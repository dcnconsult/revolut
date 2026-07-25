import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SandboxInternalTransferClient } from '../src/adapters/revolut-sandbox-client.js';
import { buildApp } from '../src/server.js';

const provider: SandboxInternalTransferClient = {
  getAccounts: vi.fn(async () => []),
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
    const zip = await readFile('../inbox/TXN001/TXN_001.zip');
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
    const zip = await readFile('../inbox/TXN001/TXN_001.zip');
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
