import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
});
