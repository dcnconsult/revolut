# Plain-language glossary

**Audience:** anyone using or supporting the Sandbox application.

| Term | Plain meaning |
| --- | --- |
| Amendment | A dated correction that leaves the original claim visible. |
| Approval | A human authorization tied to one exact plan and risk snapshot. |
| Artifact | A file contained in or associated with a submitted package. |
| Audit chain | A sequence of records linked so later changes can be detected. |
| Case | The complete review record for one funding request. |
| Claim | Something the sender says is true. A claim is not proof. |
| Counterparty | A payment recipient already verified in Revolut Sandbox. |
| Digest | A fingerprint used to prove content has not changed. |
| Evidence | A cited record used to support or correct a claim. |
| Finding | A problem, warning, or passed check produced during review. |
| Funding plan | The exact payouts, fees, reserve, and refund tied to one receipt. |
| Hard block | A problem that must be resolved by evidence or rejection. It cannot be accepted as risk. |
| Matched funding | Exactly one provider credit matches the expected account, currency, amount, and reference. |
| MFA | A second sign-in proof, normally a six-digit authenticator code. |
| Provider observation | Transaction information independently read from Revolut Sandbox. |
| Quarantine | Safe holding area used before a package passes scanning and validation. |
| Reconcile | Ask the provider for the latest result and compare it with the case. |
| Recovery code | A one-time emergency substitute for the authenticator code. |
| Reserve | An explicit amount retained rather than paid immediately. |
| Sandbox | A test environment with no live money or live customer data. |
| Signed evidence bundle | The downloadable case history with a signature that allows verification. |
| Submission | One version of an uploaded case package. |

## Common status meanings

| Status | Meaning | Operator action |
| --- | --- | --- |
| Quarantined | Safety scanning has not cleared the package. | Wait; do not open files. |
| Intake Hold | Important package or evidence problems exist. | Read “what is needed next.” |
| Awaiting Broker | The case is ready for human review. | Review claims and evidence. |
| Information Required | More evidence is needed. | Request and cite new evidence. |
| Approved | The human decision passed current checks. | Review the exact funding plan. |
| Awaiting Funds | No matching credit has been observed. | Refresh only when permitted. |
| Possible Match | More than one credit may match. | Stop and investigate. |
| Matched | Exactly one credit matches. | Continue if all other checks pass. |
| Reversed | Previously matched funding no longer qualifies. | Stop; authorization is invalid. |
| Awaiting Authorization | A plan exists but is not authorized. | Review every plan line. |
| Authorized | The exact current plan may be executed after fresh confirmation. | Recheck and execute once. |
| Partial | Some payouts completed and others did not. | Do not retry; reconcile and escalate. |
| Blocked | Execution cannot safely continue. | Stop and escalate. |
| Reconciled | All submitted payouts have confirmed final results. | Export evidence and close. |
| Failed | The operation did not complete safely. | Stop and escalate. |
