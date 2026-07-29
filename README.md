# Revolut Sandbox case workspace

This private workspace helps an authorised broker review a case, check a test
credit in Revolut Sandbox, prepare the planned test payouts, and keep a signed
record of what happened.

It is a **test-only** workspace. It does not handle live money, turn on a
Production Revolut connection, or let an uploaded file approve a payment. A ZIP file is
only information to review; it is never proof that money arrived.

## If you are working a case

Start with [Start here for brokers and operators](docs/START_HERE.md). You do
not need terminal, API, or technical file-format knowledge to use the normal
browser workflow.

The application also has a side-by-side guide:

1. Open the private operator application.
2. Select **Operator guide ↗**.
3. Keep the guide open beside the application.
4. Search for everyday words such as “upload”, “missing information”,
   “test credit”, “unclear result”, or “download record”.

## The normal broker sequence

Work through the case in this order:

1. Upload the ZIP file exactly as received.
2. Wait for the safety check, then read the file list and any questions.
3. Review what the sender says, what the application found, and your own
   broker notes separately.
4. Record corrections with their reason and supporting record.
5. Check for one matching **Sandbox test credit**.
6. Approve, ask for more information, or reject the case.
7. Read every planned payout, fee, reserve, and refund before approval.
8. Authorise and run the Sandbox test once.
9. Use **Reconcile** to check the final Sandbox result, then download the case
   record.

## Large Sandbox test amounts

The small **Direct owned-account transfer test** is only a connection check.
It has its own small limit and is not part of a broker case.

An approved broker case has a separate Sandbox-only limit. The current USD
test limit is up to USD 1 billion, subject to the private administrator's
settings and Revolut Sandbox's response. The workspace always sends the full
amount confirmed for the case. If Sandbox cannot accept it, the result is kept
as a useful case finding; the workspace never quietly lowers the amount.

## Important safety rules

- Check for the yellow **REVOLUT SANDBOX · NO LIVE DATA** banner before work.
  It confirms the test environment; it does not itself approve use of a client
  case file.
- Use Sandbox accounts only. Client case information may be used only after the
  named pilot data-handling and retention approval is in place. Production
  remains unavailable.
- Upload representative operational files only after the approved retention
  and sensitive-data controls are in place. Never put file contents in email,
  chat, logs, or Git.
- Do not share passwords, authenticator codes, recovery codes, or account
  details.
- Do not create a new test payment when the first result is unclear. Use
  **Refresh** or **Reconcile** and record what Sandbox reports.
- Stop if **Operations** is Blocked or **Backup** is not Fresh.

## Choose the right guide

| I need to… | Read |
| --- | --- |
| Start using the browser workspace | [Start here](docs/START_HERE.md) |
| Work a case from file upload to final result | [Broker case guide](docs/BROKERED_FUNDING_CASES.md) |
| Understand a word or status | [Plain-language glossary](docs/GLOSSARY.md) |
| Complete the daily check | [Daily operations guide](docs/SANDBOX_OPERATIONS_RUNBOOK.md) |
| Use the browser controls | [Sandbox operator console](docs/SANDBOX_OPERATOR_CONSOLE.md) |
| Run the separate technical connection test | [Account transfer test](docs/SANDBOX_ACCOUNT_TRANSFER_TEST_GUIDE.md) |
| Respond to an outage | [Error and outage guide](docs/ERROR_MONITORING_AND_OUTAGE_ROADMAP.md) |
| Restore a backup | [Backup restore drill](docs/CASE_BACKUP_RESTORE.md) |

## For administrators and developers

Daily brokers and operators should not run terminal commands or private APIs.
Administrator references are kept separately:

- [Beginner Linux setup](docs/SANDBOX_SETUP_LINUX_BEGINNER.md)
- [Sandbox deployment](docs/DIGITALOCEAN_DEPLOYMENT.md)
- [System architecture](docs/ARCHITECTURE.md)
- [Implementation status](docs/IMPLEMENTATION_CHECKLIST.md)
- [Production readiness gates](docs/PRODUCTION_READINESS_GUIDE.md)

`docs/business.yml` is a vendor API specification for maintainers and tooling,
not a broker procedure.
