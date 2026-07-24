import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import sensible from '@fastify/sensible';
import { MockBankingProvider } from './adapters/mock-provider.js';
import {
  RevolutSandboxClient,
  type SandboxInternalTransferClient
} from './adapters/revolut-sandbox-client.js';
import { env } from './config/env.js';
import { iso20022ImportRoutes } from './http/routes/iso20022-imports.js';
import { paymentRoutes } from './http/routes/payments.js';
import { sandboxInternalTransferRoutes } from './http/routes/sandbox-internal-transfers.js';
import { Iso20022ParserService } from './iso20022/parser.js';
import { Iso20022ImportService } from './services/iso20022-import-service.js';
import { PaymentOrchestrator } from './services/payment-orchestrator.js';
import { SandboxInternalTransferService } from './services/sandbox-internal-transfer-service.js';
import { InMemoryPaymentStore } from './storage/payment-store.js';

interface BuildAppOptions {
  mode?: typeof env.REVOLUT_MODE;
  sandboxClient?: SandboxInternalTransferClient;
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
    const service = new SandboxInternalTransferService(
      client,
      env.SANDBOX_INTERNAL_TRANSFER_MAX_MINOR
    );
    app.register(async instance => {
      await sandboxInternalTransferRoutes(instance, service);
    }, { prefix: '/v1' });
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
