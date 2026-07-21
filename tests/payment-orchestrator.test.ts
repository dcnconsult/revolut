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
});
