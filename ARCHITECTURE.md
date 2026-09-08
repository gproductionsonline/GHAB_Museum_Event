# Architecture

## Scope

Phase 1 is an event-scoped guest admission platform. It manages invited/imported/manual guests, RSVP approval, credentials, email delivery, online and operationally constrained offline admission, attendance, reports, and audit history. Payment is deliberately outside the Phase 1 runtime.

The repository currently contains an initial SQLite implementation. That implementation is not the production baseline. The next backend milestone is the PostgreSQL migration and foundation hardening described in `DEVELOPMENT_PLAN.md`.

## Component architecture

```text
Browser / PWA
  | HTTPS REST + SSE/WebSocket-compatible notification path
  v
Reverse proxy / load balancer
  |----------------------|
  v                      v
Next.js instances       Express API instances
                         |       |       |
                         v       v       v
                    PostgreSQL  Redis   Job worker
                                      (email/import/report)
```

Next.js owns the administrative and check-in interfaces. Express owns authentication, authorization, validation, domain rules, and persistence. PostgreSQL is the source of truth. Redis is optional for distributed rate limits, short-lived coordination, and queues; it is not the source of truth for check-in attendance.

## Backend modules

- `auth`: sessions, password lifecycle, login audit, RBAC.
- `events`: event dates, venues, gates, status, event configuration.
- `categories`: administrator-managed guest categories.
- `guests`: primary guests, accompanying relationships, RSVP, cancellation, search.
- `credentials`: issuance, versions, revocation, replacement, QR representation.
- `checkins`: online validation, manual check-in, concurrency-safe admission.
- `devices`: registration, authorization, expiry, event assignment, revocation.
- `offline`: provisioning, local package metadata, sync, reconciliation, conflicts.
- `imports`: upload, validation, staged rows, asynchronous processing, summary.
- `email`: queue, delivery attempts, provider responses, retries.
- `reports`: report requests, generation, download authorization, export safety.
- `audit`: append-only audit events and restricted audit export.
- `payments` (Phase 2 boundary only): ticket types, orders, payment providers, payments.

Infrastructure adapters should isolate PostgreSQL/Prisma, Redis, mail provider, object storage, and logging from domain services.

## Request flow

1. Reverse proxy terminates TLS, applies basic request limits, and forwards a request ID.
2. Express parses a bounded request body and attaches the request context.
3. Authentication verifies the session and loads the user/device context.
4. Authorization checks the required permission and event scope.
5. Zod validates and normalizes input.
6. A service/use case performs the business operation, using a transaction when multiple records or a state transition are involved.
7. The response returns a stable API DTO, never a raw Prisma object.
8. An audit event and structured log are written for security-sensitive actions.

## Authentication and authorization

Use short-lived access sessions in secure HttpOnly cookies, with refresh/session rotation and server-side revocation. Passwords use Argon2id or an approved strong password hash. The backend checks permissions, event scope, account status, and device status on every sensitive endpoint.

Roles are collections of permissions, not hard-coded checks scattered across routes. Initial roles are `ADMIN`, `STAFF`, and `CHECKIN_OPERATOR`; permissions can be added without changing route semantics.

## Credential lifecycle

Each issuance creates a credential version for exactly one guest and event. The QR contains only a random opaque bearer token or token identifier. The server stores a keyed hash for lookup and, only if operational re-display is required, an encrypted raw token protected by a separate key.

```text
PENDING -> ACTIVE -> CHECKED_IN (derived from an admission record)
ACTIVE  -> REVOKED/CANCELLED
ACTIVE  -> REPLACED -> new credential ACTIVE
ACTIVE  -> EXPIRED
```

Old versions remain immutable evidence and cannot become active again. Replacement is one transaction: lock the guest's active credential, mark it replaced, create the new version, and record the audit event.

## Online check-in

The API hashes the submitted token, verifies event scope and credential state, and attempts one insert into `CheckIn` with a unique constraint on the credential admission identity. The database determines the winner. A concurrent unique violation is returned as `ALREADY_CHECKED_IN`, with the prior timestamp where disclosure is authorized.

## Offline flow

An authorized check-in device receives a short-lived, event-scoped admission package containing only the minimum validation data. It is stored in protected device storage, has a version, expiry, device identity, and integrity metadata. Local scans are queued with operation IDs. On reconnection, the API accepts the batch idempotently and reconciles each operation against PostgreSQL. Complete disconnected devices cannot guarantee global duplicate prevention; see `OFFLINE_MODE.md`.

## Email, imports, and reports

Email, large imports, and large reports run through durable jobs. HTTP requests create jobs and return job identifiers. Workers use bounded concurrency, retry policies, idempotency keys, and delivery/import status records. Small previews may remain synchronous; committed imports must be chunked and observable.

## Scalability and observability

API instances remain stateless. PostgreSQL uses pooling, indexed event-scoped queries, short transactions, and measured connection limits. Check-in avoids dashboard joins and nonessential work in its critical path. Dashboard updates use aggregated queries and controlled realtime notifications, not full-table polling.

Every request has a request ID, endpoint, status, latency, and safe actor/event/device context. Logs exclude passwords, sessions, raw QR tokens, and unnecessary PII. `/health` reports process liveness; `/ready` verifies database and required runtime dependencies.

## Deployment

Use a multi-stage, non-root Docker image for the API and Next.js. Deploy behind TLS and a load balancer. Run migrations as a controlled release step, not on every application startup. PostgreSQL has automated backups and tested restore procedures. Redis and workers are separate deployment units only when the chosen queue/rate-limit features require them.
