import { randomUUID, verify } from 'node:crypto';
import { canonicalJson, strictJsonParse } from './canonical.js';
import { canonicalCurrencyExponent } from './currency.js';
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

type PackageFormat = BrokeredCase['submissions'][number]['format'];

interface PackageAnalysis {
  format: PackageFormat;
  submissionIdentity?: string;
  findings: RiskFinding[];
  claims: CaseClaim[];
  fundingExpectation?: IncomingFundingExpectation;
}

class IntakeValidationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'IntakeValidationError';
  }
}

const findingDefinitions: Record<string, {
  dimension: RiskDimension;
  message: string;
  neededNext: string;
  hardBlock?: boolean;
  severity?: RiskFinding['severity'];
}> = {
  ARCHIVE_NOT_ZIP: {
    dimension: 'technical_integrity',
    message: 'The uploaded file is not a ZIP archive.',
    neededNext: 'Upload the original ZIP package without changing its extension or contents.'
  },
  ARCHIVE_STRUCTURE_INVALID: {
    dimension: 'technical_integrity',
    message: 'The ZIP archive structure could not be safely inspected.',
    neededNext: 'Obtain a new, intact ZIP package from the sender.'
  },
  ARCHIVE_LIMIT_EXCEEDED: {
    dimension: 'technical_integrity',
    message: 'The ZIP exceeds a configured safety limit for size or entry count.',
    neededNext: 'Request a safely sized package or agree an approved intake method before retrying.'
  },
  ARCHIVE_PATH_UNSAFE: {
    dimension: 'technical_integrity',
    message: 'The ZIP contains an unsafe path or link.',
    neededNext: 'Reject this archive and obtain a clean replacement from the sender.'
  },
  ARCHIVE_DUPLICATE_PATH: {
    dimension: 'technical_integrity',
    message: 'The ZIP contains duplicate normalized artifact paths.',
    neededNext: 'Request a package with one unambiguous copy of each artifact.'
  },
  ARCHIVE_COMPRESSION_RATIO_EXCEEDED: {
    dimension: 'technical_integrity',
    message: 'The ZIP contains content with an unsafe compression ratio.',
    neededNext: 'Reject this archive and obtain a clean replacement from the sender.'
  },
  MANIFEST_MISSING: {
    dimension: 'technical_integrity',
    message: 'The package has no recognizable manifest.',
    neededNext: 'Review the retained inventory, identify the package family, and request its field guide or a supported package.'
  },
  MANIFEST_PARSE_FAILED: {
    dimension: 'technical_integrity',
    message: 'The package manifest could not be read as valid JSON.',
    neededNext: 'Request a readable manifest or review this package through the diagnostic compatibility path.'
  },
  MANIFEST_INVENTORY_MISMATCH: {
    dimension: 'technical_integrity',
    message: 'The declared manifest inventory does not exactly match the ZIP contents.',
    neededNext: 'Provide a newly signed package whose manifest inventory matches every artifact.'
  },
  UNSUPPORTED_PACKAGE_PROFILE: {
    dimension: 'technical_integrity',
    message: 'The archive is safe to inspect but does not match a transaction-ready package profile.',
    neededNext: 'Review the artifact inventory and record the package family before requesting information or promoting a repeatable adapter.'
  },
  UNSUPPORTED_ARTIFACT_TYPE: {
    dimension: 'technical_integrity',
    message: 'The archive contains an artifact type that the diagnostic profile does not interpret.',
    neededNext: 'Review the retained inventory and request a supported representation if the artifact is material.'
  },
  ARTIFACT_PARSE_FAILED: {
    dimension: 'technical_integrity',
    message: 'A required known-package artifact could not be interpreted safely.',
    neededNext: 'Request a readable replacement or review the package family before creating an adapter.'
  },
  REQUIRED_TRANSACTION_FIELD_NOT_FOUND: {
    dimension: 'execution_readiness',
    message: 'A required transaction field is absent or invalid.',
    neededNext: 'Request the missing transaction information and confirm it with cited evidence.'
  },
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
  },
  SANDBOX_CASE_AMOUNT_LIMIT_EXCEEDED: {
    dimension: 'execution_readiness',
    message: 'The declared Sandbox case amount exceeds the configured limit for its currency.',
    neededNext: 'Record the full declared amount, then obtain an approved Sandbox limit change or document the provider limitation.'
  },
  SANDBOX_TOPUP_LIMIT_REACHED: {
    dimension: 'incoming_settlement',
    message: 'Revolut Sandbox did not accept the requested simulated funding amount.',
    neededNext: 'Retain the provider response, document the Sandbox top-up limit, and do not reduce the amount silently.'
  },
  SANDBOX_BALANCE_INSUFFICIENT: {
    dimension: 'execution_readiness',
    message: 'The selected Sandbox account does not have the full confirmed balance.',
    neededNext: 'Record the balance limitation and create or observe full-value Sandbox funding before another attempt.'
  },
  PROVIDER_HIGH_VALUE_REJECTED: {
    dimension: 'execution_readiness',
    message: 'The provider rejected the full confirmed Sandbox value.',
    neededNext: 'Retain the provider response as a pilot finding; any amended amount requires a new plan and authorization.'
  },
  PROVIDER_AMOUNT_LIMIT_UNKNOWN: {
    dimension: 'execution_readiness',
    message: 'The provider response did not make an amount limit clear.',
    neededNext: 'Reconcile the response and record the provider limitation before considering a separately documented amended test.'
  },
  PROVIDER_CURRENCY_LIMIT: {
    dimension: 'execution_readiness',
    message: 'The selected currency is not configured for this Sandbox case amount.',
    neededNext: 'Confirm the currency-specific Sandbox limit before preparing a new case plan.'
  },
  PROVIDER_PENDING_BEYOND_TEST_WINDOW: {
    dimension: 'execution_readiness',
    message: 'The provider has not reached a final state within the pilot test window.',
    neededNext: 'Reconcile the existing request; do not submit a replacement automatically.'
  },
  PROVIDER_RESPONSE_AMBIGUOUS: {
    dimension: 'execution_readiness',
    message: 'The provider response is ambiguous and the exact submission outcome is not known.',
    neededNext: 'Reconcile the existing provider request before any replacement or amendment.'
  },
  PROVIDER_TRANSACTION_REVERSED: {
    dimension: 'execution_readiness',
    message: 'The provider reports that a Sandbox transaction was reversed.',
    neededNext: 'Retain the reversal evidence, reconcile the case, and create a new plan only after review.'
  },
  PROVIDER_RECONCILIATION_MISMATCH: {
    dimension: 'execution_readiness',
    message: 'Provider reconciliation did not confirm the expected complete plan result.',
    neededNext: 'Review every provider attempt and resolve the mismatch before a replacement plan is considered.'
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
): PackageAnalysis {
  // Metadata and content signatures are only interpreted after the archive scanner
  // has produced a clean result.
  if (archive.scanner === 'UNAVAILABLE') {
    return { format: 'generic-compatibility/1.0', findings: [finding('MALWARE_SCANNER_UNAVAILABLE')], claims: [] };
  }
  if (archive.scanner === 'INFECTED') {
    return { format: 'generic-compatibility/1.0', findings: [finding('MALWARE_DETECTED')], claims: [] };
  }

  const profile = recognizeProfile(archive);
  if (profile === 'legacy-asset-declaration') return safelyAnalyzeLegacy(archive);
  if (profile === 'brokered-funding/1.0') return safelyAnalyzeV1(archive, trustedSourceKeys);
  return analyzeGenericCompatibility(archive);
}

function recognizeProfile(archive: InspectedArchive): PackageFormat {
  const manifest = archive.entries.find(entry => entry.normalizedPath === 'manifest.json');
  if (!manifest) return 'generic-compatibility/1.0';
  const manifestValue = parseJson(manifest);
  if (!manifestValue) return 'generic-compatibility/1.0';
  const manifestObject = object(manifestValue);
  if (manifestObject.package === 'ETH_ASSET_DECLARATION') return 'legacy-asset-declaration';
  if (manifestObject.format === 'brokered-funding/1.0') return 'brokered-funding/1.0';
  return 'generic-compatibility/1.0';
}

function safelyAnalyzeLegacy(archive: InspectedArchive): PackageAnalysis {
  try {
    return analyzeLegacy(archive);
  } catch (error) {
    return failedKnownProfile('legacy-asset-declaration', archive, intakeFailureCode(error));
  }
}

function safelyAnalyzeV1(
  archive: InspectedArchive,
  trustedSourceKeys: Record<string, string>
): PackageAnalysis {
  try {
    return analyzeV1(archive, trustedSourceKeys);
  } catch (error) {
    return failedKnownProfile('brokered-funding/1.0', archive, intakeFailureCode(error));
  }
}

function failedKnownProfile(format: PackageFormat, archive: InspectedArchive, code: string): PackageAnalysis {
  const manifest = archive.entries.find(entry => entry.normalizedPath === 'manifest.json');
  return {
    format,
    findings: [finding(code, [manifest?.sha256 ?? archive.packageSha256])],
    claims: []
  };
}

function analyzeGenericCompatibility(archive: InspectedArchive): PackageAnalysis {
  const manifest = archive.entries.find(entry => entry.normalizedPath === 'manifest.json');
  const unsupported = archive.entries.filter(entry => entry.mediaType === 'application/octet-stream');
  const findings: RiskFinding[] = [];
  if (!manifest) findings.push(finding('MANIFEST_MISSING', [archive.packageSha256]));
  else if (!parseJson(manifest)) findings.push(finding('MANIFEST_PARSE_FAILED', [manifest.sha256]));
  if (unsupported.length > 0) findings.push(finding('UNSUPPORTED_ARTIFACT_TYPE', unsupported.map(entry => entry.sha256)));
  findings.push(finding('UNSUPPORTED_PACKAGE_PROFILE', [manifest?.sha256 ?? archive.packageSha256]));
  return { format: 'generic-compatibility/1.0', findings, claims: [] };
}

function analyzeLegacy(archive: InspectedArchive): PackageAnalysis {
  const manifestEntry = mustEntry(archive, 'manifest.json');
  const contractEntry = mustEntry(archive, 'contract.json');
  const interfaceEntry = mustEntry(archive, 'interface.json');
  const manifest = object(json(manifestEntry, 'MANIFEST_PARSE_FAILED'));
  const contract = object(json(contractEntry, 'ARTIFACT_PARSE_FAILED'));
  const rpcInterface = object(json(interfaceEntry, 'ARTIFACT_PARSE_FAILED'));
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
    format: 'legacy-asset-declaration',
    findings: codes.map(code => finding(code, [manifestEntry.sha256])),
    claims
  };
}

function analyzeV1(archive: InspectedArchive, trustedSourceKeys: Record<string, string>): PackageAnalysis {
  const manifestEntry = mustEntry(archive, 'manifest.json');
  const manifestValue = json(manifestEntry, 'MANIFEST_PARSE_FAILED');
  const manifest = validateV1Manifest(manifestValue);
  const signatureEntry = archive.entries.find(entry => entry.normalizedPath === 'manifest.sig');
  const findings: RiskFinding[] = [];
  if (!signatureEntry) {
    findings.push(finding('SOURCE_SIGNATURE_MISSING', [manifestEntry.sha256]));
  } else {
    const signatureValue = parseSignature(signatureEntry);
    const trustedKey = signatureValue ? trustedSourceKeys[signatureValue.keyId] : undefined;
    let validSignature = false;
    if (signatureValue?.algorithm === 'Ed25519' && trustedKey) {
      try {
        validSignature = verify(
          null,
          Buffer.from(canonicalJson(manifestValue)),
          trustedKey,
          Buffer.from(signatureValue.signature, 'base64')
        );
      } catch {
        validSignature = false;
      }
    }
    if (!validSignature) findings.push(finding('SOURCE_SIGNATURE_INVALID', [manifestEntry.sha256, signatureEntry.sha256]));
  }
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
    format: 'brokered-funding/1.0',
    submissionIdentity: manifest.submission.id,
    findings,
    claims,
    fundingExpectation: manifest.expectedIncomingCredit
  };
}

function parseSignature(entry: InspectedEntry) {
  try {
    const signature = object(json(entry, 'ARTIFACT_PARSE_FAILED'));
    return {
      keyId: text(signature.keyId, 'signature keyId'),
      algorithm: text(signature.algorithm, 'signature algorithm'),
      signature: text(signature.signature, 'signature value')
    };
  } catch {
    return undefined;
  }
}

function validateV1Manifest(value: unknown): V1Manifest {
  const manifest = object(value) as unknown as V1Manifest;
  if (manifest.format !== 'brokered-funding/1.0') {
    throw new IntakeValidationError('UNSUPPORTED_PACKAGE_PROFILE', 'Unsupported package format.');
  }
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
    throw new IntakeValidationError('REQUIRED_TRANSACTION_FIELD_NOT_FOUND', 'Manifest payout allocations are required.');
  }
  text(manifest.purpose, 'purpose');
  if (!Array.isArray(manifest.artifacts)) {
    throw new IntakeValidationError('REQUIRED_TRANSACTION_FIELD_NOT_FOUND', 'Manifest artifact inventory is required.');
  }
  for (const artifact of manifest.artifacts) {
    text(artifact.path, 'artifact path');
    text(artifact.mediaType, 'artifact media type');
    if (!Number.isSafeInteger(artifact.byteLength) || artifact.byteLength < 0) {
      throw new IntakeValidationError('REQUIRED_TRANSACTION_FIELD_NOT_FOUND', 'Artifact byte length must be a non-negative integer.');
    }
    if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) {
      throw new IntakeValidationError('REQUIRED_TRANSACTION_FIELD_NOT_FOUND', 'Artifact SHA-256 is invalid.');
    }
  }
  return manifest;
}

function validateV1Inventory(manifest: V1Manifest, archive: InspectedArchive) {
  const expectedNames = new Set(['manifest.json', 'manifest.sig', ...manifest.artifacts.map(item => item.path)]);
  const actualNames = new Set(archive.entries.map(entry => entry.normalizedPath));
  if (expectedNames.size !== actualNames.size ||
      [...expectedNames].some(name => !actualNames.has(name))) {
    throw new IntakeValidationError('MANIFEST_INVENTORY_MISMATCH', 'Strict v1 artifact inventory does not exactly match the ZIP.');
  }
  for (const declared of manifest.artifacts) {
    const actual = archive.entries.find(entry => entry.normalizedPath === declared.path);
    if (!actual || actual.byteLength !== declared.byteLength || actual.sha256 !== declared.sha256 ||
        actual.mediaType !== declared.mediaType) {
      throw new IntakeValidationError('MANIFEST_INVENTORY_MISMATCH', 'Strict v1 artifact metadata does not match the manifest.');
    }
  }
}

function mustEntry(archive: InspectedArchive, path: string): InspectedEntry {
  const entry = archive.entries.find(candidate => candidate.normalizedPath === path);
  if (!entry) throw new IntakeValidationError(path === 'manifest.json' ? 'MANIFEST_MISSING' : 'REQUIRED_TRANSACTION_FIELD_NOT_FOUND', `Required package artifact ${path} is missing.`);
  return entry;
}

function parseJson(entry: InspectedEntry) {
  try {
    return strictJsonParse(entry.content.toString('utf8'));
  } catch {
    return undefined;
  }
}

function json(entry: InspectedEntry, code: string) {
  const value = parseJson(entry);
  if (value === undefined) throw new IntakeValidationError(code, `Artifact ${entry.normalizedPath} is not valid JSON.`);
  return value;
}

function intakeFailureCode(error: unknown) {
  if (error instanceof IntakeValidationError) return error.code;
  return 'ARTIFACT_PARSE_FAILED';
}

function object(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, description: string) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new IntakeValidationError('REQUIRED_TRANSACTION_FIELD_NOT_FOUND', `Manifest ${description} is required.`);
  }
  return value;
}

function timestamp(value: unknown, description: string) {
  const result = text(value, description);
  if (!Number.isFinite(Date.parse(result))) {
    throw new IntakeValidationError('REQUIRED_TRANSACTION_FIELD_NOT_FOUND', `Manifest ${description} is invalid.`);
  }
}

function money(value: unknown, description: string) {
  const record = object(value);
  if (!Number.isSafeInteger(record.amountMinor) || Number(record.amountMinor) < 1) {
    throw new IntakeValidationError('REQUIRED_TRANSACTION_FIELD_NOT_FOUND', `Manifest ${description} amountMinor must be a positive safe integer.`);
  }
  if (typeof record.currency !== 'string' || !/^[A-Z]{3}$/.test(record.currency)) {
    throw new IntakeValidationError('REQUIRED_TRANSACTION_FIELD_NOT_FOUND', `Manifest ${description} currency is invalid.`);
  }
  if (!Number.isInteger(record.exponent) || Number(record.exponent) < 0 || Number(record.exponent) > 6) {
    throw new IntakeValidationError('REQUIRED_TRANSACTION_FIELD_NOT_FOUND', `Manifest ${description} exponent is invalid.`);
  }
  const expectedExponent = canonicalCurrencyExponent(record.currency);
  if (expectedExponent === undefined || record.exponent !== expectedExponent) {
    throw new IntakeValidationError(
      'REQUIRED_TRANSACTION_FIELD_NOT_FOUND',
      `Manifest ${description} must use the canonical currency exponent.`
    );
  }
}
