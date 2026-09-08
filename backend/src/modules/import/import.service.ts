import { parse as parseCsvSync } from "csv-parse/sync";
import * as XLSX from "xlsx";
import { prisma } from "../../lib/prisma.js";
import { badRequest, notFound, unprocessable } from "../../lib/http.js";
import { audit } from "../../lib/audit.js";
import type { AppUser } from "../../config.js";
import { createGuestWithCredential, type CreateGuestInput } from "../guests/guests.service.js";
import { issueCredential } from "../credentials/credentials.service.js";
import { scheduleStatsBroadcast } from "../stats/stats.service.js";
import { logger } from "../../lib/logger.js";

/**
 * Hard import limits (audit M-4). 10,000 rows is far above any realistic
 * Government House guest list (hundreds to a few thousand), keeps preview
 * memory, rowsJson size, and commit duration bounded, and rejects oversized
 * files with a clear validation error instead of degrading the API.
 */
export const MAX_IMPORT_ROWS = 10_000;
export const MAX_IMPORT_COLUMNS = 200;

export type NormalizedRow = {
  guestRef: string | null;
  title: string | null;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  organisation: string | null;
  designation: string | null;
  category: string; // GuestCategory code
  rsvpStatus: string; // RsvpStatus code
  accompanyingGuests: number;
  accompanyingNames: { firstName: string; lastName: string; email: string | null }[];
  tableSeat: string | null;
  invitedBy: string | null;
  notes: string | null;
};

export type RowError = { row: number; field?: string; message: string };
export type RowSkipped = { row: number; message: string };

const HEADER_SYNONYMS: Record<string, string> = {
  ref: "guest_ref", guest_ref: "guest_ref", reference: "guest_ref", guest_reference: "guest_ref",
  title: "title", salutation: "title",
  first_name: "first_name", firstname: "first_name", "first name": "first_name", given_name: "first_name",
  last_name: "last_name", lastname: "last_name", "last name": "last_name", surname: "last_name", family_name: "last_name",
  email: "email", "email address": "email", e_mail: "email", "e-mail": "email", mail: "email",
  phone: "phone", mobile: "phone", telephone: "phone", tel: "phone", phone_number: "phone", contact: "phone",
  organisation: "organisation", organization: "organisation", org: "organisation",
  designation: "designation", role: "designation", position: "designation",
  category: "guest_category", guest_category: "guest_category", "guest category": "guest_category",
  rsvp_status: "rsvp_status", rsvp: "rsvp_status", "rsvp status": "rsvp_status",
  accompanying_guests: "accompanying_guests", accompanying: "accompanying_guests",
  "accompanying guests": "accompanying_guests", number_of_accompanying_guests: "accompanying_guests",
  guests_accompanying: "accompanying_guests", party_size: "accompanying_guests",
  accompanying_guest_allowed: "accompanying_guest_allowed",
  accompanying_names: "accompanying_names", "accompanying names": "accompanying_names",
  companion_names: "accompanying_names", companions: "accompanying_names",
  accompanying_guest_name: "accompanying_names", accompanying_guest_email: "accompanying_email",
  accompanying_guest_phone: "accompanying_phone",
  table_seat: "table_seat", table: "table_seat", seat: "table_seat", "table/seat": "table_seat",
  invited_by: "invited_by", "invited by": "invited_by",
  notes: "notes", remarks: "notes", comments: "notes",
};

// Aliases normalize common Government House spellings onto seeded codes.
const CATEGORY_ALIASES: Record<string, string> = {
  VIP_GUEST: "VIP", DIGNITARY: "VIP", HEAD_OF_STATE: "OFFICIAL", DELEGATE: "OFFICIAL",
  OFFICIALS: "OFFICIAL", OFFICIAL_GUEST: "OFFICIAL", PRESS: "MEDIA", PRESSE: "MEDIA",
  GENERAL: "GENERAL_GUEST", GUEST: "GENERAL_GUEST", CONTRACTOR: "STAFF", SUPPORT: "STAFF",
  VOLUNTEER: "STAFF",
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function normalizeHeader(raw: string): string | null {
  const key = raw.toLowerCase().trim().replace(/[_\s]+/g, " ").trim();
  const compact = key.replace(/\s+/g, "_");
  return HEADER_SYNONYMS[key] ?? HEADER_SYNONYMS[compact] ?? null;
}

function toText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

/** Converts an XLSX column reference (e.g. "AB") to its 1-based number. */
function columnNumber(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/**
 * Pre-materialization size guard for XLSX sheets (audit L-6, folded into
 * M-4): reads the sheet range BEFORE sheet_to_json so a pathological sheet
 * (huge row/column count) is rejected without building it in memory.
 */
function assertXlsxSheetSize(sheet: XLSX.WorkSheet): void {
  const ref = sheet["!ref"];
  if (!ref) return;
  const match = ref.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
  if (!match) return;
  const [, , , endColLetters, endRowRaw] = match;
  const dataRows = Number(endRowRaw) - 1; // row 1 is the header
  if (dataRows > MAX_IMPORT_ROWS) {
    throw unprocessable(
      `The spreadsheet exceeds the maximum of ${MAX_IMPORT_ROWS} data rows (at least ${dataRows}). Split the file or remove rows.`,
    );
  }
  if (columnNumber(endColLetters!) > MAX_IMPORT_COLUMNS) {
    throw unprocessable(
      `The spreadsheet exceeds the maximum of ${MAX_IMPORT_COLUMNS} columns.`,
    );
  }
}

export function parseGuestFile(buffer: Buffer, filename: string): Record<string, string>[] {
  const lower = filename.toLowerCase();
  let rawRows: Record<string, unknown>[];

  if (lower.endsWith(".xlsx") || lower.endsWith(".xls") || lower.endsWith(".xlsm")) {
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw badRequest("The Excel file has no sheets");
    const sheet = workbook.Sheets[sheetName]!;
    assertXlsxSheetSize(sheet);
    rawRows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  } else if (lower.endsWith(".csv") || lower.endsWith(".txt")) {
    const text = buffer.toString("utf8");
    rawRows = parseCsvSync(text, {
      columns: true,
      bom: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    });
  } else {
    throw badRequest("Unsupported file type. Upload a .csv, .xlsx or .xls file");
  }

  // Hard row cap (audit M-4): applies to every format, before validation,
  // staging into rowsJson, or any per-row commit work.
  if (rawRows.length > MAX_IMPORT_ROWS) {
    throw unprocessable(
      `The file exceeds the maximum of ${MAX_IMPORT_ROWS} data rows (found ${rawRows.length}). Split the file or remove rows.`,
    );
  }

  const mapped: Record<string, string>[] = [];
  for (const raw of rawRows) {
    const row: Record<string, string> = {};
    for (const [header, value] of Object.entries(raw)) {
      const normalized = normalizeHeader(header);
      if (normalized && !(normalized in row)) row[normalized] = toText(value);
    }
    if (Object.keys(row).length > 0) mapped.push(row);
  }
  if (mapped.length === 0) throw badRequest("No data rows found in the file");
  if (Object.keys(mapped[0]!).length > MAX_IMPORT_COLUMNS) {
    throw unprocessable(`The file exceeds the maximum of ${MAX_IMPORT_COLUMNS} columns.`);
  }
  if (!("first_name" in mapped[0]!) && !("last_name" in mapped[0]!)) {
    throw badRequest("Could not find first_name / last_name columns. Check the header row.");
  }
  return mapped;
}

export type ValidateResult = {
  rows: NormalizedRow[];
  errors: RowError[];
  skipped: RowSkipped[];
};

export async function validateRows(
  rawRows: Record<string, string>[],
  validCategories: { code: string }[],
): Promise<ValidateResult> {
  const rows: NormalizedRow[] = [];
  const errors: RowError[] = [];
  const skipped: RowSkipped[] = [];
  const categoryCodes = new Set(validCategories.map((c) => c.code));

  rawRows.forEach((raw, idx) => {
    const rowNumber = idx + 2; // +1 header, +1 for 1-based
    const firstName = (raw.first_name ?? "").trim();
    const lastName = (raw.last_name ?? "").trim();
    const hasAnyValue = Object.values(raw).some((v) => v && v.length > 0);
    if (!hasAnyValue) return; // drop fully blank rows
    if (!firstName && !lastName) {
      errors.push({ row: rowNumber, field: "first_name", message: "Missing first_name and last_name" });
      return;
    }
    if (!firstName) {
      errors.push({ row: rowNumber, field: "first_name", message: "Missing first_name" });
      return;
    }
    if (!lastName) {
      errors.push({ row: rowNumber, field: "last_name", message: "Missing last_name" });
      return;
    }

    // RSVP mapping onto the extensible RsvpStatus model.
    const rsvpRaw = (raw.rsvp_status ?? "ACCEPTED").trim().toUpperCase();
    const rsvpStatus = ["ACCEPTED", "CONFIRMED", "ATTENDING", "YES", ""].includes(rsvpRaw)
      ? "CONFIRMED"
      : ["DECLINED", "NOT ATTENDING", "NO", "REGRETS"].includes(rsvpRaw)
        ? "DECLINED"
        : ["PENDING", "TBC", "AWAITING", "INVITED"].includes(rsvpRaw)
          ? "PENDING"
          : rsvpRaw;
    if (rsvpStatus === "DECLINED") {
      skipped.push({ row: rowNumber, message: "RSVP declined — not imported" });
      return;
    }
    if (!["CONFIRMED", "PENDING", "INVITED", "CANCELLED"].includes(rsvpStatus)) {
      errors.push({ row: rowNumber, field: "rsvp_status", message: `Unknown RSVP status "${rsvpRaw}"` });
      return;
    }

    // Category: alias normalization, then DB-backed code validation.
    const categoryRaw = (raw.guest_category ?? "GENERAL_GUEST").trim();
    const categoryKey = categoryRaw.toUpperCase().replace(/[\s-]+/g, "_");
    const category = CATEGORY_ALIASES[categoryKey] ?? categoryKey;
    if (!categoryCodes.has(category)) {
      errors.push({
        row: rowNumber,
        field: "guest_category",
        message: `Unknown category "${categoryRaw}". Available: ${[...categoryCodes].join(", ")}`,
      });
      return;
    }

    const email = (raw.email ?? "").trim().toLowerCase() || null;
    if (email && !EMAIL_RE.test(email)) {
      errors.push({ row: rowNumber, field: "email", message: `Invalid email address "${email}"` });
      return;
    }

    const accompanyingEmailRaw = (raw.accompanying_email ?? "").trim().toLowerCase() || null;
    if (accompanyingEmailRaw && !EMAIL_RE.test(accompanyingEmailRaw)) {
      errors.push({ row: rowNumber, field: "accompanying_email", message: `Invalid accompanying guest email "${accompanyingEmailRaw}"` });
      return;
    }

    const accompanyingAllowed = (raw.accompanying_guest_allowed ?? "yes").trim().toLowerCase();
    if (["no", "false", "0"].includes(accompanyingAllowed)) {
      raw.accompanying_guests = "0";
      raw.accompanying_names = "";
    }

    let accompanyingGuests = 0;
    const accRaw = (raw.accompanying_guests ?? "0").trim();
    if (accRaw !== "") {
      const n = Number(accRaw);
      if (!Number.isInteger(n) || n < 0 || n > 10) {
        errors.push({ row: rowNumber, field: "accompanying_guests", message: `accompanying_guests must be a whole number 0–10 (got "${accRaw}")` });
        return;
      }
      accompanyingGuests = n;
    }

    const accompanyingNames: NormalizedRow["accompanyingNames"] = [];
    const namesRaw = (raw.accompanying_names ?? "").trim();
    if (namesRaw) {
      const parts = namesRaw.split(/[;|\n]+/).map((s) => s.trim()).filter(Boolean);
      for (const part of parts) {
        const commaMatch = part.match(/^(.+),\s*(.+)$/);
        let first: string;
        let last: string;
        if (commaMatch) {
          last = commaMatch[1]!.trim();
          first = commaMatch[2]!.trim();
        } else {
          const tokens = part.split(/\s+/);
          first = tokens[0] ?? "";
          last = tokens.slice(1).join(" ");
        }
        accompanyingNames.push({ firstName: first, lastName: last, email: accompanyingEmailRaw });
      }
      if (accompanyingNames.length > accompanyingGuests) accompanyingGuests = accompanyingNames.length;
    }

    rows.push({
      guestRef: (raw.guest_ref ?? "").trim() || null,
      title: (raw.title ?? "").trim() || null,
      firstName,
      lastName,
      email,
      phone: (raw.phone ?? "").trim() || null,
      organisation: (raw.organisation ?? "").trim() || null,
      designation: (raw.designation ?? "").trim() || null,
      category,
      rsvpStatus,
      accompanyingGuests,
      accompanyingNames,
      tableSeat: (raw.table_seat ?? "").trim() || null,
      invitedBy: (raw.invited_by ?? "").trim() || null,
      notes: (raw.notes ?? "").trim() || null,
    });
  });

  return { rows, errors, skipped };
}

function guestInputFromRow(row: NormalizedRow, eventId: string, importJobId: string): CreateGuestInput {
  return {
    eventId,
    guestRef: row.guestRef,
    title: row.title,
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    phone: row.phone,
    organisation: row.organisation,
    designation: row.designation,
    category: row.category,
    rsvpStatus: row.rsvpStatus,
    source: "IMPORT",
    tableSeat: row.tableSeat,
    invitedBy: row.invitedBy,
    notes: row.notes,
    importJobId,
  };
}

/**
 * Queue an import for background processing (M4): PREVIEW → QUEUED.
 * The worker (jobs/imports.ts) performs the per-row processing; the HTTP
 * request returns immediately. Idempotent: only a PREVIEW job can be queued.
 */
export async function queueImportCommit(
  importJobId: string,
  actor: AppUser,
): Promise<{ importJobId: string; status: string }> {
  const job = await prisma.importJob.findUnique({ where: { id: importJobId } });
  if (!job) throw notFound("Import job not found");
  if (job.status !== "PREVIEW") throw badRequest("This import has already been committed");

  await prisma.importJob.update({
    where: { id: importJobId },
    data: { status: "QUEUED", committedAt: new Date() },
  });
  await audit({
    actor,
    eventId: job.eventId,
    action: "IMPORT_QUEUED",
    entityType: "ImportJob",
    entityId: importJobId,
    summary: `Import of ${job.filename} queued for processing (${job.validRows} rows)`,
  });
  return { importJobId, status: "QUEUED" };
}

/**
 * Worker-side import processing (M4). Processes one QUEUED ImportJob with
 * per-row transactions, records every row failure, writes a structured
 * result summary, and clears the staged rows on completion. Actor context is
 * the admin who queued the job, preserved for audit continuity.
 */
export async function processImportJob(
  importJobId: string,
  systemActor: AppUser | null = null,
): Promise<{ processed: boolean; status: string }> {
  const job = await prisma.importJob.findUnique({ where: { id: importJobId } });
  if (!job || job.status !== "QUEUED") return { processed: false, status: job?.status ?? "UNKNOWN" };

  const actor =
    systemActor ??
    (job.createdByUserId
      ? await prisma.user.findUnique({ where: { id: job.createdByUserId } }).then((u) =>
          u ? { id: u.id, email: u.email, name: u.name, role: "ADMIN" as const, roles: ["ADMIN"] } : null,
        )
      : null);

  await prisma.importJob.update({
    where: { id: importJobId },
    data: { status: "PROCESSING" },
  });

  const rows: NormalizedRow[] = JSON.parse(job.rowsJson ?? "[]");
  let guestsCreated = 0;
  let companionsCreated = 0;
  let credentialsIssued = 0;
  let rowFailures = 0;

  // Per-row transaction keeps each primary party atomic without holding one
  // long transaction over the whole file.
  for (const row of rows) {
    try {
      const result = await prisma.$transaction(async (tx) => {
        const guest = await createGuestWithCredential(
          guestInputFromRow(row, job.eventId, job.id),
          actor,
          tx,
        );
        let creds = 0;
        if (row.rsvpStatus === "CONFIRMED") {
          await issueCredential(guest.id, actor, {}, tx);
          creds += 1;
        }

        for (const name of row.accompanyingNames) {
          const companion = await createGuestWithCredential(
            {
              eventId: job.eventId,
              parentId: guest.id,
              firstName: name.firstName,
              lastName: name.lastName,
              email: name.email,
              category: row.category,
              rsvpStatus: row.rsvpStatus,
              source: "IMPORT",
              tableSeat: row.tableSeat,
              importJobId: job.id,
              notes: `Accompanying ${row.firstName} ${row.lastName}`,
            },
            actor,
            tx,
          );
          companionsCreated += 1;
          if (row.rsvpStatus === "CONFIRMED") {
            await issueCredential(companion.id, actor, {}, tx);
            creds += 1;
          }
        }

        const unnamed = row.accompanyingGuests - row.accompanyingNames.length;
        for (let i = 0; i < unnamed; i++) {
          const primaryName = `${row.title ?? ""} ${row.firstName} ${row.lastName}`.trim();
          const companion = await createGuestWithCredential(
            {
              eventId: job.eventId,
              parentId: guest.id,
              firstName: "Accompanying guest",
              lastName: `of ${primaryName}`,
              displayName: `Accompanying guest ${i + 1} of ${primaryName}`,
              category: row.category,
              rsvpStatus: row.rsvpStatus,
              source: "IMPORT",
              tableSeat: row.tableSeat,
              importJobId: job.id,
              notes: `Plus-one slot for ${row.firstName} ${row.lastName}`,
            },
            actor,
            tx,
          );
          companionsCreated += 1;
          if (row.rsvpStatus === "CONFIRMED") {
            await issueCredential(companion.id, actor, {}, tx);
            creds += 1;
          }
        }
        return creds;
      });
      guestsCreated += 1;
      credentialsIssued += result;
    } catch (err) {
      // Never silently ignore a row failure (Engineering principle #26).
      rowFailures += 1;
      const message = err instanceof Error ? err.message : String(err);
      logger.error("import_row_failed", {
        importJobId,
        row: row.guestRef ?? row.lastName,
        error: message,
      });
      await prisma.importRowError.create({
        data: {
          importJobId,
          rowNumber: 0,
          field: "commit",
          message: `Processing failed for ${row.firstName} ${row.lastName}: ${message}`,
        },
      });
    }
  }

  const status = rowFailures > 0 && guestsCreated === 0 ? "FAILED" : "COMPLETED";
  await prisma.importJob.update({
    where: { id: importJobId },
    data: {
      status,
      completedAt: new Date(),
      rowsJson: status === "COMPLETED" ? null : undefined,
      resultJson: JSON.stringify({ guestsCreated, companionsCreated, credentialsIssued, rowFailures }),
    },
  });
  await audit({
    actor,
    eventId: job.eventId,
    action: status === "COMPLETED" ? "IMPORT_COMPLETED" : "IMPORT_FAILED",
    entityType: "ImportJob",
    entityId: importJobId,
    summary: `Import of ${job.filename} ${status.toLowerCase()}: ${guestsCreated} guests, ${companionsCreated} companions, ${credentialsIssued} credentials${rowFailures ? `, ${rowFailures} row failures` : ""}`,
  });
  scheduleStatsBroadcast(job.eventId);
  return { processed: true, status };
}
