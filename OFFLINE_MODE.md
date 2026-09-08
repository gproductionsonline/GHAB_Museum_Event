# Offline Admission Mode

## Guarantee boundary

Online mode is globally authoritative: PostgreSQL guarantees one successful check-in for a credential even when devices race.

Completely disconnected devices cannot guarantee global duplicate prevention because they cannot observe each other's writes. The system must communicate this to operators and supervisors; it must not present offline admission as equivalent to online admission.

## Provisioning

1. An administrator registers a device and assigns it to one event and, preferably, one gate/zone.
2. The device authenticates with a device-scoped credential, not an administrator session.
3. The API issues a short-lived package containing only active credential hashes, minimal display name/category data, event identity, package version, expiry, and integrity metadata.
4. The device stores the package in encrypted/protected storage and records its package metadata locally.
5. Provisioning, refresh, revoke, and expiry are audited.

Packages must not contain the full guest database, passwords, session tokens, unnecessary contact data, or raw QR secrets.

## Local operation

The PWA verifies a scanned token hash against the package, checks local expiry/event scope/status, and writes an operation to a durable local queue. Each operation has a random operation ID, device ID, event ID, credential hash, gate, client timestamp, validation result, and sync state. Use IndexedDB or an equivalent durable store; localStorage is not sufficient for the queue or protected package.

The UI clearly displays `ONLINE`, `OFFLINE`, package age/expiry, queued count, and conflict status. It provides manual search only over the local minimum dataset and requires operator confirmation for manual admission.

## Synchronization

When connectivity returns, the device uploads bounded batches. The API authenticates the device, verifies event scope, deduplicates `(device_id, operation_id)`, and reconciles each operation against the online credential/check-in rules. Synchronization is safe to retry. Each result is `APPLIED`, `ALREADY_CHECKED_IN`, `INVALID`, `CANCELLED`, `REPLACED`, `EXPIRED`, or `CONFLICT`.

The server stores the received offline operation even when it rejects it. A reconciliation report connects operation, device, original timestamp, server result, and any created check-in.

## Practical conflict strategy

The default operational policy is:

- Prefer one authoritative offline device per entrance.
- Assign other offline devices to separate zones where possible.
- Synchronize all devices immediately before doors open.
- Keep offline windows short and restore connectivity using a dedicated hotspot/LAN where possible.
- Do not allow a device with an expired package to admit guests.
- Supervisor reviews conflicts and duplicate admissions after synchronization.
- If the event requires strict single-use guarantees, operate online or use one communicating admission authority.

If two disconnected devices accept one credential, the first operation received by the server is retained as the primary admission according to a documented reconciliation rule; the other is marked conflict/duplicate. This cannot retroactively prevent both physical admissions.

## Revocation and compromise

Device revocation blocks future sync/provisioning. It cannot erase data already seen by a compromised device, so packages expire, contain minimum data, and should be remotely wiped or re-provisioned where device management permits. Lost devices are reported immediately and their package is treated as compromised.
