import { describe, expect, it, vi } from 'vitest';
import type {
  RevolutSandboxAccount,
  SandboxInternalTransferClient
} from '../src/adapters/revolut-sandbox-client.js';
import { SandboxInternalTransferService } from '../src/services/sandbox-internal-transfer-service.js';

const accounts: RevolutSandboxAccount[] = [
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
];

function createClient(): SandboxInternalTransferClient {
  return {
    getAccounts: vi.fn(async () => structuredClone(accounts)),
    createInternalTransfer: vi.fn(async () => ({
      id: '33333333-3333-4333-8333-333333333333',
      state: 'completed'
    })),
    getTransaction: vi.fn(async transactionId => ({
      id: transactionId,
      state: 'completed'
    }))
  };
}

const request = {
  sourceAccountId: accounts[0]!.id,
  targetAccountId: accounts[1]!.id,
  amountMinor: 1,
  currency: 'GBP',
  reference: 'Sandbox internal test',
  clientReference: 'sandbox-live-0001'
};

describe('SandboxInternalTransferService', () => {
  it('prepares and explicitly submits an owned same-currency Sandbox transfer', async () => {
    const client = createClient();
    const service = new SandboxInternalTransferService(client, 1_000);
    const prepared = await service.prepare(request);
    expect(prepared.state).toBe('prepared');

    const submitted = await service.submit(prepared.id);
    expect(submitted.state).toBe('completed');
    expect(submitted.providerTransactionId).toBe('33333333-3333-4333-8333-333333333333');
    expect(client.createInternalTransfer).toHaveBeenCalledWith({
      requestId: prepared.id,
      sourceAccountId: request.sourceAccountId,
      targetAccountId: request.targetAccountId,
      amount: 0.01,
      currency: 'GBP',
      reference: request.reference
    });
  });

  it('is idempotent by client reference and does not submit twice', async () => {
    const client = createClient();
    const service = new SandboxInternalTransferService(client, 1_000);
    const first = await service.prepare(request);
    const second = await service.prepare(request);
    expect(second.id).toBe(first.id);

    await service.submit(first.id);
    await service.submit(first.id);
    expect(client.createInternalTransfer).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown accounts, currency mismatches, and excessive amounts', async () => {
    const service = new SandboxInternalTransferService(createClient(), 1_000);
    await expect(service.prepare({
      ...request,
      sourceAccountId: '44444444-4444-4444-8444-444444444444'
    })).rejects.toThrow('not owned');
    await expect(service.prepare({
      ...request,
      clientReference: 'sandbox-live-0002',
      currency: 'EUR'
    })).rejects.toThrow('currencies must match');
    await expect(service.prepare({
      ...request,
      clientReference: 'sandbox-live-0003',
      amountMinor: 1_001
    })).rejects.toThrow('configured maximum');
  });
});
