// M4 report job processing. ReportJob rows are the durable queue; the
// worker streams data in bounded chunks and writes CSV files to a local
// export directory (swappable for object storage behind this module).
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../lib/prisma.js";
import type { AuditLog, Prisma } from "../generated/prisma/client.js";
import { logger } from "../lib/logger.js";
import { audit } from "../lib/audit.js";

export const EXPORT_DIR = path.resolve(".data/exports");

// Explicit payload types: cursor pagination + conditional spreads otherwise
// create circular type inference in TS.
type GuestListRow = Prisma.GuestGetPayload<{
  include: { credential: true; checkIn: true; parent: true; category: true; rsvpStatus: true };
}>;
type AttendanceRow = Prisma.CheckInGetPayload<{
  include: { guest: { include: { category: true; parent: true } }; device: true };
}>;
type DoorListRow = Prisma.GuestGetPayload<{
  include: {
    credential: true; category: true; checkIn: true;
    companions: { include: { credential: true; rsvpStatus: true; checkIn: true; category: true } };
  };
}>;
type AuditRow = AuditLog;

export type ReportType = "GUEST_LIST" | "ATTENDANCE" | "DOOR_LIST" | "AUDIT";

const REPORT_TYPES: ReportType[] = ["GUEST_LIST", "ATTENDANCE", "DOOR_LIST", "AUDIT"];
export function isReportType(value: string): value is ReportType {
  return (REPORT_TYPES as string[]).includes(value);
}

/** Escapes cell values for CSV: prevents spreadsheet formula injection. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = value instanceof Date ? value.toISOString() : String(value);
  const needsEscape = /^[=+\-@\t\r]/.test(s);
  const guarded = needsEscape ? `'${s}` : s;
  if (/[",\r\n]/.test(guarded)) return `"${guarded.replace(/"/g, '""')}"`;
  return guarded;
}

export function csvLine(header: string[], rows: unknown[][]): string {
  return "\uFEFF" + [header.join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\r\n");
}

// --- chunked row builders (bounded memory: cursor pagination, 1000/Chunk) ---

async function* guestListRows(eventId: string): AsyncGenerator<unknown[]> {
  const header = [
    "guest_ref", "title", "first_name", "last_name", "email", "phone", "category",
    "organisation", "designation", "type", "party_of", "rsvp_status", "source",
    "table_seat", "invited_by", "credential_status", "credential_version",
    "credential_issued_at", "checked_in_at", "checked_in_gate", "checked_in_method", "notes",
  ];
  yield header as unknown[];
  let cursor: string | undefined = undefined;
  while (true) {
    const guests: GuestListRow[] = await prisma.guest.findMany({      where: { eventId },
      orderBy: { id: "asc" },
      take: 1000,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      include: { credential: true, checkIn: true, parent: true, category: true, rsvpStatus: true },
    });
    if (guests.length === 0) break;
    cursor = guests[guests.length - 1]!.id;
    for (const g of guests) {
      yield [
        g.guestRef, g.title, g.firstName, g.lastName, g.email, g.phone, g.category.code,
        g.organisation, g.designation, g.parentId ? "ACCOMPANYING" : "PRIMARY",
        g.parent ? `${g.parent.firstName} ${g.parent.lastName}` : "",
        g.rsvpStatus.code, g.source, g.tableSeat, g.invitedBy,
        g.credential?.status ?? "NONE", g.credential?.versionNumber ?? "",
        g.credential?.issuedAt ?? "",
        g.checkIn?.scannedAt ?? "", g.checkIn?.gate ?? "", g.checkIn?.method ?? "", g.notes,
      ];
    }
  }
}

async function* attendanceRows(eventId: string): AsyncGenerator<unknown[]> {
  const header = ["check_in_id", "operation_id", "scanned_at", "client_scan_time", "guest",
    "category", "type", "method", "gate", "device", "operator_user_id"];
  yield header as unknown[];
  let cursor: string | undefined = undefined;
  while (true) {
    const checkIns: AttendanceRow[] = await prisma.checkIn.findMany({
      where: { eventId },
      orderBy: { id: "asc" },
      take: 1000,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      include: { guest: { include: { category: true, parent: true } }, device: true },
    });
    if (checkIns.length === 0) break;
    cursor = checkIns[checkIns.length - 1]!.id;
    for (const c of checkIns) {
      yield [
        c.id, c.operationId, c.scannedAt, c.clientTimestamp ?? "",
        c.guest.displayName ?? `${c.guest.firstName} ${c.guest.lastName}`,
        c.guest.category.code, c.guest.parentId ? "ACCOMPANYING" : "PRIMARY",
        c.method, c.gate ?? "", c.device?.name ?? "", c.operatorUserId ?? "",
      ];
    }
  }
}

async function* doorListRows(eventId: string): AsyncGenerator<unknown[]> {
  const header = ["last_name", "first_name", "title", "category", "party_size",
    "credential_last4", "manual_code", "checked_in", "notes"];
  yield header as unknown[];
  let cursor: string | undefined = undefined;
  while (true) {
    const guests: DoorListRow[] = await prisma.guest.findMany({
      where: { eventId, parentId: null, rsvpStatus: { code: "CONFIRMED" } },
      orderBy: [{ lastName: "asc" }, { id: "asc" }],
      take: 1000,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      include: {
        credential: true,
        category: true,
        checkIn: true,
        companions: { include: { credential: true, rsvpStatus: true, checkIn: true, category: true } },
      },
    });
    if (guests.length === 0) break;
    cursor = guests[guests.length - 1]!.id;
    for (const g of guests) {
      yield [
        g.lastName, g.firstName, g.title ?? "", g.category.code,
        1 + g.companions.filter((c) => c.rsvpStatus.code === "CONFIRMED").length,
        g.credential?.codeLast4 ?? "",
        g.credential ? `${g.credential.codeLast4}xx` : "NO CREDENTIAL",
        g.checkIn ? "YES" : "",
        g.notes ?? "",
      ];
      for (const c of g.companions) {
        yield [
          c.lastName, c.firstName, c.title ?? "", c.category.code, "", c.credential?.codeLast4 ?? "",
          c.displayName ?? "Accompanying guest", c.checkIn ? "YES" : "", "ACCOMPANYING",
        ];
      }
    }
  }
}

async function* auditRows(eventId: string): AsyncGenerator<unknown[]> {
  const header = ["at", "actor", "action", "result", "entity_type", "entity_id", "summary"];
  yield header as unknown[];
  let cursor: string | undefined = undefined;
  while (true) {
    const logs: AuditRow[] = await prisma.auditLog.findMany({
      where: { OR: [{ eventId }, { eventId: null }], ...(cursor ? { id: { gt: cursor } } : {}) },
      orderBy: { id: "asc" },
      take: 1000,
    });
    if (logs.length === 0) break;
    cursor = logs[logs.length - 1]!.id;
    for (const l of logs) {
      yield [l.createdAt, l.actorLabel ?? "", l.action, l.result, l.entityType, l.entityId ?? "", l.summary];
    }
  }
}

/** Generates one QUEUED ReportJob. Chunked writes bound memory usage. */
export async function processReportJob(jobId: string): Promise<{ processed: boolean; status: string }> {
  const job = await prisma.reportJob.findUnique({ where: { id: jobId } });
  if (!job || job.status !== "QUEUED") return { processed: false, status: job?.status ?? "UNKNOWN" };

  await prisma.reportJob.update({ where: { id: jobId }, data: { status: "PROCESSING" } });
  try {
    fs.mkdirSync(EXPORT_DIR, { recursive: true });
    const filename = `report-${job.id}.csv`;
    const filePath = path.join(EXPORT_DIR, filename);
    const stream = fs.createWriteStream(filePath);

    const generator =
      job.type === "GUEST_LIST" ? guestListRows(job.eventId)
      : job.type === "ATTENDANCE" ? attendanceRows(job.eventId)
      : job.type === "DOOR_LIST" ? doorListRows(job.eventId)
      : auditRows(job.eventId);

    let first = true;
    let rowCount = 0;
    for await (const row of generator) {
      const cells = (row as unknown[]).map(csvCell);
      if (first) {
        stream.write(`\uFEFF${cells.join(",")}\r\n`);
        first = false;
      } else {
        stream.write(`${cells.join(",")}\r\n`);
        rowCount += 1;
      }
    }
    await new Promise<void>((resolve, reject) => {
      stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });

    await prisma.reportJob.update({
      where: { id: jobId },
      data: {
        status: "COMPLETED",
        fileRef: filename,
        completedAt: new Date(),
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
        filtersJson: JSON.stringify({ rows: rowCount }),
      },
    });
    await audit({
      action: "REPORT_GENERATED",
      entityType: "ReportJob",
      entityId: jobId,
      eventId: job.eventId,
      summary: `Report ${job.type} generated (${rowCount} rows)`,
    });
    return { processed: true, status: "COMPLETED" };
  } catch (err) {
    logger.error("report_job_failed", { jobId, error: err instanceof Error ? err.message : String(err) });
    await prisma.reportJob.update({
      where: { id: jobId },
      data: { status: "FAILED", error: err instanceof Error ? err.message : String(err) },
    });
    return { processed: true, status: "FAILED" };
  }
}
