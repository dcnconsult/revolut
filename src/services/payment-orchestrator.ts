import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { BankingProvider } from '../adapters/banking-provider.js';
import { env } from '../config/env.js';
import type {
  FundsVerification,
  NameValidationResult,
  PaymentIngestion,
  PaymentRecord,
  PaymentRequest,
  PaymentState,
  TransferQuote
} from '../domain/payment.js';
import type { PaymentStore } from '../storage/payment-store.js';

const TERMINAL: ReadonlySet<PaymentState> = new Set(['completed', 'failed', 'reverted', 'declined']);

export interface PaymentPreparationInput {
  request: PaymentRequest;
  ingestion: PaymentIngestion;
}

export type PaymentPreparationResult =
  | { status: 'prepared' | 'existing'; record: PaymentRecord }
  | { status: 'rejected'; error: string };

interface PaymentAssessment {
  validation: NameValidationResult;
  quote: TransferQuote;
  state: PaymentState;
}

interface PendingPreparation {
  index: number;
  input: PaymentPreparationInput;
  assessment: PaymentAssessment;
}

export class PaymentOrchestrator {
  constructor(private readonly provider: BankingProvider, private readonly store: PaymentStore) {}

  async prepare(request: PaymentRequest, ingestion: PaymentIngestion = { method: 'manual' }): Promise<PaymentRecord> {
    const [result] = await this.prepareMany([{ request, ingestion }], true);
    if (!result) throw new Error('Payment preparation produced no result.');
    if (result.status === 'rejected') throw new Error(result.error);
    return result.record;
  }

  async prepareMany(inputs: PaymentPreparationInput[], atomic = true): Promise<PaymentPreparationResult[]> {
    const results: Array<PaymentPreparationResult | undefined> = new Array(inputs.length);
    const pending: PendingPreparation[] = [];
    const batchReferences = new Map<string, PaymentRequest>();

    for (const [index, input] of inputs.entries()) {
      const duplicateInBatch = batchReferences.get(input.request.clientReference);
      if (duplicateInBatch) {
        results[index] = {
          status: 'rejected',
          error: isDeepStrictEqual(duplicateInBatch, input.request)
            ? 'The batch contains the same clientReference more than once.'
            : 'The batch contains conflicting payments with the same clientReference.'
        };
        continue;
      }
      batchReferences.set(input.request.clientReference, input.request);

      const existing = await this.store.findByClientReference(input.request.clientReference);
      if (existing) {
        results[index] = isDeepStrictEqual(existing.request, input.request)
          ? { status: 'existing', record: existing }
          : { status: 'rejected', error: 'Idempotency conflict: clientReference already belongs to a different payment.' };
        continue;
      }

      try {
        pending.push({ index, input, assessment: await this.assess(input.request) });
      } catch (error) {
        results[index] = { status: 'rejected', error: (error as Error).message };
      }
    }

    if (atomic && results.some(result => result?.status === 'rejected')) {
      for (const item of pending) {
        results[item.index] = { status: 'rejected', error: 'Atomic batch aborted because another payment failed validation.' };
      }
      return results.map(result => result ?? { status: 'rejected', error: 'Atomic batch aborted.' });
    }

    const groups = new Map<string, { items: PendingPreparation[]; aggregateDebitMinor: number }>();
    for (const item of pending) {
      const key = `${item.input.request.sourceAccountId}|${item.input.request.currency}`;
      const group = groups.get(key) ?? { items: [], aggregateDebitMinor: 0 };
      group.items.push(item);
      group.aggregateDebitMinor += item.assessment.quote.debitAmountMinor;
      groups.set(key, group);
    }

    const fundsByIndex = new Map<number, FundsVerification>();
    let fundsFailure = false;
    for (const group of groups.values()) {
      const first = group.items[0];
      if (!first) continue;
      const { sourceAccountId, currency } = first.input.request;
      const balance = await this.provider.getBalance(sourceAccountId, currency);
      if (balance.currency !== currency || balance.accountId !== sourceAccountId) {
        for (const item of group.items) {
          results[item.index] = { status: 'rejected', error: 'Provider returned a balance for the wrong account or currency.' };
        }
        fundsFailure = true;
        continue;
      }
      if (balance.availableMinor < group.aggregateDebitMinor) {
        for (const item of group.items) {
          results[item.index] = {
            status: 'rejected',
            error: `Insufficient aggregate available funds including fees: required ${group.aggregateDebitMinor}, available ${balance.availableMinor} ${currency} minor units.`
          };
        }
        fundsFailure = true;
        continue;
      }

      const checkedAt = new Date().toISOString();
      for (const item of group.items) {
        fundsByIndex.set(item.index, {
          accountId: sourceAccountId,
          currency,
          availableMinor: balance.availableMinor,
          paymentDebitMinor: item.assessment.quote.debitAmountMinor,
          aggregateDebitMinor: group.aggregateDebitMinor,
          checkedAt
        });
      }
    }

    if (atomic && fundsFailure) {
      for (const item of pending) {
        if (!results[item.index]) {
          results[item.index] = { status: 'rejected', error: 'Atomic batch aborted because another payment failed the aggregate funds check.' };
        }
      }
      return results.map(result => result ?? { status: 'rejected', error: 'Atomic batch aborted.' });
    }

    const records: PaymentRecord[] = [];
    for (const item of pending) {
      if (results[item.index]?.status === 'rejected') continue;
      const fundsVerification = fundsByIndex.get(item.index);
      if (!fundsVerification) {
        results[item.index] = { status: 'rejected', error: 'Funds verification result is unavailable.' };
        continue;
      }

      const now = new Date().toISOString();
      const record: PaymentRecord = {
        id: randomUUID(),
        state: item.assessment.state,
        request: item.input.request,
        ingestion: item.input.ingestion,
        validation: item.assessment.validation,
        quote: item.assessment.quote,
        fundsVerification,
        createdAt: now,
        updatedAt: now
      };
      records.push(record);
      results[item.index] = { status: 'prepared', record };
    }

    await this.store.saveMany(records);
    return results.map(result => result ?? { status: 'rejected', error: 'Payment was not prepared.' });
  }

  async submit(id: string): Promise<PaymentRecord> {
    const record = await this.mustGet(id);
    if (record.state === 'manual_review') throw new Error('Manual review is required before submission.');
    if (record.providerTransactionId) return record;
    if (record.state !== 'funds_confirmed') throw new Error(`Payment cannot be submitted from state ${record.state}.`);

    const currentQuote = await this.provider.quoteTransfer(record.request);
    if (record.quote && (
      currentQuote.currency !== record.quote.currency ||
      currentQuote.feeMinor !== record.quote.feeMinor ||
      currentQuote.debitAmountMinor !== record.quote.debitAmountMinor
    )) {
      const updated: PaymentRecord = {
        ...record,
        state: 'manual_review',
        quote: currentQuote,
        failureReason: 'The provider quote changed after preparation; review and re-prepare before submission.',
        updatedAt: new Date().toISOString()
      };
      await this.store.save(updated);
      throw new Error(updated.failureReason);
    }

    const balance = await this.provider.getBalance(record.request.sourceAccountId, record.request.currency);
    if (balance.availableMinor < currentQuote.debitAmountMinor) {
      const updated: PaymentRecord = {
        ...record,
        state: 'manual_review',
        failureReason: 'Available funds no longer cover the payment and current fee.',
        fundsVerification: {
          accountId: record.request.sourceAccountId,
          currency: record.request.currency,
          availableMinor: balance.availableMinor,
          paymentDebitMinor: currentQuote.debitAmountMinor,
          aggregateDebitMinor: currentQuote.debitAmountMinor,
          checkedAt: new Date().toISOString()
        },
        updatedAt: new Date().toISOString()
      };
      await this.store.save(updated);
      throw new Error(updated.failureReason);
    }

    const result = await this.provider.submitTransfer(record.request, record.request.clientReference);
    const updated: PaymentRecord = {
      ...record,
      providerTransactionId: result.transactionId,
      state: result.state,
      quote: currentQuote,
      fundsVerification: {
        accountId: record.request.sourceAccountId,
        currency: record.request.currency,
        availableMinor: balance.availableMinor,
        paymentDebitMinor: currentQuote.debitAmountMinor,
        aggregateDebitMinor: currentQuote.debitAmountMinor,
        checkedAt: new Date().toISOString()
      },
      updatedAt: new Date().toISOString()
    };
    await this.store.save(updated);
    return updated;
  }

  async reconcile(id: string): Promise<PaymentRecord> {
    const record = await this.mustGet(id);
    if (!record.providerTransactionId || TERMINAL.has(record.state)) return record;
    const result = await this.provider.getTransaction(record.providerTransactionId);
    const updated: PaymentRecord = { ...record, state: result.state, updatedAt: new Date().toISOString() };
    await this.store.save(updated);
    return updated;
  }

  async applyProviderState(transactionId: string, state: PaymentState): Promise<PaymentRecord | undefined> {
    const candidate = await this.store.findByProviderTransactionId(transactionId);
    if (!candidate) return undefined;
    const updated: PaymentRecord = { ...candidate, state, updatedAt: new Date().toISOString() };
    await this.store.save(updated);
    return updated;
  }

  async get(id: string) {
    return this.mustGet(id);
  }

  private async assess(request: PaymentRequest): Promise<PaymentAssessment> {
    if (!env.allowedCurrencies.has(request.currency)) throw new Error(`Currency ${request.currency} is not allowed.`);
    if (request.amountMinor > env.PAYMENT_MAX_AMOUNT_MINOR) throw new Error('Payment exceeds configured maximum.');

    const requiredFields = await this.provider.discoverRequiredFields(request);
    const missing = requiredFields.filter(path => !this.hasPath(request, path));
    if (missing.length) throw new Error(`Missing provider-required fields: ${missing.join(', ')}`);

    const validation = await this.provider.validateBeneficiary(request);
    if (validation.result === 'no_match') throw new Error('Beneficiary name validation failed.');
    const review = validation.result === 'close_match' ||
      validation.result === 'temporarily_unavailable' ||
      (validation.result === 'cannot_be_checked' && env.PAYMENT_REQUIRE_NAME_MATCH);

    const quote = await this.provider.quoteTransfer(request);
    if (quote.currency !== request.currency) throw new Error('Provider quote currency does not match the payment currency.');
    if (!Number.isInteger(quote.feeMinor) || quote.feeMinor < 0) throw new Error('Provider quote contains an invalid fee.');
    if (!Number.isInteger(quote.debitAmountMinor) || quote.debitAmountMinor < request.amountMinor) {
      throw new Error('Provider quote contains an invalid debit amount.');
    }

    return { validation, quote, state: review ? 'manual_review' : 'funds_confirmed' };
  }

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
