import { describe, expect, it } from 'vitest';
import { MockBankingProvider } from '../src/adapters/mock-provider.js';
import { PaymentOrchestrator } from '../src/services/payment-orchestrator.js';
import { InMemoryPaymentStore } from '../src/storage/payment-store.js';

const request = {
  sourceAccountId: '8d43a0d9-f040-4c98-b9de-89cf30ab9807',
  amountMinor: 100_00,
  currency: 'EUR',
  beneficiary: {
    legalName: 'Example GmbH', accountType: 'business' as const, country: 'DE', currency: 'EUR',
    iban: 'DE89370400440532013000', bic: 'COBADEFFXXX'
  },
  reference: 'Invoice 2026-001',
  clientReference: 'rev-2026-000001'
};

describe('PaymentOrchestrator', () => {
  it('prepares and submits an adequately funded payment', async () => {
    const service = new PaymentOrchestrator(new MockBankingProvider(), new InMemoryPaymentStore());
    const prepared = await service.prepare(request);
    expect(prepared.state).toBe('funds_confirmed');
    expect(prepared.fundsVerification?.aggregateDebitMinor).toBe(10_025);

    const submitted = await service.submit(prepared.id);
    expect(submitted.state).toBe('pending');
    expect(submitted.providerTransactionId).toBeTruthy();
  });

  it('is idempotent by client reference during preparation', async () => {
    const service = new PaymentOrchestrator(new MockBankingProvider(), new InMemoryPaymentStore());
    const first = await service.prepare(request);
    const second = await service.prepare(request);
    expect(second.id).toBe(first.id);
  });

  it('rejects a batch whose aggregate debit exceeds the available balance', async () => {
    class LowBalanceProvider extends MockBankingProvider {
      override async getBalance(accountId: string, currency: string) {
        return { accountId, currency, availableMinor: 15_000 };
      }
    }

    const service = new PaymentOrchestrator(new LowBalanceProvider(), new InMemoryPaymentStore());
    const results = await service.prepareMany([
      { request: { ...request, amountMinor: 10_000, clientReference: 'rev-2026-batch-001' }, ingestion: { method: 'manual' } },
      { request: { ...request, amountMinor: 10_000, clientReference: 'rev-2026-batch-002' }, ingestion: { method: 'manual' } }
    ], true);

    expect(results).toHaveLength(2);
    expect(results.every(result => result.status === 'rejected')).toBe(true);
    expect(results.map(result => result.status === 'rejected' ? result.error : '')).toEqual([
      expect.stringContaining('Insufficient aggregate available funds'),
      expect.stringContaining('Insufficient aggregate available funds')
    ]);
  });
});
