import crypto from "node:crypto";
import { z } from "zod";
import { config, type AppUser } from "../../config.js";
import { prisma } from "../../lib/prisma.js";
import { notFound, forbidden } from "../../lib/http.js";
import { sha256, hmacSha256 } from "../../lib/codes.js";
import { extractCode } from "../credentials/credentials.service.js";
import { attemptCheckIn, type CheckInResult } from "../checkin/checkin.service.js";
import { audit } from "../../lib/audit.js";
import type { Device } from "../../generated/prisma/client.js";

export type Snapshot = {
  version: string;
  eventId: string;
  eventName: string;
  generatedAt: string;
  expiresAt: string;
  signature: string;
  counts: { total: number; active: number };
  attendees: {
    h: string; // credential token hash (opaque; no raw token leaves the server)
    n: string; // display name
    c: string; // category code
    p: 0 | 1; // is accompanying guest
    g: string | null; // party of (primary guest name)
    u: string | null; // checked-in at (ISO) or null
  }[];
};

// Offline package lifetime: an authorized snapshot is valid for a bounded
// window; the device refuses local admission after expiry and must refresh.
const SNAPSHOT_TTL_HOURS = Number(process.env.SNAPSHOT_TTL_HOURS ?? 48);

/**
 * Event-scoped offline admission package. Contains ONLY the minimum data a
 * gate device needs to verify locally: token hashes, names, category codes.
 * No emails, phones, raw tokens, or administrative data. Signed with HMAC
 * for integrity (see OFFLINE_MODE.md "Provisioning").
 */
export async function buildSnapshot(eventId: string): Promise<Snapshot> {
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) throw notFound("Event not found");

  const guests = await prisma.guest.findMany({
    where: { eventId, rsvpStatus: { code: "CONFIRMED" } },
    include: {
      credential: true,
      checkIn: true,
      category: true,
      parent: true,
    },
  });

  const attendees: Snapshot["attendees"] = [];
  for (const guest of guests) {
    if (!guest.credential || guest.credential.status !== "ACTIVE") continue;
    const name =
      guest.displayName ??
      [guest.title, guest.firstName, guest.lastName].filter(Boolean).join(" ").trim();
    attendees.push({
      h: guest.credential.codeHash,
      n: name,
      c: guest.category.code,
      p: guest.parentId ? 1 : 0,
      g: guest.parent
        ? [guest.parent.title, guest.parent.firstName, guest.parent.lastName].filter(Boolean).join(" ")
        : null,
      u: guest.checkIn?.scannedAt.toISOString() ?? null,
    });
  }
  attendees.sort((a, b) => a.n.localeCompare(b.n));

  const generatedAt = new Date();
  const expiresAt = new Date(generatedAt.getTime() + SNAPSHOT_TTL_HOURS * 3600 * 1000);
  const body = JSON.stringify({ eventId, generatedAt: generatedAt.toISOString(), attendees });
  return {
    version: crypto.createHash("sha256").update(body).digest("hex").slice(0, 16),
    eventId,
    eventName: event.name,
    generatedAt: generatedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    signature: hmacSha256(body, config.SNAPSHOT_SECRET),
    counts: { total: guests.length, active: attendees.length },
    attendees,
  };
}

export const syncBatchSchema = z.object({
  eventId: z.string(),
  deviceId: z.string().min(1).max(100),
  deviceName: z.string().min(1).max(100),
  snapshotVersion: z.string().max(32).optional(),
  items: z
    .array(
      z
        .object({
          localId: z.string().min(1),
          code: z.string().min(4).max(64).optional(),
          codeHash: z.string().length(64).optional(),
          gate: z.string().nullish(),
          clientTimestamp: z.string().datetime().optional(),
        })
        .refine((item) => Boolean(item.code ?? item.codeHash), {
          message: "Each item needs a code or codeHash",
        }),
    )
    .max(2000),
});

export type SyncBatchResult = {
  batchId: string;
  applied: number;
  duplicate: number;
  rejected: number;
  /** False when the device's snapshot is stale — device must refresh. */
  snapshotCurrent: boolean;
  currentSnapshotVersion: string;
  results: {
    localId: string;
    result: CheckInResult;
    guest?: string;
    alreadyAt?: string;
    replayed?: boolean;
  }[];
};

/**
 * Resolve the authorized device for a sync request.
 *
 * Primary path: the request authenticates with a DEVICE TOKEN
 * (requireDevice ran first and set req.device) — the device is pre-authorized
 * by an administrator and its identity comes from the token, not the body.
 *
 * Compat path: a staff/operator user token (checkin:operate) may sync on
 * behalf of a REGISTERED device named in the body. Unknown devices are
 * REJECTED (audit M-8): devices are never auto-registered by syncing.
 */
async function resolveDevice(
  eventId: string,
  deviceTokenAuth: Device | null,
  bodyDeviceName: string,
): Promise<Device> {
  if (deviceTokenAuth) {
    if (deviceTokenAuth.eventId !== eventId) {
      throw forbidden("Device is not authorized for this event");
    }
    return deviceTokenAuth;
  }
  const device = await prisma.device.findFirst({ where: { eventId, name: bodyDeviceName } });
  if (!device) {
    throw forbidden(
      `Device "${bodyDeviceName}" is not registered for this event. Register it first (device:manage).`,
    );
  }
  if (device.status !== "ACTIVE") {
    throw forbidden("Device is revoked");
  }
  if (device.expiresAt && device.expiresAt < new Date()) {
    throw forbidden("Device authorization has expired");
  }
  return device;
}

/**
 * Reconciliation of offline operations. Idempotency is layered:
 *  1. OfflineCheckIn (deviceId, operationId) UNIQUE — a re-uploaded batch
 *     replays its stored results instead of re-processing.
 *  2. CheckIn.operationId UNIQUE — the same admission can never be inserted
 *     twice, even across separate reconciliation attempts.
 * Conflict model (OFFLINE_MODE.md): two disconnected devices that both
 * admitted the same credential are reconciled first-received-wins — the
 * second receives ALREADY_CHECKED_IN and its operation is retained as
 * evidence. Completely disconnected devices cannot globally prevent
 * duplicate physical admission; this limitation is documented honestly.
 * Every received operation is retained, including rejected ones.
 */
export async function applySyncBatch(
  input: z.infer<typeof syncBatchSchema>,
  actor: AppUser | null,
  deviceTokenAuth: Device | null,
): Promise<SyncBatchResult> {
  const event = await prisma.event.findUnique({ where: { id: input.eventId } });
  if (!event) throw notFound("Event not found");

  const device = await resolveDevice(input.eventId, deviceTokenAuth, input.deviceName);
  await prisma.device.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } });

  // Snapshot freshness: a stale snapshot does not invalidate the admissions
  // (they physically happened) — the device is told to refresh.
  const currentSnapshot = await buildSnapshot(input.eventId);
  const snapshotCurrent =
    !input.snapshotVersion || input.snapshotVersion === currentSnapshot.version;

  const batchId = crypto.randomUUID();
  const results: SyncBatchResult["results"] = [];
  let applied = 0;
  let duplicate = 0;
  let rejected = 0;

  for (const item of input.items) {
    // Layer 1: replay protection per (device, operation).
    const prior = await prisma.offlineCheckIn.findUnique({
      where: { deviceId_operationId: { deviceId: device.id, operationId: item.localId } },
    });
    if (prior) {
      const replayResult = (prior.status === "APPLIED"
        ? "CHECKED_IN"
        : prior.status === "ALREADY_CHECKED_IN"
          ? "ALREADY_USED"
          : (prior.status as CheckInResult)) satisfies CheckInResult;
      results.push({
        localId: item.localId,
        result: replayResult,
        replayed: true,
      });
      if (replayResult === "CHECKED_IN") applied += 1;
      else if (replayResult === "ALREADY_USED") duplicate += 1;
      else rejected += 1;
      continue;
    }

    const codeHash = item.codeHash ?? (item.code ? sha256(extractCode(item.code)) : null);
    const received = await prisma.offlineCheckIn.create({
      data: {
        deviceId: device.id,
        eventId: input.eventId,
        operationId: item.localId,
        codeHash: codeHash ?? "",
        gate: item.gate ?? null,
        clientTimestamp: item.clientTimestamp ? new Date(item.clientTimestamp) : new Date(),
        status: "PENDING",
      },
    });

    if (!codeHash) {
      await prisma.offlineCheckIn.update({
        where: { id: received.id },
        data: { status: "CONFLICT", resultDetail: "No code or codeHash supplied" },
      });
      rejected += 1;
      results.push({ localId: item.localId, result: "INVALID" });
      continue;
    }

    const outcome = await attemptCheckIn({
      eventId: input.eventId,
      method: "OFFLINE_SYNC",
      gate: item.gate ?? null,
      deviceName: device.name,
      deviceId: device.id,
      actor,
      codeHash,
      clientTimestamp: item.clientTimestamp ? new Date(item.clientTimestamp) : null,
      operationId: `offline:${device.id}:${item.localId}`,
    });

    const status = outcome.result === "CHECKED_IN"
      ? "APPLIED"
      : outcome.result === "ALREADY_USED"
        ? "ALREADY_CHECKED_IN"
        : (outcome.result as "INVALID" | "CANCELLED" | "REPLACED" | "EXPIRED" | "GUEST_CANCELLED");

    await prisma.offlineCheckIn.update({
      where: { id: received.id },
      data: {
        status,
        resultDetail: outcome.result,
        checkInId: outcome.checkIn?.id ?? null,
      },
    });

    if (outcome.result === "CHECKED_IN") applied += 1;
    else if (outcome.result === "ALREADY_USED") duplicate += 1;
    else rejected += 1;

    results.push({
      localId: item.localId,
      result: outcome.result,
      guest: outcome.guest?.displayName,
      alreadyAt: outcome.alreadyAt?.toISOString(),
    });
  }

  await audit({
    actor,
    eventId: input.eventId,
    deviceId: device.id,
    action: "OFFLINE_SYNC",
    entityType: "Device",
    entityId: device.id,
    summary: `Device "${device.name}" synced ${input.items.length} operations: ${applied} applied, ${duplicate} duplicate, ${rejected} rejected${snapshotCurrent ? "" : " (stale snapshot)"}`,
  });

  return {
    batchId,
    applied,
    duplicate,
    rejected,
    snapshotCurrent,
    currentSnapshotVersion: currentSnapshot.version,
    results,
  };
}
