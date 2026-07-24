import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SANDBOX_API_BASE_URL,
  loadDropletSandboxConfig,
  loadDropletSandboxConfigFiles,
  summarizeAccounts
} from '../scripts/sandbox/droplet-accounts.mjs';

const completeEnvironment = {
  REVOLUT_SANDBOX_BASE_URL: SANDBOX_API_BASE_URL,
  REVOLUT_SANDBOX_CLIENT_ID: 'sandbox-client-id',
  REVOLUT_SANDBOX_ISSUER: 'example.com',
  REVOLUT_SANDBOX_PRIVATE_KEY_PATH: '/run/secrets/private-key',
  REVOLUT_SANDBOX_REFRESH_TOKEN: 'sandbox-refresh-token'
};

describe('Droplet Sandbox account probe', () => {
  it('accepts only the exact Revolut Sandbox API base URL', () => {
    expect(loadDropletSandboxConfig(completeEnvironment).baseUrl).toBe(SANDBOX_API_BASE_URL);
    expect(() => loadDropletSandboxConfig({
      ...completeEnvironment,
      REVOLUT_SANDBOX_BASE_URL: 'https://b2b.revolut.com/api/1.0'
    })).toThrow('Refusing non-Sandbox API URL');
  });

  it('requires every credential setting', () => {
    expect(() => loadDropletSandboxConfig({
      ...completeEnvironment,
      REVOLUT_SANDBOX_REFRESH_TOKEN: ''
    })).toThrow('REVOLUT_SANDBOX_REFRESH_TOKEN');
  });

  it('loads only Sandbox-marked credential files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'revolut-sandbox-probe-'));
    const configPath = join(directory, 'config.json');
    const tokensPath = join(directory, 'tokens.json');
    try {
      await writeFile(configPath, JSON.stringify({
        environment: 'sandbox',
        apiBaseUrl: SANDBOX_API_BASE_URL,
        clientId: 'sandbox-client-id',
        issuer: 'example.com'
      }));
      await writeFile(tokensPath, JSON.stringify({
        environment: 'sandbox',
        refreshToken: 'sandbox-refresh-token'
      }));

      const config = await loadDropletSandboxConfigFiles({
        configPath,
        tokensPath,
        privateKeyPath: '/run/secrets/private-key'
      });
      expect(config.baseUrl).toBe(SANDBOX_API_BASE_URL);

      await writeFile(configPath, JSON.stringify({
        environment: 'production',
        apiBaseUrl: 'https://b2b.revolut.com/api/1.0',
        clientId: 'production-client-id',
        issuer: 'example.com'
      }));
      await expect(loadDropletSandboxConfigFiles({
        configPath,
        tokensPath,
        privateKeyPath: '/run/secrets/private-key'
      })).rejects.toThrow('not marked for Sandbox');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('returns only a non-sensitive account summary', () => {
    expect(summarizeAccounts([
      { id: 'one', currency: 'GBP', balance: 100, state: 'active' },
      { id: 'two', currency: 'EUR', balance: 200, state: 'inactive' },
      { id: 'three', currency: 'GBP', balance: 300, state: 'active' }
    ])).toEqual({
      accountCount: 3,
      activeAccountCount: 2,
      currencies: ['EUR', 'GBP']
    });
  });
});
