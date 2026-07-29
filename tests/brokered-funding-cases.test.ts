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
import { OperationalFault } from '../src/operations/operational-error-monitor.js';
import { legacyAssetDeclarationPackage } from './fixtures/legacy-package.js';

const limits = {
  maximumZipBytes: 25 * 1024 * 1024,
  maximumEntries: 100,
  maximumEntryBytes: 10 * 1024 * 1024,
  maximumTotalBytes: 100 * 1024 * 1024,
  maximumCompressionRatio: 20
};

const sandboxCaseMaximums = {
  USD: 100_000_000_000,
  JPY: 1_000_000_000,
  BHD: 1_000_000_000_000
};

const highValueBoundaries = [
  ['USD 10 million', 'USD', 2, 1_000_000_000],
  ['USD 100 million', 'USD', 2, 10_000_000_000],
  ['USD 500 million', 'USD', 2, 50_000_000_000],
  ['USD 1 billion', 'USD', 2, 100_000_000_000],
  ['JPY zero-decimal boundary', 'JPY', 0, 1_000_000_000],
  ['BHD three-decimal boundary', 'BHD', 3, 1_000_000_000_000]
] as const;

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

  it('does not close an unplanned case through reconciliation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'case-reconcile-unplanned-'));
    const store = new SQLiteCaseStore(':memory:');
    const service = new BrokeredFundingCaseService(
      store,
      new EncryptedEvidenceStore(directory, randomBytes(32)),
      new CleanTestScanner(),
      mockProvider(),
      limits,
      {}
    );
    try {
      const submitted = service.submit(
        await zipBuffer([['diagnostic.txt', Buffer.from('Unplanned reconciliation guard')]]),
        'reconcile-unplanned'
      );
      const record = await service.waitForProcessing(submitted.case.id);
      await expect(service.reconcile(record.id, 'admin'))
        .rejects.toThrow('Only an executing Sandbox funding plan can be reconciled');
      expect(store.get(record.id)).toMatchObject({
        caseStatus: record.caseStatus,
        executionStatus: 'NOT_PLANNED'
      });
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

  it('keeps an unsafe upload out of the Sandbox diagnostic walkthrough', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'case-walkthrough-'));
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
      const submitted = service.submit(Buffer.from('this is not a ZIP archive'), 'walkthrough-invalid-upload');
      const record = await service.waitForProcessing(submitted.case.id);
      expect(record.caseStatus).toBe('QUARANTINED');
      expect(record.riskFindings.at(-1)?.code).toBe('ARCHIVE_NOT_ZIP');
      await expect(service.prepareSandboxWalkthrough(record.id, {
        sourceAccountId: '11111111-1111-4111-8111-111111111111',
        amountMinor: 500,
        currency: 'USD'
      }, 'admin')).rejects.toThrow('Only a clean, fully inspected ZIP package');
      expect(provider.simulateTopUp).not.toHaveBeenCalled();
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(highValueBoundaries)(
    'keeps the full configured %s amount in minor units for a clean generic diagnostic case',
    async (_label, currency, exponent, amountMinor) => {
      const directory = await mkdtemp(join(tmpdir(), 'case-high-boundary-'));
      const store = new SQLiteCaseStore(':memory:');
      const provider = multiCurrencyProvider();
      const service = new BrokeredFundingCaseService(
        store,
        new EncryptedEvidenceStore(directory, randomBytes(32)),
        new CleanTestScanner(),
        provider,
        limits,
        {},
        undefined,
        sandboxCaseMaximums
      );
      try {
        const submitted = service.submit(
          await zipBuffer([['cover-letter.txt', Buffer.from('Synthetic diagnostic package')]]),
          `generic-${currency}-${exponent}-${amountMinor}`
        );
        let record = await service.waitForProcessing(submitted.case.id);
        expect(record).toMatchObject({
          caseStatus: 'INTAKE_HOLD',
          submissions: [{ format: 'generic-compatibility/1.0', state: 'VALIDATED', scanner: 'CLEAN' }]
        });
        expect(record.artifacts).toEqual(expect.arrayContaining([
          expect.objectContaining({ normalizedPath: 'cover-letter.txt', scanStatus: 'CLEAN' })
        ]));
        expect(record.riskFindings.map(item => item.code)).toEqual(expect.arrayContaining([
          'MANIFEST_MISSING',
          'UNSUPPORTED_PACKAGE_PROFILE'
        ]));

        record = await service.prepareSandboxWalkthrough(record.id, {
          sourceAccountId: `source-${currency}`,
          amountMinor,
          currency,
          exponent
        }, 'admin');
        expect(record.fundingExpectation).toMatchObject({ amountMinor, currency, exponent });
        expect(record.fundingExpectation?.amountMinor).toBe(amountMinor);
        expect(record.riskFindings.filter(item => item.hardBlock && !item.resolvedAt)
          .map(item => item.code)).toEqual(['INCOMING_SETTLEMENT_UNOBSERVED']);
      } finally {
        store.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it('runs a synthetic USD 1 billion case through funding, authorization, execution, reconciliation, and evidence export', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'case-high-value-flow-'));
    const store = new SQLiteCaseStore(':memory:');
    const provider = highValueProvider();
    const sourceKeys = generateKeyPairSync('ed25519');
    const service = new BrokeredFundingCaseService(
      store,
      new EncryptedEvidenceStore(directory, randomBytes(32)),
      new CleanTestScanner(),
      provider,
      limits,
      { 'synthetic-source-1': sourceKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
      undefined,
      sandboxCaseMaximums
    );
    try {
      const packageContent = await signedPackage(sourceKeys.privateKey, sourceKeys.publicKey, {
        amountMinor: 100_000_000_000,
        currency: 'USD',
        exponent: 2,
        reference: 'SYNTHETIC HIGH VALUE CREDIT',
        destinationAccountId: '11111111-1111-4111-8111-111111111111',
        investorName: 'Synthetic High Value Investor'
      });
      const submitted = service.submit(packageContent, 'high-value-usd-1b');
      let record = await service.waitForProcessing(submitted.case.id);
      record = await service.refreshFunding(record.id, 'admin', true);
      expect(provider.simulateTopUp).toHaveBeenCalledWith(expect.objectContaining({ amount: 1_000_000_000 }));
      expect(record.fundingStatus).toBe('MATCHED');
      record = service.decide(record.id, { outcome: 'APPROVE', reason: 'Synthetic high-value Sandbox case.' }, 'admin');
      const receipt = record.providerObservations[0]!;
      const plan = service.createPlan(record.id, {
        receiptObservationId: receipt.id,
        allocations: [allocation('CUSTOMER_PAYOUT', 100_000_000_000, 'OWNED_ACCOUNT_TRANSFER', {
          targetAccountId: '22222222-2222-4222-8222-222222222222'
        })]
      }, 'admin');
      expect(plan.receipt.amountMinor).toBe(100_000_000_000);
      service.authorizePlan(record.id, plan.version, 'admin');
      record = await service.executePlan(record.id, plan.version, 'admin');
      expect(provider.createInternalTransfer).toHaveBeenCalledWith(expect.objectContaining({ amount: 1_000_000_000 }));
      expect(record.executionStatus).toBe('RECONCILING');
      record = await service.reconcile(record.id, 'admin');
      expect(record).toMatchObject({ caseStatus: 'CLOSED', executionStatus: 'RECONCILED' });
      const bundle = JSON.parse(service.evidenceBundle(record.id).toString('utf8')) as {
        body: { auditChainVerified: boolean; auditChain: Array<{ eventType: string; evidenceRefs: string[] }> };
      };
      expect(bundle.body.auditChainVerified).toBe(true);
      expect(bundle.body.auditChain.find(event => event.eventType === 'PAYOUT_PROVIDER_RESULT')?.evidenceRefs)
        .toHaveLength(1);
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('records a full-value provider rejection as a finding without a second submission', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'case-high-value-rejected-'));
    const store = new SQLiteCaseStore(':memory:');
    const provider = highValueProvider('declined');
    const sourceKeys = generateKeyPairSync('ed25519');
    const service = new BrokeredFundingCaseService(
      store,
      new EncryptedEvidenceStore(directory, randomBytes(32)),
      new CleanTestScanner(),
      provider,
      limits,
      { 'synthetic-source-1': sourceKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
      undefined,
      sandboxCaseMaximums
    );
    try {
      const packageContent = await signedPackage(sourceKeys.privateKey, sourceKeys.publicKey, {
        amountMinor: 100_000_000_000,
        currency: 'USD',
        exponent: 2,
        reference: 'SYNTHETIC REJECTED HIGH VALUE CREDIT',
        destinationAccountId: '11111111-1111-4111-8111-111111111111',
        investorName: 'Synthetic High Value Investor'
      });
      const submitted = service.submit(packageContent, 'high-value-rejection');
      let record = await service.waitForProcessing(submitted.case.id);
      record = await service.refreshFunding(record.id, 'admin', true);
      record = service.decide(record.id, { outcome: 'APPROVE', reason: 'Synthetic provider-rejection test.' }, 'admin');
      const plan = service.createPlan(record.id, {
        receiptObservationId: record.providerObservations[0]!.id,
        allocations: [allocation('CUSTOMER_PAYOUT', 100_000_000_000, 'OWNED_ACCOUNT_TRANSFER', {
          targetAccountId: '22222222-2222-4222-8222-222222222222'
        })]
      }, 'admin');
      service.authorizePlan(record.id, plan.version, 'admin');
      record = await service.executePlan(record.id, plan.version, 'admin');
      expect(record.executionStatus).toBe('BLOCKED');
      expect(record.riskFindings.map(item => item.code)).toContain('PROVIDER_HIGH_VALUE_REJECTED');
      expect(provider.createInternalTransfer).toHaveBeenCalledTimes(1);
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps an unknown manifest plus detached file in the generic diagnostic profile', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'case-generic-signature-'));
    const store = new SQLiteCaseStore(':memory:');
    const service = new BrokeredFundingCaseService(
      store,
      new EncryptedEvidenceStore(directory, randomBytes(32)),
      new CleanTestScanner(),
      mockProvider(),
      limits,
      {}
    );
    try {
      const submitted = service.submit(await zipBuffer([
        ['manifest.json', Buffer.from('{}')],
        ['manifest.sig', Buffer.from('unrelated detached data')],
        ['cover-letter.txt', Buffer.from('Diagnostic package')]
      ]), 'generic-with-unrelated-signature');
      const record = await service.waitForProcessing(submitted.case.id);
      expect(record.submissions.at(-1)).toMatchObject({
        format: 'generic-compatibility/1.0',
        state: 'VALIDATED',
        scanner: 'CLEAN'
      });
      expect(record.riskFindings.map(item => item.code)).toContain('UNSUPPORTED_PACKAGE_PROFILE');
      expect(record.artifacts.map(item => item.normalizedPath)).toEqual(expect.arrayContaining([
        'manifest.json', 'manifest.sig', 'cover-letter.txt'
      ]));
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('accepts broker-confirmed full-value inputs for a clean generic case without weakening strict signature findings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'case-broker-confirmed-'));
    const store = new SQLiteCaseStore(':memory:');
    const provider = highValueProvider();
    const service = new BrokeredFundingCaseService(
      store,
      new EncryptedEvidenceStore(directory, randomBytes(32)),
      new CleanTestScanner(),
      provider,
      limits,
      {},
      undefined,
      sandboxCaseMaximums
    );
    try {
      const submitted = service.submit(
        await zipBuffer([['broker-cover-letter.txt', Buffer.from('Representative real-case structure')]]),
        'generic-broker-confirmed'
      );
      let record = await service.waitForProcessing(submitted.case.id);
      record = service.addAmendment(record.id, {
        reason: 'Broker confirmed the material transaction facts against cited case evidence.',
        source: 'Designated broker review',
        claims: [{
          path: 'expectedIncomingCredit',
          value: {
            amountMinor: 100_000_000_000,
            currency: 'USD',
            exponent: 2,
            reference: 'BROKER CONFIRMED USD 1B',
            destinationAccountId: '11111111-1111-4111-8111-111111111111',
            investorName: 'Confirmed synthetic investor'
          }
        }, {
          path: 'investor.legalName', value: 'Confirmed synthetic investor'
        }, {
          path: 'beneficiary.legalName', value: 'Confirmed synthetic beneficiary'
        }, {
          path: 'authority.reference', value: 'broker-confirmed-authority-reference'
        }, {
          path: 'purpose', value: 'Broker-confirmed high-value Sandbox case'
        }],
        resolvesFindingCodes: ['MANIFEST_MISSING', 'UNSUPPORTED_PACKAGE_PROFILE'],
        evidenceRefs: ['BROKER-CONFIRMATION-SYNTHETIC-001']
      }, 'admin');
      expect(record.fundingExpectation).toMatchObject({ amountMinor: 100_000_000_000, exponent: 2 });
      expect(record.riskFindings.filter(item => item.hardBlock && !item.resolvedAt)
        .map(item => item.code)).toEqual(['INCOMING_SETTLEMENT_UNOBSERVED']);
      record = await service.refreshFunding(record.id, 'admin', true);
      expect(record.fundingStatus).toBe('MATCHED');
      expect(provider.simulateTopUp).toHaveBeenCalledWith(expect.objectContaining({ amount: 1_000_000_000 }));

      const trustedSource = generateKeyPairSync('ed25519');
      const untrustedSigner = generateKeyPairSync('ed25519');
      const strictService = new BrokeredFundingCaseService(
        store,
        new EncryptedEvidenceStore(join(directory, 'strict-evidence'), randomBytes(32)),
        new CleanTestScanner(),
        mockProvider(),
        limits,
        { 'synthetic-source-1': trustedSource.publicKey.export({ type: 'spki', format: 'pem' }).toString() }
      );
      const strictSubmitted = strictService.submit(
        await signedPackage(untrustedSigner.privateKey, untrustedSigner.publicKey),
        'strict-untrusted-signature'
      );
      const strictRecord = await strictService.waitForProcessing(strictSubmitted.case.id);
      expect(strictRecord.riskFindings.map(item => item.code)).toContain('SOURCE_SIGNATURE_INVALID');
      expect(() => strictService.addAmendment(strictRecord.id, {
        reason: 'Attempt to override a strict signature result.',
        source: 'Synthetic negative test',
        claims: [{ path: 'purpose', value: 'Must not bypass source authentication' }],
        resolvesFindingCodes: ['SOURCE_SIGNATURE_INVALID'],
        evidenceRefs: ['SYNTHETIC-NEGATIVE-TEST']
      }, 'admin')).toThrow('cannot be resolved by amendment');
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('requires the exact matched credit and matched funding account for a plan', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'case-exact-receipt-'));
    const store = new SQLiteCaseStore(':memory:');
    const provider = highValueProvider();
    const sourceKeys = generateKeyPairSync('ed25519');
    const service = new BrokeredFundingCaseService(
      store,
      new EncryptedEvidenceStore(directory, randomBytes(32)),
      new CleanTestScanner(),
      provider,
      limits,
      { 'synthetic-source-1': sourceKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
      undefined,
      sandboxCaseMaximums
    );
    try {
      const submitted = service.submit(await signedPackage(sourceKeys.privateKey, sourceKeys.publicKey, {
        amountMinor: 100_000_000_000,
        currency: 'USD',
        exponent: 2,
        reference: 'EXACT RECEIPT TEST',
        destinationAccountId: '11111111-1111-4111-8111-111111111111',
        investorName: 'Exact receipt investor'
      }), 'exact-receipt-test');
      let record = await service.waitForProcessing(submitted.case.id);
      record = await service.refreshFunding(record.id, 'admin', true);
      record = service.decide(record.id, { outcome: 'APPROVE', reason: 'Exact receipt was matched.' }, 'admin');
      const stored = store.get(record.id)!;
      stored.providerObservations.push({
        id: 'unrelated-lower-credit',
        providerTransactionId: 'lower-credit-transaction',
        accountId: '11111111-1111-4111-8111-111111111111',
        direction: 'CREDIT',
        state: 'completed',
        reference: 'OTHER CREDIT',
        amountMinor: 1,
        currency: 'USD',
        exponent: 2,
        observedAt: new Date().toISOString(),
        source: 'PROVIDER',
        rawResponseSha256: 'f'.repeat(64)
      });
      store.save(stored, {
        eventType: 'TEST_UNRELATED_CREDIT_RECORDED',
        actor: 'test',
        reason: 'Synthetic unrelated lower credit.'
      });
      expect(() => service.createPlan(record.id, {
        receiptObservationId: 'unrelated-lower-credit',
        allocations: [allocation('CUSTOMER_PAYOUT', 1, 'OWNED_ACCOUNT_TRANSFER', {
          targetAccountId: '22222222-2222-4222-8222-222222222222'
        })]
      }, 'admin')).toThrow('completed matched provider credit');
      const exactObservation = store.get(record.id)!.providerObservations.find(item => item.id !== 'unrelated-lower-credit')!;
      expect(() => service.createPlan(record.id, {
        receiptObservationId: exactObservation.id,
        allocations: [{
          ...allocation('CUSTOMER_PAYOUT', 100_000_000_000, 'OWNED_ACCOUNT_TRANSFER', {
            targetAccountId: '22222222-2222-4222-8222-222222222222'
          }),
          sourceAccountId: '22222222-2222-4222-8222-222222222222'
        }]
      }, 'admin')).toThrow('must originate from the account that received');
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('records a declined full-value top-up once and permits observation-only reconciliation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'case-topup-no-retry-'));
    const store = new SQLiteCaseStore(':memory:');
    const provider = highValueProvider('completed', 'declined');
    const service = new BrokeredFundingCaseService(
      store,
      new EncryptedEvidenceStore(directory, randomBytes(32)),
      new CleanTestScanner(),
      provider,
      limits,
      {},
      undefined,
      sandboxCaseMaximums
    );
    try {
      const submitted = service.submit(
        await zipBuffer([['diagnostic.txt', Buffer.from('No manifest')]]),
        'topup-no-retry'
      );
      let record = await service.waitForProcessing(submitted.case.id);
      record = await service.prepareSandboxWalkthrough(record.id, {
        sourceAccountId: '11111111-1111-4111-8111-111111111111',
        amountMinor: 100_000_000_000,
        currency: 'USD',
        exponent: 2
      }, 'admin');
      record = await service.refreshFunding(record.id, 'admin', true);
      expect(record.fundingAttempts).toHaveLength(1);
      expect(record.fundingAttempts?.[0]).toMatchObject({ state: 'DECLINED' });
      await expect(service.refreshFunding(record.id, 'admin', true))
        .rejects.toThrow('already recorded');
      expect(provider.simulateTopUp).toHaveBeenCalledTimes(1);
      await expect(service.refreshFunding(record.id, 'admin', false)).resolves.toMatchObject({
        fundingStatus: 'UNMATCHED'
      });
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('recovers an interrupted full-value funding reservation from an independently observed terminal credit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'case-funding-recovery-'));
    const store = new SQLiteCaseStore(':memory:');
    const provider = highValueProvider();
    const service = new BrokeredFundingCaseService(
      store,
      new EncryptedEvidenceStore(directory, randomBytes(32)),
      new CleanTestScanner(),
      provider,
      limits,
      {},
      undefined,
      sandboxCaseMaximums
    );
    try {
      const submitted = service.submit(
        await zipBuffer([['diagnostic.txt', Buffer.from('Funding recovery diagnostic package')]]),
        'funding-recovery'
      );
      let record = await service.waitForProcessing(submitted.case.id);
      record = await service.prepareSandboxWalkthrough(record.id, {
        sourceAccountId: '11111111-1111-4111-8111-111111111111',
        amountMinor: 100_000_000_000,
        currency: 'USD',
        exponent: 2
      }, 'admin');
      const expectation = record.fundingExpectation!;
      const expectationDigest = sha256(canonicalJson(expectation));
      const now = new Date().toISOString();
      record.fundingAttempts = [{
        id: 'funding-recovery-attempt',
        expectationDigest,
        providerRequestId: '44444444-4444-4444-8444-444444444444',
        state: 'SUBMITTING',
        createdAt: now,
        updatedAt: now
      }];
      expect(store.reserveFundingAttempt(
        record,
        expectationDigest,
        'funding-recovery-attempt',
        record.revision ?? 0,
        {
          eventType: 'TEST_FUNDING_RESERVATION',
          actor: 'test',
          reason: 'Simulated process interruption after durable funding reservation.'
        }
      )).toBe('ACQUIRED');
      provider.listTransactions = vi.fn(async () => [{
        id: '33333333-3333-4333-8333-333333333333',
        state: 'completed',
        type: 'topup',
        reference: expectation.reference,
        legs: [{
          account_id: expectation.destinationAccountId,
          amount: minorToDecimal(expectation.amountMinor, expectation.exponent),
          currency: expectation.currency
        }]
      }]);

      record = await service.refreshFunding(record.id, 'admin', false);
      expect(record.fundingStatus).toBe('MATCHED');
      expect(record.fundingAttempts?.[0]).toMatchObject({ state: 'COMPLETED' });
      expect(store.hasActiveFundingAttemptLock(record.id)).toBe(false);
      expect(() => service.decide(record.id, {
        outcome: 'APPROVE', reason: 'Recovered funding observation is exact and complete.'
      }, 'admin')).not.toThrow();
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('records an interrupted funding reservation as ambiguous when no provider transaction can be observed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'case-funding-no-result-recovery-'));
    const store = new SQLiteCaseStore(':memory:');
    const provider = highValueProvider();
    const service = new BrokeredFundingCaseService(
      store,
      new EncryptedEvidenceStore(directory, randomBytes(32)),
      new CleanTestScanner(),
      provider,
      limits,
      {},
      undefined,
      sandboxCaseMaximums
    );
    try {
      const submitted = service.submit(
        await zipBuffer([['diagnostic.txt', Buffer.from('No-result funding recovery diagnostic package')]]),
        'funding-no-result-recovery'
      );
      let record = await service.waitForProcessing(submitted.case.id);
      record = await service.prepareSandboxWalkthrough(record.id, {
        sourceAccountId: '11111111-1111-4111-8111-111111111111',
        amountMinor: 100_000_000_000,
        currency: 'USD',
        exponent: 2
      }, 'admin');
      const expectation = record.fundingExpectation!;
      const expectationDigest = sha256(canonicalJson(expectation));
      const now = new Date().toISOString();
      record.fundingAttempts = [{
        id: 'funding-no-result-attempt',
        expectationDigest,
        providerRequestId: '55555555-5555-4555-8555-555555555555',
        state: 'SUBMITTING',
        createdAt: now,
        updatedAt: now
      }];
      expect(store.reserveFundingAttempt(
        record,
        expectationDigest,
        'funding-no-result-attempt',
        record.revision ?? 0,
        {
          eventType: 'TEST_FUNDING_RESERVATION',
          actor: 'test',
          reason: 'Simulated interruption before the provider could return a funding result.'
        }
      )).toBe('ACQUIRED');
      provider.listTransactions = vi.fn(async () => []);

      record = await service.refreshFunding(record.id, 'admin', false);
      expect(record.fundingStatus).toBe('UNMATCHED');
      expect(record.fundingAttempts?.[0]).toMatchObject({ state: 'AMBIGUOUS' });
      expect(record.riskFindings.map(item => item.code)).toContain('PROVIDER_RESPONSE_AMBIGUOUS');
      expect(store.hasActiveFundingAttemptLock(record.id)).toBe(false);
      await expect(service.refreshFunding(record.id, 'admin', true))
        .rejects.toThrow('already recorded');
      expect(() => service.decide(record.id, {
        outcome: 'REQUEST_INFORMATION',
        reason: 'The interrupted Sandbox funding request requires provider support or a later exact observation.'
      }, 'admin')).not.toThrow();
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('redacts credential-shaped provider response bodies before preserving case evidence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'case-provider-redaction-'));
    const store = new SQLiteCaseStore(':memory:');
    const provider = highValueProvider();
    provider.simulateTopUp = vi.fn(async () => {
      throw new OperationalFault('Synthetic provider validation response.', {
        category: 'validation', severity: 'critical', retryable: false,
        providerResponse: {
          refresh_token: 'refresh-secret-value',
          nested: { client_assertion: 'assertion-secret-value' },
          body: '{"access_token":"body-secret-value"}',
          query: 'access_token=query-secret-value&access-token=query-dash-secret-value'
        }
      });
    });
    const evidence = new EncryptedEvidenceStore(directory, randomBytes(32));
    const service = new BrokeredFundingCaseService(
      store, evidence, new CleanTestScanner(), provider, limits, {}, undefined, sandboxCaseMaximums
    );
    try {
      const submitted = service.submit(
        await zipBuffer([['diagnostic.txt', Buffer.from('Provider redaction diagnostic package')]]),
        'provider-redaction'
      );
      let record = await service.waitForProcessing(submitted.case.id);
      record = await service.prepareSandboxWalkthrough(record.id, {
        sourceAccountId: '11111111-1111-4111-8111-111111111111',
        amountMinor: 100_000_000_000,
        currency: 'USD',
        exponent: 2
      }, 'admin');
      record = await service.refreshFunding(record.id, 'admin', true);
      const finding = record.riskFindings.find(item => item.code === 'PROVIDER_AMOUNT_LIMIT_UNKNOWN')!;
      const preserved = evidence.get(finding.evidenceRefs[0]!).toString('utf8');
      expect(preserved).toContain('[redacted]');
      expect(preserved).not.toContain('refresh-secret-value');
      expect(preserved).not.toContain('assertion-secret-value');
      expect(preserved).not.toContain('body-secret-value');
      expect(preserved).not.toContain('query-secret-value');
      expect(preserved).not.toContain('query-dash-secret-value');
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('serializes case and pilot execution reservations across independent SQLite stores', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'case-cross-store-lock-'));
    const databasePath = join(directory, 'cases.sqlite');
    const firstStore = new SQLiteCaseStore(databasePath);
    const secondStore = new SQLiteCaseStore(databasePath);
    const service = new BrokeredFundingCaseService(
      firstStore,
      new EncryptedEvidenceStore(join(directory, 'evidence'), randomBytes(32)),
      new CleanTestScanner(),
      highValueProvider(),
      limits,
      {},
      undefined,
      sandboxCaseMaximums
    );
    try {
      const submitted = service.submit(
        await zipBuffer([['diagnostic.txt', Buffer.from('Cross-store lock diagnostic package')]]),
        'cross-store-lock'
      );
      await service.waitForProcessing(submitted.case.id);
      const firstRecord = firstStore.get(submitted.case.id)!;
      expect(firstStore.reserveExecution(
        firstRecord,
        1,
        'a'.repeat(64),
        firstRecord.revision ?? 0,
        {
          eventType: 'TEST_EXECUTION_RESERVATION',
          actor: 'test-one',
          reason: 'First worker reserves the high-value pilot execution slot.'
        }
      )).toBe('ACQUIRED');
      const secondRecord = secondStore.get(submitted.case.id)!;
      expect(secondStore.reserveExecution(
        secondRecord,
        1,
        'a'.repeat(64),
        secondRecord.revision ?? 0,
        {
          eventType: 'TEST_EXECUTION_RESERVATION',
          actor: 'test-two',
          reason: 'Second worker must not reserve the same execution slot.'
        }
      )).toBe('CASE_LOCKED');
      firstStore.releaseExecutionReservation(submitted.case.id, 1);
      const retryRecord = secondStore.get(submitted.case.id)!;
      expect(secondStore.reserveExecution(
        retryRecord,
        1,
        'a'.repeat(64),
        retryRecord.revision ?? 0,
        {
          eventType: 'TEST_EXECUTION_RESERVATION',
          actor: 'test-two',
          reason: 'Released execution reservation can be acquired once.'
        }
      )).toBe('ACQUIRED');
    } finally {
      firstStore.close();
      secondStore.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reloads the current case after claiming reconciliation so an interleaved READY update survives', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'case-reconcile-reload-'));
    const databasePath = join(directory, 'cases.sqlite');
    const firstStore = new SQLiteCaseStore(databasePath);
    const secondStore = new SQLiteCaseStore(databasePath);
    const provider = mockProvider();
    const sourceKeys = generateKeyPairSync('ed25519');
    const service = new BrokeredFundingCaseService(
      firstStore,
      new EncryptedEvidenceStore(join(directory, 'evidence'), randomBytes(32)),
      new CleanTestScanner(),
      provider,
      limits,
      { 'synthetic-source-1': sourceKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }
    );
    let restoreClaimSpy: (() => void) | undefined;
    try {
      const submitted = service.submit(
        await signedPackage(sourceKeys.privateKey, sourceKeys.publicKey),
        'reconcile-reload'
      );
      let record = await service.waitForProcessing(submitted.case.id);
      record = await service.refreshFunding(record.id, 'admin', true);
      record = service.decide(record.id, {
        outcome: 'APPROVE', reason: 'Synthetic receipt is fully matched.'
      }, 'admin');
      const plan = service.createPlan(record.id, {
        receiptObservationId: record.providerObservations[0]!.id,
        allocations: [allocation('CUSTOMER_PAYOUT', 1_000, 'OWNED_ACCOUNT_TRANSFER', {
          targetAccountId: '22222222-2222-4222-8222-222222222222'
        })]
      }, 'admin');
      service.authorizePlan(record.id, plan.version, 'admin');
      await service.executePlan(record.id, plan.version, 'admin');

      const originalClaim = firstStore.claimExecutionReconciliation.bind(firstStore);
      const claimSpy = vi.spyOn(firstStore, 'claimExecutionReconciliation').mockImplementation((caseId, version) => {
        // This write occurs after reconcile read its initial snapshot but
        // before it acquires the READY reconciliation claim.
        const interleaved = secondStore.get(caseId)!;
        interleaved.brokerFindings.push({
          id: 'ready-interleaving-marker',
          category: 'TEST_INTERLEAVING',
          outcome: 'CONCERN',
          note: 'A permitted READY-state observation update must not be overwritten.',
          evidenceRefs: [],
          actor: 'test-two',
          recordedAt: new Date().toISOString()
        });
        interleaved.updatedAt = new Date().toISOString();
        secondStore.save(interleaved, {
          eventType: 'TEST_READY_STATE_INTERLEAVING_UPDATE',
          actor: 'test-two',
          reason: 'Synthetic permitted update before reconciliation lease claim.'
        });
        return originalClaim(caseId, version);
      });
      restoreClaimSpy = () => claimSpy.mockRestore();

      record = await service.reconcile(record.id, 'admin');
      expect(record.executionStatus).toBe('RECONCILED');
      expect(firstStore.get(record.id)?.brokerFindings).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'ready-interleaving-marker' })
      ]));
    } finally {
      restoreClaimSpy?.();
      firstStore.close();
      secondStore.close();
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
      expect(record.artifacts).toEqual([]);
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

function multiCurrencyProvider(): SandboxInternalTransferClient {
  return {
    getAccounts: vi.fn(async () => ['USD', 'JPY', 'BHD'].flatMap(currency => [
      {
        id: `source-${currency}`,
        name: `${currency} diagnostic source`,
        currency,
        balance: 1_000_000_000,
        state: 'active'
      },
      {
        id: `target-${currency}`,
        name: `${currency} diagnostic target`,
        currency,
        balance: 0,
        state: 'active'
      }
    ])),
    createInternalTransfer: vi.fn(async input => ({ id: input.requestId, state: 'completed' })),
    getTransaction: vi.fn(async transactionId => ({ id: transactionId, state: 'completed' }))
  };
}

function highValueProvider(
  payoutState: 'completed' | 'declined' = 'completed',
  topupState: 'completed' | 'declined' = 'completed'
): SandboxInternalTransferClient {
  let simulated: {
    accountId: string;
    amount: number;
    currency: string;
    reference: string;
  } | undefined;
  return {
    getAccounts: vi.fn(async () => [
      {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'USD high-value source',
        currency: 'USD',
        balance: 1_000_000_000,
        state: 'active'
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        name: 'USD high-value target',
        currency: 'USD',
        balance: 0,
        state: 'active'
      }
    ]),
    simulateTopUp: vi.fn(async input => {
      simulated = input;
      return { id: '33333333-3333-4333-8333-333333333333', state: topupState };
    }),
    listTransactions: vi.fn(async () => simulated ? [{
      id: '33333333-3333-4333-8333-333333333333',
      state: topupState,
      type: 'topup',
      reference: simulated.reference,
      legs: [{
        account_id: simulated.accountId,
        amount: minorToDecimal(100_000_000_000, 2),
        currency: simulated.currency
      }]
    }] : []),
    createInternalTransfer: vi.fn(async input => ({ id: input.requestId, state: payoutState })),
    getTransaction: vi.fn(async transactionId => ({ id: transactionId, state: payoutState }))
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
  _publicKey: ReturnType<typeof generateKeyPairSync>['publicKey'],
  expectedIncomingCredit = {
    amountMinor: 1_000,
    currency: 'USD',
    exponent: 2,
    reference: 'SYNTHETIC INVESTOR CREDIT',
    destinationAccountId: '11111111-1111-4111-8111-111111111111',
    investorName: 'Synthetic Investor Ltd'
  }
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
    expectedIncomingCredit,
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

function minorToDecimal(amountMinor: number, exponent: number) {
  if (exponent === 0) return String(amountMinor);
  const digits = String(amountMinor).padStart(exponent + 1, '0');
  return `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
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
