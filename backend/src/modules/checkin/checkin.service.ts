import crypto from "node:crypto";
import type { AppUser } from "../../config.js";
import { prisma } from "../../lib/prisma.js";
import { notFound, forbidden } from "../../lib/http.js";
import { isUniqueViolation, isOperationIdViolation } from "../../lib/codes.js";
import { audit } from "../../lib/audit.js";
import { scheduleStatsBroadcast } from "../stats/stats.service.js";
import { lockGuestForUpdate } from "../guests/guests.service.js";
import type { CheckIn } from "../../generated/prisma/client.js";

export type CheckInResult =
  | "CHECKED_IN"
  | "ALREADY_USED"
  | "CANCELLED"
  | "REPLACED"
  | "GUEST_CANCELLED"
  | "INVALID";

export type AttemptInput = {
  eventId: string;
  method: "QR" | "MANUAL" | "OFFLINE_SYNC";
  gate?: string | null;
  deviceName?: string | null;
  deviceId?: string | null;
  actor: AppUser | null;
  clientTimestamp?: Date | null;
  codeHash?: string; // QR / offline scan path
  guestId?: string; // manual check-in path
  /** Client-supplied idempotency key: retries never create a second admission. */
  operationId?: string;
  syncBatchId?: string | null;
};

export type AttemptOutcome = {
  result: CheckInResult;
  operationId: string;
  guest?: {
    id: string;
    displayName: string;
    category: string;
    organisation?: string | null;
    isCompanion: boolean;
    partyOf?: string | null;
  };
  checkIn?: CheckIn;
  alreadyAt?: Date;
};

type GuestInfo = NonNullable<AttemptOutcome["guest"]>;

/** Result of the locked admission transaction. */
type LockedOutcome =
  | { kind: "ADMITTED"; checkIn: CheckIn; guest: GuestInfo }
  | { kind: "REJECTED"; result: CheckInResult; guest?: GuestInfo };

/**
 * The concurrency-safe admission use case.
 *
 * Guarantee (see DATABASE_DESIGN.md "Concurrency"): exactly one successful
 * check-in per credential, even when multiple devices race. The database is
 * the final authority via three UNIQUE indexes:
 *   - CheckIn.operationId                     (idempotent retries)
 *   - CheckIn.(eventId, credentialVersionId)  (single admission per version)
 *   - CheckIn.guestId                          (single admission per guest)
 *
 * Concurrency model (audit M-1): the admission transaction first takes a
 * FOR UPDATE lock on the Guest row — the same lock used by issue/reissue/
 * revoke/RSVP-cancel — then re-reads credential status and guest RSVP state
 * INSIDE the transaction before inserting. State validation can therefore
 * never interleave with a concurrent revocation or replacement. The unique
 * indexes arbitrate any residual race (e.g. two devices scanning the same
 * QR): exactly one insert wins; losers receive the unique-violation path.
 */
export async function attemptCheckIn(input: AttemptInput): Promise<AttemptOutcome> {
  const { eventId, method, actor } = input;
  const operationId = input.operationId ?? crypto.randomUUID();

  // Resolve the credential for the submitted identity (read-only, no lock).
  const credential = input.codeHash
    ? await prisma.credentialVersion.findUnique({
        where: { codeHash: input.codeHash },
        select: { id: true, guestId: true },
      })
    : input.guestId
      ? await prisma.credentialVersion.findFirst({
          where: { guestId: input.guestId, status: "ACTIVE" },
          select: { id: true, guestId: true },
        })
      : null;

  // Idempotent replay with identity verification (audit M-3): the stored
  // operation must correspond to the submitted event AND credential/guest.
  // Reusing an operationId with a different identity is INVALID — never a
  // false CHECKED_IN for the wrong guest.
  const existingByOp = await prisma.checkIn.findUnique({ where: { operationId } });
  if (existingByOp) {
    if (existingByOp.eventId !== eventId) {
      return { result: "INVALID", operationId };
    }
    if (input.codeHash) {
      if (!credential || credential.id !== existingByOp.credentialVersionId) {
        return { result: "INVALID", operationId };
      }
    } else if (input.guestId && existingByOp.guestId !== input.guestId) {
      return { result: "INVALID", operationId };
    }
    const replayGuest = await prisma.guest.findUnique({
      where: { id: existingByOp.guestId },
      include: { category: true, parent: true },
    });
    return {
      result: "CHECKED_IN",
      operationId,
      guest: replayGuest ? toGuestInfo(replayGuest) : undefined,
      checkIn: existingByOp,
    };
  }

  if (!credential) return { result: "INVALID", operationId };

  try {
    const outcome = await prisma.$transaction<LockedOutcome>(async (tx) => {
      // Serialize against every credential state mutation on this guest (M-1).
      await lockGuestForUpdate(tx, credential.guestId);

      const cred = await tx.credentialVersion.findUnique({
        where: { id: credential.id },
        include: { guest: { include: { category: true, parent: true, rsvpStatus: true } } },
      });
      if (!cred || !cred.guest) {
        return { kind: "REJECTED", result: "INVALID" } satisfies LockedOutcome;
      }
      const guest = cred.guest;

      if (cred.status === "REVOKED") {
        return { kind: "REJECTED", result: "CANCELLED", guest: toGuestInfo(guest) } satisfies LockedOutcome;
      }
      if (cred.status === "REPLACED") {
        return { kind: "REJECTED", result: "REPLACED", guest: toGuestInfo(guest) } satisfies LockedOutcome;
      }
      if (cred.status === "EXPIRED" || cred.status === "PENDING") {
        return { kind: "REJECTED", result: "INVALID", guest: toGuestInfo(guest) } satisfies LockedOutcome;
      }
      if (guest.rsvpStatus.code === "CANCELLED" || guest.rsvpStatus.code === "DECLINED") {
        return { kind: "REJECTED", result: "GUEST_CANCELLED", guest: toGuestInfo(guest) } satisfies LockedOutcome;
      }
      if (guest.eventId !== eventId) {
        return { kind: "REJECTED", result: "INVALID" } satisfies LockedOutcome;
      }

      // Resolve a device reference by name inside the same transaction.
      let deviceId = input.deviceId ?? null;
      if (!deviceId && input.deviceName) {
        const device = await tx.device.findFirst({ where: { eventId, name: input.deviceName } });
        deviceId = device?.id ?? null;
      }

      const checkIn = await tx.checkIn.create({
        data: {
          operationId,
          credentialVersionId: cred.id,
          guestId: guest.id,
          eventId,
          deviceId,
          operatorUserId: actor?.id ?? null,
          method,
          gate: input.gate ?? null,
          scannedAt: input.clientTimestamp ?? new Date(),
          clientTimestamp: input.clientTimestamp ?? null,
        },
      });
      return { kind: "ADMITTED", checkIn, guest: toGuestInfo(guest) } satisfies LockedOutcome;
    });

    if (outcome.kind === "ADMITTED") {
      scheduleStatsBroadcast(eventId);
      return {
        result: "CHECKED_IN",
        operationId,
        guest: outcome.guest,
        checkIn: outcome.checkIn,
      };
    }
    return { result: outcome.result, operationId, guest: outcome.guest };
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Audit L-1: distinguish which database guarantee fired. An
      // operationId collision is a client idempotency-key reuse, NOT a
      // duplicate admission — it must not be reported as ALREADY_USED.
      if (isOperationIdViolation(err)) {
        return { result: "INVALID", operationId };
      }
      const byCredential = await prisma.checkIn.findUnique({
        where: { eventId_credentialVersionId: { eventId, credentialVersionId: credential.id } },
      });
      const byGuest =
        byCredential ??
        (await prisma.checkIn.findUnique({ where: { guestId: credential.guestId } }));
      if (!byCredential && !byGuest) {
        // Defensive: the winning admission could not be identified.
        return { result: "INVALID", operationId };
      }
      const racedGuest = await prisma.guest.findUnique({
        where: { id: credential.guestId },
        include: { category: true, parent: true },
      });
      return {
        result: "ALREADY_USED",
        operationId,
        guest: racedGuest ? toGuestInfo(racedGuest) : undefined,
        alreadyAt: byGuest?.scannedAt ?? byCredential?.scannedAt ?? undefined,
      };
    }
    throw err;
  }
}

type GuestWithRelations = {
  id: string;
  title?: string | null;
  firstName: string;
  lastName: string;
  displayName?: string | null;
  email?: string | null;
  phone?: string | null;
  organisation?: string | null;
  parentId?: string | null;
  category: { code: string };
  parent?: { title?: string | null; firstName: string; lastName: string } | null;
};

function toGuestInfo(guest: GuestWithRelations): GuestInfo {
  const name = guest.displayName
    ? guest.displayName
    : [guest.title, guest.firstName, guest.lastName].filter(Boolean).join(" ").trim();
  return {
    id: guest.id,
    displayName: name,
    category: guest.category.code,
    organisation: guest.organisation,
    isCompanion: Boolean(guest.parentId),
    partyOf: guest.parent
      ? [guest.parent.title, guest.parent.firstName, guest.parent.lastName].filter(Boolean).join(" ")
      : null,
  };
}

/**
 * Void (undo) a check-in. The admission row is deleted so the guest can be
 * re-admitted, and the FULL before-state of the deleted row is preserved in
 * the immutable audit log. Delete and audit run in ONE transaction (audit
 * M-2): either both persist, or neither does — a voided admission can never
 * leave no forensic trace. The unique invariants stay intact, so the guest
 * remains re-admissible after the void.
 */
export async function undoCheckIn(
  checkInId: string,
  actor: AppUser,
): Promise<{ guestId: string; eventId: string }> {
  if (actor.role === "CHECKIN_OPERATOR") {
    throw forbidden("Check-in operators cannot void check-ins");
  }

  const result = await prisma.$transaction(async (tx) => {
    const checkIn = await tx.checkIn.findUnique({ where: { id: checkInId } });
    if (!checkIn) throw notFound("Check-in not found");

    const guest = await tx.guest.findUniqueOrThrow({ where: { id: checkIn.guestId } });

    // Complete forensic snapshot of the admission being voided (audit M-2).
    const before = {
      checkInId: checkIn.id,
      eventId: checkIn.eventId,
      guestId: checkIn.guestId,
      credentialVersionId: checkIn.credentialVersionId,
      operationId: checkIn.operationId,
      operatorUserId: checkIn.operatorUserId,
      deviceId: checkIn.deviceId,
      method: checkIn.method,
      gate: checkIn.gate,
      scannedAt: checkIn.scannedAt.toISOString(),
      clientTimestamp: checkIn.clientTimestamp?.toISOString() ?? null,
    };

    await tx.checkIn.delete({ where: { id: checkInId } });
    await audit(
      {
        actor,
        eventId: checkIn.eventId,
        action: "CHECKIN_UNDONE",
        entityType: "CheckIn",
        entityId: checkInId,
        result: "SUCCESS",
        summary: `Check-in for guest ${guest.displayName ?? guest.firstName + " " + guest.lastName} undone`,
        before,
      },
      tx,
    );
    return { guestId: checkIn.guestId, eventId: checkIn.eventId };
  });

  scheduleStatsBroadcast(result.eventId);
  return result;
}
