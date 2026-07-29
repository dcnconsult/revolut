# Sandbox automation closeout

**Audience:** operators and release reviewers.

**Operator takeaway:** the service remains private and Sandbox-only. Begin with
[Start here](START_HERE.md), stop when Operations is not Clear or Backup is not
Fresh, and never treat this closeout note as authorization to execute.

## Current operating state

- The DigitalOcean Droplet runs the Revolut Business Sandbox provider.
- Production mode is refused.
- The API and monitoring dashboard bind only to `127.0.0.1:3000`.
- Merges to `master` deploy immutable commit-SHA releases through GitHub
  Actions.
- Deployment requires unit checks, a container health check, and a
  prepared-only remote smoke test.
- Failed candidate activation attempts to restore the previous release.
- SQLite stores transfer records, persistent idempotency state, and
  append-only audit events in a Docker volume.
- The daily read-only monitor runs at 06:17 UTC.
- The weekly prepared-only smoke test runs Sunday at 04:47 UTC.
- The local SQLite backup runs Sunday at 03:17 server time with SHA-256
  verification and retains the newest four generations.
- Scheduled failures create deduplicated `[Ops]` GitHub issues and successful
  recovery closes them.

## Safety boundary

Routine automation never submits a transfer. The dedicated account-transfer
workflow can move only a small Sandbox test amount and requires its separate
execution switch. A separately authorised broker case may run one controlled
Sandbox test for its full confirmed case amount, within the separate case
limit. It still cannot use live money. If that result is unclear, keep the
record and reconcile it; do not automatically submit another test.

Credentials, account identifiers, balances, and private keys are not printed
by monitoring or smoke-test summaries.

## Deferred until live-conversion planning

- Private object-storage provisioning and credentials
- Enabling encrypted off-droplet backup uploads
- Production API certificates and authorization
- Production beneficiary-payment implementation and approval policy
- Authenticated public ingress
- Production webhook verification and reconciliation
- Formal restore drill using the off-droplet encrypted backup

The backup CLI already supports `--storage object` and retention counts, but
object mode remains disabled until root-managed storage and `age` encryption
configuration are installed.

## Primary operator references

- [`SANDBOX_OPERATIONS_RUNBOOK.md`](SANDBOX_OPERATIONS_RUNBOOK.md)
- [`DIGITALOCEAN_DEPLOYMENT.md`](DIGITALOCEAN_DEPLOYMENT.md)
- [`SANDBOX_LIVE_MODE.md`](SANDBOX_LIVE_MODE.md)
- [`SANDBOX_ACCOUNT_TRANSFER_TEST_GUIDE.md`](SANDBOX_ACCOUNT_TRANSFER_TEST_GUIDE.md)
- [`BROKERED_FUNDING_CASES.md`](BROKERED_FUNDING_CASES.md)
- [`PRODUCTION_READINESS_GUIDE.md`](PRODUCTION_READINESS_GUIDE.md)
- [`ERROR_MONITORING_AND_OUTAGE_ROADMAP.md`](ERROR_MONITORING_AND_OUTAGE_ROADMAP.md)
