import { prisma } from "./prisma.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { AppUser } from "../config.js";

export type AuditInput = {
  actor?: AppUser | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  eventId?: string | null;
  requestId?: string | null;
  deviceId?: string | null;
  result?: "SUCCESS" | "FAILURE";
  summary: string;
  before?: unknown;
  after?: unknown;
};

/**
 * Append-only audit write. There is deliberately no update/delete helper:
 * audit history is evidence and must never be edited or erased
 * (see SECURITY.md "Audit tampering").
 */
export async function audit(input: AuditInput, tx?: Prisma.TransactionClient) {
  const client = tx ?? prisma;
  await client.auditLog.create({
    data: {
      actorUserId: input.actor?.id ?? null,
      actorLabel: input.actor ? `${input.actor.name} (${input.actor.role})` : "system",
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      eventId: input.eventId ?? null,
      requestId: input.requestId ?? null,
      deviceId: input.deviceId ?? null,
      result: input.result ?? "SUCCESS",
      summary: input.summary,
      beforeJson: input.before === undefined ? null : JSON.stringify(input.before),
      afterJson: input.after === undefined ? null : JSON.stringify(input.after),
    },
  });
}

export function snapshot<T extends object>(entity: T | null | undefined): T | null {
  return entity ? JSON.parse(JSON.stringify(entity)) : null;
}
