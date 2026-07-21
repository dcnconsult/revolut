import { randomUUID } from 'node:crypto';
import type { BankingProvider } from '../adapters/banking-provider.js';
import { env } from '../config/env.js';
import type { PaymentRecord, PaymentRequest, PaymentState } from '../domain/payment.js';
import type { PaymentStore } from '../storage/payment-store.js';

const TERMINAL: ReadonlySet<PaymentState> = new Set(['completed', 'failed', 'reverted', 'declined']);

export class PaymentOrchestrator {
  constructor(private readonly provider: BankingProvider, private readonly store: PaymentStore) {}

  async prepare(request: PaymentRequest): Promise<PaymentRecord> {
    const duplicate = await this.store.findByClientReference(request.clientReference);
    if (duplicate) return duplicate;

    if (!env.allowedCurrencies.has(request.currency)) throw new Error(`Currency ${request.currency} is not allowed.`);
    if (request.amountMinor > env.PAYMENT_MAX_AMOUNT_MINOR) throw new Error('Payment exceeds configured maximum.');

    const requiredFields = await this.provider.discoverRequiredFields(request);
    const missing = requiredFields.filter(path => !this.hasPath(request, path));
    if (missing.length) throw new Error(`Missing provider-required fields: ${missing.join(', ')}`);

    const validation = await this.provider.validateBeneficiary(request);
    const hardStop = validation.result === 'no_match';
    const review = validation.result === 'close_match' || validation.result === 'temporarily_unavailable';
    if (hardStop) throw new Error('Beneficiary name validation failed.');

    const quote = await this.provider.quoteTransfer(request);
    const balance = await this.provider.getBalance(request.sourceAccountId, request.currency);
    if (balance.availableMinor < quote.debitAmountMinor) throw new Error('Insufficient available funds including fees.');

    const now = new Date().toISOString();
    const state: PaymentState = review ? 'manual_review' : 'funds_confirmed';
    const record: PaymentRecord = { id: randomUUID(), state, request, validation, quote, createdAt: now, updatedAt: now };
    await this.store.save(record);
    return record;
  }

  async submit(id: string): Promise<PaymentRecord> {
    const record = await this.mustGet(id);
    if (record.state === 'manual_review') throw new Error('Manual review is required before submission.');
    if (record.providerTransactionId) return record;
    if (record.state !== 'funds_confirmed') throw new Error(`Payment cannot be submitted from state ${record.state}.`);

    const result = await this.provider.submitTransfer(record.request, record.request.clientReference);
    const updated = { ...record, providerTransactionId: result.transactionId, state: result.state, updatedAt: new Date().toISOString() };
    await this.store.save(updated);
    return updated;
  }

  async reconcile(id: string): Promise<PaymentRecord> {
    const record = await this.mustGet(id);
    if (!record.providerTransactionId || TERMINAL.has(record.state)) return record;
    const result = await this.provider.getTransaction(record.providerTransactionId);
    const updated = { ...record, state: result.state, updatedAt: new Date().toISOString() };
    await this.store.save(updated);
    return updated;
  }

  async applyProviderState(transactionId: string, state: PaymentState): Promise<PaymentRecord | undefined> {
    // Replace with a providerTransactionId index in persistent storage.
    const candidate = await this.store.findByClientReference(transactionId);
    if (!candidate) return undefined;
    const updated = { ...candidate, state, updatedAt: new Date().toISOString() };
    await this.store.save(updated);
    return updated;
  }

  async get(id: string) { return this.mustGet(id); }

  private async mustGet(id: string) {
    const record = await this.store.get(id);
    if (!record) throw new Error('Payment not found.');
    return record;
  }

  private hasPath(value: unknown, path: string) {
    return path.split('.').reduce<unknown>((node, key) => {
      if (node && typeof node === 'object' && key in node) return (node as Record<string, unknown>)[key];
      return undefined;
    }, value) !== undefined;
  }
}
