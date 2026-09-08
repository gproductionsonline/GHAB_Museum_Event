# API Design

## Decision record — route contract (audit M-9)

**Decision:** the implemented *flat domain paths with explicit `eventId` parameters* are the single authoritative API contract. The originally sketched nested-REST paths (e.g. `POST /events/:eventId/checkins/validate`) were **not** adopted.

Rationale:

- The flat contract is already exercised end-to-end by the frontend, the integration test suite (41 tests), and the operational smoke script; migrating route shapes in a remediation change-set adds regression risk with no functional gain.
- Event scoping is enforced server-side in every handler regardless of URL shape (explicit `eventId` mismatch checks against resource ownership); scoping does not depend on URL nesting.
- Domain modules map 1:1 onto path prefixes, which keeps the modular-monolith boundaries legible.
- A future `v2` contract may introduce nested resources; it must be added as a new version, not by silently renaming `v1`.

Future agents MUST implement new endpoints in the style below and extend this file in the same change.

## Conventions

Base path: `/api/v1`. JSON errors use:

```json
{"error":{"code":"VALIDATION_ERROR","message":"Safe user-facing message","requestId":"…","details":[]}}
```

- Status codes: 400 `BAD_REQUEST`, 401 `UNAUTHORIZED`, 403 `FORBIDDEN`, 404 `NOT_FOUND`, 409 `CONFLICT`, 413 `PAYLOAD_TOO_LARGE`, 422 `VALIDATION_ERROR`, 429 `RATE_LIMITED`, 500 `INTERNAL_ERROR`, 503 `UNAVAILABLE`.
- Collections use bounded page pagination (max `pageSize` 200).
- Mutating check-in endpoints accept an optional `operationId` idempotency key; retries with the same key never create a second admission.
- Responses are allowlisted DTOs; internal database identifiers are not exposed beyond resource UUIDs.
- Every response carries `X-Request-Id`; clients may supply `X-Request-Id`.

### Rate limits (429 `RATE_LIMITED`)

In-memory fixed-window limiter, applied per IP before authentication (swap to Redis when the API scales past one instance — see ARCHITECTURE.md). Parameterized routes share one budget per IP per operation group, not per entity id:

| Endpoint group | Limit (per IP) |
| --- | --- |
| `POST /auth/login` | 10 / 15 min |
| `POST /checkin/scan`, `POST /checkin/manual` | 300 / min |
| `POST /checkin/undo` | 60 / min |
| `POST /sync/checkins` | 30 / min |
| `GET /sync/snapshot` | 30 / min |
| `GET /stats/stream` (SSE connections) | 10 / min |
| Guest mutations (`POST /guests`, `PATCH /guests/:id`, RSVP/cancel/restore, companions, credential issue/reissue/revoke/email) | 120 / min shared |
| `POST /credentials/bulk-email` | 10 / min |
| `GET /credentials/:guestId/qr.png` | 60 / min |
| `POST /import/preview` | 10 / min |
| `POST /import/:jobId/commit` | 10 / min |
| User mutations (`POST /users`, `POST /users/:id/reset-password`) | 30 / min shared |
| Device mutations (`POST /devices`, revoke, activate) | 30 / min shared |
| Event mutations (`POST /events`, `PATCH /events/:id`, category create/update) | 60 / min shared |
| `POST /reports/jobs` | 20 / min |
| CSV exports (`guests.csv`, `attendance.csv`, `door-list.csv`, `audit.csv`) | 30 / min shared |

Read-only collection endpoints (guest lists, audit viewer, email deliveries, device lists, import history) are permission-gated and paginated; they are not rate limited in Phase 1.

## Authentication

- `POST /auth/login` `{email, password}` → `{token, user}` — rate limited 10/15 min/IP; failures audited.
- `GET /auth/me` → `{user, permissions[]}` (any authenticated, active user).

Passwords, refresh tokens, and session cookies are NOT implemented in Phase 1 foundation (tracked in DEVELOPMENT_PLAN for the auth-hardening milestone).

## Events and categories

- `GET /events` — any authenticated user. Returns events with gates, active categories, and counts.
- `POST /events` — `event:manage`. Creates default event-scoped categories (bootstrap data; administrators manage categories afterwards).
- `GET /events/:id` — any authenticated user.
- `PATCH /events/:id` — `event:manage` (including gate replacement).
- `GET /events/:eventId/categories` — any authenticated user; returns the event's active, administrator-managed categories. `?includeInactive=1` (requires `category:manage`) also returns deactivated categories for the management UI.

## Guests

- `GET /guests?eventId&q&category&status&checkedIn&emailed&primary&page&pageSize` — `guest:read`.
- `POST /guests` `{eventId, …, category: <GuestCategory.code>}` — `guest:write`.
- `GET /guests/:id` — `guest:read`.
  **QR exposure boundary (audit H-1):** the response contains the raw QR credential (`guest.qr`) **only when the caller holds `credential:read`**. Check-in operators receive `qr: null`.
- `GET /guests/:id/audit` — `audit:read`.
- `PATCH /guests/:id` — `guest:write` (amendment; category/rsvp supplied as codes).
- `POST /guests/:id/cancel` / `POST /guests/:id/restore` — `guest:write` (RSVP transition; cancellation revokes active credentials atomically, including companions).
- `POST /guests/:id/companions` — `guest:write`.
- `POST /guests/:id/credential/issue` — `credential:issue`.
- `POST /guests/:id/credential/reissue` — `credential:issue` + `credential:revoke` (old version → REPLACED, permanently invalid).
- `POST /guests/:id/credential/revoke` — `credential:revoke`.
- `POST /guests/:id/credential/email` — `email:send` (records an `EmailDelivery` with an idempotency key).

## Credentials

- `POST /credentials/bulk-email` `{eventId}` — `credential:issue` + `email:send`.
- `GET /credentials/:guestId/qr.png` — `credential:read` (controlled QR re-render for printing).
- `GET /credentials/pending?eventId` — `guest:read`.

## Check-in

All check-in responses return one of `CHECKED_IN | ALREADY_USED | INVALID | CANCELLED | REPLACED | GUEST_CANCELLED`, plus `operationId` and (where authorized) guest display fields.

- `POST /checkin/scan` `{eventId, code, gate?, deviceName?, operationId?}` — `checkin:operate`; 300 req/min/IP.
- `POST /checkin/manual` `{eventId, guestId, gate?, deviceName?, operationId?}` — `checkin:operate`.
- `POST /checkin/undo` `{checkInId}` — `checkin:void`. Void semantics (audit M-2): the admission row is deleted (allowing re-admission) and a **complete forensic snapshot** is written to the immutable audit log in the **same transaction**.
- `GET /checkin/recent?eventId&limit` — `checkin:operate`.

**operationId replay semantics (audit M-3):** a replayed `operationId` is honored only when it matches the submitted event AND credential/guest identity; reuse against a different identity returns `INVALID`. A database collision on `operationId` is classified `INVALID`, never `ALREADY_USED` (audit L-1).

**Concurrency guarantee:** `CheckIn.operationId`, `CheckIn.(eventId, credentialVersionId)`, and `CheckIn.guestId` UNIQUE indexes guarantee exactly one admission per guest under any concurrency. Admission transactions serialize on a `SELECT … FOR UPDATE` lock of the Guest row — the same lock used by all credential state mutations — so status validation can never interleave with revoke/reissue (audit M-1).

## Offline synchronization (foundation)

- `GET /sync/snapshot?eventId[&version]` — `checkin:operate`. Event-scoped, hash-only admission package (no raw tokens, no contact data), HMAC-signed, versioned.
- `POST /sync/checkins` `{eventId, deviceId, deviceName, items[]}` — `checkin:operate`; 30 req/min/IP. Reconciliation is idempotent per `(deviceId, operationId)`; every received operation is retained as evidence, including rejected ones.

The full device pre-authorization workflow (register/provision/revoke behind `device:manage`) is scheduled with the offline milestone; auto-registration on first sync is a known foundation limitation (audit M-8, not part of this remediation).

Device management (implemented): `GET /devices` and `POST /devices` (register — the device token is returned exactly once), `POST /devices/:id/revoke` / `POST /devices/:id/activate`, `GET /devices/me` (device-token self-info), and `GET /devices/:id/sync-history` — all behind `device:manage` except `/devices/me`. Sync history returns the device's retained offline operations with reconciliation results (evidence rows are kept for rejected operations too); no code hashes are returned.

## Stats (dashboard)

- `GET /stats?eventId` — `guest:read`.
- `GET /stats/stream?eventId&token=<jwt>` — SSE. **Authorization is fresh from the database (audit M-5):** a deactivated user, or a user without `guest:read`, is rejected even with an unexpired JWT. The token travels as a query parameter because `EventSource` cannot set headers.

## Imports

- `POST /import/preview` (multipart `file` + `eventId`) — `import:manage`.
  **Hard limits (audit M-4):** 5 MB upload cap (→ 413), 10,000 data rows (→ 422 `VALIDATION_ERROR`), 200 columns; oversized XLSX sheets are rejected via a pre-materialization range check.
- `POST /import/:jobId/commit` — `import:manage`; per-row transactions; row failures recorded in `ImportRowError`, never silently ignored.
- `GET /import/batches?eventId` — `import:manage`.
- `GET /import/template.csv` — `import:manage`.

## Reports

- `GET /reports/guests.csv?eventId` — `report:export`.
- `GET /reports/attendance.csv?eventId` — `report:export`.
- `GET /reports/door-list.csv?eventId` — `report:export` (backup admission process).
- `GET /reports/audit.csv?eventId` — `audit:read` + `report:export`.

All CSV exports escape spreadsheet formula prefixes. Large-report background jobs are scheduled with the reporting milestone.

## Health

- `GET /health` — process liveness; no diagnostics.
- `GET /ready` — verifies PostgreSQL; 503 when unavailable.

## Authorization matrix

| Operation | ADMIN | STAFF | CHECKIN_OPERATOR |
|---|---:|---:|---:|
| View guests / stats (guest:read) | yes | yes | yes (admission-scoped use) |
| Raw QR credential surfaces (credential:read) | yes | yes | **no** |
| Create/amend/cancel guests (guest:write) | yes | yes | no |
| Issue/revoke/reissue credentials | yes | yes | no |
| Send credential email (email:send) | yes | yes | no |
| QR + manual check-in (checkin:operate) | yes | yes | yes |
| Void check-in (checkin:void) | yes | yes | no |
| Import guest lists (import:manage) | yes | no | no |
| Export reports (report:export) | yes | yes | no |
| Read audit log (audit:read) | yes | yes | no |
| Manage events/categories (event:manage, category:manage) | yes | no | no |
| Provision devices (device:manage, offline:provision) | yes | no | no |
| Manage users/roles (user:manage) | yes | no | no |
