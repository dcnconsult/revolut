# Connected Revolut Sandbox mode

**Audience:** designated administrators and maintainers. Daily operators should
use [Use the Sandbox operator console](SANDBOX_OPERATOR_CONSOLE.md).

The word “connected” means the application can reach Revolut's test service.
It does not mean Production, live customer data, or live money.

`REVOLUT_MODE=sandbox` connects the loopback-only application API to the real
Revolut Business Sandbox. It never selects the Production Business API.

## Boundaries

- The only permitted provider host is
  `https://sandbox-b2b.revolut.com/api/1.0`.
- `REVOLUT_MODE=production` stops application startup.
- Existing beneficiary-payment and ISO preparation routes are not registered
  in Sandbox mode.
- Only transfers between two accounts owned by the same Sandbox business are
  supported.
- Preparation does not move test funds. Submission is a separate request.
- The default maximum is 1,000 minor units (`10.00`).
- Records and idempotency state are stored in a local SQLite database using
  WAL mode and JSON-validated record columns.
- The application remains bound to `127.0.0.1:3000` on the Droplet.

## Endpoints

List owned Sandbox accounts:

```text
GET /v1/sandbox/accounts
```

Prepare an internal transfer:

```text
POST /v1/sandbox/internal-transfers/prepare
```

Example body:

```json
{
  "sourceAccountId": "SANDBOX_SOURCE_ACCOUNT_UUID",
  "targetAccountId": "SANDBOX_TARGET_ACCOUNT_UUID",
  "amountMinor": 1,
  "currency": "GBP",
  "reference": "Controlled Sandbox test",
  "clientReference": "sandbox-controlled-0001"
}
```

The response has `state: "prepared"`. It has not moved test funds.

Submit, retrieve, or reconcile:

```text
POST /v1/sandbox/internal-transfers/{id}/submit
GET  /v1/sandbox/internal-transfers/{id}
POST /v1/sandbox/internal-transfers/{id}/reconcile
```

## Droplet configuration

The application reads the existing root-owned Sandbox files:

```text
/etc/revolut/sandbox/config.json
/etc/revolut/sandbox/tokens.json
/etc/revolut/sandbox/privatecert.pem
```

Set this exact line in `/etc/revolut/revolut.env`:

```text
REVOLUT_MODE=sandbox
```

The deployment script detects this mode, adds `compose.sandbox.yaml`, mounts
the three files read-only, and verifies that `/health` reports:

```json
{
  "status": "ok",
  "mode": "sandbox",
  "provider": "revolut-sandbox-internal-transfer"
}
```

To return to the deterministic provider, restore `REVOLUT_MODE=mock` and
reactivate a release. Production must not be selected.

## Local monitoring and backups

The loopback-only monitoring page is available at:

```text
http://127.0.0.1:3000/v1/sandbox/monitoring
```

JSON endpoints provide the summary, recent transfers, and append-only audit
events under `/v1/sandbox/monitoring/`.

The SQLite database is stored in the Docker volume `revolut_revolut-data`.
The weekly cron job runs Sunday at 03:17 server time and creates a consistent
SQLite online backup plus a SHA-256 checksum under:

```text
/var/backups/revolut/
```

Install or refresh the cron entry with:

```bash
bash /opt/revolut/current/scripts/deploy/install-sqlite-backup-cron.sh
```

The scheduled command uses local storage and retains the newest four verified
backup/checksum pairs. Test the same behavior immediately with:

```bash
bash /opt/revolut/current/scripts/deploy/backup-sandbox-database.sh \
  --storage local --retention 4
```

Retention accepts counts from 1 through 52. Object storage is deferred and
remains disabled until its encrypted storage configuration is explicitly
installed. See
[`SANDBOX_OPERATIONS_RUNBOOK.md`](SANDBOX_OPERATIONS_RUNBOOK.md) for scheduled
monitoring, dashboard access, backup controls, and incident response.
