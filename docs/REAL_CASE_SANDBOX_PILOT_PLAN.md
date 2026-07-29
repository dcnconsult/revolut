# Real-case, high-value Sandbox pilot plan

**Status:** Approved plan; first engineering slice delivered locally, external pilot gate remains
**Date:** July 28, 2026
**Environment:** Revolut Business Sandbox only
**Audience:** product owner, developer, and the designated broker/operator

## Executive decision

The next phase will let the broker upload representative ZIP packages received
in the ordinary course of business, review the extracted transaction details,
resolve exceptions, and attempt the transaction through the complete Revolut
Sandbox workflow.

The expected transaction values are tens to hundreds of millions of dollars.
For real-case testing, the application should attempt the full declared amount
in Sandbox whenever the operator confirms it. The current low transfer ceiling
must not constrain the case workflow.

High-value provider limits, balance constraints, validation responses,
rejections, pending states, and other Sandbox behavior are useful test results.
They must be recorded as case findings rather than hidden by an artificial
application cap or silently scaled transaction.

This decision does not enable Production mode, public access, or live funds.

## Delivery update — July 28, 2026

The code-related first implementation slice in this plan is now present in the
local working tree and has passed local verification. This is an implementation
update, not permission to upload a client ZIP, deploy the change, or perform an
external Sandbox test.

Delivered locally:

- separate small direct-test and broker-case Sandbox limits, with an initial
  USD case ceiling up to USD 1 billion;
- safe diagnostic intake for a clean unfamiliar ZIP, including a safe file list
  and clear questions;
- broker review, recorded corrections, request-information, and rejection
  controls;
- exact full-confirmed-amount Sandbox test-credit matching and plan checks;
- useful, redacted findings for high-value Sandbox responses; and
- durable one-time execution and reconciliation safeguards that do not lower or
  automatically repeat an unclear test.

Still required before the pilot starts:

- named approval for sensitive-data handling, retention, access, and the
  private transfer channel;
- approved representative client case ZIPs; and
- named broker/owner authorization for each external Sandbox test.

For the broker-facing procedure, use [Start here](START_HERE.md) and
[Work a Sandbox case](BROKERED_FUNDING_CASES.md). This document remains the
technical plan and acceptance record.

## Deployed baseline when this plan was approved

This records the deployment available at planning time. Verify the actual
release before acting; the local delivery update above does not imply that the
deployed environment has changed.

The current deployed release is:

```text
6d9e9f8b79ff4a4cab3e032e9746b22d350c10a9
```

It provides:

- a loopback-only application reached through the private Mint SSH launcher;
- Revolut Business Sandbox internal-account connectivity;
- encrypted original-package and case-evidence storage;
- malware quarantine and conservative ZIP validation;
- separate case, funding, and execution states;
- administrator authentication, CSRF protection, password reauthentication,
  and fresh MFA for authorization and execution;
- a guided controlled Sandbox walkthrough;
- exact plan digests, stable provider request identifiers, reconciliation, and
  signed evidence export;
- matched database-and-evidence backups and rollback-capable releases.

Current intake recognizes two profiles:

1. strict `brokered-funding/1.0`; and
2. the known legacy asset-declaration training profile.

At plan approval, most unfamiliar client packages collapsed into a generic
`PACKAGE_VALIDATION_FAILED` intake hold and the controlled walkthrough inherited
the low direct-transfer test ceiling. The local first slice now addresses those
implementation limitations. It has not processed an external client ZIP or run
an external high-value Sandbox test.

## Goals

1. Accept unfamiliar but safe ZIP packages for diagnostic review.
2. Preserve the exact original package before interpretation.
3. Identify recurring package families without weakening strict validation.
4. Extract candidate transaction facts with explicit provenance.
5. Give the broker a simple interface to confirm, correct, or reject facts.
6. Turn missing, conflicting, or unsupported information into specific
   broker-language exceptions.
7. Attempt the full confirmed transaction value in Revolut Sandbox.
8. Record provider behavior as evidence, including high-value rejection or
   limits.
9. Reconcile every submitted Sandbox transaction to a final or clearly
   escalated state.
10. Build a reusable exception and format catalog from real operating cases.

## Non-goals

This phase will not:

- enable Revolut Production endpoints;
- touch live funds;
- expose the application publicly;
- allow an uploaded package to authorize a transaction by itself;
- automatically trust bank accounts, counterparties, wallet claims, compliance
  statements, or payout instructions found in a ZIP;
- silently change a submitted amount to make a transaction pass;
- add real client packages or unredacted personal information to Git;
- automatically create a new external counterparty from package contents; or
- remove human approval, reauthentication, MFA, idempotency, reconciliation, or
  evidence requirements.

## Core design principle

Diagnostic acceptance and transaction readiness are separate decisions.

```text
safe to store and inspect
    does not mean
complete, verified, approved, or authorized to execute
```

The strict `brokered-funding/1.0` validator remains the transaction-ready
contract. A separate compatibility intake path will handle unfamiliar ZIPs and
produce a reviewable case.

## Target broker workflow

1. The broker opens the private Mint launcher and signs in.
2. The broker uploads the ZIP exactly as received.
3. The application stores the original encrypted package and assigns a case
   reference.
4. The private malware scanner completes before any artifact is interpreted.
5. The application shows a safe file list: filenames, types, sizes, hashes, and
   safe structural metadata.
6. The package-profile classifier identifies a known adapter or selects the
   generic compatibility profile.
7. The application extracts possible case details and shows their source.
8. The broker reviews:
   - submitted case details;
   - automatic check results;
   - broker findings;
   - missing information;
   - conflicts; and
   - what is needed next.
9. The broker confirms or records corrections to investor, beneficiary, authority, amount,
   currency, incoming-funding expectation, payout allocation, reference, and
   purpose.
10. The application creates or observes a clearly labelled Sandbox funding
    transaction for the full confirmed amount.
11. The broker matches the exact Sandbox funding result.
12. The broker approves or rejects the case.
13. The application creates an exactly balanced funding plan.
14. The broker reviews the amount, currency, source, destination, plan version,
    digest, and current risk state.
15. The broker reauthenticates with a password and fresh MFA to authorize.
16. The broker reauthenticates again to execute once.
17. The application reconciles the provider result.
18. The broker downloads the signed evidence bundle.
19. The package profile, exceptions, corrections, provider responses, elapsed
    time, and support required are added to the pilot results.

## High-value Sandbox transaction policy

### Separate the two ceilings

The existing direct-transfer diagnostic tool should retain its small safety
ceiling. It is a connection test and is not the real-case workflow.

The case workflow will use a separate Sandbox-only high-value policy:

- proposed configurable maximum: the equivalent of USD 1 billion per case;
- expected pilot range: USD 10 million through USD 500 million;
- full configured precision for the transaction currency;
- amount stored and balanced in integer minor units;
- no floating-point comparison for accounting or plan equality;
- explicit validation against integer overflow and provider serialization
  limits; and
- no effect outside `REVOLUT_MODE=sandbox`.

The final ceiling should be configurable without a code release and should
support per-currency limits if provider behavior differs by currency.

### Full-value attempt is the default

After operator confirmation, the Sandbox plan should use the full declared
amount. If the provider accepts the amount, the normal workflow continues.

If the provider rejects or constrains the amount:

1. preserve the exact request and redacted provider response;
2. mark the execution as blocked or failed, as appropriate;
3. create a specific provider finding;
4. show the broker the provider-language and broker-language explanation;
5. do not silently retry with a smaller amount;
6. permit a separately documented amended test only after the original result
   is retained; and
7. use a new plan version, authorization, and idempotency identity for any
   amended attempt.

### Sandbox funding

For a case that expects an incoming credit, the system should create or observe
a clearly labelled Sandbox funding transaction at the full confirmed amount
before the payout plan is approved.

The label must identify:

- Sandbox simulation;
- case reference;
- submission identity; and
- test purpose.

The case package is never evidence that Sandbox funding arrived. The funding
state changes only from a provider observation.

### Provider limits are findings

Add findings for at least:

- `SANDBOX_TOPUP_LIMIT_REACHED`;
- `SANDBOX_BALANCE_INSUFFICIENT`;
- `PROVIDER_HIGH_VALUE_REJECTED`;
- `PROVIDER_AMOUNT_LIMIT_UNKNOWN`;
- `PROVIDER_CURRENCY_LIMIT`;
- `PROVIDER_PENDING_BEYOND_TEST_WINDOW`;
- `PROVIDER_RESPONSE_AMBIGUOUS`;
- `PROVIDER_TRANSACTION_REVERSED`; and
- `PROVIDER_RECONCILIATION_MISMATCH`.

These findings should include a safe explanation, the needed next action, and
redacted evidence references.

## Diagnostic ZIP intake

### Preserve conservative archive safety

Continue enforcing:

- ZIP signature and structure checks;
- configured compressed and uncompressed byte limits;
- entry-count, path-depth, and compression-ratio limits;
- path normalization and traversal prevention;
- duplicate normalized-path rejection;
- encrypted original-package storage;
- private malware scanning; and
- no artifact parsing before a clean scan.

### Do not collapse all failures

Replace the generic intake failure where possible with stable findings:

- `ARCHIVE_NOT_ZIP`;
- `ARCHIVE_STRUCTURE_INVALID`;
- `ARCHIVE_LIMIT_EXCEEDED`;
- `ARCHIVE_PATH_UNSAFE`;
- `ARCHIVE_DUPLICATE_PATH`;
- `ARCHIVE_COMPRESSION_RATIO_EXCEEDED`;
- `MANIFEST_MISSING`;
- `MANIFEST_PARSE_FAILED`;
- `MANIFEST_INVENTORY_MISMATCH`;
- `UNSUPPORTED_PACKAGE_PROFILE`;
- `UNSUPPORTED_ARTIFACT_TYPE`;
- `ARTIFACT_PARSE_FAILED`; and
- `REQUIRED_TRANSACTION_FIELD_NOT_FOUND`.

Unsafe archives remain rejected or quarantined. Safe but unknown archives
become diagnostic cases in `INTAKE_HOLD`.

### Package-profile registry

Create a registry with:

- a stable profile identifier and version;
- recognition rules based on safe structure and content signatures;
- the list of expected and optional artifacts;
- field extractors;
- field-level validation;
- exception mappings;
- redaction rules;
- test fixtures; and
- an explicit confidence level.

The registry must always include a generic fallback that inventories the
package without pretending to understand it.

Do not create one-off conditionals for individual client files. Promote a new
adapter only when a repeatable package family is identified.

## Candidate transaction model

Every extracted value must carry provenance:

- artifact path;
- artifact SHA-256;
- structural location, such as JSON path, XML path, CSV row, or PDF page;
- extraction method;
- raw submitted representation where safe;
- normalized value;
- confidence or confirmation state;
- operator amendment, if any; and
- supporting evidence references.

Candidate fields include:

- submission and external case identifiers;
- investor or sender identity;
- end business and beneficiary identity;
- authority and scope;
- source-of-funds assertions;
- amount, currency, and exponent;
- expected incoming reference and account;
- payout allocations;
- fees, reserve, and refund;
- payout method and verified destination;
- transaction purpose;
- requested execution date; and
- package-specific compliance evidence.

No low-confidence extracted value should become an executable plan input until
the operator confirms or corrects it.

## General case-review interface

The controlled walkthrough should become one option inside a general case
detail view.

The screen should show:

1. package health and profile;
2. artifact inventory;
3. submitted and extracted claims;
4. machine findings;
5. broker findings;
6. funding expectation and observations;
7. amendments and resolved findings;
8. decision history;
9. plan versions and exact balance;
10. authorization state;
11. execution attempts;
12. reconciliation status; and
13. signed evidence download.

Administrator actions:

- confirm a candidate value;
- correct a value with a reason and evidence;
- mark a field not applicable;
- add a broker finding;
- request specific information;
- reject the case;
- refresh or create Sandbox funding;
- approve the case;
- create a plan;
- authorize and execute; and
- reconcile and export.

The broker should not need to enter JSON, hashes, provider identifiers, or
internal state codes.

## Accelerated single-user pilot

The pilot can move quickly because there is one designated operator, but the
state and authorization controls remain unchanged.

### Wave 1: first five packages

For each package:

1. upload and scan;
2. inventory and classify;
3. extract available values;
4. record all exceptions;
5. have the broker confirm or amend the case;
6. attempt full-value Sandbox funding and execution when minimum fields are
   confirmed;
7. reconcile or record the provider limitation; and
8. hold a short review immediately after the case.

There is no artificial intake-only waiting period. A sufficiently reviewable
case may proceed through Sandbox during the same session.

### Wave 2: next ten to twenty packages

- group recurring package structures;
- implement the first repeatable adapters;
- automate repeated low-risk field extraction;
- retain broker confirmation for material facts;
- improve exception wording; and
- measure how much remote support is still required.

### Wave 3: ongoing operating sample

- run new package families through the generic intake path;
- compare recurring exceptions by sender and profile;
- promote stable adapters;
- expand regression coverage using approved synthetic or rigorously redacted
  fixtures; and
- produce a readiness report for the next environment gate.

## Pilot data capture

Record for each package:

- case and submission references;
- received package profile;
- whether sensitive data is present;
- scan and intake result;
- extracted and confirmed fields;
- exception codes;
- broker amendments;
- requested missing information;
- full declared amount and currency;
- Sandbox funding result;
- Sandbox execution result;
- provider limitation or rejection;
- reconciliation result;
- elapsed time by workflow stage;
- operator clicks or corrections;
- remote-support time;
- repeated format or exception group; and
- recommended product, rule, adapter, or documentation change.

## Sensitive-data and retention boundary

The pilot may use representative operational packages only after confirming
that the current private environment and retention policy are approved for
their contents.

Required controls:

- use the private SSH-tunnel application, not email or a public upload link;
- preserve encrypted evidence at rest;
- restrict administrator access to the designated operator and maintainer;
- retain only for the approved pilot period;
- include packages in matched backups under the same retention policy;
- keep package contents out of application logs;
- keep real packages, extracted personal data, and provider responses out of
  Git;
- create test fixtures only from synthetic data or reviewed,
  irreversibly-redacted examples; and
- document deletion of expired pilot cases and matched backup material before
  implementing automated purge.

## Concurrency and idempotency

The broker may upload and review multiple cases, but high-value execution
should be serialized during the pilot.

Controls:

- one execution attempt per plan version and allocation;
- stable provider request identifiers;
- duplicate package and duplicate submission detection;
- no double-click resubmission;
- no automatic retry after an ambiguous provider response;
- case-level execution lock;
- authorization invalidated by material amendments;
- new authorization for every plan version; and
- reconciliation before a replacement attempt.

## Implementation workstreams

### Workstream A: diagnostic intake

- introduce typed intake errors and granular findings;
- retain a safe artifact inventory after a clean scan;
- add the generic package profile;
- add package fingerprinting;
- preserve existing strict-v1 behavior; and
- expose profile and artifact inventory in the case API.

### Workstream B: extraction and normalization

- define candidate fields and provenance;
- add adapter interfaces;
- implement safe JSON, XML, CSV, and selected PDF metadata extraction;
- prevent artifact parsers from resolving external resources;
- add conflict detection; and
- require operator confirmation for material values.

### Workstream C: broker case review

- build the general case-detail screen;
- expose existing review, amendment, and decision APIs;
- add request-information and reject paths;
- show plain-language findings and needed-next actions;
- show original versus amended values; and
- provide a format/exception feedback action.

### Workstream D: high-value Sandbox workflow

- separate the direct diagnostic ceiling from the case ceiling;
- add a Sandbox-only high-value configuration;
- test amounts through at least USD 1 billion equivalent;
- use integer minor-unit arithmetic end to end;
- simulate or observe full-value funding;
- build an exact full-value plan;
- preserve reauthentication, MFA, digest, and idempotency controls;
- record provider high-value responses as findings; and
- prohibit silent amount reduction or automatic retry.

### Workstream E: reporting and learning

- create an exception catalog;
- group cases by package fingerprint and sender profile;
- export a redacted pilot summary;
- report stage time and support time;
- identify adapter candidates;
- maintain a decision log for rule changes; and
- turn approved synthetic/redacted examples into regression fixtures.

## Prioritized backlog

### P0: engineering slice delivered locally; external authorization still required

The code-related items below are implemented and locally verified. Item 1 is
an external gate and remains required before the first representative client
case or external Sandbox test.

1. Confirm sensitive-data authorization and pilot retention.
2. Split the direct diagnostic ceiling from the case execution ceiling.
3. Add the Sandbox-only high-value amount configuration.
4. Add boundary tests for USD 10 million, 100 million, 500 million, and
   1 billion.
5. Add granular archive and unsupported-profile findings.
6. Preserve and expose the clean artifact inventory.
7. Add the generic compatibility case profile.
8. Add a general case-detail screen.
9. Expose broker review, amendment, request-information, and reject actions.
10. Record full-value provider failures as findings.
11. Verify backup and evidence export with a high-value case.

### P1: required during the first five cases

1. Candidate-field and provenance model.
2. JSON, XML, and CSV extraction adapters.
3. Operator confirmation controls.
4. Conflict and ambiguity findings.
5. Full-value Sandbox funding creation and matching.
6. Serialized case execution lock.
7. Exception feedback and pilot metrics.
8. First recurring package-family adapter.

### P2: after patterns emerge

1. Selected PDF text/table extraction under strict limits.
2. Additional recurring package adapters.
3. Exception trend dashboard.
4. Package-profile administration and versioning.
5. Redacted pilot-report export.
6. Approved retention and deletion automation.

## Test plan

### Unit tests

- amounts at USD 10 million, 100 million, 500 million, and 1 billion;
- currencies with zero, two, and three decimal exponents;
- exact plan balance at high minor-unit values;
- safe-integer and serialization boundaries;
- duplicate submissions;
- typed archive failures;
- package profile detection;
- extraction provenance;
- conflicting candidate fields;
- authorization invalidation after amendment; and
- provider-limit finding mapping.

### Integration tests

- unknown safe ZIP becomes a diagnostic intake hold;
- unsafe ZIP remains blocked;
- known strict-v1 behavior is unchanged;
- broker correction resolves the corresponding finding;
- confirmed real-file values create a full-value Sandbox expectation;
- exact full-value funding is observed and matched;
- authorization and execution require separate fresh reauthentication;
- duplicate execution is impossible;
- provider rejection becomes an actionable case finding;
- ambiguous execution does not retry automatically;
- reconciliation closes only final provider results; and
- evidence export contains the full audit history.

### Revolut Sandbox verification

For increasing values:

1. prepare funding;
2. create or observe the full-value Sandbox credit;
3. match the credit;
4. build the exact plan;
5. authorize;
6. execute once;
7. record the raw-response digest;
8. reconcile; and
9. document the highest accepted value and every provider response.

Start with USD 10 million and progress through 100 million, 500 million, and
1 billion only as each prior test reaches a clear provider result.

## Acceptance criteria

The phase is successful when:

- five representative operational ZIPs can be uploaded without technical
  assistance;
- every clean but unsupported ZIP receives a useful inventory and specific
  findings;
- the broker can confirm or correct all material transaction fields without
  entering JSON;
- full declared amounts in the expected range can be attempted in Sandbox;
- accepted high-value transactions complete the full workflow;
- rejected or limited transactions produce actionable findings;
- no amount is silently scaled;
- every provider attempt is idempotent and auditable;
- every case ends reconciled, rejected, information-required, or explicitly
  blocked;
- the original package and signed evidence remain available;
- no live endpoint or live funds are reachable;
- recurring package families and exceptions are measurable; and
- the first adapter backlog is supported by observed cases rather than
  assumptions.

## Inputs needed from the broker

For each initial ZIP, collect only:

- the ZIP exactly as received;
- the sender or package family;
- the intended business outcome;
- the expected amount and currency;
- what the broker believes should happen next;
- any exception already known to the broker; and
- whether the package contains personal, confidential, or regulated data.

The broker should not be asked to create manifests, calculate hashes, rename
files, or understand the application schema during the discovery pilot.

## Completed first implementation slice

The following vertical slice is complete locally:

1. separate the case and direct-test amount ceilings;
2. configure a Sandbox case maximum equivalent to USD 1 billion;
3. add high-value accounting and boundary tests;
4. replace generic safe-archive failures with typed findings;
5. preserve the safe file list for unsupported ZIPs;
6. display the file list and questions in a general case-detail screen; and
7. run a synthetic high-value case through funding, authorisation, execution,
   reconciliation, and evidence export.

The next step is not automatic client intake. First complete the external gates
in [Delivery update — July 28, 2026](#delivery-update--july-28-2026). Then use
the first approved client case ZIP to improve the generic intake and choose the
first recurring-format adapter.

## Handoff note for a new context window

Read this document first, then inspect:

- `src/cases/archive-reader.ts`;
- `src/cases/intake.ts`;
- `src/cases/model.ts`;
- `src/cases/currency.ts`;
- `src/cases/case-service.ts`;
- `src/http/routes/cases.ts`;
- `frontend/src/App.tsx`;
- `tests/brokered-funding-cases.test.ts`;
- `tests/case-routes.test.ts`;
- `tests/archive-reader.test.ts`; and
- `tests/revolut-sandbox-client.test.ts`.

Begin a new context by verifying the external gates and the actual deployment.
Do not replace or weaken the strict `brokered-funding/1.0` path. Keep the
direct-transfer smoke-test ceiling small while the authenticated case workflow
uses the full broker-confirmed amount only in Revolut Sandbox. Keep every
unclear result, reconcile it, and never solve a limit by quietly lowering or
repeating the test.
