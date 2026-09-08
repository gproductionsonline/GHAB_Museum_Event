import { describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";

// Migration verification: the tracked migrations must have produced the
// tables and critical constraints the foundation depends on.
// NOTE: Prisma preserves model-name casing (quoted identifiers), so the
// physical table names are e.g. "CheckIn", not "check_ins".
describe("database migration verification", () => {
  const REQUIRED_TABLES = [
    "User",
    "Role",
    "Permission",
    "UserRole",
    "RolePermission",
    "Event",
    "Gate",
    "GuestCategory",
    "RsvpStatus",
    "Guest",
    "CredentialVersion",
    "CheckIn",
    "Device",
    "OfflineCheckIn",
    "ImportJob",
    "ImportRowError",
    "EmailDelivery",
    "ReportJob",
    "AuditLog",
    "TicketType",
    "Order",
    "OrderItem",
    "PaymentProvider",
    "Payment",
  ];

  it("contains every expected table", async () => {
    const rows = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `;
    const names = new Set(rows.map((r) => r.table_name));
    for (const table of REQUIRED_TABLES) {
      expect(names.has(table), `missing table: ${table}`).toBe(true);
    }
  });

  it("connects and answers SELECT 1 (PostgreSQL)", async () => {
    const result = await prisma.$queryRaw`SELECT 1 AS one`;
    expect(result).toEqual([{ one: 1 }]);
  });

  it("enforces the check-in single-admission unique indexes", async () => {
    const indexes = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'CheckIn' AND indexdef LIKE '%UNIQUE%'
    `;
    const names = indexes.map((i) => i.indexname);
    expect(names).toContain("CheckIn_guestId_key");
    expect(names).toContain("CheckIn_eventId_credentialVersionId_key");
    expect(names).toContain("CheckIn_operationId_key");
  });

  it("enforces unique credential token hashes and version history", async () => {
    const indexes = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'CredentialVersion' AND indexdef LIKE '%UNIQUE%'
    `;
    const names = indexes.map((i) => i.indexname);
    expect(names).toContain("CredentialVersion_codeHash_key");
    expect(names).toContain("CredentialVersion_guestId_versionNumber_key");
  });

  it("enforces idempotent offline reconciliation and email delivery", async () => {
    const offlineIndexes = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'OfflineCheckIn' AND indexdef LIKE '%UNIQUE%'
    `;
    expect(offlineIndexes.map((i) => i.indexname)).toContain("OfflineCheckIn_deviceId_operationId_key");

    const emailIndexes = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'EmailDelivery' AND indexdef LIKE '%UNIQUE%'
    `;
    expect(emailIndexes.map((i) => i.indexname)).toContain("EmailDelivery_idempotencyKey_key");
  });

  it("seeds the three RBAC roles", async () => {
    const roles = await prisma.role.findMany({ select: { code: true } });
    const codes = roles.map((r) => r.code).sort();
    expect(codes).toEqual(["ADMIN", "CHECKIN_OPERATOR", "STAFF"]);
  });
});
