# AI Workflow

## Purpose

This file prevents architecture drift while multiple AI models contribute to one production system.

## Model allocation

- **GPT-5.6 Luna**: architecture, threat modeling, concurrency reviews, difficult debugging, migration review, production readiness review.
- **GLM 5.3**: primary implementation, ordinary CRUD, UI, tests, and routine fixes within approved design.
- **DeepSeek V4 Pro**: low-risk documentation, boilerplate, formatting, and simple non-critical tasks.

Model allocation never overrides human review for authentication, authorization, QR credentials, offline sync, migrations, payment boundaries, or deployment.

## Required agent workflow

1. Read `AGENTS.md` and the relevant design document.
2. Inspect the current code, migrations, tests, package files, and git status.
3. State the exact scope and affected invariants before editing.
4. Reuse existing patterns unless there is a documented reason to change them.
5. Validate every external input and keep controllers thin.
6. Implement the smallest complete change; do not generate the whole application in one pass.
7. Add or update tests, especially for security, state transitions, idempotency, and concurrency.
8. Run typecheck, lint, tests, build, and migration validation.
   - Backend: `npm run typecheck && npm run lint && npm run build && npm test`
   - Frontend: `npx tsc --noEmit && npm run lint && npm run build`
   - Prisma: `npx prisma validate && npx prisma generate`
9. Review the diff for unrelated changes, secrets, PII, weakened controls, and generated artifacts.
10. Update documentation when an approved architectural decision changes.

## Prohibited behavior

- Do not replace PostgreSQL with SQLite or another database.
- Do not add payment processing to Phase 1.
- Do not silently change API contracts, credential semantics, offline consistency, or RBAC.
- Do not delete audit data, issued credential history, or production data to fix tests.
- Do not add dependencies without recording the production requirement they solve.
- Do not put secrets in source or browser-visible environment variables.
- Do not use frontend restrictions as authorization.
- Do not claim offline global duplicate prevention.

## Handoff format

Each implementation handoff must report:

- files changed
- database/migration changes
- API changes
- frontend changes
- tests added/run and results
- security and concurrency impact
- commands used
- known limitations and follow-up work

## Conflict resolution

If implementation and documentation disagree, stop feature work, identify the conflict, and request an architecture decision. GPT-5.6 Luna or the project owner must approve changes to foundational documents. The approved decision is recorded in the affected document and, where significant, in a dated decision record.
