// M4 job runner: schedules the exported worker functions on intervals in the
// server process. Disabled in tests (JOBS_ENABLED=false) where workers are
// driven deterministically; the swap point for a dedicated worker process or
// Redis-backed queue is this module alone.
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { processEmailQueue } from "./email.js";
import { processImportJob } from "../modules/import/import.service.js";
import { processReportJob } from "./reports.js";

const timers: NodeJS.Timeout[] = [];

async function safe(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    logger.error("job_tick_failed", { job: name, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Picks up QUEUED import jobs (oldest first, one per tick). */
export async function processImportJobs(): Promise<number> {
  const job = await prisma.importJob.findFirst({
    where: { status: "QUEUED" },
    orderBy: { createdAt: "asc" },
  });
  if (!job) return 0;
  await processImportJob(job.id);
  return 1;
}

/** Picks up QUEUED report jobs (oldest first, one per tick). */
export async function processReportJobs(): Promise<number> {
  const job = await prisma.reportJob.findFirst({
    where: { status: "QUEUED" },
    orderBy: { createdAt: "asc" },
  });
  if (!job) return 0;
  await processReportJob(job.id);
  return 1;
}

export function startWorkers(): void {
  if (process.env.JOBS_ENABLED === "false") {
    logger.info("jobs_disabled", {});
    return;
  }
  timers.push(setInterval(() => void safe("email", () => processEmailQueue()), 3_000));
  timers.push(setInterval(() => void safe("imports", () => processImportJobs()), 2_000));
  timers.push(setInterval(() => void safe("reports", () => processReportJobs()), 2_000));
  logger.info("jobs_started", { emailMs: 3000, importMs: 2000, reportMs: 2000 });
}

export function stopWorkers(): void {
  for (const t of timers) clearInterval(t);
  timers.length = 0;
}
