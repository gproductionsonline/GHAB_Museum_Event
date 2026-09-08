# Database Design

## Database target

PostgreSQL is mandatory. Prisma 7 migrations are the only normal schema change mechanism. The repository's current SQLite schema is transitional and must not be promoted.

## Normalized entities

```text
Event 1---* Guest *---1 GuestCategory
Guest 1---* Guest (primary -> accompanying relationship)
Guest 1---* CredentialVersion 1---* CheckIn
Event 1---* Gate
Event 1---* Guest, CredentialVersion, CheckIn, Device, ImportJob, ReportJob
User *---* Role *---* Permission
ImportJob 1---* ImportRowError
CredentialVersion 1---* EmailDelivery
Device 1---* OfflineCheckIn
Event 1---* TicketType 1---* Order 1---* Payment   [Phase 2 boundary]
PaymentProvider 1---* Payment                         [Phase 2 boundary]
AuditLog references actor, event, target type/id, and device where applicable
```

## Proposed tables and important fields

- `Event`: id, public identifier, name, venue, starts/ends, timezone, status, created/updated timestamps.
- `Gate`: event_id, name, code, active, sort order; unique `(event_id, code)`.
- `GuestCategory`: event scope or global scope, code, display name, description, active, sort order; unique within scope.
- `RsvpStatus`: code, display name, terminal flag, active, sort order. Use a table/configuration rather than hard-coded categories.
- `Guest`: event_id, category_id, rsvp_status_id, parent_guest_id nullable, names, normalized search name, contact fields, source, status, consent/retention metadata, timestamps.
- `CredentialVersion`: guest_id, event_id, public id, token_hash unique, encrypted token optional, status, issued/revoked/replaced/expiry timestamps, replacement pointer, version number. One active credential per guest/event is enforced.
- `CheckIn`: event_id, guest_id, credential_version_id, device_id, operator_id, method, gate, operation_id, server timestamp, client timestamp. Unique `(event_id, credential_version_id)` and unique `operation_id` where applicable.
- `Device`: event_id, device public id, name, type, authorization status, credential hash, expiry, last seen, revoked timestamp.
- `OfflineCheckIn`: device_id, event_id, operation_id, credential hash, client timestamp, received timestamp, reconciliation status, check-in id, conflict reason. Unique `(device_id, operation_id)`.
- `ImportJob`: event_id, uploader, original filename, content digest, status, counts, timestamps, idempotency key.
- `ImportRowError`: import_job_id, row number, field, safe raw summary, message.
- `EmailDelivery`: guest_id, credential_version_id, idempotency key, recipient, template, provider, status, attempts, next retry, provider reference, error summary, timestamps.
- `ReportJob`: event_id, requester, type, filters JSON, status, object reference, expiry, timestamps.
- `AuditLog`: event_id, actor, action, target type/id, device, request id, IP metadata where permitted, result, safe before/after summary, timestamp. Append-only.
- `User`, `Role`, `Permission`, `UserRole`, `RolePermission`: normalized RBAC.
- Phase 2: `TicketType`, `Order`, `OrderItem`, `PaymentProvider`, `Payment`; no Phase 1 payment behavior.

## Constraints and invariants

- Guest belongs to exactly one event and one active category.
- Accompanying guest is a guest row with one parent; parent cannot itself be an accompanying guest if that business rule is selected.
- Relationship cannot cycle; service validation plus database-safe transaction enforce it.
- Credential version belongs to the same event as its guest.
- At most one active credential version exists per guest/event. Use a PostgreSQL partial unique index on active status.
- A credential token hash is globally unique.
- A check-in cannot be inserted twice for a credential version.
- A cancelled/replaced/expired credential cannot check in.
- Check-in event, guest, credential, and device must agree.
- Audit rows are never updated or casually deleted.

### Concurrency model (binding, from the M0/M1 remediation)

All credential state mutations (issue, reissue, revoke, RSVP-cancel cascade) and check-in admission serialize on a `SELECT … FOR UPDATE` row lock of the Guest row inside a single transaction, then re-read state before mutating. The database UNIQUE indexes (`CheckIn.operationId`, `CheckIn.(eventId, credentialVersionId)`, `CheckIn.guestId`) remain the final exactly-one-admission arbiter. Application locking supplements — never replaces — these constraints.

### CHECK constraints (migration `add_state_check_constraints`)

Domain-bounded status fields are enforced at the database level, while administrator-extensible values (GuestCategory.code, RsvpStatus.code) deliberately remain unconstrained:

- `CredentialVersion.status ∈ {PENDING, ACTIVE, REVOKED, REPLACED, EXPIRED}`; `versionNumber > 0`
- `CheckIn.method ∈ {QR, MANUAL, OFFLINE_SYNC}`
- `Guest.source ∈ {IMPORT, MANUAL, ONLINE}`
- `Event.status ∈ {DRAFT, SCHEDULED, LIVE, COMPLETED, CANCELLED}`
- `Device.status ∈ {ACTIVE, REVOKED}`
- `OfflineCheckIn.status ∈ {PENDING, APPLIED, ALREADY_CHECKED_IN, INVALID, CANCELLED, REPLACED, EXPIRED, CONFLICT, GUEST_CANCELLED}`
- `EmailDelivery.status ∈ {QUEUED, SENDING, SENT, FAILED}`
- `ImportJob.status ∈ {PREVIEW, PROCESSING, COMPLETED, FAILED, CANCELLED}`
- `ReportJob.status ∈ {QUEUED, PROCESSING, COMPLETED, FAILED}`
- Phase 2 boundary: `Order.status ∈ {PENDING, PAID, FULFILLED, CANCELLED, REFUNDED}`; `Payment.status ∈ {PENDING, AUTHORIZED, CAPTURED, FAILED, REFUNDED}`

## Indexes

- Guest `(event_id, normalized_name)`, `(event_id, last_name, first_name)`, `(event_id, category_id)`, `(event_id, rsvp_status_id)`, and selective email/phone indexes according to query plans.
- CredentialVersion unique `token_hash`, `(event_id, status)`, `(guest_id, issued_at DESC)`.
- CheckIn unique `(event_id, credential_version_id)`, `(event_id, scanned_at DESC)`, `(event_id, device_id, scanned_at DESC)`.
- Device `(event_id, status)` and unique public device identifier.
- OfflineCheckIn unique `(device_id, operation_id)`, `(event_id, status)`.
- ImportJob `(event_id, created_at DESC)`; ImportRowError `(import_job_id, row_number)`.
- EmailDelivery `(status, next_attempt_at)` and `(credential_version_id)`.
- AuditLog `(event_id, created_at DESC)` and `(target_type, target_id, created_at DESC)`.

Index choices must be confirmed with `EXPLAIN (ANALYZE, BUFFERS)` against representative data.

## State transitions

Guest: `PENDING -> INVITED -> CONFIRMED | DECLINED | CANCELLED`.

Credential: `PENDING -> ACTIVE -> REPLACED | CANCELLED | EXPIRED`; check-in is a separate immutable admission record, not a destructive status overwrite.

Import: `RECEIVED -> VALIDATING -> PREVIEW_READY -> PROCESSING -> COMPLETED | FAILED | CANCELLED`.

Email: `QUEUED -> SENDING -> SENT | FAILED`; bounded retries with terminal failure.

## Concurrency

Online check-in runs in a short PostgreSQL transaction. It inserts an admission record under the unique credential constraint; exactly one concurrent request succeeds. The loser reads the existing admission and returns `ALREADY_CHECKED_IN`. This behavior is mandatory in integration tests.

## Phase 2 extensibility

Orders and payments reference tickets and guests but never alter check-in rules. A paid order transitions to an approved registration/credential issuance use case. Imported, manually created, publicly registered, and paid guests all use the same Guest -> CredentialVersion -> CheckIn path.
