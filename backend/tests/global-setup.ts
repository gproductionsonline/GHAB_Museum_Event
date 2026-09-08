// Vitest global setup: applies all tracked migrations to the test database
// and seeds the RBAC foundation. Runs once before the test workers start.
//
// NOTE: vitest's `test.env` block applies to test workers, NOT to this
// global-setup process — so the test URL is defined here explicitly and must
// stay in sync with vitest.config.ts.
import { execSync } from "node:child_process";
import { prisma } from "../src/lib/prisma.js";

const TEST_DATABASE_URL =
  "postgresql://gh_events:gh_events_dev@localhost:5434/gh_events_test?schema=public";

export default async function setup() {
  if (!/postgres(ql)?:\/\//.test(TEST_DATABASE_URL)) {
    throw new Error("Refusing to run tests against a non-PostgreSQL database");
  }

  execSync("npx prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  });
  execSync("npx tsx prisma/seed.ts", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  });

  await prisma.$connect();
  console.log("[test-setup] migrations applied and RBAC seeded");
}

export async function teardown() {
  await prisma.$disconnect();
}
