# ISO 20022 payment import

## Purpose

This module adds file ingestion as an alternate input path to manual payment entry. It is parser and normalization machinery. The payment engine, funds checks, authorization, submission, and completion follow-up remain shared.

Supported namespaces:

- `urn:iso:std:iso:20022:tech:xsd:pain.001.001.09`
- `urn:iso:std:iso:20022:tech:xsd:pain.001.001.03`

Only canonical default-namespace documents are accepted by this profile. Namespace-prefixed elements are rejected to keep the initial parser surface narrow and auditable.

## API

### Validate

`POST /v1/payment-imports/iso20022/validate`

Multipart fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `file` | yes | One UTF-8 XML file |
| `sourceAccountId` | conditional | Default Revolut account UUID applied when no map entry exists |
| `defaultSourceAccountId` | conditional | Alias of `sourceAccountId` |
| `sourceAccountMap` | conditional | JSON object mapping XML debtor account identifiers to Revolut account UUIDs |
| `atomic` | no | Parsed for API consistency; preparation uses it, validation only previews |

The response includes file digest/provenance, message metadata, document issues, transaction candidates, normalized `PaymentRequest` values, and validation flags. No payment record is written.

### Prepare

`POST /v1/payment-imports/iso20022/prepare`

Uses the same multipart fields. It validates the file and then invokes the same provider-facing preparation workflow used by manual entry.

Response status:

- `201` when all candidates are prepared or deterministically found as existing;
- `207` when partial mode produces a mixture of prepared/existing and rejected items;
- `422` when nothing can be prepared;
- `400`, `413`, or `415` for malformed upload envelopes, configured size limits, or unsupported media/encoding.

Preparation does not call the transfer-submission endpoint.

## Field mapping

| ISO 20022 path | Canonical field |
| --- | --- |
| `GrpHdr/MsgId` | ingestion message ID and deterministic reference input |
| `PmtInf/PmtInfId` | ingestion payment-information ID |
| `PmtInf/DbtrAcct/Id` | debtor-account identifier used for source-account resolution |
| `PmtInf/ReqdExctnDt` | `requestedExecutionDate` |
| `CdtTrfTxInf/PmtId/InstrId` | provenance and deterministic reference input |
| `CdtTrfTxInf/PmtId/EndToEndId` | required provenance and reference fallback |
| `CdtTrfTxInf/Amt/InstdAmt` | exact amount and currency, converted to integer minor units |
| `CdtTrfTxInf/Cdtr/Nm` | beneficiary legal name |
| `CdtTrfTxInf/Cdtr/PstlAdr` | normalized beneficiary address when sufficient structured/hybrid fields exist |
| `CdtTrfTxInf/CdtrAcct/Id/IBAN` | beneficiary IBAN |
| `CdtTrfTxInf/CdtrAcct/Id/Othr/Id` | beneficiary account number for supported non-IBAN profile |
| `CdtTrfTxInf/CdtrAgt/FinInstnId/BICFI` or `BIC` | beneficiary BIC |
| `ClrSysMmbId/MmbId` | six-digit UK sort code when used with non-IBAN account number |
| `RmtInf/Ustrd` or structured creditor reference | payment reference |
| `Purp` / category purpose | `purposeCode` |
| `ChrgBr` | `shared`, `sender`, or `recipient` where mapping is supported |

The initial canonical payment model requires the payment and beneficiary currencies to match. Currency conversion and multi-leg FX must be explicit provider/product workflows, not inferred from a file.

## Integrity and rejection rules

Document-level errors include unsafe XML, unsupported namespace/message shape, missing required headers, unsupported payment method, count mismatch, control-sum mismatch, and configured transaction-limit breaches. They prevent any preparation.

Transaction-level errors include unresolved source account, invalid amount/currency, invalid IBAN, unsupported account coordinates, missing beneficiary identity, country conflicts, past execution date, unsupported charge-bearer value, and canonical schema failure.

Warnings preserve observability without silently changing intent. Examples include legacy `.03`, inferred beneficiary type, country derived from IBAN, default source-account override, duplicate identifiers, and an unstructured SEPA address before its configured cutoff.

## Duplicate behavior

The full file SHA-256 digest creates a stable import ID. Each normalized payment gets a deterministic client reference. Reimporting the same request returns the existing payment. A reused reference attached to different payment data is rejected as an idempotency conflict.

The in-memory implementation demonstrates behavior but is not durable. Production must enforce these identities with database unique constraints and transaction boundaries.

## Funds behavior

The orchestrator obtains a quote for every candidate, groups quoted debit amounts by source account and currency, and compares each group total with the observed available balance. It records the balance, aggregate debit, individual debit, and check time.

This prevents a single batch from passing only because each row was checked independently. It does not reserve funds and cannot protect against concurrent applications or later account activity. Submission therefore re-quotes and rechecks the individual payment; production additionally needs concurrency control or a reservation ledger.

## Address transition

For EUR/SEPA transactions, an unstructured-only creditor address generates a warning before `ISO20022_STRUCTURED_ADDRESS_CUTOFF` and an error on or after it. The default is `2026-11-15`. The policy should be kept versioned against the applicable payment-scheme implementation guidelines.

## Security profile

The upload path rejects DTD/entity declarations, include elements, unexpected processing instructions, invalid UTF-8, NUL bytes, excessive size, excessive element count, and excessive nesting depth. It never resolves external schemas or network resources.

Do not log complete XML bodies or bank coordinates. Store the file digest and normalized/audited facts by default. Where original-file retention is legally or operationally required, encrypt it, apply access controls and retention limits, and keep it outside ordinary application logs.

## Production promotion criteria

Promote the import path only after all of these observations survive controls:

1. official version-pinned XSD and applicable scheme/bank rules pass;
2. each debtor account is reconciled to an authenticated, business-owned Revolut account;
3. every required provider field is discovered and populated;
4. beneficiary and compliance outcomes satisfy policy;
5. persistent idempotency and batch transactions survive retry/concurrency tests;
6. approvals bind to an immutable payment digest;
7. provider submission returns an identity and initial state;
8. authenticated webhook/polling observations reconcile to a terminal outcome;
9. ledger totals and provider transactions reconcile without unexplained residuals.
