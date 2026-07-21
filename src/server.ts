import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import sensible from '@fastify/sensible';
import { MockBankingProvider } from './adapters/mock-provider.js';
import { env } from './config/env.js';
import { iso20022ImportRoutes } from './http/routes/iso20022-imports.js';
import { paymentRoutes } from './http/routes/payments.js';
import { Iso20022ParserService } from './iso20022/parser.js';
import { Iso20022ImportService } from './services/iso20022-import-service.js';
import { PaymentOrchestrator } from './services/payment-orchestrator.js';
import { InMemoryPaymentStore } from './storage/payment-store.js';

export function buildApp() {
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

  const provider = new MockBankingProvider(); // Replace with RevolutBusinessProvider after credentials are connected.
  const orchestrator = new PaymentOrchestrator(provider, new InMemoryPaymentStore());
  const parser = new Iso20022ParserService({
    maxFileBytes: env.ISO20022_MAX_FILE_BYTES,
    maxTransactions: env.ISO20022_MAX_TRANSACTIONS,
    maxXmlElements: env.ISO20022_MAX_XML_ELEMENTS,
    maxXmlDepth: env.ISO20022_MAX_XML_DEPTH,
    structuredAddressCutoff: env.ISO20022_STRUCTURED_ADDRESS_CUTOFF
  });
  const importService = new Iso20022ImportService(parser, orchestrator);

  app.get('/health', async () => ({ status: 'ok', mode: env.REVOLUT_MODE }));
  app.register(async instance => {
    await paymentRoutes(instance, orchestrator);
    await iso20022ImportRoutes(instance, importService);
  }, { prefix: '/v1' });
  return app;
}

if (process.env.NODE_ENV !== 'test') {
  const app = buildApp();
  app.listen({ port: env.PORT, host: '0.0.0.0' }).catch(error => {
    app.log.error(error);
    process.exit(1);
  });
}
