import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import sensible from '@fastify/sensible';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
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

interface BuildAppOptions {
  mode?: typeof env.REVOLUT_MODE;
  sandboxClient?: SandboxInternalTransferClient;
  sandboxDatabasePath?: string;
  operatorCredentials?: OperatorCredentials;
}

export function buildApp(options: BuildAppOptions = {}) {
  const mode = options.mode ?? env.REVOLUT_MODE;
  if (mode === 'production') {
    throw new Error('Production mode is not implemented. Use REVOLUT_MODE=mock or REVOLUT_MODE=sandbox.');
  }
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers.x-api-key', 'req.headers.cookie']
    },
    bodyLimit: env.ISO20022_MAX_FILE_BYTES + 200_000
  });
  app.register(sensible);
  app.register(multipart, {
    limits: {
      files: 1,
      fields: 4,
      parts: 5,
      fileSize: env.ISO20022_MAX_FILE_BYTES,
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
    const auth = new OperatorAuth(credentials, store, env.OPERATOR_COOKIE_SECURE);
    app.addHook('onClose', async () => store.close());
    app.register(async instance => {
      await operatorRoutes(instance, auth);
      await sandboxInternalTransferRoutes(instance, service, auth);
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

if (process.env.NODE_ENV !== 'test') {
  const app = buildApp();
  app.listen({ port: env.PORT, host: '0.0.0.0' }).catch(error => {
    app.log.error(error);
    process.exit(1);
  });
}
