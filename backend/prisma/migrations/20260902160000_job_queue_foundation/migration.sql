-- M4 job-queue foundation: import commits and report generation become
-- asynchronous background jobs. ImportJob gains a QUEUED state and a
-- structured result payload; the staged-rows blob is cleared on completion.

ALTER TABLE "ImportJob" DROP CONSTRAINT "ImportJob_status_check";
ALTER TABLE "ImportJob" ADD CONSTRAINT "ImportJob_status_check"
  CHECK ("status" IN ('PREVIEW', 'QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED'));

ALTER TABLE "ImportJob" ADD COLUMN "resultJson" TEXT;
