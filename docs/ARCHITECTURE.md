# Architecture and promotion gates

## Known inputs
Source account, amount/currency, beneficiary identity and bank coordinates, reference, corridor-specific purpose/charge data, and a unique client reference.

## Observed signals
Provider field requirements, name-validation response, available balance, quote/fees, submission response, transaction status, webhook signature and event.

## Target output
Exactly one authorized bank transfer with a traceable terminal outcome: completed, failed, reverted, or declined.

## State machine
`draft -> validated -> funds_confirmed -> pending -> completed|failed|reverted|declined`

`manual_review` is a hold state for close matches, temporary validation failure, policy flags, or approvals.

## Control gates
- **-1 park/falsify:** malformed beneficiary, unsupported corridor, no name match, inadequate funds, invalid webhook signature, conflicting idempotency record.
- **0 diagnose:** close match, validation unavailable, quote drift, stale balance, pending beyond SLA.
- **+1 promote:** required fields satisfied, policy checks pass, funds cover amount plus fees, unique client reference, provider accepted submission, terminal status reconciled.

## Trust boundaries
- Browser/UI never receives Revolut private keys, refresh tokens, or provider access tokens.
- Server signs short-lived client assertions using a private key stored outside Git.
- Webhooks are authenticated before state changes.
- Persistent production storage must enforce unique `client_reference` and `provider_transaction_id` constraints.

## Provider adapter work
Implement `RevolutBusinessProvider` against live documented endpoints for accounts, `/pay/fields`, quote/transfer preparation, `/pay`, transaction retrieval, account-name validation, OAuth token refresh, and v2 webhooks. Keep endpoint payload mapping inside the adapter.
