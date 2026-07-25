import type { FastifyInstance } from 'fastify';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { env } from '../../config/env.js';
import type { OperatorAuth } from '../../security/operator-auth.js';
import type {
  SandboxInternalTransferRecord,
  SandboxInternalTransferRequest,
  SandboxInternalTransferService
} from '../../services/sandbox-internal-transfer-service.js';

interface SubmitBody {
  password?: string;
  confirmation?: string;
}

const actionRoles = ['admin', 'automation'] as const;

export async function sandboxInternalTransferRoutes(
  app: FastifyInstance,
  service: SandboxInternalTransferService,
  auth: OperatorAuth
) {
  app.get('/sandbox/operator-status', async (request, reply) => {
    const principal = auth.require(request, reply, ['admin', 'viewer', 'automation']);
    if (!principal) return;
    return {
      mode: 'sandbox',
      liveData: false,
      maximumAmountMinor: service.maximumTransferAmountMinor(),
      role: principal.role,
      release: env.RELEASE_SHA === 'local' ? 'local' : env.RELEASE_SHA.slice(0, 12),
      backup: backupStatus(),
      generatedAt: new Date().toISOString()
    };
  });

  app.get('/sandbox/accounts', async (request, reply) => {
    const principal = auth.require(request, reply, [...actionRoles]);
    if (!principal) return;
    try {
      return reply.send(await service.listAccounts());
    } catch (error) {
      return reply.internalServerError(error instanceof Error ? error.message : 'Unable to list Sandbox accounts.');
    }
  });

  app.post<{ Body: SandboxInternalTransferRequest }>(
    '/sandbox/internal-transfers/prepare',
    async (request, reply) => {
      const principal = auth.require(request, reply, [...actionRoles], true);
      if (!principal) return;
      try {
        validateTransferRequest(request.body);
        const record = await service.prepare(request.body);
        auth.audit(principal.username, principal.role, 'transfer_prepare', 'success', record.id, {
          amountMinor: record.request.amountMinor,
          currency: record.request.currency
        });
        return reply.code(201).send(record);
      } catch (error) {
        auth.audit(principal.username, principal.role, 'transfer_prepare', 'denied', undefined, {});
        return reply.badRequest(error instanceof Error ? error.message : 'Sandbox transfer preparation failed.');
      }
    }
  );

  app.post<{ Params: { id: string }; Body: SubmitBody }>(
    '/sandbox/internal-transfers/:id/submit',
    async (request, reply) => {
      const principal = auth.require(request, reply, ['admin'], true);
      if (!principal) return;
      try {
        const prepared = service.get(request.params.id);
        const ageMs = Date.now() - Date.parse(prepared.createdAt);
        if (!Number.isFinite(ageMs) || ageMs > 15 * 60 * 1000) {
          throw new Error('Prepared transfer has expired. Prepare it again before submitting.');
        }
        const expectedPhrase = submitPhrase(prepared);
        if (request.body?.confirmation !== expectedPhrase ||
            !auth.verifyAdminPassword(principal.username, request.body?.password ?? '', request.ip)) {
          auth.audit(principal.username, principal.role, 'transfer_submit', 'reauthentication_denied', prepared.id);
          return reply.code(403).send({ error: 'Password or confirmation phrase is incorrect.' });
        }
        const submitted = await service.submit(request.params.id);
        auth.audit(principal.username, principal.role, 'transfer_submit', 'success', submitted.id, {
          amountMinor: submitted.request.amountMinor,
          currency: submitted.request.currency,
          state: submitted.state
        });
        return reply.send(submitted);
      } catch (error) {
        auth.audit(principal.username, principal.role, 'transfer_submit', 'failed', request.params.id);
        return reply.badRequest(error instanceof Error ? error.message : 'Sandbox transfer submission failed.');
      }
    }
  );

  app.post<{ Params: { id: string } }>(
    '/sandbox/internal-transfers/:id/reconcile',
    async (request, reply) => {
      const principal = auth.require(request, reply, ['admin'], true);
      if (!principal) return;
      try {
        const record = await service.reconcile(request.params.id);
        auth.audit(principal.username, principal.role, 'transfer_reconcile', 'success', record.id, {
          state: record.state
        });
        return reply.send(record);
      } catch (error) {
        return reply.badRequest(error instanceof Error ? error.message : 'Sandbox reconciliation failed.');
      }
    }
  );

  app.get<{ Params: { id: string } }>('/sandbox/internal-transfers/:id', async (request, reply) => {
    const principal = auth.require(request, reply, ['admin', 'automation']);
    if (!principal) return;
    try {
      return reply.send(service.get(request.params.id));
    } catch (error) {
      return reply.notFound(error instanceof Error ? error.message : 'Sandbox transfer not found.');
    }
  });

  app.get('/sandbox/monitoring/summary', async (request, reply) => {
    const principal = auth.require(request, reply, ['admin', 'viewer', 'automation']);
    if (!principal) return;
    return service.monitoringSummary();
  });

  app.get<{ Querystring: { limit?: string } }>('/sandbox/monitoring/transfers', async (request, reply) => {
    const principal = auth.require(request, reply, ['admin', 'viewer', 'automation']);
    if (!principal) return;
    const limit = parseLimit(request.query.limit, reply);
    if (!limit) return;
    const records = service.listTransfers(limit);
    return principal.role === 'viewer' ? records.map(redactTransfer) : records;
  });

  app.get<{ Querystring: { limit?: string } }>('/sandbox/monitoring/audit-events', async (request, reply) => {
    const principal = auth.require(request, reply, ['admin', 'viewer', 'automation']);
    if (!principal) return;
    const limit = parseLimit(request.query.limit, reply);
    if (!limit) return;
    const events = service.listAuditEvents(limit);
    return principal.role === 'viewer'
      ? events.map(event => ({
          eventType: event.eventType,
          state: event.state,
          transferRef: event.transferId.slice(0, 8),
          createdAt: event.createdAt
        }))
      : events;
  });

  app.get<{ Querystring: { limit?: string } }>('/sandbox/monitoring/operator-events', async (request, reply) => {
    const principal = auth.require(request, reply, ['admin', 'viewer']);
    if (!principal) return;
    const limit = parseLimit(request.query.limit, reply);
    if (!limit) return;
    const events = service.listOperatorEvents(limit);
    return principal.role === 'viewer'
      ? events.map(event => ({
          action: event.action,
          outcome: event.outcome,
          transferRef: event.transferId?.slice(0, 8),
          createdAt: event.createdAt
        }))
      : events;
  });
}

function parseLimit(value: string | undefined, reply: Parameters<OperatorAuth['require']>[1]) {
  const limit = Number(value ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    void reply.badRequest('limit must be an integer between 1 and 500.');
    return undefined;
  }
  return limit;
}

function redactTransfer(record: SandboxInternalTransferRecord) {
  return {
    transferRef: record.id.slice(0, 8),
    state: record.state,
    amountMinor: record.request.amountMinor,
    currency: record.request.currency,
    reference: record.request.reference,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

function submitPhrase(record: SandboxInternalTransferRecord) {
  return `SUBMIT ${(record.request.amountMinor / 100).toFixed(2)} ${record.request.currency}`;
}

function validateTransferRequest(value: SandboxInternalTransferRequest) {
  if (!value || typeof value.sourceAccountId !== 'string' || typeof value.targetAccountId !== 'string') {
    throw new Error('Source and target Sandbox accounts are required.');
  }
  if (!Number.isSafeInteger(value.amountMinor) || value.amountMinor < 1) {
    throw new Error('Sandbox amount must be a positive number of minor currency units.');
  }
  if (!/^[A-Z]{3}$/.test(value.currency)) throw new Error('Currency must be a three-letter uppercase code.');
  if (typeof value.reference !== 'string' || value.reference.length < 1 || value.reference.length > 140) {
    throw new Error('Reference must contain 1 to 140 characters.');
  }
  if (typeof value.clientReference !== 'string' || value.clientReference.length < 1 ||
      value.clientReference.length > 80) {
    throw new Error('Client reference must contain 1 to 80 characters.');
  }
}

function backupStatus() {
  try {
    const candidates = readdirSync(env.SANDBOX_BACKUP_STATUS_PATH)
      .filter(name => name.endsWith('.sqlite3') || name.endsWith('.sqlite'))
      .map(name => statSync(join(env.SANDBOX_BACKUP_STATUS_PATH, name)).mtime)
      .sort((left, right) => right.getTime() - left.getTime());
    if (!candidates[0]) return { state: 'missing' as const };
    const ageMs = Date.now() - candidates[0].getTime();
    return {
      state: ageMs <= 8 * 24 * 60 * 60 * 1000 ? 'fresh' as const : 'stale' as const,
      latestAt: candidates[0].toISOString()
    };
  } catch {
    return { state: 'unavailable' as const };
  }
}
