# Check backups and perform a restore drill

## What the operator checks

**Audience:** all operators.

Before authorizing any execution:

1. Find the **Backup** card.
2. Continue only when it says **Fresh**.
3. If it says **Stale**, **Missing**, or **Unavailable**, stop execution.
4. Record the time and displayed state.
5. Ask the administrator to investigate.

Do not try to create, move, decrypt, or restore backup files yourself.

## Administrator-only restore drill

**Audience:** the designated server administrator. Perform this only on an
isolated Sandbox host. Never point a drill at Production or a live provider.

A valid case backup is one matched set:

- the SQLite database backup;
- the encrypted case-evidence directory;
- the evidence encryption key inside that directory;
- the generated hash manifests.

Restoring only one part is not a successful restore.

### Step-by-step drill

1. Select one completed backup set and write down its timestamp.
2. Stop the isolated test API.
3. Copy the selected database and matching evidence directory into a new,
   empty restore directory.
4. Verify the database SHA-256 file.
5. Verify every line in `BACKUP_MANIFEST.sha256`.
6. Run SQLite `PRAGMA integrity_check` and require the result `ok`.
7. Configure the isolated API to use only the restored database and evidence
   directory.
8. Start one Sandbox API instance.
9. Open a known case and download its signed evidence bundle.
10. Require `auditChainVerified` to be `true`.
11. Record the backup timestamp, verification results, case reference,
    administrator, and outcome.
12. After retaining the drill record, securely remove only the isolated drill
    copy.

If a hash fails, the database is not `ok`, an artifact cannot be decrypted, or
the audit chain fails, mark the drill failed and do not use that backup set.

The backup script is `scripts/backup-sqlite.mjs`. It creates a database backup,
a timestamp-matched `case-evidence-*` directory, and hash manifests.
