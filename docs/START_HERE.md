# Start here: broker and operator guide

**Who this is for:** the authorised broker or operator using the private
browser workspace.

**Important:** this is Revolut **Sandbox**. It is a test environment only—no
live money and no Production Revolut connection.

## Before you begin

1. Open the private address supplied by your administrator.
2. Check that the yellow banner says **REVOLUT SANDBOX · NO LIVE DATA**.
3. Sign in with your own username and password.
4. Enter the current six-digit code from your authenticator app if asked.
5. Check **Operations**. Continue only when it says **Clear**.
6. Check **Backup**. Do not approve or run a Sandbox case unless it says
   **Fresh**.
7. Select **Operator guide ↗** if you would like the help guide open beside
   the workspace.

The banner confirms that this is the Sandbox test environment. It does not by
itself approve use of a client case ZIP. Use client case information only when
the named pilot data-handling and retention approval says you may do so.

Stop and contact the administrator if the Sandbox banner is missing, the
workspace says **Blocked**, backup is not fresh, or you are asked to use live
client case information before that approval is in place.

## What the workspace does with a ZIP file

The ZIP file you upload becomes a **case**: one protected work record for the
request. The workspace first stores the original file, then checks whether it
is safe to inspect.

A safe but unfamiliar ZIP can still be useful. The workspace will show its
file list and tell you what information is missing or cannot yet be checked.
That does not mean the file is ready for a payment. You decide what needs to
be confirmed, corrected, requested, or rejected.

## Your daily check

1. Review the **Environment**, **Operations**, and **Backup** cards.
2. Refresh the case inbox.
3. Look for cases marked:
   - **Quarantined**
   - **Needs information**
   - **Possible match**
   - **Reversed**
   - **Partial**, **Blocked**, or **Failed**
4. Record the date, time, your name, and whether the check was clear.
5. If a status is unclear, leave the case as it is and follow
   [If something goes wrong](#if-something-goes-wrong).

## Work a case

Follow these steps in order:

1. Upload the ZIP file exactly as you received it.
2. Read the package health, file list, and questions raised by the workspace.
3. Compare the sender's information, the workspace's findings, and your own
   broker review.
4. Add a documented correction when you have a supporting record.
5. Check for one matching **Sandbox test credit**.
6. Choose **Approve**, **Request information**, or **Reject**.
7. Read the planned payouts, fees, reserve, and refund.
8. Authorise and run the Sandbox test once.
9. Select **Reconcile** to check the final Sandbox result, then download the
   signed case record.

For screenshots and step-by-step help, read the
[Broker case guide](BROKERED_FUNDING_CASES.md).

## About large test amounts

The separate direct-account test is a small connection check. It is not the
broker case workflow.

For an approved Sandbox case, the workspace uses the full amount confirmed for
that case, within its Sandbox-only limit. It does not quietly reduce a large
test amount to make the test pass. If Revolut Sandbox limits, declines, or
leaves a result unclear, keep that result in the case and ask for guidance
before changing anything.

## If something goes wrong

1. Stop. Do not press **Authorise**, **Execute**, or a funding button again.
2. Use **Refresh** or **Reconcile** when the workspace offers it; these check
   the existing Sandbox result rather than starting another test.
3. Note the time, first eight characters of the case reference, screen name,
   status, and the plain-language message.
4. Do not copy package contents, names, full account details, balances,
   passwords, one-time codes, recovery codes, or browser technical details.
5. Send the safe note to the named administrator through the approved support
   channel.

Use this template:

```text
Time:
Case reference (first 8 characters only):
Screen:
Status:
What the workspace said:
What I did: Stopped without starting another test
```

## Where to go next

- [Use the browser workspace](SANDBOX_OPERATOR_CONSOLE.md)
- [Work a case in detail](BROKERED_FUNDING_CASES.md)
- [Read status meanings](GLOSSARY.md)
- [Complete daily operations](SANDBOX_OPERATIONS_RUNBOOK.md)
