# Work a brokered-funding case

**Audience:** administrators who review and execute synthetic Sandbox cases.
Read-only users may follow the same review steps but cannot change a case.

**Safety boundary:** this application uses Revolut Sandbox only. A ZIP package
describes a request. It does not prove funds arrived and it does not authorize
a payout.

For a shorter checklist, open **Operator guide ↗** in the application.

## Before you begin

1. Confirm the yellow banner says **REVOLUT SANDBOX · NO LIVE DATA**.
2. Confirm **Operations** is **Clear** and **Backup** is **Fresh**.
3. Use your own account and current authenticator code.
4. Make sure the ZIP came through the approved private channel.
5. Keep the sender's message or case reference available for comparison.

Stop if the banner is missing, the package contains live customer information,
or the application reports a security or backup problem.

## Step 1: upload the package

1. In **Funding case inbox**, choose the ZIP.
2. Select **Upload to quarantine** once.
3. Wait for a case reference.
4. Do not rename, unpack, edit, or upload individual package files.

The application stores the original package before checking it. Uploading the
same submission again does not create permission to process it twice.

## Step 2: review package health

Wait for scanning and validation to finish, then read every blocked reason.

- **Quarantined** means safety checks have not passed. Do not open artifacts.
- **Intake Hold** means the package can be recorded but required information or
  integrity checks failed.
- **Awaiting Broker** means the package passed intake and needs human review.

An unavailable malware scanner leaves the case quarantined. Do not bypass the
scanner or send confidential files to an online scanning service.

## Step 3: compare claims and findings

Review the three columns separately:

1. **Submitted claims:** what the sender stated.
2. **Machine findings:** repeatable checks performed by the application.
3. **Broker findings:** your documented professional review.

Check identity, authority, source of funds, beneficiary, payout instructions,
document consistency, incoming settlement, allocation, and execution
readiness. Never turn an assumption into a fact.

## Step 4: add evidence or an amendment

1. Obtain new evidence through an approved source.
2. Select the claim that needs correction.
3. Enter the corrected value.
4. Explain why it changed.
5. Identify the source and cite the relevant evidence.
6. Save the amendment and wait for risk checks to run again.

The original claim remains visible. A hard block cannot be accepted as a
judgment call; resolve it with new evidence or reject the case.

## Step 5: match the incoming credit

1. Select **Refresh provider observations**.
2. Compare the observed sender, reference, currency, amount, time, and provider
   account with the expected credit.
3. Select a match only when all required details agree.
4. Treat **Possible Match** as unconfirmed.

The package itself is never proof of receipt. A test credit created by the
application is labelled **Sandbox simulation** and must not be described as
real settlement.

Stop if the credit is missing, duplicated, reversed, in the wrong currency, or
cannot be distinguished from another transaction.

## Step 6: make the case decision

Choose exactly one outcome:

- **Approve** only when every required risk area passes and there is no hard
  block.
- **Request information** when a specific item can be supplied or corrected.
- **Reject** when the request must not proceed.

Record a short, factual reason. Approval still does not authorize payment.

## Step 7: review the funding plan

Read every customer payout, broker fee, provider fee, reserve, and refund.
The plan can continue only when:

```text
matched receipt =
customer payouts + broker fee + provider fees + reserve or refund
```

Check the currency, amount, beneficiary, existing Sandbox counterparty or owned
account, payment reference, and purpose for every line. The application never
creates a counterparty from uploaded package data.

## Step 8: authorize and execute

1. Confirm the case is approved and the funding match is current.
2. Confirm the plan version and digest shown on screen.
3. Re-enter your password.
4. Enter a fresh authenticator code.
5. Type the exact plan-specific phrase shown on screen.
6. Select **Authorize** once.
7. Review the same plan again and select **Execute** once.

Payouts are submitted one at a time. A pending, failed, reverted, declined, or
unclear result stops the sequence. Do not click execute again or create a
replacement request.

Any material change to evidence, funding, beneficiary, allocation, provider
details, or risk invalidates authorization. Review the new plan version from
the beginning.

## Step 9: reconcile and export

1. Select **Reconcile** for a queued, partial, or unclear execution.
2. Wait for a final provider result for each submitted payout.
3. Confirm later payouts remained unsubmitted if an earlier one stopped.
4. Continue until the case shows **Reconciled**, or escalate the blocking
   result.
5. Select **Download evidence**.
6. Store the signed bundle in the approved case location.

The evidence bundle contains the original package, checks, amendments,
decisions, plan versions, approvals, redacted provider evidence,
reconciliation, and the audit chain.

## Legacy `TXN_001.zip`

This fixture is expected to open in **Intake Hold**. It is a training example
of an incomplete package, not a payment-ready case. Expected problems include:

- missing and undeclared files plus one file with the wrong size or hash;
- no source signature, identities, beneficiary, payout instructions,
  allocation, or authority;
- no wallet address, transaction hash, custody evidence, or proof of ETH
  control;
- an RPC hexadecimal value that differs from the stated wei amount;
- manual valuation and unsupported “KYC/AML CLEARED” claims.

Do not call the provider or create a funding plan for this fixture. Each block
requires new, cited evidence or the case must be rejected.

## Technical reference for administrators

The application enforces separate case, funding, and execution states; exact
minor-unit accounting; immutable plan digests; append-only amendments; stable
provider request IDs; encrypted evidence storage; and a hash-linked audit
chain. API and package-format details are intentionally kept out of the daily
operator workflow. Maintainers can inspect the authenticated `/v1/cases`
routes and the `brokered-funding/1.0` schema in the source code.

See also [plain-language status meanings](GLOSSARY.md) and
[backup and restore](CASE_BACKUP_RESTORE.md).
