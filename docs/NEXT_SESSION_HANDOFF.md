# Next Session Handoff

**Audience:** maintainers continuing development. This is a dated engineering
record, not an operator procedure. Operators should use
[Start here](START_HERE.md).

**Current-document warning:** verify every release identifier, deployment
result, and “next work” statement against the repository and active Sandbox
before acting. Later documentation and code take priority over this snapshot.

Prepared July 24, 2026 for `dcnconsult/revolut`.

## Current baseline

- Branch: `master`
- Active release: `9af8954f646a5c478367f7ac1b15c6f5aa3f944d`
- PR #12 merged: consolidated operational error monitoring and outage safeguards
- Latest DigitalOcean deployment: successful
- Latest remote monitor: successful
- Droplet: Ubuntu 24.04.4; retrieve its current address from the approved
  infrastructure inventory
- API and operator console bind only to `127.0.0.1:3000`
- Public inbound access is restricted to SSH
- Revolut mode is Sandbox using the real Revolut Business Sandbox; no live data
- Production mode remains intentionally blocked by the application and activation script

Access the browser console through an SSH tunnel and open:

```text
http://127.0.0.1:3000/operator/
```

The Droplet-native text console is:

```bash
bash /opt/revolut/current/scripts/deploy/run-operator-console.sh
```

There is one administrator and one read-only user. Preserve the existing credentials; do not print, rotate, or recreate them without explicit authorization.

## Controls already in place

- SQLite storage for Sandbox transfers, persistent idempotency, operator/transfer audit, and operational errors
- Consolidated redacted error capture, categorization, fingerprint aggregation, occurrence counts, and recovery tracking
- Monitoring endpoints and browser/text-console error reports
- Eight-second provider timeout
- At most two bounded retries for rate limits, provider 5xx responses, and network faults
- Capped `Retry-After`, coalesced token refresh, and stable provider request IDs
- Daily health monitor at 06:17 UTC
- Weekly prepared-only remote smoke test Sunday at 04:47 UTC
- Weekly local backup Sunday at 03:17 server time with four retained copies
- Critical monitoring failures use the existing GitHub `[Ops]` issue channel
- Object storage is deliberately deferred

The baseline passed linting, type checks, 51 tests across 14 files, build, two Chromium end-to-end tests, dependency audit, Docker build, shell syntax checks, documentation link checks, and secret scanning.

## Recommended next work

Start with Phase A: a Sandbox-only email alert adapter.

Requirements:

- Provider-neutral adapter with email disabled by default
- SQLite outbox with delivery status and audit history
- Root-managed credentials; never store or print secrets in the repository
- Redacted alert payloads only
- Alert on first critical occurrence, escalation, and recovery
- Fingerprint-based deduplication and cooldown
- Explicit recipient allowlist
- Sandbox delivery test path
- Preserve GitHub issues as a second alert channel
- No change to `REVOLUT_MODE`, firewall rules, PAY scope, or transfer submission behavior

After that, remaining roadmap items are:

1. Production Gate 2 read-only probe, only when the real Production account, certificate, client ID, and READ consent are available. Use separate root-managed secrets and allow only `GET /accounts`; never treat Production as a Sandbox URL toggle.
2. Safe transaction-intent queue, deferred until a transactional production database and dual approval exist. It must never auto-release after an outage and must reconcile ambiguous provider results before retrying.
3. Encrypted off-Droplet object-storage backups and a formal restore drill before live operation.
4. Webhooks v2 only after authenticated HTTPS ingress exists; keep the operator UI and API loopback-only.
5. Broader production controls: PostgreSQL or equivalent durable idempotency, approvals, source ownership, reconciliation, and required payment-format validation.

See:

- [Error monitoring and outage roadmap](ERROR_MONITORING_AND_OUTAGE_ROADMAP.md)
- [Production readiness guide](PRODUCTION_READINESS_GUIDE.md)
- [Sandbox operations runbook](SANDBOX_OPERATIONS_RUNBOOK.md)
- [Sandbox operator console](SANDBOX_OPERATOR_CONSOLE.md)
- [Sandbox closeout status](SANDBOX_CLOSEOUT_STATUS.md)
- [DigitalOcean deployment](DIGITALOCEAN_DEPLOYMENT.md)

## Safety boundaries

- Do not switch `REVOLUT_MODE` to Production.
- Do not enable PAY or access live account data.
- Do not expose port 3000 or change the firewall.
- Do not read, echo, commit, or transmit credentials.
- Automated checks may prepare a `0.01` Sandbox transfer record but must never submit it.
- Do not activate an email sender or transaction queue before its gates and tests pass.
- Keep Sandbox and Production accounts, certificates, consent, and secrets completely separate.
- Use the PR and CI workflow for code changes; verify before merge and deployment.

## Safe verification

Local:

```bash
npm run check
npm run build
npm run test:e2e
npm audit --omit=dev
```

Droplet:

```bash
bash /opt/revolut/current/scripts/deploy/run-remote-monitor-check.sh
bash /opt/revolut/current/scripts/deploy/run-remote-smoke-test.sh
```

The remote smoke test creates only a prepared `0.01` Sandbox record and never submits it.

Relevant GitHub Actions workflows:

- `Check Revolut Sandbox from Droplet`
- `Run Safe Remote Sandbox Smoke Test`
- `Deploy API to DigitalOcean`

## Ready-to-paste kickoff prompt

> Continue `dcnconsult/revolut` from `docs/NEXT_SESSION_HANDOFF.md`. Start with Phase A: implement the Sandbox-only email alert adapter and SQLite outbox for consolidated operational errors. Keep email disabled by default; use redacted payloads, root-managed credentials, deduplication/cooldown, first-critical/escalation/recovery events, and delivery audit. Add tests and documentation. Do not change `REVOLUT_MODE`, firewall exposure, PAY scope, or transfer submission behavior. Review the repository and verify the active release before making changes.
