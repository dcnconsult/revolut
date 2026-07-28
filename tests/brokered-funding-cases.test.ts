import { generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import yazl from 'yazl';
import type { SandboxInternalTransferClient } from '../src/adapters/revolut-sandbox-client.js';
import { canonicalJson, sha256, strictJsonParse } from '../src/cases/canonical.js';
import { BrokeredFundingCaseService } from '../src/cases/case-service.js';
import { SQLiteCaseStore } from '../src/cases/case-store.js';
import { EncryptedEvidenceStore } from '../src/cases/evidence-store.js';
import { CleanTestScanner, type MalwareScanner } from '../src/cases/malware-scanner.js';
import { legacyAssetDeclarationPackage } from './fixtures/legacy-package.js';

const limits = {
  maximumZipBytes: 25 * 1024 * 1024,
  maximumEntries: 100,
  maximumEntryBytes: 10 * 1024 * 1024,
  maximumTotalBytes: 100 * 1024 * 1024,
  maximumCompressionRatio: 20
};

describe('brokered funding case workflow', () => {
  it('opens TXN_001.zip on exact intake hold without provider mutations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'case-legacy-'));
    const store = new SQLiteCaseStore(':memory:');
    const provider = mockProvider();
    const service = new BrokeredFundingCaseService(
      store,
      new EncryptedEvidenceStore(directory, randomBytes(32)),
      new CleanTestScanner(),
      provider,
      limits,
      {}
    );
    try {
      const zip = await legacyAssetDeclarationPackage();
      const submitted = service.submit(zip, 'TXN_001');
      const record = await service.waitForProcessing(submitted.case.id);
      expect(record.caseStatus).toBe('INTAKE_HOLD');
      expect(record.fundingStatus).toBe('AWAITING_FUNDS');
      expect(record.executionStatus).toBe('NOT_PLANNED');
      expect(record.submissions[0]?.format).toBe('legacy-asset-declaration');
      expect(record.riskFindings.map(item => item.code)).toEqual([
        'MANIFEST_DECLARED_FILES_MISSING',
        'MANIFEST_UNDECLARED_FILE',
        'MANIFEST_ARTIFACT_MISMATCH',
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
        'RPC_BALANCE_MISMATCH',
        'MANUAL_VALUATION',
        'UNSUPPORTED_KYC_AML_ASSERTION',
        'INCOMING_SETTLEMENT_UNOBSERVED'
      ]);
      await expect(service.refreshFunding(record.id, 'admin')).rejects.toThrow('Provider access is blocked');
      expect(provider.getAccounts).not.toHaveBeenCalled();
      expect(provider.listTransactions).not.toHaveBeenCalled();
      expect(provider.createInternalTransfer).not.toHaveBeenCalled();
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('matches a signed synthetic Sandbox receipt, balances a plan, executes sequentially, and signs evidence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'case-clean-'));
    const store = new SQLiteCaseStore(':memory:');
    const provider = mockProvider();
    const sourceKeys = generateKeyPairSync('ed25519');
    const packageContent = await signedPackage(sourceKeys.privateKey, sourceKeys.publicKey);
    const service = new BrokeredFundingCaseService(
      store,
      new EncryptedEvidenceStore(directory, randomBytes(32)),
      new CleanTestScanner(),
      provider,
      limits,
      {
        'synthetic-source-1': sourceKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
      }
    );
    try {
      const submitted = service.submit(packageContent, 'clean-submission-1');
      let record = await service.waitForProcessing(submitted.case.id);
      expect(record.riskSnapshots.at(-1)).toMatchObject({
        overall: 'HIGH',
        hardBlockCodes: ['INCOMING_SETTLEMENT_UNOBSERVED']
      });

      record = await service.refreshFunding(record.id, 'admin', true);
      expect(record.fundingStatus).toBe('MATCHED');
      expect(record.providerObservations[0]?.source).toBe('SANDBOX_SIMULATION');
      expect(record.riskSnapshots.at(-1)?.overall).toBe('LOW');
      record = service.decide(record.id, { outcome: 'APPROVE', reason: 'All deterministic checks passed.' }, 'admin');
      const receipt = record.providerObservations[0]!;
      const plan = service.createPlan(record.id, {
        receiptObservationId: receipt.id,
        allocations: [
          allocation('CUSTOMER_PAYOUT', 500, 'OWNED_ACCOUNT_TRANSFER', {
            targetAccountId: '22222222-2222-4222-8222-222222222222'
          }),
          allocation('CUSTOMER_PAYOUT', 400, 'COUNTERPARTY_PAYMENT', {
            counterpartyId: 'counterparty-1',
            paymentMethodId: 'payment-method-1'
          }),
          allocation('BROKER_FEE', 50, 'OWNED_ACCOUNT_TRANSFER', {
            targetAccountId: '22222222-2222-4222-8222-222222222222'
          }),
          allocation('PROVIDER_FEE', 25, 'COUNTERPARTY_PAYMENT', {
            counterpartyId: 'counterparty-1',
            paymentMethodId: 'payment-method-1'
          }),
          allocation('RESERVE', 25, 'RETAIN', {})
        ]
      }, 'admin');
      expect(plan.allocations.reduce((total, item) => total + item.amountMinor, 0)).toBe(1_000);
      record = service.authorizePlan(record.id, plan.version, 'admin');
      record = await service.executePlan(record.id, plan.version, 'admin');
      expect(record.executionStatus).toBe('RECONCILING');
      expect(provider.createInternalTransfer).toHaveBeenCalledTimes(2);
      expect(provider.createCounterpartyPayment).toHaveBeenCalledTimes(2);
      const requestIds = [
        ...vi.mocked(provider.createInternalTransfer).mock.calls.map(call => call[0].requestId),
        ...vi.mocked(provider.createCounterpartyPayment!).mock.calls.map(call => call[0].requestId)
      ];
      expect(new Set(requestIds).size).toBe(4);

      record = await service.reconcile(record.id, 'admin');
      expect(record).toMatchObject({
        caseStatus: 'CLOSED',
        executionStatus: 'RECONCILED'
      });
      const bundle = JSON.parse(service.evidenceBundle(record.id).toString('utf8')) as {
        body: { auditChainVerified: boolean; originalPackages: Array<{ sha256: string }> };
        signature: { value: string; publicKey: string };
      };
      expect(bundle.body.auditChainVerified).toBe(true);
      expect(bundle.body.originalPackages[0]?.sha256).toBe(sha256(packageContent));
      expect(verify(
        null,
        Buffer.from(canonicalJson(bundle.body)),
        bundle.signature.publicKey,
        Buffer.from(bundle.signature.value, 'base64')
      )).toBe(true);
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('turns an unusable upload into an explicit Sandbox-only walkthrough and completes it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'case-walkthrough-'));
    const store = new SQLiteCaseStore(':memory:');
    const provider = mockProvider();
    let simulated: {
      accountId: string;
      amount: number;
      currency: string;
      reference: string;
    } | undefined;
    provider.simulateTopUp = vi.fn(async input => {
      simulated = input;
      return {
        id: '33333333-3333-4333-8333-333333333333',
        state: 'completed'
      };
    });
    provider.listTransactions = vi.fn(async () => simulated ? [{
      id: '33333333-3333-4333-8333-333333333333',
      state: 'completed',
      type: 'topup',
      reference: simulated.reference,
      legs: [{
        account_id: simulated.accountId,
        amount: simulated.amount.toFixed(2),
        currency: simulated.currency
      }]
    }] : []);
    const service = new BrokeredFundingCaseService(
      store,
      new EncryptedEvidenceStore(directory, randomBytes(32)),
      new CleanTestScanner(),
      provider,
      limits,
      {}
    );
    try {
      const submitted = service.submit(Buffer.from('this is not a ZIP archive'), 'walkthrough-invalid-upload');
      let record = await service.waitForProcessing(submitted.case.id);
      expect(record.caseStatus).toBe('INTAKE_HOLD');
      expect(record.riskFindings.at(-1)?.code).toBe('PACKAGE_VALIDATION_FAILED');

      record = await service.prepareSandboxWalkthrough(record.id, {
        sourceAccountId: '11111111-1111-4111-8111-111111111111',
        amountMinor: 500,
        currency: 'USD'
      }, 'admin');
      expect(record.caseStatus).toBe('AWAITING_BROKER');
      expect(record.fundingExpectation).toMatchObject({
        amountMinor: 500,
        currency: 'USD',
        destinationAccountId: '11111111-1111-4111-8111-111111111111'
      });
      expect(record.riskFindings.filter(item => item.hardBlock && !item.resolvedAt).map(item => item.code))
        .toEqual(['INCOMING_SETTLEMENT_UNOBSERVED']);

      record = await service.refreshFunding(record.id, 'admin', true);
      expect(record.fundingStatus).toBe('MATCHED');
      record = service.decide(record.id, {
        outcome: 'APPROVE',
        reason: 'Explicit Sandbox walkthrough approved.'
      }, 'admin');
      const receipt = record.providerObservations[0]!;
      const plan = service.createPlan(record.id, {
        receiptObservationId: receipt.id,
        allocations: [allocation('CUSTOMER_PAYOUT', 500, 'OWNED_ACCOUNT_TRANSFER', {
          targetAccountId: '22222222-2222-4222-8222-222222222222'
        })]
      }, 'admin');
      service.authorizePlan(record.id, plan.version, 'admin');
      record = await service.executePlan(record.id, plan.version, 'admin');
      expect(record.executionStatus).toBe('RECONCILING');
      record = await service.reconcile(record.id, 'admin');
      expect(record).toMatchObject({
        caseStatus: 'CLOSED',
        executionStatus: 'RECONCILED'
      });
      expect(service.list().find(item => item.id === record.id)?.nextAction)
        .toBe('Export and retain the signed evidence bundle.');
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects duplicate JSON properties and leaves scanner outages quarantined', async () => {
    expect(() => strictJsonParse('{"amount":1,"amount":2}')).toThrow('Duplicate JSON property');
    const directory = await mkdtemp(join(tmpdir(), 'case-scanner-'));
    const store = new SQLiteCaseStore(':memory:');
    const unavailable: MalwareScanner = {
      scan: vi.fn(async () => ({ status: 'UNAVAILABLE' as const }))
    };
    const service = new BrokeredFundingCaseService(
      store,
      new EncryptedEvidenceStore(directory, randomBytes(32)),
      unavailable,
      mockProvider(),
      limits,
      {}
    );
    try {
      const zip = await legacyAssetDeclarationPackage();
      const submitted = service.submit(zip, 'scanner-outage');
      const record = await service.waitForProcessing(submitted.case.id);
      expect(record.caseStatus).toBe('QUARANTINED');
      expect(record.riskFindings.map(item => item.code)).toEqual(['MALWARE_SCANNER_UNAVAILABLE']);
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function mockProvider(): SandboxInternalTransferClient {
  return {
    getAccounts: vi.fn(async () => [
      {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'USD source',
        currency: 'USD',
        balance: 100,
        state: 'active'
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        name: 'USD owned target',
        currency: 'USD',
        balance: 0,
        state: 'active'
      }
    ]),
    simulateTopUp: vi.fn(async () => ({
      id: '33333333-3333-4333-8333-333333333333',
      state: 'completed'
    })),
    listTransactions: vi.fn(async () => [{
      id: '33333333-3333-4333-8333-333333333333',
      state: 'completed',
      type: 'topup',
      reference: 'SYNTHETIC INVESTOR CREDIT',
      legs: [{
        account_id: '11111111-1111-4111-8111-111111111111',
        amount: '10.00',
        currency: 'USD'
      }]
    }]),
    createInternalTransfer: vi.fn(async input => ({
      id: input.requestId,
      state: 'completed'
    })),
    getCounterparties: vi.fn(async () => [{
      id: 'counterparty-1',
      name: 'Verified synthetic counterparty',
      state: 'active',
      accounts: [{ id: 'payment-method-1', currency: 'USD' }]
    }]),
    createCounterpartyPayment: vi.fn(async input => ({
      id: input.requestId,
      state: 'completed'
    })),
    getTransaction: vi.fn(async transactionId => ({
      id: transactionId,
      state: 'completed'
    }))
  };
}

function allocation(
  kind: 'CUSTOMER_PAYOUT' | 'BROKER_FEE' | 'PROVIDER_FEE' | 'RESERVE',
  amountMinor: number,
  method: 'OWNED_ACCOUNT_TRANSFER' | 'COUNTERPARTY_PAYMENT' | 'RETAIN',
  destination: {
    targetAccountId?: string;
    counterpartyId?: string;
    paymentMethodId?: string;
  }
) {
  return {
    kind,
    amountMinor,
    currency: 'USD',
    exponent: 2,
    beneficiaryName: kind === 'RESERVE' ? 'Explicit reserve' : 'Synthetic beneficiary',
    reference: `SYNTHETIC ${kind}`,
    method,
    sourceAccountId: '11111111-1111-4111-8111-111111111111',
    ...destination
  };
}

async function signedPackage(
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
  _publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']
) {
  const artifactContent = Buffer.from(JSON.stringify({
    authority: 'Synthetic test authority only',
    screening: 'Synthetic test screening only'
  }));
  const manifest = {
    format: 'brokered-funding/1.0',
    envelope: { id: 'env-1', createdAt: '2026-07-25T12:00:00Z' },
    source: { id: 'source-1', name: 'Synthetic source' },
    submission: { id: 'clean-submission-1', submittedAt: '2026-07-25T12:00:01Z' },
    investor: { id: 'investor-1', legalName: 'Synthetic Investor Ltd', country: 'GB' },
    endBusiness: { id: 'business-1', legalName: 'Synthetic Customer Ltd', country: 'DE' },
    authority: { type: 'LIMITED_MANDATE', reference: 'authority.json' },
    expectedIncomingCredit: {
      amountMinor: 1_000,
      currency: 'USD',
      exponent: 2,
      reference: 'SYNTHETIC INVESTOR CREDIT',
      destinationAccountId: '11111111-1111-4111-8111-111111111111',
      investorName: 'Synthetic Investor Ltd'
    },
    payoutAllocations: [{ purpose: 'Synthetic acceptance test; exact plan is broker-authored.' }],
    purpose: 'Low-value synthetic Sandbox acceptance test',
    artifacts: [{
      path: 'authority.json',
      mediaType: 'application/json',
      byteLength: artifactContent.length,
      sha256: sha256(artifactContent)
    }]
  };
  const signature = {
    keyId: 'synthetic-source-1',
    algorithm: 'Ed25519',
    signature: sign(null, Buffer.from(canonicalJson(manifest)), privateKey).toString('base64')
  };
  return zipBuffer([
    ['manifest.json', Buffer.from(JSON.stringify(manifest))],
    ['manifest.sig', Buffer.from(JSON.stringify(signature))],
    ['authority.json', artifactContent]
  ]);
}

function zipBuffer(entries: Array<[string, Buffer]>) {
  return new Promise<Buffer>((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.once('error', reject);
    zip.outputStream.once('end', () => resolve(Buffer.concat(chunks)));
    for (const [name, content] of entries) zip.addBuffer(content, name);
    zip.end();
  });
}
