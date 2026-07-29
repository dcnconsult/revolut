# Release notes

## 0.4.0 - 2026-07-28

**Release type:** Sandbox pilot feature

This release adds the controlled broker-case workflow for representative
client-case testing in Revolut Sandbox. It remains private and Sandbox-only:
it does not enable Production, live money, public access, or client-case data
handling without the named pilot approval.

### Full-confirmed-amount Sandbox cases

- Separates the small direct owned-account connection test from the broker case
  limit.
- Adds a configurable Sandbox-only broker-case ceiling, initially up to USD 1
  billion for USD cases.
- Uses the full broker-confirmed test amount instead of silently scaling it
  down.
- Preserves high-value limits, rejections, and unclear results as useful case
  findings rather than automatically retrying or reducing the amount.

### Safe case intake and broker controls

- Lets a clean but unfamiliar client ZIP enter protected diagnostic review with
  a safe file list and plain-language questions.
- Adds broker-confirmed case details, recorded corrections, requests for
  information, rejection, exact Sandbox test-credit matching, and balanced
  plan review.
- Adds durable one-time execution, high-value safeguards, redacted evidence,
  and reconciliation controls.

### Broker-facing documentation

- Rewrites the main operator guides and in-app help in broker terms for
  non-technical readers.
- Clarifies the client data-handling approval boundary and the difference
  between a direct connection test and a full broker case.
- Updates the pilot plan, readiness material, and handoff to distinguish local
  implementation from external pilot authorization.

### Validation

- Completed linting, backend and frontend type checks, and the full automated
  test suite.
- Completed production server and browser-console builds.
- Completed Git whitespace and local documentation-link checks.

## 0.3.1 - 2026-07-26

**Release type:** documentation only

This patch release improves the web-based administrator guidance for brokers. It does not change application behavior, APIs, payment processing, case controls, security controls, or deployment requirements.

### Improved broker guide

- Reframed the guide around the broker as the primary reader while explaining that the application may label the broker's access level as **Administrator**.
- Replaced command-heavy wording with calm, plain-language guidance for non-technical users.
- Preserved the exact domain and screen terminology used for claims, findings, amendments, matched funding, beneficiaries, counterparties, funding plans, authorization, execution, and reconciliation.
- Expanded the broker glossary and clarified when to continue, pause, request information, reject, reconcile, or contact support.

### New workflow map

- Added a responsive, printable overview of the complete brokered-funding case workflow.
- Added visual decision paths for approval, information requests, rejection, execution outcomes, reconciliation, and escalation.
- Clarified which checks the application assists with and which decisions remain the broker's responsibility.

### Validation

- Verified HTML structure, headings, internal links, and local assets.
- Verified guide search behavior and the workflow print control.
- Completed a production console build and confirmed that the built help documents match their source files.
