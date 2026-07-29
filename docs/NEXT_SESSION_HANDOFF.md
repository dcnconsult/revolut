# Next Session Handoff

**Audience:** maintainers continuing development. This is a dated engineering
record, not an operator procedure. Operators should use
[Start here](START_HERE.md).

**Current-document warning:** verify every release identifier, deployment
result, and “next work” statement against the repository and active Sandbox
before acting. Later documentation and code take priority over this snapshot.

Prepared July 28, 2026 for `dcnconsult/revolut`.

## Pilot implementation update

The code-related first slice from
[the real-case Sandbox pilot plan](REAL_CASE_SANDBOX_PILOT_PLAN.md) is present
in the local working tree and has passed local verification. It is **not**
evidence of a deployment, permission to upload a client ZIP, or permission to
perform an external Sandbox test.

The local slice now provides:

- separate limits for the small direct connection test and the broker case;
- a configurable Sandbox-only case ceiling, initially up to USD 1 billion for
  USD cases;
- a safe file list and useful questions for a clean but unfamiliar ZIP;
- broker review, recorded corrections, request-information, and rejection
  controls;
- exact full-confirmed-amount Sandbox funding and plan checks; and
- one-time execution, redacted result capture, durable reconciliation, and no
  automatic resubmission after an unclear result.

Before any external pilot activity, obtain the named sensitive-data and
retention approval, choose approved representative case material, and obtain
the broker/owner authorization for the specific Sandbox test. No such client
ZIP intake or external high-value Sandbox action is part of this handoff.

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
- Revolut mode is Sandbox using the real Revolut Business Sandbox; no live
  money. Client case information remains subject to the named pilot approval.
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
- Bounded retries for safe read-only and token calls only; broker-case funding
  and payouts are never automatically submitted again
- Capped `Retry-After`, coalesced token refresh, and stable provider request IDs
- Daily health monitor at 06:17 UTC
- Weekly prepared-only remote smoke test Sunday at 04:47 UTC
- Weekly local backup Sunday at 03:17 server time with four retained copies
- Critical monitoring failures use the existing GitHub `[Ops]` issue channel
- Object storage is deliberately deferred

The current pilot slice passed local linting, type checks, tests, and build
verification. Re-run the safe checks below before merging or deploying because
the pilot work remains an uncommitted local addition.

## Recommended next work

The implementation does not grant pilot authority. Do not begin client-case
intake merely because the code is present.

1. Obtain written approval for the pilot's sensitive-data handling, retention,
   access, and approved private channel.
2. Select the initial representative client case ZIPs only after that approval.
   Keep originals out of Git, chat, email, and test fixtures unless they have
   been explicitly redacted and approved for that purpose.
3. Obtain the named broker/owner authorization before each external Sandbox
   test. Work from the full confirmed case amount; if Sandbox limits, rejects,
   or leaves it unclear, retain and reconcile that first result rather than
   lowering or repeating it.
4. Record the file layout, broker questions, Sandbox response, elapsed time,
   and support needed for each case. Use those observations to choose the first
   recurring-format adapter and exception report.

After the first governed cases, the next engineering work is recurring-format
adapters, exception/pilot reporting, and approved retention/deletion
automation. Email alerting, Production readiness, object-storage backups, and
webhooks remain separate deferred roadmaps; they are not prerequisites to the
private Sandbox pilot unless their own approvals say otherwise.

See:

- [Error monitoring and outage roadmap](ERROR_MONITORING_AND_OUTAGE_ROADMAP.md)
- [Production readiness guide](PRODUCTION_READINESS_GUIDE.md)
- [Sandbox operations runbook](SANDBOX_OPERATIONS_RUNBOOK.md)
- [Sandbox operator console](SANDBOX_OPERATOR_CONSOLE.md)
- [Sandbox closeout status](SANDBOX_CLOSEOUT_STATUS.md)
- [DigitalOcean deployment](DIGITALOCEAN_DEPLOYMENT.md)

## Safety boundaries

- Do not switch `REVOLUT_MODE` to Production.
- Do not enable PAY, access Production account data, or use live money.
- Do not upload a client case ZIP until the named pilot data-handling and
  retention approval is confirmed.
- Do not expose port 3000 or change the firewall.
- Do not read, echo, commit, or transmit credentials.
- Automated checks may prepare a `0.01` Sandbox transfer record but must never submit it.
- Never automatically repeat a broker-case funding or payout request. Keep an
  unclear result and reconcile it before any later case decision.
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

> Continue `dcnconsult/revolut` from `docs/NEXT_SESSION_HANDOFF.md` and `docs/REAL_CASE_SANDBOX_PILOT_PLAN.md`. The local broker-case implementation slice is complete, but no client ZIP, deployment, or external high-value Sandbox action has been authorized by this handoff. First verify the named data-handling/retention approval and the active release. Then prepare the initial approved representative ZIP intake and broker/owner authorization workflow. Keep the direct connection-test limit separate from the full broker-confirmed Sandbox case amount. Never lower or automatically repeat an unclear case funding or payout request; preserve and reconcile the existing result. Do not change Production mode, firewall exposure, PAY scope, or live-money behavior.
