# Engineering Rules

This repository contains the Government House CHOGM Event Guest and QR Check-In System.

## Non-negotiable decisions

- Frontend: Next.js App Router, React, TypeScript, responsive PWA where required.
- Backend: Node.js, Express, TypeScript, REST API.
- Database: PostgreSQL only for development, staging, and production targets.
- ORM: Prisma 7 with tracked migrations.
- Validation: Zod at every external boundary.
- Architecture: modular monolith; do not introduce microservices without an approved decision record.
- Phase 1 contains no payment processing or payment credentials.
- Phase 2 must reuse the guest, credential, event, and check-in domains.

## Before changing code

1. Read this file and the relevant design document.
2. Inspect the existing implementation, migrations, tests, and environment configuration.
3. Identify affected invariants, API contracts, migrations, and security controls.
4. Keep unrelated changes out of the change.
5. Prefer a small, reversible change over a broad rewrite.

## Backend rules

- Keep controllers/routes thin; put business rules in services/use cases.
- Enforce authorization on the server. Frontend guards are only UX.
- Use PostgreSQL transactions and database constraints for critical mutations.
- Check-in must be idempotent and concurrency-safe.
- Never use localStorage for authentication tokens in production; use secure, HttpOnly, SameSite cookies or an approved equivalent.
- Do not load the complete guest database into a browser. Offline packages are event-scoped, minimal, encrypted/protected, expiring, and device-authorized.
- Do not store raw QR secrets in logs, QR payloads, exports, or analytics.
- Do not delete audit evidence or issued credential history.
- Never hard-code passwords, secrets, categories, roles, or production configuration.
- Validate file type, size, content, rows, formulas, and business rules before import.
- Escape spreadsheet formula prefixes in CSV/XLSX exports.

## Frontend rules

- Do not place database credentials, signing keys, SMTP credentials, or service tokens in `NEXT_PUBLIC_*` variables.
- Keep admission workflows fast, keyboard/touch friendly, accessible, and usable on ordinary phones/tablets.
- Keep business logic out of React components where it can be a backend service or shared domain utility.

## Verification required

After meaningful changes, run the applicable typecheck, lint, unit/integration tests, migration validation, and build. For changes to credentials, authorization, imports, offline sync, or check-in, add or update tests. Review generated SQL and API exposure before considering the change complete.

## Change documentation

Update the relevant design document when changing a security boundary, data model, API contract, offline consistency rule, deployment dependency, or Phase 2 extension point. Do not silently change architecture.
