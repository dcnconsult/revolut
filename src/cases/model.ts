export type CaseStatus =
  | 'QUARANTINED'
  | 'INTAKE_HOLD'
  | 'AWAITING_BROKER'
  | 'INFORMATION_REQUIRED'
  | 'REJECTED'
  | 'APPROVED'
  | 'CLOSED'
  | 'EXCEPTION';

export type FundingStatus =
  | 'AWAITING_FUNDS'
  | 'POSSIBLE_MATCH'
  | 'MATCHED'
  | 'REVERSED'
  | 'UNMATCHED';

export type ExecutionStatus =
  | 'NOT_PLANNED'
  | 'PLAN_DRAFT'
  | 'AWAITING_AUTHORIZATION'
  | 'AUTHORIZED'
  | 'QUEUED'
  | 'PARTIAL'
  | 'RECONCILING'
  | 'RECONCILED'
  | 'BLOCKED'
  | 'FAILED';

export type RiskDimension =
  | 'technical_integrity'
  | 'source_authentication'
  | 'investor_identity'
  | 'beneficiary_identity'
  | 'authority'
  | 'source_of_funds'
  | 'document_consistency'
  | 'incoming_settlement'
  | 'payout_structure'
  | 'execution_readiness';

export interface Money {
  amountMinor: number;
  currency: string;
  exponent: number;
}

export interface Submission {
  id: string;
  version: number;
  packageSha256: string;
  format: 'brokered-funding/1.0' | 'legacy-asset-declaration' | 'generic-compatibility/1.0';
  originalArtifactSha256: string;
  state: 'QUEUED' | 'VALIDATING' | 'QUARANTINED' | 'VALIDATED' | 'FAILED';
  receivedAt: string;
  completedAt?: string;
  scanner: 'CLEAN' | 'INFECTED' | 'UNAVAILABLE' | 'NOT_RUN';
}

export interface Artifact {
  id: string;
  submissionId: string;
  path: string;
  normalizedPath: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
  encryptedObjectSha256: string;
  scanStatus: 'CLEAN' | 'INFECTED' | 'UNAVAILABLE' | 'NOT_RUN';
}

export interface CaseClaim {
  id: string;
  version: number;
  path: string;
  value: unknown;
  source: 'SUBMISSION' | 'BROKER_AMENDMENT' | 'PROVIDER_OBSERVATION';
  evidenceRefs: string[];
  recordedAt: string;
  supersedesClaimId?: string;
}

export interface RiskFinding {
  id: string;
  code: string;
  dimension: RiskDimension;
  severity: 'INFO' | 'WARNING' | 'BLOCK';
  hardBlock: boolean;
  message: string;
  neededNext: string;
  evidenceRefs: string[];
  createdAt: string;
  resolvedAt?: string;
  resolvedByAmendmentId?: string;
}

export interface BrokerFinding {
  id: string;
  category: string;
  outcome: 'PASS' | 'CONCERN' | 'BLOCK';
  note: string;
  evidenceRefs: string[];
  actor: string;
  recordedAt: string;
}

export interface CaseAmendment {
  id: string;
  version: number;
  reason: string;
  source: string;
  claims: Array<{ path: string; value: unknown }>;
  resolvesFindingCodes: string[];
  evidenceRefs: string[];
  actor: string;
  recordedAt: string;
}

export interface IncomingFundingExpectation extends Money {
  reference: string;
  destinationAccountId: string;
  investorName: string;
}

export interface ProviderObservation extends Money {
  id: string;
  providerTransactionId: string;
  accountId: string;
  direction: 'CREDIT' | 'DEBIT';
  state: string;
  reference: string;
  observedAt: string;
  source: 'PROVIDER' | 'SANDBOX_SIMULATION';
  rawResponseSha256: string;
}

export interface FundingAttempt {
  id: string;
  expectationDigest: string;
  providerRequestId: string;
  providerTransactionId?: string;
  providerRequestHash?: string;
  providerResponseHash?: string;
  state: 'SUBMITTING' | 'PENDING' | 'COMPLETED' | 'FAILED' | 'REVERTED' | 'DECLINED' | 'AMBIGUOUS';
  createdAt: string;
  updatedAt: string;
}

export type AllocationKind =
  | 'CUSTOMER_PAYOUT'
  | 'BROKER_FEE'
  | 'PROVIDER_FEE'
  | 'RESERVE'
  | 'REFUND';

export interface FundingAllocation extends Money {
  id: string;
  kind: AllocationKind;
  beneficiaryName: string;
  reference: string;
  method: 'OWNED_ACCOUNT_TRANSFER' | 'COUNTERPARTY_PAYMENT' | 'RETAIN';
  sourceAccountId: string;
  targetAccountId?: string;
  counterpartyId?: string;
  paymentMethodId?: string;
}

export interface FundingPlan {
  version: number;
  createdAt: string;
  createdBy: string;
  receiptObservationId: string;
  receipt: Money;
  allocations: FundingAllocation[];
  digest: string;
  riskSnapshotDigest: string;
  status: 'DRAFT' | 'AWAITING_AUTHORIZATION' | 'AUTHORIZED' | 'STALE' | 'EXECUTING' | 'RECONCILED' | 'FAILED';
}

export interface Approval {
  id: string;
  planVersion: number;
  planDigest: string;
  riskSnapshotDigest: string;
  actor: string;
  authorizedAt: string;
  invalidatedAt?: string;
  invalidationReason?: string;
}

export interface ExecutionAttempt {
  id: string;
  planVersion: number;
  allocationId: string;
  sequence: number;
  providerRequestId: string;
  providerTransactionId?: string;
  providerRequestHash?: string;
  providerResponseHash?: string;
  state: 'UNSUBMITTED' | 'SUBMITTING' | 'PENDING' | 'COMPLETED' | 'FAILED' | 'REVERTED' | 'DECLINED' | 'AMBIGUOUS';
  createdAt: string;
  updatedAt: string;
}

export interface RiskSnapshot {
  version: number;
  createdAt: string;
  overall: 'LOW' | 'MEDIUM' | 'HIGH';
  dimensions: Record<RiskDimension, 'PASS' | 'REVIEW' | 'BLOCK'>;
  hardBlockCodes: string[];
  digest: string;
}

export interface BrokeredCase {
  id: string;
  // Monotonically advanced by the SQLite store on every durable mutation.
  // Optional only so records written before this concurrency guard remain
  // readable and normalize to revision 0 on their first write.
  revision?: number;
  caseStatus: CaseStatus;
  fundingStatus: FundingStatus;
  executionStatus: ExecutionStatus;
  createdAt: string;
  updatedAt: string;
  submissions: Submission[];
  artifacts: Artifact[];
  claims: CaseClaim[];
  riskFindings: RiskFinding[];
  brokerFindings: BrokerFinding[];
  amendments: CaseAmendment[];
  fundingExpectation?: IncomingFundingExpectation;
  providerObservations: ProviderObservation[];
  // Optional for compatibility with records written before funding attempts
  // were explicitly persisted; services initialize it before mutation.
  fundingAttempts?: FundingAttempt[];
  plans: FundingPlan[];
  approvals: Approval[];
  executionAttempts: ExecutionAttempt[];
  riskSnapshots: RiskSnapshot[];
  decision?: {
    outcome: 'APPROVE' | 'REJECT' | 'REQUEST_INFORMATION';
    reason: string;
    actor: string;
    decidedAt: string;
  };
}

export interface CaseEvent {
  caseId: string;
  sequence: number;
  previousHash: string;
  eventHash: string;
  eventType: string;
  actor: string;
  reason: string;
  evidenceRefs: string[];
  payload: Record<string, unknown>;
  createdAt: string;
}
