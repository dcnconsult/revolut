import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const base = new URL('../scripts/client/mint/', import.meta.url);
const installer = await readFile(new URL('install.sh', base), 'utf8');
const launcher = await readFile(new URL('launch.sh.in', base), 'utf8');
const directTunnel = await readFile(new URL('direct-tunnel.sh.in', base), 'utf8');
const desktop = await readFile(
  new URL('com.dcnconsult.RevolutSandbox.desktop.in', base),
  'utf8'
);
const firstRun = await readFile(new URL('first-run.sh.in', base), 'utf8');
const packageDesktop = await readFile(new URL('package.desktop.in', base), 'utf8');
const packageBuilder = await readFile(new URL('build-enrollment-package.ps1', base), 'utf8');
const guide = await readFile(new URL('README.md', base), 'utf8');

describe('Linux Mint one-click launcher', () => {
  it('pins SSH identity, host verification, forwarding, and keepalives', () => {
    for (const expected of [
      'IdentitiesOnly yes',
      'BatchMode yes',
      'PasswordAuthentication no',
      'KbdInteractiveAuthentication no',
      'StrictHostKeyChecking yes',
      'UserKnownHostsFile',
      'ForwardAgent no',
      'ForwardX11 no',
      'ExitOnForwardFailure yes',
      'ServerAliveInterval 15',
      'ServerAliveCountMax 3',
      'LocalForward 127.0.0.1:$LOCAL_PORT 127.0.0.1:$REMOTE_PORT'
    ]) {
      expect(installer).toContain(expected);
    }
    expect(installer).toContain('install -m 600 "$STAGING_DIR/tunnel_identity"');
    expect(installer).toContain('ssh-keygen -F "$HOST_LOOKUP"');
  });

  it('uses a resilient single-instance tunnel without a user-service dependency', () => {
    expect(directTunnel).toContain('flock -n 9');
    expect(directTunnel).toContain('while true');
    expect(directTunnel).toContain('-N -T revolut-sandbox-tunnel');
    expect(launcher).toContain('direct_tunnel_is_running');
    expect(launcher).not.toContain('systemctl --user');
    expect(desktop).toContain('Terminal=false');
    expect(desktop).toContain('Exec=@LAUNCHER_PATH@');
  });

  it('opens only after checking the Sandbox health response', () => {
    expect(launcher).toContain('"status"');
    expect(launcher).toContain('"sandbox"');
    expect(launcher).toContain('/health');
    expect(launcher).toContain('/operator/');
    expect(launcher).toContain('xdg-open "$APPLICATION_URL"');
    expect(launcher).toContain('wrong-application-mode');
    expect(launcher).toContain('activation-pending');
  });

  it('documents one-time provisioning without embedding private material', () => {
    expect(guide).toContain('restrict,port-forwarding,permitopen="127.0.0.1:3000"');
    expect(guide).toContain('ssh-keygen -lf');
    expect(guide).toMatch(/`ssh-keyscan`\s+alone does not establish trust/);
    expect(installer).not.toMatch(/BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY/);
    expect(installer).toContain('CONNECTION VERIFIED');
  });

  it('generates enrollment identity only on Mint and exports only its public key', () => {
    expect(firstRun).toContain('ssh-keygen');
    expect(firstRun).toContain('-N ""');
    expect(firstRun).toContain('Revolut-Sandbox-Public-Key.txt');
    expect(firstRun).toContain('--skip-connection-test');
    expect(firstRun).not.toMatch(/BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY/);
    expect(packageDesktop).toContain('Exec=/usr/lib/revolut-sandbox/first-run.sh');
    expect(packageDesktop).toContain('Name=Revolut Sandbox Setup or Repair');
    expect(packageDesktop).toContain('Terminal=false');
  });

  it('builds the Debian artifact outside the repository with public configuration only', () => {
    expect(packageBuilder).toContain('dpkg-deb --root-owner-group --build');
    expect(packageBuilder).toContain('ssh-ed25519');
    expect(packageBuilder).toContain('ContainsPrivateKey = $false');
    expect(packageBuilder).not.toMatch(/BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY/);
  });
});
