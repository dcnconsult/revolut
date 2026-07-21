# Implementation checklist

## +1 implemented in the scaffold

1. Manual and ISO 20022 inputs normalize into one payment domain model.
2. Multipart XML upload has file, part, element-count, and depth limits.
3. DTD/entity declarations, include elements, non-declaration processing instructions, malformed XML, unsupported namespaces, and invalid UTF-8 are rejected.
4. `pain.001.001.03` and `pain.001.001.09` are parsed with explicit version provenance.
5. Message/payment required fields, transaction counts, exact control sums, IBAN checksums, execution dates, and canonical payment schemas are validated.
6. File and payment identities are deterministic for duplicate handling.
7. Batch preparation aggregates quoted debits by source account and currency before comparing available funds.
8. Imported payments are prepared but never automatically submitted.
9. Submission re-quotes and rechecks funds before calling the provider.
10. Unit and HTTP tests cover valid `.03`/`.09` imports, unsafe XML rejection, deterministic duplicates, and aggregate-funds failure.

## 0 diagnostic integration work

1. Add version-pinned official ISO XSD validation and applicable EPC/bank Schematron/business-rule validation, with all schemas local and network resolution disabled.
2. Build the user interface: manual entry, drag/drop XML upload, preview table, field-level issues, source-account mapping, duplicate indicators, totals, approval, and completion timeline.
3. Add the Revolut provider adapter and centralized X.509/OAuth token manager.
4. Resolve/create counterparties and beneficiary accounts from normalized payment data, then call `/pay/fields` for each corridor.
5. Query Revolut accounts and verify every XML debtor account maps to an account owned by the authenticated business and supports the payment currency.
6. Replace in-memory storage with PostgreSQL, unique constraints, immutable audit events, import provenance, and transactional batch writes.
7. Add concurrency-safe funds reservations or account/currency locks across manual and file-originated payments.
8. Add role-based approval and dual control above configurable thresholds; approvals must be bound to a request digest so edits invalidate approval.
9. Add sanctions/AML policy hooks appropriate to the business, counterparties, corridors, and jurisdictions.
10. Add webhook v2 authentication, replay protection, event idempotency, and failed-event recovery.
11. Add polling fallback, pending-payment SLA alerts, and daily provider-to-ledger reconciliation.
12. Add corridor fixtures for EUR/SEPA, CHF, GBP, USD/SWIFT, and specific bank requirements.
13. Add encrypted original-file retention/quarantine, malware scanning if policy requires it, redacted logging, and data-retention/deletion controls.
14. Add OpenAPI schemas, authentication/authorization middleware, rate limits, request IDs, and operator audit views.
15. Run Revolut sandbox contract tests, including counterparty resolution, dynamic fields, balances, quotes, transfer submission, status transitions, and expected failures.

## -1 production blockers

1. Do not treat syntax/semantic parsing as official ISO/EPC conformance while `officialXsd` is false.
2. Do not treat a caller-supplied source-account UUID as proof that the XML debtor account belongs to the business.
3. Do not treat an available-balance response as a reservation of funds.
4. Do not treat sandbox beneficiary-name results as production VoP/CoP evidence.
5. Do not submit a file automatically on upload or after validation.
6. Do not enable live-money submission without durable idempotency, transactional controls, approvals, authenticated completion follow-up, and a tested rollback/incident procedure.
7. Do not store the X.509 private key, refresh token, access token, production XML, or populated `.env` values in GitHub.
