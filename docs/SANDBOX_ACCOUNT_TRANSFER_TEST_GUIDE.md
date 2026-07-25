# Run a controlled Sandbox account-transfer test

**Audience:** an administrator asked to test the advanced diagnostic tool.

This test moves a very small synthetic amount between two owned Revolut
Sandbox accounts. It is separate from funding cases. It does not prove a
beneficiary, funding match, case approval, or Production readiness.

## Before you start

1. Confirm the yellow banner says **REVOLUT SANDBOX · NO LIVE DATA**.
2. Confirm **Operations** is **Clear** and **Backup** is **Fresh**.
3. Confirm your access card says **Admin**.
4. Confirm an administrator requested this diagnostic.
5. Confirm no earlier test is pending or awaiting reconciliation.

Stop if any check fails.

## Prepare the test

1. Open **Advanced diagnostic — Direct owned-account transfer test**.
2. Choose the approved source Sandbox account.
3. Choose a different approved destination Sandbox account.
4. Enter the currency supported by both accounts.
5. Enter the approved amount. Use the smallest allowed value unless the test
   record says otherwise.
6. Enter a clearly synthetic reference.
7. Select **Prepare test** once.

Preparation validates the request but does not submit it. The prepared record
expires after 15 minutes.

## Review before submission

Read the prepared summary and confirm:

- source and destination are different owned Sandbox accounts;
- currency matches both accounts;
- amount is within the displayed ceiling;
- reference clearly identifies a Sandbox test;
- environment is Sandbox and live data is false.

If any value is wrong, let the preparation expire and start again. Do not
submit it.

## Submit once

1. Re-enter your password.
2. Enter a fresh authenticator code.
3. Type the exact confirmation phrase shown on screen.
4. Select **Submit Sandbox transfer** once.
5. Wait for the displayed result.

Do not repeat submission because the page is slow or the result is pending.
The application keeps one stable provider request ID so reconciliation can
determine what happened without double payment.

## Reconcile

1. Find the test under **Recent Sandbox activity**.
2. If it is pending or unclear, select **Reconcile** once.
3. Record the final state and time.
4. Stop and report a failed, reverted, declined, or still-ambiguous result.

## Test record

Record only:

- date and time;
- operator name;
- release identifier;
- redacted transfer reference;
- amount and currency;
- prepared result;
- final reconciled result;
- incident reference, if any.

Do not copy account identifiers, tokens, passwords, cookies, balances, or
browser developer-tool output into the test record.
