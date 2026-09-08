// Audit M-4 + L-6 regressions: hard import row/column limits, upload size
// cap, and pre-materialization XLSX sheet guards.
import { describe, expect, it } from "vitest";
import request from "supertest";
import * as XLSX from "xlsx";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { MAX_IMPORT_ROWS, MAX_IMPORT_COLUMNS } from "../src/modules/import/import.service.js";

const app = createApp();

async function loginAdmin(): Promise<string> {
  const res = await request(app)
    .post("/api/v1/auth/login")
    .send({ email: "admin@ghab.gov", password: "ChangeMe123!" });
  return res.body.token as string;
}

async function getEventId(): Promise<string> {
  const events = await prisma.event.findMany({ take: 1 });
  return events[0]!.id;
}

const HEADER = "guest_ref,title,first_name,last_name,email,phone,guest_category,rsvp_status";

function buildCsv(dataRows: number): Buffer {
  const lines = [HEADER];
  for (let i = 0; i < dataRows; i++) {
    lines.push(`GH-${i},Mr.,First${i},Last${i},guest${i}@example.com,+12685550${i},MEDIA,ACCEPTED`);
  }
  return Buffer.from(`\uFEFF${lines.join("\n")}\n`, "utf8");
}

function buildXlsx(rows: string[][]): Buffer {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Guests");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("M-4: import row limit enforcement", () => {
  it("accepts a small file under the limit", async () => {
    const token = await loginAdmin();
    const eventId = await getEventId();
    const res = await request(app)
      .post("/api/v1/import/preview")
      .set("Authorization", `Bearer ${token}`)
      .field("eventId", eventId)
      .attach("file", buildCsv(25), "under-limit.csv")
      .expect(200);
    expect(res.body.totalRows).toBe(25);
    expect(res.body.validRows).toBe(25);
  });

  it("accepts a file at exactly the row limit (boundary is inclusive)", async () => {
    const token = await loginAdmin();
    const eventId = await getEventId();
    const res = await request(app)
      .post("/api/v1/import/preview")
      .set("Authorization", `Bearer ${token}`)
      .field("eventId", eventId)
      .attach("file", buildCsv(MAX_IMPORT_ROWS), "at-limit.csv")
      .expect(200);
    expect(res.body.totalRows).toBe(MAX_IMPORT_ROWS);
  }, 60_000);

  it("rejects a CSV exceeding the row limit with 422 VALIDATION_ERROR", async () => {
    const token = await loginAdmin();
    const eventId = await getEventId();
    const res = await request(app)
      .post("/api/v1/import/preview")
      .set("Authorization", `Bearer ${token}`)
      .field("eventId", eventId)
      .attach("file", buildCsv(MAX_IMPORT_ROWS + 1), "over-limit.csv")
      .expect(422);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.message).toContain(`${MAX_IMPORT_ROWS}`);
  }, 60_000);

  it("rejects an XLSX exceeding the row limit (pre-materialization sheet guard)", async () => {
    const token = await loginAdmin();
    const eventId = await getEventId();
    const rows: string[][] = [["first_name", "last_name", "email", "guest_category"]];
    for (let i = 0; i <= MAX_IMPORT_ROWS; i++) {
      rows.push([`First${i}`, `Last${i}`, `x${i}@example.com`, "MEDIA"]);
    }
    const res = await request(app)
      .post("/api/v1/import/preview")
      .set("Authorization", `Bearer ${token}`)
      .field("eventId", eventId)
      .attach("file", buildXlsx(rows), "over-limit.xlsx")
      .expect(422);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  }, 120_000);

  it("rejects an XLSX with excessive columns (expansion guard)", async () => {
    const token = await loginAdmin();
    const eventId = await getEventId();
    const header = Array.from({ length: MAX_IMPORT_COLUMNS + 1 }, (_, i) => `col_${i}`);
    const res = await request(app)
      .post("/api/v1/import/preview")
      .set("Authorization", `Bearer ${token}`)
      .field("eventId", eventId)
      .attach("file", buildXlsx([header]), "too-wide.xlsx")
      .expect(422);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects an upload above the 5 MB size cap with 413", async () => {
    const token = await loginAdmin();
    const eventId = await getEventId();
    const oversized = Buffer.alloc(6 * 1024 * 1024, 65); // 6 MB of 'A'
    await request(app)
      .post("/api/v1/import/preview")
      .set("Authorization", `Bearer ${token}`)
      .field("eventId", eventId)
      .attach("file", oversized, "oversized.csv")
      .expect(413);
  });
});
