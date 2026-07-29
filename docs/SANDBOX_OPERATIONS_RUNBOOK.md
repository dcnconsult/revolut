# Daily Sandbox operations

**Who this is for:** the person who checks the private broker workspace each
working day.

This guide checks that the **test** workspace is ready. It never authorises live
access or a live payment.

## A normal result

The workspace is ready for ordinary broker review when all of these are true:

- the yellow banner says **REVOLUT SANDBOX · NO LIVE DATA**;
- **Operations** says **Clear**;
- **Backup** says **Fresh**;
- the latest scheduled check passed;
- no case is unexpectedly **Partial**, **Blocked**, **Failed**, or **Reversed**;
- the release shown by the workspace matches the approved release record.

## Daily check

1. Open the private workspace and sign in.
2. Check the yellow Sandbox banner.
3. Read the **Operations** card.
4. Read the **Backup** card.
5. Refresh the case inbox.
6. Review any case that needs attention.
7. Review **Recent Sandbox activity** for pending, failed, or unclear items.
8. Review the operational report for unresolved errors.
9. Record the date, time, your name, release, and whether the check was clear.

If everything is normal, no further action is required.

## What the Operations card means

| What you see | Plain meaning | What to do |
|---|---|---|
| Clear | No unresolved workspace problem is known. | Continue normal review. |
| Degraded | A warning or temporary problem needs attention. | Pause a new test and read the safe report. |
| Blocked | A serious problem needs administrator attention. | Stop case work and contact the administrator. |
| Unavailable | The report could not be read. | Treat this as Blocked. |

## What a test result means

| What you see | Plain meaning | What to do |
|---|---|---|
| Prepared | The workspace checked the details but did not send a Sandbox test. | Review or let it expire. |
| Authorized | One exact plan is ready for the final Sandbox confirmation. | Recheck it, then execute once. |
| Queued or Submitted | Sandbox is still returning a result. | Wait, then use **Reconcile**. Do not submit again. |
| Pending or unclear | Sandbox has not given a final answer. | Use **Reconcile**; do not start a replacement test. |
| Partial | An earlier test payout was sent and later work stopped. | Stop and ask for support. |
| Reconciled or Completed | The final Sandbox result was confirmed. | Download the signed case record. |
| Blocked or Failed | The workspace cannot safely continue. | Stop and ask for support. |
| Reverted or Declined | Sandbox did not complete the test payout. | Keep the result, reconcile it, and do not retry automatically. |

## If something is wrong

1. Stop the current action.
2. Do not repeatedly upload, authorise, execute, or fund a case.
3. Use **Refresh** or **Reconcile** for a pending or unclear result. These
   inspect the existing test; they do not start another one.
4. Record the time, first eight characters of the case reference, release, and
   plain-language message.
5. Do not include names, full account details, balances, ZIP contents,
   passwords, tokens, recovery codes, or authenticator codes.
6. Send the safe note to the administrator through the approved channel.
7. Resume only after the administrator records the resolution.

## About large Sandbox case tests

The small Direct Transfer Test checks the connection only. A broker case uses a
separate Sandbox case limit and the full broker-confirmed test amount. If
Sandbox limits, rejects, or cannot clearly report that amount, keep the result
in the case record. Do not lower the amount yourself and do not run the test
again.

## Weekly administrator checks

**Brokers and operators stop here.** The following work belongs to the
designated administrator:

1. Confirm the scheduled Sandbox monitor completed.
2. Confirm a recent backup set exists and its checks pass.
3. Review unresolved operational-error categories.
4. Confirm the service remains private.
5. Confirm it still connects only to the approved Revolut Sandbox service.
6. Confirm Production mode and public access remain disabled.
7. Complete and record restore drills on the approved schedule.

See [backup and restore](CASE_BACKUP_RESTORE.md) and
[Sandbox deployment](DIGITALOCEAN_DEPLOYMENT.md) for the administrator steps.
