# Revolut Sandbox daily monitor

## Who this guide is for

This guide is for colleagues who do not work with code or servers.

You will use one button in GitHub to check that our DigitalOcean server can
safely authenticate to Revolut Sandbox and verify the supporting application,
monitoring database, backup, cron, disk, credentials, and private network
binding.

You will not need a terminal, certificate, token, password, or API key.

## What the monitor proves

A successful check proves all of the following:

- GitHub can securely reach our DigitalOcean Droplet.
- The Droplet can authenticate to Revolut Sandbox.
- Revolut Sandbox accepts our **READ-only** permission.
- The Droplet can retrieve a summary of the test accounts.
- The request used the Sandbox address, not the Production address.
- The application is healthy in Sandbox mode.
- The monitoring database and latest backup are readable and valid.
- The weekly backup schedule is installed.
- Disk use and credential-file permissions remain within configured limits.
- Port 3000 remains bound only to the Droplet loopback interface.

Phase 2 does **not**:

- send or schedule a payment;
- change an account, counterparty, card, or team member;
- read sensitive card numbers or CVVs;
- connect the public application to Production banking;
- prove that Production is ready.

The application uses the Sandbox internal-transfer provider. The daily monitor
is read-only and never calls either the preparation or submission endpoint.

## Before you start

You need:

- access to the `dcnconsult/revolut` repository in GitHub;
- permission to run GitHub Actions;
- confirmation from the project owner that the `sandbox-phase2` environment is ready.

Never ask anyone to send you a certificate, token, private key, password, or
authorization code.

## Run the check

1. Open the [`dcnconsult/revolut` Actions page](https://github.com/dcnconsult/revolut/actions).
2. In the list on the left, select **Check Revolut Sandbox from Droplet**.
3. Select **Run workflow**.
4. Leave the branch set to `master`.
5. Select the green **Run workflow** button.
6. Wait for the new run to appear. This normally takes less than two minutes.
7. Open the run and select **READ-only Sandbox account check**.

## Read the result

### Green check

The final line starts with:

```text
REMOTE_MONITOR_OK
```

It confirms health, authentication, database, backup, cron, disk, and
loopback-only binding without printing account details. This is a successful
daily monitor.

### Red X

The final error starts with:

```text
REMOTE_MONITOR_FAILED
```

Do not retry more than once.

Copy only the `REMOTE_MONITOR_FAILED` line and send it to the project
maintainer. Never copy surrounding environment values, tokens, keys, or
complete diagnostic logs into email or chat.

## Safety rules

- Run only the workflow named **Check Revolut Sandbox from Droplet**.
- Confirm the result says `mode=sandbox`.
- Confirm the result says `authentication=ok` and `bind=loopback`.
- Never add, change, or reveal GitHub secrets.
- Never open or download files from `.secrets`, `/etc/revolut`, or `/run/secrets`.
- Never enable **Manage account details**, **Make payments**, or **Read sensitive card details** without a separately approved test plan.
- A Sandbox result must never be described as a Production payment result.

## Suggested test record

Record only:

- date and time;
- tester's name;
- GitHub Actions run link;
- green or red result;
- the single green or red result line.

Do not record account IDs, balances, certificates, tokens, or keys.
