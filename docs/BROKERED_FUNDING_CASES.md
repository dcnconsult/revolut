# Broker guide: work a Sandbox case

**Who this is for:** the authorised broker who reviews a case in the private
browser workspace. A read-only user may look at the case, but cannot change it.

**What this is:** a careful, documented test in Revolut Sandbox.

**What this is not:** a live payment, proof that a sender's file is correct, or
permission to use live money. A ZIP file starts a review record; it never proves
that money arrived and it never authorises a payout.

For a shorter version, use **Operator guide ↗** in the workspace.

## Before you start

1. Check the yellow banner: **REVOLUT SANDBOX · NO LIVE DATA**.
2. Check **Operations: Clear** and **Backup: Fresh**.
3. Use your own sign-in and current authenticator code.
4. Make sure the ZIP arrived through the approved private channel.
5. Keep the sender's message or business reference available for comparison.

Stop if the banner is missing, the workspace reports a security or backup
problem, or representative operational files have not been approved for this
private test environment.

## 1. Upload the file exactly as received

1. In **Funding case inbox**, choose the ZIP file.
2. Select **Upload to quarantine** once.
3. Wait for the case reference to appear.
4. Do not rename, unpack, edit, or upload individual files from the ZIP.

The workspace keeps the original file safely before it checks it. Uploading the
same file again does not create a second case or another chance to run a test.

## 2. Read package health and the file list

Wait for scanning to finish. Then read the plain-language message and **Needed
next** instruction for each open item.

- **Quarantined** means the safety check has not cleared the file. Stop; do not
  open files or try to work around the check.
- **Intake Hold** means the file can be kept for review, but important details
  are missing, unclear, or cannot yet be checked.
- **Awaiting Broker** means the file passed its initial checks and now needs
  your review.

A safe but unfamiliar ZIP is still useful. The workspace can show a protected
file list—names, types, sizes, and check results—without pretending that it
understands every document. Treat that file list as a starting point for your
review, not as payment instructions.

Never send a confidential ZIP to a public scanning website or paste its contents
into email, chat, or a support ticket.

## 3. Review the case in broker terms

Keep these three things separate:

1. **Submitted information** — what the sender says.
2. **Workspace findings** — what the checks found or could not confirm.
3. **Broker review** — your professional assessment and supporting records.

Check the parties, authority, purpose, expected incoming amount, reference,
destination, and proposed payout. Do not turn a reasonable assumption into a
recorded fact.

Use **Add broker finding** to record a pass, concern, or stop reason. Write a
short, factual note that another broker can follow later.

## 4. Record confirmed facts or a correction

When a clean but unfamiliar ZIP needs broker confirmation, use **Confirm
real-case inputs**. Enter only facts you have checked independently:

- the destination Sandbox account;
- full incoming test amount and currency;
- payment reference;
- investor and beneficiary names;
- authority reference and business purpose; and
- a short reference to the supporting record and why you are recording it.

The workspace keeps the earlier statement and your correction together. You do
not need to enter technical file codes, hashes, or JSON.

Some safety or provider findings cannot be cleared by typing a correction. In
that situation, follow the **Needed next** instruction, obtain a new supporting
record, wait for a later Sandbox result, or reject the case.

## 5. Confirm the Sandbox test credit

The case can move on only after one matching test credit is seen in Revolut
Sandbox. The uploaded file is never proof that the test credit arrived.

1. Select **Create and match test credit** only when the case is ready for that
   Sandbox step.
2. Check that one credit has the right Sandbox account, currency, full amount,
   and reference.
3. Continue only when **Funds** says **Matched**.

The workspace labels this credit as a Sandbox simulation. It is not real
settlement and must not be described as real client money.

If it says **Possible Match**, **Unmatched**, **Awaiting Funds**, **Reversed**,
or **Unclear**, stop. Use **Refresh** or **Reconcile** to check the existing
result. Do not start another funding test.

## 6. Record the broker decision

Choose one clear outcome:

- **Approve** — all required checks pass and the Sandbox test credit is
  matched.
- **Request information** — a specific item can be supplied or clarified.
- **Reject** — the case should not proceed or the concern cannot be resolved.

Add a short, factual reason. Approval allows plan review; it does not itself run
a payment.

## 7. Read the plan before authorising it

Read every line: customer payout, broker fee, provider fee, reserve, and refund.
The full matched test credit must be accounted for exactly:

```text
matched test credit = payouts + fees + reserve or refund
```

For each line, check the amount, currency, beneficiary, existing Sandbox
destination, reference, and purpose. The workspace does not create a new
recipient from an uploaded ZIP file.

## 8. Authorise and run the Sandbox test once

1. Confirm the case is approved and the matched test credit is still current.
2. Read the plan version and short plan reference shown on screen.
3. Enter your password and a fresh authenticator code to **Authorise**.
4. Read the same plan again.
5. Enter your password and a fresh authenticator code to **Execute once**.
6. Wait for Sandbox to return a result.

The workspace submits payouts one at a time. If a result is pending, declined,
reversed, failed, or unclear, it stops safely. Do not press **Execute** again
and do not create a replacement test payment.

Any important change to the case, funding, beneficiary, plan, or supporting
record means you must review the new plan from the beginning.

## 9. Check the final result and save the record

Use **Reconcile Sandbox result** only after a plan has been run. It asks
Sandbox for the current result of the existing request; it does not send another
payment.

1. Select **Reconcile Sandbox result** for a pending, partial, blocked, or
   unclear execution.
2. Check that later payouts were not sent after an earlier one stopped.
3. Continue checking until the case says **Reconciled**, or keep the case
   stopped and ask for support.
4. Select **Download signed evidence** and store it in the approved case
   location.

The downloaded record contains the original file, checks, broker notes,
corrections, decisions, plan versions, Sandbox results, and a signed history.

## When a high-value Sandbox test is limited or interrupted

The direct account-transfer button is a small connection check. A broker case
uses a separate Sandbox-only case limit and sends the **full confirmed test
amount**. It will not quietly shrink an amount.

If Sandbox limits, rejects, or cannot clearly report a high-value test:

1. Stop. Do not submit the funding or payout again.
2. Use **Refresh** or **Reconcile** to check the existing test result.
3. Keep the provider result or the “unclear” finding in the case.
4. Request support or record a separately supported new case decision before
   considering a changed test.

The workspace protects the first attempt so a second click cannot accidentally
create a second high-value test.

## If you need help

Record only the following in a support message:

```text
Time:
Case reference (first 8 characters only):
Screen:
Status:
What the workspace said:
What I did: Stopped without starting another test
```

Do not send names, full account details, balances, ZIP contents, passwords,
authenticator or recovery codes, tokens, or screenshots containing them.

See also [plain-language status meanings](GLOSSARY.md),
[daily operations](SANDBOX_OPERATIONS_RUNBOOK.md), and
[backup and restore](CASE_BACKUP_RESTORE.md).

## Technical reference for administrators

Technical API, storage, encryption, and package-format details are intentionally
kept out of this broker guide. Administrators can use the
[deployment guide](DIGITALOCEAN_DEPLOYMENT.md) and source documentation.
