import { Router, type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { asyncHandler, badRequest, notFound, param } from "../../lib/http.js";
import { requirePermission } from "../../lib/auth.js";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../../lib/audit.js";
import type { AppUser } from "../../config.js";
import { rateLimit } from "../../lib/rate-limit.js";
import { isReportType, EXPORT_DIR } from "../../jobs/reports.js";

export const reportsRouter = Router();

/** Escape cell values for CSV: prevents spreadsheet formula injection. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = value instanceof Date ? value.toISOString() : String(value);
  // Formula-injection defense: prefix dangerous leading characters.
  const needsEscape = /^[=+\-@\t\r]/.test(s);
  const guarded = needsEscape ? `'${s}` : s;
  if (/[",\r\n]/.test(guarded)) return `"${guarded.replace(/"/g, '""')}"`;
  return guarded;
}

function csvBody(header: string[], rows: unknown[][]): string {
  return "\uFEFF" + [header.join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\r\n");
}

// Synchronous exports are capped; larger exports must use ReportJob.
const SYNC_EXPORT_MAX_ROWS = 5000;

// CSV exports stream up to 5,000 joined rows each; one shared per-IP budget
// across all export types bounds the database load from report hammering.
const exportLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyFn: (req) => `${req.ip ?? "unknown"}:report-exports`,
});

function sendCsv(
  res: Response,
  filename: string,
  header: string[],
  rows: unknown[][],
  actor: AppUser | null,
  eventId: string,
) {
  void audit({
    actor,
    eventId,
    action: "REPORT_EXPORTED",
    entityType: "ReportJob",
    entityId: `inline:${filename}`,
    summary: `Exported ${filename} (${rows.length} rows)`,
  });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(csvBody(header, rows));
}

reportsRouter.get(
  "/guests.csv",
  exportLimiter,
  requirePermission("report:export"),
  asyncHandler(async (req, res) => {
    const eventId = z.string().parse(req.query.eventId ?? "");
    const guests = await prisma.guest.findMany({
      where: { eventId },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      take: SYNC_EXPORT_MAX_ROWS,
      include: {
        credential: true,
        checkIn: true,
        parent: true,
        category: true,
        rsvpStatus: true,
      },
    });

    const header = [
      "guest_ref", "title", "first_name", "last_name", "email", "phone", "category",
      "organisation", "designation", "type", "party_of", "rsvp_status", "source",
      "table_seat", "invited_by", "credential_status", "credential_version",
      "credential_issued_at", "checked_in_at", "checked_in_gate", "checked_in_method", "notes",
    ];
    const rows = guests.map((g) => [
      g.guestRef, g.title, g.firstName, g.lastName, g.email, g.phone, g.category.code,
      g.organisation, g.designation, g.parentId ? "ACCOMPANYING" : "PRIMARY",
      g.parent ? `${g.parent.firstName} ${g.parent.lastName}` : "",
      g.rsvpStatus.code, g.source, g.tableSeat, g.invitedBy,
      g.credential?.status ?? "NONE", g.credential?.versionNumber ?? "",
      g.credential?.issuedAt ?? "",
      g.checkIn?.scannedAt ?? "", g.checkIn?.gate ?? "", g.checkIn?.method ?? "", g.notes,
    ]);
    sendCsv(res, "guest-list.csv", header, rows, req.user!, eventId);
  }),
);

reportsRouter.get(
  "/attendance.csv",
  exportLimiter,
  requirePermission("report:export"),
  asyncHandler(async (req, res) => {
    const eventId = z.string().parse(req.query.eventId ?? "");
    const checkIns = await prisma.checkIn.findMany({
      where: { eventId },
      orderBy: { scannedAt: "asc" },
      take: SYNC_EXPORT_MAX_ROWS,
      include: { guest: { include: { category: true, parent: true } }, device: true },
    });
    const header = ["check_in_id", "operation_id", "scanned_at", "client_scan_time", "guest",
      "category", "type", "method", "gate", "device", "operator_user_id"];
    const rows = checkIns.map((c) => [
      c.id, c.operationId, c.scannedAt, c.clientTimestamp ?? "",
      c.guest.displayName ?? `${c.guest.firstName} ${c.guest.lastName}`,
      c.guest.category.code, c.guest.parentId ? "ACCOMPANYING" : "PRIMARY",
      c.method, c.gate ?? "", c.device?.name ?? "", c.operatorUserId ?? "",
    ]);
    sendCsv(res, "attendance.csv", header, rows, req.user!, eventId);
  }),
);

reportsRouter.get(
  "/door-list.csv",
  exportLimiter,
  requirePermission("report:export"),
  asyncHandler(async (req, res) => {
    // Backup admission process: printable door list with a short manual code.
    const eventId = z.string().parse(req.query.eventId ?? "");
    const guests = await prisma.guest.findMany({
      where: { eventId, parentId: null, rsvpStatus: { code: "CONFIRMED" } },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      take: SYNC_EXPORT_MAX_ROWS,
      include: {
        credential: true,
        category: true,
        checkIn: true,
        companions: { include: { credential: true, rsvpStatus: true, checkIn: true, category: true } },
      },
    });
    const header = ["last_name", "first_name", "title", "category", "party_size",
      "credential_last4", "manual_code", "checked_in", "notes"];
    const rows: unknown[][] = [];
    for (const g of guests) {
      rows.push([
        g.lastName, g.firstName, g.title ?? "", g.category.code,
        1 + g.companions.filter((c) => c.rsvpStatus.code === "CONFIRMED").length,
        g.credential?.codeLast4 ?? "",
        g.credential ? `${g.credential.codeLast4}xx` : "NO CREDENTIAL",
        g.checkIn ? "YES" : "",
        g.notes ?? "",
      ]);
      for (const c of g.companions) {
        rows.push([
          c.lastName, c.firstName, c.title ?? "", c.category.code, "", c.credential?.codeLast4 ?? "",
          c.displayName ?? "Accompanying guest", c.checkIn ? "YES" : "", "ACCOMPANYING",
        ]);
      }
    }
    sendCsv(res, "door-list.csv", header, rows, req.user!, eventId);
  }),
);

reportsRouter.get(
  "/audit.csv",
  exportLimiter,
  requirePermission("audit:read", "report:export"),
  asyncHandler(async (req, res) => {
    const eventId = typeof req.query.eventId === "string" ? req.query.eventId : "";
    if (!eventId) throw badRequest("eventId is required");
    const logs = await prisma.auditLog.findMany({
      where: { OR: [{ eventId }, { eventId: null }] },
      orderBy: { createdAt: "desc" },
      take: 5000,
    });
    const header = ["at", "actor", "action", "result", "entity_type", "entity_id", "summary"];
    const rows = logs.map((l) => [
      l.createdAt, l.actorLabel ?? "", l.action, l.result, l.entityType, l.entityId ?? "", l.summary,
    ]);
    sendCsv(res, "audit-log.csv", header, rows, req.user!, eventId);
  }),
);

// ---------------------------------------------------------------------------
// M4: asynchronous report jobs for large exports (background generation).
// ---------------------------------------------------------------------------

const reportJobLimiter = rateLimit({ windowMs: 60 * 1000, max: 20 });

/** Queue a report job for background generation. */
reportsRouter.post(
  "/jobs",
  reportJobLimiter,
  requirePermission("report:export"),
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        eventId: z.string(),
        type: z.string().refine(isReportType, "Unknown report type"),
        format: z.enum(["CSV"]).default("CSV"),
      })
      .safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid report request");
    const event = await prisma.event.findUnique({ where: { id: parsed.data.eventId } });
    if (!event) throw notFound("Event not found");

    const job = await prisma.reportJob.create({
      data: {
        eventId: parsed.data.eventId,
        type: parsed.data.type,
        format: parsed.data.format,
        status: "QUEUED",
        createdByUserId: req.user!.id,
      },
    });
    await audit({
      actor: req.user,
      eventId: job.eventId,
      action: "REPORT_QUEUED",
      entityType: "ReportJob",
      entityId: job.id,
      summary: `Report job ${job.type} queued for ${event.name}`,
    });
    res.status(201).json({ reportJob: { id: job.id, type: job.type, status: job.status } });
  }),
);

reportsRouter.get(
  "/jobs",
  requirePermission("report:export"),
  asyncHandler(async (req, res) => {
    const eventId = typeof req.query.eventId === "string" ? req.query.eventId : undefined;
    const jobs = await prisma.reportJob.findMany({
      where: eventId ? { eventId } : undefined,
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    res.json({
      reportJobs: jobs.map((j) => ({
        id: j.id,
        type: j.type,
        format: j.format,
        status: j.status,
        rows: j.filtersJson ? (JSON.parse(j.filtersJson) as { rows?: number }).rows ?? null : null,
        createdAt: j.createdAt,
        completedAt: j.completedAt,
        expiresAt: j.expiresAt,
      })),
    });
  }),
);

reportsRouter.get(
  "/jobs/:id",
  requirePermission("report:export"),
  asyncHandler(async (req, res) => {
    const job = await prisma.reportJob.findUnique({ where: { id: param(req, "id") } });
    if (!job) throw notFound("Report job not found");
    res.json({
      reportJob: {
        id: job.id,
        type: job.type,
        status: job.status,
        error: job.error,
        rows: job.filtersJson ? (JSON.parse(job.filtersJson) as { rows?: number }).rows ?? null : null,
        createdAt: job.createdAt,
        completedAt: job.completedAt,
        expiresAt: job.expiresAt,
      },
    });
  }),
);

/** Download a completed report file (server-generated filename only — no
 *  user-controlled paths, so there is no traversal surface). */
reportsRouter.get(
  "/jobs/:id/download",
  requirePermission("report:export"),
  asyncHandler(async (req, res) => {
    const job = await prisma.reportJob.findUnique({ where: { id: param(req, "id") } });
    if (!job) throw notFound("Report job not found");
    if (job.status !== "COMPLETED" || !job.fileRef) {
      throw badRequest("Report is not ready for download");
    }
    if (job.expiresAt && job.expiresAt < new Date()) {
      throw badRequest("This report export has expired. Generate a new one.");
    }
    const filePath = path.join(EXPORT_DIR, path.basename(job.fileRef));
    if (!fs.existsSync(filePath)) throw notFound("Report file no longer exists");
    await audit({
      actor: req.user,
      eventId: job.eventId,
      action: "REPORT_DOWNLOADED",
      entityType: "ReportJob",
      entityId: job.id,
      summary: `Report ${job.type} downloaded`,
    });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${job.type.toLowerCase()}-${job.id.slice(0, 8)}.csv"`);
    fs.createReadStream(filePath).pipe(res);
  }),
);
