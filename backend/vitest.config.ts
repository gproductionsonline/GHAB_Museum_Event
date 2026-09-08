import { defineConfig } from "vitest/config";

// Integration tests run against the isolated `postgres-test` container
// (docker compose up -d postgres-test, host port 5434). The env block sets
// the test DATABASE_URL BEFORE any module imports run dotenv, so .env values
// never override it.
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    globalSetup: "./tests/global-setup.ts",
    // All files share ONE test database with persistent state between runs;
    // parallel forks cause unique-constraint races and load-flaky 5s timeouts.
    fileParallelism: false,
    env: {
      NODE_ENV: "test",
      DATABASE_URL:
        "postgresql://gh_events:gh_events_dev@localhost:5434/gh_events_test?schema=public",
      JWT_SECRET: "test-jwt-secret-at-least-16-chars",
      CREDENTIAL_SECRET: "test-credential-secret-16ch",
      SNAPSHOT_SECRET: "test-snapshot-secret",
      FRONTEND_ORIGIN: "http://localhost:3000",
      PORT: "4100",
    },
  },
});
