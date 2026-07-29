import { setTimeout as delay } from 'node:timers/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SandboxInternalTransferClient } from '../src/adapters/revolut-sandbox-client.js';
import type { BrokeredFundingCaseService } from '../src/cases/case-service.js';
import type { BrokeredCase } from '../src/cases/model.js';
import { caseRoutes } from '../src/http/routes/cases.js';
import type { OperatorAuth } from '../src/security/operator-auth.js';
import { buildApp } from '../src/server.js';
import { legacyAssetDeclarationPackage } from './fixtures/legacy-package.js';

const provider: SandboxInternalTransferClient = {
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
      name: 'USD target',
      currency: 'USD',
      balance: 0,
      state: 'active'
    }
  ]),
  createInternalTransfer: vi.fn(),
  getTransaction: vi.fn(async id => ({ id, state: 'completed' })),
  listTransactions: vi.fn(async () => [])
};

describe('brokered funding case routes', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    vi.clearAllMocks();
  });

  it('accepts a private ZIP asynchronously and exposes the complete legacy hold', async () => {
    app = buildApp({ mode: 'sandbox', sandboxClient: provider, sandboxDatabasePath: ':memory:' });
    const login = await app.inject({
      method: 'POST',
      url: '/v1/operator/session',
      payload: { username: 'admin', password: 'admin-test-password' }
    });
    const setCookie = login.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0] ?? '';
    const securityHeaders = {
      cookie,
      'x-csrf-token': login.json().csrfToken as string,
      origin: 'http://localhost:80'
    };
    const zip = await legacyAssetDeclarationPackage();
    const multipart = multipartPayload(zip);
    const submitted = await app.inject({
      method: 'POST',
      url: '/v1/cases/submissions',
      headers: {
        ...securityHeaders,
        'x-submission-id': 'route-TXN_001',
        'content-type': multipart.contentType
      },
      payload: multipart.body
    });
    expect(submitted.statusCode).toBe(202);
    const caseId = submitted.json().caseId as string;
    let record: {
      caseStatus: string;
      riskFindings: Array<{ code: string }>;
    } | undefined;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/cases/${caseId}`,
        headers: { cookie }
      });
      record = response.json();
      if (record?.caseStatus !== 'QUARANTINED') break;
      await delay(10);
    }
    expect(record?.caseStatus).toBe('INTAKE_HOLD');
    expect(record?.riskFindings.map(item => item.code)).toContain('RPC_BALANCE_MISMATCH');

    const refresh = await app.inject({
      method: 'POST',
      url: `/v1/cases/${caseId}/funding-observations/refresh`,
      headers: securityHeaders,
      payload: {}
    });
    expect(refresh.statusCode).toBe(400);
    expect(refresh.body).toContain('Provider access is blocked');
    expect(provider.listTransactions).not.toHaveBeenCalled();

    const evidence = await app.inject({
      method: 'GET',
      url: `/v1/cases/${caseId}/evidence`,
      headers: { cookie }
    });
    expect(evidence.statusCode).toBe(200);
    expect(evidence.headers['content-type']).toContain('application/vnd.brokered-funding-evidence+json');
    expect(JSON.parse(evidence.body).body.auditChainVerified).toBe(true);
  });

  it('enforces session, role, CSRF, and exact origin on case mutations', async () => {
    app = buildApp({ mode: 'sandbox', sandboxClient: provider, sandboxDatabasePath: ':memory:' });
    expect((await app.inject({ method: 'GET', url: '/v1/cases' })).statusCode).toBe(401);
    const viewerLogin = await app.inject({
      method: 'POST',
      url: '/v1/operator/session',
      payload: { username: 'viewer', password: 'viewer-test-password' }
    });
    const setCookie = viewerLogin.headers['set-cookie'];
    const viewerCookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0] ?? '';
    const zip = await legacyAssetDeclarationPackage();
    const multipart = multipartPayload(zip);
    expect((await app.inject({
      method: 'POST',
      url: '/v1/cases/submissions',
      headers: {
        cookie: viewerCookie,
        'x-csrf-token': viewerLogin.json().csrfToken as string,
        origin: 'http://localhost:80',
        'content-type': multipart.contentType
      },
      payload: multipart.body
    })).statusCode).toBe(403);
  });

  it('returns a strict redacted case summary to a viewer', async () => {
    const viewerApp = Fastify();
    const service = {
      get: vi.fn(() => viewerSensitiveCase())
    } as unknown as BrokeredFundingCaseService;
    const auth = {
      require: vi.fn(() => ({ username: 'viewer', role: 'viewer' }))
    } as unknown as OperatorAuth;
    await caseRoutes(viewerApp, service, auth);

    try {
      const response = await viewerApp.inject({ method: 'GET', url: '/cases/case-private' });
      expect(response.statusCode).toBe(200);
      const record = response.json() as Record<string, unknown>;

      expect(record).toMatchObject({
        id: 'case-private',
        caseStatus: 'APPROVED',
        submissions: [{
          id: 'submission-1',
          format: 'brokered-funding/1.0',
          scanner: 'CLEAN'
        }],
        artifacts: [{ path: '[redacted — administrator evidence view]', scanStatus: 'CLEAN' }],
        fundingExpectation: {
          reference: '[redacted]',
          destinationAccountId: '[redacted]',
          investorName: '[redacted]'
        },
        providerObservations: [],
        plans: [{ version: 1, status: 'AUTHORIZED', digest: '[redacted]' }],
        riskFindings: [{
          code: 'BROKER_REVIEW',
          message: 'A broker review requires administrator follow-up.'
        }]
      });
      for (const secret of [
        'Jane Doe',
        'BROKER NOTE PRIVATE',
        'DECISION REASON PRIVATE',
        'private-reference',
        'private-source-account',
        'private-target-account',
        'private-counterparty',
        'private-payment-method',
        'jane-doe-passport.pdf',
        'CLIENT-SUBMISSION-PRIVATE',
        'private-approval-actor'
      ]) {
        expect(response.body).not.toContain(secret);
      }
      for (const property of [
        'claims',
        'amendments',
        'brokerFindings',
        'approvals',
        'executionAttempts',
        'decision',
        'riskSnapshots'
      ]) {
        expect(record).not.toHaveProperty(property);
      }
      expect((record.plans as Array<Record<string, unknown>>)[0]).not.toHaveProperty('allocations');
      expect((record.submissions as Array<Record<string, unknown>>)[0]).not.toHaveProperty('packageSha256');
      expect((record.artifacts as Array<Record<string, unknown>>)[0]).not.toHaveProperty('sha256');
    } finally {
      await viewerApp.close();
    }
  });

  it('does not allow an administrator to prepare a Sandbox walkthrough for an unsafe upload', async () => {
    app = buildApp({ mode: 'sandbox', sandboxClient: provider, sandboxDatabasePath: ':memory:' });
    const login = await app.inject({
      method: 'POST',
      url: '/v1/operator/session',
      payload: { username: 'admin', password: 'admin-test-password' }
    });
    const setCookie = login.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0] ?? '';
    const securityHeaders = {
      cookie,
      'x-csrf-token': login.json().csrfToken as string,
      origin: 'http://localhost:80'
    };
    const multipart = multipartPayload(Buffer.from('not a ZIP archive'));
    const submitted = await app.inject({
      method: 'POST',
      url: '/v1/cases/submissions',
      headers: {
        ...securityHeaders,
        'x-submission-id': 'route-sandbox-walkthrough',
        'content-type': multipart.contentType
      },
      payload: multipart.body
    });
    expect(submitted.statusCode).toBe(202);
    const caseId = submitted.json().caseId as string;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/cases/${caseId}`,
        headers: { cookie }
      });
      if (response.json().submissions?.at(-1)?.state === 'FAILED') break;
      await delay(10);
    }

    const prepared = await app.inject({
      method: 'POST',
      url: `/v1/cases/${caseId}/sandbox-walkthrough`,
      headers: securityHeaders,
      payload: {
        sourceAccountId: '11111111-1111-4111-8111-111111111111',
        amountMinor: 500,
        currency: 'USD'
      }
    });
    expect(prepared.statusCode).toBe(400);
    expect(prepared.body).toContain('Only a clean, fully inspected ZIP package');
  });
});

function multipartPayload(file: Buffer) {
  const boundary = '----brokered-funding-test-boundary';
  const prefix = Buffer.from(
    `--${boundary}\r\n` +
    'Content-Disposition: form-data; name="package"; filename="TXN_001.zip"\r\n' +
    'Content-Type: application/zip\r\n\r\n'
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    body: Buffer.concat([prefix, file, suffix]),
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

function viewerSensitiveCase(): BrokeredCase {
  const now = '2026-07-28T12:00:00.000Z';
  return {
    id: 'case-private',
    caseStatus: 'APPROVED',
    fundingStatus: 'MATCHED',
    executionStatus: 'AUTHORIZED',
    createdAt: now,
    updatedAt: now,
    submissions: [{
      id: 'CLIENT-SUBMISSION-PRIVATE',
      version: 1,
      packageSha256: 'a'.repeat(64),
      format: 'brokered-funding/1.0',
      originalArtifactSha256: 'b'.repeat(64),
      state: 'VALIDATED',
      receivedAt: now,
      completedAt: now,
      scanner: 'CLEAN'
    }],
    artifacts: [{
      id: 'artifact-private',
      submissionId: 'CLIENT-SUBMISSION-PRIVATE',
      path: 'jane-doe-passport.pdf',
      normalizedPath: 'jane-doe-passport.pdf',
      mediaType: 'application/pdf',
      byteLength: 1234,
      sha256: 'c'.repeat(64),
      encryptedObjectSha256: 'd'.repeat(64),
      scanStatus: 'CLEAN'
    }],
    claims: [{
      id: 'claim-private',
      version: 1,
      path: 'investor.legalName',
      value: 'Jane Doe',
      source: 'SUBMISSION',
      evidenceRefs: ['claim-evidence-private'],
      recordedAt: now
    }],
    riskFindings: [{
      id: 'finding-private',
      code: 'BROKER_JANE_DOE',
      dimension: 'investor_identity',
      severity: 'BLOCK',
      hardBlock: true,
      message: 'BROKER NOTE PRIVATE: Jane Doe needs review.',
      neededNext: 'Call Jane Doe privately.',
      evidenceRefs: ['finding-evidence-private'],
      createdAt: now
    }],
    brokerFindings: [{
      id: 'broker-finding-private',
      category: 'Jane Doe',
      outcome: 'BLOCK',
      note: 'BROKER NOTE PRIVATE: Jane Doe needs review.',
      evidenceRefs: ['broker-evidence-private'],
      actor: 'private-approval-actor',
      recordedAt: now
    }],
    amendments: [{
      id: 'amendment-private',
      version: 1,
      reason: 'DECISION REASON PRIVATE',
      source: 'private broker source',
      claims: [{ path: 'investor.legalName', value: 'Jane Doe' }],
      resolvesFindingCodes: ['BROKER_JANE_DOE'],
      evidenceRefs: ['amendment-evidence-private'],
      actor: 'private-approval-actor',
      recordedAt: now
    }],
    fundingExpectation: {
      amountMinor: 100_000_000_000,
      currency: 'USD',
      exponent: 2,
      reference: 'private-reference',
      destinationAccountId: 'private-source-account',
      investorName: 'Jane Doe'
    },
    providerObservations: [{
      id: 'provider-observation-private',
      providerTransactionId: 'private-provider-transaction',
      accountId: 'private-source-account',
      direction: 'CREDIT',
      state: 'completed',
      reference: 'private-reference',
      amountMinor: 100_000_000_000,
      currency: 'USD',
      exponent: 2,
      observedAt: now,
      source: 'PROVIDER',
      rawResponseSha256: 'e'.repeat(64)
    }],
    plans: [{
      version: 1,
      createdAt: now,
      createdBy: 'private-approval-actor',
      receiptObservationId: 'provider-observation-private',
      receipt: { amountMinor: 100_000_000_000, currency: 'USD', exponent: 2 },
      allocations: [{
        id: 'allocation-private',
        kind: 'CUSTOMER_PAYOUT',
        beneficiaryName: 'Jane Doe',
        reference: 'private-reference',
        method: 'COUNTERPARTY_PAYMENT',
        sourceAccountId: 'private-source-account',
        targetAccountId: 'private-target-account',
        counterpartyId: 'private-counterparty',
        paymentMethodId: 'private-payment-method',
        amountMinor: 100_000_000_000,
        currency: 'USD',
        exponent: 2
      }],
      digest: 'f'.repeat(64),
      riskSnapshotDigest: '0'.repeat(64),
      status: 'AUTHORIZED'
    }],
    approvals: [{
      id: 'approval-private',
      planVersion: 1,
      planDigest: 'f'.repeat(64),
      riskSnapshotDigest: '0'.repeat(64),
      actor: 'private-approval-actor',
      authorizedAt: now
    }],
    executionAttempts: [{
      id: 'attempt-private',
      planVersion: 1,
      allocationId: 'allocation-private',
      sequence: 1,
      providerRequestId: 'private-provider-request',
      providerTransactionId: 'private-provider-transaction',
      providerRequestHash: '1'.repeat(64),
      providerResponseHash: '2'.repeat(64),
      state: 'UNSUBMITTED',
      createdAt: now,
      updatedAt: now
    }],
    riskSnapshots: [{
      version: 1,
      createdAt: now,
      overall: 'HIGH',
      dimensions: {
        technical_integrity: 'PASS',
        source_authentication: 'PASS',
        investor_identity: 'BLOCK',
        beneficiary_identity: 'PASS',
        authority: 'PASS',
        source_of_funds: 'PASS',
        document_consistency: 'PASS',
        incoming_settlement: 'PASS',
        payout_structure: 'PASS',
        execution_readiness: 'PASS'
      },
      hardBlockCodes: ['BROKER_JANE_DOE'],
      digest: '3'.repeat(64)
    }],
    decision: {
      outcome: 'APPROVE',
      reason: 'DECISION REASON PRIVATE',
      actor: 'private-approval-actor',
      decidedAt: now
    }
  };
}
