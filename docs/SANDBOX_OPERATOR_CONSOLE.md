# Use the Sandbox workspace

**Who this is for:** authorised brokers and read-only reviewers using the
private browser workspace.

The workspace can reach **Revolut Sandbox only**. It is for documented tests,
not live money. You do not need terminal commands or technical API knowledge
for normal broker work.

Representative operational files may be used only after the approved retention
and sensitive-data arrangements are in place. Never place their contents in
email, chat, logs, or Git.

## Open the workspace

1. If needed, ask the administrator to start the private connection.
2. Open the private address supplied through the approved channel.
3. Check the yellow banner: **REVOLUT SANDBOX · NO LIVE DATA**.
4. Sign in with your own username and password.
5. Enter the current six-digit authenticator code.
6. Select **Operator guide ↗** to keep the plain-language guide open beside
   the workspace.

If the yellow banner is missing or different, stop. Do not use a saved browser
address as a substitute for checking the banner.

## Know what you can do

An **Administrator** can upload a file, add broker notes and corrections,
record a decision, prepare a Sandbox plan, and complete the guarded Sandbox
test steps.

A **Read only** user can see safe, redacted case information and history. They
cannot change a case or download private original files.

Your account is personal. Do not share a password, authenticator code, recovery
code, or browser session.

## Read the top cards first

1. **Environment** must say **Sandbox**.
2. **Operations** should say **Clear**. If it says Degraded or Blocked, pause
   case work and ask for guidance.
3. **Backup** should say **Fresh** before you authorise a case plan.
4. **Access** shows whether you can make changes or only review.
5. **Deployment** helps the administrator identify the running release if
   support is needed.

The other cards may show small technical connection tests. They do not approve
or limit a broker case.

## Large Sandbox case amounts

There are two different test tools:

- **Direct owned-account transfer test** — a small, technical connection check.
- **Broker case workflow** — the documented end-to-end Sandbox test for a
  confirmed case.

The broker case workflow has its own Sandbox-only amount limit. For USD, the
initial limit is up to USD 1 billion, subject to the approved private settings
and Sandbox's response. When the broker confirms an amount, the workspace uses
the full amount for the Sandbox test. It never quietly reduces the amount to
make a result look successful.

If Sandbox rejects, limits, or leaves the result unclear, the workspace keeps
that response as a case finding. This is useful information for the broker and
the pilot; it is not a reason to lower the amount and try again.

## If a test is interrupted or unclear

1. Stop. Do not press the funding or payout button again.
2. Select **Refresh** or **Reconcile Sandbox result** when offered. These check
   the first test rather than starting another one.
3. Read the plain-language finding and **Needed next** instruction.
4. Keep the result in the case and contact the administrator if it cannot be
   completed or explained.

The workspace remembers the first high-value attempt so a second click cannot
silently create a duplicate test.

## Work a case from the inbox

Use [Work a Sandbox case](BROKERED_FUNDING_CASES.md) for the full guide. In
short:

1. Upload the ZIP once.
2. Read the safety result, file list, and questions.
3. Compare sender information, workspace findings, and broker review.
4. Record supported corrections or ask for information.
5. Confirm one matching Sandbox test credit.
6. Approve, request information, or reject.
7. Read the exact plan.
8. Authorise and execute once.
9. Reconcile the existing result and download the signed record.

These are separate checks. A sender's statement, a Sandbox test credit, a
broker decision, and plan approval do not replace one another.

## Use the direct transfer test only when asked

The **Direct owned-account transfer test** is for a controlled connection check.
It is not part of a broker case and must not use uploaded claims as payment
instructions. Follow the [account transfer test guide](SANDBOX_ACCOUNT_TRANSFER_TEST_GUIDE.md)
only when an administrator requests it.

## Sign out safely

1. Finish or save the current review.
2. Select **Sign out**.
3. Close the workspace and guide windows.
4. Close the private connection if the administrator asked you to do so.

Sessions end automatically after inactivity. A release update may also ask you
to sign in again.

## If the workspace does not open

1. Check that the private connection is running.
2. Retry the approved address once.
3. Record the time, page heading, and plain-language error.
4. Contact the administrator.

Do not paste screenshots containing case details, account identifiers,
balances, passwords, tokens, cookies, authenticator codes, or browser developer
tools into email, chat, or an issue.

## Administrator-only note

Only the private deployment administrator can change the Sandbox case limit.
The technical setting is `CASE_SANDBOX_MAXIMUMS_JSON`; brokers do not need to
edit or calculate it. See [Sandbox deployment](DIGITALOCEAN_DEPLOYMENT.md) for
the technical procedure.
