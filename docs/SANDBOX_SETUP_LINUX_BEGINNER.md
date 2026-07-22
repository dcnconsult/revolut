# Revolut Business Sandbox setup on Linux

These instructions are written for a first-time Linux user. They use the Revolut **Sandbox only**. Sandbox and Production are separate environments with separate credentials and URLs.

## Before you begin

You need:

- access to the REVOLUTE repository;
- a Revolut Business Sandbox login;
- permission in Revolut to manage API integrations;
- an internet connection;
- Node.js 22 or newer, npm, Git, and OpenSSL.

Never send anyone these files:

```text
.secrets/sandbox/privatecert.pem
.secrets/sandbox/tokens.json
```

The public certificate is safe to upload to Revolut. The private key is not.

## Step 1: Open Terminal

On Ubuntu, press:

```text
Ctrl + Alt + T
```

A Terminal window opens.

## Step 2: Install the required programs

For Ubuntu or Debian, copy this command, paste it into Terminal, and press Enter:

```bash
sudo apt update && sudo apt install -y git openssl curl
```

Enter the computer password if asked. The password will not appear while you type. That is normal.

Node.js 22 or newer is also required. Check the installed version:

```bash
node --version
```

The result must begin with `v22`, `v23`, `v24`, or a later number. If `node` is not found or the version is lower than 22, ask the project maintainer to install the approved Node.js version before continuing.

Check npm:

```bash
npm --version
```

## Step 3: Download or update the repository

For a new copy:

```bash
git clone https://github.com/dcnconsult/revolut.git
cd revolut
```

For an existing copy:

```bash
cd revolut
git pull origin master
```

## Step 4: Start the beginner helper

Run:

```bash
bash START-HERE-SANDBOX.sh
```

The menu displays:

```text
1. First-time Revolut Sandbox setup
2. Test the saved Sandbox account connection
3. Add test funds to a Sandbox account
4. Run all safe local code tests
5. Close
```

Choose `1` for the first setup.

## Step 5: Confirm Sandbox safety

The helper asks you to type:

```text
SANDBOX
```

Type the word exactly, then press Enter.

The helper creates:

```text
.secrets/sandbox/privatecert.pem
.secrets/sandbox/publiccert.cer
```

The private key stays on this computer. Only the public certificate is uploaded to Revolut.

## Step 6: Copy the public certificate

The helper tries to copy the public certificate automatically.

If automatic copying does not work, open another Terminal tab and run:

```bash
cat .secrets/sandbox/publiccert.cer
```

Copy everything from:

```text
-----BEGIN CERTIFICATE-----
```

through:

```text
-----END CERTIFICATE-----
```

Do not copy `privatecert.pem`.

## Step 7: Add the certificate in Revolut Sandbox

The helper opens the Revolut Sandbox Business API settings page when a graphical browser is available.

If no browser opens, manually visit the Revolut Business Sandbox website and open:

```text
Settings → APIs → Business API
```

Confirm the browser address begins with:

```text
https://sandbox-business.revolut.com/
```

Click **Add API certificate** or **Add new** and enter:

```text
Certificate title: REVOLUTE Sandbox
OAuth redirect URI: https://example.com
X509 public key: paste the complete PUBLIC certificate
```

Click **Continue**. Copy the displayed `ClientID`, return to Terminal, paste it, and press Enter.

## Step 8: Authorize access

On the certificate details page:

1. Click **Enable access**.
2. Click **Authorise**.
3. Complete the Sandbox approval steps.
4. The browser redirects to `https://example.com`.
5. The page may show an error. That is acceptable for this test.
6. Copy the entire browser address immediately.
7. Return to Terminal, paste the entire address, and press Enter.

The authorization code is valid for only about two minutes. If it expires, repeat the authorization steps and paste the new address.

The helper exchanges the code using the Revolut Sandbox token endpoint and stores the resulting tokens under `.secrets/sandbox/` without displaying them.

## Step 9: Confirm the connection

The helper calls the Sandbox `/accounts` endpoint. Success looks like an account table followed by:

```text
SUCCESS: Revolut Sandbox authentication and GET /accounts both worked.
```

This proves Sandbox connectivity only. It does not enable Production and does not send a payment.

## Later use

From the repository directory, run:

```bash
bash START-HERE-SANDBOX.sh
```

Then choose:

- `2` to test the saved account connection;
- `3` to add test money to a Sandbox account;
- `4` to run local code tests.

## Common problems

### Permission denied when running the script

Use:

```bash
bash START-HERE-SANDBOX.sh
```

This works even when the file is not marked executable.

Optionally make it executable:

```bash
chmod +x START-HERE-SANDBOX.sh
./START-HERE-SANDBOX.sh
```

### OpenSSL was not found

On Ubuntu or Debian:

```bash
sudo apt update && sudo apt install -y openssl
```

### The browser did not open

Open Revolut Sandbox manually. The helper continues in Terminal.

### The public certificate was not copied

Run:

```bash
cat .secrets/sandbox/publiccert.cer
```

Copy the complete output. Never copy the private key.

### The access token expired

Choose menu option `2`. The helper uses the saved refresh token and creates a new short-lived access token. Refreshing invalidates the previous access token.

### Need to report an error

Copy only the final error message. Never send:

- `privatecert.pem`;
- `tokens.json`;
- an access token;
- a refresh token;
- a client assertion;
- an authorization code.
