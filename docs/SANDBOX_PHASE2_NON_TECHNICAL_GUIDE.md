# Read the daily Sandbox monitor

**Audience:** a non-technical operator reviewing the automated daily check.

The monitor answers one narrow question: can the private service safely reach
the approved Revolut Sandbox and read the expected test information? It does
not approve a case, move money, or prove readiness for Production.

## Read the result

1. Open the approved daily-check record or operator console.
2. Confirm the record is for today's approved release.
3. Confirm the environment says **Sandbox**.
4. Confirm live data says **false**.
5. Read the final result.

### Green or passed

Record the date, time, release, and **passed**. No further action is required
unless the console shows a separate case, backup, or operations warning.

### Red or failed

1. Do not run a payout or advanced transfer diagnostic.
2. Record the failed step and the safe message.
3. Record the date, time, and release.
4. Contact the administrator through the approved channel.
5. Wait for a recorded recovery before resuming.

Do not keep rerunning the check, change credentials, enable extra permissions,
or switch hosts.

## What the monitor does not do

The monitor does not:

- access live customer or banking data;
- make or authorize a transfer;
- verify a submitted funding package;
- match an incoming credit;
- expose the private application to the internet;
- turn the system into a Production service.

For the complete routine, use [Daily Sandbox operations](SANDBOX_OPERATIONS_RUNBOOK.md).
