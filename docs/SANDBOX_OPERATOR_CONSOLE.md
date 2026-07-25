# Use the Sandbox operator console

**Audience:** authorized administrators and read-only operators.

The console is private and can use only synthetic Revolut Sandbox data. You do
not need terminal or API knowledge for normal work.

## Open the console

1. If required, ask the administrator to start the private connection.
2. Open the private application address supplied through the approved channel.
3. Confirm the yellow banner says **REVOLUT SANDBOX · NO LIVE DATA**.
4. Sign in with your own username and password.
5. Enter the current six-digit authenticator code.
6. Select **Operator guide ↗**. It opens in a separate window so you can keep
   the guide beside the application.

Do not use a bookmarked address if the Sandbox banner is missing or different.

## Understand your access

An **Administrator** can upload packages, record findings and amendments, make
decisions, create plans, and complete guarded Sandbox execution.

A **Read only** user can inspect redacted status, cases, transfers, errors, and
audit history. They cannot retrieve sensitive account details or change state.

Accounts belong to individuals. Never share a password, authenticator code,
recovery code, or browser session.

## Read the top status cards

1. **Environment** must say **Sandbox**.
2. **Operations** should say **Clear**. Degraded or Blocked needs review.
3. **Backup** should say **Fresh** before authorization.
4. **Access** confirms whether you are Administrator or Read only.
5. **Deployment** identifies the running release for support.

The other cards summarize stored tests and the small diagnostic transfer
ceiling. They do not authorize a funding-case payout.

## Work the case inbox

Use the workflow in [Work a brokered-funding case](BROKERED_FUNDING_CASES.md):

1. Upload to quarantine.
2. Review package health.
3. Compare claims and findings.
4. Add cited evidence.
5. Match the incoming Sandbox credit.
6. Make a decision.
7. Review the exact plan.
8. Authorize and execute.
9. Reconcile and export evidence.

Complete the steps in order. A package claim, funding match, case approval, and
plan authorization are four different controls.

## Use the direct transfer diagnostic

The **Direct owned-account transfer test** is an advanced diagnostic. It is not
part of a funding case and cannot rely on uploaded claims.

Use it only when an administrator has requested a controlled connectivity
test. Follow [Sandbox account transfer test](SANDBOX_ACCOUNT_TRANSFER_TEST_GUIDE.md).

## Sign out safely

1. Finish or save the current review.
2. Select **Sign out**.
3. Close both the application and guide windows.
4. Close the private connection if your administrator instructed you to do so.

Sessions expire automatically after inactivity. A deployment may also require
you to sign in again.

## If the console does not open

1. Confirm the private connection is running.
2. Retry the approved application address once.
3. Record the time, the page heading, and the plain-language error.
4. Contact the administrator.

Do not paste screenshots containing case details, account identifiers,
balances, passwords, tokens, cookies, authenticator codes, or browser
developer-tool output into email, chat, or an issue.

Administrator-only console provisioning and text-mode recovery are covered in
[DigitalOcean deployment](DIGITALOCEAN_DEPLOYMENT.md).
