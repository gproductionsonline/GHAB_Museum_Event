# Development Plan

## Milestones

### M0: Foundation and decision approval

- Approve these documents and confirm event, hosting, data-retention, and operational assumptions.
- Replace the current transitional SQLite setup with PostgreSQL configuration and Docker development services.
- Add request IDs, structured logging, `/health`, `/ready`, environment validation, and migration policy.

### M1: Database and security foundation

- Implement normalized PostgreSQL schema, Prisma migrations, RBAC, event scope, categories, RSVP statuses, credential versions, devices, imports, email deliveries, reports, and audit records.
- Add session security, permission middleware, rate limits, and safe DTOs.
- Add migration and seed tests; review generated SQL and indexes.

### M2: Guest and credential workflows

- Guest CRUD, category management, RSVP transitions, explicit accompanying relationships.
- CSV/XLSX preview and asynchronous commit jobs.
- Credential issuance, replacement, revocation, QR rendering, and delivery jobs.

### M3: Admission workflows

- Online QR validation with atomic concurrency protection.
- Manual search/check-in with least-privilege fields.
- Authorized device provisioning, offline package, queue, sync, reconciliation, and conflict reporting.

### M4: Dashboard and reporting

- Aggregated attendance metrics, controlled realtime updates, delivery/import status.
- CSV/XLSX exports with formula-injection protection and asynchronous large-report generation.

### M5: Verification and operations

- Security, integration, E2E, concurrency, offline, failure-recovery, and load tests.
- Docker staging deployment, TLS, backups, restore rehearsal, monitoring, staff operating guide, and training rehearsal.

## Delivery target assessment

The requested operational target around September 12 is a high-risk compressed schedule for a production-grade system. A safe release requires the event date, PostgreSQL hosting, the Resend email provider (API key + verified sender domain), approved guest rules, device count, and test participants immediately. If those are unavailable, the safest reduced scope is online admission plus a single-authority offline procedure, not an untested multi-device offline promise.

No milestone is complete merely because code compiles. It is complete only after its tests, migration review, security review, operational runbook, and acceptance workflow pass.

## Required confirmations

- Event dates, timezone, gates, admission rules, and event categories.
- Whether every accompanying person receives an individual credential.
- Government House data retention, privacy, export, and staff-access rules.
- PostgreSQL hosting and backup owner.
- Email provider/from domain and DNS ownership for SPF/DKIM/DMARC.
- Number and ownership of scanner devices, device management capability, and offline operating policy.
- Primary owner for approving imports, cancellations, credential replacements, and deployment.
- Existing website integration boundary and production domain/subdomain.

## Verification commands for the foundation

From the repository root:

```bash
git status --short
cd backend
npm run typecheck
npm run lint
npm run build
cd ../frontend
npm run lint
npm run build
```

Once PostgreSQL configuration and migrations are implemented:

```bash
docker compose up -d postgres postgres-test
cd backend
npx prisma validate
npx prisma migrate deploy
npm test
```

The exact test and migration scripts must be added as part of M0/M1; agents must not pretend they exist before they do.

## M0/M1 remediation record (post-audit)

The independent architecture review (`M0_M1_ARCHITECTURE_REVIEW.md`, verdict: APPROVED WITH REQUIRED FIXES) required fixes before M2. All have been implemented and verified:

- H-1 raw QR exposure boundary (`credential:read`-gated)
- M-1 Guest-row `FOR UPDATE` serialization for all credential mutations + admission
- M-2 atomic void + complete forensic audit snapshot
- M-3/L-1 identity-verified operationId replay + violation classification
- M-4 import hard limits (5 MB / 10,000 rows / 200 columns) + 413 mapping
- M-5 SSE fresh-database authorization (`guest:read`)
- M-9 API contract decision: flat `/api/v1` paths retained; `API_DESIGN.md` is the single authoritative contract
- L-6 XLSX pre-materialization sheet guards
- L-7 backend ESLint (`npm run lint`)

Note on toolchain: the backend compiler is TypeScript 6.0.x (the JS-API line supported by typescript-eslint). TypeScript 7 (native) can be re-adopted once typescript-eslint supports it; the language semantics are identical.
