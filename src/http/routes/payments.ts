import type { FastifyInstance } from 'fastify';
import { PaymentRequestSchema } from '../../domain/payment.js';
import type { PaymentOrchestrator } from '../../services/payment-orchestrator.js';

export async function paymentRoutes(app: FastifyInstance, orchestrator: PaymentOrchestrator) {
  app.post('/payments/prepare', async (request, reply) => {
    const parsed = PaymentRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_error', details: parsed.error.flatten() });
    try { return reply.code(201).send(await orchestrator.prepare(parsed.data)); }
    catch (error) { return reply.code(422).send({ error: 'payment_rejected', message: (error as Error).message }); }
  });

  app.post<{ Params: { id: string } }>('/payments/:id/submit', async (request, reply) => {
    try { return reply.send(await orchestrator.submit(request.params.id)); }
    catch (error) { return reply.code(409).send({ error: 'submission_rejected', message: (error as Error).message }); }
  });

  app.post<{ Params: { id: string } }>('/payments/:id/reconcile', async (request, reply) => {
    try { return reply.send(await orchestrator.reconcile(request.params.id)); }
    catch (error) { return reply.code(404).send({ error: 'not_found', message: (error as Error).message }); }
  });

  app.get<{ Params: { id: string } }>('/payments/:id', async (request, reply) => {
    try { return reply.send(await orchestrator.get(request.params.id)); }
    catch (error) { return reply.code(404).send({ error: 'not_found', message: (error as Error).message }); }
  });
}
