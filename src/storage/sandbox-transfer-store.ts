import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SandboxInternalTransferRecord } from '../services/sandbox-internal-transfer-service.js';
import type {
  OperationalErrorInput,
  OperationalErrorPersistence,
  OperationalErrorRecord,
  OperationalErrorReport
} from '../operations/operational-error-monitor.js';

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

export interface SandboxTransferStore extends OperationalErrorPersistence {
  get(id: string): SandboxInternalTransferRecord | undefined;
  findByClientReference(clientReference: string): SandboxInternalTransferRecord | undefined;
  save(record: SandboxInternalTransferRecord, eventType: string, details?: Record<string, unknown>): void;
  list(limit: number): SandboxInternalTransferRecord[];
  listAuditEvents(limit: number): SandboxAuditEvent[];
  recordOperatorEvent(event: Omit<OperatorAuditEvent, 'id' | 'createdAt'>): void;
  listOperatorEvents(limit: number): OperatorAuditEvent[];
  recordTotpStep(username: string, step: number): boolean;
  consumeRecoveryCode(username: string, codeHash: string): boolean;
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

interface OperationalErrorRow {
  id: number;
  fingerprint: string;
  category: OperationalErrorRecord['category'];
  severity: OperationalErrorRecord['severity'];
  operation: string;
  safe_message: string;
  retryable: number;
  http_status: number | null;
  context_json: string;
  occurrence_count: number;
  first_occurred_at: string;
  last_occurred_at: string;
  resolved_at: string | null;
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
      CREATE TABLE IF NOT EXISTS operator_totp_steps (
        username TEXT NOT NULL,
        time_step INTEGER NOT NULL,
        used_at TEXT NOT NULL,
        PRIMARY KEY (username, time_step)
      );
      CREATE TABLE IF NOT EXISTS operator_recovery_codes_used (
        username TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        used_at TEXT NOT NULL,
        PRIMARY KEY (username, code_hash)
      );
      CREATE TABLE IF NOT EXISTS operational_errors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fingerprint TEXT NOT NULL UNIQUE,
        category TEXT NOT NULL,
        severity TEXT NOT NULL,
        operation TEXT NOT NULL,
        safe_message TEXT NOT NULL,
        retryable INTEGER NOT NULL CHECK (retryable IN (0, 1)),
        http_status INTEGER,
        context_json TEXT NOT NULL CHECK (json_valid(context_json)),
        occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
        first_occurred_at TEXT NOT NULL,
        last_occurred_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS operational_errors_last_occurred
        ON operational_errors(last_occurred_at DESC);
      CREATE INDEX IF NOT EXISTS operational_errors_unresolved
        ON operational_errors(resolved_at, severity, last_occurred_at DESC);
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

  recordTotpStep(username: string, step: number) {
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO operator_totp_steps (username, time_step, used_at)
      VALUES (?, ?, ?)
    `).run(username, step, new Date().toISOString());
    return Number(result.changes) === 1;
  }

  consumeRecoveryCode(username: string, codeHash: string) {
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO operator_recovery_codes_used (username, code_hash, used_at)
      VALUES (?, ?, ?)
    `).run(username, codeHash, new Date().toISOString());
    return Number(result.changes) === 1;
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

  recordOperationalError(error: OperationalErrorInput) {
    this.database.prepare(`
      INSERT INTO operational_errors (
        fingerprint, category, severity, operation, safe_message, retryable,
        http_status, context_json, occurrence_count, first_occurred_at,
        last_occurred_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)
      ON CONFLICT(fingerprint) DO UPDATE SET
        category = excluded.category,
        severity = excluded.severity,
        retryable = excluded.retryable,
        http_status = excluded.http_status,
        context_json = excluded.context_json,
        occurrence_count = operational_errors.occurrence_count + 1,
        last_occurred_at = excluded.last_occurred_at,
        resolved_at = NULL
    `).run(
      error.fingerprint,
      error.category,
      error.severity,
      error.operation,
      error.safeMessage,
      error.retryable ? 1 : 0,
      error.httpStatus ?? null,
      JSON.stringify(error.context),
      error.occurredAt,
      error.occurredAt
    );
  }

  resolveOperationalErrors(operation: string, resolvedAt: string) {
    this.database.prepare(`
      UPDATE operational_errors SET resolved_at = ?
      WHERE operation = ? AND resolved_at IS NULL
    `).run(resolvedAt, operation);
  }

  listOperationalErrors(limit: number) {
    const rows = this.database.prepare(`
      SELECT id, fingerprint, category, severity, operation, safe_message,
        retryable, http_status, context_json, occurrence_count,
        first_occurred_at, last_occurred_at, resolved_at
      FROM operational_errors ORDER BY last_occurred_at DESC LIMIT ?
    `).all(limit) as unknown as OperationalErrorRow[];
    return rows.map(row => ({
      id: Number(row.id),
      fingerprint: row.fingerprint,
      category: row.category,
      severity: row.severity,
      operation: row.operation,
      safeMessage: row.safe_message,
      retryable: row.retryable === 1,
      ...(row.http_status === null ? {} : { httpStatus: Number(row.http_status) }),
      context: JSON.parse(row.context_json) as Record<string, string | number | boolean>,
      occurrenceCount: Number(row.occurrence_count),
      occurredAt: row.last_occurred_at,
      firstOccurredAt: row.first_occurred_at,
      lastOccurredAt: row.last_occurred_at,
      ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {})
    }));
  }

  operationalErrorReport(): OperationalErrorReport {
    const rows = this.database.prepare(`
      SELECT category, severity, retryable, occurrence_count, last_occurred_at
      FROM operational_errors WHERE resolved_at IS NULL
    `).all() as unknown as Array<{
      category: string;
      severity: string;
      retryable: number;
      occurrence_count: number;
      last_occurred_at: string;
    }>;
    const critical = rows.filter(row => row.severity === 'critical').length;
    const warning = rows.filter(row => row.severity === 'warning').length;
    const byCategory: Record<string, number> = {};
    for (const row of rows) byCategory[row.category] = (byCategory[row.category] ?? 0) + 1;
    const latestOccurredAt = rows
      .map(row => row.last_occurred_at)
      .sort((left, right) => right.localeCompare(left))[0];
    return {
      health: critical > 0 ? 'blocked' : warning > 0 ? 'degraded' : 'clear',
      unresolved: rows.length,
      critical,
      warning,
      retryable: rows.filter(row => row.retryable === 1).length,
      totalOccurrences: rows.reduce((total, row) => total + Number(row.occurrence_count), 0),
      byCategory,
      ...(latestOccurredAt ? { latestOccurredAt } : {}),
      generatedAt: new Date().toISOString()
    };
  }

  close() {
    this.database.close();
  }

  private parseRecord(json: string) {
    return JSON.parse(json) as SandboxInternalTransferRecord;
  }
}
