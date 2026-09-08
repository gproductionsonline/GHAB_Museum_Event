// M4 email job processing. Workers are plain exported functions so tests can
// drive them deterministically; runner.ts schedules them on intervals in the
// server process. State lives in EmailDelivery rows (queue, attempts, retry
// schedule) — never in memory — so the model is horizontally extensible.
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { config } from "../config.js";
import { sendDelivery } from "../modules/credentials/credentials.service.js";

export const MAX_EMAIL_ATTEMPTS = Number(process.env.EMAIL_MAX_ATTEMPTS ?? 5);

/** Exponential backoff: 30s, 1m, 2m, 4m … capped at 1h. */
export function nextRetryDelayMs(attempts: number): number {
  return Math.min(30_000 * 2 ** (attempts - 1), 3600_000);
}

/**
 * Processes due email deliveries (QUEUED, or FAILED with retries remaining
 * and a due nextAttemptAt). Bounded per batch; no duplicate sends: the
 * idempotencyKey upsert at queue time guarantees one delivery row per
 * logical send, and this worker is the only state machine moving it.
 * Returns the number of deliveries processed.
 */
export async function processEmailQueue(limit = 10): Promise<{
  processed: number;
  sent: number;
  failed: number;
  terminal: number;
}> {
  const now = new Date();
  const due = await prisma.emailDelivery.findMany({
    where: {
      OR: [
        { status: "QUEUED" },
        {
          status: "FAILED",
          attempts: { lt: MAX_EMAIL_ATTEMPTS },
          nextAttemptAt: { lte: now },
        },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  let sent = 0;
  let failed = 0;
  let terminal = 0;

  for (const delivery of due) {
    await prisma.emailDelivery.update({
      where: { id: delivery.id },
      data: { status: "SENDING" },
    });
    try {
      const result = await sendDelivery(delivery);
      await prisma.emailDelivery.update({
        where: { id: delivery.id },
        data: {
          status: "SENT",
          sentAt: new Date(),
          provider: result.delivered ? "resend" : "outbox",
          error: result.delivered ? null : result.detail,
          attempts: { increment: 1 },
          nextAttemptAt: null,
        },
      });
      sent += 1;
    } catch (err) {
      const attempts = delivery.attempts + 1;
      const exhausted = attempts >= MAX_EMAIL_ATTEMPTS;
      await prisma.emailDelivery.update({
        where: { id: delivery.id },
        data: {
          status: "FAILED",
          attempts,
          nextAttemptAt: exhausted ? null : new Date(Date.now() + nextRetryDelayMs(attempts)),
          error: err instanceof Error ? err.message : String(err),
        },
      });
      failed += 1;
      if (exhausted) terminal += 1;
      logger.warn("email_delivery_failed", {
        deliveryId: delivery.id,
        attempts,
        exhausted,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { processed: due.length, sent, failed, terminal };
}

/** Queue a credential email without sending: returns false when a delivery
 *  for the same logical send already exists (idempotent). */
export async function queueCredentialDelivery(
  guestId: string,
  idempotencyKey: string,
): Promise<{ queued: boolean; alreadyHandled: boolean }> {
  const guest = await prisma.guest.findUnique({
    where: { id: guestId },
    include: { credential: true, rsvpStatus: true },
  });
  if (!guest || !guest.credential || guest.credential.status !== "ACTIVE" || !guest.email) {
    return { queued: false, alreadyHandled: false };
  }
  const existing = await prisma.emailDelivery.findUnique({ where: { idempotencyKey } });
  if (existing && (existing.status === "SENT" || existing.status === "QUEUED" || existing.status === "SENDING")) {
    return { queued: false, alreadyHandled: true };
  }
  await prisma.emailDelivery.upsert({
    where: { idempotencyKey },
    create: {
      guestId,
      credentialVersionId: guest.credential.id,
      idempotencyKey,
      recipient: guest.email,
      subject: "Your admission credential",
      status: "QUEUED",
    },
    update: {
      status: "QUEUED",
      guestId,
      credentialVersionId: guest.credential.id,
      recipient: guest.email,
      nextAttemptAt: null,
    },
  });
  return { queued: true, alreadyHandled: false };
}

void config; // reserved: future provider routing configuration
