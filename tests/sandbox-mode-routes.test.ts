import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { SandboxInternalTransferClient } from '../src/adapters/revolut-sandbox-client.js';
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

  it('reports the real Sandbox provider and does not register mock payment routes', async () => {
    app = buildApp({ mode: 'sandbox', sandboxClient: client });
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.json()).toEqual({
      status: 'ok',
      mode: 'sandbox',
      provider: 'revolut-sandbox-internal-transfer'
    });

    const mockPayment = await app.inject({ method: 'POST', url: '/v1/payments/prepare', payload: {} });
    expect(mockPayment.statusCode).toBe(404);

    const accountResponse = await app.inject({ method: 'GET', url: '/v1/sandbox/accounts' });
    expect(accountResponse.statusCode).toBe(200);
    expect(accountResponse.json()[0]).toMatchObject({
      currency: 'GBP',
      balanceMinor: 2_000,
      state: 'active'
    });
  });

  it('uses prepare then submit for an internal Sandbox transfer', async () => {
    app = buildApp({ mode: 'sandbox', sandboxClient: client });
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
      }
    });
    expect(preparedResponse.statusCode).toBe(201);
    expect(preparedResponse.json().state).toBe('prepared');

    const submittedResponse = await app.inject({
      method: 'POST',
      url: `/v1/sandbox/internal-transfers/${preparedResponse.json().id}/submit`
    });
    expect(submittedResponse.statusCode).toBe(200);
    expect(submittedResponse.json().state).toBe('completed');
  });

  it('refuses production mode', () => {
    expect(() => buildApp({ mode: 'production' })).toThrow('Production mode is not implemented');
  });
});
