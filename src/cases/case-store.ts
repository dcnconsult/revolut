import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonicalJson, sha256 } from './canonical.js';
import type { BrokeredCase, CaseEvent } from './model.js';

interface JsonRow {
  record_json: string;
}

interface EventRow {
  case_id: string;
  sequence: number;
  previous_hash: string;
  event_hash: string;
  event_type: string;
  actor: string;
  reason: string;
  evidence_refs_json: string;
  payload_json: string;
  created_at: string;
}

interface JobRow {
  id: string;
  case_id: string;
  submission_id: string;
}

export class SQLiteCaseStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path, { timeout: 5_000 });
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS brokered_cases (
        id TEXT PRIMARY KEY,
        case_status TEXT NOT NULL,
        funding_status TEXT NOT NULL,
        execution_status TEXT NOT NULL,
        record_json TEXT NOT NULL CHECK (json_valid(record_json)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS brokered_cases_inbox
        ON brokered_cases(case_status, updated_at DESC);
      CREATE TABLE IF NOT EXISTS case_submission_identities (
        submission_id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL,
        package_sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (case_id) REFERENCES brokered_cases(id)
      );
      DROP INDEX IF EXISTS case_submission_digest;
      CREATE INDEX IF NOT EXISTS case_submission_digest_lookup
        ON case_submission_identities(package_sha256);
      CREATE TABLE IF NOT EXISTS case_events (
        case_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        previous_hash TEXT NOT NULL,
        event_hash TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        reason TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL CHECK (json_valid(evidence_refs_json)),
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        created_at TEXT NOT NULL,
        PRIMARY KEY (case_id, sequence),
        FOREIGN KEY (case_id) REFERENCES brokered_cases(id)
      );
      CREATE TABLE IF NOT EXISTS case_jobs (
        id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL,
        submission_id TEXT NOT NULL,
        job_type TEXT NOT NULL,
        state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (case_id) REFERENCES brokered_cases(id)
      );
      CREATE INDEX IF NOT EXISTS case_jobs_pending
        ON case_jobs(state, available_at);
    `);
  }

  create(record: BrokeredCase, submissionId: string, packageSha256: string) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const duplicate = this.database.prepare(`
        SELECT case_id, package_sha256 FROM case_submission_identities
        WHERE submission_id = ? OR package_sha256 = ?
      `).get(submissionId, packageSha256) as { case_id: string; package_sha256: string } | undefined;
      if (duplicate) {
        if (duplicate.package_sha256 !== packageSha256) {
          throw new Error('Submission identity replayed with changed package content.');
        }
        this.database.exec('ROLLBACK');
        return this.get(duplicate.case_id);
      }
      this.insertOrUpdate(record);
      this.database.prepare(`
        INSERT INTO case_submission_identities (submission_id, case_id, package_sha256, created_at)
        VALUES (?, ?, ?, ?)
      `).run(submissionId, record.id, packageSha256, record.createdAt);
      this.database.exec('COMMIT');
      return structuredClone(record);
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }

  get(id: string) {
    const row = this.database.prepare(
      'SELECT record_json FROM brokered_cases WHERE id = ?'
    ).get(id) as JsonRow | undefined;
    return row ? JSON.parse(row.record_json) as BrokeredCase : undefined;
  }

  findBySubmissionId(id: string) {
    const row = this.database.prepare(`
      SELECT c.record_json FROM brokered_cases c
      JOIN case_submission_identities s ON s.case_id = c.id
      WHERE s.submission_id = ?
    `).get(id) as JsonRow | undefined;
    return row ? JSON.parse(row.record_json) as BrokeredCase : undefined;
  }

  bindSubmissionIdentity(caseId: string, submissionId: string, packageSha256: string) {
    const existing = this.database.prepare(`
      SELECT case_id, package_sha256 FROM case_submission_identities
      WHERE submission_id = ?
    `).get(submissionId) as { case_id: string; package_sha256: string } | undefined;
    if (existing) {
      if (existing.case_id !== caseId || existing.package_sha256 !== packageSha256) {
        throw new Error('Submission identity replayed with changed package content.');
      }
      return;
    }
    this.database.prepare(`
      INSERT INTO case_submission_identities (submission_id, case_id, package_sha256, created_at)
      VALUES (?, ?, ?, ?)
    `).run(submissionId, caseId, packageSha256, new Date().toISOString());
  }

  list(limit: number) {
    const rows = this.database.prepare(`
      SELECT record_json FROM brokered_cases ORDER BY updated_at DESC LIMIT ?
    `).all(limit) as unknown as JsonRow[];
    return rows.map(row => JSON.parse(row.record_json) as BrokeredCase);
  }

  save(
    record: BrokeredCase,
    event: {
      eventType: string;
      actor: string;
      reason: string;
      evidenceRefs?: string[];
      payload?: Record<string, unknown>;
    }
  ) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.insertOrUpdate(record);
      const previous = this.database.prepare(`
        SELECT sequence, event_hash FROM case_events
        WHERE case_id = ? ORDER BY sequence DESC LIMIT 1
      `).get(record.id) as { sequence: number; event_hash: string } | undefined;
      const createdAt = new Date().toISOString();
      const sequence = Number(previous?.sequence ?? 0) + 1;
      const previousHash = previous?.event_hash ?? '0'.repeat(64);
      const eventBody = {
        caseId: record.id,
        sequence,
        previousHash,
        eventType: event.eventType,
        actor: event.actor,
        reason: event.reason,
        evidenceRefs: event.evidenceRefs ?? [],
        payload: event.payload ?? {},
        createdAt
      };
      const eventHash = sha256(canonicalJson(eventBody));
      this.database.prepare(`
        INSERT INTO case_events (
          case_id, sequence, previous_hash, event_hash, event_type, actor,
          reason, evidence_refs_json, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.id,
        sequence,
        previousHash,
        eventHash,
        event.eventType,
        event.actor,
        event.reason,
        JSON.stringify(event.evidenceRefs ?? []),
        JSON.stringify(event.payload ?? {}),
        createdAt
      );
      this.database.exec('COMMIT');
      return eventHash;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  enqueue(job: { id: string; caseId: string; submissionId: string; type: string }) {
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO case_jobs (
        id, case_id, submission_id, job_type, state, attempts,
        available_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'QUEUED', 0, ?, ?, ?)
    `).run(job.id, job.caseId, job.submissionId, job.type, now, now, now);
  }

  updateJob(id: string, state: 'RUNNING' | 'COMPLETED' | 'FAILED', error?: string) {
    this.database.prepare(`
      UPDATE case_jobs SET state = ?,
        attempts = attempts + CASE WHEN ? = 'RUNNING' THEN 1 ELSE 0 END,
        last_error = ?, updated_at = ? WHERE id = ?
    `).run(state, state, error ?? null, new Date().toISOString(), id);
  }

  pendingJobs() {
    const rows = this.database.prepare(`
      SELECT id, case_id, submission_id FROM case_jobs
      WHERE state IN ('QUEUED', 'RUNNING') ORDER BY created_at
    `).all() as unknown as JobRow[];
    return rows.map(row => ({
      id: row.id,
      caseId: row.case_id,
      submissionId: row.submission_id
    }));
  }

  events(caseId: string) {
    const rows = this.database.prepare(`
      SELECT case_id, sequence, previous_hash, event_hash, event_type,
        actor, reason, evidence_refs_json, payload_json, created_at
      FROM case_events WHERE case_id = ? ORDER BY sequence
    `).all(caseId) as unknown as EventRow[];
    return rows.map(row => ({
      caseId: row.case_id,
      sequence: Number(row.sequence),
      previousHash: row.previous_hash,
      eventHash: row.event_hash,
      eventType: row.event_type,
      actor: row.actor,
      reason: row.reason,
      evidenceRefs: JSON.parse(row.evidence_refs_json) as string[],
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      createdAt: row.created_at
    } satisfies CaseEvent));
  }

  verifyChain(caseId: string) {
    let previousHash = '0'.repeat(64);
    for (const event of this.events(caseId)) {
      if (event.previousHash !== previousHash) return false;
      const { eventHash: _eventHash, ...eventBody } = event;
      if (sha256(canonicalJson(eventBody)) !== event.eventHash) return false;
      previousHash = event.eventHash;
    }
    return true;
  }

  close() {
    this.database.close();
  }

  private insertOrUpdate(record: BrokeredCase) {
    this.database.prepare(`
      INSERT INTO brokered_cases (
        id, case_status, funding_status, execution_status,
        record_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        case_status = excluded.case_status,
        funding_status = excluded.funding_status,
        execution_status = excluded.execution_status,
        record_json = excluded.record_json,
        updated_at = excluded.updated_at
    `).run(
      record.id,
      record.caseStatus,
      record.fundingStatus,
      record.executionStatus,
      JSON.stringify(record),
      record.createdAt,
      record.updatedAt
    );
  }
}
