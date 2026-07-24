import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { SandboxInternalTransferService } from '../../services/sandbox-internal-transfer-service.js';

const TransferRequestSchema = z.object({
  sourceAccountId: z.string().uuid(),
  targetAccountId: z.string().uuid(),
  amountMinor: z.number().int().positive(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  reference: z.string().trim().min(1).max(140),
  clientReference: z.string().trim().min(8).max(64)
});

export async function sandboxInternalTransferRoutes(
  app: FastifyInstance,
  service: SandboxInternalTransferService
) {
  app.get('/sandbox/accounts', async (_request, reply) => {
    try {
      return reply.send(await service.listAccounts());
    } catch (error) {
      return reply.code(502).send({ error: 'sandbox_provider_error', message: (error as Error).message });
    }
  });

  app.post('/sandbox/internal-transfers/prepare', async (request, reply) => {
    const parsed = TransferRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_error', details: parsed.error.flatten() });
    }
    try {
      return reply.code(201).send(await service.prepare(parsed.data));
    } catch (error) {
      return reply.code(422).send({ error: 'sandbox_transfer_rejected', message: (error as Error).message });
    }
  });

  app.post<{ Params: { id: string } }>('/sandbox/internal-transfers/:id/submit', async (request, reply) => {
    try {
      return reply.send(await service.submit(request.params.id));
    } catch (error) {
      return reply.code(409).send({ error: 'sandbox_submission_rejected', message: (error as Error).message });
    }
  });

  app.post<{ Params: { id: string } }>('/sandbox/internal-transfers/:id/reconcile', async (request, reply) => {
    try {
      return reply.send(await service.reconcile(request.params.id));
    } catch (error) {
      return reply.code(404).send({ error: 'sandbox_transfer_not_found', message: (error as Error).message });
    }
  });

  app.get<{ Params: { id: string } }>('/sandbox/internal-transfers/:id', async (request, reply) => {
    try {
      return reply.send(service.get(request.params.id));
    } catch (error) {
      return reply.code(404).send({ error: 'sandbox_transfer_not_found', message: (error as Error).message });
    }
  });
}
