import { canonicalJson, sha256 } from './canonical.js';
import type { BrokeredCase, RiskDimension, RiskSnapshot } from './model.js';

const dimensions: RiskDimension[] = [
  'technical_integrity',
  'source_authentication',
  'investor_identity',
  'beneficiary_identity',
  'authority',
  'source_of_funds',
  'document_consistency',
  'incoming_settlement',
  'payout_structure',
  'execution_readiness'
];

export function evaluateRisk(record: BrokeredCase): RiskSnapshot {
  const dimensionResults = Object.fromEntries(dimensions.map(dimension => {
    const active = record.riskFindings.filter(finding =>
      finding.dimension === dimension && !finding.resolvedAt
    );
    const state = active.some(finding => finding.hardBlock)
      ? 'BLOCK'
      : active.length > 0
        ? 'REVIEW'
        : 'PASS';
    return [dimension, state];
  })) as RiskSnapshot['dimensions'];
  const hardBlockCodes = record.riskFindings
    .filter(finding => finding.hardBlock && !finding.resolvedAt)
    .map(finding => finding.code)
    .sort();
  const values = Object.values(dimensionResults);
  const overall: RiskSnapshot['overall'] = hardBlockCodes.length > 0
    ? 'HIGH'
    : values.some(value => value === 'REVIEW')
      ? 'MEDIUM'
      : 'LOW';
  const body = {
    version: record.riskSnapshots.length + 1,
    createdAt: new Date().toISOString(),
    overall,
    dimensions: dimensionResults,
    hardBlockCodes
  };
  return {
    ...body,
    digest: sha256(canonicalJson({ overall, dimensions: dimensionResults, hardBlockCodes }))
  };
}

export function appendRiskSnapshot(record: BrokeredCase) {
  const snapshot = evaluateRisk(record);
  const previous = record.riskSnapshots.at(-1);
  if (!previous || previous.digest !== snapshot.digest) record.riskSnapshots.push(snapshot);
  return record.riskSnapshots.at(-1)!;
}

export function invalidateAuthorization(record: BrokeredCase, reason: string) {
  const now = new Date().toISOString();
  let invalidated = false;
  for (const approval of record.approvals) {
    if (!approval.invalidatedAt) {
      approval.invalidatedAt = now;
      approval.invalidationReason = reason;
      invalidated = true;
    }
  }
  for (const plan of record.plans) {
    if (plan.status === 'AUTHORIZED') plan.status = 'STALE';
  }
  if (invalidated) record.executionStatus = record.plans.length > 0 ? 'AWAITING_AUTHORIZATION' : 'NOT_PLANNED';
  return invalidated;
}
