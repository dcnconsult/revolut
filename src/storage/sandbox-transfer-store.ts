import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SandboxInternalTransferRecord } from '../services/sandbox-internal-transfer-service.js';

export interface SandboxAuditEvent {
  id: number;
  transferId: string;
  eventType: string;
  state: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface OperatorAuditEvent {
  id: number;
  actor: string;
  role: string;
  action: string;
  outcome: string;
  transferId?: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface SandboxTransferStore {
  get(id: string): SandboxInternalTransferRecord | undefined;
  findByClientReference(clientReference: string): SandboxInternalTransferRecord | undefined;
  save(record: SandboxInternalTransferRecord, eventType: string, details?: Record<string, unknown>): void;
  list(limit: number): SandboxInternalTransferRecord[];
  listAuditEvents(limit: number): SandboxAuditEvent[];
  recordOperatorEvent(event: Omit<OperatorAuditEvent, 'id' | 'createdAt'>): void;
  listOperatorEvents(limit: number): OperatorAuditEvent[];
  summary(): { total: number; byState: Record<string, number>; latestUpdatedAt?: string };
  close(): void;
}

interface TransferRow {
  record_json: string;
}

interface AuditRow {
  id: number;
  transfer_id: string;
  event_type: string;
  state: string;
  details_json: string;
  created_at: string;
}

interface OperatorAuditRow {
  id: number;
  actor: string;
  role: string;
  action: string;
  outcome: string;
  transfer_id: string | null;
  details_json: string;
  created_at: string;
}

export class SQLiteSandboxTransferStore implements SandboxTransferStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path, { timeout: 5_000 });
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS sandbox_transfers (
        id TEXT PRIMARY KEY,
        client_reference TEXT NOT NULL UNIQUE,
        provider_transaction_id TEXT UNIQUE,
        state TEXT NOT NULL,
        record_json TEXT NOT NULL CHECK (json_valid(record_json)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sandbox_transfers_updated_at
        ON sandbox_transfers(updated_at DESC);
      CREATE TABLE IF NOT EXISTS sandbox_audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transfer_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        state TEXT NOT NULL,
        details_json TEXT NOT NULL CHECK (json_valid(details_json)),
        created_at TEXT NOT NULL,
        FOREIGN KEY (transfer_id) REFERENCES sandbox_transfers(id)
      );
      CREATE INDEX IF NOT EXISTS sandbox_audit_created_at
        ON sandbox_audit_events(created_at DESC);
      CREATE TABLE IF NOT EXISTS operator_audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor TEXT NOT NULL,
        role TEXT NOT NULL,
        action TEXT NOT NULL,
        outcome TEXT NOT NULL,
        transfer_id TEXT,
        details_json TEXT NOT NULL CHECK (json_valid(details_json)),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS operator_audit_created_at
        ON operator_audit_events(created_at DESC);
    `);
  }

  get(id: string) {
    const row = this.database.prepare(
      'SELECT record_json FROM sandbox_transfers WHERE id = ?'
    ).get(id) as TransferRow | undefined;
    return row ? this.parseRecord(row.record_json) : undefined;
  }

  findByClientReference(clientReference: string) {
    const row = this.database.prepare(
      'SELECT record_json FROM sandbox_transfers WHERE client_reference = ?'
    ).get(clientReference) as TransferRow | undefined;
    return row ? this.parseRecord(row.record_json) : undefined;
  }

  save(record: SandboxInternalTransferRecord, eventType: string, details: Record<string, unknown> = {}) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`
        INSERT INTO sandbox_transfers (
          id, client_reference, provider_transaction_id, state, record_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          provider_transaction_id = excluded.provider_transaction_id,
          state = excluded.state,
          record_json = excluded.record_json,
          updated_at = excluded.updated_at
      `).run(
        record.id,
        record.request.clientReference,
        record.providerTransactionId ?? null,
        record.state,
        JSON.stringify(record),
        record.createdAt,
        record.updatedAt
      );
      this.database.prepare(`
        INSERT INTO sandbox_audit_events (
          transfer_id, event_type, state, details_json, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(record.id, eventType, record.state, JSON.stringify(details), record.updatedAt);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  list(limit: number) {
    const rows = this.database.prepare(`
      SELECT record_json FROM sandbox_transfers ORDER BY updated_at DESC LIMIT ?
    `).all(limit) as unknown as TransferRow[];
    return rows.map(row => this.parseRecord(row.record_json));
  }

  listAuditEvents(limit: number) {
    const rows = this.database.prepare(`
      SELECT id, transfer_id, event_type, state, details_json, created_at
      FROM sandbox_audit_events ORDER BY id DESC LIMIT ?
    `).all(limit) as unknown as AuditRow[];
    return rows.map(row => ({
      id: Number(row.id),
      transferId: row.transfer_id,
      eventType: row.event_type,
      state: row.state,
      details: JSON.parse(row.details_json) as Record<string, unknown>,
      createdAt: row.created_at
    }));
  }

  recordOperatorEvent(event: Omit<OperatorAuditEvent, 'id' | 'createdAt'>) {
    this.database.prepare(`
      INSERT INTO operator_audit_events (
        actor, role, action, outcome, transfer_id, details_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.actor,
      event.role,
      event.action,
      event.outcome,
      event.transferId ?? null,
      JSON.stringify(event.details),
      new Date().toISOString()
    );
  }

  listOperatorEvents(limit: number) {
    const rows = this.database.prepare(`
      SELECT id, actor, role, action, outcome, transfer_id, details_json, created_at
      FROM operator_audit_events ORDER BY id DESC LIMIT ?
    `).all(limit) as unknown as OperatorAuditRow[];
    return rows.map(row => ({
      id: Number(row.id),
      actor: row.actor,
      role: row.role,
      action: row.action,
      outcome: row.outcome,
      ...(row.transfer_id ? { transferId: row.transfer_id } : {}),
      details: JSON.parse(row.details_json) as Record<string, unknown>,
      createdAt: row.created_at
    }));
  }

  summary() {
    const totalRow = this.database.prepare(
      'SELECT COUNT(*) AS total, MAX(updated_at) AS latest FROM sandbox_transfers'
    ).get() as { total: number; latest: string | null };
    const stateRows = this.database.prepare(
      'SELECT state, COUNT(*) AS count FROM sandbox_transfers GROUP BY state'
    ).all() as unknown as Array<{ state: string; count: number }>;
    return {
      total: Number(totalRow.total),
      byState: Object.fromEntries(stateRows.map(row => [row.state, Number(row.count)])),
      ...(totalRow.latest ? { latestUpdatedAt: totalRow.latest } : {})
    };
  }

  close() {
    this.database.close();
  }

  private parseRecord(json: string) {
    return JSON.parse(json) as SandboxInternalTransferRecord;
  }
}
