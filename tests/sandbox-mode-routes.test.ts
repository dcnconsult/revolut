import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { SandboxInternalTransferClient } from '../src/adapters/revolut-sandbox-client.js';
import { OperationalFault } from '../src/operations/operational-error-monitor.js';
import { buildApp } from '../src/server.js';

const client: SandboxInternalTransferClient = {
  getAccounts: vi.fn(async () => [
    {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'GBP source',
      currency: 'GBP',
      balance: 20,
      state: 'active'
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'GBP target',
      currency: 'GBP',
      balance: 5,
      state: 'active'
    }
  ]),
  createInternalTransfer: vi.fn(async () => ({
    id: '33333333-3333-4333-8333-333333333333',
    state: 'completed'
  })),
  getTransaction: vi.fn(async transactionId => ({ id: transactionId, state: 'completed' }))
};

describe('Sandbox server mode', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    vi.clearAllMocks();
  });

  async function login(username = 'admin', password = 'admin-test-password') {
    const response = await app!.inject({
      method: 'POST',
      url: '/v1/operator/session',
      payload: { username, password }
    });
    const setCookie = response.headers['set-cookie'];
    return {
      response,
      cookie: (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0] ?? '',
      csrf: response.json().csrfToken as string
    };
  }

  it('reports the real Sandbox provider and does not register mock payment routes', async () => {
    app = buildApp({ mode: 'sandbox', sandboxClient: client, sandboxDatabasePath: ':memory:' });
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.json()).toEqual({
      status: 'ok',
      mode: 'sandbox',
      provider: 'revolut-sandbox-internal-transfer'
    });

    const mockPayment = await app.inject({ method: 'POST', url: '/v1/payments/prepare', payload: {} });
    expect(mockPayment.statusCode).toBe(404);

    const auth = await login();
    const accountResponse = await app.inject({
      method: 'GET',
      url: '/v1/sandbox/accounts',
      headers: { cookie: auth.cookie }
    });
    expect(accountResponse.statusCode).toBe(200);
    expect(accountResponse.json()[0]).toMatchObject({
      currency: 'GBP',
      balanceMinor: 2_000,
      state: 'active'
    });
  });

  it('uses prepare then submit for an internal Sandbox transfer', async () => {
    app = buildApp({ mode: 'sandbox', sandboxClient: client, sandboxDatabasePath: ':memory:' });
    const auth = await login();
    const preparedResponse = await app.inject({
      method: 'POST',
      url: '/v1/sandbox/internal-transfers/prepare',
      payload: {
        sourceAccountId: '11111111-1111-4111-8111-111111111111',
        targetAccountId: '22222222-2222-4222-8222-222222222222',
        amountMinor: 1,
        currency: 'GBP',
        reference: 'Sandbox internal test',
        clientReference: 'sandbox-route-0001'
      },
      headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrf, origin: 'http://localhost:80' }
    });
    expect(preparedResponse.statusCode).toBe(201);
    expect(preparedResponse.json().state).toBe('prepared');

    const submittedResponse = await app.inject({
      method: 'POST',
      url: `/v1/sandbox/internal-transfers/${preparedResponse.json().id}/submit`,
      headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrf, origin: 'http://localhost:80' },
      payload: {
        password: 'admin-test-password',
        confirmation: 'SUBMIT 0.01 GBP'
      }
    });
    expect(submittedResponse.statusCode).toBe(200);
    expect(submittedResponse.json().state).toBe('completed');

    const summary = await app.inject({
      method: 'GET',
      url: '/v1/sandbox/monitoring/summary',
      headers: { cookie: auth.cookie }
    });
    expect(summary.json()).toMatchObject({ total: 1, byState: { completed: 1 } });

    const audit = await app.inject({
      method: 'GET',
      url: '/v1/sandbox/monitoring/audit-events',
      headers: { cookie: auth.cookie }
    });
    expect(audit.json().map((event: { eventType: string }) => event.eventType)).toEqual([
      'submitted',
      'prepared'
    ]);
  });

  it('enforces viewer redaction and denies state-changing access', async () => {
    app = buildApp({ mode: 'sandbox', sandboxClient: client, sandboxDatabasePath: ':memory:' });
    expect((await app.inject({ method: 'GET', url: '/v1/sandbox/monitoring/summary' })).statusCode).toBe(401);
    const auth = await login('viewer', 'viewer-test-password');
    const accounts = await app.inject({
      method: 'GET',
      url: '/v1/sandbox/accounts',
      headers: { cookie: auth.cookie }
    });
    expect(accounts.statusCode).toBe(403);
    const prepare = await app.inject({
      method: 'POST',
      url: '/v1/sandbox/internal-transfers/prepare',
      headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrf, origin: 'http://localhost:80' },
      payload: {}
    });
    expect(prepare.statusCode).toBe(403);
    const events = await app.inject({
      method: 'GET',
      url: '/v1/sandbox/monitoring/operator-events',
      headers: { cookie: auth.cookie }
    });
    expect(events.statusCode).toBe(200);
    expect(JSON.stringify(events.json())).not.toContain('viewer-test-password');
  });

  it('allows prepared-only automation and always denies submission', async () => {
    app = buildApp({ mode: 'sandbox', sandboxClient: client, sandboxDatabasePath: ':memory:' });
    const headers = { authorization: 'Bearer automation-test-token' };
    const prepared = await app.inject({
      method: 'POST',
      url: '/v1/sandbox/internal-transfers/prepare',
      headers,
      payload: {
        sourceAccountId: '11111111-1111-4111-8111-111111111111',
        targetAccountId: '22222222-2222-4222-8222-222222222222',
        amountMinor: 1,
        currency: 'GBP',
        reference: 'Automated smoke',
        clientReference: 'automation-route-0001'
      }
    });
    expect(prepared.statusCode).toBe(201);
    const submit = await app.inject({
      method: 'POST',
      url: `/v1/sandbox/internal-transfers/${prepared.json().id}/submit`,
      headers,
      payload: {}
    });
    expect(submit.statusCode).toBe(403);
  });

  it('persists redacted provider failures and resolves them after recovery', async () => {
    const recoveringClient: SandboxInternalTransferClient = {
      getAccounts: vi.fn()
        .mockRejectedValueOnce(new OperationalFault(
          'Provider failed for 11111111-1111-4111-8111-111111111111 with Bearer secret-token',
          {
            category: 'rate_limit',
            severity: 'warning',
            retryable: true,
            httpStatus: 429
          }
        ))
        .mockResolvedValue([
          {
            id: '11111111-1111-4111-8111-111111111111',
            name: 'GBP source',
            currency: 'GBP',
            balance: 20,
            state: 'active'
          }
        ]),
      createInternalTransfer: vi.fn(),
      getTransaction: vi.fn()
    };
    app = buildApp({
      mode: 'sandbox',
      sandboxClient: recoveringClient,
      sandboxDatabasePath: ':memory:'
    });
    const auth = await login('viewer', 'viewer-test-password');
    const admin = await login();
    const failed = await app.inject({
      method: 'GET',
      url: '/v1/sandbox/accounts',
      headers: { cookie: admin.cookie }
    });
    expect(failed.statusCode).toBe(500);
    expect(failed.body).not.toContain('11111111');
    expect(failed.body).not.toContain('secret-token');

    const report = await app.inject({
      method: 'GET',
      url: '/v1/sandbox/monitoring/error-report',
      headers: { cookie: auth.cookie }
    });
    expect(report.json()).toMatchObject({
      health: 'degraded',
      unresolved: 1,
      warning: 1,
      retryable: 1
    });
    const errors = await app.inject({
      method: 'GET',
      url: '/v1/sandbox/monitoring/errors?limit=25',
      headers: { cookie: auth.cookie }
    });
    expect(errors.statusCode).toBe(200);
    expect(errors.body).toContain('[id]');
    expect(errors.body).not.toContain('secret-token');

    expect((await app.inject({
      method: 'GET',
      url: '/v1/sandbox/accounts',
      headers: { cookie: admin.cookie }
    })).statusCode).toBe(200);
    const recovered = await app.inject({
      method: 'GET',
      url: '/v1/sandbox/monitoring/error-report',
      headers: { cookie: auth.cookie }
    });
    expect(recovered.json()).toMatchObject({ health: 'clear', unresolved: 0 });
  });

  it('refuses production mode', () => {
    expect(() => buildApp({ mode: 'production' })).toThrow('Production mode is not implemented');
  });
});
