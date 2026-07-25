# Sandbox operator console

The operator console gives non-technical staff a guided view of the Revolut
Sandbox deployment. It is private, works only in Sandbox mode, and is not
reachable directly from the internet.

## Open the console

1. Open PowerShell on the authorized workstation.
2. Keep this command running:

   ```powershell
   ssh -i C:\Users\novot\.ssh\revolut_deploy -L 3300:127.0.0.1:3000 deploy@178.128.36.90
   ```

3. Open `http://127.0.0.1:3300/operator/` in Chrome.
4. Sign in with the admin or read-only credentials supplied privately.
5. Confirm the yellow **REVOLUT SANDBOX · NO LIVE DATA** banner is visible.

The read-only user can see health, backups, deployment status, redacted
transfers, and redacted audit events. The read-only user cannot retrieve
account balances or perform a transfer.

## Run an admin Sandbox transfer

1. Sign in as the admin.
2. Choose an eligible account pair under **Run a controlled Sandbox transfer**.
3. Enter an amount from `0.01` through the ceiling shown on screen.
4. Select **Prepare test**. Preparation validates the request but does not move
   Sandbox funds.
5. Review the amount, environment, and prepared state.
6. Re-enter the admin password and type the exact phrase shown on screen.
7. Select **Submit Sandbox transfer** once.

Prepared transfers expire after 15 minutes. Every submission repeats the
account, currency, balance, amount, and idempotency checks. Never retry a
submitted record merely because its state is pending.

## Account and credential rules

- There is exactly one admin and one read-only human account.
- Passwords are displayed only during one-time provisioning and must be stored
  in the organization password manager.
- Five failed sign-in attempts within 15 minutes trigger a temporary limit.
- Sessions expire after 30 minutes without activity or eight hours overall.
- Deployments may require users to sign in again.
- The machine automation token cannot submit or reconcile transfers.

Provision the accounts once on the Droplet, as root:

```bash
bash /opt/revolut/current/scripts/deploy/provision-operator-access.sh
```

The script refuses to overwrite existing credentials.

## If something fails

Copy only the plain-language error and time. Do not copy account identifiers,
balances, passwords, tokens, cookies, or browser developer-tool output into an
issue or chat message. Follow `SANDBOX_OPERATIONS_RUNBOOK.md` for escalation.
