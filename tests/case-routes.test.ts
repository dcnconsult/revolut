import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SandboxInternalTransferClient } from '../src/adapters/revolut-sandbox-client.js';
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

  it('allows an administrator to prepare an explicit Sandbox walkthrough for an unusable upload', async () => {
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
      if (response.json().caseStatus !== 'QUARANTINED') break;
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
    expect(prepared.statusCode).toBe(200);
    expect(prepared.json()).toMatchObject({
      caseStatus: 'AWAITING_BROKER',
      fundingStatus: 'AWAITING_FUNDS',
      fundingExpectation: {
        amountMinor: 500,
        currency: 'USD',
        destinationAccountId: '11111111-1111-4111-8111-111111111111'
      }
    });
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
