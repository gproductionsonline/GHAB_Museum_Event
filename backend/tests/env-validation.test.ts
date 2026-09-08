import { describe, expect, it } from "vitest";
import { envSchema } from "../src/config.js";

describe("environment validation", () => {
  const base = {
    PORT: "4000",
    NODE_ENV: "development",
    FRONTEND_ORIGIN: "http://localhost:3000",
    DATABASE_URL: "postgresql://user:pass@localhost:5432/db?schema=public",
    JWT_SECRET: "long-enough-development-secret",
    ADMIN_TOKEN_HOURS: "12",
    SCANNER_TOKEN_DAYS: "7",
    QR_CODE_PREFIX: "GHAB1",
    SNAPSHOT_SECRET: "snap-secret",
    CREDENTIAL_SECRET: "credential-secret-16",
  };

  it("accepts a valid environment", () => {
    const result = envSchema.safeParse(base);
    expect(result.success).toBe(true);
  });

  it("accepts a Resend-configured environment", () => {
    const result = envSchema.safeParse({
      ...base,
      RESEND_API_KEY: "re_test_key",
      EMAIL_FROM: "Government House Events <no-reply@example.gov>",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a Resend key without EMAIL_FROM (unverified sender would fail every delivery)", () => {
    const result = envSchema.safeParse({
      ...base,
      RESEND_API_KEY: "re_test_key",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("EMAIL_FROM"))).toBe(true);
    }
  });

  it("rejects a SQLite DATABASE_URL (PostgreSQL is mandatory)", () => {
    const result = envSchema.safeParse({ ...base, DATABASE_URL: "file:./dev.db" });
    expect(result.success).toBe(false);
  });

  it("rejects a missing DATABASE_URL", () => {
    const { DATABASE_URL: _omit, ...without } = base;
    const result = envSchema.safeParse(without);
    expect(result.success).toBe(false);
  });

  it("rejects a short JWT_SECRET", () => {
    const result = envSchema.safeParse({ ...base, JWT_SECRET: "short" });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown NODE_ENV", () => {
    const result = envSchema.safeParse({ ...base, NODE_ENV: "staging" });
    expect(result.success).toBe(false);
  });
});
