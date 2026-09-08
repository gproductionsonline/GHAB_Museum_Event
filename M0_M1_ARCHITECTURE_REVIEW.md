# M0/M1 Foundation — Independent Architecture, Security & Concurrency Review

**Reviewer role:** Independent senior reviewer (architecture, security, database, concurrency, production readiness)
**Scope:** Audit only. No application code was modified by this review.
**Date:** 2 September 2026
**Inputs reviewed:** All nine foundation documents; `backend/` (schema, 2 migrations, config, middleware, 9 modules, seed, 4 test files, vitest/docker config); `frontend/` (API client, auth, scanner PWA, admin pages, ESLint config, service worker).

---

## 1. Executive Summary

The M0/M1 foundation is **substantively as reported**. The PostgreSQL migration is real (provider `postgresql`, migration lock verified, SQLite artifacts removed), the 24-table schema matches `DATABASE_DESIGN.md` closely, RBAC is database-backed and enforced server-side, structured logging with correlation IDs is in place, `/health` and `/ready` behave as documented, and the error envelope matches `API_DESIGN.md`. The verification claims (typecheck/build/lint/tests 22/22, Prisma validation, Docker Compose) were independently re-executed during this session and are genuine.

**The check-in concurrency guarantee is correct.** Exactly-one-admission is enforced by three PostgreSQL unique indexes (`CheckIn.operationId`, `CheckIn(eventId, credentialVersionId)`, `CheckIn.guestId`), which serialize on index insertion regardless of how many API instances race. The 12-scan test result (1 `CHECKED_IN`, 11 `ALREADY_USED`) is deterministic, not luck.

However, the audit found **one HIGH finding** (a check-in operator can retrieve any guest's raw QR bearer code through `GET /api/v1/guests/:id`, defeating the hash-only snapshot design and least privilege) and a set of MEDIUM findings concentrated in three areas:

1. **State-transition races (TOCTOU)**: credential status checks are read outside the insert transaction, and `revoke` reads outside its own transaction — a concurrent revoke-vs-reissue race can leave an orphaned ACTIVE credential on a "revoked" guest. None of these enable double admission (the guestId unique blocks that), but they can admit a just-invalidated credential and can corrupt revocation state.
2. **Void-then-audit ordering**: `undoCheckIn` deletes the admission row and *then* writes the audit record, outside a transaction, and the audit snapshot omits operator/device/operationId. If the audit write fails, the admission leaves no forensic trace.
3. **API contract drift**: implemented route paths follow the pre-foundation prototype, not `API_DESIGN.md` (e.g. `/checkin/scan` vs documented `/events/:eventId/checkins/validate`). Coherent internally, but the documented contract is supposed to be the source of truth.

None of these invalidate the foundation. All are fixable in small, localized changes. The recommendation is **APPROVED WITH REQUIRED FIXES** — proceed to M2 only after the HIGH finding and the five required M2-blocking fixes in §19.

---

## 2. Overall Verdict

## **APPROVED WITH REQUIRED FIXES**

- No CRITICAL findings.
- One HIGH finding must be fixed before M2 continues building on the guest detail route.
- Five MEDIUM findings are M2-blocking because later milestones will compound them.
- Production readiness is explicitly NOT claimed by the plan for this milestone (deployment/backup work is scheduled for M5) and the audit confirms the foundation is not production-ready in the expected ways (auth token storage, distributed rate limiting, report streaming, Docker).

---

## 3. Critical Findings

**None.** Specifically investigated and ruled out:

- Double admission under concurrency — **not possible**; see §9.
- Authorization bypass on any audited endpoint — not found; every route is permission-gated and the frontend is not trusted.
- Raw QR secrets in offline snapshot — not present; snapshot contains hashes only (`sync.service.ts` snapshot builder).
- Secrets in logs — not found; request logs contain only method/path/status/duration/userId, and `DATABASE_URL` is never logged.

---

## 4. High Findings

### H-1. Check-in operators can read any guest's raw QR bearer code

- **Severity:** HIGH
- **Evidence:** `backend/src/modules/guests/guests.routes.ts:159` gates `GET /guests/:id` behind `requirePermission("guest:read")`; the response at line ~218 includes `qr` (raw code + data URL) whenever the credential is active, via `guestQrDataUrl()` (`credentials.service.ts:158-169`). The seed grants `guest:read` to `CHECKIN_OPERATOR` (`prisma/seed.ts:50`).
- **Why it matters:** The credential design deliberately keeps raw tokens away from gate devices (offline snapshot exposes `codeHash` only). This route defeats that boundary: any operator token can enumerate guests and harvest usable bearer secrets — a printable/screenshot-able QR that admits the guest. It converts a least-privilege operator into a credential holder.
- **Recommended fix:** Return `qr` only when the caller holds `credential:read` (check `req.auth.permissions`), or move the QR payload out of the guest detail response entirely into the existing `/credentials/:guestId/qr.png` route (already correctly gated behind `credential:read`). One-line-to-small change.
- **Blocks M2:** YES — M2 builds credential workflows on exactly this route.
- **Blocks production:** YES.

---

## 5. Medium Findings

### M-1. Credential state transitions are not serialized (TOCTOU family)

- **Severity:** MEDIUM
- **Evidence:** `checkin.service.ts:78-100` reads credential status/guest RSVP *before* the insert at lines 110-124, with no transaction or row lock. `credentials.service.ts:130-138` reads the guest/credential *outside* the `revokeCredential` transaction, then updates by the stale id inside it (lines 140-155).
- **Why it matters:** Two concrete races: (a) a revoke/reissue/guest-cancel landing between the read and the insert admits a just-invalidated credential (millisecond window, requires concurrent admin+scanner action); (b) **revoke vs reissue on the same guest**: revoke reads active credential v1; a concurrent reissue marks v1 `REPLACED`, creates v2 `ACTIVE`, and repoints the guest; revoke then sets v1 `REVOKED` and **nulls the pointer while v2 remains ACTIVE** — an orphaned live credential whose `codeHash` still validates in `attemptCheckIn` (which looks up by hash, not pointer). The guest appears revoked yet is still admissible. Note: none of these permit *double* admission — `CheckIn.guestId` unique blocks that — but revocation guarantees are violated.
- **Recommended fix:** Serialize all credential state mutations (issue/reissue/revoke) and the check-in insert on the guest row: `SELECT … FOR UPDATE` on `Guest` inside one transaction (Prisma `$transaction` + `$queryRaw` … `FOR UPDATE`, or an advisory lock keyed by guestId). Re-verify credential status inside the same transaction as the check-in insert.
- **Blocks M2:** YES (M2 is the credential-workflow milestone; retrofitting later touches every flow).
- **Blocks production:** YES.

### M-2. Void deletes the admission row before writing its audit record, outside a transaction, with an incomplete snapshot

- **Severity:** MEDIUM
- **Evidence:** `checkin.service.ts:188-205` — `prisma.checkIn.delete` (line 193) runs before `audit(...)` (line 194), not in a transaction. The `before` snapshot (line 202) records only `{checkInId, scannedAt, gate, method}`, omitting `operatorUserId`, `deviceId`, `operationId`, and `clientTimestamp`.
- **Why it matters:** Once the row is deleted, the audit log is the *only* evidence the admission ever happened (attendance reports show nothing). If the audit write throws after the delete (DB error, crash), the admission vanishes with no forensic trace — a direct violation of "never silently delete evidence" (AGENTS.md) and SECURITY.md's audit-integrity threat. The missing fields mean a voided offline-sync admission cannot be traced back to its device or operation.
- **Recommended fix:** Wrap delete+audit in one `$transaction` (audit first, or both in the same tx — either ordering is safe inside a transaction; audit-first additionally records intent even on delete failure). Include the full row snapshot in `before`.
- **Blocks M2:** YES (trivial now, forensic debt later).
- **Blocks production:** YES.

### M-3. operationId replay returns `CHECKED_IN` for the stored row's guest without verifying it matches the submitted credential

- **Severity:** MEDIUM
- **Evidence:** `checkin.service.ts:64-76` — replay path looks up by `operationId` only and returns `CHECKED_IN` with `existingByOp.guestId`'s identity; it never compares `existingByOp.credentialVersionId`/`guestId`/`eventId` to the request.
- **Why it matters:** A buggy or hostile client reusing an operationId with a *different* QR gets a green `CHECKED_IN` naming the wrong guest — the operator admits on false confirmation data. Admission integrity is preserved (no new row), but response integrity is broken, and the API accepts client-supplied `operationId` on the scan endpoint (`checkin.routes.ts` scanSchema).
- **Recommended fix:** On replay, verify the stored row matches the requested credential (or guest/event); on mismatch return `INVALID` (or `CONFLICT`). Keep replay semantics for exact matches.
- **Blocks M2:** YES (cheap now; the sync layer in M3 depends on replay semantics).
- **Blocks production:** YES.

### M-4. Guest import has no row-count cap

- **Severity:** MEDIUM
- **Evidence:** `import.service.ts` `parseGuestFile` maps every row of a 15 MB file (multer cap) with no ceiling; `validateRows` is unbounded; all valid rows are serialized into one `rowsJson` TEXT field (`import.routes.ts` preview), and `commitImportBatch` runs one transaction per row, sequentially, unbounded.
- **Why it matters:** A 15 MB CSV can exceed 100k rows: preview materializes it all into memory and one large DB field; commit blocks the HTTP request for a very long time — exactly the "large imports must not block the HTTP request" rule (AGENTS.md / ARCHITECTURE.md asynchronous import requirement). It is also a memory-exhaustion vector for the parse itself.
- **Recommended fix:** Enforce a hard row cap now (e.g. 5,000–10,000 rows → `422 VALIDATION_ERROR` with a clear message). The async job pipeline remains a later milestone, but the cap is a one-line safety floor that must exist before real Government House files arrive.
- **Blocks M2:** YES (M2 is the import milestone).
- **Blocks production:** YES.

### M-5. SSE stream authenticates from token payload only — no freshness check

- **Severity:** MEDIUM
- **Evidence:** `stats.routes.ts:20-30` — the stream calls `verifyToken()` but never `loadAuthContext()`, unlike every other authenticated route.
- **Why it matters:** A deactivated user (or a user whose roles were stripped) keeps live dashboard access until token expiry (up to 12 h for admin). Not data-destructive, but it is the one endpoint family that bypasses the otherwise-uniform "permissions loaded fresh from DB on every request" guarantee.
- **Recommended fix:** Call `loadAuthContext` and check a permission (`guest:read`) instead of the role heuristic; reject when inactive.
- **Blocks M2:** YES (small; keeps the auth model uniform before more SSE consumers appear).
- **Blocks production:** YES.

### M-6. Report exports are unbounded full-table reads

- **Severity:** MEDIUM
- **Evidence:** `reports.routes.ts:52,88,111` — `guest.findMany({where:{eventId}})` / `checkIn.findMany` with no `take`; door list builds the whole event in memory. `ReportJob` table exists but is unused.
- **Why it matters:** At Government House scale (hundreds–low thousands) this is fine; at the documented 10k-guest target it materializes wide rows × N plus CSV string in one request. `API_DESIGN.md`/`ARCHITECTURE.md` require background jobs for large exports.
- **Recommended fix:** Acceptable to defer the job pipeline to the reporting milestone, but add a defensive `take` + row-count warning now, or stream the response.
- **Blocks M2:** No.
- **Blocks production:** YES (at target scale).

### M-7. Manual search and report/credential endpoints have no rate limiting

- **Severity:** MEDIUM
- **Evidence:** `rateLimit` is applied only to `/auth/login` (10/15 min), `/checkin/scan` and `/checkin/manual` (300/min), and `/sync/checkins` (30/min). `GET /guests?q=…` (operator search), all `/reports/*` and `/credentials/*` routes are unthrottled.
- **Why it matters:** `SECURITY.md` explicitly lists rate limiting for manual search and sensitive admin APIs. Unthrottled search is a scraping/DoS surface once real PII exists.
- **Recommended fix:** Apply modest in-memory limits to search/report/credential endpoints now (same helper); move to Redis with the production deployment.
- **Blocks M2:** No (but trivial to add alongside M2 work).
- **Blocks production:** YES.

### M-8. Device "authorization" is auto-registration on first sync

- **Severity:** MEDIUM
- **Evidence:** `sync.service.ts:136-151` — an unknown `deviceName` is **created** with `status: "ACTIVE"` and the sync proceeds; the subsequent `status !== "ACTIVE"` check can never fail for a first-time device.
- **Why it matters:** `OFFLINE_MODE.md` requires *pre-authorized* devices (registered by an admin with `device:manage`, then provisioned). As implemented, any check-in operator can introduce a new "authorized" device simply by syncing one. The `Device` table and status gate are right; the admission policy is not.
- **Recommended fix:** Before the M3 offline milestone, remove auto-registration from the sync path (return 403 for unknown or non-ACTIVE devices) and add the documented device-management endpoints. No schema change needed — this is why it should be fixed before M3 builds on it.
- **Blocks M2:** No.
- **Blocks production:** YES (before offline mode is relied upon).

### M-9. API route paths drift from API_DESIGN.md

- **Severity:** MEDIUM
- **Evidence:** Documented vs implemented: `POST /events/:eventId/checkins/validate` vs `POST /checkin/scan`; `/events/:eventId/imports` vs `/import`; `/events/:eventId/guests/:guestId/credentials` vs `/guests/:id/credential/issue`; documented `/devices/register`/`provision`/`revoke` vs auto-registration inside `/sync/checkins`; documented `/auth/refresh`/`logout`/password-reset absent.
- **Why it matters:** The documents are the approved contract and the anti-drift mechanism (`AI_WORKFLOW.md`). The implementation is internally coherent (frontend matches it), but future agents following `API_DESIGN.md` will build conflicting routes.
- **Recommended fix:** Decide in M2: either (a) migrate routes to the documented contract while the surface is still small, or (b) amend `API_DESIGN.md` with a decision record adopting the implemented paths. Option (a) is cleaner; cost grows with every milestone.
- **Blocks M2:** YES (the decision must happen before M2 adds endpoints).
- **Blocks production:** No (contract coherence issue, not a runtime defect).

### M-10. Rate-limiter bucket map grows without bound

- **Severity:** MEDIUM
- **Evidence:** `rate-limit.ts:12,26-35` — `buckets` Map keyed by `ip:path`; stale entries are filtered on access but keys never seen again are never removed; with `trust proxy = 1` (`app.ts`), a client hitting the API directly can rotate `X-Forwarded-For` values to mint unlimited keys.
- **Why it matters:** Memory-exhaustion vector (unauthenticated, pre-auth endpoints) and trivial limiter evasion when not behind the intended single proxy.
- **Recommended fix:** Cap the map size (e.g. 10k keys, evict-oldest) or periodically sweep expired buckets; in production set `trust proxy` to the actual LB topology and move counters to Redis.
- **Blocks M2:** No.
- **Blocks production:** YES (map cap) / deployment-config dependent (trust proxy).

---

## 6. Low Findings

### L-1. Unique-violation classification conflates operationId collisions with ALREADY_USED
- **Evidence:** `checkin.service.ts:127-142` — a violation on `operationId` (operationId reused across different credentials) finds neither `byCredential` nor `byGuest` and returns `ALREADY_USED` with no timestamp. Misleading operator feedback; admission integrity unaffected.
- **Fix:** Inspect the Prisma error meta/field to distinguish the violated constraint; return `INVALID`/`CONFLICT` for operationId collisions. **Blocks M2:** No. **Blocks production:** No (polish with M-3 fix).

### L-2. Check-in events are not written to AuditLog
- **Evidence:** `attemptCheckIn` creates the `CheckIn` row only. `SECURITY.md`'s audit list includes "QR check-in" and "manual check-in". The `CheckIn` row *is* a complete evidence record (operator, device, timestamps, method), so this is arguably a documented-by-data decision — but the docs disagree with the implementation.
- **Fix:** Either add audit rows for admissions or record the "CheckIn-is-audit-evidence" decision in `SECURITY.md`/`DATABASE_DESIGN.md`. Note the RBAC test suite and smoke tests confirm CheckIn rows carry operator identity. **Blocks M2:** No. **Blocks production:** No (resolve the doc/code disagreement).

### L-3. AuditLog integrity is application-level only
- **Evidence:** `audit.ts` offers create-only helpers (good), but nothing at the database layer prevents `UPDATE`/`DELETE` on `AuditLog` by the application's DB role, as `SECURITY.md` contemplates ("database restrictions").
- **Fix:** In the deployment milestone, grant the app role `INSERT`/`SELECT` only on `AuditLog` (or add a trigger rejecting mutations). **Blocks M2:** No. **Blocks production:** YES (hardening, with M5 deployment).

### L-4. Audit `requestId` is rarely populated
- **Evidence:** `audit()` accepts `requestId`, but only the auth routes pass `req.requestId`; all service-level audits (guest/credential/check-in actions) omit it, so audit rows cannot be correlated to access logs.
- **Fix:** Thread `req.requestId` into service calls (e.g. via `req.auth` or an explicit param). **Blocks M2:** No. **Blocks production:** No (observability polish).

### L-5. Default categories are hard-coded constants in two places
- **Evidence:** `events.routes.ts` `DEFAULT_CATEGORIES` and `seed.ts` duplicate the same five-category list, with a comment justifying them as bootstrap data. `AGENTS.md` says "never hard-code categories" — technically satisfied (runtime CRUD is table-driven; the constant only seeds new events), but duplicated.
- **Fix:** Single shared constant or seed-only bootstrap. **Blocks M2:** No. **Blocks production:** No.

### L-6. XLSX decompression has no expansion-ratio guard
- **Evidence:** `import.service.ts` parses a ≤15 MB buffer with SheetJS entirely in memory. XLSX is zipped XML; expansion ratios can be large. SheetJS 0.20.3 is fetched from the official CDN tarball (good — avoids the vulnerable npm 0.18.x line).
- **Fix:** Reduce the upload cap (2–5 MB is realistic for a guest list), enforce the row cap (M-4), and reject sheets with extreme cell counts. **Blocks M2:** No (fold into M-4). **Blocks production:** No.

### L-7. No ESLint configuration for the backend
- **Evidence:** `backend/package.json` has no `lint` script and no ESLint config; `AI_WORKFLOW.md` requires lint after meaningful changes. Frontend lint exists (0 errors / 10 documented warnings).
- **Fix:** Add ESLint (typescript-eslint) with a `lint` script in M2. **Blocks M2:** YES (process requirement for future milestones, trivial to add). **Blocks production:** No.

### L-8. Backend/frontend TypeScript major versions diverge
- **Evidence:** backend `typescript ^7.0.2` (native compiler), frontend `typescript ^5`. Both build fine; the divergence is informational and presumably deliberate (Next 16 toolchain).
- **Fix:** Note in DEVELOPMENT_PLAN; no action. **Blocks M2:** No. **Blocks production:** No.

---

## 7. Architecture Review

**Matches documentation:** modular monolith with `modules/{auth,events,guests,credentials,checkin,sync,stats,import,reports}` — matches ARCHITECTURE.md's module list (minus `categories/devices/offline/email` as standalone modules; categories live under events, device/offline under sync — acceptable consolidation at this scale). Controllers are thin; business rules live in `*.service.ts` files; infrastructure is isolated in `src/lib`. Request flow (proxy→middleware→auth→RBAC→zod→service→DTO→audit) matches the documented sequence.

**Positive:** no microservices, no speculative abstractions, no duplicated check-in logic (single `attemptCheckIn` used by scan/manual/sync), the payment boundary is tables-only as required.

**Findings:**
- API drift M-9 (above) is the main architecture-drift item.
- `DEFAULT_CATEGORIES` duplication (L-5) is the only repeated business constant found.
- SSE hub is in-memory per instance (`sse.ts`) — fine and consistent with the documented stateless-API/realtime-notification stance; documented, not a defect.
- `stats.service` imports nothing inappropriate; `checkin.service` importing `stats.service` for broadcasts creates a mild checkin→stats coupling; acceptable, but the broadcast cost belongs on a queue eventually (see §15).

**Verdict:** structure is faithful to the documents; drift is limited to route naming (M-9), not architecture.

## 8. Database Review

**Provider/config:** `postgresql` provider; `prisma7.config.ts` supplies the datasource URL and a shadow DB; runtime uses `@prisma/adapter-pg` with `max: 20` pool. Migration lock says `postgresql`. Two tracked migrations, replayable (`migrate deploy` verified against a freshly created test DB).

**Verified correct:**
- One active credential per guest via UNIQUE nullable pointer `Guest.activeCredentialId` — a Prisma-expressible substitute for a partial unique index; sound.
- `CredentialVersion`: `codeHash` UNIQUE, `(guestId, versionNumber)` UNIQUE, append-only history (no update path except status transitions).
- `CheckIn`: three unique guards (see §9); FKs to guest/credential/event/device/operator with sane cascades (audit rows `SetNull` on event deletion so evidence survives; `OfflineCheckIn.checkInId` `SetNull`).
- Indexes match documented query patterns (event-scoped name/category/RSVP/email; credential `(eventId,status)`; check-in `(eventId, scannedAt DESC)`); no over-indexing observed; no missing index for any implemented query path identified (all list/filter queries hit an `eventId`-prefixed index).
- RSVP states and categories are tables, seeded, event-scoped categories with `(eventId, code)` unique — matches docs.
- Enum/state modeling is string-based by design (documented decision, validated by zod).

**Findings:**
- No CHECK constraints on status columns (e.g. `CredentialVersion.status ∈ {…}`): state integrity is application-only. A misbehaving future writer could store nonsense. LOW/MEDIUM — cheap to add as a migration before data grows. **Blocks M2:** recommended with M-1's fix (same migration window). **Blocks production:** recommended.
- N+1: none found in list paths (grouped queries in stats; companions fetched once per detail). `commitImportBatch` is N-transactions by design (per-row atomicity) — correct but slow; documented as M4 work.
- Connection pooling: `max: 20` per instance; PostgreSQL default `max_connections=100` means ≥5 instances require pooling review — noted in §15, not a defect.

## 9. Concurrency Review (highest priority)

**Claim verified: exactly one successful admission per credential under concurrent scans.**

Mechanism: every admission is a single `INSERT INTO "CheckIn"`. PostgreSQL unique B-tree indexes (`operationId`, `(eventId, credentialVersionId)`, `guestId`) make concurrent duplicate inserts impossible: a racing insert either blocks on the winner's in-flight index entry and then fails with SQLSTATE 23505, or fails immediately against the committed entry. Exactly one transaction can hold each key. This is enforced by the database engine, not application code, therefore it holds **across processes and across API instances** — the 12-scan test exercising one process does not overstate the guarantee. The loser path catches the unique violation, re-reads the winning row, and returns `ALREADY_USED` with the winner's timestamp. The test asserting 1/11 split and a single DB row is deterministic for this reason.

`operationId` idempotency is likewise DB-enforced (UNIQUE), so client retries and duplicate offline-sync uploads cannot create second admissions; the `OfflineCheckIn(deviceId, operationId)` unique adds a second replay-proof layer for sync.

**Race conditions found (none permit double admission):**
1. **Status-check TOCTOU** (M-1): credential status/guest-RSVP validation is not in the same transaction as the insert. A revoke/reissue/cancel that commits in the window admits a just-invalidated credential. Millisecond window; requires concurrent admin action.
2. **Revoke-vs-reissue corruption** (M-1): stale read outside revoke's transaction can leave an orphaned ACTIVE credential on a pointer-nulled guest; its codeHash still validates.
3. **Replay-path mismatch** (M-3): response-integrity only.
4. **Misclassified operationId collision** (L-1): feedback only.

**Recommendation:** move to `SELECT … FOR UPDATE` on the guest row for all credential mutations and re-validate status inside the check-in transaction. With that change the implementation is transactionally airtight under PostgreSQL's default READ COMMITTED.

## 10. QR Security Review

- **Entropy:** 20 chars × 32-symbol alphabet ≈ 100 bits, from `crypto.randomBytes` (CSPRNG) — not sequential, not predictable. Compliant.
- **QR payload:** `GHAB1.<code>` only — no PII, no auth claims. Compliant.
- **Storage:** sha256 hash for lookup + AES-256-GCM `codeEnc` for controlled re-display (scrypt-derived key from `CREDENTIAL_SECRET`). If the DB is compromised but the app environment is not, codes are not recoverable (hash preimage is infeasible at 100 bits). The `codeEnc` column deliberately weakens pure hash-only storage to enable admin re-render/re-email — a documented trade-off consistent with SECURITY.md's "only if operational re-display is required". Assessment: acceptable; rotating `CREDENTIAL_SECRET` invalidates decryptability, so include it in the production secret-rotation policy.
- **Lookup/enumeration:** lookup is by hash; unknown codes return generic `INVALID` with no oracle; login failures are generic. No credential enumeration path found.
- **Revocation/replacement/expiration:** implemented with version history; old versions immutable (enforced by transitions only, not DB constraints — see M-1/L CHECK note).
- **Event scoping:** `attemptCheckIn` rejects event mismatch; snapshot is event-scoped. ✓
- **Weaknesses:** H-1 (raw code via guest detail to operators) is the single real leak. The QR PNG route is correctly gated (`credential:read`). Email delivery writes `EmailDelivery` with idempotency keys — good. No raw-code logging anywhere (verified in logger call sites).

## 11. Authentication / RBAC / IDOR Review

- Login: bcrypt (cost 12), generic errors, throttled (10/15 min), audited with failure records. ✓
- JWT: HS256, 12 h admin / 7 d operator; **no refresh, rotation, or server-side logout** (documented gap; user `active=false` is the revocation path and it *is* checked fresh on every request via `loadAuthContext` — verified).
- RBAC: database-backed roles/permissions; middleware `requirePermission(...codes)` requires ALL codes; permissions loaded fresh per request (role changes take effect immediately — verified by design and by the `/me` test). Frontend guards are UX only; backend 401/403 verified by tests.
- IDOR/event scoping: resources are addressed by UUID; `attemptCheckIn` validates event match; manual check-in cannot cross-admit. **There is no user↔event membership model**, so any STAFF/ADMIN can access every event's data — acceptable for the current single-event deployment (and the seed creates one event), but it deviates from API_DESIGN's "scoped admission data" for STAFF and must be introduced before the system is used for multiple events. Not a code defect; a scoping-model gap. **Blocks production only if multi-event use precedes the fix.**
- Frontend bypass attempts: backend re-verified independently (401 without token, 403 missing permission) — authoritative server-side.
- SSE freshness gap: M-5.

## 12. Rate-Limit Review

- Protected: login (10/15 min), scan+manual (300/min), sync (30/min). Values are sensible for gate operations (300/min ≫ realistic door throughput).
- Gaps: no limits on search/reports/credentials (M-7); per-instance in-memory (documented limitation, acceptable for development; production requires Redis-backed counters shared across instances — swap point is isolated in `rate-limit.ts`).
- `trust proxy = 1` is correct behind exactly one proxy but allows header spoofing when accessed directly (M-10); production must match the actual LB topology.
- 429s return the standard error envelope. ✓

**Production requirement:** Redis fixed/sliding-window counters keyed by user (not only IP) for authenticated endpoints, IP-keyed for pre-auth; keep permissive gate limits to never throttle legitimate door operations.

## 13. File-Upload Review

- Multer: memory storage (nothing written to disk, no execution), 15 MB, 1 file, 10 fields. Extension allowlist enforced in `parseGuestFile`; content is parsed by SheetJS/csv-parse without executing anything. No path usage of the filename (stored as a DB string only) — no traversal surface. CSV export escapes formula prefixes (`'` guard on `=+-@\t\r` — verified in generated output). CSV import stores raw values (correct).
- Gaps: no row cap (M-4 — the significant one), no magic-byte validation (extension-only), generous 15 MB with no decompression ratio guard (L-6). No temp files used, so no cleanup attack surface. **Verdict:** foundation is safe for development; add the row cap before real imports.

## 14. Audit-Log Review

- Coverage: login (success/failure), guest created/amended/cancelled/RSVP, credentials issued/reissued/revoked/emailed, imports previewed/committed, offline sync, device registration, report exports, voids. Matches SECURITY.md's list except check-in events themselves (L-2 — defensible since `CheckIn` is an evidence table, but the disagreement should be recorded).
- Actor: user id + label recorded; system actions labeled. Event, device, and result fields exist and are used by services. Timestamps are DB-generated.
- Secrets: before/after snapshots verified to contain only `{version, status}`-style data — no codes, hashes, or passwords. Guest snapshots contain contact PII (email/phone) — appropriate for an administrative audit of guest amendments.
- Immutability: application offers no update/delete path; DB-level restriction pending (L-3).
- **Void decision assessment:** deleting the admission row is *acceptable* for the stated reason (freeing the per-guest unique for re-admission while `(eventId, credentialVersionId)` stays inviolable), **provided** the audit record is complete and reliably written. Today it is neither (M-2): the write is outside the transaction and the snapshot omits operator/device/operation/client timestamp. Fix M-2 and this design is forensically sound; leave it and voided admissions are reconstructible only partially.

## 15. Scalability Review

**What scales horizontally as built:** the API is stateless per request; all admission truth is in PostgreSQL; logging is per-instance JSON; SSE clients are per-instance (dashboards simply multiplex).

**Likely bottlenecks, in order:**
1. **`broadcastStats` inside the scan critical path** — every admission awaits a full event-stats recomputation (~8 queries incl. group-bys) plus SSE fan-out. At door-open bursts (hundreds of scans/min) this multiplies DB load per admission and adds latency to the gate response. Fix: fire-and-forget/debounced broadcast or a periodic dashboard poll. **Blocks production:** effectively yes (performance) — schedule with M2/M4.
2. **PostgreSQL connection ceiling** — 20 connections/instance vs default `max_connections=100`; beyond ~4 instances use PgBouncer or a managed pooler.
3. **Unbounded exports** (M-6) and **unbounded import commits** (M-4).
4. **In-memory rate limits/SSE** — Redis needed only when instance count > 1.

**No evidence-based claim beyond:** a single instance comfortably serves this event's profile (hundreds–low thousands of guests, gate bursts); the constraint design means check-in safety does not degrade with scale. Load testing remains outstanding (DEVELOPMENT_PLAN M5) — correctly not claimed by the implementation.

## 16. Phase 2 Compatibility Review

The boundary is honored: no payment code, no provider calls, no endpoints. Tables exist and are unused by Phase 1 logic: `TicketType`, `Order`, `OrderItem` (with `guestId` fulfilment link), `PaymentProvider` (non-secret `configJson` only), `Payment` (provider-ref pattern, no card data).

**Can Phase 2 flow (registration → ticket → order → bank payment → confirmation → credential issuance → check-in) be added without rebuilding?** Yes:
- `Guest.source` supports `ONLINE`.
- Credential issuance is already source-agnostic (`issueCredential` keyed on guest+RSVP); a paid order fulfilment can mark a registration CONFIRMED and reuse the same use case.
- `CheckIn` never references orders; payments cannot corrupt admission.
- The missing Phase 2 entity is `Registration` (documented as conceptual in PHASE_2_PAYMENT_ARCHITECTURE.md) — an additive migration, no rebuild.
- One watch-item: `OrderItem.guestId` links tickets to guests; keep fulfilment creating *guest rows via the same service*, not direct credential writes.

**Verdict: compatible. No schema decision found that forces a rebuild.**

## 17. Test-Quality Review

**Real behavior tested (verified by reading the tests, not trusting counts):**
- *Concurrency test:* 12 genuinely parallel supertest requests against one app; asserts 1 `CHECKED_IN` / 11 `ALREADY_USED` **and** exactly one DB row. Because the guarantee is constraint-based, this is not false confidence for multi-instance deployments — the same unique indexes arbitrate. It does **not** cover: revoke/reissue-during-scan races (M-1), concurrent same-operationId, or cross-process operation (two app instances) — all recommended additions.
- *RBAC tests:* no-token 401, malformed-token 401 (after a genuine bug this review's precursor run exposed — fixed), operator 403 on admin endpoints with permission named in the message, `/me` permission set, STAFF boundary via `/me`. Missing: a test asserting operators **cannot** read the QR payload (would have caught H-1), deactivated-user behavior, SSE freshness.
- *Migration test:* asserts all 24 tables, the three critical CheckIn unique indexes, credential unique indexes, `OfflineCheckIn`/`EmailDelivery` idempotency keys, `SELECT 1`, and the three seeded roles. Genuinely verifies migrations were applied. Does not assert FKs/cascades (minor).
- *Readiness test:* happy path only; the 503 branch is untested (recommend a second app instance with a bad URL).
- *Idempotency test:* sequential replay → one row. Good; add a concurrent variant.
- *Determinism:* the shared persistent test DB accumulates state across runs (unique suffixes mitigate); recommend a per-run reset (`migrate reset` in global setup) for hermeticity.

**Overall:** unusually honest test suite for a foundation — the tests check invariants, not implementation details.

## 18. Production-Readiness Checklist

| Area | Status | Notes |
|---|---|---|
| Environment validation, fail-fast | READY | zod at startup; rejects SQLite URLs |
| Secrets handling (dev) | READY (dev) | `.env` gitignored both apps; rotation policy documented in `.env.example` |
| Secrets (prod) | REQUIRES HARDENING | dev-only values must be rotated; secret manager at deploy time |
| CORS allowlist | READY | explicit origins |
| Security headers | READY (API) | helmet; frontend CSP still to be set |
| Request size limits | READY | 2 MB JSON, 15 MB upload (reduce with M-4) |
| Centralized errors, no stack leakage | READY | verified envelope + prod gating |
| Structured logging + request IDs | READY | no secrets/PII in logs |
| `/health`, `/ready` | READY | correct semantics |
| Graceful shutdown, DB disconnect | READY | SIGINT/SIGTERM + 8 s force |
| Auth token storage | REQUIRES HARDENING | localStorage bearer (see §12 of findings — dev-acceptable; HttpOnly cookie migration required pre-prod) |
| Distributed rate limiting | NOT READY (by design) | in-memory; Redis at multi-instance |
| Background jobs (email/import/report) | NOT READY (by design) | synchronous; M4/M6 |
| Report streaming | REQUIRES HARDENING | unbounded reads (M-6) |
| Audit DB-level immutability | REQUIRES HARDENING | L-3 |
| Docker production image | NOT READY (by design) | scheduled M5 |
| Backups/restore | NOT READY (by design) | scheduled M5 |
| Migration safety | READY | tracked, replayable, shadow DB |
| Dependencies | READY | modern majors; SheetJS from official CDN (avoids npm advisory); `npm audit` flags are inside Prisma's own CLI tooling (dev-time, not runtime app code) |
| npm scripts | REQUIRES HARDENING | backend lacks a `lint` script (L-7) |

## 19. Required Fixes Before M2

1. **H-1** — Gate the QR payload (raw code/dataURL) behind `credential:read` on `GET /guests/:id` (or move it to the existing PNG route). Blocks M2.
2. **M-1** — Serialize credential mutations + check-in insert with guest-row locking; move `revokeCredential`'s read inside its transaction; consider status CHECK constraints in the same migration. Blocks M2.
3. **M-2** — Void: delete+audit in one transaction; full row snapshot in `before`. Blocks M2.
4. **M-3** — Replay-path credential match verification (plus L-1 classification while there). Blocks M2 (M3 sync depends on replay).
5. **M-4** — Hard row cap on imports (and lower upload limit). Blocks M2 (import milestone).
6. **M-5** — SSE fresh-auth via `loadAuthContext` + permission check. Blocks M2.
7. **M-9** — Decide API path reconciliation (migrate or amend API_DESIGN.md) before adding endpoints. Blocks M2.
8. **L-7** — Add backend ESLint + `lint` script. Blocks M2 (process).

## 20. Recommended Fixes Before Production

- localStorage → HttpOnly `Secure SameSite=Strict` cookies; 15-min access token + rotating refresh; CSRF double-submit on browser state-changing routes; keep device/scanner auth separate (M3 device tokens). (Assessment: not CRITICAL for the dev milestone — 12 h/7 h bearer tokens with no refresh, revocable via `active=false`; XSS exposure is the real risk and is mitigated today only by React escaping and no `dangerouslySetInnerHTML` usage — verified.)
- Redis-backed distributed rate limiting + `trust proxy` matched to LB; map-size cap (M-10).
- Rate limits on search/reports/credentials (M-7).
- Report streaming or job pipeline (M-6).
- Device pre-authorization workflow (M-8) before offline reliance.
- AuditLog DB-level INSERT/SELECT-only grants (L-3).
- `broadcastStats` off the scan critical path (§15.1).
- Rotate `JWT_SECRET`/`CREDENTIAL_SECRET`/`SNAPSHOT_SECRET`; production-grade passwords with forced change (seed prints dev credentials — acceptable dev-only).
- Frontend CSP; SSE token-in-URL mitigation (short-lived tokens make exposure bounded; consider cookie auth for SSE after migration).
- Multi-event user scoping if more than one event will use the system.

## 21. Items That Can Safely Wait

- Async email/import/report job pipelines (M4/M6 by plan) — EmailDelivery/ImportJob/ReportJob schemas already track state.
- Offline queue/PWA work (M3/M8) — schema (Device, OfflineCheckIn, snapshot hashing) already supports it; fix M-8 first.
- User/role management endpoints and password reset (M2+ per plan).
- Cross-instance concurrency smoke test and load tests (M5/M11 by plan).
- L-4 (requestId propagation), L-5 (category constant dedup), L-8 (TS version note), L-6 (XLSX ratio guard — fold into M-4), dashboard UX polish.
- Frontend's 10 lint warnings (documented `set-state-in-effect` mount reads; migrate to `useSyncExternalStore` in a hardening pass).

## 22. Exact Next Steps

1. Implement §19 items 1–8 as a single, small, reviewable change-set (no new features) — all are localized to `guests.routes.ts`, `checkin.service.ts`, `credentials.service.ts`, `stats.routes.ts`, `import.service.ts`/`import.routes.ts`, one Prisma migration (optional CHECK constraints), and an ESLint config.
2. Re-run the full verification suite: `backend: typecheck, build, test`, `prisma validate/generate/migrate deploy`, `frontend: tsc, lint, build`, plus the smoke script; add regression tests for H-1 (operator cannot read QR), M-1 (revoke-vs-reissue serialization), M-2 (void leaves complete audit row), M-3 (replay mismatch → INVALID).
3. Record the resolved doc/code decisions (void semantics, CheckIn-as-audit, API path reconciliation choice) in the affected documents per AGENTS.md change-documentation rules.
4. Then, and only then, begin M2 (guest & credential workflows), which builds directly on the two files this audit flagged most: `guests.routes.ts` and `credentials.service.ts`.

---

### Summary Table

| Severity | Count | IDs |
|---|---|---|
| CRITICAL | 0 | — |
| HIGH | 1 | H-1 |
| MEDIUM | 10 | M-1 … M-10 |
| LOW | 8 | L-1 … L-8 |
| INFO | several | TS version divergence, SSE-in-memory hub, `guest:read`-scoped detail fields for operators (part of H-1 fix), multi-event scoping gap |

**Final verdict: APPROVED WITH REQUIRED FIXES — the foundation is sound, the concurrency guarantee is genuinely database-enforced, and no finding invalidates the M0/M1 design. Do not start M2 until §19 is complete.**
