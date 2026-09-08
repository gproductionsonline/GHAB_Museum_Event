import { config } from "../../config.js";
import type { AppUser } from "../../config.js";
import { prisma } from "../../lib/prisma.js";
import { notFound, badRequest, conflict } from "../../lib/http.js";
import { generateCredentialCode, sha256 } from "../../lib/codes.js";
import { encryptSecret, decryptSecret } from "../../lib/crypto.js";
import { audit } from "../../lib/audit.js";
import { qrDataUrl, qrPngBuffer } from "../../lib/qr.js";
import { renderCredentialEmail, sendMail, type MailAttachment } from "../../lib/email.js";
import type { Prisma, CredentialVersion, Guest } from "../../generated/prisma/client.js";
import { displayName, lockGuestForUpdate } from "../guests/guests.service.js";
import crypto from "node:crypto";

export function qrPayload(code: string): string {
  return `${config.QR_CODE_PREFIX}.${code}`;
}

/** Accepts both the bare code and the prefixed "PREFIX.CODE" QR payload. */
export function extractCode(raw: string): string {
  const trimmed = raw.trim();
  const prefix = config.QR_CODE_PREFIX.toUpperCase();
  if (trimmed.toUpperCase().startsWith(`${prefix}.`)) {
    return trimmed.slice(prefix.length + 1).toUpperCase();
  }
  return trimmed.toUpperCase();
}

export function rawCode(credential: CredentialVersion): string {
  if (!credential.codeEnc) throw new Error("Credential code is not recoverable");
  return decryptSecret(credential.codeEnc);
}

/**
 * Issues a new credential version for a guest and atomically repoints the
 * guest's single ACTIVE credential. When reissuing, the previous version is
 * marked REPLACED first — it can never become valid again.
 *
 * Concurrency (audit M-1): the whole operation runs inside one transaction
 * that first takes a FOR UPDATE row lock on the Guest row. All credential
 * state mutations (issue/reissue/revoke/RSVP-cancel) and check-in admission
 * use the same lock, so no mutation can act on stale state — the
 * revoke-vs-reissue race can no longer leave an orphaned ACTIVE credential.
 */
export async function issueCredential(
  guestId: string,
  actor: AppUser | null,
  opts: { reissue?: boolean; reason?: string } = {},
  tx?: Prisma.TransactionClient,
): Promise<CredentialVersion> {
  if (!tx) {
    return prisma.$transaction((t) => issueCredential(guestId, actor, opts, t));
  }
  const db = tx;
  await lockGuestForUpdate(db, guestId);
  const guest = await db.guest.findUnique({
    where: { id: guestId },
    include: { rsvpStatus: true, credential: true },
  });
  if (!guest) throw notFound("Guest not found");
  if (guest.rsvpStatus.code !== "CONFIRMED") {
    throw badRequest(`Cannot issue a credential to a guest whose RSVP is ${guest.rsvpStatus.code}`);
  }
  if (guest.activeCredentialId && !opts.reissue) {
    throw conflict("Guest already has an active credential. Revoke or reissue instead.");
  }

  const code = generateCredentialCode();
  const lastVersion = await db.credentialVersion.findFirst({
    where: { guestId },
    orderBy: { versionNumber: "desc" },
    select: { versionNumber: true },
  });

  const credential = await db.credentialVersion.create({
    data: {
      guestId,
      eventId: guest.eventId,
      versionNumber: (lastVersion?.versionNumber ?? 0) + 1,
      codeHash: sha256(code),
      codeEnc: encryptSecret(code),
      codeLast4: code.slice(-4),
      status: "ACTIVE",
    },
  });

  // Old version becomes immutable evidence: REPLACED can never re-activate.
  if (opts.reissue && guest.credential && guest.credential.id !== credential.id) {
    await db.credentialVersion.update({
      where: { id: guest.credential.id },
      data: {
        status: "REPLACED",
        revokedAt: guest.credential.revokedAt ?? new Date(),
        revokedReason: guest.credential.revokedReason ?? (opts.reason ?? "Replaced by reissue"),
      },
    });
  }

  await db.guest.update({
    where: { id: guestId },
    data: { activeCredentialId: credential.id },
  });

  await audit(
    {
      actor,
      eventId: guest.eventId,
      action: opts.reissue ? "CREDENTIAL_REISSUED" : "CREDENTIAL_ISSUED",
      entityType: "CredentialVersion",
      entityId: credential.id,
      summary: opts.reissue
        ? `Credential v${credential.versionNumber} reissued for ${displayName(guest)}${opts.reason ? `: ${opts.reason}` : ""}`
        : `Credential v${credential.versionNumber} issued for ${displayName(guest)}`,
      before: opts.reissue
        ? { version: guest.credential?.versionNumber ?? null, status: guest.credential?.status ?? null }
        : undefined,
      after: { version: credential.versionNumber, status: credential.status },
    },
    db,
  );
  return credential;
}

export async function reissueCredential(
  guestId: string,
  reason: string | undefined,
  actor: AppUser,
): Promise<CredentialVersion> {
  const guest = await prisma.guest.findUnique({ where: { id: guestId } });
  if (!guest) throw notFound("Guest not found");
  // issueCredential(reissue) runs inside one transaction: old -> REPLACED,
  // new row created, guest pointer swapped. Old QR is dead from this moment.
  return prisma.$transaction((tx) => issueCredential(guestId, actor, { reissue: true, reason }, tx));
}

/**
 * Revoke the guest's active credential. The entire read-validate-mutate
 * sequence runs inside one transaction under the Guest row lock (audit M-1):
 * the active credential is resolved AFTER the lock, so a concurrent reissue
 * cannot leave an orphaned ACTIVE credential behind a nulled pointer.
 */
export async function revokeCredential(
  guestId: string,
  reason: string | undefined,
  actor: AppUser,
): Promise<CredentialVersion> {
  return prisma.$transaction(async (tx) => {
    await lockGuestForUpdate(tx, guestId);
    const guest = await tx.guest.findUnique({
      where: { id: guestId },
      include: { credential: true },
    });
    if (!guest) throw notFound("Guest not found");
    if (!guest.credential) throw notFound("No active credential for this guest");
    if (guest.credential.status !== "ACTIVE") {
      throw badRequest(`Credential is already ${guest.credential.status}`);
    }

    const updated = await tx.credentialVersion.update({
      where: { id: guest.credential.id },
      data: { status: "REVOKED", revokedAt: new Date(), revokedReason: reason ?? "No reason given" },
    });
    await tx.guest.update({ where: { id: guestId }, data: { activeCredentialId: null } });
    await audit({
      actor,
      eventId: guest.eventId,
      action: "CREDENTIAL_REVOKED",
      entityType: "CredentialVersion",
      entityId: updated.id,
      summary: `Credential for ${displayName(guest)} revoked: ${reason ?? "no reason given"}`,
    });
    return updated;
  });
}

export async function guestQrDataUrl(
  guestId: string,
): Promise<{ code: string; dataUrl: string; versionNumber: number } | null> {
  const guest = await prisma.guest.findUnique({ where: { id: guestId }, include: { credential: true } });
  if (!guest?.credential || guest.credential.status !== "ACTIVE") return null;
  const code = rawCode(guest.credential);
  return {
    code,
    dataUrl: await qrDataUrl(qrPayload(code)),
    versionNumber: guest.credential.versionNumber,
  };
}

export async function credentialQrPng(
  guestId: string,
): Promise<{ code: string; versionNumber: number; png: Buffer }> {
  const guest = await prisma.guest.findUnique({ where: { id: guestId }, include: { credential: true } });
  if (!guest?.credential) throw notFound("No credential for this guest");
  const code = rawCode(guest.credential);
  return {
    code,
    versionNumber: guest.credential.versionNumber,
    png: await qrPngBuffer(qrPayload(code)),
  };
}

async function buildPartyEmail(
  guest: Guest & { credential: CredentialVersion | null },
): Promise<{
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments: MailAttachment[];
  credentialVersionId: string;
} | null> {
  if (!guest.credential || guest.credential.status !== "ACTIVE") return null;
  const mainCode = rawCode(guest.credential);
  const mainQr = await qrDataUrl(qrPayload(mainCode));

  const companionsWithoutEmail = await prisma.guest.findMany({
    where: { parentId: guest.id, rsvpStatus: { code: "CONFIRMED" }, email: null },
    include: { credential: true },
  });

  const extras: { displayName: string; code: string; qrDataUrl: string }[] = [];
  for (const companion of companionsWithoutEmail) {
    if (!companion.credential || companion.credential.status !== "ACTIVE") continue;
    const code = rawCode(companion.credential);
    extras.push({
      displayName: displayName(companion),
      code,
      qrDataUrl: await qrDataUrl(qrPayload(code)),
    });
  }

  const event = await prisma.event.findUniqueOrThrow({ where: { id: guest.eventId } });
  const html = renderCredentialEmail({
    code: mainCode,
    qrDataUrl: mainQr,
    guest: {
      displayName: displayName(guest),
      category: "",
      organisation: guest.organisation,
      tableSeat: guest.tableSeat,
    },
    event,
    extraGuests: extras,
  });

  const attachments: MailAttachment[] = [
    {
      filename: `qr-${mainCode}.png`,
      content: Buffer.from(mainQr.split(",")[1]!, "base64"),
      cid: "qr-main",
      contentType: "image/png",
    },
    ...extras.map((e) => ({
      filename: `qr-${e.code}.png`,
      content: Buffer.from(e.qrDataUrl.split(",")[1]!, "base64"),
      cid: `qr-${e.code}`,
      contentType: "image/png",
    })),
  ];

  return {
    to: guest.email!,
    subject: `Your admission credential — ${event.name}`,
    html,
    text: `Your admission code for ${event.name}: ${mainCode}. Present this code at the entrance.`,
    attachments,
    credentialVersionId: guest.credential.id,
  };
}

/**
 * Worker-facing send path (M4): renders and sends the party email for an
 * EmailDelivery row. Throwing marks the delivery FAILED with retry.
 */
export async function sendDelivery(
  delivery: { guestId: string; subject: string },
): Promise<{ delivered: boolean; detail: string }> {
  const guest = await prisma.guest.findUnique({
    where: { id: delivery.guestId },
    include: { credential: true },
  });
  if (!guest?.credential || guest.credential.status !== "ACTIVE" || !guest.email) {
    throw new Error("Guest, active credential, or email no longer available");
  }
  const mail = await buildPartyEmail(guest);
  if (!mail) throw new Error("Could not build the credential email");
  return sendMail({
    to: mail.to,
    subject: delivery.subject || mail.subject,
    html: mail.html,
    text: mail.text,
    attachments: mail.attachments,
  });
}

export async function emailGuestCredential(
  guestId: string,
  actor: AppUser,
  opts: { idempotencyKey?: string } = {},
): Promise<{ delivered: boolean; detail: string; alreadySent?: boolean }> {
  const guest = await prisma.guest.findUnique({
    where: { id: guestId },
    include: { credential: true },
  });
  if (!guest) throw notFound("Guest not found");
  if (!guest.credential) throw badRequest("Guest has no credential — issue one first");
  if (guest.credential.status !== "ACTIVE") throw badRequest(`Credential is ${guest.credential.status}`);
  if (!guest.email) throw badRequest("Guest has no email address on file");

  const idempotencyKey = opts.idempotencyKey ?? crypto.randomUUID();

  // Idempotency: a bulk resend for the same logical delivery is not repeated.
  const existing = await prisma.emailDelivery.findUnique({ where: { idempotencyKey } });
  if (existing?.status === "SENT") {
    return { delivered: true, detail: "Already sent earlier", alreadySent: true };
  }

  const mail = await buildPartyEmail(guest);
  if (!mail) throw badRequest("Could not build the credential email");

  const result = await sendMail(mail);
  await prisma.emailDelivery.upsert({
    where: { idempotencyKey },
    create: {
      guestId,
      credentialVersionId: mail.credentialVersionId,
      idempotencyKey,
      recipient: mail.to,
      subject: mail.subject,
      status: result.delivered ? "SENT" : "FAILED",
      attempts: 1,
      provider: result.delivered ? "resend" : "outbox",
      sentAt: result.delivered ? new Date() : null,
      error: result.delivered ? null : result.detail,
    },
    update: {
      status: result.delivered ? "SENT" : "FAILED",
      attempts: { increment: 1 },
      provider: result.delivered ? "resend" : "outbox",
      sentAt: result.delivered ? new Date() : null,
      error: result.delivered ? null : result.detail,
    },
  });
  await audit({
    actor,
    eventId: guest.eventId,
    action: "CREDENTIAL_EMAILED",
    entityType: "CredentialVersion",
    entityId: mail.credentialVersionId,
    summary: `Credential email ${result.delivered ? "sent" : "written to outbox"} to ${guest.email} for ${displayName(guest)}`,
  });
  return result;
}

export type BulkEmailResult = {
  issued: number;
  queued: number;
  alreadyHandled: number;
  failed: { guestId: string; guest: string; error: string }[];
};

/**
 * Bulk issue + queue email delivery (M4). When `guestIds` is provided, only
 * those primary guests are processed; otherwise every confirmed primary
 * guest whose active credential has not been sent is included. Queueing is
 * idempotent per credential version (idempotencyKey = credential-<id>), so
 * re-running never duplicates a delivery. The email worker sends and retries.
 */
export async function bulkIssueAndEmail(
  eventId: string,
  actor: AppUser,
  guestIds?: string[],
): Promise<BulkEmailResult> {
  const selection = guestIds && guestIds.length > 0 ? { in: guestIds } : undefined;

  const guestsNeedingCredential = await prisma.guest.findMany({
    where: {
      eventId,
      parentId: null,
      rsvpStatus: { code: "CONFIRMED" },
      activeCredentialId: null,
      ...(selection ? { id: selection } : {}),
    },
    take: 500,
  });
  for (const g of guestsNeedingCredential) {
    await issueCredential(g.id, actor);
  }

  const pending = await prisma.guest.findMany({
    where: {
      eventId,
      parentId: null,
      rsvpStatus: { code: "CONFIRMED" },
      email: { not: null },
      activeCredentialId: { not: null },
      credential: { emailDeliveries: { none: { status: "SENT" } } },
      ...(selection ? { id: selection } : {}),
    },
    include: { credential: true },
    orderBy: { lastName: "asc" },
    take: 500,
  });

  const result: BulkEmailResult = {
    issued: guestsNeedingCredential.length,
    queued: 0,
    alreadyHandled: 0,
    failed: [],
  };
  const { queueCredentialDelivery } = await import("../../jobs/email.js");
  for (const guest of pending) {
    try {
      const r = await queueCredentialDelivery(guest.id, `credential-${guest.credential!.id}`);
      if (r.queued) result.queued += 1;
      else if (r.alreadyHandled) result.alreadyHandled += 1;
      else result.failed.push({ guestId: guest.id, guest: displayName(guest), error: "Guest has no emailable credential" });
    } catch (err) {
      result.failed.push({
        guestId: guest.id,
        guest: displayName(guest),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  await audit({
    actor,
    eventId,
    action: "BULK_EMAIL_QUEUED",
    entityType: "Event",
    entityId: eventId,
    summary: `Bulk credential email: ${result.issued} credentials issued, ${result.queued} deliveries queued${result.failed.length ? `, ${result.failed.length} failed to queue` : ""}`,
  });
  return result;
}
