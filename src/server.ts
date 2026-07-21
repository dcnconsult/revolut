import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { MockBankingProvider } from './adapters/mock-provider.js';
import { env } from './config/env.js';
import { paymentRoutes } from './http/routes/payments.js';
import { PaymentOrchestrator } from './services/payment-orchestrator.js';
import { InMemoryPaymentStore } from './storage/payment-store.js';

export function buildApp() {
  const app = Fastify({ logger: { level: env.LOG_LEVEL, redact: ['req.headers.authorization', 'req.headers.x-api-key'] } });
  app.register(sensible);
  const provider = new MockBankingProvider(); // Replace with RevolutBusinessProvider after credentials are connected.
  const orchestrator = new PaymentOrchestrator(provider, new InMemoryPaymentStore());

  app.get('/health', async () => ({ status: 'ok', mode: env.REVOLUT_MODE }));
  app.register(async instance => paymentRoutes(instance, orchestrator), { prefix: '/v1' });
  return app;
}

if (process.env.NODE_ENV !== 'test') {
  const app = buildApp();
  app.listen({ port: env.PORT, host: '0.0.0.0' }).catch(error => { app.log.error(error); process.exit(1); });
}
