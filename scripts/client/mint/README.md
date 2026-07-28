# Linux Mint one-click launcher

This package turns the existing loopback-only SSH access into one application
icon for a nontechnical Linux Mint operator. An administrator performs the
installation once. The operator subsequently selects **Revolut Sandbox** from
the application menu or Desktop; the launcher maintains the SSH tunnel, checks
that the destination is the approved Sandbox application, and opens the login
page in the default browser.

Docker, Node.js, a project checkout, and terminal use are not required on the
operator computer.

## Preferred no-remote-access enrollment

When the Mint computer has no remote-administration service, build a
personalized Debian package containing only the approved server address and
pinned public host key:

```powershell
.\scripts\client\mint\build-enrollment-package.ps1 `
  -ServerHost APPROVED_HOST `
  -KnownHostsPath "$HOME\.ssh\known_hosts" `
  -OutputDirectory ..\outbox\Revolut-Sandbox-Mint
```

The administrator sends the resulting `.deb` and `READ-ME-FIRST.txt` to the
operator. The operator double-clicks the `.deb`, selects **Install**, and opens
**Revolut Sandbox** from the Mint application menu. First launch generates the
private key locally and exports only `Revolut-Sandbox-Public-Key.txt` to the
Desktop.

The operator may email that public file. The private key remains under
`~/.local/share/revolut-sandbox/` and must never be emailed or copied into the
package. Add the received public key to the server using the restriction shown
below. After activation is confirmed, the operator clicks the same application
icon again.

## What the installation creates

All runtime files are owned by the Mint user:

| Path | Purpose |
| --- | --- |
| `~/.config/revolut-sandbox/ssh_config` | Pinned, noninteractive SSH connection |
| `~/.local/share/revolut-sandbox/tunnel_identity` | Dedicated private key, mode `0600` |
| `~/.local/share/revolut-sandbox/known_hosts` | Pre-verified server host key |
| `~/.local/lib/revolut-sandbox/direct-tunnel.sh` | Single-instance automatic tunnel recovery |
| `~/.local/share/applications/com.dcnconsult.RevolutSandbox.desktop` | Mint application-menu entry |
| `~/Desktop/Revolut Sandbox.desktop` | Optional one-click Desktop shortcut |
| `~/.local/state/revolut-sandbox/launcher.log` | Non-sensitive status names and timestamps |

The private tunnel runner starts on the first click, permits only one running
copy, and reconnects after ordinary network interruptions. It does not depend
on a system-wide or per-user systemd service.

## Administrator preparation

Perform these steps locally on the operator's Mint computer. Do not send a
private key through email, chat, Git, or an unencrypted installer.

1. Confirm these packages are installed:

   ```bash
   sudo apt install openssh-client curl xdg-utils
   ```

2. Create a dedicated key as the Mint operator:

   ```bash
   install -d -m 700 "$HOME/.ssh"
   ssh-keygen -t ed25519 -f "$HOME/.ssh/revolut_sandbox_tunnel" \
     -C "revolut-sandbox-tunnel"
   ```

   For unattended opening, either arrange for the Mint login keyring/SSH agent
   to unlock the key or use a dedicated key without a passphrase. A
   passphrase-free key is acceptable only when the workstation uses encrypted
   storage, the user's account is protected, and the server applies the
   forwarding-only restriction below.

3. Add the public key to the Droplet's `deploy` account with this exact
   restriction before the public-key text:

   ```text
   restrict,port-forwarding,permitopen="127.0.0.1:3000" ssh-ed25519 AAAA... revolut-sandbox-tunnel
   ```

   `restrict` disables shell-adjacent capabilities, `port-forwarding`
   selectively re-enables forwarding, and `permitopen` limits the key to the
   application's loopback port. Keep the existing server firewall and
   loopback-only application binding.

4. Obtain the server ED25519 host key and verify its fingerprint against the
   trusted DigitalOcean console or approved infrastructure record. `ssh-keyscan`
   alone does not establish trust.

   ```bash
   ssh-keyscan -t ed25519 APPROVED_HOST > /tmp/revolut-known-hosts
   ssh-keygen -lf /tmp/revolut-known-hosts
   ```

5. From this repository directory, install as the Mint operator, not with
   `sudo`:

   ```bash
   ./scripts/client/mint/install.sh \
     --host APPROVED_HOST \
     --identity "$HOME/.ssh/revolut_sandbox_tunnel" \
     --known-hosts /tmp/revolut-known-hosts
   ```

6. The installer performs a complete connection test and opens
   `http://127.0.0.1:3000/operator/`. Confirm that the page has the yellow
   **REVOLUT SANDBOX · NO LIVE DATA** banner before handing the computer to the
   operator. Do not use `--skip-connection-test` for a normal handoff.

The operator's normal instructions are simply:

> Connect to the internet and double-click **Revolut Sandbox**. Wait up to 30
> seconds for the login page. If a plain-language error appears, try once more,
> then contact the administrator without changing settings.

## Safe troubleshooting

An administrator can inspect status without exposing credentials:

```bash
tail -n 30 "$HOME/.local/state/revolut-sandbox/launcher.log"
tail -n 30 "$HOME/.local/state/revolut-sandbox/tunnel.log"
```

The launcher log contains only timestamps and fixed status names. The tunnel
log can contain the configured server name and SSH error messages but should
not contain the private key.
Never request or copy the private-key file during troubleshooting.

To apply changed access files, rerun the installer with `--replace`. The
installer stops the old tunnel before installing the replacement.
