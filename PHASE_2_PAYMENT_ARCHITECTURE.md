# Phase 2 Payment Architecture

## Boundary

Phase 1 does not process money, expose payment endpoints, store bank credentials, or call a bank gateway. The payment boundary is documented now so it does not leak into guest admission logic.

## Future entities

- `TicketType`: event, name, category/rules, price in minor currency units, currency, capacity, active dates.
- `Registration`: public registrant identity and consent, linked to a guest after approval.
- `Order`: event, buyer, status, totals, currency, idempotency key, source.
- `OrderItem`: ticket type, quantity, unit price snapshot, guest/registration association.
- `PaymentProvider`: provider code, active state, non-secret configuration reference.
- `Payment`: order, provider, amount/currency, provider reference, status, timestamps, safe failure code, raw response reference if retention is approved.

## Adapter flow

```text
Public registration -> ticket selection -> Order/PENDING
  -> PaymentProvider adapter
  -> verified callback/status -> Order/PAID
  -> registration approval/fulfilment
  -> existing Guest -> CredentialVersion -> CheckIn path
```

The bank integration implements a provider interface for create-payment, verify-payment, handle-callback, refund/status where supported. The domain does not depend on one bank's API shape. Webhooks are authenticated, replay-protected, idempotent, and reconciled against the provider rather than trusting browser redirects.

Successful payment does not directly mutate check-in records. It creates or approves the registration/order fulfilment, which invokes the existing credential issuance use case. Imported and manually created guests use the same use case with a different source.

## Data and security

Never store card data or bank passwords. Store only provider references and the minimum payment audit data. Payment secrets live in a secret manager. Order totals are immutable snapshots. Refund/cancellation transitions are explicit and audited.

## Phase 2 migration plan

1. Add ticket/order/payment migrations without changing Phase 1 check-in constraints.
2. Add provider adapter and sandbox tests.
3. Add public registration and anti-abuse controls.
4. Add payment callbacks and reconciliation jobs.
5. Add fulfilment rules and end-to-end tests from paid order to QR admission.

No Phase 2 work should require changing the meaning of an existing credential or check-in.
