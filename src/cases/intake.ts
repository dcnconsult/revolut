import { randomUUID, verify } from 'node:crypto';
import { canonicalJson, strictJsonParse } from './canonical.js';
import type {
  BrokeredCase,
  CaseClaim,
  IncomingFundingExpectation,
  RiskDimension,
  RiskFinding
} from './model.js';
import type { InspectedArchive, InspectedEntry } from './archive-reader.js';

interface ManifestArtifact {
  path: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
}

interface V1Manifest {
  format: string;
  envelope: { id: string; createdAt: string };
  source: { id: string; name: string };
  submission: { id: string; submittedAt: string };
  investor: { id: string; legalName: string; country: string };
  endBusiness: { id: string; legalName: string; country: string };
  authority: { type: string; reference: string };
  expectedIncomingCredit: IncomingFundingExpectation;
  payoutAllocations: unknown[];
  purpose: string;
  artifacts: ManifestArtifact[];
}

const findingDefinitions: Record<string, {
  dimension: RiskDimension;
  message: string;
  neededNext: string;
  hardBlock?: boolean;
  severity?: RiskFinding['severity'];
}> = {
  MANIFEST_DECLARED_FILES_MISSING: {
    dimension: 'technical_integrity',
    message: 'The manifest declares files that are absent from the package.',
    neededNext: 'Provide a new complete package whose inventory matches its contents.'
  },
  MANIFEST_UNDECLARED_FILE: {
    dimension: 'technical_integrity',
    message: 'The package contains a PDF that is not declared in the manifest.',
    neededNext: 'Provide a new signed manifest that declares every artifact.'
  },
  MANIFEST_ARTIFACT_MISMATCH: {
    dimension: 'technical_integrity',
    message: 'declaration.csv does not match the byte length and SHA-256 declared in the manifest.',
    neededNext: 'Provide a newly signed package with correct artifact hashes and byte lengths.'
  },
  SOURCE_SIGNATURE_MISSING: {
    dimension: 'source_authentication',
    message: 'No detached source signature or trusted signing-key identifier is present.',
    neededNext: 'Provide a brokered-funding/1.0 package signed by an enrolled source key.'
  },
  INVESTOR_IDENTITY_MISSING: {
    dimension: 'investor_identity',
    message: 'The package does not identify the investor.',
    neededNext: 'Provide verified investor identity evidence and a stable source reference.'
  },
  BENEFICIARY_MISSING: {
    dimension: 'beneficiary_identity',
    message: 'No customer beneficiary or end business is identified.',
    neededNext: 'Provide verified beneficiary identity evidence.'
  },
  PAYOUT_INSTRUCTIONS_MISSING: {
    dimension: 'payout_structure',
    message: 'No payout instructions or verified provider destination are supplied.',
    neededNext: 'Select verified Sandbox-owned accounts or existing counterparties separately.'
  },
  ALLOCATION_MISSING: {
    dimension: 'payout_structure',
    message: 'The package contains no allocation of receipt, payouts, fees, and reserve or refund.',
    neededNext: 'Provide an exact minor-unit allocation that balances to the expected receipt.'
  },
  AUTHORITY_MISSING: {
    dimension: 'authority',
    message: 'No evidence authorizes the broker to act or disburse funds.',
    neededNext: 'Provide signed authority evidence identifying the parties, scope, and limits.'
  },
  WALLET_ADDRESS_MISSING: {
    dimension: 'source_of_funds',
    message: 'No Ethereum wallet address is provided.',
    neededNext: 'Provide the source wallet address in cited evidence.'
  },
  TRANSACTION_HASH_MISSING: {
    dimension: 'source_of_funds',
    message: 'No on-chain transaction hash is provided.',
    neededNext: 'Provide independently verifiable transaction evidence.'
  },
  CUSTODY_EVIDENCE_MISSING: {
    dimension: 'source_of_funds',
    message: 'No custody evidence is provided.',
    neededNext: 'Provide custody records tied to the identified investor and wallet.'
  },
  ETH_CONTROL_PROOF_MISSING: {
    dimension: 'source_of_funds',
    message: 'No proof of control over the declared ETH is provided.',
    neededNext: 'Provide a signed wallet-control proof or independently verified custody evidence.'
  },
  RPC_BALANCE_MISMATCH: {
    dimension: 'document_consistency',
    message: 'The supplied RPC hexadecimal balance differs from the declared wei balance.',
    neededNext: 'Provide new source evidence whose base-unit values agree.'
  },
  MANUAL_VALUATION: {
    dimension: 'document_consistency',
    message: 'The EUR valuation is manually asserted and is not authoritative settlement evidence.',
    neededNext: 'Provide a cited, time-specific rate source if valuation remains relevant.',
    hardBlock: false,
    severity: 'WARNING'
  },
  UNSUPPORTED_KYC_AML_ASSERTION: {
    dimension: 'source_of_funds',
    message: 'KYC/AML CLEARED is asserted without a screening reference or supporting evidence.',
    neededNext: 'Provide independently reviewable screening evidence and scope.'
  },
  INCOMING_SETTLEMENT_UNOBSERVED: {
    dimension: 'incoming_settlement',
    message: 'The expected investor receipt has not been independently observed at the provider.',
    neededNext: 'Refresh provider observations and match the exact credit.'
  },
  MALWARE_SCANNER_UNAVAILABLE: {
    dimension: 'technical_integrity',
    message: 'The private malware scanner was unavailable; the package remains quarantined.',
    neededNext: 'Restore the private scanner and re-run validation.'
  },
  MALWARE_DETECTED: {
    dimension: 'technical_integrity',
    message: 'The private malware scanner detected unsafe content.',
    neededNext: 'Reject the package and obtain a clean replacement.'
  },
  SOURCE_SIGNATURE_INVALID: {
    dimension: 'source_authentication',
    message: 'The detached package signature is invalid or its key is not trusted.',
    neededNext: 'Obtain a new package signed by an enrolled source key.'
  }
};

export function finding(code: string, evidenceRefs: string[] = []): RiskFinding {
  const definition = findingDefinitions[code];
  if (!definition) throw new Error(`Unknown risk finding ${code}.`);
  return {
    id: randomUUID(),
    code,
    dimension: definition.dimension,
    severity: definition.severity ?? 'BLOCK',
    hardBlock: definition.hardBlock ?? true,
    message: definition.message,
    neededNext: definition.neededNext,
    evidenceRefs,
    createdAt: new Date().toISOString()
  };
}

export function analyzePackage(
  archive: InspectedArchive,
  trustedSourceKeys: Record<string, string>
): {
  format: BrokeredCase['submissions'][number]['format'];
  submissionIdentity?: string;
  findings: RiskFinding[];
  claims: CaseClaim[];
  fundingExpectation?: IncomingFundingExpectation;
} {
  if (archive.scanner === 'UNAVAILABLE') {
    return { format: detectLegacy(archive) ? 'legacy-asset-declaration' : 'brokered-funding/1.0', findings: [finding('MALWARE_SCANNER_UNAVAILABLE')], claims: [] };
  }
  if (archive.scanner === 'INFECTED') {
    return { format: detectLegacy(archive) ? 'legacy-asset-declaration' : 'brokered-funding/1.0', findings: [finding('MALWARE_DETECTED')], claims: [] };
  }
  return detectLegacy(archive)
    ? analyzeLegacy(archive)
    : analyzeV1(archive, trustedSourceKeys);
}

function detectLegacy(archive: InspectedArchive) {
  const manifest = archive.entries.find(entry => entry.normalizedPath === 'manifest.json');
  if (!manifest) return false;
  const value = strictJsonParse(manifest.content.toString('utf8'));
  return object(value).package === 'ETH_ASSET_DECLARATION';
}

function analyzeLegacy(archive: InspectedArchive) {
  const manifestEntry = mustEntry(archive, 'manifest.json');
  const contractEntry = mustEntry(archive, 'contract.json');
  const interfaceEntry = mustEntry(archive, 'interface.json');
  const manifest = object(strictJsonParse(manifestEntry.content.toString('utf8')));
  const contract = object(strictJsonParse(contractEntry.content.toString('utf8')));
  const rpcInterface = object(strictJsonParse(interfaceEntry.content.toString('utf8')));
  const declaredFiles = object(manifest.files);
  const actualNames = new Set(archive.entries.map(entry => entry.normalizedPath));
  const missing = Object.keys(declaredFiles).filter(name => !actualNames.has(name));
  const undeclared = archive.entries
    .map(entry => entry.normalizedPath)
    .filter(name => name !== 'manifest.json' && !(name in declaredFiles));
  const mismatched = Object.entries(declaredFiles).filter(([name, value]) => {
    const actual = archive.entries.find(entry => entry.normalizedPath === name);
    if (!actual) return false;
    const declared = object(value);
    return Number(declared.size_bytes) !== actual.byteLength || declared.sha256 !== actual.sha256;
  }).map(([name]) => name);
  const declaredWei = String(object(contract.balance).wei ?? '');
  const expectedHex = String(object(object(object(rpcInterface.verification_workflow).step_2_balance).expect_hex) ?? '');
  let hexMismatch = true;
  try {
    hexMismatch = BigInt(expectedHex) !== BigInt(declaredWei);
  } catch {
    hexMismatch = true;
  }
  const codes = [
    ...(missing.length > 0 ? ['MANIFEST_DECLARED_FILES_MISSING'] : []),
    ...(undeclared.length > 0 ? ['MANIFEST_UNDECLARED_FILE'] : []),
    ...(mismatched.length > 0 ? ['MANIFEST_ARTIFACT_MISMATCH'] : []),
    'SOURCE_SIGNATURE_MISSING',
    'INVESTOR_IDENTITY_MISSING',
    'BENEFICIARY_MISSING',
    'PAYOUT_INSTRUCTIONS_MISSING',
    'ALLOCATION_MISSING',
    'AUTHORITY_MISSING',
    'WALLET_ADDRESS_MISSING',
    'TRANSACTION_HASH_MISSING',
    'CUSTODY_EVIDENCE_MISSING',
    'ETH_CONTROL_PROOF_MISSING',
    ...(hexMismatch ? ['RPC_BALANCE_MISMATCH'] : []),
    'MANUAL_VALUATION',
    'UNSUPPORTED_KYC_AML_ASSERTION',
    'INCOMING_SETTLEMENT_UNOBSERVED'
  ];
  const now = new Date().toISOString();
  const claims: CaseClaim[] = [
    ['asset.ticker', object(contract.asset).ticker],
    ['asset.network', object(contract.asset).network],
    ['balance.wei', declaredWei],
    ['balance.amount', object(contract.balance).amount],
    ['compliance.kyc_aml_status', object(contract.compliance).kyc_aml_status]
  ].map(([path, value], index) => ({
    id: randomUUID(),
    version: index + 1,
    path: String(path),
    value,
    source: 'SUBMISSION',
    evidenceRefs: [contractEntry.sha256],
    recordedAt: now
  }));
  return {
    format: 'legacy-asset-declaration' as const,
    findings: codes.map(code => finding(code, [manifestEntry.sha256])),
    claims
  };
}

function analyzeV1(archive: InspectedArchive, trustedSourceKeys: Record<string, string>) {
  const manifestEntry = mustEntry(archive, 'manifest.json');
  const signatureEntry = mustEntry(archive, 'manifest.sig');
  const manifestValue = strictJsonParse(manifestEntry.content.toString('utf8'));
  const manifest = validateV1Manifest(manifestValue);
  const signature = object(strictJsonParse(signatureEntry.content.toString('utf8')));
  const keyId = text(signature.keyId, 'signature keyId');
  const algorithm = text(signature.algorithm, 'signature algorithm');
  const signatureValue = text(signature.signature, 'signature value');
  const trustedKey = trustedSourceKeys[keyId];
  let validSignature = false;
  if (algorithm === 'Ed25519' && trustedKey) {
    try {
      validSignature = verify(
        null,
        Buffer.from(canonicalJson(manifestValue)),
        trustedKey,
        Buffer.from(signatureValue, 'base64')
      );
    } catch {
      validSignature = false;
    }
  }
  const findings: RiskFinding[] = [];
  if (!validSignature) findings.push(finding('SOURCE_SIGNATURE_INVALID', [manifestEntry.sha256]));
  validateV1Inventory(manifest, archive);
  const now = new Date().toISOString();
  const claimValues: Array<[string, unknown]> = [
    ['investor', manifest.investor],
    ['endBusiness', manifest.endBusiness],
    ['authority', manifest.authority],
    ['expectedIncomingCredit', manifest.expectedIncomingCredit],
    ['payoutAllocations', manifest.payoutAllocations],
    ['purpose', manifest.purpose]
  ];
  const claims = claimValues.map(([path, value], index) => ({
    id: randomUUID(),
    version: index + 1,
    path,
    value,
    source: 'SUBMISSION' as const,
    evidenceRefs: [manifestEntry.sha256],
    recordedAt: now
  }));
  findings.push(finding('INCOMING_SETTLEMENT_UNOBSERVED', [manifestEntry.sha256]));
  return {
    format: 'brokered-funding/1.0' as const,
    submissionIdentity: manifest.submission.id,
    findings,
    claims,
    fundingExpectation: manifest.expectedIncomingCredit
  };
}

function validateV1Manifest(value: unknown): V1Manifest {
  const manifest = object(value) as unknown as V1Manifest;
  if (manifest.format !== 'brokered-funding/1.0') throw new Error('Unsupported package format.');
  text(manifest.envelope?.id, 'envelope id');
  timestamp(manifest.envelope?.createdAt, 'envelope timestamp');
  text(manifest.source?.id, 'source id');
  text(manifest.source?.name, 'source name');
  text(manifest.submission?.id, 'submission id');
  timestamp(manifest.submission?.submittedAt, 'submission timestamp');
  text(manifest.investor?.id, 'investor id');
  text(manifest.investor?.legalName, 'investor legal name');
  text(manifest.investor?.country, 'investor country');
  text(manifest.endBusiness?.id, 'end-business id');
  text(manifest.endBusiness?.legalName, 'end-business legal name');
  text(manifest.endBusiness?.country, 'end-business country');
  text(manifest.authority?.type, 'authority type');
  text(manifest.authority?.reference, 'authority reference');
  money(manifest.expectedIncomingCredit, 'expected incoming credit');
  text(manifest.expectedIncomingCredit?.reference, 'incoming reference');
  text(manifest.expectedIncomingCredit?.destinationAccountId, 'incoming destination account');
  text(manifest.expectedIncomingCredit?.investorName, 'incoming investor name');
  if (!Array.isArray(manifest.payoutAllocations) || manifest.payoutAllocations.length === 0) {
    throw new Error('Manifest payout allocations are required.');
  }
  text(manifest.purpose, 'purpose');
  if (!Array.isArray(manifest.artifacts)) throw new Error('Manifest artifact inventory is required.');
  for (const artifact of manifest.artifacts) {
    text(artifact.path, 'artifact path');
    text(artifact.mediaType, 'artifact media type');
    if (!Number.isSafeInteger(artifact.byteLength) || artifact.byteLength < 0) {
      throw new Error('Artifact byte length must be a non-negative integer.');
    }
    if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error('Artifact SHA-256 is invalid.');
  }
  return manifest;
}

function validateV1Inventory(manifest: V1Manifest, archive: InspectedArchive) {
  const expectedNames = new Set(['manifest.json', 'manifest.sig', ...manifest.artifacts.map(item => item.path)]);
  const actualNames = new Set(archive.entries.map(entry => entry.normalizedPath));
  if (expectedNames.size !== actualNames.size ||
      [...expectedNames].some(name => !actualNames.has(name))) {
    throw new Error('Strict v1 artifact inventory does not exactly match the ZIP.');
  }
  for (const declared of manifest.artifacts) {
    const actual = mustEntry(archive, declared.path);
    if (actual.byteLength !== declared.byteLength || actual.sha256 !== declared.sha256 ||
        actual.mediaType !== declared.mediaType) {
      throw new Error(`Strict v1 artifact metadata mismatch for ${declared.path}.`);
    }
  }
}

function mustEntry(archive: InspectedArchive, path: string): InspectedEntry {
  const entry = archive.entries.find(candidate => candidate.normalizedPath === path);
  if (!entry) throw new Error(`Required package artifact ${path} is missing.`);
  return entry;
}

function object(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, description: string) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Manifest ${description} is required.`);
  }
  return value;
}

function timestamp(value: unknown, description: string) {
  const result = text(value, description);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`Manifest ${description} is invalid.`);
}

function money(value: unknown, description: string) {
  const record = object(value);
  if (!Number.isSafeInteger(record.amountMinor) || Number(record.amountMinor) < 1) {
    throw new Error(`Manifest ${description} amountMinor must be a positive safe integer.`);
  }
  if (typeof record.currency !== 'string' || !/^[A-Z]{3}$/.test(record.currency)) {
    throw new Error(`Manifest ${description} currency is invalid.`);
  }
  if (!Number.isInteger(record.exponent) || Number(record.exponent) < 0 || Number(record.exponent) > 6) {
    throw new Error(`Manifest ${description} exponent is invalid.`);
  }
}
