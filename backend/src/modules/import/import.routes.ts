import { Router } from "express";
import multer from "multer";
import { asyncHandler, badRequest, notFound, param } from "../../lib/http.js";
import { requirePermission } from "../../lib/auth.js";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../../lib/audit.js";
import { rateLimit } from "../../lib/rate-limit.js";
import { parseGuestFile, validateRows, queueImportCommit } from "./import.service.js";

// Upload hardening: memory storage only (nothing is executed or written to
// disk), strict size limit (5 MB — realistic for a 10,000-row guest list),
// extension allowlist enforced in parseGuestFile, hard row/column caps.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 10 },
});

// File parsing and commit queueing are heavy operations; tight budgets stop a
// runaway client from monopolizing the event loop or the job runner.
const previewLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });
const commitLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyFn: (req) => `${req.ip ?? "unknown"}:import-commit`,
});

export const importRouter = Router();

importRouter.post(
  "/preview",
  previewLimiter,
  requirePermission("import:manage"),
  upload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest("Upload a .csv or .xlsx file as the 'file' field");
    const eventId = req.body.eventId;
    if (!eventId) throw badRequest("eventId is required");
    const event = await prisma.event.findUnique({ where: { id: eventId } });
    if (!event) throw badRequest("Event not found");

    const rawRows = parseGuestFile(req.file.buffer, req.file.originalname);

    // Category validation against the event's administrator-managed set.
    const categories = await prisma.guestCategory.findMany({
      where: { eventId, active: true },
      select: { code: true },
    });
    const { rows, errors, skipped } = await validateRows(rawRows, categories);

    // Duplicate detection: against existing guests and within the file.
    const existing = new Set(
      (
        await prisma.guest.findMany({
          where: { eventId, parentId: null },
          select: { normalizedName: true },
        })
      ).map((g) => g.normalizedName),
    );
    const seen = new Set<string>();
    const duplicateErrors: typeof errors = [];
    const uniqueRows = rows.filter((row) => {
      const key = `${row.firstName.toLowerCase()} ${row.lastName.toLowerCase()}`.trim();
      if (existing.has(key)) {
        duplicateErrors.push({ row: -1, message: `${row.firstName} ${row.lastName} already exists in this event — skipped at commit` });
        return false;
      }
      if (seen.has(key)) {
        duplicateErrors.push({ row: -1, message: `Duplicate row in file: ${row.firstName} ${row.lastName} — only the first was kept` });
        return false;
      }
      seen.add(key);
      return true;
    });
    errors.push(...duplicateErrors);

    const job = await prisma.importJob.create({
      data: {
        eventId,
        filename: req.file.originalname,
        status: "PREVIEW",
        totalRows: rawRows.length,
        validRows: uniqueRows.length,
        errorCount: errors.length,
        skippedRows: skipped.length,
        rowsJson: JSON.stringify(uniqueRows),
        createdByUserId: req.user!.id,
      },
    });

    // Persist row errors as evidence (ImportRowError), bounded to sane volume.
    if (errors.length > 0) {
      await prisma.importRowError.createMany({
        data: errors.slice(0, 500).map((e) => ({
          importJobId: job.id,
          rowNumber: e.row,
          field: e.field ?? null,
          message: e.message,
        })),
      });
    }

    await audit({
      actor: req.user,
      eventId,
      action: "IMPORT_PREVIEWED",
      entityType: "ImportJob",
      entityId: job.id,
      summary: `Previewed ${req.file.originalname}: ${rawRows.length} rows, ${uniqueRows.length} valid, ${errors.length} errors`,
      requestId: req.requestId,
    });

    res.json({
      batchId: job.id,
      importJobId: job.id,
      filename: job.filename,
      totalRows: job.totalRows,
      validRows: job.validRows,
      errorCount: job.errorCount,
      skippedRows: job.skippedRows,
      errors: errors.slice(0, 50),
      skipped: skipped.slice(0, 50),
      sample: uniqueRows.slice(0, 5),
    });
  }),
);

/**
 * Queue the import for background processing (M4). The response returns
 * immediately; poll GET /import/:jobId for progress and the result summary.
 */
importRouter.post(
  "/:jobId/commit",
  commitLimiter,
  requirePermission("import:manage"),
  asyncHandler(async (req, res) => {
    const result = await queueImportCommit(param(req, "jobId"), req.user!);
    res.json({ ...result, batchId: result.importJobId });
  }),
);

/** Import job detail: status, result summary, and persisted row errors. */
importRouter.get(
  "/:jobId",
  requirePermission("import:manage"),
  asyncHandler(async (req, res) => {
    const jobId = param(req, "jobId");
    const job = await prisma.importJob.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        filename: true,
        status: true,
        totalRows: true,
        validRows: true,
        errorCount: true,
        skippedRows: true,
        resultJson: true,
        createdAt: true,
        committedAt: true,
        completedAt: true,
      },
    });
    if (!job) throw notFound("Import job not found");
    const errors = await prisma.importRowError.findMany({
      where: { importJobId: jobId },
      orderBy: { rowNumber: "asc" },
      take: 100,
    });
    res.json({
      importJob: { ...job, result: job.resultJson ? JSON.parse(job.resultJson) : null },
      errors,
    });
  }),
);

importRouter.get(
  "/batches",
  requirePermission("import:manage"),
  asyncHandler(async (req, res) => {
    const eventId = typeof req.query.eventId === "string" ? req.query.eventId : null;
    const batches = await prisma.importJob.findMany({
      where: eventId ? { eventId } : undefined,
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        filename: true,
        status: true,
        totalRows: true,
        validRows: true,
        errorCount: true,
        skippedRows: true,
        createdAt: true,
        committedAt: true,
      },
    });
    res.json({ batches });
  }),
);

/** CSV template download for Government House's guest list. */
importRouter.get(
  "/template.csv",
  requirePermission("import:manage"),
  asyncHandler(async (_req, res) => {
    const header = "guest_ref,title,first_name,last_name,email,phone,guest_category,organisation,designation,accompanying_guest_allowed,accompanying_guests,accompanying_names,accompanying_email,table_seat,invited_by,rsvp_status,notes";
    const example = "GH-0001,Hon.,Ada,Smith,ada.smith@example.gov,+12685550001,VIP,Ministry of Foreign Affairs,Minister,yes,1,James Smith;,,T1,Protocol Office,ACCEPTED,Allergy: nuts";
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="guest-list-template.csv"');
    res.send(`\uFEFF${header}\n${example}\n`);
  }),
);
