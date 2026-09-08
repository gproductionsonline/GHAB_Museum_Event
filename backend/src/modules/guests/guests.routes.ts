import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { asyncHandler, notFound, badRequest, param } from "../../lib/http.js";
import { requirePermission } from "../../lib/auth.js";
import {
  guestQuerySchema,
  createGuestWithCredential,
  amendGuest,
  setGuestRsvp,
  displayName,
  type RsvpCode,
} from "./guests.service.js";
import {
  guestQrDataUrl,
  issueCredential,
  revokeCredential,
  reissueCredential,
  emailGuestCredential,
} from "../credentials/credentials.service.js";
import { scheduleStatsBroadcast } from "../stats/stats.service.js";
import { rateLimit } from "../../lib/rate-limit.js";

// Mutation throttle (SECURITY.md DoS row): generous enough for normal staff
// workflows (amendments, RSVP changes, companion adds, credential cycling),
// tight enough to blunt runaway scripts and accidental loops. Keyed per IP
// across the whole mutation group — parameterized paths must not split the
// budget per guest id.
const guestMutationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  keyFn: (req) => `${req.ip ?? "unknown"}:guests-mutations`,
});

const createSchema = z.object({
  eventId: z.string(),
  title: z.string().max(20).nullish(),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  email: z.string().email().nullish(),
  phone: z.string().max(40).nullish(),
  organisation: z.string().max(200).nullish(),
  designation: z.string().max(200).nullish(),
  category: z.string(),
  tableSeat: z.string().max(40).nullish(),
  invitedBy: z.string().max(200).nullish(),
  notes: z.string().max(2000).nullish(),
  guestRef: z.string().max(100).nullish(),
  issueCredential: z.boolean().default(true),
  allowDuplicate: z.boolean().default(false),
});

const amendSchema = createSchema.omit({ eventId: true, issueCredential: true }).partial();

const companionSchema = z.object({
  firstName: z.string().min(1).max(100).optional(),
  lastName: z.string().min(1).max(100).optional(),
  displayName: z.string().min(1).max(200).optional(),
  email: z.string().email().nullish(),
  issueCredential: z.boolean().default(true),
});

export const guestsRouter = Router();

guestsRouter.get(
  "/",
  requirePermission("guest:read"),
  asyncHandler(async (req, res) => {
    const parsed = guestQuerySchema.safeParse(req.query);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid query");
    const q = parsed.data;
    const needle = q.q?.toLowerCase() ?? "";

    const where = {
      eventId: q.eventId,
      ...(q.category ? { category: { code: q.category } } : {}),
      ...(q.status ? { rsvpStatus: { code: q.status } } : {}),
      ...(q.primary === "yes" ? { parentId: null } : q.primary === "no" ? { parentId: { not: null } } : {}),
      ...(q.checkedIn === "yes" ? { checkIn: {}} : q.checkedIn === "no" ? { checkIn: null } : {}),
      ...(q.emailed === "yes"
        ? { credential: { emailDeliveries: { some: { status: "SENT" } } } }
        : q.emailed === "no"
          ? { OR: [{ credential: { emailDeliveries: { none: { status: "SENT" } } } }, { activeCredentialId: null }] }
          : {}),
      ...(needle
        ? {
            OR: [
              { firstName: { contains: q.q, mode: "insensitive" as const } },
              { lastName: { contains: q.q, mode: "insensitive" as const } },
              { displayName: { contains: q.q, mode: "insensitive" as const } },
              { normalizedName: { contains: needle } },
              { email: { contains: needle } },
              { phone: { contains: q.q } },
              { organisation: { contains: q.q, mode: "insensitive" as const } },
              { guestRef: { contains: q.q } },
            ],
          }
        : {}),
    };

    const [total, guests] = await Promise.all([
      prisma.guest.count({ where }),
      prisma.guest.findMany({
        where,
        orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: {
          credential: { include: { emailDeliveries: { where: { status: "SENT" }, orderBy: { sentAt: "desc" }, take: 1 } } },
          checkIn: true,
          parent: true,
          category: true,
          rsvpStatus: true,
          _count: { select: { companions: true } },
        },
      }),
    ]);

    res.json({
      total,
      page: q.page,
      pageSize: q.pageSize,
      guests: guests.map((g) => ({
        id: g.id,
        name: displayName(g),
        firstName: g.firstName,
        lastName: g.lastName,
        email: g.email,
        phone: g.phone,
        category: g.category.code,
        status: g.rsvpStatus.code,
        source: g.source,
        organisation: g.organisation,
        tableSeat: g.tableSeat,
        isCompanion: Boolean(g.parentId),
        partyOf: g.parent
          ? [g.parent.title, g.parent.firstName, g.parent.lastName].filter(Boolean).join(" ")
          : null,
        companionCount: g._count.companions,
        credential: g.credential
          ? {
              id: g.credential.id,
              status: g.credential.status,
              codeLast4: g.credential.codeLast4,
              issuedAt: g.credential.issuedAt,
              emailedAt: g.credential.emailDeliveries[0]?.sentAt ?? null,
            }
          : null,
        checkIn: g.checkIn
          ? { id: g.checkIn.id, scannedAt: g.checkIn.scannedAt, gate: g.checkIn.gate, method: g.checkIn.method }
          : null,
      })),
    });
  }),
);

guestsRouter.post(
  "/",
  guestMutationLimiter,
  requirePermission("guest:write"),
  asyncHandler(async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid guest");
    const { issueCredential: doIssue, ...data } = parsed.data;
    const guest = await createGuestWithCredential({ ...data, source: "MANUAL" }, req.user!);
    if (doIssue) await issueCredential(guest.id, req.user!);
    res.status(201).json({ guest: { id: guest.id } });
  }),
);

guestsRouter.get(
  "/:id",
  requirePermission("guest:read"),
  asyncHandler(async (req, res) => {
    const id = param(req, "id");
    const guest = await prisma.guest.findUnique({
      where: { id },
      include: {
        credential: true,
        checkIn: true,
        parent: true,
        category: true,
        rsvpStatus: true,
        companions: { include: { credential: true, checkIn: true, rsvpStatus: true } },
      },
    });
    if (!guest) throw notFound("Guest not found");

    const lastDelivery = guest.credential
      ? await prisma.emailDelivery.findFirst({
          where: { credentialVersionId: guest.credential.id, status: "SENT" },
          orderBy: { sentAt: "desc" },
        })
      : null;
    // Audit H-1: the raw QR bearer credential is only exposed to callers
    // holding credential:read. Check-in operators (guest:read) must never be
    // able to harvest a usable credential from this response.
    const canReadCredentials = req.auth?.permissions.has("credential:read") ?? false;
    const qr =
      canReadCredentials && guest.credential?.status === "ACTIVE" ? await guestQrDataUrl(id) : null;

    res.json({
      guest: {
        id: guest.id,
        eventId: guest.eventId,
        guestRef: guest.guestRef,
        title: guest.title,
        firstName: guest.firstName,
        lastName: guest.lastName,
        displayName: guest.displayName,
        email: guest.email,
        phone: guest.phone,
        organisation: guest.organisation,
        designation: guest.designation,
        category: guest.category.code,
        rsvpStatus: guest.rsvpStatus.code,
        status: guest.rsvpStatus.code,
        source: guest.source,
        tableSeat: guest.tableSeat,
        invitedBy: guest.invitedBy,
        notes: guest.notes,
        isCompanion: Boolean(guest.parentId),
        partyOf: guest.parent ? displayName(guest.parent) : null,
        createdAt: guest.createdAt,
        credential: guest.credential
          ? {
              id: guest.credential.id,
              status: guest.credential.status,
              codeLast4: guest.credential.codeLast4,
              versionNumber: guest.credential.versionNumber,
              issuedAt: guest.credential.issuedAt,
              emailedAt: lastDelivery?.sentAt ?? null,
              revokedAt: guest.credential.revokedAt,
              revokedReason: guest.credential.revokedReason,
            }
          : null,
        qr,
        checkIn: guest.checkIn,
        companions: guest.companions.map((c) => ({
          id: c.id,
          name: displayName(c),
          email: c.email,
          status: c.rsvpStatus.code,
          credential: c.credential ? { status: c.credential.status } : null,
          checkIn: c.checkIn,
        })),
      },
    });
  }),
);

guestsRouter.get(
  "/:id/audit",
  requirePermission("audit:read"),
  asyncHandler(async (req, res) => {
    const logs = await prisma.auditLog.findMany({
      where: { OR: [{ entityType: "Guest", entityId: param(req, "id") }] },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    res.json({ logs });
  }),
);

guestsRouter.patch(
  "/:id",
  guestMutationLimiter,
  requirePermission("guest:write"),
  asyncHandler(async (req, res) => {
    const parsed = amendSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid amendment");
    const guest = await amendGuest(param(req, "id"), parsed.data, req.user!);
    scheduleStatsBroadcast(guest.eventId);
    res.json({ guest: { id: guest.id } });
  }),
);

guestsRouter.post(
  "/:id/cancel",
  guestMutationLimiter,
  requirePermission("guest:write"),
  asyncHandler(async (req, res) => {
    const reason = z.string().max(500).optional().parse(req.body?.reason);
    const guest = await setGuestRsvp(param(req, "id"), "CANCELLED" as RsvpCode, reason, req.user!);
    scheduleStatsBroadcast(guest.eventId);
    res.json({ guest: { id: guest.id, status: "CANCELLED" } });
  }),
);

guestsRouter.post(
  "/:id/restore",
  guestMutationLimiter,
  requirePermission("guest:write"),
  asyncHandler(async (req, res) => {
    const guest = await setGuestRsvp(param(req, "id"), "CONFIRMED" as RsvpCode, undefined, req.user!);
    scheduleStatsBroadcast(guest.eventId);
    res.json({ guest: { id: guest.id, status: "CONFIRMED" } });
  }),
);

/** RSVP state transition (M2): move a guest to any seeded RSVP state. */
guestsRouter.post(
  "/:id/rsvp",
  guestMutationLimiter,
  requirePermission("guest:write"),
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        code: z.enum(["PENDING", "INVITED", "CONFIRMED", "DECLINED", "CANCELLED"]),
        reason: z.string().max(500).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid RSVP transition");
    const guest = await setGuestRsvp(
      param(req, "id"),
      parsed.data.code as RsvpCode,
      parsed.data.reason,
      req.user!,
    );
    scheduleStatsBroadcast(guest.eventId);
    res.json({ guest: { id: guest.id, status: parsed.data.code } });
  }),
);

/** Credential version history (M2) — no raw secrets, codeLast4 only. */
guestsRouter.get(
  "/:id/credentials",
  requirePermission("guest:read"),
  asyncHandler(async (req, res) => {
    const guestId = param(req, "id");
    const guest = await prisma.guest.findUnique({ where: { id: guestId }, select: { id: true } });
    if (!guest) throw notFound("Guest not found");
    const versions = await prisma.credentialVersion.findMany({
      where: { guestId },
      orderBy: { versionNumber: "desc" },
      include: {
        emailDeliveries: { orderBy: { sentAt: "desc" }, take: 1, where: { status: "SENT" } },
      },
    });
    res.json({
      credentials: versions.map((v) => ({
        id: v.id,
        versionNumber: v.versionNumber,
        status: v.status,
        codeLast4: v.codeLast4,
        issuedAt: v.issuedAt,
        revokedAt: v.revokedAt,
        revokedReason: v.revokedReason,
        expiresAt: v.expiresAt,
        emailedAt: v.emailDeliveries[0]?.sentAt ?? null,
      })),
    });
  }),
);

guestsRouter.post(
  "/:id/companions",
  guestMutationLimiter,
  requirePermission("guest:write"),
  asyncHandler(async (req, res) => {
    const id = param(req, "id");
    const parent = await prisma.guest.findUnique({ where: { id }, include: { category: true, rsvpStatus: true } });
    if (!parent) throw notFound("Guest not found");
    if (parent.parentId) throw badRequest("Cannot add a companion to an accompanying guest");
    const parsed = companionSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid companion");
    const { issueCredential: doIssue, ...data } = parsed.data;

    const companion = await createGuestWithCredential(
      {
        eventId: parent.eventId,
        parentId: parent.id,
        firstName: data.firstName ?? data.displayName ?? "Accompanying guest",
        lastName: data.lastName ?? "",
        displayName: data.displayName ?? (data.firstName ? null : `Guest of ${displayName(parent)}`),
        email: data.email ?? null,
        category: parent.category.code,
        rsvpStatus: parent.rsvpStatus.code,
        source: "MANUAL",
        tableSeat: parent.tableSeat,
        notes: `Accompanying ${displayName(parent)}`,
      },
      req.user!,
    );
    if (doIssue) await issueCredential(companion.id, req.user!);
    scheduleStatsBroadcast(parent.eventId);
    res.status(201).json({ guest: { id: companion.id } });
  }),
);

// --- credential operations ---

guestsRouter.post(
  "/:id/credential/issue",
  guestMutationLimiter,
  requirePermission("credential:issue"),
  asyncHandler(async (req, res) => {
    const cred = await issueCredential(param(req, "id"), req.user!);
    const guest = await prisma.guest.findUniqueOrThrow({ where: { id: param(req, "id") } });
    scheduleStatsBroadcast(guest.eventId);
    res.status(201).json({ credential: { id: cred.id, status: cred.status } });
  }),
);

guestsRouter.post(
  "/:id/credential/reissue",
  guestMutationLimiter,
  requirePermission("credential:issue", "credential:revoke"),
  asyncHandler(async (req, res) => {
    const reason = z.string().max(500).optional().parse(req.body?.reason);
    const cred = await reissueCredential(param(req, "id"), reason, req.user!);
    res.json({ credential: { id: cred.id, status: cred.status, replacesPrevious: true } });
  }),
);

guestsRouter.post(
  "/:id/credential/revoke",
  guestMutationLimiter,
  requirePermission("credential:revoke"),
  asyncHandler(async (req, res) => {
    const reason = z.string().max(500).optional().parse(req.body?.reason);
    const cred = await revokeCredential(param(req, "id"), reason, req.user!);
    res.json({ credential: { id: cred.id, status: cred.status } });
  }),
);

guestsRouter.post(
  "/:id/credential/email",
  guestMutationLimiter,
  requirePermission("email:send"),
  asyncHandler(async (req, res) => {
    const result = await emailGuestCredential(param(req, "id"), req.user!);
    res.json(result);
  }),
);
