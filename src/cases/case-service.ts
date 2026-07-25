import {
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign
} from 'node:crypto';
import type {
  RevolutSandboxTransaction,
  SandboxInternalTransferClient
} from '../adapters/revolut-sandbox-client.js';
import { inspectArchive, type ArchiveLimits } from './archive-reader.js';
import { canonicalJson, sha256 } from './canonical.js';
import type { SQLiteCaseStore } from './case-store.js';
import type { EncryptedEvidenceStore } from './evidence-store.js';
import { analyzePackage } from './intake.js';
import type { MalwareScanner } from './malware-scanner.js';
import type {
  BrokeredCase,
  BrokerFinding,
  CaseAmendment,
  FundingAllocation,
  FundingPlan,
  Money,
  ProviderObservation,
  RiskFinding
} from './model.js';
import { appendRiskSnapshot, invalidateAuthorization } from './risk.js';

interface SubmitResult {
  case: BrokeredCase;
  duplicate: boolean;
}

interface AmendmentInput {
  reason: string;
  source: string;
  claims: Array<{ path: string; value: unknown }>;
  resolvesFindingCodes: string[];
  evidenceRefs: string[];
}

interface PlanInput {
  receiptObservationId: string;
  allocations: Omit<FundingAllocation, 'id'>[];
}

export class BrokeredFundingCaseService {
  private readonly processing = new Map<string, Promise<void>>();
  private readonly execution = new Map<string, Promise<BrokeredCase>>();
  private readonly signingPrivateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
  private readonly signingPublicKey: ReturnType<typeof generateKeyPairSync>['publicKey'];

  constructor(
    private readonly store: SQLiteCaseStore,
    private readonly evidence: EncryptedEvidenceStore,
    private readonly scanner: MalwareScanner,
    private readonly provider: SandboxInternalTransferClient,
    private readonly limits: ArchiveLimits,
    private readonly trustedSourceKeys: Record<string, string>,
    signingKeyPem?: string
  ) {
    if (signingKeyPem) {
      const privateKey = signingKeyPem;
      this.signingPrivateKey = privateKey as never;
      this.signingPublicKey = createPublicKey(privateKey) as never;
    } else {
      const pair = generateKeyPairSync('ed25519');
      this.signingPrivateKey = pair.privateKey;
      this.signingPublicKey = pair.publicKey;
    }
  }

  submit(packageContent: Buffer, requestedSubmissionId?: string): SubmitResult {
    const packageSha256 = sha256(packageContent);
    const submissionId = normalizeIdentity(requestedSubmissionId ?? packageSha256);
    const existing = this.store.findBySubmissionId(submissionId);
    if (existing) {
      const digest = existing.submissions.find(item => item.id === submissionId)?.packageSha256;
      if (digest !== packageSha256) throw new Error('Submission identity replayed with changed package content.');
      return { case: existing, duplicate: true };
    }
    const storedPackage = this.evidence.put(packageContent);
    const now = new Date().toISOString();
    const caseRecord: BrokeredCase = {
      id: randomUUID(),
      caseStatus: 'QUARANTINED',
      fundingStatus: 'AWAITING_FUNDS',
      executionStatus: 'NOT_PLANNED',
      createdAt: now,
      updatedAt: now,
      submissions: [{
        id: submissionId,
        version: 1,
        packageSha256,
        format: 'legacy-asset-declaration',
        originalArtifactSha256: storedPackage.plaintextSha256,
        state: 'QUEUED',
        receivedAt: now,
        scanner: 'NOT_RUN'
      }],
      artifacts: [],
      claims: [],
      riskFindings: [],
      brokerFindings: [],
      amendments: [],
      providerObservations: [],
      plans: [],
      approvals: [],
      executionAttempts: [],
      riskSnapshots: []
    };
    const created = this.store.create(caseRecord, submissionId, packageSha256);
    if (!created) throw new Error('Could not create case.');
    if (created.id !== caseRecord.id) return { case: created, duplicate: true };
    this.store.save(caseRecord, {
      eventType: 'SUBMISSION_RECEIVED',
      actor: 'operator',
      reason: 'Private ZIP accepted into quarantine.',
      evidenceRefs: [packageSha256],
      payload: { submissionId, packageSha256 }
    });
    const jobId = randomUUID();
    this.store.enqueue({ id: jobId, caseId: caseRecord.id, submissionId, type: 'VALIDATE_SUBMISSION' });
    const process = this.processSubmission(caseRecord.id, submissionId, jobId);
    this.processing.set(caseRecord.id, process);
    void process.finally(() => this.processing.delete(caseRecord.id));
    return { case: caseRecord, duplicate: false };
  }

  async waitForProcessing(caseId: string) {
    await this.processing.get(caseId);
    return this.mustGet(caseId);
  }

  resumePendingJobs() {
    for (const job of this.store.pendingJobs()) {
      if (this.processing.has(job.caseId)) continue;
      const process = this.processSubmission(job.caseId, job.submissionId, job.id);
      this.processing.set(job.caseId, process);
      void process.finally(() => this.processing.delete(job.caseId));
    }
  }

  list(limit = 100) {
    return this.store.list(limit).map(record => ({
      id: record.id,
      caseStatus: record.caseStatus,
      fundingStatus: record.fundingStatus,
      executionStatus: record.executionStatus,
      overallRisk: record.riskSnapshots.at(-1)?.overall ?? 'HIGH',
      hardBlockCount: record.riskSnapshots.at(-1)?.hardBlockCodes.length ?? 0,
      updatedAt: record.updatedAt,
      nextAction: nextAction(record)
    }));
  }

  get(caseId: string) {
    return structuredClone(this.mustGet(caseId));
  }

  addAmendment(caseId: string, input: AmendmentInput, actor: string) {
    const record = this.mustGet(caseId);
    if (['REJECTED', 'CLOSED'].includes(record.caseStatus)) {
      throw new Error(`Case amendments are not allowed from ${record.caseStatus}.`);
    }
    requireText(input.reason, 'Amendment reason', 500);
    requireText(input.source, 'Amendment source', 300);
    if (!Array.isArray(input.claims) || input.claims.length === 0) {
      throw new Error('At least one corrected claim is required.');
    }
    if (!Array.isArray(input.evidenceRefs) || input.evidenceRefs.length === 0) {
      throw new Error('Amendments must cite new evidence.');
    }
    const amendment: CaseAmendment = {
      id: randomUUID(),
      version: record.amendments.length + 1,
      reason: input.reason,
      source: input.source,
      claims: structuredClone(input.claims),
      resolvesFindingCodes: [...new Set(input.resolvesFindingCodes ?? [])],
      evidenceRefs: [...new Set(input.evidenceRefs)],
      actor,
      recordedAt: new Date().toISOString()
    };
    for (const claim of amendment.claims) {
      requireText(claim.path, 'Claim path', 200);
      const previous = [...record.claims].reverse().find(item => item.path === claim.path);
      record.claims.push({
        id: randomUUID(),
        version: record.claims.filter(item => item.path === claim.path).length + 1,
        path: claim.path,
        value: structuredClone(claim.value),
        source: 'BROKER_AMENDMENT',
        evidenceRefs: amendment.evidenceRefs,
        recordedAt: amendment.recordedAt,
        ...(previous ? { supersedesClaimId: previous.id } : {})
      });
    }
    for (const code of amendment.resolvesFindingCodes) {
      for (const finding of record.riskFindings.filter(item => item.code === code && !item.resolvedAt)) {
        finding.resolvedAt = amendment.recordedAt;
        finding.resolvedByAmendmentId = amendment.id;
      }
    }
    record.amendments.push(amendment);
    invalidateAuthorization(record, 'Material case amendment');
    record.caseStatus = 'AWAITING_BROKER';
    record.updatedAt = amendment.recordedAt;
    appendRiskSnapshot(record);
    this.store.save(record, {
      eventType: 'CASE_AMENDED',
      actor,
      reason: input.reason,
      evidenceRefs: amendment.evidenceRefs,
      payload: {
        amendmentId: amendment.id,
        resolvedFindingCodes: amendment.resolvesFindingCodes
      }
    });
    return structuredClone(record);
  }

  addReview(
    caseId: string,
    input: Omit<BrokerFinding, 'id' | 'actor' | 'recordedAt'>,
    actor: string
  ) {
    const record = this.mustGet(caseId);
    requireText(input.category, 'Review category', 100);
    requireText(input.note, 'Review note', 1_000);
    if (!['PASS', 'CONCERN', 'BLOCK'].includes(input.outcome)) throw new Error('Invalid review outcome.');
    const review: BrokerFinding = {
      ...input,
      evidenceRefs: [...new Set(input.evidenceRefs ?? [])],
      id: randomUUID(),
      actor,
      recordedAt: new Date().toISOString()
    };
    record.brokerFindings.push(review);
    if (review.outcome === 'BLOCK') {
      record.riskFindings.push({
        id: randomUUID(),
        code: `BROKER_${safeCode(review.category)}`,
        dimension: 'execution_readiness',
        severity: 'BLOCK',
        hardBlock: true,
        message: review.note,
        neededNext: 'Resolve the broker finding with a cited amendment or reject the case.',
        evidenceRefs: review.evidenceRefs,
        createdAt: review.recordedAt
      });
    }
    invalidateAuthorization(record, 'Broker review changed');
    record.updatedAt = review.recordedAt;
    appendRiskSnapshot(record);
    this.store.save(record, {
      eventType: 'BROKER_REVIEW_RECORDED',
      actor,
      reason: review.note,
      evidenceRefs: review.evidenceRefs,
      payload: { reviewId: review.id, outcome: review.outcome }
    });
    return structuredClone(record);
  }

  decide(
    caseId: string,
    input: { outcome: 'APPROVE' | 'REJECT' | 'REQUEST_INFORMATION'; reason: string },
    actor: string
  ) {
    const record = this.mustGet(caseId);
    requireText(input.reason, 'Decision reason', 1_000);
    if (!['APPROVE', 'REJECT', 'REQUEST_INFORMATION'].includes(input.outcome)) {
      throw new Error('Invalid case decision.');
    }
    const snapshot = appendRiskSnapshot(record);
    if (input.outcome === 'APPROVE' &&
        (snapshot.overall !== 'LOW' || record.fundingStatus !== 'MATCHED')) {
      throw new Error('A case can be approved only after every risk dimension passes and funding is matched.');
    }
    record.decision = {
      outcome: input.outcome,
      reason: input.reason,
      actor,
      decidedAt: new Date().toISOString()
    };
    record.caseStatus = input.outcome === 'APPROVE'
      ? 'APPROVED'
      : input.outcome === 'REJECT'
        ? 'REJECTED'
        : 'INFORMATION_REQUIRED';
    if (input.outcome !== 'APPROVE') invalidateAuthorization(record, `Case decision: ${input.outcome}`);
    record.updatedAt = record.decision.decidedAt;
    this.store.save(record, {
      eventType: 'CASE_DECISION_RECORDED',
      actor,
      reason: input.reason,
      payload: { outcome: input.outcome, riskSnapshotDigest: snapshot.digest }
    });
    return structuredClone(record);
  }

  async refreshFunding(
    caseId: string,
    actor: string,
    simulate = false
  ) {
    const record = this.mustGet(caseId);
    const unresolvedOtherBlocks = record.riskFindings.filter(item =>
      item.hardBlock && !item.resolvedAt && item.code !== 'INCOMING_SETTLEMENT_UNOBSERVED'
    );
    if (unresolvedOtherBlocks.length > 0) {
      throw new Error('Provider access is blocked until the package and cited evidence findings are resolved.');
    }
    const expectation = record.fundingExpectation;
    if (!expectation) throw new Error('This case has no usable incoming funding expectation.');
    const simulationIds = new Set<string>();
    if (simulate) {
      if (!this.provider.simulateTopUp) throw new Error('Sandbox top-up simulation is unavailable.');
      const result = await this.provider.simulateTopUp({
        accountId: expectation.destinationAccountId,
        amount: minorToMajor(expectation.amountMinor, expectation.exponent),
        currency: expectation.currency,
        reference: expectation.reference
      });
      simulationIds.add(result.id);
    }
    if (!this.provider.listTransactions) throw new Error('Provider transaction observation is unavailable.');
    const transactions = await this.provider.listTransactions();
    const observations = transactions.flatMap(transaction =>
      transactionObservations(transaction, expectation, simulationIds)
    );
    for (const observation of observations) {
      const existing = record.providerObservations.find(item => item.providerTransactionId === observation.providerTransactionId);
      if (existing) Object.assign(existing, observation, { id: existing.id });
      else record.providerObservations.push(observation);
    }
    const candidates = record.providerObservations.filter(item =>
      item.direction === 'CREDIT' &&
      item.accountId === expectation.destinationAccountId &&
      item.currency === expectation.currency &&
      item.amountMinor === expectation.amountMinor &&
      item.reference === expectation.reference &&
      ['completed', 'COMPLETED'].includes(item.state)
    );
    const previousMatched = record.fundingStatus === 'MATCHED';
    record.fundingStatus = candidates.length === 1
      ? 'MATCHED'
      : candidates.length > 1
        ? 'POSSIBLE_MATCH'
        : 'UNMATCHED';
    if (candidates.length === 1) {
      resolveFindings(record, ['INCOMING_SETTLEMENT_UNOBSERVED'], 'PROVIDER_OBSERVATION');
      if (record.caseStatus === 'INTAKE_HOLD' &&
          !record.riskFindings.some(item => item.hardBlock && !item.resolvedAt)) {
        record.caseStatus = 'AWAITING_BROKER';
      }
    } else if (previousMatched) {
      record.fundingStatus = 'REVERSED';
      invalidateAuthorization(record, 'Matched funding was reversed or is no longer a unique exact match');
    }
    record.updatedAt = new Date().toISOString();
    appendRiskSnapshot(record);
    this.store.save(record, {
      eventType: simulate ? 'SANDBOX_FUNDING_SIMULATED_AND_REFRESHED' : 'FUNDING_OBSERVATIONS_REFRESHED',
      actor,
      reason: simulate
        ? 'Operator requested an explicitly labelled Sandbox test credit.'
        : 'Provider transactions independently refreshed.',
      evidenceRefs: candidates.map(item => item.rawResponseSha256),
      payload: {
        fundingStatus: record.fundingStatus,
        exactMatchCount: candidates.length,
        simulation: simulate
      }
    });
    return structuredClone(record);
  }

  createPlan(caseId: string, input: PlanInput, actor: string) {
    const record = this.mustGet(caseId);
    if (record.caseStatus !== 'APPROVED' || record.fundingStatus !== 'MATCHED') {
      throw new Error('The case must be approved with exactly matched funding before a plan is created.');
    }
    const snapshot = appendRiskSnapshot(record);
    if (snapshot.overall !== 'LOW') throw new Error('The current risk snapshot is not LOW.');
    const observation = record.providerObservations.find(item => item.id === input.receiptObservationId);
    if (!observation || observation.direction !== 'CREDIT' ||
        !['completed', 'COMPLETED'].includes(observation.state)) {
      throw new Error('The funding-plan receipt must reference the completed matched provider credit.');
    }
    if (!Array.isArray(input.allocations) || input.allocations.length === 0) {
      throw new Error('At least one funding allocation is required.');
    }
    const allocations = input.allocations.map(allocation => validateAllocation(allocation, observation));
    const total = allocations.reduce((sum, allocation) => sum + allocation.amountMinor, 0);
    if (!Number.isSafeInteger(total) || total !== observation.amountMinor) {
      throw new Error('Allocation invariant failed: receipt must exactly equal payouts, fees, reserve, and refund.');
    }
    invalidateAuthorization(record, 'New funding-plan version created');
    const version = record.plans.length + 1;
    const createdAt = new Date().toISOString();
    const planBody = {
      version,
      createdAt,
      createdBy: actor,
      receiptObservationId: observation.id,
      receipt: moneyFrom(observation),
      allocations,
      riskSnapshotDigest: snapshot.digest
    };
    const plan: FundingPlan = {
      ...planBody,
      digest: sha256(canonicalJson(planBody)),
      status: 'AWAITING_AUTHORIZATION'
    };
    record.plans.push(plan);
    record.executionStatus = 'AWAITING_AUTHORIZATION';
    record.updatedAt = createdAt;
    this.store.save(record, {
      eventType: 'FUNDING_PLAN_CREATED',
      actor,
      reason: 'Balanced funding plan created for broker authorization.',
      evidenceRefs: [observation.rawResponseSha256],
      payload: { version, digest: plan.digest, allocationCount: allocations.length }
    });
    return structuredClone(plan);
  }

  authorizePlan(caseId: string, version: number, actor: string) {
    const record = this.mustGet(caseId);
    const plan = mustPlan(record, version);
    if (plan.status !== 'AWAITING_AUTHORIZATION') {
      throw new Error(`Funding plan cannot be authorized from ${plan.status}.`);
    }
    const snapshot = appendRiskSnapshot(record);
    if (snapshot.overall !== 'LOW' || snapshot.digest !== plan.riskSnapshotDigest ||
        record.caseStatus !== 'APPROVED' || record.fundingStatus !== 'MATCHED') {
      throw new Error('Funding plan is stale or the case is no longer executable.');
    }
    const approval = {
      id: randomUUID(),
      planVersion: version,
      planDigest: plan.digest,
      riskSnapshotDigest: snapshot.digest,
      actor,
      authorizedAt: new Date().toISOString()
    };
    record.approvals.push(approval);
    plan.status = 'AUTHORIZED';
    record.executionStatus = 'AUTHORIZED';
    record.updatedAt = approval.authorizedAt;
    this.store.save(record, {
      eventType: 'FUNDING_PLAN_AUTHORIZED',
      actor,
      reason: 'Broker supplied password, fresh MFA, origin/CSRF checks, and the plan-specific phrase.',
      payload: {
        approvalId: approval.id,
        planVersion: version,
        planDigest: plan.digest,
        riskSnapshotDigest: snapshot.digest
      }
    });
    return structuredClone(record);
  }

  async executePlan(caseId: string, version: number, actor: string) {
    const key = `${caseId}:${version}`;
    const running = this.execution.get(key);
    if (running) return structuredClone(await running);
    const task = this.executeSequentially(caseId, version, actor);
    this.execution.set(key, task);
    try {
      return structuredClone(await task);
    } finally {
      this.execution.delete(key);
    }
  }

  async reconcile(caseId: string, actor: string) {
    const record = this.mustGet(caseId);
    record.executionStatus = 'RECONCILING';
    for (const attempt of record.executionAttempts.filter(item =>
      ['SUBMITTING', 'PENDING', 'AMBIGUOUS'].includes(item.state)
    )) {
      if (!attempt.providerTransactionId) continue;
      const result = await this.provider.getTransaction(attempt.providerTransactionId);
      attempt.state = mapAttemptState(result.state);
      attempt.providerResponseHash = sha256(canonicalJson(result));
      attempt.updatedAt = new Date().toISOString();
      if (attempt.state !== 'COMPLETED') break;
    }
    const actionable = latestPlan(record)?.allocations.filter(item => item.method !== 'RETAIN') ?? [];
    const completed = record.executionAttempts.filter(item => item.state === 'COMPLETED').length;
    record.executionStatus = completed === actionable.length
      ? 'RECONCILED'
      : record.executionAttempts.some(item => ['FAILED', 'REVERTED', 'DECLINED'].includes(item.state))
        ? 'FAILED'
        : completed > 0
          ? 'PARTIAL'
          : 'BLOCKED';
    if (record.executionStatus === 'RECONCILED') {
      const plan = latestPlan(record);
      if (plan) plan.status = 'RECONCILED';
      record.caseStatus = 'CLOSED';
    }
    record.updatedAt = new Date().toISOString();
    this.store.save(record, {
      eventType: 'EXECUTION_RECONCILED',
      actor,
      reason: 'Non-terminal provider results were refreshed.',
      payload: { executionStatus: record.executionStatus }
    });
    return structuredClone(record);
  }

  evidenceBundle(caseId: string) {
    const record = this.mustGet(caseId);
    const events = this.store.events(caseId);
    if (!this.store.verifyChain(caseId)) throw new Error('Case audit chain verification failed.');
    const originals = record.submissions.map(submission => ({
      submissionId: submission.id,
      sha256: submission.packageSha256,
      contentBase64: this.evidence.get(submission.originalArtifactSha256).toString('base64')
    }));
    const body = {
      format: 'brokered-funding-evidence/1.0',
      generatedAt: new Date().toISOString(),
      case: record,
      originalPackages: originals,
      artifactManifest: record.artifacts,
      auditChain: events,
      auditChainVerified: true
    };
    const canonical = canonicalJson(body);
    const signature = sign(null, Buffer.from(canonical), this.signingPrivateKey).toString('base64');
    return Buffer.from(JSON.stringify({
      body,
      signature: {
        algorithm: 'Ed25519',
        value: signature,
        publicKey: this.signingPublicKey.export({ type: 'spki', format: 'pem' }).toString()
      }
    }, null, 2));
  }

  authorizationPhrase(caseId: string, version: number, action: 'AUTHORIZE' | 'EXECUTE') {
    const plan = mustPlan(this.mustGet(caseId), version);
    return `${action} ${caseId} PLAN ${version} ${plan.digest.slice(0, 12)}`;
  }

  private async processSubmission(caseId: string, submissionId: string, jobId: string) {
    this.store.updateJob(jobId, 'RUNNING');
    const record = this.mustGet(caseId);
    const submission = record.submissions.find(item => item.id === submissionId);
    if (!submission) throw new Error('Submission job no longer has a submission.');
    submission.state = 'VALIDATING';
    try {
      const content = this.evidence.get(submission.originalArtifactSha256);
      const archive = await inspectArchive(content, this.limits, this.scanner);
      const analysis = analyzePackage(archive, this.trustedSourceKeys);
      if (analysis.submissionIdentity) {
        this.store.bindSubmissionIdentity(record.id, analysis.submissionIdentity, submission.packageSha256);
      }
      submission.format = analysis.format;
      submission.scanner = archive.scanner;
      submission.state = archive.scanner === 'CLEAN' ? 'VALIDATED' : 'QUARANTINED';
      submission.completedAt = new Date().toISOString();
      record.artifacts = archive.entries.map(entry => {
        const stored = this.evidence.put(entry.content);
        return {
          id: randomUUID(),
          submissionId,
          path: entry.path,
          normalizedPath: entry.normalizedPath,
          mediaType: entry.mediaType,
          byteLength: entry.byteLength,
          sha256: entry.sha256,
          encryptedObjectSha256: stored.encryptedObjectSha256,
          scanStatus: entry.scanStatus
        };
      });
      record.claims = analysis.claims;
      record.riskFindings = analysis.findings;
      if (analysis.fundingExpectation) record.fundingExpectation = analysis.fundingExpectation;
      record.caseStatus = archive.scanner === 'CLEAN'
        ? analysis.findings.some(item => item.hardBlock)
          ? 'INTAKE_HOLD'
          : 'AWAITING_BROKER'
        : 'QUARANTINED';
      record.updatedAt = submission.completedAt;
      appendRiskSnapshot(record);
      this.store.save(record, {
        eventType: 'SUBMISSION_VALIDATED',
        actor: 'system',
        reason: record.caseStatus === 'QUARANTINED'
          ? 'Private malware scan did not clear the submission.'
          : 'Deterministic archive, inventory, claim, and risk validation completed.',
        evidenceRefs: [submission.packageSha256],
        payload: {
          format: submission.format,
          scanner: submission.scanner,
          caseStatus: record.caseStatus,
          findingCodes: record.riskFindings.map(item => item.code)
        }
      });
      this.store.updateJob(jobId, 'COMPLETED');
    } catch (error) {
      const now = new Date().toISOString();
      submission.state = 'FAILED';
      submission.completedAt = now;
      record.caseStatus = 'INTAKE_HOLD';
      record.updatedAt = now;
      const technicalFinding: RiskFinding = {
        id: randomUUID(),
        code: 'PACKAGE_VALIDATION_FAILED',
        dimension: 'technical_integrity',
        severity: 'BLOCK',
        hardBlock: true,
        message: error instanceof Error ? error.message : 'Package validation failed.',
        neededNext: 'Provide a new package that satisfies the conservative ZIP and manifest rules.',
        evidenceRefs: [submission.packageSha256],
        createdAt: now
      };
      record.riskFindings.push(technicalFinding);
      appendRiskSnapshot(record);
      this.store.save(record, {
        eventType: 'SUBMISSION_VALIDATION_FAILED',
        actor: 'system',
        reason: technicalFinding.message,
        evidenceRefs: [submission.packageSha256]
      });
      this.store.updateJob(jobId, 'FAILED', technicalFinding.message);
    }
  }

  private async executeSequentially(caseId: string, version: number, actor: string) {
    const record = this.mustGet(caseId);
    const plan = mustPlan(record, version);
    const approval = record.approvals.find(item =>
      item.planVersion === version && item.planDigest === plan.digest && !item.invalidatedAt
    );
    const resumablePartial = plan.status === 'EXECUTING' &&
      record.executionStatus === 'PARTIAL' &&
      record.executionAttempts
        .filter(item => item.planVersion === version)
        .every(item => item.state === 'COMPLETED');
    if (!approval || !(
      (plan.status === 'AUTHORIZED' && record.executionStatus === 'AUTHORIZED') ||
      resumablePartial
    )) {
      throw new Error('The exact current plan does not have a valid authorization.');
    }
    plan.status = 'EXECUTING';
    record.executionStatus = 'QUEUED';
    record.updatedAt = new Date().toISOString();
    this.store.save(record, {
      eventType: 'EXECUTION_QUEUED',
      actor,
      reason: 'Broker supplied fresh execution reauthentication and the plan-specific phrase.',
      payload: { planVersion: version, planDigest: plan.digest }
    });
    const actionable = plan.allocations.filter(allocation => allocation.method !== 'RETAIN');
    for (const [index, allocation] of actionable.entries()) {
      let attempt = record.executionAttempts.find(item =>
        item.planVersion === version && item.allocationId === allocation.id
      );
      if (attempt?.state === 'COMPLETED') continue;
      if (attempt && attempt.state !== 'UNSUBMITTED') {
        record.executionStatus = completedAttempts(record) > 0 ? 'PARTIAL' : 'BLOCKED';
        break;
      }
      const now = new Date().toISOString();
      attempt = {
        id: randomUUID(),
        planVersion: version,
        allocationId: allocation.id,
        sequence: index + 1,
        providerRequestId: stableProviderRequestId(plan.digest, allocation.id),
        state: 'SUBMITTING',
        createdAt: now,
        updatedAt: now
      };
      record.executionAttempts.push(attempt);
      const requestBody = providerRequest(allocation, attempt.providerRequestId);
      attempt.providerRequestHash = sha256(canonicalJson(requestBody));
      record.updatedAt = now;
      this.store.save(record, {
        eventType: 'PAYOUT_SUBMISSION_STARTED',
        actor,
        reason: 'Sequential payout preflight passed; stable provider request ID reserved.',
        payload: {
          allocationId: allocation.id,
          sequence: attempt.sequence,
          requestHash: attempt.providerRequestHash
        }
      });
      try {
        await this.preflight(allocation);
        const result = allocation.method === 'OWNED_ACCOUNT_TRANSFER'
          ? await this.provider.createInternalTransfer({
              requestId: attempt.providerRequestId,
              sourceAccountId: allocation.sourceAccountId,
              targetAccountId: allocation.targetAccountId!,
              amount: minorToMajor(allocation.amountMinor, allocation.exponent),
              currency: allocation.currency,
              reference: allocation.reference
            })
          : await this.submitCounterpartyPayment(allocation, attempt.providerRequestId);
        attempt.providerTransactionId = result.id;
        attempt.providerResponseHash = sha256(canonicalJson(result));
        attempt.state = mapAttemptState(result.state);
        attempt.updatedAt = new Date().toISOString();
        record.updatedAt = attempt.updatedAt;
        this.store.save(record, {
          eventType: 'PAYOUT_PROVIDER_RESULT',
          actor,
          reason: 'Provider returned a result for the reserved payout request ID.',
          payload: {
            allocationId: allocation.id,
            sequence: attempt.sequence,
            state: attempt.state,
            responseHash: attempt.providerResponseHash
          }
        });
        if (attempt.state !== 'COMPLETED') {
          record.executionStatus = completedAttempts(record) > 0 ? 'PARTIAL' : 'BLOCKED';
          break;
        }
      } catch (error) {
        attempt.state = 'AMBIGUOUS';
        attempt.updatedAt = new Date().toISOString();
        record.executionStatus = completedAttempts(record) > 0 ? 'PARTIAL' : 'BLOCKED';
        record.updatedAt = attempt.updatedAt;
        this.store.save(record, {
          eventType: 'PAYOUT_SUBMISSION_AMBIGUOUS',
          actor,
          reason: 'Submission outcome is ambiguous; reconcile before any retry.',
          payload: {
            allocationId: allocation.id,
            sequence: attempt.sequence,
            errorHash: sha256(error instanceof Error ? error.message : String(error))
          }
        });
        break;
      }
    }
    if (actionable.every(allocation =>
      record.executionAttempts.some(item => item.allocationId === allocation.id && item.state === 'COMPLETED')
    )) {
      record.executionStatus = 'RECONCILING';
    }
    record.updatedAt = new Date().toISOString();
    this.store.save(record, {
      eventType: 'SEQUENTIAL_EXECUTION_PAUSED',
      actor,
      reason: record.executionStatus === 'RECONCILING'
        ? 'All payouts completed provider submission; reconciliation is required.'
        : 'Execution stopped safely; remaining payouts were not submitted.',
      payload: { executionStatus: record.executionStatus }
    });
    return record;
  }

  private async preflight(allocation: FundingAllocation) {
    const accounts = await this.provider.getAccounts();
    const source = accounts.find(account => account.id === allocation.sourceAccountId);
    if (!source || source.state !== 'active') throw new Error('Source account is not an active owned Sandbox account.');
    if (source.currency !== allocation.currency) throw new Error('Source account currency changed.');
    if (majorToMinor(source.balance, allocation.exponent) < allocation.amountMinor) {
      throw new Error('Available Sandbox balance no longer covers this payout.');
    }
    if (allocation.method === 'OWNED_ACCOUNT_TRANSFER') {
      const target = accounts.find(account => account.id === allocation.targetAccountId);
      if (!target || target.state !== 'active') throw new Error('Target is not an active owned Sandbox account.');
      if (target.currency !== allocation.currency) throw new Error('Target account currency changed.');
    } else {
      if (!this.provider.getCounterparties) throw new Error('Counterparty lookup is unavailable.');
      const counterparties = await this.provider.getCounterparties();
      const counterparty = counterparties.find(item => item.id === allocation.counterpartyId);
      if (!counterparty || (counterparty.state && counterparty.state !== 'active')) {
        throw new Error('Selected Sandbox counterparty is not currently verified and active.');
      }
      if (counterparty.accounts && !counterparty.accounts.some(item =>
        item.id === allocation.paymentMethodId &&
        (!item.currency || item.currency === allocation.currency)
      )) {
        throw new Error('Selected counterparty payment method is no longer available.');
      }
    }
  }

  private async submitCounterpartyPayment(allocation: FundingAllocation, requestId: string) {
    if (!this.provider.createCounterpartyPayment) throw new Error('Counterparty payment is unavailable.');
    return this.provider.createCounterpartyPayment({
      requestId,
      sourceAccountId: allocation.sourceAccountId,
      counterpartyId: allocation.counterpartyId!,
      paymentMethodId: allocation.paymentMethodId!,
      amount: minorToMajor(allocation.amountMinor, allocation.exponent),
      currency: allocation.currency,
      reference: allocation.reference
    });
  }

  private mustGet(caseId: string) {
    const record = this.store.get(caseId);
    if (!record) throw new Error('Case not found.');
    return record;
  }
}

function nextAction(record: BrokeredCase) {
  if (record.caseStatus === 'QUARANTINED') return 'Wait for private malware scanning.';
  if (record.caseStatus === 'INTAKE_HOLD' || record.caseStatus === 'INFORMATION_REQUIRED') {
    return record.riskFindings.find(item => item.hardBlock && !item.resolvedAt)?.neededNext ??
      'Add cited evidence and re-review.';
  }
  if (record.fundingStatus !== 'MATCHED') return 'Independently observe and match the incoming provider credit.';
  if (record.caseStatus !== 'APPROVED') return 'Record the broker decision.';
  if (record.executionStatus === 'NOT_PLANNED') return 'Create an exactly balanced funding plan.';
  if (record.executionStatus === 'AWAITING_AUTHORIZATION') return 'Authorize the exact funding-plan digest.';
  if (['AUTHORIZED', 'QUEUED', 'PARTIAL', 'BLOCKED'].includes(record.executionStatus)) {
    return 'Execute or reconcile the authorized Sandbox plan.';
  }
  if (record.executionStatus === 'RECONCILING') return 'Reconcile provider results.';
  return 'Export and retain the signed evidence bundle.';
}

function transactionObservations(
  transaction: RevolutSandboxTransaction,
  expectation: NonNullable<BrokeredCase['fundingExpectation']>,
  simulationIds: Set<string>
): ProviderObservation[] {
  return (transaction.legs ?? []).map(leg => {
    const amountMinor = decimalMajorToMinor(String(leg.amount), expectation.exponent);
    const direction = amountMinor >= 0 ? 'CREDIT' as const : 'DEBIT' as const;
    const body = {
      providerTransactionId: transaction.id,
      state: transaction.state,
      type: transaction.type ?? '',
      reference: transaction.reference ?? '',
      leg
    };
    return {
      id: randomUUID(),
      providerTransactionId: transaction.id,
      accountId: leg.account_id ?? '',
      direction,
      state: transaction.state,
      reference: transaction.reference ?? '',
      amountMinor: Math.abs(amountMinor),
      currency: leg.currency,
      exponent: expectation.exponent,
      observedAt: new Date().toISOString(),
      source: simulationIds.has(transaction.id) ? 'SANDBOX_SIMULATION' : 'PROVIDER',
      rawResponseSha256: sha256(canonicalJson(body))
    };
  });
}

function decimalMajorToMinor(value: string, exponent: number) {
  const match = value.match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!match) throw new Error('Provider amount is not an exact decimal string.');
  const sign = match[1] === '-' ? -1n : 1n;
  const whole = BigInt(match[2] ?? '0');
  const fraction = match[3] ?? '';
  if (fraction.length > exponent && /[1-9]/.test(fraction.slice(exponent))) {
    throw new Error('Provider amount has precision beyond the configured currency exponent.');
  }
  const padded = fraction.padEnd(exponent, '0').slice(0, exponent);
  const amount = sign * (whole * 10n ** BigInt(exponent) + BigInt(padded || '0'));
  const number = Number(amount);
  if (!Number.isSafeInteger(number)) throw new Error('Provider amount exceeds safe minor-unit range.');
  return number;
}

function majorToMinor(value: number, exponent: number) {
  return decimalMajorToMinor(String(value), exponent);
}

function minorToMajor(amountMinor: number, exponent: number) {
  const divisor = 10 ** exponent;
  const value = amountMinor / divisor;
  if (!Number.isFinite(value)) throw new Error('Invalid provider amount.');
  return value;
}

function validateAllocation(
  value: Omit<FundingAllocation, 'id'>,
  receipt: ProviderObservation
): FundingAllocation {
  if (!['CUSTOMER_PAYOUT', 'BROKER_FEE', 'PROVIDER_FEE', 'RESERVE', 'REFUND'].includes(value.kind)) {
    throw new Error('Invalid allocation kind.');
  }
  if (!Number.isSafeInteger(value.amountMinor) || value.amountMinor < 1) {
    throw new Error('Allocation amount must be a positive integer of minor units.');
  }
  if (value.currency !== receipt.currency || value.exponent !== receipt.exponent) {
    throw new Error('Every allocation must use the matched receipt currency and exponent.');
  }
  if (!['OWNED_ACCOUNT_TRANSFER', 'COUNTERPARTY_PAYMENT', 'RETAIN'].includes(value.method)) {
    throw new Error('Invalid allocation execution method.');
  }
  requireText(value.beneficiaryName, 'Allocation beneficiary', 200);
  requireText(value.reference, 'Allocation reference', 140);
  requireText(value.sourceAccountId, 'Allocation source account', 100);
  if (value.method === 'OWNED_ACCOUNT_TRANSFER') requireText(value.targetAccountId, 'Target account', 100);
  if (value.method === 'COUNTERPARTY_PAYMENT') {
    requireText(value.counterpartyId, 'Counterparty', 100);
    requireText(value.paymentMethodId, 'Counterparty payment method', 100);
  }
  if (value.method === 'RETAIN' && !['RESERVE', 'REFUND'].includes(value.kind)) {
    throw new Error('Only explicit reserve or refund allocations may be retained.');
  }
  return { ...structuredClone(value), id: randomUUID() };
}

function providerRequest(allocation: FundingAllocation, requestId: string) {
  return {
    requestId,
    method: allocation.method,
    sourceAccountId: allocation.sourceAccountId,
    targetAccountId: allocation.targetAccountId,
    counterpartyId: allocation.counterpartyId,
    paymentMethodId: allocation.paymentMethodId,
    amountMinor: allocation.amountMinor,
    currency: allocation.currency,
    exponent: allocation.exponent,
    reference: allocation.reference
  };
}

function stableProviderRequestId(planDigest: string, allocationId: string) {
  const hash = Buffer.from(sha256(`${planDigest}:${allocationId}`), 'hex');
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function mapAttemptState(state: string): BrokeredCase['executionAttempts'][number]['state'] {
  const normalized = state.toUpperCase();
  if (['COMPLETED', 'FAILED', 'REVERTED', 'DECLINED', 'PENDING'].includes(normalized)) {
    return normalized as BrokeredCase['executionAttempts'][number]['state'];
  }
  return 'PENDING';
}

function completedAttempts(record: BrokeredCase) {
  return record.executionAttempts.filter(item => item.state === 'COMPLETED').length;
}

function latestPlan(record: BrokeredCase) {
  return record.plans.at(-1);
}

function mustPlan(record: BrokeredCase, version: number) {
  const plan = record.plans.find(item => item.version === version);
  if (!plan) throw new Error('Funding plan version not found.');
  return plan;
}

function resolveFindings(record: BrokeredCase, codes: string[], resolver: string) {
  const now = new Date().toISOString();
  for (const finding of record.riskFindings) {
    if (codes.includes(finding.code) && !finding.resolvedAt) {
      finding.resolvedAt = now;
      finding.resolvedByAmendmentId = resolver;
    }
  }
}

function moneyFrom(value: Money): Money {
  return {
    amountMinor: value.amountMinor,
    currency: value.currency,
    exponent: value.exponent
  };
}

function requireText(value: unknown, description: string, maximum: number) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    throw new Error(`${description} is required and must not exceed ${maximum} characters.`);
  }
  return value;
}

function normalizeIdentity(value: string) {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(normalized)) throw new Error('Submission ID is invalid.');
  return normalized;
}

function safeCode(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'FINDING';
}
