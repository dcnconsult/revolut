# REVOLUTE Business API scaffold

A TypeScript/Fastify foundation for preparing, validating, funding, submitting, and reconciling direct bank-to-bank payments through the Revolut Business API.

Payments can enter the same canonical workflow through either:

1. manual JSON entry; or
2. an uploaded ISO 20022 Customer Credit Transfer Initiation XML file (`pain.001`).

The current provider is deterministic and safe for local development. The production `RevolutBusinessProvider`, OAuth/X.509 token manager, persistent audit database, approvals, and verified completion webhooks remain isolated promotion gates.

## Current ISO 20022 import profile

The import API supports:

- `pain.001.001.09`, the current EPC SEPA customer-to-PSP message version;
- `pain.001.001.03` as a legacy interoperability profile;
- one or many `PmtInf` blocks and credit-transfer transactions;
- IBAN beneficiaries and UK account-number/sort-code beneficiaries;
- exact decimal-to-minor-unit conversion and control-sum reconciliation;
- debtor-account-to-Revolut-account mapping;
- deterministic import and payment references for duplicate detection;
- aggregate batch funds verification before preparation;
- atomic import by default, with explicit partial mode available for diagnostic use.

The parser performs secure XML syntax, supported-namespace, file-integrity, semantic, and application-schema validation. It deliberately reports `officialXsd: false`: official ISO/EPC XSD and implementation-guideline Schematron validation must be added before production promotion.

## Run locally

```bash
cp .env.example .env
npm install
npm run dev
```

Health check:

```bash
curl http://localhost:3000/health
```

## Manual payment entry

Prepare a transfer:

```bash
curl -X POST http://localhost:3000/v1/payments/prepare \
  -H 'content-type: application/json' \
  -d '{
    "sourceAccountId":"8d43a0d9-f040-4c98-b9de-89cf30ab9807",
    "amountMinor":10000,
    "currency":"EUR",
    "beneficiary":{
      "legalName":"Example GmbH",
      "accountType":"business",
      "country":"DE",
      "currency":"EUR",
      "iban":"DE89370400440532013000",
      "bic":"COBADEFFXXX"
    },
    "reference":"Invoice 2026-001",
    "clientReference":"rev-2026-000001"
  }'
```

## ISO 20022 XML upload

Validate and preview a file without creating payment records:

```bash
curl -X POST http://localhost:3000/v1/payment-imports/iso20022/validate \
  -F 'file=@tests/fixtures/pain.001.001.09-valid.xml;type=application/xml' \
  -F 'sourceAccountId=8d43a0d9-f040-4c98-b9de-89cf30ab9807'
```

Prepare all valid payments after document validation, provider field discovery, beneficiary validation, quotation, and aggregate funds verification:

```bash
curl -X POST http://localhost:3000/v1/payment-imports/iso20022/prepare \
  -F 'file=@tests/fixtures/pain.001.001.09-valid.xml;type=application/xml' \
  -F 'sourceAccountId=8d43a0d9-f040-4c98-b9de-89cf30ab9807' \
  -F 'atomic=true'
```

For a file containing multiple debtor accounts, map each normalized debtor account identifier to its Revolut account UUID rather than applying a blanket override:

```bash
curl -X POST http://localhost:3000/v1/payment-imports/iso20022/prepare \
  -F 'file=@payment-batch.xml;type=application/xml' \
  -F 'sourceAccountMap={"GB82WEST12345698765432":"8d43a0d9-f040-4c98-b9de-89cf30ab9807"}' \
  -F 'atomic=true'
```

`atomic=true` is the default. Document-level integrity errors always reject the entire file. With `atomic=false`, individually invalid transactions are rejected while valid transactions may be prepared; this does not override document-level errors.

Importing never sends money automatically. Each returned payment remains in `funds_confirmed` or `manual_review` until separately authorized and submitted:

```bash
curl -X POST http://localhost:3000/v1/payments/<PAYMENT_ID>/submit
curl -X POST http://localhost:3000/v1/payments/<PAYMENT_ID>/reconcile
curl http://localhost:3000/v1/payments/<PAYMENT_ID>
```

See `docs/ISO20022_IMPORT.md` for the field mapping, rejection model, security controls, and production gaps.

## Verification

```bash
npm run check
npm run build
npm audit --audit-level=high
```

## Important boundaries

This scaffold does not bypass bank authorization, compliance, source-account ownership, beneficiary checks, transaction limits, or approval policy. It contains no certificates, private keys, refresh tokens, or access tokens.

A successful upload proves only that the document survived the implemented parser and orchestration controls. It does not prove that funds are reserved, the beneficiary passed production Confirmation of Payee/Verification of Payee, Revolut accepted the transfer, or the receiving bank completed it. Those claims are promoted only from corresponding provider observations.

Production submission must remain disabled until persistent idempotency, transactional batch controls, immutable audit events, source-account ownership reconciliation, XSD/Schematron validation, approval controls, webhook authentication, and Revolut sandbox contract tests pass.

See `docs/ARCHITECTURE.md` and `docs/IMPLEMENTATION_CHECKLIST.md`.
