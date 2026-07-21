# Architecture and promotion gates

## Entry paths

The system has two interchangeable ingestion paths:

- manual JSON input through `POST /v1/payments/prepare`;
- ISO 20022 XML input through `POST /v1/payment-imports/iso20022/validate` and `/prepare`.

Both paths normalize into the same `PaymentRequest` and enter the same orchestration, provider, state, audit, and completion logic. ISO parsing is input machinery, not a second payment engine.

## Known inputs

Manual or XML-sourced values include the selected source account, amount and currency, beneficiary identity and bank coordinates, reference, execution date, purpose/charge data, and a unique client reference.

For an XML import, additional known inputs are the file bytes, filename, SHA-256 digest, ISO namespace/message version, message ID, payment-information ID, transaction index, debtor account identifier, and the explicit debtor-account-to-Revolut-account selection.

## Observed signals

- Parser observations: byte size, UTF-8 validity, XML syntax, namespace, element/depth limits, transaction counts, control sums, required message fields, normalized payment fields, and deterministic file digest.
- Provider observations: corridor field requirements, beneficiary-name response, available balance, quote and fees, submission response, transaction state, webhook signature, and event identity.
- Persistence observations: existing client reference, provider transaction identity, approval record, import record, and immutable state transitions.

## Target output

Exactly one authorized bank transfer per unique canonical payment request, with a traceable terminal outcome: `completed`, `failed`, `reverted`, or `declined`.

An uploaded file may describe many payments, but it does not authorize or submit them merely by being uploaded.

## Canonical state machine

`draft -> validated -> funds_confirmed -> submitted|pending -> completed|failed|reverted|declined`

`manual_review` is a hold state for close beneficiary matches, unavailable validation, policy flags, quote/funds drift, or approval requirements.

## ISO 20022 validation layers

1. **Transport:** one multipart file, permitted MIME type, configured byte/part limits.
2. **Parser safety:** UTF-8, no DTD/entity declarations, no processing instructions beyond the XML declaration, no include elements, no prefixed element profile, configured element/depth limits.
3. **XML syntax:** well-formed XML.
4. **Message profile:** supported default namespace and expected `Document/CstmrCdtTrfInitn` structure.
5. **Document integrity:** required group and payment-information headers, transaction-count reconciliation, exact control-sum reconciliation, supported `TRF` method, configured batch limit.
6. **Payment semantics:** amount/currency, beneficiary identity, bank coordinates, IBAN checksum, execution date, reference, address policy, and source-account selection.
7. **Canonical schema:** normalized `PaymentRequest` validation.
8. **Provider orchestration:** required-field discovery, beneficiary validation, quote, and aggregate available-funds check.

Layer 4 is not official XSD validation. Production must add version-pinned official XSD plus the relevant EPC/bank implementation constraints without permitting network schema resolution.

## Batch behavior

Atomic mode is the default. Any transaction-level validation or preparation failure rejects all new candidates in that import. Document-integrity errors reject the file regardless of atomic mode.

Partial mode is diagnostic/product machinery for cases where operations policy permits valid rows to continue. It does not relax file-integrity checks.

Available funds are verified by grouping prepared candidates by source account and currency, then comparing the aggregate provider debit including quoted fees against the observed available balance. This closes the obvious per-row overcommit error, but it is still a snapshot rather than a reservation. Production needs transactional reservation/locking across concurrent imports and manual payments.

## Idempotency and provenance

- `importId` derives from the full uploaded-file SHA-256 digest.
- Each imported payment receives deterministic ingestion provenance.
- `clientReference` derives from stable message and payment attributes.
- An identical existing request is returned as `existing`.
- Reuse of a client reference for a different request is rejected.
- Production storage must enforce uniqueness rather than relying on an in-memory process.

## Source-account trust boundary

The XML debtor account is not automatically treated as a Revolut account ID. The caller must either:

- provide `sourceAccountMap`, mapping each debtor account identifier to a Revolut account UUID; or
- provide a default source-account override, which is accepted with a warning in this scaffold.

Production must query the authenticated business's Revolut accounts, verify ownership and currency, persist the approved mapping, and reject mismatches. This is the control that preserves direct bank-to-bank use and prevents an XML file from selecting an unverified funding account.

## Control gates

- **-1 park/falsify:** malformed or unsafe XML, unsupported message profile, count/control-sum mismatch, unresolved debtor account, invalid beneficiary details, unsupported corridor, no name match, inadequate aggregate funds, invalid webhook signature, conflicting idempotency record, or failed source-account ownership match.
- **0 diagnose:** legacy `.03` file, inferred beneficiary type/country, close name match, validation unavailable, partial-import request, quote drift, stale balance, pending beyond SLA, or sandbox-only result.
- **+1 promote:** required fields satisfied, approved source-account mapping, policy and approval checks pass, aggregate funds cover amount plus fees, unique persistent references, provider accepted the authorized submission, and terminal state reconciled from authenticated provider observations.

## Trust boundaries

- Browser/UI never receives Revolut private keys, refresh tokens, or provider access tokens.
- Uploading/parsing does not equal authorizing/submitting.
- Server signs short-lived client assertions using a private key stored outside Git.
- Webhooks are authenticated and replay-protected before state changes.
- Production storage enforces unique `client_reference`, `provider_transaction_id`, and appropriate import/payment identity constraints.
- The original XML must be retained only under an explicit encrypted retention policy; logs should store a digest and redacted metadata, not full bank coordinates.

## Provider adapter work

Implement `RevolutBusinessProvider` against the currently documented endpoints for accounts, `/pay/fields`, beneficiary/counterparty resolution, quotation, `/pay`, transaction retrieval, account-name validation, OAuth token refresh, and v2 webhooks. Keep provider payload mapping inside the adapter.

The adapter must discover corridor-specific fields at runtime. The normalized ISO document is an input source; it is not evidence that every provider-required field is present.
