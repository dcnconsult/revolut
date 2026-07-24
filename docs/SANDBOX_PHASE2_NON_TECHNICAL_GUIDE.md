# Revolut Sandbox Phase 2 check

## Who this guide is for

This guide is for colleagues who do not work with code or servers.

You will use one button in GitHub to check that our DigitalOcean server can
safely read test-account information from Revolut Sandbox.

You will not need a terminal, certificate, token, password, or API key.

## What Phase 2 proves

A successful check proves all of the following:

- GitHub can securely reach our DigitalOcean Droplet.
- The Droplet can authenticate to Revolut Sandbox.
- Revolut Sandbox accepts our **READ-only** permission.
- The Droplet can retrieve a summary of the test accounts.
- The request used the Sandbox address, not the Production address.

Phase 2 does **not**:

- send or schedule a payment;
- change an account, counterparty, card, or team member;
- read sensitive card numbers or CVVs;
- connect the public application to real banking;
- prove that Production is ready.

The application itself continues to use its safe mock payment provider. Phase
2 is a separate connectivity check.

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
PHASE2_SANDBOX_OK
```

It also shows:

- the number of Sandbox accounts;
- how many are active;
- the test currencies returned;
- `host=sandbox-b2b.revolut.com`;
- `permission=READ`.

This is a successful Phase 2 check.

### Red X

The final error starts with:

```text
PHASE2_SANDBOX_FAILED
```

Do not retry more than once.

Copy only the `PHASE2_SANDBOX_FAILED` line and send it to the project
maintainer. Never copy surrounding environment values, tokens, keys, or
complete diagnostic logs into email or chat.

## Safety rules

- Run only the workflow named **Check Revolut Sandbox from Droplet**.
- Confirm the result says `host=sandbox-b2b.revolut.com`.
- Confirm the result says `permission=READ`.
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
- account count and currencies from a green result.

Do not record account IDs, balances, certificates, tokens, or keys.
