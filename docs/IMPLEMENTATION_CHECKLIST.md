# Implementation checklist

1. Register separate Sandbox and Production X.509 certificates.
2. Store the private key and refresh token in a managed secret store.
3. Add the Revolut provider adapter and token manager.
4. Replace in-memory storage with PostgreSQL and immutable audit events.
5. Add role-based approval for payments above configurable thresholds.
6. Add sanctions/AML policy hooks appropriate to the business and jurisdictions.
7. Add webhook v2 signature verification, replay protection, and failed-event recovery.
8. Add polling fallback and pending-payment SLA alerts.
9. Add corridor fixtures for EUR/SEPA, CHF, GBP, and SWIFT scenarios.
10. Run sandbox contract tests; do not treat sandbox CoP/VoP as real beneficiary verification.
11. Add production canary limits and dual approval before raising limits.
