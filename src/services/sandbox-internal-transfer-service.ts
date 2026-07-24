import { randomUUID } from 'node:crypto';
import type {
  RevolutSandboxAccount,
  SandboxInternalTransferClient
} from '../adapters/revolut-sandbox-client.js';

export interface SandboxInternalTransferRequest {
  sourceAccountId: string;
  targetAccountId: string;
  amountMinor: number;
  currency: string;
  reference: string;
  clientReference: string;
}

export interface SandboxInternalTransferRecord {
  id: string;
  state: 'prepared' | 'submitted' | 'pending' | 'completed' | 'failed' | 'reverted' | 'declined';
  request: SandboxInternalTransferRequest;
  providerTransactionId?: string;
  createdAt: string;
  updatedAt: string;
}

const providerStates = new Set(['pending', 'completed', 'failed', 'reverted', 'declined']);

export class SandboxInternalTransferService {
  private readonly records = new Map<string, SandboxInternalTransferRecord>();

  constructor(
    private readonly client: SandboxInternalTransferClient,
    private readonly maximumAmountMinor: number
  ) {}

  async listAccounts() {
    const accounts = await this.client.getAccounts();
    return accounts.map(account => ({
      id: account.id,
      name: account.name ?? '(Sandbox account)',
      currency: account.currency,
      balanceMinor: this.majorToMinor(account.balance),
      state: account.state
    }));
  }

  async prepare(request: SandboxInternalTransferRequest) {
    if (request.amountMinor > this.maximumAmountMinor) {
      throw new Error(`Sandbox transfer exceeds the configured maximum of ${this.maximumAmountMinor} minor units.`);
    }
    const existing = [...this.records.values()].find(
      record => record.request.clientReference === request.clientReference
    );
    if (existing) {
      if (JSON.stringify(existing.request) !== JSON.stringify(request)) {
        throw new Error('Idempotency conflict: clientReference belongs to a different Sandbox transfer.');
      }
      return structuredClone(existing);
    }

    const accounts = await this.client.getAccounts();
    const source = this.findAccount(accounts, request.sourceAccountId, 'source');
    const target = this.findAccount(accounts, request.targetAccountId, 'target');
    if (source.id === target.id) throw new Error('Source and target Sandbox accounts must be different.');
    if (source.state !== 'active' || target.state !== 'active') {
      throw new Error('Source and target Sandbox accounts must both be active.');
    }
    if (source.currency !== request.currency || target.currency !== request.currency) {
      throw new Error('Source, target, and request currencies must match.');
    }
    if (this.majorToMinor(source.balance) < request.amountMinor) {
      throw new Error('The Sandbox source account has insufficient test funds.');
    }

    const now = new Date().toISOString();
    const record: SandboxInternalTransferRecord = {
      id: randomUUID(),
      state: 'prepared',
      request,
      createdAt: now,
      updatedAt: now
    };
    this.records.set(record.id, record);
    return structuredClone(record);
  }

  async submit(id: string) {
    const record = this.mustGet(id);
    if (record.providerTransactionId) return structuredClone(record);
    if (record.state !== 'prepared') throw new Error(`Sandbox transfer cannot be submitted from ${record.state}.`);

    const accounts = await this.client.getAccounts();
    const source = this.findAccount(accounts, record.request.sourceAccountId, 'source');
    const target = this.findAccount(accounts, record.request.targetAccountId, 'target');
    if (source.currency !== record.request.currency || target.currency !== record.request.currency) {
      throw new Error('Sandbox account currency changed after preparation.');
    }
    if (this.majorToMinor(source.balance) < record.request.amountMinor) {
      throw new Error('Sandbox test funds no longer cover the prepared transfer.');
    }

    const result = await this.client.createInternalTransfer({
      requestId: record.id,
      sourceAccountId: record.request.sourceAccountId,
      targetAccountId: record.request.targetAccountId,
      amount: record.request.amountMinor / 100,
      currency: record.request.currency,
      reference: record.request.reference
    });
    const updated: SandboxInternalTransferRecord = {
      ...record,
      providerTransactionId: result.id,
      state: this.mapProviderState(result.state),
      updatedAt: new Date().toISOString()
    };
    this.records.set(id, updated);
    return structuredClone(updated);
  }

  async reconcile(id: string) {
    const record = this.mustGet(id);
    if (!record.providerTransactionId || this.isTerminal(record.state)) return structuredClone(record);
    const result = await this.client.getTransaction(record.providerTransactionId);
    const updated: SandboxInternalTransferRecord = {
      ...record,
      state: this.mapProviderState(result.state),
      updatedAt: new Date().toISOString()
    };
    this.records.set(id, updated);
    return structuredClone(updated);
  }

  get(id: string) {
    return structuredClone(this.mustGet(id));
  }

  private mustGet(id: string) {
    const record = this.records.get(id);
    if (!record) throw new Error('Sandbox transfer not found.');
    return record;
  }

  private findAccount(accounts: RevolutSandboxAccount[], id: string, description: string) {
    const account = accounts.find(candidate => candidate.id === id);
    if (!account) throw new Error(`The ${description} account is not owned by this Sandbox business.`);
    return account;
  }

  private majorToMinor(value: number) {
    const minor = Math.round(value * 100);
    if (!Number.isSafeInteger(minor)) throw new Error('Revolut Sandbox returned an invalid account balance.');
    return minor;
  }

  private mapProviderState(value: string): SandboxInternalTransferRecord['state'] {
    return providerStates.has(value)
      ? value as SandboxInternalTransferRecord['state']
      : 'submitted';
  }

  private isTerminal(state: SandboxInternalTransferRecord['state']) {
    return ['completed', 'failed', 'reverted', 'declined'].includes(state);
  }
}
