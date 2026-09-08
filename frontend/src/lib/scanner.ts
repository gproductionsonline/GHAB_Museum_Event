"use client";

import type { SnapshotAttendee } from "./scanner-db";

export const QR_PREFIX = "GHAB1";

/** Extract the raw code from a scanned QR payload (accepts prefixed or bare). */
export function extractCode(raw: string): string | null {
  const trimmed = raw.trim().toUpperCase();
  if (trimmed.startsWith(`${QR_PREFIX}.`)) {
    return trimmed.slice(QR_PREFIX.length + 1);
  }
  if (/^[A-Z0-9]{16,32}$/.test(trimmed)) return trimmed;
  return null;
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export type LocalScanResult =
  | { kind: "CHECKED_IN"; attendee: SnapshotAttendee }
  | { kind: "ALREADY_USED"; attendee: SnapshotAttendee }
  | { kind: "CANCELLED" | "INVALID" };

export function verifyLocal(
  codeHash: string,
  attendees: SnapshotAttendee[],
): LocalScanResult {
  const attendee = attendees.find((a) => a.h === codeHash);
  if (!attendee) return { kind: "INVALID" };
  // Cancelled/revoked guests are excluded from the snapshot entirely, so a
  // code present in the snapshot but missing locally means cancellation only
  // after a re-sync. Locally-used detection:
  if (attendee.u) return { kind: "ALREADY_USED", attendee };
  return { kind: "CHECKED_IN", attendee };
}
