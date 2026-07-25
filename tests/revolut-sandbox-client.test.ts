import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  REVOLUT_SANDBOX_API_BASE_URL,
  RevolutSandboxClient
} from '../src/adapters/revolut-sandbox-client.js';

describe('RevolutSandboxClient host boundary', () => {
  it('refuses a Production-marked credential file before making a request', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'revolut-sandbox-client-'));
    try {
      const configPath = join(directory, 'config.json');
      const tokensPath = join(directory, 'tokens.json');
      const privateKeyPath = join(directory, 'private.pem');
      await writeFile(configPath, JSON.stringify({
        environment: 'sandbox',
        apiBaseUrl: 'https://b2b.revolut.com/api/1.0',
        clientId: 'sandbox-client',
        issuer: 'example.com'
      }));
      await writeFile(tokensPath, JSON.stringify({
        environment: 'sandbox',
        refreshToken: 'sandbox-refresh'
      }));
      await writeFile(privateKeyPath, 'not-used');
      const fetchImplementation = vi.fn();
      const client = new RevolutSandboxClient(
        { configPath, tokensPath, privateKeyPath },
        fetchImplementation as unknown as typeof fetch
      );

      await expect(client.getAccounts()).rejects.toThrow('Refusing non-Sandbox API URL');
      expect(fetchImplementation).not.toHaveBeenCalled();
      expect(REVOLUT_SANDBOX_API_BASE_URL).toBe('https://sandbox-b2b.revolut.com/api/1.0');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('coalesces token refresh and applies a bounded Retry-After retry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'revolut-sandbox-retry-'));
    try {
      const configPath = join(directory, 'config.json');
      const tokensPath = join(directory, 'tokens.json');
      const privateKeyPath = join(directory, 'private.pem');
      const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      await writeFile(configPath, JSON.stringify({
        environment: 'sandbox',
        apiBaseUrl: REVOLUT_SANDBOX_API_BASE_URL,
        clientId: 'sandbox-client',
        issuer: 'example.com'
      }));
      await writeFile(tokensPath, JSON.stringify({
        environment: 'sandbox',
        refreshToken: 'sandbox-refresh'
      }));
      await writeFile(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
      let accountCalls = 0;
      const fetchImplementation = vi.fn(async (url: string | URL) => {
        if (String(url).endsWith('/auth/token')) {
          return new Response(JSON.stringify({ access_token: 'access', expires_in: 2400 }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
        accountCalls += 1;
        if (accountCalls === 1) {
          return new Response(JSON.stringify({ message: 'Slow down' }), {
            status: 429,
            headers: { 'content-type': 'application/json', 'retry-after': '0' }
          });
        }
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      });
      const client = new RevolutSandboxClient(
        { configPath, tokensPath, privateKeyPath },
        fetchImplementation as unknown as typeof fetch
      );

      await expect(Promise.all([client.getAccounts(), client.getAccounts()])).resolves.toEqual([[], []]);
      const tokenCalls = fetchImplementation.mock.calls
        .filter(([url]) => String(url).endsWith('/auth/token'));
      expect(tokenCalls).toHaveLength(1);
      expect(accountCalls).toBe(3);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
