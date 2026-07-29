import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  REVOLUT_SANDBOX_API_BASE_URL,
  RevolutSandboxClient
} from '../src/adapters/revolut-sandbox-client.js';
import { OperationalFault } from '../src/operations/operational-error-monitor.js';

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

  it('does not automatically retry a money-moving Sandbox request', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'revolut-sandbox-no-retry-'));
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
      let transferCalls = 0;
      const fetchImplementation = vi.fn(async (url: string | URL) => {
        if (String(url).endsWith('/auth/token')) {
          return new Response(JSON.stringify({ access_token: 'access', expires_in: 2400 }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
        transferCalls += 1;
        return new Response(JSON.stringify({ message: 'Temporary provider failure' }), {
          status: 500,
          headers: { 'content-type': 'application/json' }
        });
      });
      const client = new RevolutSandboxClient(
        { configPath, tokensPath, privateKeyPath },
        fetchImplementation as unknown as typeof fetch
      );

      await expect(client.createInternalTransfer({
        requestId: '11111111-1111-4111-8111-111111111111',
        sourceAccountId: '22222222-2222-4222-8222-222222222222',
        targetAccountId: '33333333-3333-4333-8333-333333333333',
        amount: 1_000_000_000,
        currency: 'USD',
        reference: 'SYNTHETIC HIGH VALUE NO RETRY'
      })).rejects.toThrow('HTTP 500');
      expect(transferCalls).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not refresh-and-replay a money-moving request after HTTP 401', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'revolut-sandbox-no-401-replay-'));
    try {
      const configPath = join(directory, 'config.json');
      const tokensPath = join(directory, 'tokens.json');
      const privateKeyPath = join(directory, 'private.pem');
      const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      await writeFile(configPath, JSON.stringify({
        environment: 'sandbox', apiBaseUrl: REVOLUT_SANDBOX_API_BASE_URL,
        clientId: 'sandbox-client', issuer: 'example.com'
      }));
      await writeFile(tokensPath, JSON.stringify({ environment: 'sandbox', refreshToken: 'sandbox-refresh' }));
      await writeFile(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
      let tokenCalls = 0;
      let transferCalls = 0;
      const fetchImplementation = vi.fn(async (url: string | URL) => {
        if (String(url).endsWith('/auth/token')) {
          tokenCalls += 1;
          return new Response(JSON.stringify({ access_token: 'access', expires_in: 2400 }), {
            status: 200, headers: { 'content-type': 'application/json' }
          });
        }
        transferCalls += 1;
        return new Response(JSON.stringify({ error: 'Unauthorized provider response' }), {
          status: 401, headers: { 'content-type': 'application/json' }
        });
      });
      const client = new RevolutSandboxClient(
        { configPath, tokensPath, privateKeyPath }, fetchImplementation as unknown as typeof fetch
      );

      await expect(client.createInternalTransfer({
        requestId: '11111111-1111-4111-8111-111111111111',
        sourceAccountId: '22222222-2222-4222-8222-222222222222',
        targetAccountId: '33333333-3333-4333-8333-333333333333',
        amount: 1_000_000_000,
        currency: 'USD',
        reference: 'SYNTHETIC HIGH VALUE 401 NO REPLAY'
      })).rejects.toThrow('HTTP 401');
      expect(transferCalls).toBe(1);
      expect(tokenCalls).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('retains provider error bodies and malformed response bodies for encrypted case evidence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'revolut-sandbox-provider-evidence-'));
    try {
      const configPath = join(directory, 'config.json');
      const tokensPath = join(directory, 'tokens.json');
      const privateKeyPath = join(directory, 'private.pem');
      const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      await writeFile(configPath, JSON.stringify({
        environment: 'sandbox', apiBaseUrl: REVOLUT_SANDBOX_API_BASE_URL,
        clientId: 'sandbox-client', issuer: 'example.com'
      }));
      await writeFile(tokensPath, JSON.stringify({ environment: 'sandbox', refreshToken: 'sandbox-refresh' }));
      await writeFile(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
      const fetchImplementation = vi.fn(async (url: string | URL) => {
        if (String(url).endsWith('/auth/token')) {
          return new Response(JSON.stringify({ access_token: 'access', expires_in: 2400 }), {
            status: 200, headers: { 'content-type': 'application/json' }
          });
        }
        return new Response(JSON.stringify({
          error: 'High value amount limit exceeded',
          detail: 'Synthetic provider diagnostic'
        }), { status: 422, headers: { 'content-type': 'application/json' } });
      });
      const client = new RevolutSandboxClient(
        { configPath, tokensPath, privateKeyPath }, fetchImplementation as unknown as typeof fetch
      );
      let fault: unknown;
      try {
        await client.createInternalTransfer({
          requestId: '11111111-1111-4111-8111-111111111111',
          sourceAccountId: '22222222-2222-4222-8222-222222222222',
          targetAccountId: '33333333-3333-4333-8333-333333333333',
          amount: 1_000_000_000,
          currency: 'USD',
          reference: 'SYNTHETIC PROVIDER EVIDENCE'
        });
      } catch (error) {
        fault = error;
      }
      expect(fault).toBeInstanceOf(OperationalFault);
      expect(fault).toMatchObject({
        httpStatus: 422,
        providerResponse: { error: 'High value amount limit exceeded' }
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
