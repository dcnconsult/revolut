# Error monitoring and outage roadmap

**Audience:** operators should use only the immediate response below;
maintainers own the implementation roadmap.

## Immediate operator response

1. Stop the current authorization or execution.
2. Record the time, release, redacted case or transfer reference, and the
   plain-language message.
3. Do not retry a pending or ambiguous provider request.
4. Use **Reconcile** when the application offers it.
5. Escalate through the approved channel and wait for recorded recovery.

Never include credentials, account details, package contents, balances,
cookies, or authenticator codes. For the full routine, see
[Daily Sandbox operations](SANDBOX_OPERATIONS_RUNBOOK.md).

## Maintainer reference

This module consolidates redacted Revolut Sandbox and application failures in
the existing SQLite operations database. It is monitoring infrastructure, not
a live-money queue.

## Official error model

Revolut documents these Business API HTTP responses:

| Status | Classification | Current response |
| --- | --- | --- |
| `400`, `405`, `406`, `422` | Invalid request or response contract | Record warning; do not retry |
| `401` | Access token invalid or expired | Refresh once, then record a blocking authentication error |
| `403` | Scope, permission, account, or policy block | Record blocking authorization error; operator review |
| `404`, `409` | Missing resource or state conflict | Record warning; reconcile before another action |
| `429` | Rate limit | Honor bounded `Retry-After` delay and retry at most twice |
| `500`, `503` | Provider unavailable | Bounded retry; record a blocking provider error if exhausted |
| Network/timeout | Outcome may be unknown | Bounded retry only with a stable idempotency key |

References:

- [Business API errors](https://developer.revolut.com/docs/guides/manage-accounts/api-usage-and-testing/errors)
- [Authentication troubleshooting](https://developer.revolut.com/docs/guides/manage-accounts/get-started/make-your-first-api-request)
- [Business API usage and limits](https://developer.revolut.com/docs/guides/manage-accounts/api-usage-and-testing/usage-and-limits)
- [Bank-transfer idempotency](https://developer.revolut.com/docs/guides/manage-accounts/transfers/bank-transfers)
- [Revolut Business API FAQ](https://help.revolut.com/business/help/integrating-with-external-apps/revolut-business-api/question-using-revolut-business-api/)

## Implemented controls

- Provider calls have an eight-second timeout.
- A `401` clears the cached access token and refreshes once.
- Concurrent callers share one in-flight token refresh. This avoids one
  refresh invalidating a token another caller has just obtained.
- `429` and `5xx` responses use a bounded delay and at most two retries.
- `Retry-After` is honored but capped at two seconds for an interactive
  request. Longer outages are reported instead of tying up the service.
- Transfer retries reuse the same provider `request_id`, which Revolut
  documents as the idempotency control that prevents duplicate processing.
- No background process submits a prepared transfer.
- Errors are classified, redacted, fingerprinted, and stored in SQLite.
- Repeated identical errors increment one record rather than flooding logs.
- A later successful call resolves open errors for the same operation.
- The stored record contains no stack, token, certificate, account ID,
  transfer UUID, raw provider payload, or bank data.
- The daily remote monitor fails on unresolved critical errors, causing the
  existing deduplicated GitHub `[Ops]` issue workflow to alert operators.

SQLite table:

```text
operational_errors
```

Authenticated monitoring endpoints:

```text
GET /v1/sandbox/monitoring/error-report
GET /v1/sandbox/monitoring/errors?limit=25
```

Both the browser console and the Droplet text console display the consolidated
report to admin and read-only users.

## Report interpretation

- `clear`: no unresolved errors.
- `degraded`: unresolved warnings exist; preparation and monitoring may
  continue, but review the report.
- `blocked`: at least one unresolved critical error exists. Do not submit a
  transfer until the cause is understood and a subsequent successful check
  resolves it.

The report's `retryable` label means only that the technical condition may be
temporary. It is not permission for an operator or future queue to submit a
second payment with a new request ID.

## Operator troubleshooting

1. Record the time, operation, category, HTTP status, count, and safe message.
2. Never paste tokens, certificates, raw API responses, account IDs, balances,
   or payment data into GitHub issues or email.
3. For `401`, confirm token refresh health and certificate configuration.
4. For `403`, check consent scopes, Business roles, certificate status, and IP
   allowlisting. Do not retry repeatedly.
5. For `409`, retrieve and reconcile the existing resource before deciding
   whether any further action is valid.
6. For `429`, stop manual repetition and allow the bounded backoff to work.
7. For `5xx`, timeout, or network failure, treat submission outcome as
   ambiguous until the stable request ID or provider transaction is reconciled.
8. Confirm recovery through the same operation; successful recovery marks the
   consolidated error resolved.

## Phase A: email alert adapter

Email is deliberately not active yet. The implementation gate is:

- use a provider-neutral alert interface and a SQLite outbox;
- keep SMTP or email-API credentials in a root-managed secret, never GitHub;
- send only redacted category, severity, operation, count, first/last time,
  release SHA, and runbook link;
- send on first critical occurrence, threshold escalation, and recovery;
- deduplicate repeated alerts and enforce a cooldown;
- configure an allowlisted recipient group, not arbitrary addresses;
- test through a non-financial Sandbox recipient;
- retain the existing GitHub issue alert as a second channel;
- record delivery attempts and outcomes without storing message credentials.

## Phase B: safe transaction-intent queue

The queue must be a fail-closed holding area, not automatic delayed execution.
It is deferred until durable Production storage and dual approval exist.

Required states:

```text
awaiting_review -> approved -> dispatching -> submitted -> reconciled
        |             |             |
        +-> cancelled +-> expired   +-> ambiguous
```

Required safeguards:

- persist an immutable request digest and a stable provider `request_id`;
- never store access tokens, private keys, or certificates with queue items;
- use database uniqueness and transactional claiming;
- expire approval when amount, beneficiary, account, currency, or request
  fields change;
- require two-person approval and admin reauthentication;
- stop new dispatch when the circuit is blocked;
- never auto-release held items merely because connectivity returns;
- reconcile an ambiguous request ID with Revolut before any retry;
- retry only the identical request with the identical request ID;
- cap attempts, use exponential backoff with jitter, and move exhausted items
  to manual review;
- require an operator to resume the circuit and separately release each item;
- audit every state transition append-only;
- expose queue depth, oldest age, ambiguous count, and blocked reason;
- test crash recovery, concurrent workers, duplicate delivery, token refresh,
  rate limits, and provider outage simulations.

For Production, implement this queue in PostgreSQL or another transactional
database. The current SQLite database remains appropriate for the Sandbox
error monitor but is not approval to queue live payments.

## Phase C: webhook-assisted reconciliation

When authenticated public HTTPS ingress is ready, use Revolut Webhooks v2 to
shorten ambiguous-state recovery. Verify signatures and timestamps, enforce
event idempotency, and retain polling as a bounded fallback. A webhook never
authorizes a queued payment; it only reports provider state.

See [`PRODUCTION_READINESS_GUIDE.md`](PRODUCTION_READINESS_GUIDE.md).
