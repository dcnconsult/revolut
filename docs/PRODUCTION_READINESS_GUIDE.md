# Revolut Production readiness guide

This guide prepares the Sandbox deployment for a future Revolut Business
Production integration. It does **not** authorize a Production connection or a
live-money test.

The current Droplet must remain in `REVOLUT_MODE=sandbox`. Its activation
script intentionally refuses Production mode.

## The important distinction

Revolut Sandbox and Production are independent environments. They use
different Business accounts, credentials, consent, tokens, and API hosts.
Changing only the base URL is neither sufficient nor safe.

| Item | Sandbox | Production |
| --- | --- | --- |
| Business account | Sandbox test account | Verified Revolut Business account |
| API host | `https://sandbox-b2b.revolut.com/api/1.0` | `https://b2b.revolut.com/api/1.0` |
| Certificate and client ID | Sandbox-specific | Production-specific |
| OAuth consent and tokens | Sandbox-specific | Production-specific |
| Accounts and counterparties | Test data | Real financial data |
| Current repository support | Active, loopback-only | Intentionally blocked |

Official references:

- [Sign up for a Revolut Business account](https://developer.revolut.com/docs/guides/manage-accounts/get-started/sign-up-for-revolut-business-account)
- [Set up a test environment with Revolut Sandbox](https://developer.revolut.com/docs/guides/manage-accounts/get-started/prepare-sandbox-environment)
- [Make your first API request](https://developer.revolut.com/docs/guides/manage-accounts/get-started/make-your-first-api-request)
- [Business API reference](https://developer.revolut.com/docs/api/business)

## Target promotion path

Production should be introduced as a parallel integration, not by converting
the working Sandbox deployment in place.

### Gate 0: keep the Sandbox baseline

Before Production preparation:

- all CI and deployment checks pass;
- the daily monitor and weekly prepared-only smoke test are healthy;
- a verified backup and documented restore test exist;
- the Sandbox transfer ceiling and two-step submission remain enabled;
- the active Droplet remains loopback-only and SSH-only;
- the Production host cannot be selected by the current deployment.

Rollback at this gate is simply the existing immutable Sandbox release.

### Gate 1: Production account and credential preparation

An authorized Revolut Business administrator completes these tasks in the
Production Business web application:

1. Confirm the real Revolut Business account is verified and identify the
   people allowed to manage API integrations and approve payments.
   Revolut currently documents the required Platform permissions as
   **Manage Integrations**, **Manage API**, and **View Business**.
2. Generate a **new Production key pair**. Do not reuse the Sandbox private
   key.
3. Upload only the Production public certificate under **APIs → Business
   API**, set the OAuth redirect URI, and record the Production client ID.
4. Configure the public outbound IP allowlist after verifying the Droplet's
   actual egress IP. Do not enter the VPC/private IP.
5. Grant only `READ` consent for the first Production connection. Do not grant
   `WRITE`, `PAY`, or `READ_SENSITIVE_CARD_DATA`.
6. Complete authorization and exchange the short-lived authorization code on
   a secured operator workstation or host process.

Revolut documents a two-minute validity for the authorization code and a
40-minute lifetime for an access token. The refresh token, access token,
client-assertion JWT, and private key are secrets.

No Production secret belongs in Git, GitHub Actions output, a release
directory, a Docker image, shell history, screenshots, or operator logs.

### Gate 2: isolated Production read-only proof

Build and review a separate, outbound-only Production probe before enabling a
Production provider in the application. It must:

- accept only `https://b2b.revolut.com/api/1.0`;
- use the Production certificate and token set from a new root-managed secret
  directory, separate from `/etc/revolut/sandbox`;
- support only `GET` operations;
- start with `GET /accounts`;
- print only environment, HTTP result, account count, and token-expiry status;
- redact account IDs, names, balances, bank details, and tokens;
- expose no listening port;
- fail closed if any scope beyond `READ` is detected or configured;
- apply bounded retries with backoff and respect Revolut's documented
  60-requests-per-minute business limit;
- leave the running Sandbox application unchanged.

Passing this gate proves authentication and outbound connectivity only. It
does not authorize payment preparation or submission.

### Gate 3: Production application foundation

Before the main application may read Production data:

- implement a dedicated Production provider and centralized token manager;
- keep Production and Sandbox configuration, storage, monitoring, and
  credentials separate;
- replace SQLite/in-memory Production workflows with durable transactional
  storage and database-enforced idempotency;
- reconcile every configured source account to an account returned by the
  authenticated Production business;
- add immutable, redacted audit events and retention controls;
- add alerting for authentication failures, throttling, stale data, and
  reconciliation gaps;
- provision encrypted off-Droplet backups and complete a restore drill;
- document certificate, refresh-token, and webhook-secret rotation;
- require a manually approved deployment environment distinct from the
  current historically named Sandbox environment.

The first Production application release remains read-only.

### Gate 4: draft-only payment trial

Prefer Revolut payment drafts for the first payment-related Production test.
The Business API can create drafts that remain drafts until a user sends them
for processing in the Revolut Business application.

Requirements:

- grant `WRITE`, which Revolut documents for payment drafts, but not `PAY`;
- use a dedicated low-value source account and documented ceiling;
- require two authorized people: one prepares, one reviews in Revolut;
- bind approval to an immutable request digest;
- prohibit automatic conversion of a draft into a payment;
- reconcile the draft and resulting transaction from Revolut;
- retain a redacted audit trail and operator evidence;
- have a written abort and incident procedure.

See [Payment drafts](https://developer.revolut.com/docs/guides/manage-accounts/transfers/payment-drafts).

### Gate 5: controlled live-money pilot

`PAY` consent and direct Production submission remain prohibited until every
Production blocker in [`IMPLEMENTATION_CHECKLIST.md`](IMPLEMENTATION_CHECKLIST.md)
is closed and independently reviewed.

The first live pilot must additionally have:

- written business-owner approval naming the source account, beneficiary,
  currency, exact maximum amount, time window, and operators;
- verified counterparty ownership and applicable name-check evidence;
- dynamic corridor fields validated against the Production API;
- dual control and admin reauthentication;
- durable idempotency and a single-use client reference;
- a preflight balance check plus concurrency protection;
- authenticated status completion through webhooks or a bounded polling
  fallback;
- immediate reconciliation against the Revolut transaction;
- monitoring staffed for the entire pilot and a documented stop condition.

There is no automatic rollback for a completed bank payment. Application
rollback only stops further requests.

## Webhooks and the current firewall

Production read-only testing does not require an inbound firewall change.

Revolut Webhooks v2 require a public HTTPS endpoint. The current SSH-only
firewall therefore cannot receive them. Before enabling webhooks:

- provision authenticated HTTPS ingress separately from the operator console;
- expose only the webhook path on port 443;
- verify the `Revolut-Signature` HMAC SHA-256 signature;
- reject timestamps outside Revolut's documented five-minute tolerance;
- handle multiple signatures during secret rotation;
- enforce event idempotency and replay protection;
- monitor and recover failed webhook events;
- keep the operator UI and application API loopback-only.

Revolut lists different webhook source IP addresses for Production and
Sandbox. Confirm the current list immediately before changing any firewall
rule.

Official references:

- [About webhooks](https://developer.revolut.com/docs/guides/manage-accounts/webhooks/about-webhooks)
- [Manage webhooks](https://developer.revolut.com/docs/guides/manage-accounts/webhooks/manage-webhooks)

## Go/no-go record

Each gate needs a dated record containing:

- approving people and roles;
- exact commit and deployed release;
- scopes granted;
- certificate fingerprint, never the private key;
- verified outbound IP and allowlist;
- test cases and non-sensitive results;
- backup and restore evidence;
- monitoring and incident-response owner;
- rollback or stop procedure;
- unresolved risks and explicit decision.

Any missing evidence is a **no-go**. Sandbox operations continue while
Production preparation is paused.

## Next implementation slice

The safest next engineering change is Gate 2 only: add a separate,
Production-host-pinned, `READ`-only account-connectivity probe with unit tests
and a manual workflow. It must be impossible for that probe to call a mutating
endpoint, and it must not alter the active Sandbox container.

The consolidated failure model, email-alert gate, and fail-closed
transaction-intent queue requirements are documented in
[`ERROR_MONITORING_AND_OUTAGE_ROADMAP.md`](ERROR_MONITORING_AND_OUTAGE_ROADMAP.md).
