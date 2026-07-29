import { randomUUID } from 'node:crypto';
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

interface CaseEventInput {
  eventType: string;
  actor: string;
  reason: string;
  evidenceRefs?: string[];
  payload?: Record<string, unknown>;
  // Internal mutation guards: provider workers and a claimed reconciliation
  // are the only operations allowed to write while their durable lock exists.
  allowExecutionMutation?: boolean;
  allowFundingMutation?: boolean;
  requiredExecutionPlanVersion?: number;
  requiredExecutionLockState?: 'ACTIVE' | 'RECONCILING';
  requiredExecutionClaimToken?: string;
}

type ExecutionReservation = 'ACQUIRED' | 'CASE_LOCKED' | 'PILOT_LOCKED' | 'STALE';
type FundingReservation = 'ACQUIRED' | 'ALREADY_RESERVED' | 'STALE';
type ConditionalSave = 'SAVED' | 'STALE';
type FundingObservationRecovery = 'SAVED' | 'STALE' | 'NOT_ACTIVE';

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
      CREATE TABLE IF NOT EXISTS case_execution_locks (
        case_id TEXT PRIMARY KEY,
        plan_version INTEGER NOT NULL,
        plan_digest TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'READY_TO_RECONCILE', 'RECONCILING')),
        acquired_at TEXT NOT NULL,
        lease_updated_at TEXT NOT NULL,
        claim_token TEXT,
        FOREIGN KEY (case_id) REFERENCES brokered_cases(id)
      );
      CREATE TABLE IF NOT EXISTS sandbox_execution_locks (
        lock_name TEXT PRIMARY KEY,
        case_id TEXT NOT NULL,
        plan_version INTEGER NOT NULL,
        acquired_at TEXT NOT NULL,
        FOREIGN KEY (case_id) REFERENCES brokered_cases(id)
      );
      CREATE TABLE IF NOT EXISTS case_funding_attempt_locks (
        case_id TEXT NOT NULL,
        expectation_digest TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'RECORDED')),
        acquired_at TEXT NOT NULL,
        PRIMARY KEY (case_id, expectation_digest),
        FOREIGN KEY (case_id) REFERENCES brokered_cases(id)
      );
    `);
    this.ensureLockStateColumns();
    this.recoverTerminalReservations();
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
    return row ? this.readRecord(row.record_json) : undefined;
  }

  findBySubmissionId(id: string) {
    const row = this.database.prepare(`
      SELECT c.record_json FROM brokered_cases c
      JOIN case_submission_identities s ON s.case_id = c.id
      WHERE s.submission_id = ?
    `).get(id) as JsonRow | undefined;
    return row ? this.readRecord(row.record_json) : undefined;
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
    return rows.map(row => this.readRecord(row.record_json));
  }

  save(record: BrokeredCase, event: CaseEventInput) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.assertMutationAllowed(record.id, event);
      this.insertOrUpdate(record);
      const eventHash = this.appendEvent(record, event);
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

  saveIfCurrent(record: BrokeredCase, expectedRevision: number, event: CaseEventInput): ConditionalSave {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      if (!this.isCurrentRecord(record.id, expectedRevision)) {
        this.database.exec('ROLLBACK');
        return 'STALE';
      }
      this.assertMutationAllowed(record.id, event);
      this.insertOrUpdate(record);
      this.appendEvent(record, event);
      this.database.exec('COMMIT');
      return 'SAVED';
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }

  saveObservedFundingRecovery(
    record: BrokeredCase,
    expectationDigest: string,
    expectedRevision: number,
    event: CaseEventInput
  ): FundingObservationRecovery {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      if (!this.isCurrentRecord(record.id, expectedRevision)) {
        this.database.exec('ROLLBACK');
        return 'STALE';
      }
      const lock = this.database.prepare(`
        SELECT state FROM case_funding_attempt_locks
        WHERE case_id = ? AND expectation_digest = ?
      `).get(record.id, expectationDigest) as { state: string } | undefined;
      if (lock?.state !== 'ACTIVE') {
        this.database.exec('ROLLBACK');
        return 'NOT_ACTIVE';
      }
      this.assertMutationAllowed(record.id, { ...event, allowFundingMutation: true });
      this.insertOrUpdate(record);
      this.appendEvent(record, event);
      this.database.prepare(`
        UPDATE case_funding_attempt_locks SET state = 'RECORDED'
        WHERE case_id = ? AND expectation_digest = ? AND state = 'ACTIVE'
      `).run(record.id, expectationDigest);
      if (!this.lastStatementChanged()) throw new Error('Funding recovery reservation changed before it could be recorded.');
      this.database.exec('COMMIT');
      return 'SAVED';
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }

  reserveExecution(
    record: BrokeredCase,
    planVersion: number,
    planDigest: string,
    expectedRevision: number,
    event: CaseEventInput
  ): ExecutionReservation {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      if (!this.isCurrentRecord(record.id, expectedRevision)) {
        this.database.exec('ROLLBACK');
        return 'STALE';
      }
      this.database.prepare(`
        INSERT OR IGNORE INTO case_execution_locks (
          case_id, plan_version, plan_digest, state, acquired_at, lease_updated_at
        ) VALUES (?, ?, ?, 'ACTIVE', ?, ?)
      `).run(record.id, planVersion, planDigest, new Date().toISOString(), new Date().toISOString());
      if (!this.lastStatementChanged()) {
        this.database.exec('ROLLBACK');
        return 'CASE_LOCKED';
      }
      this.database.prepare(`
        INSERT OR IGNORE INTO sandbox_execution_locks (lock_name, case_id, plan_version, acquired_at)
        VALUES ('high-value-sandbox-pilot', ?, ?, ?)
      `).run(record.id, planVersion, new Date().toISOString());
      if (!this.lastStatementChanged()) {
        this.database.exec('ROLLBACK');
        return 'PILOT_LOCKED';
      }
      this.insertOrUpdate(record);
      this.appendEvent(record, event);
      this.database.exec('COMMIT');
      return 'ACQUIRED';
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }

  releaseExecutionLock(caseId: string, planVersion: number) {
    this.database.prepare(`
      DELETE FROM case_execution_locks WHERE case_id = ? AND plan_version = ?
    `).run(caseId, planVersion);
  }

  releaseExecutionReservation(caseId: string, planVersion: number) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`
        DELETE FROM case_execution_locks WHERE case_id = ? AND plan_version = ?
      `).run(caseId, planVersion);
      this.database.prepare(`
        DELETE FROM sandbox_execution_locks
        WHERE lock_name = 'high-value-sandbox-pilot' AND case_id = ? AND plan_version = ?
      `).run(caseId, planVersion);
      this.database.exec('COMMIT');
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }

  executionLockState(caseId: string, planVersion: number) {
    const row = this.database.prepare(`
      SELECT state FROM case_execution_locks WHERE case_id = ? AND plan_version = ?
    `).get(caseId, planVersion) as { state: 'ACTIVE' | 'READY_TO_RECONCILE' | 'RECONCILING' } | undefined;
    return row?.state;
  }

  hasActiveExecutionLock(caseId: string) {
    const row = this.database.prepare(`
      SELECT 1 AS present FROM case_execution_locks WHERE case_id = ? AND state = 'ACTIVE'
    `).get(caseId) as { present: number } | undefined;
    return Boolean(row?.present);
  }

  private hasExecutionMutationLock(caseId: string) {
    const row = this.database.prepare(`
      SELECT 1 AS present FROM case_execution_locks
      WHERE case_id = ? AND state IN ('ACTIVE', 'RECONCILING')
    `).get(caseId) as { present: number } | undefined;
    return Boolean(row?.present);
  }

  markExecutionReadyAfterSubmission(caseId: string, planVersion: number) {
    this.database.prepare(`
      UPDATE case_execution_locks SET state = 'READY_TO_RECONCILE', lease_updated_at = ?
      WHERE case_id = ? AND plan_version = ? AND state = 'ACTIVE'
    `).run(new Date().toISOString(), caseId, planVersion);
  }

  releaseExecutionReconciliationClaim(caseId: string, planVersion: number, claimToken: string) {
    this.database.prepare(`
      UPDATE case_execution_locks
      SET state = 'READY_TO_RECONCILE', lease_updated_at = ?, claim_token = NULL
      WHERE case_id = ? AND plan_version = ? AND state = 'RECONCILING' AND claim_token = ?
    `).run(new Date().toISOString(), caseId, planVersion, claimToken);
  }

  claimExecutionReconciliation(caseId: string, planVersion: number) {
    const claimToken = randomUUID();
    this.database.prepare(`
      UPDATE case_execution_locks
      SET state = 'RECONCILING', lease_updated_at = ?, claim_token = ?
      WHERE case_id = ? AND plan_version = ? AND state = 'READY_TO_RECONCILE'
    `).run(new Date().toISOString(), claimToken, caseId, planVersion);
    return this.lastStatementChanged() ? claimToken : undefined;
  }

  claimStaleExecutionReconciliation(caseId: string, planVersion: number, staleBefore: string) {
    const claimToken = randomUUID();
    this.database.prepare(`
      UPDATE case_execution_locks
      SET state = 'RECONCILING', lease_updated_at = ?, claim_token = ?
      WHERE case_id = ? AND plan_version = ? AND state IN ('ACTIVE', 'RECONCILING')
        AND lease_updated_at <= ?
    `).run(new Date().toISOString(), claimToken, caseId, planVersion, staleBefore);
    return this.lastStatementChanged() ? claimToken : undefined;
  }

  heartbeatExecutionLock(
    caseId: string,
    planVersion: number,
    state: 'ACTIVE' | 'RECONCILING' = 'ACTIVE',
    claimToken?: string
  ) {
    const statement = claimToken
      ? this.database.prepare(`
          UPDATE case_execution_locks SET lease_updated_at = ?
          WHERE case_id = ? AND plan_version = ? AND state = ? AND claim_token = ?
        `)
      : this.database.prepare(`
          UPDATE case_execution_locks SET lease_updated_at = ?
          WHERE case_id = ? AND plan_version = ? AND state = ?
        `);
    if (claimToken) statement.run(new Date().toISOString(), caseId, planVersion, state, claimToken);
    else statement.run(new Date().toISOString(), caseId, planVersion, state);
    return this.lastStatementChanged();
  }

  acquirePilotExecutionLock(caseId: string, planVersion: number) {
    this.database.prepare(`
      INSERT OR IGNORE INTO sandbox_execution_locks (lock_name, case_id, plan_version, acquired_at)
      VALUES ('high-value-sandbox-pilot', ?, ?, ?)
    `).run(caseId, planVersion, new Date().toISOString());
    return this.lastStatementChanged();
  }

  releasePilotExecutionLock(caseId: string, planVersion: number) {
    this.database.prepare(`
      DELETE FROM sandbox_execution_locks
      WHERE lock_name = 'high-value-sandbox-pilot' AND case_id = ? AND plan_version = ?
    `).run(caseId, planVersion);
  }

  reserveFundingAttempt(
    record: BrokeredCase,
    expectationDigest: string,
    attemptId: string,
    expectedRevision: number,
    event: CaseEventInput
  ): FundingReservation {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      if (!this.isCurrentRecord(record.id, expectedRevision)) {
        this.database.exec('ROLLBACK');
        return 'STALE';
      }
      this.database.prepare(`
        INSERT OR IGNORE INTO case_funding_attempt_locks (
          case_id, expectation_digest, attempt_id, state, acquired_at
        ) VALUES (?, ?, ?, 'ACTIVE', ?)
      `).run(record.id, expectationDigest, attemptId, new Date().toISOString());
      if (!this.lastStatementChanged()) {
        this.database.exec('ROLLBACK');
        return 'ALREADY_RESERVED';
      }
      this.insertOrUpdate(record);
      this.appendEvent(record, event);
      this.database.exec('COMMIT');
      return 'ACQUIRED';
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }

  hasActiveFundingAttemptLock(caseId: string) {
    const row = this.database.prepare(`
      SELECT 1 AS present FROM case_funding_attempt_locks
      WHERE case_id = ? AND state = 'ACTIVE'
    `).get(caseId) as { present: number } | undefined;
    return Boolean(row?.present);
  }

  markFundingAttemptRecorded(caseId: string, expectationDigest: string) {
    this.database.prepare(`
      UPDATE case_funding_attempt_locks SET state = 'RECORDED'
      WHERE case_id = ? AND expectation_digest = ? AND state = 'ACTIVE'
    `).run(caseId, expectationDigest);
  }

  releaseFundingAttemptLock(caseId: string, expectationDigest: string) {
    this.database.prepare(`
      DELETE FROM case_funding_attempt_locks WHERE case_id = ? AND expectation_digest = ?
    `).run(caseId, expectationDigest);
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

  private lastStatementChanged() {
    const row = this.database.prepare('SELECT changes() AS changes').get() as { changes: number };
    return Number(row.changes) === 1;
  }

  private isCurrentRecord(caseId: string, expectedRevision: number) {
    const row = this.database.prepare(`
      SELECT record_json FROM brokered_cases WHERE id = ?
    `).get(caseId) as { record_json: string } | undefined;
    return row !== undefined && this.readRecord(row.record_json).revision === expectedRevision;
  }

  private assertMutationAllowed(caseId: string, event: CaseEventInput) {
    if (event.requiredExecutionPlanVersion !== undefined) {
      const expectedState = event.requiredExecutionLockState ?? 'ACTIVE';
      const lock = this.database.prepare(`
        SELECT state, claim_token FROM case_execution_locks
        WHERE case_id = ? AND plan_version = ?
      `).get(caseId, event.requiredExecutionPlanVersion) as {
        state: 'ACTIVE' | 'READY_TO_RECONCILE' | 'RECONCILING'; claim_token: string | null;
      } | undefined;
      if (lock?.state !== expectedState ||
          (event.requiredExecutionClaimToken !== undefined && lock.claim_token !== event.requiredExecutionClaimToken)) {
        throw new Error('The Sandbox execution reservation is no longer owned by this worker.');
      }
    }
    if (!event.allowExecutionMutation && this.hasExecutionMutationLock(caseId)) {
      throw new Error('Case mutation is locked while a Sandbox execution is being submitted or reconciled.');
    }
    if (!event.allowFundingMutation && this.hasActiveFundingAttemptLock(caseId)) {
      throw new Error('Case mutation is locked while a Sandbox funding submission is being recorded.');
    }
  }

  private ensureLockStateColumns() {
    const executionColumns = this.database.prepare('PRAGMA table_info(case_execution_locks)').all() as Array<{ name: string }>;
    if (!executionColumns.some(column => column.name === 'state')) {
      this.database.exec("ALTER TABLE case_execution_locks ADD COLUMN state TEXT NOT NULL DEFAULT 'ACTIVE'");
    }
    const executionColumnsAfterState = this.database.prepare('PRAGMA table_info(case_execution_locks)').all() as Array<{ name: string }>;
    if (!executionColumnsAfterState.some(column => column.name === 'lease_updated_at')) {
      this.database.exec("ALTER TABLE case_execution_locks ADD COLUMN lease_updated_at TEXT NOT NULL DEFAULT ''");
      this.database.exec("UPDATE case_execution_locks SET lease_updated_at = acquired_at WHERE lease_updated_at = ''");
    }
    const executionColumnsAfterLease = this.database.prepare('PRAGMA table_info(case_execution_locks)').all() as Array<{ name: string }>;
    if (!executionColumnsAfterLease.some(column => column.name === 'claim_token')) {
      this.database.exec('ALTER TABLE case_execution_locks ADD COLUMN claim_token TEXT');
    }
    const executionTable = this.database.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'case_execution_locks'
    `).get() as { sql?: string } | undefined;
    // Earlier pilot builds only allowed ACTIVE/READY_TO_RECONCILE. Rebuild
    // this small lock table so a claimed reconciliation is also durable.
    if (!executionTable?.sql?.includes('RECONCILING')) {
      this.database.exec('BEGIN IMMEDIATE');
      try {
        this.database.exec(`
          CREATE TABLE case_execution_locks_rebuilt (
            case_id TEXT PRIMARY KEY,
            plan_version INTEGER NOT NULL,
            plan_digest TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'READY_TO_RECONCILE', 'RECONCILING')),
            acquired_at TEXT NOT NULL,
            lease_updated_at TEXT NOT NULL,
            claim_token TEXT,
            FOREIGN KEY (case_id) REFERENCES brokered_cases(id)
          );
          INSERT INTO case_execution_locks_rebuilt (
            case_id, plan_version, plan_digest, state, acquired_at, lease_updated_at, claim_token
          ) SELECT case_id, plan_version, plan_digest, state, acquired_at, lease_updated_at, claim_token
            FROM case_execution_locks;
          DROP TABLE case_execution_locks;
          ALTER TABLE case_execution_locks_rebuilt RENAME TO case_execution_locks;
        `);
        this.database.exec('COMMIT');
      } catch (error) {
        if (this.database.isTransaction) this.database.exec('ROLLBACK');
        throw error;
      }
    }
    const fundingColumns = this.database.prepare('PRAGMA table_info(case_funding_attempt_locks)').all() as Array<{ name: string }>;
    if (!fundingColumns.some(column => column.name === 'state')) {
      this.database.exec("ALTER TABLE case_funding_attempt_locks ADD COLUMN state TEXT NOT NULL DEFAULT 'ACTIVE'");
    }
  }

  private recoverTerminalReservations() {
    const executionLocks = this.database.prepare(`
      SELECT case_id, plan_version FROM case_execution_locks
    `).all() as Array<{ case_id: string; plan_version: number }>;
    for (const lock of executionLocks) {
      const record = this.get(lock.case_id);
      const plan = record?.plans.find(item => item.version === Number(lock.plan_version));
      if (plan && ['RECONCILED', 'FAILED'].includes(plan.status)) {
        this.releaseExecutionReservation(lock.case_id, Number(lock.plan_version));
      }
    }
    const pilotLocks = this.database.prepare(`
      SELECT case_id, plan_version FROM sandbox_execution_locks
      WHERE lock_name = 'high-value-sandbox-pilot'
    `).all() as Array<{ case_id: string; plan_version: number }>;
    for (const lock of pilotLocks) {
      const record = this.get(lock.case_id);
      const plan = record?.plans.find(item => item.version === Number(lock.plan_version));
      if (plan && ['RECONCILED', 'FAILED'].includes(plan.status)) {
        this.releaseExecutionReservation(lock.case_id, Number(lock.plan_version));
      }
    }
    const fundingLocks = this.database.prepare(`
      SELECT case_id, expectation_digest FROM case_funding_attempt_locks WHERE state = 'ACTIVE'
    `).all() as Array<{ case_id: string; expectation_digest: string }>;
    for (const lock of fundingLocks) {
      const record = this.get(lock.case_id);
      const attempt = record?.fundingAttempts?.find(item => item.expectationDigest === lock.expectation_digest);
      if (attempt && ['COMPLETED', 'FAILED', 'REVERTED', 'DECLINED'].includes(attempt.state)) {
        this.markFundingAttemptRecorded(lock.case_id, lock.expectation_digest);
      }
    }
  }

  private appendEvent(record: BrokeredCase, event: CaseEventInput) {
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
    return eventHash;
  }

  private insertOrUpdate(record: BrokeredCase) {
    record.revision = (record.revision ?? 0) + 1;
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

  private readRecord(value: string) {
    const record = JSON.parse(value) as BrokeredCase;
    record.revision ??= 0;
    return record;
  }
}
