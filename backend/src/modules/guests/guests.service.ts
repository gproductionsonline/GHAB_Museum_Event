import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { badRequest, notFound, conflict } from "../../lib/http.js";
import type { Prisma, Guest } from "../../generated/prisma/client.js";
import { audit, snapshot } from "../../lib/audit.js";
import type { AppUser } from "../../config.js";

export const RSVP_CODES = ["PENDING", "INVITED", "CONFIRMED", "DECLINED", "CANCELLED"] as const;

/**
 * Serialization point for all credential/admission state transitions
 * (audit M-1). Every mutation of a guest's credential state — issue, reissue,
 * revoke, RSVP cancellation cascade, and check-in admission — takes this row
 * lock inside its transaction before reading state, so no operation can act on
 * stale credential/RSVP data. The database unique constraints remain the
 * final admission arbiter; the lock guarantees state-consistent validation.
 */
export async function lockGuestForUpdate(
  tx: Prisma.TransactionClient,
  guestId: string,
): Promise<void> {
  const rows =
    await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Guest" WHERE "id" = ${guestId} FOR UPDATE`;
  if (rows.length === 0) throw notFound("Guest not found");
}
export type RsvpCode = (typeof RSVP_CODES)[number];

/** Event-scoped category lookup (categories are administrator-managed). */
export async function resolveCategory(
  eventId: string,
  input: string,
  tx?: Prisma.TransactionClient,
): Promise<{ id: string; code: string }> {
  const db = tx ?? prisma;
  const code = input.trim().toUpperCase().replace(/[\s-]+/g, "_");
  const category = await db.guestCategory.findFirst({ where: { eventId, code, active: true } });
  if (!category) {
    const available = await db.guestCategory.findMany({
      where: { eventId, active: true },
      orderBy: { sort: "asc" },
    });
    throw badRequest(
      `Unknown guest category "${input}". Available: ${available.map((c) => c.code).join(", ")}`,
    );
  }
  return { id: category.id, code: category.code };
}

export async function resolveRsvpStatus(
  code: string,
  tx?: Prisma.TransactionClient,
): Promise<{ id: string; code: string }> {
  const db = tx ?? prisma;
  const status = await db.rsvpStatus.findUnique({ where: { code: code.toUpperCase() } });
  if (!status || !status.active) throw badRequest(`Unknown RSVP status "${code}"`);
  return { id: status.id, code: status.code };
}

export function normalizeNameForSearch(firstName: string, lastName: string): string {
  return `${firstName} ${lastName}`.trim().toLowerCase();
}

export function displayName(g: {
  title?: string | null;
  firstName: string;
  lastName: string;
  displayName?: string | null;
}): string {
  if (g.displayName) return g.displayName;
  return [g.title, g.firstName, g.lastName].filter(Boolean).join(" ").trim();
}

export type CreateGuestInput = {
  eventId: string;
  guestRef?: string | null;
  title?: string | null;
  firstName: string;
  lastName: string;
  displayName?: string | null;
  email?: string | null;
  phone?: string | null;
  organisation?: string | null;
  designation?: string | null;
  category: string; // GuestCategory.code
  rsvpStatus?: string; // RsvpStatus.code, default CONFIRMED
  source?: string;
  tableSeat?: string | null;
  invitedBy?: string | null;
  notes?: string | null;
  parentId?: string | null;
  importJobId?: string | null;
  /** Manual creation: allow creating despite an identical normalized name. */
  allowDuplicate?: boolean;
};

export async function createGuestWithCredential(
  input: CreateGuestInput,
  actor: AppUser | null,
  tx?: Prisma.TransactionClient,
): Promise<Guest> {
  const db = tx ?? prisma;
  if (input.parentId) {
    const parent = await db.guest.findUnique({ where: { id: input.parentId } });
    if (!parent) throw notFound("Parent guest not found");
    if (parent.parentId) {
      throw badRequest("An accompanying guest cannot itself have accompanying guests (no nested parties).");
    }
  }

  // Duplicate detection (M2): a guest with the same normalized name cannot
  // be created twice for an event unless explicitly allowed. Import paths
  // deduplicate at preview and keep this check as a safety net.
  if (!input.allowDuplicate) {
    const normalizedName = normalizeNameForSearch(input.firstName, input.lastName);
    const duplicate = await db.guest.findFirst({
      where: { eventId: input.eventId, normalizedName, parentId: null },
      select: { id: true },
    });
    if (duplicate) {
      throw conflict(
        `A guest named "${input.firstName} ${input.lastName}" already exists in this event.`,
      );
    }
  }

  const category = await resolveCategory(input.eventId, input.category, db);
  const rsvp = await resolveRsvpStatus(input.rsvpStatus ?? "CONFIRMED", db);
  const email = input.email?.trim().toLowerCase() || null;

  const guest = await db.guest.create({
    data: {
      eventId: input.eventId,
      parentId: input.parentId ?? null,
      categoryId: category.id,
      rsvpStatusId: rsvp.id,
      guestRef: input.guestRef ?? null,
      title: input.title ?? null,
      firstName: input.firstName,
      lastName: input.lastName,
      displayName: input.displayName ?? null,
      normalizedName: normalizeNameForSearch(input.firstName, input.lastName),
      email,
      phone: input.phone ?? null,
      organisation: input.organisation ?? null,
      designation: input.designation ?? null,
      source: input.source ?? "MANUAL",
      tableSeat: input.tableSeat ?? null,
      invitedBy: input.invitedBy ?? null,
      notes: input.notes ?? null,
      importJobId: input.importJobId ?? null,
    },
  });
  await audit(
    {
      actor,
      eventId: guest.eventId,
      action: input.parentId ? "COMPANION_CREATED" : "GUEST_CREATED",
      entityType: "Guest",
      entityId: guest.id,
      summary: `${displayName(guest)} (${category.code}) added via ${guest.source.toLowerCase()}`,
      after: snapshot(guest),
    },
    tx,
  );
  return guest;
}

const AMENDABLE = [
  "guestRef",
  "title",
  "displayName",
  "email",
  "phone",
  "organisation",
  "designation",
  "tableSeat",
  "invitedBy",
  "notes",
] as const;

export async function amendGuest(
  guestId: string,
  patch: Partial<CreateGuestInput>,
  actor: AppUser,
): Promise<Guest> {
  const before = await prisma.guest.findUnique({ where: { id: guestId } });
  if (!before) throw notFound("Guest not found");

  const data: Prisma.GuestUpdateInput = {};
  for (const key of AMENDABLE) {
    if (patch[key] !== undefined) {
      (data as Record<string, unknown>)[key] = patch[key];
    }
  }
  if (patch.firstName !== undefined || patch.lastName !== undefined) {
    const firstName = patch.firstName ?? before.firstName;
    const lastName = patch.lastName ?? before.lastName;
    data.firstName = firstName;
    data.lastName = lastName;
    data.normalizedName = normalizeNameForSearch(firstName, lastName);
  }
  if (patch.email !== undefined) data.email = patch.email?.trim().toLowerCase() || null;
  if (patch.category !== undefined) data.category = { connect: { id: (await resolveCategory(before.eventId, patch.category)).id } };
  if (patch.rsvpStatus !== undefined) {
    data.rsvpStatus = { connect: { id: (await resolveRsvpStatus(patch.rsvpStatus)).id } };
  }

  const after = await prisma.guest.update({ where: { id: guestId }, data });
  await audit({
    actor,
    eventId: after.eventId,
    action: "GUEST_AMENDED",
    entityType: "Guest",
    entityId: guestId,
    summary: `${displayName(after)} amended`,
    before: snapshot(before),
    after: snapshot(after),
  });
  return after;
}

/**
 * Moves a guest to an RSVP state. CANCELLED/DECLINED revoke the active
 * credential (and those of accompanying guests) atomically.
 */
export async function setGuestRsvp(
  guestId: string,
  code: RsvpCode,
  reason: string | undefined,
  actor: AppUser,
): Promise<Guest> {
  const before = await prisma.guest.findUnique({ where: { id: guestId } });
  if (!before) throw notFound("Guest not found");

  return prisma.$transaction(async (tx) => {
    // Serialize against credential mutations and admissions on this guest (M-1).
    await lockGuestForUpdate(tx, guestId);
    const rsvp = await resolveRsvpStatus(code, tx);
    const after = await tx.guest.update({
      where: { id: guestId },
      data: { rsvpStatusId: rsvp.id },
    });

    if (code === "CANCELLED" || code === "DECLINED") {
      await revokeActiveCredentialForGuest(guestId, reason ?? `Guest ${code.toLowerCase()}`, actor, tx);

      // Cascade to confirmed companions.
      const companions = await tx.guest.findMany({ where: { parentId: guestId } });
      for (const companion of companions) {
        const companionRsvp = await tx.rsvpStatus.findUnique({ where: { id: companion.rsvpStatusId } });
        if (companionRsvp?.code === "CONFIRMED" || companionRsvp?.code === "PENDING" || companionRsvp?.code === "INVITED") {
          await tx.guest.update({ where: { id: companion.id }, data: { rsvpStatusId: rsvp.id } });
          await revokeActiveCredentialForGuest(companion.id, `Primary guest ${code.toLowerCase()}`, actor, tx);
        }
      }
    }

    await audit(
      {
        actor,
        eventId: after.eventId,
        action: code === "CANCELLED" ? "GUEST_CANCELLED" : `GUEST_RSVP_${code}`,
        entityType: "Guest",
        entityId: guestId,
        summary: `${displayName(after)} RSVP set to ${code}${reason ? `: ${reason}` : ""}`,
        before: snapshot(before),
        after: snapshot(after),
      },
      tx,
    );
    return after;
  });
}

/**
 * Revoke the guest's active credential and clear the pointer. Takes the guest
 * row lock when running inside a transaction so the read-then-mutate sequence
 * cannot interleave with issue/reissue/admission (audit M-1). Called from
 * setGuestRsvp for the primary guest and each companion.
 */
export async function revokeActiveCredentialForGuest(
  guestId: string,
  reason: string,
  actor: AppUser | null,
  tx?: Prisma.TransactionClient,
): Promise<void> {
  if (!tx) {
    // Always called within a transaction by setGuestRsvp; the fallback path
    // wraps itself for safety.
    return prisma.$transaction((t) => revokeActiveCredentialForGuest(guestId, reason, actor, t));
  }
  const db = tx;
  await lockGuestForUpdate(db, guestId);
  const guest = await db.guest.findUnique({ where: { id: guestId } });
  if (!guest?.activeCredentialId) return;
  const cred = await db.credentialVersion.findUnique({ where: { id: guest.activeCredentialId } });
  if (!cred || cred.status !== "ACTIVE") return;

  await db.credentialVersion.update({
    where: { id: cred.id },
    data: { status: "REVOKED", revokedAt: new Date(), revokedReason: reason },
  });
  await db.guest.update({ where: { id: guestId }, data: { activeCredentialId: null } });
  await audit(
    {
      actor,
      eventId: guest.eventId,
      action: "CREDENTIAL_REVOKED",
      entityType: "CredentialVersion",
      entityId: cred.id,
      summary: `Credential for ${displayName(guest)} revoked: ${reason}`,
    },
    db,
  );
}

export const guestQuerySchema = z.object({
  eventId: z.string(),
  q: z.string().optional(),
  category: z.string().optional(), // GuestCategory.code
  status: z.enum(RSVP_CODES).optional(), // RsvpStatus.code
  checkedIn: z.enum(["yes", "no"]).optional(),
  emailed: z.enum(["yes", "no"]).optional(),
  primary: z.enum(["yes", "no"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});
