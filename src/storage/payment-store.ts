import type { PaymentRecord } from '../domain/payment.js';

export interface PaymentStore {
  save(record: PaymentRecord): Promise<void>;
  get(id: string): Promise<PaymentRecord | undefined>;
  findByClientReference(clientReference: string): Promise<PaymentRecord | undefined>;
}

export class InMemoryPaymentStore implements PaymentStore {
  private readonly records = new Map<string, PaymentRecord>();

  async save(record: PaymentRecord) { this.records.set(record.id, structuredClone(record)); }
  async get(id: string) { const record = this.records.get(id); return record ? structuredClone(record) : undefined; }
  async findByClientReference(clientReference: string) {
    return [...this.records.values()].find(r => r.request.clientReference === clientReference);
  }
}
