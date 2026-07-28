# Revolut Sandbox funding workbench

This application helps one authorized operator review synthetic funding cases,
observe test funds in Revolut Sandbox, approve an exact payout plan, execute the
test payouts, and keep a signed evidence record.

It does **not** handle live money. An uploaded package creates a case for human
review; it never proves that funds arrived and never authorizes a payment.

## Start with the operator guide

If you use the browser application, begin with
[Start here for operators](docs/START_HERE.md).

The application also has a side-by-side HTML guide:

1. Open the operator application.
2. Select **Operator guide ↗**.
3. Keep the new guide window beside the application.
4. Use the search box to find tasks or statuses such as “upload,” “pending,”
   “backup,” or “reconcile.”

## The safe operating sequence

Always complete these steps in order:

1. Upload the private ZIP package to quarantine.
2. Wait for package safety and integrity checks.
3. Compare submitted claims with machine and broker findings.
4. Add corrections only as cited amendments.
5. Independently observe and match the incoming Sandbox credit.
6. Approve, reject, or request information.
7. Review every payout, fee, reserve, and refund.
8. Authorize and execute the exact plan.
9. Reconcile provider results and export signed evidence.

## Choose the right guide

| I need to… | Read |
| --- | --- |
| Use the browser application | [Sandbox operator console](docs/SANDBOX_OPERATOR_CONSOLE.md) |
| Work a funding case | [Funding-case guide](docs/BROKERED_FUNDING_CASES.md) |
| Complete the daily check | [Operations runbook](docs/SANDBOX_OPERATIONS_RUNBOOK.md) |
| Understand a status or term | [Plain-language glossary](docs/GLOSSARY.md) |
| Run the advanced direct-transfer test | [Account transfer test](docs/SANDBOX_ACCOUNT_TRANSFER_TEST_GUIDE.md) |
| Respond to an error | [Error and outage guide](docs/ERROR_MONITORING_AND_OUTAGE_ROADMAP.md) |
| Restore a backup | [Backup restore drill](docs/CASE_BACKUP_RESTORE.md) |
| Set up or deploy the server | [Administrator deployment guide](docs/DIGITALOCEAN_DEPLOYMENT.md) |
| Plan SSH, VPN, HTTPS, or mutual-TLS access | [Remote connection options](docs/REMOTE_CONNECTION_OPTIONS.md) |

## Non-negotiable safety boundaries

- Confirm the yellow **REVOLUT SANDBOX · NO LIVE DATA** banner before work.
- Use only synthetic identities and low-value test amounts.
- Never use or store investor Revolut credentials.
- Never treat package content as independent evidence of settlement.
- Never create a counterparty automatically from uploaded instructions.
- Never retry an authorization or payment with an unclear result.
- Stop when Operations is Blocked or Backup is not Fresh.
- Production mode remains unavailable.

## For administrators and developers

Daily operators should not run terminal commands or call private APIs.
Administrators can use the following references:

- [Beginner Linux setup](docs/SANDBOX_SETUP_LINUX_BEGINNER.md)
- [Sandbox deployment](docs/DIGITALOCEAN_DEPLOYMENT.md)
- [System architecture](docs/ARCHITECTURE.md)
- [ISO 20022 administrator reference](docs/ISO20022_IMPORT.md)
- [Implementation status](docs/IMPLEMENTATION_CHECKLIST.md)
- [Production readiness gates](docs/PRODUCTION_READINESS_GUIDE.md)

`docs/business.yml` is a vendor API specification retained for maintainers and
tooling. It is not an operator guide and should not be edited as a procedure.

Before releasing a change, administrators run:

```text
npm run check
npm run build
npm run test:e2e
```

These are administrator commands, not operator procedures.
