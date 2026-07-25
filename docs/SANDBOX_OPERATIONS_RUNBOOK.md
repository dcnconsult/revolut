# Revolut Sandbox operations runbook

This runbook is for staff who need to confirm that the Sandbox service is
working. It does not authorize live-data access or a transfer submission.

## Normal status

The expected application status is:

```text
status=ok mode=sandbox
```

The daily monitor should end with:

```text
REMOTE_MONITOR_OK mode=sandbox health=ok authentication=ok database=ok backup=fresh cron=active disk=ok bind=loopback
```

The weekly prepared-only test should end with:

```text
REMOTE_SMOKE_OK mode=sandbox transfer=prepared-only idempotency=ok persistence=ok monitoring=ok backup=ok bind=loopback
```

Neither scheduled workflow submits a transfer.

## Automated schedule

- **Daily at 06:17 UTC:** service health, Sandbox authentication, monitoring
  database, backup freshness and checksum, backup cron, credential file
  permissions, disk use, and loopback binding.
- **Sunday at 03:17 server time:** local SQLite backup, retaining the newest
  four verified backup pairs.
- **Sunday at 04:47 UTC:** prepared-only smoke test, including restart
  persistence and a fresh verified backup.

GitHub may start scheduled workflows later than the exact minute during busy
periods.

If a scheduled check fails, GitHub creates or updates a repository issue whose
title begins with `[Ops]`. A later successful scheduled run comments on and
closes that issue automatically. Manual test failures do not create alert
issues.

## Run a check manually

1. Open the repository on GitHub.
2. Select **Actions**.
3. Choose **Check Revolut Sandbox from Droplet** for the read-only daily
   monitor, or **Run Safe Remote Sandbox Smoke Test** for the prepared-only
   weekly test.
4. Select **Run workflow**.
5. Wait for a green check and open the result.
6. Confirm the final line begins with `REMOTE_MONITOR_OK` or
   `REMOTE_SMOKE_OK`.

Do not select an account-transfer workflow with execution enabled as part of
routine monitoring.

## Open the monitoring dashboard

From the authorized workstation, keep this command running:

```powershell
ssh -i C:\Users\novot\.ssh\revolut_deploy -L 3300:127.0.0.1:3000 deploy@178.128.36.90
```

Then open:

```text
http://127.0.0.1:3300/operator/
```

The application is intentionally unavailable on the Droplet's public port
3000. Sign in with the privately supplied admin or read-only account. See
[`SANDBOX_OPERATOR_CONSOLE.md`](SANDBOX_OPERATOR_CONSOLE.md).

If the browser or tunnel is unavailable, use the authenticated text fallback
from an interactive Droplet console:

```bash
bash /opt/revolut/current/scripts/deploy/run-operator-console.sh
```

## Transfer states

| State | Meaning | Routine action |
| --- | --- | --- |
| `prepared` | Validated locally; not submitted to Revolut | No action |
| `submitted` | Accepted for processing by the Sandbox API | Ask a technical operator to reconcile |
| `pending` | Sandbox processing has not finished | Wait, then reconcile |
| `completed` | Sandbox operation completed | No action |
| `failed`, `declined`, or `reverted` | Sandbox operation did not complete | Record the test reference and escalate |

Scheduled automation should create only `prepared` records.

## Respond to a failure

1. Do not retry a submitted transfer and do not enable execution.
2. Open the linked GitHub Actions run in the `[Ops]` issue.
3. Note the reported step, such as `backup-freshness` or
   `sandbox-authentication`.
4. Confirm whether the latest deployment workflow is green.
5. Send the issue link and failing step to the technical operator.

Credentials, tokens, account identifiers, and balances must never be copied
into an issue, chat message, or screenshot.

## Off-droplet backup status

Backups currently remain on the Droplet under `/var/backups/revolut`.
Encrypted off-droplet disaster recovery requires a private object-storage
bucket, endpoint, access key, secret key, and a separately retained encryption
secret. Do not place any of those values in Git.

The backup command has explicit storage and retention controls:

```bash
# Current scheduled behavior: keep four local weekly backups.
bash /opt/revolut/current/scripts/deploy/backup-sandbox-database.sh \
  --storage local --retention 4

# Future behavior after object storage is configured.
bash /opt/revolut/current/scripts/deploy/backup-sandbox-database.sh \
  --storage object --retention 8
```

Retention is a count from 1 to 52. A value of `1` keeps only the newest backup,
effectively overwriting the previous generation. Rotation deletes only files
matching the application's timestamped SQLite-backup naming pattern and their
checksum sidecars. Object mode always makes and retains a local staging backup
before attempting the encrypted upload.

The guarded upload command is:

```bash
bash /opt/revolut/current/scripts/deploy/upload-offsite-backup.sh --retention 8
```

It remains disabled until `/etc/revolut/offsite-backup.env` explicitly contains
`OFFSITE_BACKUP_ENABLED=YES`. When enabled, it verifies the local checksum,
encrypts the database for an `age` public recipient, and uploads only the
encrypted file and its checksum through a root-managed `rclone`
configuration. The decryption private key should be retained away from the
Droplet.
