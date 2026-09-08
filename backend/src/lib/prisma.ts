import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import { config } from "../config.js";

// Prisma 7 uses driver adapters for all engines; PostgreSQL runs on
// @prisma/adapter-pg. Pool tuning lives here so horizontal scaling is a
// configuration change, not a code change (see ARCHITECTURE.md "Scalability").
export const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: config.DATABASE_URL, max: 20 }),
  log: config.isProd ? ["error"] : ["error", "warn"],
});

/** Lightweight connectivity probe used by /ready. */
export async function pingDatabase(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
