# Security and Threat Model

## Security objectives

- Only authorized staff can manage guests or admit people.
- A credential is opaque, unpredictable, event-scoped, revocable, and single-use online.
- Offline admission is limited, expiring, auditable, and honest about its consistency boundary.
- Guest data is minimized and disclosed according to role.
- Administrative history cannot be silently erased.

## Threats and controls

| Threat | Required control |
|---|---|
| Password theft/brute force | Argon2id or approved strong hash, login throttling, breached-password policy, session expiry, reset tokens that are single-use and short-lived. |
| Token/session theft | Secure HttpOnly SameSite cookies, TLS, rotation, revocation, no browser-accessible secrets, no tokens in logs or URLs. |
| RBAC bypass / IDOR | Permission checks in every controller/service, event-scope checks, opaque public IDs, deny-by-default tests. |
| SQL injection | Prisma parameterized queries; no interpolated SQL without a reviewed parameterized query. |
| XSS | React escaping, safe HTML policy for email templates, output encoding, CSP where compatible, no unsafe guest content injection. |
| CSRF | SameSite cookies plus CSRF tokens/origin checks for state-changing browser requests. |
| QR guessing | At least 128 bits of cryptographic entropy, hash lookup, rate limiting, generic invalid responses, no sequential identifiers. |
| QR replay | Unique online check-in constraint, credential revocation/replacement, event/date validation, audit trail. |
| Credential enumeration | Generic invalid responses, throttling, no token fragments in responses or logs. |
| Malicious CSV/XLSX | Size/type/content validation, isolated parser, bounded rows/cells, no execution, formula-prefix escaping on exports, safe filenames. |
| PII exposure | DTO allowlists, role-specific fields, masked search where appropriate, restricted exports, retention policy. |
| Offline device compromise | Device authorization, short expiry, minimum event dataset, encrypted/protected storage, device revocation, wipe/reprovision procedure. |
| Audit tampering | Append-only application permissions, database restrictions, immutable/centralized log sink where available, audit export controls. |
| Race conditions | PostgreSQL transaction plus unique constraint/locking; mandatory concurrent test. |
| DoS | Request/body/file limits, rate limits, bounded queries, pagination, queue backpressure, proxy limits, database pool limits. |
| SSRF / unsafe callbacks | Allowlisted provider endpoints, no arbitrary URL fetching, strict webhook verification. |
| Secrets leakage | Secret manager/environment injection, startup validation, rotation, secret scanning, no secrets in `NEXT_PUBLIC_*`. |

## Credential & admission integrity (M0/M1 remediation decisions)

Recorded after the independent architecture audit; these are binding:

- **QR exposure boundary (H-1).** Raw QR bearer credentials are exposed only through `credential:read`-gated surfaces (`guest.qr` in guest detail when the caller holds `credential:read`, and `GET /credentials/:guestId/qr.png`). Check-in operators (`guest:read`) can never harvest a usable credential from any response. Offline snapshots contain token hashes only.
- **Serialization strategy (M-1).** Every credential state mutation (issue, reissue, revoke, RSVP cancellation cascade) and the check-in admission run inside one transaction that first takes `SELECT … FOR UPDATE` on the Guest row. No mutation can act on stale credential/RSVP state; the revoke-vs-reissue race can no longer orphan an ACTIVE credential behind a null pointer. The PostgreSQL UNIQUE indexes (`CheckIn.operationId`, `(eventId, credentialVersionId)`, `guestId`) remain the final exactly-one-admission arbiter — application locking supplements, never replaces, database guarantees.
- **Void semantics (M-2).** Voiding a check-in deletes the admission row (freeing the per-guest unique for re-admission) and writes a complete forensic snapshot — check-in id, event, guest, credential version, operationId, operator, device, method, gate, both timestamps — to the immutable audit log **in the same transaction**. A void can never leave an admission without evidence.
- **operationId replay semantics (M-3, L-1).** Replay is honored only when event and credential/guest identity match; a reused key against a different identity returns `INVALID`, never a false `CHECKED_IN`. Database collisions on `operationId` are classified `INVALID`, not `ALREADY_USED`.
- **Import hard limits (M-4).** Uploads are capped at 5 MB (413), 10,000 data rows and 200 columns (422 `VALIDATION_ERROR`); oversized XLSX sheets are rejected by a pre-materialization range check. Limits bound preview memory, staged rows, and commit duration.
- **SSE authorization (M-5).** The stats stream authorizes freshly from the database on every connection: deactivated users and users without `guest:read` are rejected even with an unexpired JWT.

## QR threat model

QR credentials are bearer credentials: anyone holding one may attempt admission. They contain no PII and no authentication/session authority. Token values are generated with a CSPRNG and stored as hashes. If re-display is required, encrypted token material is protected separately and never returned in list APIs.

Online validation is authoritative. An offline device can validate only against its last authorized package and cannot observe another disconnected device's admission. Reconciliation records both the original operation and the server result.

## Authorization model

Permissions are checked server-side after authentication and before service execution. Examples include `guest:write`, `credential:issue`, `credential:revoke`, `checkin:operate`, `offline:provision`, `report:export`, `category:manage`, and `audit:read`. Check-in operators cannot import, manage users, provision arbitrary devices, or export unrestricted PII.

## Security verification

Every security-sensitive change requires tests for unauthorized access, IDOR, invalid/expired/revoked credentials, role violations, malformed uploads, formula injection, retry/idempotency behavior, and concurrent scans. Production deployment also requires TLS, secret configuration, backup restoration, dependency scanning, and log/alert verification.
