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
import {
  ArchiveValidationError,
  inspectArchive,
  type ArchiveLimits
} from './archive-reader.js';
import { canonicalJson, sha256 } from './canonical.js';
import { canonicalCurrencyExponent, requireCanonicalCurrencyExponent } from './currency.js';
import type { SQLiteCaseStore } from './case-store.js';
import type { EncryptedEvidenceStore } from './evidence-store.js';
import { analyzePackage, finding } from './intake.js';
import type { MalwareScanner } from './malware-scanner.js';
import { OperationalFault } from '../operations/operational-error-monitor.js';
import type {
  BrokeredCase,
  BrokerFinding,
  CaseAmendment,
  FundingAllocation,
  FundingAttempt,
  FundingPlan,
  IncomingFundingExpectation,
  Money,
  ProviderObservation
} from './model.js';
import { appendRiskSnapshot, invalidateAuthorization } from './risk.js';

// Provider requests time out within seconds; this delay is deliberately much
// longer so an operator can safely take over a crashed execution without
// racing a healthy worker.
const STALE_EXECUTION_RECOVERY_MS = 2 * 60_000;

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

interface SandboxWalkthroughInput {
  sourceAccountId: string;
  amountMinor: number;
  currency: string;
  exponent?: number;
}

export class BrokeredFundingCaseService {
  private readonly processing = new Map<string, Promise<void>>();
  private readonly execution = new Map<string, Promise<BrokeredCase>>();
  private activeSandboxExecutionKey: string | undefined;
  private readonly signingPrivateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
  private readonly signingPublicKey: ReturnType<typeof generateKeyPairSync>['publicKey'];

  constructor(
    private readonly store: SQLiteCaseStore,
    private readonly evidence: EncryptedEvidenceStore,
    private readonly scanner: MalwareScanner,
    private readonly provider: SandboxInternalTransferClient,
    private readonly limits: ArchiveLimits,
    private readonly trustedSourceKeys: Record<string, string>,
    signingKeyPem?: string,
    private readonly sandboxCaseMaximumMinorByCurrency: Readonly<Record<string, number>> = {
      USD: 100_000_000_000
    }
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
      revision: 0,
      caseStatus: 'QUARANTINED',
      fundingStatus: 'AWAITING_FUNDS',
      executionStatus: 'NOT_PLANNED',
      createdAt: now,
      updatedAt: now,
      submissions: [{
        id: submissionId,
        version: 1,
        packageSha256,
        format: 'generic-compatibility/1.0',
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
      fundingAttempts: [],
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

  async prepareSandboxWalkthrough(
    caseId: string,
    input: SandboxWalkthroughInput,
    actor: string
  ) {
    const record = this.mustGet(caseId);
    this.requireNoActiveExecution(record, 'A Sandbox walkthrough');
    const submission = record.submissions.at(-1);
    if (['REJECTED', 'CLOSED'].includes(record.caseStatus)) {
      throw new Error(`A Sandbox walkthrough cannot be prepared from ${record.caseStatus}.`);
    }
    if (record.plans.length > 0 || record.executionStatus !== 'NOT_PLANNED') {
      throw new Error('A Sandbox walkthrough cannot replace an existing funding plan.');
    }
    if (record.fundingExpectation) {
      throw new Error('This case already has a usable incoming funding expectation.');
    }
    if (!submission || submission.state !== 'VALIDATED' || submission.scanner !== 'CLEAN') {
      throw new Error('Only a clean, fully inspected ZIP package can enter the Sandbox diagnostic walkthrough.');
    }
    if (submission.format !== 'generic-compatibility/1.0') {
      throw new Error('The Sandbox diagnostic walkthrough is only available for a clean generic compatibility case.');
    }
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 1) {
      throw new Error('Sandbox walkthrough amount must be a positive integer of minor units.');
    }
    if (!/^[A-Z]{3}$/.test(input.currency)) {
      throw new Error('Sandbox walkthrough currency must be a three-letter uppercase code.');
    }
    const exponent = input.exponent ?? canonicalCurrencyExponent(input.currency);
    if (exponent === undefined) throw new Error(`Currency ${input.currency} is not enabled for the Sandbox case workflow.`);
    requireCanonicalCurrencyExponent(input.currency, exponent);
    this.requireSandboxCaseAmount({
      amountMinor: input.amountMinor,
      currency: input.currency,
      exponent
    });
    const accounts = await this.provider.getAccounts();
    const source = accounts.find(account => account.id === input.sourceAccountId);
    if (!source || source.state !== 'active') {
      throw new Error('Select an active owned Revolut Sandbox account.');
    }
    if (source.currency !== input.currency) {
      throw new Error('Selected Sandbox account currency does not match the walkthrough currency.');
    }
    if (!accounts.some(account =>
      account.id !== source.id && account.state === 'active' && account.currency === source.currency
    )) {
      throw new Error('A second active owned Sandbox account in the same currency is required.');
    }

    const now = new Date().toISOString();
    const reference = sandboxFundingReference(record.id, submission.id);
    const expectation = {
      amountMinor: input.amountMinor,
      currency: input.currency,
      exponent,
      reference,
      destinationAccountId: source.id,
      investorName: 'Sandbox diagnostic operator'
    };
    const amendmentId = randomUUID();
    const evidenceRef = `SANDBOX-WALKTHROUGH-${record.id}`;
    const correctedClaims: Array<{ path: string; value: unknown }> = [
      ['expectedIncomingCredit', expectation],
      ['purpose', 'Explicit Sandbox-only end-to-end workflow simulation']
    ].map(([path, value]) => ({ path: String(path), value }));
    const resolvedCodes = [...new Set(record.riskFindings
      .filter(item => !item.resolvedAt && diagnosticWalkthroughFindingCodes.has(item.code))
      .map(item => item.code))];

    resolveFindings(record, resolvedCodes, amendmentId);
    record.amendments.push({
      id: amendmentId,
      version: record.amendments.length + 1,
      reason: 'Operator explicitly prepared a Sandbox-only diagnostic walkthrough; uploaded claims are not relied upon.',
      source: 'Operator-selected owned Revolut Sandbox account',
      claims: correctedClaims,
      resolvesFindingCodes: resolvedCodes,
      evidenceRefs: [evidenceRef],
      actor,
      recordedAt: now
    });
    for (const claim of correctedClaims) {
      const previous = [...record.claims].reverse().find(item => item.path === claim.path);
      record.claims.push({
        id: randomUUID(),
        version: record.claims.filter(item => item.path === claim.path).length + 1,
        path: claim.path,
        value: structuredClone(claim.value),
        source: 'BROKER_AMENDMENT',
        evidenceRefs: [evidenceRef],
        recordedAt: now,
        ...(previous ? { supersedesClaimId: previous.id } : {})
      });
    }
    record.fundingExpectation = expectation;
    record.riskFindings.push(finding('INCOMING_SETTLEMENT_UNOBSERVED', [evidenceRef]));
    delete record.decision;
    record.caseStatus = 'AWAITING_BROKER';
    record.fundingStatus = 'AWAITING_FUNDS';
    record.executionStatus = 'NOT_PLANNED';
    record.updatedAt = now;
    invalidateAuthorization(record, 'Sandbox walkthrough prepared');
    appendRiskSnapshot(record);
    this.store.save(record, {
      eventType: 'SANDBOX_WALKTHROUGH_PREPARED',
      actor,
      reason: 'Explicit Sandbox-only case inputs replaced unrecognized diagnostic package claims.',
      evidenceRefs: [evidenceRef],
      payload: {
        sandboxOnly: true,
        amountMinor: input.amountMinor,
        currency: input.currency,
        resolvedFindingCodes: resolvedCodes
      }
    });
    return structuredClone(record);
  }

  addAmendment(caseId: string, input: AmendmentInput, actor: string) {
    const record = this.mustGet(caseId);
    if (['REJECTED', 'CLOSED'].includes(record.caseStatus)) {
      throw new Error(`Case amendments are not allowed from ${record.caseStatus}.`);
    }
    this.requireNoActiveExecution(record, 'Case amendments');
    requireText(input.reason, 'Amendment reason', 500);
    requireText(input.source, 'Amendment source', 300);
    if (!Array.isArray(input.claims) || input.claims.length === 0) {
      throw new Error('At least one corrected claim is required.');
    }
    if (!Array.isArray(input.evidenceRefs) || input.evidenceRefs.length === 0) {
      throw new Error('Amendments must cite new evidence.');
    }
    const requestedResolvedCodes = [...new Set(input.resolvesFindingCodes ?? [])];
    const activeCodes = new Set(record.riskFindings.filter(item => !item.resolvedAt).map(item => item.code));
    for (const code of requestedResolvedCodes) {
      if (!activeCodes.has(code)) throw new Error(`Finding ${code} is not an active case finding.`);
      if (nonAmendableFindingCodes.has(code)) {
        throw new Error(`Finding ${code} cannot be resolved by amendment; follow its required replacement or reconciliation path.`);
      }
    }
    const incomingClaims = input.claims.filter(claim => claim.path === 'expectedIncomingCredit');
    if (incomingClaims.length > 1) throw new Error('An amendment may confirm only one incoming funding expectation.');
    const submission = record.submissions.at(-1);
    const confirmedExpectation = incomingClaims[0]
      ? validateBrokerFundingExpectation(incomingClaims[0].value)
      : undefined;
    if (confirmedExpectation && (
      submission?.format !== 'generic-compatibility/1.0' ||
      submission.state !== 'VALIDATED' ||
      submission.scanner !== 'CLEAN'
    )) {
      throw new Error('Only a clean generic compatibility case may receive broker-confirmed incoming funding inputs.');
    }
    const previousFundingAttempts = fundingAttempts(record);
    const replacementResolvedCodes: string[] = [];
    if (confirmedExpectation) {
      if (record.fundingStatus === 'MATCHED' || previousFundingAttempts.some(item => item.state === 'COMPLETED')) {
        throw new Error('A confirmed incoming funding expectation cannot replace a matched or completed receipt.');
      }
      if (previousFundingAttempts.some(item => ['SUBMITTING', 'PENDING', 'AMBIGUOUS'].includes(item.state))) {
        throw new Error('Reconcile the existing Sandbox funding attempt before a replacement expectation is considered.');
      }
      if (previousFundingAttempts.length > 0) {
        const newExpectationDigest = fundingExpectationDigest(confirmedExpectation);
        if (previousFundingAttempts.some(item => item.expectationDigest === newExpectationDigest)) {
          throw new Error('A replacement Sandbox funding amendment must confirm a materially different full-value expectation.');
        }
        replacementResolvedCodes.push(...record.riskFindings
          .filter(item => !item.resolvedAt && replacementFundingFindingCodes.has(item.code))
          .map(item => item.code));
      }
    }
    const resolvedCodes = [...new Set([...requestedResolvedCodes, ...replacementResolvedCodes])];
    const amendment: CaseAmendment = {
      id: randomUUID(),
      version: record.amendments.length + 1,
      reason: input.reason,
      source: input.source,
      claims: structuredClone(input.claims),
      resolvesFindingCodes: resolvedCodes,
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
    if (confirmedExpectation) {
      record.fundingExpectation = confirmedExpectation;
      record.fundingStatus = 'AWAITING_FUNDS';
      if (!record.riskFindings.some(item => item.code === 'INCOMING_SETTLEMENT_UNOBSERVED' && !item.resolvedAt)) {
        record.riskFindings.push(finding('INCOMING_SETTLEMENT_UNOBSERVED', amendment.evidenceRefs));
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
    this.requireNoActiveExecution(record, 'Broker reviews');
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
    this.requireNoActiveExecution(record, 'Case decisions');
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
    if (this.store.hasActiveExecutionLock(record.id)) {
      throw new Error('Funding observations are locked while an authorized Sandbox payout is being submitted.');
    }
    const unresolvedOtherBlocks = record.riskFindings.filter(item =>
      item.hardBlock && !item.resolvedAt && item.code !== 'INCOMING_SETTLEMENT_UNOBSERVED' &&
      !reconcilableFundingFindingCodes.has(item.code)
    );
    if (unresolvedOtherBlocks.length > 0) {
      throw new Error('Provider access is blocked until the package and cited evidence findings are resolved.');
    }
    const expectation = record.fundingExpectation;
    if (!expectation) throw new Error('This case has no usable incoming funding expectation.');
    const expectationDigest = fundingExpectationDigest(expectation);
    const attempts = fundingAttempts(record);
    const existingAttempt = [...attempts].reverse().find(item => item.expectationDigest === expectationDigest);
    const simulationReferences = new Set(record.submissions.map(submission =>
      sandboxFundingReference(record.id, submission.id)
    ));
    const amountLimitFinding = this.sandboxCaseAmountFinding(expectation);
    if (amountLimitFinding) {
      this.addProviderFinding(record, amountLimitFinding.code, amountLimitFinding.evidenceRefs);
      record.fundingStatus = 'UNMATCHED';
      record.updatedAt = new Date().toISOString();
      appendRiskSnapshot(record);
      this.store.save(record, {
        eventType: 'SANDBOX_CASE_AMOUNT_LIMIT_BLOCKED',
        actor,
        reason: 'The full declared Sandbox case amount is outside the configured currency limit.',
        evidenceRefs: amountLimitFinding.evidenceRefs,
        payload: { currency: expectation.currency, amountMinor: expectation.amountMinor }
      });
      return structuredClone(record);
    }
    const simulationIds = new Set<string>();
    if (simulate) {
      if (!this.provider.simulateTopUp) throw new Error('Sandbox top-up simulation is unavailable.');
      if (existingAttempt) {
        throw new Error('This full-value Sandbox funding attempt is already recorded; refresh and reconcile it before any amendment or replacement.');
      }
      const providerRequestId = stableFundingRequestId(record.id, expectationDigest);
      const simulationReference = sandboxFundingReference(record.id, record.submissions.at(-1)?.id ?? 'CURRENT');
      const request = {
        accountId: expectation.destinationAccountId,
        amount: minorToMajor(expectation.amountMinor, expectation.exponent),
        currency: expectation.currency,
        reference: simulationReference
      };
      const now = new Date().toISOString();
      const attempt: FundingAttempt = {
        id: randomUUID(),
        expectationDigest,
        // /sandbox/topup has no documented provider idempotency field. This
        // stable internal identity, case-scoped reference, and no-resubmit
        // gate preserve a one-attempt audit trail without sending unknown API
        // fields to Revolut.
        providerRequestId,
        state: 'SUBMITTING',
        createdAt: now,
        updatedAt: now
      };
      const expectedRevision = record.revision ?? 0;
      attempt.providerRequestHash = sha256(canonicalJson(request));
      attempts.push(attempt);
      const requestEvidenceRef = this.preserveProviderEvidence({
        operation: 'sandbox_topup',
        providerRequestId: attempt.providerRequestId,
        request
      });
      record.updatedAt = now;
      const reservation = this.store.reserveFundingAttempt(record, expectationDigest, attempt.id, expectedRevision, {
        eventType: 'SANDBOX_FUNDING_SUBMISSION_STARTED',
        actor,
        reason: 'Full-value Sandbox funding request was reserved with a stable case attempt identity.',
        evidenceRefs: [requestEvidenceRef],
        payload: { providerRequestId: attempt.providerRequestId, requestHash: attempt.providerRequestHash }
      });
      if (reservation !== 'ACQUIRED') {
        attempts.pop();
        throw new Error(reservation === 'STALE'
          ? 'This case changed while full-value Sandbox funding was being prepared; refresh it before retrying.'
          : 'This full-value Sandbox funding attempt is already reserved by another worker; refresh and reconcile it before retrying.');
      }
      const reservationRevision = record.revision ?? 0;
      let result: Awaited<ReturnType<NonNullable<SandboxInternalTransferClient['simulateTopUp']>>>;
      try {
        result = await this.provider.simulateTopUp(request);
      } catch (error) {
        const evidenceRef = this.preserveProviderEvidence({
          operation: 'sandbox_topup',
          providerRequestId: attempt.providerRequestId,
          request,
          error: safeProviderError(error)
        });
        const findingCode = providerFailureFinding(error, 'funding');
        attempt.providerResponseHash = evidenceRef;
        attempt.state = findingCode === 'PROVIDER_RESPONSE_AMBIGUOUS' ||
          findingCode === 'PROVIDER_AMOUNT_LIMIT_UNKNOWN'
          ? 'AMBIGUOUS'
          : 'FAILED';
        attempt.updatedAt = new Date().toISOString();
        this.addProviderFinding(record, findingCode, [evidenceRef]);
        record.fundingStatus = 'UNMATCHED';
        record.updatedAt = attempt.updatedAt;
        appendRiskSnapshot(record);
        if (this.store.saveIfCurrent(record, reservationRevision, {
          eventType: 'SANDBOX_FUNDING_PROVIDER_FAILURE',
          allowFundingMutation: true,
          actor,
          reason: 'Sandbox funding outcome requires provider observation or documented reconciliation before any replacement.',
          evidenceRefs: [evidenceRef],
          payload: { providerRequestId: attempt.providerRequestId, findingCode }
        }) !== 'SAVED') {
          throw new Error('Sandbox funding changed while the provider response was being recorded; reconcile the reserved attempt before another action.');
        }
        this.store.markFundingAttemptRecorded(record.id, expectationDigest);
        return structuredClone(record);
      }
      const evidenceRef = this.preserveProviderEvidence({
        operation: 'sandbox_topup',
        providerRequestId: attempt.providerRequestId,
        request,
        response: result
      });
      simulationIds.add(result.id);
      attempt.providerTransactionId = result.id;
      attempt.providerResponseHash = evidenceRef;
      attempt.state = mapFundingAttemptState(result.state);
      attempt.updatedAt = new Date().toISOString();
      const resultFinding = providerResultFinding(result.state, 'funding');
      if (resultFinding) {
        this.addProviderFinding(record, resultFinding, [evidenceRef]);
        record.fundingStatus = 'UNMATCHED';
        record.updatedAt = attempt.updatedAt;
        appendRiskSnapshot(record);
        if (this.store.saveIfCurrent(record, reservationRevision, {
          eventType: 'SANDBOX_FUNDING_PROVIDER_LIMIT',
          allowFundingMutation: true,
          actor,
          reason: 'Sandbox funding returned a non-complete provider state; refresh observations before any replacement.',
          evidenceRefs: [evidenceRef],
          payload: {
            providerState: result.state,
            providerTransactionId: result.id,
            providerRequestId: attempt.providerRequestId,
            findingCode: resultFinding
          }
        }) !== 'SAVED') {
          throw new Error('Sandbox funding changed while the provider response was being recorded; reconcile the reserved attempt before another action.');
        }
        this.store.markFundingAttemptRecorded(record.id, expectationDigest);
        return structuredClone(record);
      }
      // Persist the provider response before any broader transaction
      // observation. This lets a concurrent broker action see a durable
      // completed attempt, never an in-memory-only top-up result.
      if (this.store.saveIfCurrent(record, reservationRevision, {
        eventType: 'SANDBOX_FUNDING_PROVIDER_RESULT',
        allowFundingMutation: true,
        actor,
        reason: 'Sandbox funding provider response recorded before independent observation refresh.',
        evidenceRefs: [evidenceRef],
        payload: {
          providerState: result.state,
          providerTransactionId: result.id,
          providerRequestId: attempt.providerRequestId
        }
      }) !== 'SAVED') {
        throw new Error('Sandbox funding changed while the provider response was being recorded; reconcile the reserved attempt before another action.');
      }
      this.store.markFundingAttemptRecorded(record.id, expectationDigest);
    }
    if (!this.provider.listTransactions) throw new Error('Provider transaction observation is unavailable.');
    let transactions: RevolutSandboxTransaction[];
    try {
      transactions = await this.provider.listTransactions();
    } catch (error) {
      const evidenceRef = this.preserveProviderEvidence({
        operation: 'funding_observation',
        error: safeProviderError(error)
      });
      const findingCode = providerFailureFinding(error, 'funding');
      const interruptedAttempt = [...attempts].reverse().find(item => item.expectationDigest === expectationDigest);
      const activeFundingReservation = !simulate && this.store.hasActiveFundingAttemptLock(record.id);
      if (activeFundingReservation && interruptedAttempt) {
        // An observation outage cannot establish whether the reserved request
        // reached the provider. Persist it as ambiguous and release only the
        // worker reservation, never the attempt's no-resubmit record.
        interruptedAttempt.state = 'AMBIGUOUS';
        interruptedAttempt.providerResponseHash = evidenceRef;
        interruptedAttempt.updatedAt = new Date().toISOString();
      }
      this.addProviderFinding(record, findingCode, [evidenceRef]);
      record.fundingStatus = 'UNMATCHED';
      record.updatedAt = new Date().toISOString();
      appendRiskSnapshot(record);
      const observationFailureEvent = {
        eventType: 'FUNDING_OBSERVATION_PROVIDER_FAILURE',
        actor,
        reason: 'Provider funding observations could not be refreshed.',
        evidenceRefs: [evidenceRef],
        payload: { findingCode }
      };
      if (activeFundingReservation) {
        const recovery = this.store.saveObservedFundingRecovery(
          record,
          expectationDigest,
          record.revision ?? 0,
          { ...observationFailureEvent, allowFundingMutation: true }
        );
        if (recovery !== 'SAVED') {
          throw new Error('Funding observations changed while an interrupted submission was being recovered; refresh before retrying.');
        }
      } else if (this.store.saveIfCurrent(record, record.revision ?? 0, observationFailureEvent) !== 'SAVED') {
        throw new Error('Funding observations changed while the provider failure was being recorded; refresh before retrying.');
      }
      return structuredClone(record);
    }
    // The provider list endpoint is broad. Retain evidence only for the
    // case-labelled destination-account transactions, never neighboring
    // Sandbox account activity returned in the same page.
    const observedAttempt = [...attempts].reverse().find(item => item.expectationDigest === expectationDigest);
    const observations = transactions
      .filter(transaction => isRelevantFundingTransaction(
        transaction,
        expectation,
        simulationIds,
        simulationReferences
      ))
      .flatMap(transaction => {
        const evidenceRef = this.preserveProviderEvidence({
          operation: 'funding_observation',
          response: transaction
        });
        if (observedAttempt && (
          isCaseSimulationFundingTransaction(transaction, simulationIds, simulationReferences) ||
          transaction.reference === expectation.reference
        )) {
          observedAttempt.providerTransactionId = transaction.id;
          observedAttempt.providerResponseHash = evidenceRef;
          observedAttempt.state = mapFundingAttemptState(transaction.state);
          observedAttempt.updatedAt = new Date().toISOString();
          const resultFinding = providerResultFinding(transaction.state, 'funding');
          if (resultFinding) this.addProviderFinding(record, resultFinding, [evidenceRef]);
        }
        return transactionObservations(
          transaction,
          expectation,
          simulationIds,
          simulationReferences,
          evidenceRef
        );
      });
    for (const observation of observations) {
      const existing = record.providerObservations.find(item => item.providerTransactionId === observation.providerTransactionId);
      if (existing) Object.assign(existing, observation, { id: existing.id });
      else record.providerObservations.push(observation);
    }
    const candidates = record.providerObservations.filter(item =>
      isExactFundingObservation(item, expectation)
    );
    const previousMatched = record.fundingStatus === 'MATCHED';
    record.fundingStatus = candidates.length === 1
      ? 'MATCHED'
      : candidates.length > 1
        ? 'POSSIBLE_MATCH'
        : 'UNMATCHED';
    if (candidates.length === 1) {
      resolveFindings(record, ['INCOMING_SETTLEMENT_UNOBSERVED'], 'PROVIDER_OBSERVATION');
      if (observedAttempt?.state === 'COMPLETED') {
        resolveFindings(record, [...reconcilableFundingFindingCodes], 'PROVIDER_OBSERVATION');
      }
      if (record.caseStatus === 'INTAKE_HOLD' &&
          !record.riskFindings.some(item => item.hardBlock && !item.resolvedAt)) {
        record.caseStatus = 'AWAITING_BROKER';
      }
    } else if (previousMatched) {
      record.fundingStatus = 'REVERSED';
      invalidateAuthorization(record, 'Matched funding was reversed or is no longer a unique exact match');
    }
    // A worker may have reserved a funding request and then stopped before it
    // could durably record a provider result.  A later independent lookup
    // must convert that reservation into an auditable recovery state instead
    // of leaving the case permanently locked.  It does not permit resubmission:
    // the recorded lock and attempt remain the one authoritative attempt.
    const activeFundingReservation = !simulate && this.store.hasActiveFundingAttemptLock(record.id);
    let recoveryEvidenceRef: string | undefined;
    if (activeFundingReservation && (!observedAttempt || observedAttempt.state === 'SUBMITTING')) {
      recoveryEvidenceRef = this.preserveProviderEvidence({
        operation: 'funding_observation_recovery',
        providerRequestId: observedAttempt?.providerRequestId,
        outcome: 'No case-labelled provider transaction could be observed after a reserved Sandbox funding submission.'
      });
      if (observedAttempt) {
        observedAttempt.state = 'AMBIGUOUS';
        observedAttempt.providerResponseHash = recoveryEvidenceRef;
        observedAttempt.updatedAt = new Date().toISOString();
      }
      this.addProviderFinding(record, 'PROVIDER_RESPONSE_AMBIGUOUS', [recoveryEvidenceRef]);
    }
    record.updatedAt = new Date().toISOString();
    appendRiskSnapshot(record);
    const observationEvent = {
      eventType: simulate ? 'SANDBOX_FUNDING_SIMULATED_AND_REFRESHED' : 'FUNDING_OBSERVATIONS_REFRESHED',
      actor,
      reason: simulate
        ? 'Operator requested an explicitly labelled Sandbox test credit.'
        : 'Provider transactions independently refreshed.',
      evidenceRefs: [
        ...candidates.map(item => item.rawResponseSha256),
        ...(recoveryEvidenceRef ? [recoveryEvidenceRef] : [])
      ],
      payload: {
        fundingStatus: record.fundingStatus,
        exactMatchCount: candidates.length,
        simulation: simulate
      }
    };
    if (activeFundingReservation) {
      const recovery = this.store.saveObservedFundingRecovery(
        record,
        expectationDigest,
        record.revision ?? 0,
        { ...observationEvent, allowFundingMutation: true }
      );
      if (recovery === 'STALE') {
        throw new Error('Funding observations changed while recovery was being recorded; refresh the case before retrying.');
      }
      if (recovery === 'NOT_ACTIVE' && this.store.saveIfCurrent(record, record.revision ?? 0, observationEvent) !== 'SAVED') {
        throw new Error('Funding observations changed while they were being recorded; refresh the case before retrying.');
      }
    } else if (this.store.saveIfCurrent(record, record.revision ?? 0, observationEvent) !== 'SAVED') {
      throw new Error('Funding observations changed while they were being recorded; refresh the case before retrying.');
    }
    return structuredClone(record);
  }

  createPlan(caseId: string, input: PlanInput, actor: string) {
    const record = this.mustGet(caseId);
    this.requireNoActiveExecution(record, 'A new funding plan');
    requirePriorExecutionsReconciled(record);
    if (record.caseStatus !== 'APPROVED' || record.fundingStatus !== 'MATCHED') {
      throw new Error('The case must be approved with exactly matched funding before a plan is created.');
    }
    const snapshot = appendRiskSnapshot(record);
    if (snapshot.overall !== 'LOW') throw new Error('The current risk snapshot is not LOW.');
    const expectation = record.fundingExpectation;
    const observation = record.providerObservations.find(item => item.id === input.receiptObservationId);
    if (!expectation || !observation || !isExactFundingObservation(observation, expectation)) {
      throw new Error('The funding-plan receipt must reference the completed matched provider credit.');
    }
    this.requireSandboxCaseAmount(observation);
    if (!Array.isArray(input.allocations) || input.allocations.length === 0) {
      throw new Error('At least one funding allocation is required.');
    }
    const allocations = input.allocations.map(allocation => validateAllocation(allocation, observation));
    if (allocations.some(allocation => allocation.sourceAccountId !== expectation.destinationAccountId)) {
      throw new Error('Every allocation must originate from the account that received the exact matched funding credit.');
    }
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
    if (this.activeSandboxExecutionKey && this.activeSandboxExecutionKey !== key) {
      throw new Error('Another Sandbox case execution is in progress; reconcile it before starting a different case.');
    }
    const record = this.mustGet(caseId);
    const plan = mustPlan(record, version);
    this.requireSandboxCaseAmount(plan.receipt);
    const approval = record.approvals.find(item =>
      item.planVersion === version && item.planDigest === plan.digest && !item.invalidatedAt
    );
    if (!approval || plan.status !== 'AUTHORIZED' || record.executionStatus !== 'AUTHORIZED') {
      throw new Error('The exact current plan does not have a valid authorization.');
    }
    const expectedRevision = record.revision ?? 0;
    plan.status = 'EXECUTING';
    record.executionStatus = 'QUEUED';
    record.updatedAt = new Date().toISOString();
    const reservation = this.store.reserveExecution(record, version, plan.digest, expectedRevision, {
      eventType: 'EXECUTION_QUEUED',
      actor,
      reason: 'Broker supplied fresh execution reauthentication and the plan-specific phrase.',
      payload: { planVersion: version, planDigest: plan.digest }
    });
    if (reservation === 'CASE_LOCKED') {
      throw new Error('This case execution is already reserved by another worker; reconcile its provider state before retrying.');
    }
    if (reservation === 'PILOT_LOCKED') {
      throw new Error('Another high-value Sandbox case is reserved for execution; reconcile it before starting a different case.');
    }
    if (reservation === 'STALE') {
      throw new Error('This case changed while execution was being authorized; refresh it and repeat fresh authorization.');
    }
    const task = this.executeSequentially(caseId, version, actor);
    this.execution.set(key, task);
    this.activeSandboxExecutionKey = key;
    try {
      return structuredClone(await task);
    } finally {
      this.execution.delete(key);
      if (this.activeSandboxExecutionKey === key) this.activeSandboxExecutionKey = undefined;
      const current = this.store.get(caseId);
      if (current && executionNeedsReconciliation(current, version)) {
        this.store.markExecutionReadyAfterSubmission(caseId, version);
      } else {
        this.store.releaseExecutionReservation(caseId, version);
      }
    }
  }

  async reconcile(caseId: string, actor: string) {
    let record = this.mustGet(caseId);
    let planBeforeReconciliation = latestPlan(record);
    if (!planBeforeReconciliation || planBeforeReconciliation.status !== 'EXECUTING') {
      throw new Error('Only an executing Sandbox funding plan can be reconciled.');
    }
    const claimedPlanVersion = planBeforeReconciliation?.version;
    const lockState = planBeforeReconciliation
      ? this.store.executionLockState(record.id, planBeforeReconciliation.version)
      : undefined;
    const staleExecutionClaimToken = (lockState === 'ACTIVE' || lockState === 'RECONCILING') && planBeforeReconciliation
      ? this.store.claimStaleExecutionReconciliation(
          record.id,
          planBeforeReconciliation.version,
          new Date(Date.now() - STALE_EXECUTION_RECOVERY_MS).toISOString()
        )
      : undefined;
    if ((lockState === 'ACTIVE' || lockState === 'RECONCILING') && !staleExecutionClaimToken) {
      throw new Error('This Sandbox execution is still being submitted; wait for its durable result before reconciliation.');
    }
    if (record.executionStatus === 'QUEUED' && !staleExecutionClaimToken) {
      throw new Error('This Sandbox execution is queued; wait for the submission worker to finish before reconciliation.');
    }
    const reconciliationClaimToken = staleExecutionClaimToken || (lockState === 'READY_TO_RECONCILE'
      ? this.store.claimExecutionReconciliation(record.id, planBeforeReconciliation!.version)
      : undefined);
    const reconciliationClaimed = Boolean(reconciliationClaimToken);
    if (lockState === 'READY_TO_RECONCILE' && !reconciliationClaimToken) {
      throw new Error('Another worker claimed this Sandbox reconciliation; refresh the case before retrying.');
    }
    try {
      // A READY lock permits observation refreshes until this worker claims it.
      // Reload only after that durable claim so an earlier snapshot can never
      // overwrite an intervening case update during reconciliation.
      if (reconciliationClaimed) {
        record = this.mustGet(caseId);
        planBeforeReconciliation = latestPlan(record);
        if (!planBeforeReconciliation || planBeforeReconciliation.version !== claimedPlanVersion) {
          throw new Error('The claimed Sandbox execution plan changed before reconciliation began.');
        }
      }
      const reconciliationRevision = record.revision ?? 0;
      record.executionStatus = 'RECONCILING';
    for (const attempt of record.executionAttempts.filter(item =>
      ['SUBMITTING', 'PENDING', 'AMBIGUOUS'].includes(item.state)
    )) {
      if (reconciliationClaimToken && planBeforeReconciliation &&
          !this.store.heartbeatExecutionLock(
            record.id,
            planBeforeReconciliation.version,
            'RECONCILING',
            reconciliationClaimToken
          )) {
        throw new Error('Sandbox reconciliation reservation is no longer owned by this worker.');
      }
      let result: Awaited<ReturnType<SandboxInternalTransferClient['getTransaction']>> | undefined;
      if (attempt.providerTransactionId) {
        try {
          result = await this.provider.getTransaction(attempt.providerTransactionId);
        } catch (error) {
          const evidenceRef = this.preserveProviderEvidence({
            operation: 'payout_reconciliation',
            providerRequestId: attempt.providerRequestId,
            error: safeProviderError(error)
          });
          attempt.state = 'AMBIGUOUS';
          attempt.providerResponseHash = evidenceRef;
          attempt.updatedAt = new Date().toISOString();
          this.addProviderFinding(record, 'PROVIDER_RESPONSE_AMBIGUOUS', [evidenceRef]);
          continue;
        }
      } else if (this.provider.listTransactions) {
        try {
          const candidates = await this.provider.listTransactions({
            requestId: attempt.providerRequestId,
            from: providerLookupFrom(attempt.createdAt)
          });
          if (candidates.length === 1) {
            const recovered = candidates[0]!;
            attempt.providerTransactionId = recovered.id;
            const evidenceRef = this.preserveProviderEvidence({
              operation: 'payout_reconciliation_lookup',
              providerRequestId: attempt.providerRequestId,
              response: recovered
            });
            attempt.providerResponseHash = evidenceRef;
            result = recovered;
          }
        } catch (error) {
          const evidenceRef = this.preserveProviderEvidence({
            operation: 'payout_reconciliation_lookup',
            providerRequestId: attempt.providerRequestId,
            error: safeProviderError(error)
          });
          attempt.providerResponseHash = evidenceRef;
        }
      }
      if (!result) {
        attempt.state = 'AMBIGUOUS';
        attempt.updatedAt = new Date().toISOString();
        this.addProviderFinding(record, 'PROVIDER_RESPONSE_AMBIGUOUS', attempt.providerResponseHash
          ? [attempt.providerResponseHash]
          : []);
        continue;
      }
      attempt.state = mapAttemptState(result.state);
      const evidenceRef = this.preserveProviderEvidence({
        operation: 'payout_reconciliation',
        providerRequestId: attempt.providerRequestId,
        response: result
      });
      attempt.providerResponseHash = evidenceRef;
      attempt.updatedAt = new Date().toISOString();
      const resultFinding = providerResultFinding(result.state, 'execution');
      if (resultFinding) this.addProviderFinding(record, resultFinding, [evidenceRef]);
      if (attempt.state !== 'COMPLETED') break;
    }
    const plan = latestPlan(record);
    const actionable = plan?.allocations.filter(item => item.method !== 'RETAIN') ?? [];
    const planAttempts = plan
      ? record.executionAttempts.filter(item => item.planVersion === plan.version)
      : [];
    const completed = planAttempts.filter(item => item.state === 'COMPLETED').length;
    const hasNonTerminalAttempt = planAttempts.some(item =>
      ['SUBMITTING', 'PENDING', 'AMBIGUOUS'].includes(item.state)
    );
    const hasTerminalFailure = planAttempts.some(item =>
      ['FAILED', 'REVERTED', 'DECLINED'].includes(item.state)
    );
    record.executionStatus = completed === actionable.length
      ? 'RECONCILED'
      : hasTerminalFailure || !hasNonTerminalAttempt
        ? 'FAILED'
      : completed > 0
          ? 'PARTIAL'
          : 'BLOCKED';
    if (record.executionStatus === 'RECONCILED') {
      if (plan) plan.status = 'RECONCILED';
      record.caseStatus = 'CLOSED';
    } else if (record.executionStatus === 'FAILED' && plan) {
      plan.status = 'FAILED';
    } else if (planAttempts.length > 0) {
      this.addProviderFinding(record, 'PROVIDER_RECONCILIATION_MISMATCH', planAttempts
        .map(item => item.providerResponseHash)
        .filter((value): value is string => Boolean(value)));
    }
    record.updatedAt = new Date().toISOString();
    appendRiskSnapshot(record);
    if (this.store.saveIfCurrent(record, reconciliationRevision, {
      eventType: 'EXECUTION_RECONCILED',
      allowExecutionMutation: true,
      ...(reconciliationClaimToken && planBeforeReconciliation ? {
        requiredExecutionPlanVersion: planBeforeReconciliation.version,
        requiredExecutionLockState: 'RECONCILING' as const,
        requiredExecutionClaimToken: reconciliationClaimToken
      } : {}),
      actor,
      reason: 'Non-terminal provider results were refreshed.',
      payload: { executionStatus: record.executionStatus }
    }) !== 'SAVED') {
      throw new Error('Case changed while reconciliation was in progress; refresh before retrying.');
    }
      if (plan && ['RECONCILED', 'FAILED'].includes(record.executionStatus)) {
        this.store.releaseExecutionReservation(record.id, plan.version);
      } else if (reconciliationClaimed && planBeforeReconciliation) {
        this.store.releaseExecutionReconciliationClaim(
          record.id,
          planBeforeReconciliation.version,
          reconciliationClaimToken!
        );
      }
      return structuredClone(record);
    } catch (error) {
      if (reconciliationClaimed && planBeforeReconciliation) {
        this.store.releaseExecutionReconciliationClaim(
          record.id,
          planBeforeReconciliation.version,
          reconciliationClaimToken!
        );
      }
      throw error;
    }
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
      // A clean archive remains useful for diagnostic review even when it does
      // not match a transaction-ready profile. Never retain or expose an
      // inventory until the *whole* package scan has cleared.
      record.artifacts = archive.scanner === 'CLEAN'
        ? archive.entries.map(entry => {
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
          })
        : [];
      const analysis = analyzePackage(archive, this.trustedSourceKeys);
      if (analysis.fundingExpectation) {
        const amountLimitFinding = this.sandboxCaseAmountFinding(analysis.fundingExpectation);
        if (amountLimitFinding) analysis.findings.push(amountLimitFinding);
      }
      if (analysis.submissionIdentity) {
        this.store.bindSubmissionIdentity(record.id, analysis.submissionIdentity, submission.packageSha256);
      }
      submission.format = analysis.format;
      submission.scanner = archive.scanner;
      submission.state = archive.scanner === 'CLEAN' ? 'VALIDATED' : 'QUARANTINED';
      submission.completedAt = new Date().toISOString();
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
      record.caseStatus = 'QUARANTINED';
      record.updatedAt = now;
      const technicalFinding = finding(archiveFailureCode(error), [submission.packageSha256]);
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
    const actionable = plan.allocations.filter(allocation => allocation.method !== 'RETAIN');
    for (const [index, allocation] of actionable.entries()) {
      let attempt = record.executionAttempts.find(item =>
        item.planVersion === version && item.allocationId === allocation.id
      );
      if (attempt?.state === 'COMPLETED') continue;
      if (attempt && attempt.state !== 'UNSUBMITTED') {
        record.executionStatus = completedAttempts(record, version) > 0 ? 'PARTIAL' : 'BLOCKED';
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
      const requestEvidenceRef = this.preserveProviderEvidence({
        operation: 'payout_submission',
        request: requestBody
      });
      record.updatedAt = now;
      this.store.save(record, {
        eventType: 'PAYOUT_SUBMISSION_STARTED',
        allowExecutionMutation: true,
        requiredExecutionPlanVersion: version,
        actor,
        reason: 'Sequential payout preflight passed; stable provider request ID reserved.',
        evidenceRefs: [requestEvidenceRef],
        payload: {
          allocationId: allocation.id,
          sequence: attempt.sequence,
          requestHash: attempt.providerRequestHash
        }
      });
      try {
        if (!this.store.heartbeatExecutionLock(caseId, version)) {
          throw new Error('Sandbox execution reservation is no longer active; reconcile before another payout.');
        }
        await this.preflight(allocation);
        // Re-read the durable case after the awaited provider preflight. A
        // cross-worker change to funding, risk, or authorization must stop
        // before this irreversible provider call.
        const current = this.mustGet(caseId);
        const currentPlan = mustPlan(current, version);
        this.requireExecutionAuthorization(current, currentPlan, version);
        if (!this.store.heartbeatExecutionLock(caseId, version)) {
          throw new Error('Sandbox execution reservation is no longer active; reconcile before another payout.');
        }
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
        const responseEvidenceRef = this.preserveProviderEvidence({
          operation: 'payout_submission',
          response: result
        });
        attempt.providerResponseHash = responseEvidenceRef;
        attempt.state = mapAttemptState(result.state);
        attempt.updatedAt = new Date().toISOString();
        record.updatedAt = attempt.updatedAt;
        const resultFinding = providerResultFinding(result.state, 'execution');
        if (resultFinding) this.addProviderFinding(record, resultFinding, [responseEvidenceRef]);
        this.store.save(record, {
          eventType: 'PAYOUT_PROVIDER_RESULT',
          allowExecutionMutation: true,
          requiredExecutionPlanVersion: version,
          actor,
          reason: 'Provider returned a result for the reserved payout request ID.',
          evidenceRefs: [responseEvidenceRef],
          payload: {
            allocationId: allocation.id,
            sequence: attempt.sequence,
            state: attempt.state,
            responseHash: attempt.providerResponseHash,
            ...(resultFinding ? { findingCode: resultFinding } : {})
          }
        });
        if (attempt.state !== 'COMPLETED') {
          record.executionStatus = completedAttempts(record, version) > 0 ? 'PARTIAL' : 'BLOCKED';
          break;
        }
      } catch (error) {
        const findingCode = providerFailureFinding(error, 'execution');
        const evidenceRef = this.preserveProviderEvidence({
          operation: 'payout_submission',
          error: safeProviderError(error)
        });
        attempt.providerResponseHash = evidenceRef;
        attempt.state = findingCode === 'PROVIDER_RESPONSE_AMBIGUOUS' ||
          findingCode === 'PROVIDER_AMOUNT_LIMIT_UNKNOWN'
          ? 'AMBIGUOUS'
          : 'FAILED';
        attempt.updatedAt = new Date().toISOString();
        record.executionStatus = completedAttempts(record, version) > 0 ? 'PARTIAL' : 'BLOCKED';
        record.updatedAt = attempt.updatedAt;
        this.addProviderFinding(record, findingCode, [evidenceRef]);
        this.store.save(record, {
          eventType: attempt.state === 'AMBIGUOUS'
            ? 'PAYOUT_SUBMISSION_AMBIGUOUS'
            : 'PAYOUT_SUBMISSION_FAILED',
          allowExecutionMutation: true,
          requiredExecutionPlanVersion: version,
          actor,
          reason: attempt.state === 'AMBIGUOUS'
            ? 'Submission outcome is ambiguous; reconcile before any retry.'
            : 'Submission was blocked or rejected; retain the provider finding before any amendment.',
          evidenceRefs: [evidenceRef],
          payload: {
            allocationId: allocation.id,
            sequence: attempt.sequence,
            errorHash: sha256(error instanceof Error ? error.message : String(error)),
            findingCode
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
    appendRiskSnapshot(record);
    this.store.save(record, {
      eventType: 'SEQUENTIAL_EXECUTION_PAUSED',
      allowExecutionMutation: true,
      requiredExecutionPlanVersion: version,
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

  private sandboxCaseAmountFinding(value: Money) {
    if (canonicalCurrencyExponent(value.currency) !== value.exponent) {
      return finding('PROVIDER_CURRENCY_LIMIT');
    }
    const maximum = this.sandboxCaseMaximumMinorByCurrency[value.currency];
    if (maximum === undefined || !Number.isSafeInteger(maximum) || maximum < 1) {
      return finding('PROVIDER_CURRENCY_LIMIT');
    }
    if (value.amountMinor > maximum) {
      return finding('SANDBOX_CASE_AMOUNT_LIMIT_EXCEEDED');
    }
    return undefined;
  }

  private requireSandboxCaseAmount(value: Money) {
    if (!Number.isSafeInteger(value.amountMinor) || value.amountMinor < 1) {
      throw new Error('Sandbox case amount must be a positive safe integer of minor units.');
    }
    if (!/^[A-Z]{3}$/.test(value.currency)) {
      throw new Error('Sandbox case currency must be a three-letter uppercase code.');
    }
    requireCanonicalCurrencyExponent(value.currency, value.exponent);
    const amountFinding = this.sandboxCaseAmountFinding(value);
    if (amountFinding) throw new Error(amountFinding.message);
  }

  private addProviderFinding(record: BrokeredCase, code: string, evidenceRefs: string[] = []) {
    const active = record.riskFindings.find(item => item.code === code && !item.resolvedAt);
    if (active) {
      active.evidenceRefs = [...new Set([...active.evidenceRefs, ...evidenceRefs])];
      return active;
    }
    const created = finding(code, evidenceRefs);
    record.riskFindings.push(created);
    return created;
  }

  private requireNoActiveExecution(record: BrokeredCase, action: string) {
    if (this.store.hasActiveFundingAttemptLock(record.id)) {
      throw new Error(`${action} are blocked while a Sandbox funding submission is still being recorded.`);
    }
    if (this.store.hasActiveExecutionLock(record.id) ||
        ['QUEUED', 'RECONCILING'].includes(record.executionStatus) ||
        record.plans.some(plan => plan.status === 'EXECUTING')) {
      throw new Error(`${action} are blocked while a Sandbox execution is in progress; reconcile it first.`);
    }
  }

  private requireExecutionAuthorization(record: BrokeredCase, plan: FundingPlan, version: number) {
    const approval = record.approvals.find(item =>
      item.planVersion === version && item.planDigest === plan.digest && !item.invalidatedAt
    );
    const snapshot = appendRiskSnapshot(record);
    if (this.store.executionLockState(record.id, version) !== 'ACTIVE' ||
        !approval || plan.status !== 'EXECUTING' || record.caseStatus !== 'APPROVED' ||
        record.fundingStatus !== 'MATCHED' || snapshot.overall !== 'LOW' ||
        snapshot.digest !== plan.riskSnapshotDigest) {
      throw new Error('Sandbox execution authorization is no longer current; reconciliation is required before another attempt.');
    }
  }

  private preserveProviderEvidence(value: unknown) {
    const safeValue = redactProviderEvidence(value);
    return this.evidence.put(Buffer.from(canonicalJson(safeValue))).plaintextSha256;
  }

  private mustGet(caseId: string) {
    const record = this.store.get(caseId);
    if (!record) throw new Error('Case not found.');
    return record;
  }
}

const diagnosticWalkthroughFindingCodes = new Set([
  'MANIFEST_MISSING',
  'MANIFEST_PARSE_FAILED',
  'UNSUPPORTED_PACKAGE_PROFILE',
  'UNSUPPORTED_ARTIFACT_TYPE',
  'ARTIFACT_PARSE_FAILED',
  'REQUIRED_TRANSACTION_FIELD_NOT_FOUND'
]);

const reconcilableFundingFindingCodes = new Set([
  'SANDBOX_TOPUP_LIMIT_REACHED',
  'SANDBOX_BALANCE_INSUFFICIENT',
  'PROVIDER_AMOUNT_LIMIT_UNKNOWN',
  'PROVIDER_CURRENCY_LIMIT',
  'PROVIDER_PENDING_BEYOND_TEST_WINDOW',
  'PROVIDER_RESPONSE_AMBIGUOUS',
  'PROVIDER_TRANSACTION_REVERSED'
]);

const replacementFundingFindingCodes = new Set([
  'SANDBOX_TOPUP_LIMIT_REACHED',
  'SANDBOX_BALANCE_INSUFFICIENT',
  'PROVIDER_AMOUNT_LIMIT_UNKNOWN',
  'PROVIDER_CURRENCY_LIMIT',
  'PROVIDER_TRANSACTION_REVERSED'
]);

// These findings attest to package safety/authenticity or to a provider result.
// They must be superseded by a clean re-upload or a provider reconciliation,
// never by an operator-entered amendment.
const nonAmendableFindingCodes = new Set([
  'ARCHIVE_NOT_ZIP',
  'ARCHIVE_STRUCTURE_INVALID',
  'ARCHIVE_LIMIT_EXCEEDED',
  'ARCHIVE_PATH_UNSAFE',
  'ARCHIVE_DUPLICATE_PATH',
  'ARCHIVE_COMPRESSION_RATIO_EXCEEDED',
  'MALWARE_SCANNER_UNAVAILABLE',
  'MALWARE_DETECTED',
  'MANIFEST_INVENTORY_MISMATCH',
  'MANIFEST_DECLARED_FILES_MISSING',
  'MANIFEST_UNDECLARED_FILE',
  'MANIFEST_ARTIFACT_MISMATCH',
  'ARTIFACT_PARSE_FAILED',
  'SOURCE_SIGNATURE_MISSING',
  'SOURCE_SIGNATURE_INVALID',
  'INCOMING_SETTLEMENT_UNOBSERVED',
  'SANDBOX_CASE_AMOUNT_LIMIT_EXCEEDED',
  'SANDBOX_TOPUP_LIMIT_REACHED',
  'SANDBOX_BALANCE_INSUFFICIENT',
  'PROVIDER_HIGH_VALUE_REJECTED',
  'PROVIDER_AMOUNT_LIMIT_UNKNOWN',
  'PROVIDER_CURRENCY_LIMIT',
  'PROVIDER_PENDING_BEYOND_TEST_WINDOW',
  'PROVIDER_RESPONSE_AMBIGUOUS',
  'PROVIDER_TRANSACTION_REVERSED',
  'PROVIDER_RECONCILIATION_MISMATCH'
]);

function validateBrokerFundingExpectation(value: unknown): IncomingFundingExpectation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Broker-confirmed incoming funding details must be an object.');
  }
  const candidate = value as Record<string, unknown>;
  if (!Number.isSafeInteger(candidate.amountMinor) || Number(candidate.amountMinor) < 1) {
    throw new Error('Broker-confirmed incoming amount must be a positive safe integer of minor units.');
  }
  if (typeof candidate.currency !== 'string' || !/^[A-Z]{3}$/.test(candidate.currency)) {
    throw new Error('Broker-confirmed incoming currency must be a three-letter uppercase code.');
  }
  if (!Number.isInteger(candidate.exponent)) {
    throw new Error('Broker-confirmed incoming currency exponent must be an integer.');
  }
  requireCanonicalCurrencyExponent(candidate.currency, candidate.exponent as number);
  const reference = requireText(candidate.reference, 'Broker-confirmed incoming reference', 140);
  const destinationAccountId = requireText(candidate.destinationAccountId, 'Broker-confirmed destination account', 100);
  const investorName = requireText(candidate.investorName, 'Broker-confirmed investor name', 200);
  return {
    amountMinor: candidate.amountMinor as number,
    currency: candidate.currency,
    exponent: candidate.exponent as number,
    reference: reference.trim(),
    destinationAccountId: destinationAccountId.trim(),
    investorName: investorName.trim()
  };
}

function archiveFailureCode(error: unknown) {
  if (error instanceof ArchiveValidationError) return error.code;
  return 'ARCHIVE_STRUCTURE_INVALID';
}

function sandboxFundingReference(caseId: string, submissionId: string) {
  return `SANDBOX SIM | CASE ${caseId.slice(0, 8).toUpperCase()} | SUB ${submissionId.slice(0, 24)} | PILOT`;
}

function fundingExpectationDigest(expectation: IncomingFundingExpectation) {
  return sha256(canonicalJson(expectation));
}

function stableFundingRequestId(caseId: string, expectationDigest: string) {
  const hash = Buffer.from(sha256(`${caseId}:funding:${expectationDigest}`), 'hex');
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function fundingAttempts(record: BrokeredCase) {
  // Records created before this field was introduced remain readable.
  return record.fundingAttempts ?? (record.fundingAttempts = []);
}

function providerResultFinding(
  state: string,
  phase: 'funding' | 'execution'
): string | undefined {
  const normalized = state.toUpperCase();
  if (normalized === 'COMPLETED') return undefined;
  if (normalized === 'REVERTED') return 'PROVIDER_TRANSACTION_REVERSED';
  if (normalized === 'PENDING' || normalized === 'SUBMITTING') return 'PROVIDER_PENDING_BEYOND_TEST_WINDOW';
  if (['FAILED', 'DECLINED'].includes(normalized)) {
    return phase === 'funding' ? 'SANDBOX_TOPUP_LIMIT_REACHED' : 'PROVIDER_HIGH_VALUE_REJECTED';
  }
  return 'PROVIDER_RESPONSE_AMBIGUOUS';
}

function mapFundingAttemptState(state: string): FundingAttempt['state'] {
  const normalized = state.toUpperCase();
  if (['COMPLETED', 'FAILED', 'REVERTED', 'DECLINED', 'PENDING'].includes(normalized)) {
    return normalized as FundingAttempt['state'];
  }
  return 'PENDING';
}

function providerFailureFinding(error: unknown, phase: 'funding' | 'execution') {
  // Classification may use useful provider text, but never an unredacted
  // response body: credential-shaped fields must not affect the finding.
  const message = canonicalJson(redactProviderEvidence(safeProviderError(error))).toLowerCase();
  if (/insufficient|balance/.test(message)) return 'SANDBOX_BALANCE_INSUFFICIENT';
  if (/currency/.test(message)) return 'PROVIDER_CURRENCY_LIMIT';
  if (/limit|maximum|amount|value/.test(message)) {
    return phase === 'funding' ? 'SANDBOX_TOPUP_LIMIT_REACHED' : 'PROVIDER_HIGH_VALUE_REJECTED';
  }
  if (/network|timeout|unavailable|ambiguous|connection/.test(message)) {
    return 'PROVIDER_RESPONSE_AMBIGUOUS';
  }
  return 'PROVIDER_AMOUNT_LIMIT_UNKNOWN';
}

function safeProviderError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    name: error instanceof Error ? error.name : 'UnknownProviderError',
    // Provider errors are retained only in encrypted evidence. Keep their
    // compact message separate from credentials and request headers.
    message: redactSensitiveText(message),
    ...(error instanceof OperationalFault && error.httpStatus !== undefined
      ? { httpStatus: error.httpStatus }
      : {}),
    ...(error instanceof OperationalFault && error.providerResponse !== undefined
      ? { providerResponse: error.providerResponse }
      : {})
  };
}

function redactProviderEvidence(value: unknown): unknown {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(redactProviderEvidence);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [
    key,
    /authorization|token|secret|password|cookie|api.?key|client.?assertion|private.?key/i.test(key)
      ? '[redacted]'
      : redactProviderEvidence(child)
  ]));
}

function redactSensitiveText(value: string) {
  return value
    .replace(
      /(["']?(?:authorization|(?:access|refresh)[_-]?token|token|secret|password|cookie|api[_-]?key|client[_-]?assertion|private[_-]?key)["']?\s*:\s*["']?)(?:bearer\s+)?[^"'\s,}&]+/gi,
      '$1[redacted]'
    )
    .replace(
      /(authorization|(?:(?:access|refresh)[_-]?)?token|secret|password|cookie|api[_-]?key|client[_-]?assertion|private[_-]?key)\s*[:=]\s*(?:bearer\s+)?[^\s,;&]+/gi,
      '$1=[redacted]'
    )
    .replace(
      /<(authorization|(?:access|refresh)[_-]?token|token|secret|password|cookie|api[_-]?key|client[_-]?assertion|private[_-]?key)(?:\s[^>]*)?>[^<]*<\/\1>/gi,
      '<$1>[redacted]</$1>'
    )
    .replace(/\bbearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]');
}

function nextAction(record: BrokeredCase) {
  if (record.caseStatus === 'CLOSED') return 'Export and retain the signed evidence bundle.';
  if (record.caseStatus === 'REJECTED') return 'Retain the rejection decision and supporting evidence.';
  if (record.caseStatus === 'QUARANTINED') {
    return record.submissions.at(-1)?.state === 'FAILED'
      ? 'This package failed safe intake; retain the finding and upload a clean replacement ZIP.'
      : 'Wait for private malware scanning.';
  }
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
  simulationIds: Set<string>,
  simulationReferences: Set<string>,
  rawResponseSha256: string
): ProviderObservation[] {
  const simulated = isCaseSimulationFundingTransaction(transaction, simulationIds, simulationReferences);
  return (transaction.legs ?? [])
    .filter(leg => leg.account_id === expectation.destinationAccountId && leg.currency === expectation.currency)
    .map(leg => {
    const amountMinor = decimalMajorToMinor(String(leg.amount), expectation.exponent);
    const direction = amountMinor >= 0 ? 'CREDIT' as const : 'DEBIT' as const;
    return {
      id: randomUUID(),
      providerTransactionId: transaction.id,
      accountId: leg.account_id ?? '',
      direction,
      state: transaction.state,
      reference: simulated ? expectation.reference : transaction.reference ?? '',
      amountMinor: Math.abs(amountMinor),
      currency: leg.currency,
      exponent: expectation.exponent,
      observedAt: new Date().toISOString(),
      source: simulated ? 'SANDBOX_SIMULATION' : 'PROVIDER',
      rawResponseSha256
    };
    });
}

function isRelevantFundingTransaction(
  transaction: RevolutSandboxTransaction,
  expectation: NonNullable<BrokeredCase['fundingExpectation']>,
  simulationIds: Set<string>,
  simulationReferences: Set<string>
) {
  if (isCaseSimulationFundingTransaction(transaction, simulationIds, simulationReferences)) return true;
  return transaction.reference === expectation.reference &&
    (transaction.legs ?? []).some(leg =>
      leg.account_id === expectation.destinationAccountId && leg.currency === expectation.currency
    );
}

function isCaseSimulationFundingTransaction(
  transaction: RevolutSandboxTransaction,
  simulationIds: Set<string>,
  simulationReferences: Set<string>
) {
  return simulationIds.has(transaction.id) ||
    (transaction.reference !== undefined && simulationReferences.has(transaction.reference));
}

function providerLookupFrom(createdAt: string) {
  const timestamp = Date.parse(createdAt);
  // Revolut's request-ID transaction lookup requires a recent from value.
  // Keep the search narrowly bounded to this attempt's creation time.
  if (!Number.isFinite(timestamp)) return new Date(Date.now() - 60_000).toISOString();
  return new Date(timestamp - 60_000).toISOString();
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
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0 ||
      !Number.isInteger(exponent) || exponent < 0 || exponent > 6) {
    throw new Error('Invalid provider amount.');
  }
  const decimal = minorToDecimal(amountMinor, exponent);
  const value = Number(decimal);
  if (!Number.isFinite(value) || JSON.stringify(value) === undefined ||
      decimalMajorToMinor(JSON.stringify(value), exponent) !== amountMinor) {
    throw new Error('Provider amount cannot be serialized without changing its minor-unit value.');
  }
  return value;
}

function minorToDecimal(amountMinor: number, exponent: number) {
  if (exponent === 0) return String(amountMinor);
  const digits = String(amountMinor).padStart(exponent + 1, '0');
  return `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
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

function completedAttempts(record: BrokeredCase, planVersion?: number) {
  return record.executionAttempts.filter(item =>
    item.state === 'COMPLETED' && (planVersion === undefined || item.planVersion === planVersion)
  ).length;
}

function requirePriorExecutionsReconciled(record: BrokeredCase) {
  for (const plan of record.plans) {
    const attempts = record.executionAttempts.filter(item => item.planVersion === plan.version);
    const hasNonTerminalAttempt = attempts.some(item =>
      ['SUBMITTING', 'PENDING', 'AMBIGUOUS'].includes(item.state)
    );
    if (plan.status === 'EXECUTING' || hasNonTerminalAttempt) {
      throw new Error('A prior Sandbox plan has not been reconciled; do not create a replacement plan yet.');
    }
    if (attempts.length > 0 && !['RECONCILED', 'FAILED'].includes(plan.status)) {
      throw new Error('A prior Sandbox plan has not reached a recorded final reconciliation state.');
    }
  }
}

function executionNeedsReconciliation(record: BrokeredCase, version: number) {
  const plan = record.plans.find(item => item.version === version);
  if (!plan) return false;
  const attempts = record.executionAttempts.filter(item => item.planVersion === version);
  return plan.status === 'EXECUTING' ||
    attempts.some(item => ['SUBMITTING', 'PENDING', 'AMBIGUOUS'].includes(item.state)) ||
    ['QUEUED', 'PARTIAL', 'RECONCILING', 'BLOCKED'].includes(record.executionStatus);
}

function isExactFundingObservation(
  observation: ProviderObservation,
  expectation: NonNullable<BrokeredCase['fundingExpectation']>
) {
  return observation.direction === 'CREDIT' &&
    observation.accountId === expectation.destinationAccountId &&
    observation.currency === expectation.currency &&
    observation.exponent === expectation.exponent &&
    observation.amountMinor === expectation.amountMinor &&
    observation.reference === expectation.reference &&
    ['completed', 'COMPLETED'].includes(observation.state);
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
