# Revolut Sandbox account transfer test

## Who this guide is for

This guide is for colleagues who do not work with code or servers. It tests a
small transfer between two accounts owned by our Revolut Sandbox business.

Revolut states that Sandbox and Production are independent. This workflow is
also hard-coded to the Sandbox API host and refuses the Production API URL.

## What the test does

The test:

- finds two active Sandbox accounts in the same currency;
- checks that the source has enough test funds;
- limits the amount to between `0.01` and `10.00`;
- creates a unique request ID so the same request cannot be processed twice;
- uses `POST /transfer`, Revolut's account-to-account transfer endpoint;
- prints only the mode, state, amount, currency, Sandbox host, and permission.

It never prints account IDs, balances, tokens, certificates, or private keys.

The application API remains mock-only. This test is a separate one-shot
container with no network port.

## Before an executed test

The project owner must confirm that:

- the Sandbox API certificate has `READ` and `PAY` consent;
- the current Sandbox credentials have been installed on the Droplet;
- at least two active Sandbox accounts exist in the same currency;
- the source account contains at least the selected amount of Sandbox test funds.

`PAY` can initiate transactions, so it must be enabled only for the independent
Sandbox certificate. Never enable it for Production as part of this procedure.

## Run a dry run

1. Open the [`dcnconsult/revolut` Actions page](https://github.com/dcnconsult/revolut/actions).
2. Select **Test Sandbox Account Transfer**.
3. Select **Run workflow**.
4. Leave the branch set to `master`.
5. Leave **Sandbox test amount** at `0.01`.
6. Leave **Move Sandbox test funds** turned off.
7. Select the green **Run workflow** button.

A green dry run ends with:

```text
PHASE3_SANDBOX_TRANSFER_READY execution=DRY_RUN state=not_submitted amount=0.01 currency=GBP host=sandbox-b2b.revolut.com permission=PAY_required live_data=false
```

The currency may differ. `DRY_RUN` and `state=not_submitted` prove no transfer
was created.

## Execute the Sandbox transfer

Run this only after the project owner approves the specific test.

1. Repeat the dry-run steps.
2. Set the approved amount, normally `0.01`.
3. Turn on **Move Sandbox test funds**.
4. Select **Run workflow**.
5. Open the run and select **Sandbox-only account transfer**.

A successful executed test ends with:

```text
PHASE3_SANDBOX_TRANSFER_OK execution=EXECUTED state=completed amount=0.01 currency=GBP host=sandbox-b2b.revolut.com permission=PAY live_data=false
```

The state may briefly be `pending` depending on Sandbox behaviour.

## Stop and report

Stop if:

- the host is anything other than `sandbox-b2b.revolut.com`;
- `live_data` is anything other than `false`;
- the requested amount is unexpected;
- the workflow reports `PHASE3_SANDBOX_TRANSFER_FAILED`.

Send the maintainer only the workflow link and the single result or failure
line. Do not copy environment values or full authentication logs.

## Test record

Record only:

- date and time;
- tester's name;
- GitHub Actions run link;
- dry run or executed;
- amount, currency, and final state.

Do not record account IDs, balances, certificates, tokens, or keys.
