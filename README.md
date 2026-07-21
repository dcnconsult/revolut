# REVOLUTE Business API scaffold

A TypeScript/Fastify foundation for validating, funding, submitting, and reconciling bank-to-bank transfers through a provider adapter. The initial adapter is deterministic and safe for local development; the Revolut adapter is intentionally isolated as the next integration step.

## Run locally

```bash
cp .env.example .env
npm install
npm run dev
```

Health check: `GET http://localhost:3000/health`

Prepare a transfer:

```bash
curl -X POST http://localhost:3000/v1/payments/prepare \
  -H 'content-type: application/json' \
  -d '{
    "sourceAccountId":"8d43a0d9-f040-4c98-b9de-89cf30ab9807",
    "amountMinor":10000,
    "currency":"EUR",
    "beneficiary":{"legalName":"Example GmbH","accountType":"business","country":"DE","currency":"EUR","iban":"DE89370400440532013000","bic":"COBADEFFXXX"},
    "reference":"Invoice 2026-001",
    "clientReference":"rev-2026-000001"
  }'
```

Submit the returned payment ID:

```bash
curl -X POST http://localhost:3000/v1/payments/<PAYMENT_ID>/submit
```

## Important boundaries

This code does not bypass bank authorization, compliance, account ownership, beneficiary checks, or transaction limits. It does not contain certificates or secrets. Production submission must remain disabled until persistent idempotency, audit logs, webhook verification, approval controls, and Revolut sandbox contract tests pass.

See `docs/ARCHITECTURE.md` and `docs/IMPLEMENTATION_CHECKLIST.md`.
