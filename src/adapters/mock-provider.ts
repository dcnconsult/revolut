import { randomUUID } from 'node:crypto';
import type { BankingProvider } from './banking-provider.js';
import type { PaymentRequest, SubmitResult } from '../domain/payment.js';

export class MockBankingProvider implements BankingProvider {
  private readonly transactions = new Map<string, SubmitResult>();

  async getBalance(accountId: string, currency: string) {
    return { accountId, currency, availableMinor: 50_000_000 };
  }

  async discoverRequiredFields(payment: PaymentRequest) {
    const fields: string[] = [];
    if (payment.beneficiary.country !== 'GB' && payment.currency === 'EUR') fields.push('beneficiary.iban');
    if (payment.amountMinor >= 1_000_000) fields.push('purposeCode');
    return fields;
  }

  async validateBeneficiary(payment: PaymentRequest) {
    return { result: 'match' as const, matchedName: payment.beneficiary.legalName, source: 'mock' as const };
  }

  async quoteTransfer(payment: PaymentRequest) {
    const feeMinor = 25;
    return {
      feeMinor,
      debitAmountMinor: payment.amountMinor + feeMinor,
      currency: payment.currency,
      estimatedDelivery: new Date(Date.now() + 86_400_000).toISOString()
    };
  }

  async submitTransfer(_payment: PaymentRequest, _idempotencyKey: string) {
    const transactionId = randomUUID();
    const result: SubmitResult = { transactionId, state: 'pending' };
    this.transactions.set(transactionId, result);
    return result;
  }

  async getTransaction(transactionId: string) {
    return this.transactions.get(transactionId) ?? { transactionId, state: 'failed' };
  }
}
