# DigitalOcean Sandbox deployment

The Droplet currently runs the Revolut Business Sandbox internal-transfer
provider. Sandbox and Production remain separate, and this deployment does not
make the scaffold suitable for live-money submission.

## Security model

- The API container is bound only to `127.0.0.1:3000` on the Droplet.
- The firewall exposes SSH only.
- Deployments run as the dedicated `deploy` user, not `root`.
- `/etc/revolut/revolut.env` must contain `REVOLUT_MODE=sandbox` for the
  active deployment. The deterministic local fallback uses `mock`.
- The activation script permits only `mock` or `sandbox` and refuses
  Production mode.
- GitHub Actions secrets contain SSH connection material; Git does not.

Until authentication and a TLS reverse proxy are designed, reach the API with
an SSH tunnel:

```bash
ssh -L 3000:127.0.0.1:3000 deploy@178.128.36.90
curl http://127.0.0.1:3000/health
```

## One-time Droplet bootstrap

Run the bootstrap from a root console on Ubuntu 24.04:

```bash
curl -fsSLo /tmp/revolut-bootstrap.sh \
  https://raw.githubusercontent.com/dcnconsult/revolut/master/scripts/deploy/bootstrap-ubuntu.sh
bash /tmp/revolut-bootstrap.sh
```

The script installs Docker, Compose, `rsync`, and UFW; creates `deploy`; copies
root's existing authorized SSH keys to that user; creates the mock environment
file; and leaves only SSH open in UFW.

Before changing root login settings, open a second terminal and verify:

```bash
ssh deploy@178.128.36.90
docker version
docker compose version
```

Do not disable the working root console or root SSH path until `deploy` access
has been tested in a separate session.

## GitHub environment and secrets

The existing deployment environment is named `mock-production` for historical
compatibility with its configured secrets. Despite that legacy name, the
Droplet's root-managed environment file selects Sandbox mode and Production
mode is refused.
Configure required reviewers if deployment should require a manual approval.

Add these environment secrets:

| Secret | Value |
| --- | --- |
| `DROPLET_HOST` | `178.128.36.90` |
| `DROPLET_USER` | `deploy` |
| `DROPLET_SSH_KEY` | Private key matching an authorized key for `deploy` |
| `DROPLET_KNOWN_HOSTS` | Verified `known_hosts` line for the Droplet |

Generate `DROPLET_KNOWN_HOSTS` from a trusted machine after independently
checking the Droplet's ED25519 host-key fingerprint in its console:

```bash
ssh-keyscan -t ed25519 178.128.36.90
```

Do not accept an unverified first-seen host key inside the workflow.

## Deployment and rollback

Merging to `master` or manually dispatching the workflow:

1. runs linting, type checks, tests, and the TypeScript build;
2. builds and health-checks the container;
3. uploads files to an immutable commit-SHA release directory;
4. builds the image on the Droplet;
5. starts it and requires `/health` to report the configured mode;
6. in Sandbox mode, runs a prepared-only remote smoke test covering
   idempotency, restart persistence, monitoring, backup verification, and
   loopback-only binding; and
7. updates `/opt/revolut/current` only when those checks pass.

If candidate startup, health, backup scheduling, or the Sandbox smoke test
fails, the activation script attempts to reactivate the previous immutable
release automatically. The smoke test never calls the transfer submission
endpoint and never prints account identifiers, balances, or credentials.

Run the same safe smoke test manually with the **Run Safe Remote Sandbox Smoke
Test** GitHub Actions workflow or from the Droplet:

```bash
bash /opt/revolut/current/scripts/deploy/run-remote-smoke-test.sh
```

A successful run prints one non-sensitive line beginning with
`REMOTE_SMOKE_OK`.

## Scheduled operations

The **Check Revolut Sandbox from Droplet** workflow runs a read-only monitor
daily at 06:17 UTC. The **Run Safe Remote Sandbox Smoke Test** workflow runs a
prepared-only persistence and backup check each Sunday at 04:47 UTC. Scheduled
failures open or update a deduplicated `[Ops]` GitHub issue; a later successful
scheduled run closes it.

See [`SANDBOX_OPERATIONS_RUNBOOK.md`](SANDBOX_OPERATIONS_RUNBOOK.md) for the
non-technical operating procedure and escalation rules.

Images are tagged with the Git commit SHA. To reactivate an existing release:

```bash
bash /opt/revolut/releases/<FULL_COMMIT_SHA>/scripts/deploy/activate-release.sh \
  <FULL_COMMIT_SHA>
```

## Production boundary

Do not add Revolut private keys, refresh tokens, populated `.env` files, bank
XML, or GitHub deployment secrets to the repository. Live mode remains blocked
by the controls documented in `IMPLEMENTATION_CHECKLIST.md`.

## READ-only Revolut Sandbox monitoring

The underlying account-authentication check runs in a separate one-shot
container, exposes no port, and refuses every API host except Revolut Sandbox.
The scheduled daily monitor combines that check with application health,
SQLite monitoring, backup freshness and integrity, credential permissions,
disk capacity, cron status, and loopback binding.

An explicitly configured `REVOLUT_MODE=sandbox` release uses
`compose.sandbox.yaml` and supports only transfers between accounts owned by
the same Sandbox business. Production mode is refused. See
`SANDBOX_LIVE_MODE.md`.

The Droplet stores these root-managed files:

```text
/etc/revolut/sandbox/config.json
/etc/revolut/sandbox/tokens.json
/etc/revolut/sandbox/privatecert.pem
```

The three files are mounted read-only into the probe container. Their contents
do not appear in Docker environment inspection. None belongs in Git, a release
directory, a Docker image, or a GitHub secret.

The committed check reads the saved configuration and refuses to run unless
the API URL is exactly:

```text
https://sandbox-b2b.revolut.com/api/1.0
```

Technical operators can run:

```bash
bash /opt/revolut/current/scripts/deploy/run-sandbox-phase2-check.sh
```

Non-technical testers should use the **Check Revolut Sandbox from Droplet**
manual GitHub Actions workflow and follow
[`SANDBOX_PHASE2_NON_TECHNICAL_GUIDE.md`](SANDBOX_PHASE2_NON_TECHNICAL_GUIDE.md)
or the broader
[`SANDBOX_OPERATIONS_RUNBOOK.md`](SANDBOX_OPERATIONS_RUNBOOK.md).

Successful workflow output is a non-sensitive summary beginning with
`REMOTE_MONITOR_OK`. The underlying account check still uses
`PHASE2_SANDBOX_OK` internally. Neither output prints tokens, account IDs, or
balances.
