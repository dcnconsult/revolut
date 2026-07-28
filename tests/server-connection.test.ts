import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildServerConnectionOptions,
  parseTrustProxy,
  shouldUseSecureCookies
} from '../src/config/server-connection.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, {
    recursive: true,
    force: true
  })));
});

describe('server connection configuration', () => {
  it('keeps proxy forwarding disabled unless exact trusted proxies are configured', () => {
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('  ')).toBe(false);
    expect(parseTrustProxy('127.0.0.1, 10.0.0.0/8')).toEqual([
      '127.0.0.1',
      '10.0.0.0/8'
    ]);
  });

  it('rejects TLS paths when the listener is still configured for HTTP', () => {
    expect(() => buildServerConnectionOptions({
      transport: 'http',
      trustProxy: '',
      tlsCertificatePath: '/tls/server.crt'
    })).toThrow(/cannot be combined/);
  });

  it('requires both a certificate and private key for HTTPS', () => {
    expect(() => buildServerConnectionOptions({
      transport: 'https',
      trustProxy: ''
    })).toThrow(/APP_TLS_KEY_PATH/);
  });

  it('loads direct HTTPS material and enforces TLS 1.2 or newer', async () => {
    const files = await createTlsFiles();
    const options = buildServerConnectionOptions({
      transport: 'https',
      trustProxy: '',
      tlsCertificatePath: files.certificate,
      tlsPrivateKeyPath: files.key,
      tlsPrivateKeyPassphrasePath: files.passphrase
    });

    expect(options.https).toMatchObject({
      minVersion: 'TLSv1.2',
      passphrase: 'test-passphrase'
    });
    expect(options.https?.cert?.toString()).toBe('test-certificate');
    expect(options.https?.key?.toString()).toBe('test-private-key');
    expect(options.https?.requestCert).toBeUndefined();
  });

  it('requires and loads a client CA for mutual TLS', async () => {
    const files = await createTlsFiles();
    const options = buildServerConnectionOptions({
      transport: 'mtls',
      trustProxy: '127.0.0.1',
      tlsCertificatePath: files.certificate,
      tlsPrivateKeyPath: files.key,
      tlsClientCaPath: files.ca
    });

    expect(options.trustProxy).toEqual(['127.0.0.1']);
    expect(options.https).toMatchObject({
      minVersion: 'TLSv1.2',
      requestCert: true,
      rejectUnauthorized: true
    });
    expect(options.https?.ca?.toString()).toBe('test-client-ca');
  });

  it('automatically secures session cookies for direct TLS', () => {
    expect(shouldUseSecureCookies(false, 'http')).toBe(false);
    expect(shouldUseSecureCookies(false, 'https')).toBe(true);
    expect(shouldUseSecureCookies(false, 'mtls')).toBe(true);
    expect(shouldUseSecureCookies(true, 'http')).toBe(true);
  });
});

async function createTlsFiles() {
  const directory = await mkdtemp(join(tmpdir(), 'revolut-tls-test-'));
  temporaryDirectories.push(directory);
  const certificate = join(directory, 'server.crt');
  const key = join(directory, 'server.key');
  const ca = join(directory, 'client-ca.crt');
  const passphrase = join(directory, 'server.passphrase');
  await Promise.all([
    writeFile(certificate, 'test-certificate'),
    writeFile(key, 'test-private-key'),
    writeFile(ca, 'test-client-ca'),
    writeFile(passphrase, 'test-passphrase\n')
  ]);
  return { certificate, key, ca, passphrase };
}
