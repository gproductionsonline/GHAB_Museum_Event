-- Database-level state integrity (audit M-1 hardening): CHECK constraints
-- for known status fields. Application logic (zod + service transitions)
-- remains the first line of defense; these constraints guarantee no write
-- path can store an out-of-domain state.
-- Extensible administrator-managed values (GuestCategory.code,
-- RsvpStatus.code) are deliberately NOT constrained.

ALTER TABLE "CredentialVersion" ADD CONSTRAINT "CredentialVersion_status_check"
  CHECK ("status" IN ('PENDING', 'ACTIVE', 'REVOKED', 'REPLACED', 'EXPIRED'));
ALTER TABLE "CredentialVersion" ADD CONSTRAINT "CredentialVersion_versionNumber_check"
  CHECK ("versionNumber" > 0);

ALTER TABLE "CheckIn" ADD CONSTRAINT "CheckIn_method_check"
  CHECK ("method" IN ('QR', 'MANUAL', 'OFFLINE_SYNC'));

ALTER TABLE "Guest" ADD CONSTRAINT "Guest_source_check"
  CHECK ("source" IN ('IMPORT', 'MANUAL', 'ONLINE'));

ALTER TABLE "Event" ADD CONSTRAINT "Event_status_check"
  CHECK ("status" IN ('DRAFT', 'SCHEDULED', 'LIVE', 'COMPLETED', 'CANCELLED'));

ALTER TABLE "Device" ADD CONSTRAINT "Device_status_check"
  CHECK ("status" IN ('ACTIVE', 'REVOKED'));

ALTER TABLE "OfflineCheckIn" ADD CONSTRAINT "OfflineCheckIn_status_check"
  CHECK ("status" IN ('PENDING', 'APPLIED', 'ALREADY_CHECKED_IN', 'INVALID', 'CANCELLED', 'REPLACED', 'EXPIRED', 'CONFLICT', 'GUEST_CANCELLED'));

ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_status_check"
  CHECK ("status" IN ('QUEUED', 'SENDING', 'SENT', 'FAILED'));

ALTER TABLE "ImportJob" ADD CONSTRAINT "ImportJob_status_check"
  CHECK ("status" IN ('PREVIEW', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED'));

ALTER TABLE "ReportJob" ADD CONSTRAINT "ReportJob_status_check"
  CHECK ("status" IN ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED'));

-- Phase 2 boundary tables (unused in Phase 1; constraints fixed now so the
-- future payment flows inherit the same integrity guarantees).
ALTER TABLE "Order" ADD CONSTRAINT "Order_status_check"
  CHECK ("status" IN ('PENDING', 'PAID', 'FULFILLED', 'CANCELLED', 'REFUNDED'));
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_status_check"
  CHECK ("status" IN ('PENDING', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'REFUNDED'));
