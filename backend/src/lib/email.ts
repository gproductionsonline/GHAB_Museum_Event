import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

const OUTBOX_DIR = path.resolve(".data/outbox");
const RESEND_ENDPOINT = "https://api.resend.com/emails";

export type MailAttachment = {
  filename: string;
  content: Buffer;
  cid?: string;
  contentType: string;
};

export type MailInput = {
  to: string;
  subject: string;
  html: string;
  text?: string;
  attachments?: MailAttachment[];
};

export async function sendMail(input: MailInput): Promise<{ delivered: boolean; detail: string }> {
  if (config.resendEnabled) return sendViaResend(input);
  return writeToOutbox(input);
}

/**
 * Resend delivery (https://resend.com — POST /emails, Bearer API key).
 * Inline QR images ride as attachments with `content_id`, matching the
 * `cid:qr-…` references in the rendered HTML. Any non-2xx response throws so
 * the email worker's bounded retry/backoff handles transient failures
 * (Resend 429/5xx) and records permanent ones (invalid key, unverified
 * domain) on the EmailDelivery row.
 */
async function sendViaResend(input: MailInput): Promise<{ delivered: boolean; detail: string }> {
  const res = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: config.EMAIL_FROM,
      to: input.to,
      subject: input.subject,
      html: input.html,
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.attachments?.length
        ? {
            attachments: input.attachments.map((a) => ({
              filename: a.filename,
              content: a.content.toString("base64"),
              content_type: a.contentType,
              ...(a.cid ? { content_id: a.cid } : {}),
            })),
          }
        : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend API error ${res.status}: ${summarizeProviderError(body)}`);
  }
  const data = (await res.json().catch(() => ({}))) as { id?: string };
  return { delivered: true, detail: `sent via Resend (${data.id ?? "unknown id"})` };
}

/** Safe, bounded provider message for the EmailDelivery.error column and
 *  logs. The API key travels in headers and can never appear in the body. */
function summarizeProviderError(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    const message = typeof parsed.message === "string" ? parsed.message : body;
    return message.slice(0, 300) || "no response body";
  } catch {
    return body.slice(0, 300) || "no response body";
  }
}

/** Offline/dev fallback: write the email to .data/outbox for manual review.
 *  Inline any CID attachments so the preview renders without a mail client. */
async function writeToOutbox(input: MailInput): Promise<{ delivered: boolean; detail: string }> {
  fs.mkdirSync(OUTBOX_DIR, { recursive: true });
  let previewHtml = input.html;
  for (const att of input.attachments ?? []) {
    if (att.cid) {
      previewHtml = previewHtml.replaceAll(
        `cid:${att.cid}`,
        `data:${att.contentType};base64,${att.content.toString("base64")}`,
      );
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeTo = input.to.replace(/[^a-zA-Z0-9@.-]/g, "_");
  const file = path.join(OUTBOX_DIR, `${stamp}_${safeTo}.html`);
  const banner = `<html><body style="margin:0"><p style="background:#fef3c7;padding:8px;font-family:sans-serif;border-bottom:1px solid #e5e7eb">DEV OUTBOX — Resend is not configured. This email was not delivered; review and send/print manually if needed.</p>${previewHtml}</body></html>`;
  fs.writeFileSync(file, banner, "utf8");
  console.log(`[mail:outbox] ${input.to} "${input.subject}" -> ${file}`);
  return { delivered: false, detail: `written to outbox: ${path.basename(file)}` };
}

export type CredentialEmailGuest = {
  displayName: string;
  category: string;
  organisation?: string | null;
  tableSeat?: string | null;
};

export type CredentialEmailEvent = {
  name: string;
  startsAt: Date;
  endsAt?: Date | null;
  venue?: string | null;
};

export type CredentialEmailCode = {
  code: string;
  qrDataUrl: string;
  guest: CredentialEmailGuest;
  event: CredentialEmailEvent;
  extraGuests?: { displayName: string; code: string; qrDataUrl: string }[];
};

function fmtDate(d: Date): string {
  return d.toLocaleString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

export function renderCredentialEmail(data: CredentialEmailCode): string {
  const { guest, event } = data;
  const when = fmtDate(event.startsAt) + (event.endsAt ? ` – ${fmtDate(event.endsAt)}` : "");
  const where = event.venue ?? "Government House";
  const grouped = data.code.match(/.{1,5}/g)?.join(" ") ?? data.code;

  const companionBlocks = (data.extraGuests ?? [])
    .map(
      (g) => `
    <td style="padding:16px;text-align:center;border:1px solid #e5e7eb;border-radius:8px">
      <div style="font-weight:bold;font-size:14px;margin-bottom:8px">${escapeHtml(g.displayName)}</div>
      <img src="cid:qr-${g.code}" alt="QR code" width="180" height="180" style="display:block;margin:0 auto"/>
      <div style="font-family:monospace;font-size:12px;margin-top:8px;letter-spacing:1px">${g.code.match(/.{1,5}/g)?.join(" ")}</div>
    </td>`,
    )
    .join("");

  return `
<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Georgia,'Times New Roman',serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 0">
    <tr><td align="center">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
        <tr>
          <td style="background:#0f2a4a;color:#ffffff;padding:28px 36px;text-align:center">
            <div style="font-size:13px;letter-spacing:3px;text-transform:uppercase;color:#d4af37">Government House</div>
            <div style="font-size:22px;font-weight:bold;margin-top:6px">${escapeHtml(event.name)}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:28px 36px">
            <p style="margin:0 0 4px;font-size:16px">Dear ${escapeHtml(guest.displayName)},</p>
            <p style="margin:0 0 18px;color:#4b5563;font-size:14px;line-height:1.6">
              Your admission credential for the event below is confirmed. Please present the QR code
              on this message at the entrance, either printed or on your phone. This credential is
              unique, single-use and non-transferable.
            </p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:22px">
              <tr><td style="padding:14px 18px;font-size:14px;color:#374151"><b>When:</b> ${escapeHtml(when)}</td></tr>
              <tr><td style="padding:0 18px 14px;font-size:14px;color:#374151"><b>Where:</b> ${escapeHtml(where)}</td></tr>
              <tr><td style="padding:0 18px 14px;font-size:14px;color:#374151"><b>Category:</b> ${escapeHtml(guest.category.replace(/_/g, " "))}</td></tr>
              ${guest.tableSeat ? `<tr><td style="padding:0 18px 14px;font-size:14px;color:#374151"><b>Seat:</b> ${escapeHtml(guest.tableSeat)}</td></tr>` : ""}
            </table>
            <div style="text-align:center;padding:22px;border:2px dashed #d4af37;border-radius:10px">
              <img src="cid:qr-main" alt="Your admission QR code" width="220" height="220" style="display:block;margin:0 auto"/>
              <div style="font-family:'Courier New',monospace;font-size:16px;font-weight:bold;margin-top:10px;letter-spacing:2px">${grouped}</div>
              <div style="color:#6b7280;font-size:12px;margin-top:6px">Present this code at the entrance</div>
            </div>
            ${data.extraGuests?.length ? `
            <p style="font-size:14px;color:#374151;margin:22px 0 10px"><b>Credentials for accompanying guests of your party:</b></p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${companionBlocks}</tr></table>` : ""}
            <p style="color:#6b7280;font-size:12px;margin-top:24px;line-height:1.6">
              If you cannot attend, please inform Government House so your credential can be released.
              Do not forward this email or share the code — admission will be refused if the code has
              already been used, cancelled or replaced.
            </p>
          </td>
        </tr>
        <tr><td style="background:#f3f4f6;color:#6b7280;font-size:11px;text-align:center;padding:14px">Issued by Government House — Event Admissions</td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`.trimStart();
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
