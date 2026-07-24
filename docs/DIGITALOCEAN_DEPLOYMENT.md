# DigitalOcean mock deployment

This deployment deliberately runs only the deterministic mock provider. It
does not make the scaffold suitable for live-money submission.

## Security model

- The API container is bound only to `127.0.0.1:3000` on the Droplet.
- The firewall exposes SSH only.
- Deployments run as the dedicated `deploy` user, not `root`.
- `/etc/revolut/revolut.env` must contain `REVOLUT_MODE=mock`.
- The activation script refuses any other mode.
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

In repository settings, create an environment named `mock-production`.
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
5. starts it and requires `/health` to report mock mode; and
6. updates `/opt/revolut/current`.

Images are tagged with the Git commit SHA. To reactivate an existing release:

```bash
bash /opt/revolut/releases/<FULL_COMMIT_SHA>/scripts/deploy/activate-release.sh \
  <FULL_COMMIT_SHA>
```

## Production boundary

Do not add Revolut private keys, refresh tokens, populated `.env` files, bank
XML, or GitHub deployment secrets to the repository. Live mode remains blocked
by the controls documented in `IMPLEMENTATION_CHECKLIST.md`.
