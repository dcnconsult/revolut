# Daily Sandbox operations

**Audience:** the person checking the private operator console each working day.

This runbook confirms that the test service is healthy. It never authorizes
live access or a payment.

## Normal result

The application is ready for ordinary review when all of these are true:

- the yellow banner says **REVOLUT SANDBOX · NO LIVE DATA**;
- **Operations** is **Clear**;
- **Backup** is **Fresh**;
- the latest scheduled check passed;
- there is no unexplained **Partial**, **Blocked**, **Failed**, or **Reversed**
  case;
- the release identifier matches the approved release record.

## Daily check

1. Open the private console and sign in.
2. Confirm the Sandbox banner.
3. Read the **Operations** card.
4. Read the **Backup** card.
5. Refresh the funding case inbox.
6. Review cases needing attention.
7. Review **Recent Sandbox activity** for pending or failed items.
8. Review **Consolidated operational report** for unresolved errors.
9. Record the date, time, your name, release, and pass/fail result.

If everything is normal, no further action is required.

## What each Operations state means

| State | Meaning | Operator action |
|---|---|---|
| Clear | No unresolved operational error | Continue normal review |
| Degraded | A warning or retryable problem exists | Pause execution and review the safe report |
| Blocked | A critical or non-retryable problem exists | Stop execution and contact the administrator |
| Unavailable | The report could not be loaded | Treat as blocked |

## What transfer and execution states mean

| State | Meaning | Operator action |
|---|---|---|
| Prepared / Draft | Checked but not submitted | Review or allow it to expire |
| Authorized | Bound to one exact plan | Execute only after a final review |
| Queued / Submitted | Sent or awaiting provider result | Reconcile; do not resubmit |
| Pending | Provider has not given a final result | Wait and reconcile |
| Partial | An earlier payout was submitted and later work stopped | Stop and escalate |
| Reconciled / Completed | Final result has been observed | Export evidence |
| Blocked / Failed | Processing cannot safely continue | Stop and escalate |
| Reverted / Declined | Provider did not complete the payout | Stop and reconcile |

## Respond to a problem

1. Stop the current action.
2. Do not retry an upload, authorization, execution, or transfer repeatedly.
3. Record the time, case reference or redacted transfer reference, release, and
   exact plain-language message.
4. Check whether the application labels the condition retryable.
5. If a case is pending or ambiguous, use **Reconcile** rather than creating a
   new request.
6. Send the safe record to the administrator through the approved channel.
7. Resume only after the administrator records resolution.

Never include names, full account details, balances, package contents,
passwords, tokens, cookies, recovery codes, or authenticator codes.

## Weekly administrator checks

**Operators stop here.** The remaining work belongs to the designated
administrator:

1. Confirm the scheduled Sandbox monitor completed.
2. Confirm a recent backup set exists and its hashes verify.
3. Review unresolved operational-error categories.
4. Confirm the service still binds only to loopback.
5. Confirm the provider host is the pinned Revolut Sandbox host.
6. Confirm Production mode and public ingress remain disabled.
7. Perform and record restore drills on the approved schedule.

See [check backups and perform a restore drill](CASE_BACKUP_RESTORE.md) and
[DigitalOcean deployment](DIGITALOCEAN_DEPLOYMENT.md).
