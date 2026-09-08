// Prisma 7 configuration. The datasource URL comes from the environment
// (never hard-coded); a shadow database is required for migration diffs and
// `migrate dev`. Locally the docker-compose `postgres-test` service provides
// it — for CI or production pipelines override SHADOW_DATABASE_URL.
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
    shadowDatabaseUrl:
      process.env["SHADOW_DATABASE_URL"] ??
      "postgresql://gh_events:gh_events_dev@localhost:5434/gh_events_test",
  },
});
