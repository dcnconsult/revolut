# Remote connection options

**Audience:** designated server and security administrators. These options do
not enable Production mode or authorize public access. Keep the existing
Sandbox authentication, firewall, backup, and approval controls.

The application supports four deployment patterns. "SSL" in older
documentation and control panels means TLS/HTTPS here; obsolete SSL protocols
are not enabled.

| Option | Encryption boundary | Application settings | Recommended use |
| --- | --- | --- | --- |
| SSH local forwarding | SSH client to server | `APP_TRANSPORT=http`, no trusted proxy | Current single-administrator Sandbox access |
| Private VPN/overlay | VPN peers | `APP_TRANSPORT=http`, bind/publish only on the approved private interface | Small approved private network |
| HTTPS reverse proxy | Browser to Caddy/Nginx/load balancer | `APP_TRANSPORT=http`, exact `APP_TRUST_PROXY`, `OPERATOR_COOKIE_SECURE=true` | Preferred multi-user remote access |
| Direct HTTPS or mutual TLS | Browser/client to this Node process | `APP_TRANSPORT=https` or `mtls`, certificate paths, secure cookie automatic | Restricted environments without a proxy |

## 1. Existing SSH tunnel

No server changes are needed. Keep the Compose port published on
`127.0.0.1:3000` and connect:

```bash
ssh -L 3000:127.0.0.1:3000 deploy@SANDBOX_HOST_FROM_INVENTORY
```

Then open `http://127.0.0.1:3000/operator/`. This remains the safest default
because it creates no public application listener.

## 2. Private VPN or overlay

Keep `APP_TRANSPORT=http` only when the private network itself provides
authenticated encryption. Publish the container port on the approved VPN
interface, not `0.0.0.0`, and restrict the host firewall to the VPN subnet.
Application login and MFA are still required.

## 3. TLS at a reverse proxy

This is the preferred design for a stable remote hostname. The proxy owns
certificate issuance and renewal and forwards to the loopback-only application.

Set:

```dotenv
APP_TRANSPORT=http
APP_TRUST_PROXY=127.0.0.1
OPERATOR_COOKIE_SECURE=true
```

Use the proxy's actual source IP or CIDR when it is not on loopback. Never set
an unrestricted trust-proxy value. Forward the original `Host`,
`X-Forwarded-For`, and `X-Forwarded-Proto` headers, and allow only the intended
hostname. Keep port 3000 closed externally and expose only proxy port 443.

The reverse proxy must enforce TLS 1.2 or newer, redirect HTTP to HTTPS, set
HSTS after the hostname and certificate are proven, apply request-size and
timeout limits at least as strict as the application, and preserve WebSocket
settings only if a future feature requires them.

## 4. Direct HTTPS

For direct server TLS, mount the certificate and private key read-only and set:

```dotenv
APP_HOST=0.0.0.0
PORT=3443
APP_TRANSPORT=https
APP_TLS_CERT_PATH=/run/secrets/app-tls-cert
APP_TLS_KEY_PATH=/run/secrets/app-tls-key
APP_TLS_KEY_PASSPHRASE_PATH=
APP_TRUST_PROXY=
```

The certificate file should include the leaf certificate and required
intermediate chain. If the private key is encrypted, store its passphrase in a
separate root-managed file and set `APP_TLS_KEY_PASSPHRASE_PATH`. Direct TLS
automatically adds `Secure` to operator session cookies.

Do not publish the port until a hostname, certificate validation, firewall
rule, monitoring check, and rollback test are ready. The existing Docker
health check assumes the default internal HTTP deployment, so a direct-TLS
container deployment must also supply a certificate-valid HTTPS health check.

## 5. Mutual TLS

Mutual TLS adds a client-certificate gate in front of the normal operator
login. It does not replace application authentication, role checks, MFA, or
CSRF protection.

```dotenv
APP_TRANSPORT=mtls
APP_TLS_CERT_PATH=/run/secrets/app-tls-cert
APP_TLS_KEY_PATH=/run/secrets/app-tls-key
APP_TLS_CLIENT_CA_PATH=/run/secrets/app-client-ca
```

Only certificates chaining to the configured client CA are accepted. Use a
dedicated private CA, short certificate lifetimes, a documented revocation
process, and separate certificates per device or operator.

## Fail-closed behavior

Startup stops when:

- HTTPS or mutual TLS lacks a key or certificate;
- mutual TLS lacks a client CA;
- a TLS file is empty or unreadable;
- TLS paths are supplied while `APP_TRANSPORT=http`; or
- a client CA is supplied for ordinary HTTPS.

All direct TLS modes require TLS 1.2 or newer. Proxy trust remains disabled
unless explicit proxy addresses or CIDRs are supplied.

## Promotion checklist

Before changing from the SSH-only baseline:

1. Record the approved connection option, hostname, source networks, and owner.
2. Back up and test rollback to the loopback-only release.
3. Verify certificate chain, hostname, expiry monitoring, and renewal.
4. Confirm port 3000 is not publicly reachable.
5. Test login, MFA, secure cookies, CSRF-protected actions, logout, and rate
   limiting through the final connection path.
6. Run the safe Sandbox smoke test without submitting funds.
7. Update monitoring to use the final scheme and trusted certificate chain.
