# Live Revolut Sandbox mode

`REVOLUT_MODE=sandbox` connects the loopback-only application API to the real
Revolut Business Sandbox. It never selects the Production Business API.

## Boundaries

- The only permitted provider host is
  `https://sandbox-b2b.revolut.com/api/1.0`.
- `REVOLUT_MODE=production` stops application startup.
- Existing beneficiary-payment and ISO preparation routes are not registered
  in Sandbox mode.
- Only transfers between two accounts owned by the same Sandbox business are
  supported.
- Preparation does not move test funds. Submission is a separate request.
- The default maximum is 1,000 minor units (`10.00`).
- Records and idempotency state are currently in memory and reset when the
  container restarts. This mode is for controlled Sandbox testing only.
- The application remains bound to `127.0.0.1:3000` on the Droplet.

## Endpoints

List owned Sandbox accounts:

```text
GET /v1/sandbox/accounts
```

Prepare an internal transfer:

```text
POST /v1/sandbox/internal-transfers/prepare
```

Example body:

```json
{
  "sourceAccountId": "SANDBOX_SOURCE_ACCOUNT_UUID",
  "targetAccountId": "SANDBOX_TARGET_ACCOUNT_UUID",
  "amountMinor": 1,
  "currency": "GBP",
  "reference": "Controlled Sandbox test",
  "clientReference": "sandbox-controlled-0001"
}
```

The response has `state: "prepared"`. It has not moved test funds.

Submit, retrieve, or reconcile:

```text
POST /v1/sandbox/internal-transfers/{id}/submit
GET  /v1/sandbox/internal-transfers/{id}
POST /v1/sandbox/internal-transfers/{id}/reconcile
```

## Droplet configuration

The application reads the existing root-owned Sandbox files:

```text
/etc/revolut/sandbox/config.json
/etc/revolut/sandbox/tokens.json
/etc/revolut/sandbox/privatecert.pem
```

Set this exact line in `/etc/revolut/revolut.env`:

```text
REVOLUT_MODE=sandbox
```

The deployment script detects this mode, adds `compose.sandbox.yaml`, mounts
the three files read-only, and verifies that `/health` reports:

```json
{
  "status": "ok",
  "mode": "sandbox",
  "provider": "revolut-sandbox-internal-transfer"
}
```

To return to the deterministic provider, restore `REVOLUT_MODE=mock` and
reactivate a release. Production must not be selected.
