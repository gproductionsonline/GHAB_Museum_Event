import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { asyncHandler, notFound, badRequest, param } from "../../lib/http.js";
import { requireAuth, requirePermission } from "../../lib/auth.js";
import { audit, snapshot } from "../../lib/audit.js";
import { rateLimit } from "../../lib/rate-limit.js";

// Admin mutation throttle (SECURITY.md DoS row): event/category CRUD is a
// low-frequency workflow; a tight budget blunts scripted or accidental floods.
// Keyed per IP across the whole mutation group.
const eventMutationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyFn: (req) => `${req.ip ?? "unknown"}:events-mutations`,
});

// Default categories created for every new event. These are bootstrap data
// only — administrators manage categories per event afterwards; application
// logic never hard-codes category values.
const DEFAULT_CATEGORIES = [
  { code: "VIP", name: "VIP", sort: 0 },
  { code: "OFFICIAL", name: "Official", sort: 1 },
  { code: "STAFF", name: "Staff", sort: 2 },
  { code: "MEDIA", name: "Media", sort: 3 },
  { code: "GENERAL_GUEST", name: "General Guest", sort: 4 },
];

const eventSchema = z.object({
  name: z.string().min(3).max(200),
  slug: z.string().regex(/^[a-z0-9-]+$/).optional(),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date().optional(),
  venue: z.string().max(200).optional(),
  timezone: z.string().max(60).default("UTC"),
  status: z.enum(["DRAFT", "SCHEDULED", "LIVE", "COMPLETED", "CANCELLED"]).optional(),
  gates: z.array(z.object({ name: z.string().min(1).max(100), sort: z.number().int().optional() })).optional(),
});

export const eventsRouter = Router();

eventsRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (_req, res) => {
    const events = await prisma.event.findMany({
      orderBy: { startsAt: "asc" },
      include: {
        gates: { orderBy: { sort: "asc" }, where: { active: true } },
        categories: { where: { active: true }, orderBy: { sort: "asc" } },
        _count: { select: { guests: true, checkIns: true } },
      },
    });
    res.json({ events });
  }),
);

eventsRouter.get(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const event = await prisma.event.findUnique({
      where: { id: param(req, "id") },
      include: {
        gates: { orderBy: { sort: "asc" }, where: { active: true } },
        categories: { where: { active: true }, orderBy: { sort: "asc" } },
        _count: { select: { guests: true, checkIns: true } },
      },
    });
    if (!event) throw notFound("Event not found");
    res.json({ event });
  }),
);

// Event-scoped guest categories (administrator-configurable). Administrators
// may additionally list inactive categories (management/re-activation UI).
eventsRouter.get(
  "/:eventId/categories",
  requireAuth,
  asyncHandler(async (req, res) => {
    const includeInactive =
      req.query.includeInactive === "1" &&
      (req.auth?.permissions.has("category:manage") ?? false);
    const categories = await prisma.guestCategory.findMany({
      where: { eventId: param(req, "eventId"), ...(includeInactive ? {} : { active: true }) },
      orderBy: { sort: "asc" },
      select: { id: true, code: true, name: true, description: true, sort: true, active: true },
    });
    res.json({ categories });
  }),
);

/** Category management (M2): create an event-scoped category. */
eventsRouter.post(
  "/:eventId/categories",
  eventMutationLimiter,
  requirePermission("category:manage"),
  asyncHandler(async (req, res) => {
    const eventId = param(req, "eventId");
    const parsed = z
      .object({
        code: z.string().min(2).max(40).regex(/^[A-Za-z0-9 _-]+$/),
        name: z.string().min(2).max(80),
        description: z.string().max(300).nullish(),
        sort: z.coerce.number().int().min(0).max(999).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid category");
    const code = parsed.data.code.toUpperCase().replace(/[\s-]+/g, "_");
    const existing = await prisma.guestCategory.findUnique({
      where: { eventId_code: { eventId, code } },
    });
    if (existing) throw badRequest(`Category code "${code}" already exists for this event`);

    const category = await prisma.guestCategory.create({
      data: {
        eventId,
        code,
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        sort: parsed.data.sort ?? 100,
      },
    });
    await audit({
      actor: req.user,
      eventId,
      action: "CATEGORY_CREATED",
      entityType: "GuestCategory",
      entityId: category.id,
      summary: `Category "${category.name}" (${category.code}) created`,
      after: { id: category.id, code: category.code, name: category.name },
      requestId: req.requestId,
    });
    res.status(201).json({ category });
  }),
);

/** Category management (M2): rename, deactivate, or re-sort a category. */
eventsRouter.patch(
  "/:eventId/categories/:categoryId",
  eventMutationLimiter,
  requirePermission("category:manage"),
  asyncHandler(async (req, res) => {
    const eventId = param(req, "eventId");
    const categoryId = param(req, "categoryId");
    const before = await prisma.guestCategory.findFirst({ where: { id: categoryId, eventId } });
    if (!before) throw notFound("Category not found");
    const parsed = z
      .object({
        name: z.string().min(2).max(80).optional(),
        description: z.string().max(300).nullish(),
        active: z.boolean().optional(),
        sort: z.coerce.number().int().min(0).max(999).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid category update");

    // Deactivating a category with assigned guests is allowed (guests keep
    // their historical category) but is surfaced to the caller.
    let assignedGuests: number | undefined;
    if (parsed.data.active === false) {
      assignedGuests = await prisma.guest.count({ where: { categoryId, eventId } });
    }
    const category = await prisma.guestCategory.update({ where: { id: categoryId }, data: parsed.data });
    await audit({
      actor: req.user,
      eventId,
      action: "CATEGORY_AMENDED",
      entityType: "GuestCategory",
      entityId: categoryId,
      summary: `Category "${category.name}" (${category.code}) updated${parsed.data.active === false ? " — deactivated" : ""}`,
      before: { name: before.name, active: before.active, sort: before.sort },
      after: { name: category.name, active: category.active, sort: category.sort },
      requestId: req.requestId,
    });
    res.json({ category, assignedGuests });
  }),
);

eventsRouter.post(
  "/",
  eventMutationLimiter,
  requirePermission("event:manage"),
  asyncHandler(async (req, res) => {
    const parsed = eventSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid event");
    const data = parsed.data;
    const event = await prisma.event.create({
      data: {
        name: data.name,
        slug: data.slug,
        startsAt: data.startsAt,
        endsAt: data.endsAt,
        venue: data.venue,
        timezone: data.timezone,
        status: data.status ?? "SCHEDULED",
        gates: data.gates
          ? { create: data.gates.map((g, i) => ({ name: g.name, code: g.name.replace(/[^A-Z0-9]/gi, "_").toUpperCase(), sort: g.sort ?? i })) }
          : undefined,
        categories: { create: DEFAULT_CATEGORIES },
      },
      include: { gates: true, categories: { orderBy: { sort: "asc" } } },
    });
    await audit({
      actor: req.user,
      eventId: event.id,
      action: "EVENT_CREATED",
      entityType: "Event",
      entityId: event.id,
      summary: `Event "${event.name}" created`,
      after: snapshot(event),
      requestId: req.requestId,
    });
    res.status(201).json({ event });
  }),
);

eventsRouter.patch(
  "/:id",
  eventMutationLimiter,
  requirePermission("event:manage"),
  asyncHandler(async (req, res) => {
    const id = param(req, "id");
    const before = await prisma.event.findUnique({ where: { id }, include: { gates: true } });
    if (!before) throw notFound("Event not found");
    const parsed = eventSchema.partial().safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid event update");
    const { gates, ...fields } = parsed.data;

    const event = await prisma.event.update({
      where: { id },
      data: {
        ...(fields.name !== undefined ? { name: fields.name } : {}),
        ...(fields.slug !== undefined ? { slug: fields.slug } : {}),
        ...(fields.startsAt !== undefined ? { startsAt: fields.startsAt } : {}),
        ...(fields.endsAt !== undefined ? { endsAt: fields.endsAt } : {}),
        ...(fields.venue !== undefined ? { venue: fields.venue } : {}),
        ...(fields.timezone !== undefined ? { timezone: fields.timezone } : {}),
        ...(fields.status !== undefined ? { status: fields.status } : {}),
      },
    });

    if (gates) {
      await prisma.gate.deleteMany({ where: { eventId: id } });
      await prisma.gate.createMany({
        data: gates.map((g, i) => ({
          eventId: id,
          name: g.name,
          code: g.name.replace(/[^A-Z0-9]/gi, "_").toUpperCase(),
          sort: g.sort ?? i,
        })),
      });
    }

    await audit({
      actor: req.user,
      eventId: event.id,
      action: "EVENT_AMENDED",
      entityType: "Event",
      entityId: event.id,
      summary: `Event "${event.name}" updated`,
      before: snapshot(before),
      after: snapshot(event),
      requestId: req.requestId,
    });
    res.json({
      event: await prisma.event.findUnique({
        where: { id: event.id },
        include: { gates: { orderBy: { sort: "asc" } }, categories: { orderBy: { sort: "asc" } } },
      }),
    });
  }),
);
