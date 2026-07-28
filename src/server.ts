import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import sensible from '@fastify/sensible';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Server as HttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockBankingProvider } from './adapters/mock-provider.js';
import {
  RevolutSandboxClient,
  type SandboxInternalTransferClient
} from './adapters/revolut-sandbox-client.js';
import { env } from './config/env.js';
import { iso20022ImportRoutes } from './http/routes/iso20022-imports.js';
import { paymentRoutes } from './http/routes/payments.js';
import { sandboxInternalTransferRoutes } from './http/routes/sandbox-internal-transfers.js';
import { operatorRoutes } from './http/routes/operator.js';
import { caseRoutes } from './http/routes/cases.js';
import { Iso20022ParserService } from './iso20022/parser.js';
import { Iso20022ImportService } from './services/iso20022-import-service.js';
import { PaymentOrchestrator } from './services/payment-orchestrator.js';
import { SandboxInternalTransferService } from './services/sandbox-internal-transfer-service.js';
import { InMemoryPaymentStore } from './storage/payment-store.js';
import { SQLiteSandboxTransferStore } from './storage/sandbox-transfer-store.js';
import {
  createTestCredentials,
  loadOperatorCredentials,
  OperatorAuth,
  type OperatorCredentials
} from './security/operator-auth.js';
import { SQLiteCaseStore } from './cases/case-store.js';
import { EncryptedEvidenceStore } from './cases/evidence-store.js';
import { BrokeredFundingCaseService } from './cases/case-service.js';
import {
  ClamAvScanner,
  CleanTestScanner,
  type MalwareScanner
} from './cases/malware-scanner.js';
import {
  buildServerConnectionOptions,
  shouldUseSecureCookies
} from './config/server-connection.js';

interface BuildAppOptions {
  mode?: typeof env.REVOLUT_MODE;
  sandboxClient?: SandboxInternalTransferClient;
  sandboxDatabasePath?: string;
  operatorCredentials?: OperatorCredentials;
  caseEvidenceRoot?: string;
  caseEvidenceKey?: Buffer;
  caseScanner?: MalwareScanner;
  trustedSourceKeys?: Record<string, string>;
  evidenceSigningKeyPem?: string;
}

export function buildApp(options: BuildAppOptions = {}) {
  const mode = options.mode ?? env.REVOLUT_MODE;
  if (mode === 'production') {
    throw new Error('Production mode is not implemented. Use REVOLUT_MODE=mock or REVOLUT_MODE=sandbox.');
  }
  const connection = buildServerConnectionOptions({
    transport: env.APP_TRANSPORT,
    trustProxy: env.APP_TRUST_PROXY,
    ...(env.APP_TLS_CERT_PATH ? { tlsCertificatePath: env.APP_TLS_CERT_PATH } : {}),
    ...(env.APP_TLS_KEY_PATH ? { tlsPrivateKeyPath: env.APP_TLS_KEY_PATH } : {}),
    ...(env.APP_TLS_CLIENT_CA_PATH ? { tlsClientCaPath: env.APP_TLS_CLIENT_CA_PATH } : {}),
    ...(env.APP_TLS_KEY_PASSPHRASE_PATH
      ? { tlsPrivateKeyPassphrasePath: env.APP_TLS_KEY_PASSPHRASE_PATH }
      : {})
  });
  const fastifyOptions = {
    logger: {
      level: env.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers.x-api-key', 'req.headers.cookie']
    },
    bodyLimit: Math.max(env.ISO20022_MAX_FILE_BYTES, env.CASE_ZIP_MAX_BYTES) + 200_000,
    trustProxy: connection.trustProxy
  };
  const app: FastifyInstance = connection.https
    ? Fastify<HttpsServer>({
        ...fastifyOptions,
        https: connection.https
      }) as unknown as FastifyInstance
    : Fastify(fastifyOptions);
  app.register(sensible);
  app.register(multipart, {
    limits: {
      files: 1,
      fields: 4,
      parts: 5,
      fileSize: Math.max(env.ISO20022_MAX_FILE_BYTES, env.CASE_ZIP_MAX_BYTES),
      fieldSize: 100_000
    }
  });

  app.get('/health', async () => ({
    status: 'ok',
    mode,
    provider: mode === 'sandbox' ? 'revolut-sandbox-internal-transfer' : 'mock'
  }));

  if (mode === 'mock') {
    const provider = new MockBankingProvider();
    const orchestrator = new PaymentOrchestrator(provider, new InMemoryPaymentStore());
    const parser = new Iso20022ParserService({
      maxFileBytes: env.ISO20022_MAX_FILE_BYTES,
      maxTransactions: env.ISO20022_MAX_TRANSACTIONS,
      maxXmlElements: env.ISO20022_MAX_XML_ELEMENTS,
      maxXmlDepth: env.ISO20022_MAX_XML_DEPTH,
      structuredAddressCutoff: env.ISO20022_STRUCTURED_ADDRESS_CUTOFF
    });
    const importService = new Iso20022ImportService(parser, orchestrator);
    app.register(async instance => {
      await paymentRoutes(instance, orchestrator);
      await iso20022ImportRoutes(instance, importService);
    }, { prefix: '/v1' });
  } else {
    const client = options.sandboxClient ?? new RevolutSandboxClient({
      configPath: env.REVOLUT_SANDBOX_CONFIG_PATH,
      tokensPath: env.REVOLUT_SANDBOX_TOKENS_PATH,
      privateKeyPath: env.REVOLUT_SANDBOX_PRIVATE_KEY_PATH
    });
    const store = new SQLiteSandboxTransferStore(options.sandboxDatabasePath ?? env.SANDBOX_DATABASE_PATH);
    const service = new SandboxInternalTransferService(
      client,
      env.SANDBOX_INTERNAL_TRANSFER_MAX_MINOR,
      store
    );
    const credentials = options.operatorCredentials ??
      (env.NODE_ENV === 'test'
        ? createTestCredentials()
        : loadOperatorCredentials(env.OPERATOR_AUTH_CONFIG_PATH));
    const auth = new OperatorAuth(
      credentials,
      store,
      shouldUseSecureCookies(env.OPERATOR_COOKIE_SECURE, env.APP_TRANSPORT)
    );
    const evidenceRoot = options.caseEvidenceRoot ??
      (env.NODE_ENV === 'test'
        ? join(tmpdir(), `revolut-case-evidence-${randomUUID()}`)
        : env.CASE_EVIDENCE_ROOT);
    const evidenceKey = options.caseEvidenceKey ?? loadOrCreateEvidenceKey(
      evidenceRoot,
      env.CASE_EVIDENCE_KEY_BASE64
    );
    const caseStore = new SQLiteCaseStore(options.sandboxDatabasePath ?? env.SANDBOX_DATABASE_PATH);
    const caseService = new BrokeredFundingCaseService(
      caseStore,
      new EncryptedEvidenceStore(evidenceRoot, evidenceKey),
      options.caseScanner ?? (
        env.NODE_ENV === 'test'
          ? new CleanTestScanner()
          : new ClamAvScanner(env.CLAMAV_HOST, env.CLAMAV_PORT)
      ),
      client,
      {
        maximumZipBytes: env.CASE_ZIP_MAX_BYTES,
        maximumEntries: env.CASE_ZIP_MAX_ENTRIES,
        maximumEntryBytes: env.CASE_ZIP_MAX_ENTRY_BYTES,
        maximumTotalBytes: env.CASE_ZIP_MAX_TOTAL_BYTES,
        maximumCompressionRatio: env.CASE_ZIP_MAX_COMPRESSION_RATIO
      },
      options.trustedSourceKeys ?? env.trustedSourceKeys,
      options.evidenceSigningKeyPem ?? (env.CASE_EVIDENCE_SIGNING_KEY_PEM || undefined),
      env.SANDBOX_INTERNAL_TRANSFER_MAX_MINOR
    );
    caseService.resumePendingJobs();
    app.addHook('onClose', async () => {
      caseStore.close();
      store.close();
    });
    app.register(async instance => {
      await operatorRoutes(instance, auth);
      await sandboxInternalTransferRoutes(instance, service, auth);
      if (env.BROKERED_FUNDING_ENABLED) await caseRoutes(instance, caseService, auth);
    }, { prefix: '/v1' });

    const frontendRoot = join(process.cwd(), 'dist', 'frontend');
    if (existsSync(frontendRoot)) {
      app.register(staticFiles, {
        root: frontendRoot,
        prefix: '/operator/',
        decorateReply: false
      });
      app.get('/operator', async (_request, reply) => reply.redirect('/operator/'));
    }
  }
  return app;
}

function loadOrCreateEvidenceKey(root: string, configured: string) {
  if (configured) {
    const key = Buffer.from(configured, 'base64');
    if (key.length !== 32) throw new Error('CASE_EVIDENCE_KEY_BASE64 must encode exactly 32 bytes.');
    return key;
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const keyPath = join(root, 'master.key');
  if (existsSync(keyPath)) {
    const key = Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'base64');
    if (key.length !== 32) throw new Error('Persisted case evidence key is invalid.');
    return key;
  }
  const key = randomBytes(32);
  writeFileSync(keyPath, `${key.toString('base64')}\n`, { mode: 0o600, flag: 'wx' });
  return key;
}

if (process.env.NODE_ENV !== 'test') {
  const app = buildApp();
  app.listen({ port: env.PORT, host: env.APP_HOST }).catch(error => {
    app.log.error(error);
    process.exit(1);
  });
}
