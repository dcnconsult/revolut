import type { FastifyInstance } from 'fastify';
import type { BrokeredFundingCaseService } from '../../cases/case-service.js';
import type { OperatorAuth } from '../../security/operator-auth.js';

interface CaseParams {
  id: string;
}

interface PlanParams extends CaseParams {
  version: string;
}

interface ReauthenticatedBody {
  password?: string;
  totp?: string;
  confirmation?: string;
}

export async function caseRoutes(
  app: FastifyInstance,
  service: BrokeredFundingCaseService,
  auth: OperatorAuth
) {
  app.post('/cases/submissions', async (request, reply) => {
    const principal = auth.require(request, reply, ['admin'], true);
    if (!principal) return;
    try {
      if (!request.isMultipart()) throw new Error('Submission must use multipart/form-data.');
      const part = await request.file();
      if (!part) throw new Error('A ZIP package is required.');
      if (!part.filename.toLowerCase().endsWith('.zip')) throw new Error('Submission filename must end in .zip.');
      const content = await part.toBuffer();
      const requestedId = stringHeader(request.headers['x-submission-id']);
      const result = service.submit(content, requestedId);
      auth.audit(principal.username, principal.role, 'case_submission', result.duplicate ? 'duplicate' : 'accepted', undefined, {
        caseId: result.case.id,
        packageSha256: result.case.submissions.at(-1)?.packageSha256
      });
      return reply.code(result.duplicate ? 200 : 202).send({
        caseId: result.case.id,
        submissionId: result.case.submissions.at(-1)?.id,
        caseStatus: result.case.caseStatus,
        duplicate: result.duplicate
      });
    } catch (error) {
      auth.audit(principal.username, principal.role, 'case_submission', 'denied');
      return reply.badRequest(publicMessage(error, 'Package intake failed.'));
    }
  });

  app.get<{ Querystring: { limit?: string } }>('/cases', async (request, reply) => {
    const principal = auth.require(request, reply, ['admin', 'viewer']);
    if (!principal) return;
    const limit = parseLimit(request.query.limit);
    if (!limit) return reply.badRequest('limit must be an integer between 1 and 500.');
    return service.list(limit);
  });

  app.get<{ Params: CaseParams }>('/cases/:id', async (request, reply) => {
    const principal = auth.require(request, reply, ['admin', 'viewer']);
    if (!principal) return;
    try {
      const record = service.get(request.params.id);
      return principal.role === 'viewer' ? redactCaseForViewer(record) : record;
    } catch (error) {
      return reply.notFound(publicMessage(error, 'Case not found.'));
    }
  });

  app.post<{ Params: CaseParams; Body: Parameters<BrokeredFundingCaseService['addAmendment']>[1] }>(
    '/cases/:id/amendments',
    async (request, reply) => {
      const principal = auth.require(request, reply, ['admin'], true);
      if (!principal) return;
      try {
        return reply.code(201).send(service.addAmendment(request.params.id, request.body, principal.username));
      } catch (error) {
        return reply.badRequest(publicMessage(error, 'Amendment could not be recorded.'));
      }
    }
  );

  app.post<{ Params: CaseParams; Body: Parameters<BrokeredFundingCaseService['addReview']>[1] }>(
    '/cases/:id/reviews',
    async (request, reply) => {
      const principal = auth.require(request, reply, ['admin'], true);
      if (!principal) return;
      try {
        return reply.code(201).send(service.addReview(request.params.id, request.body, principal.username));
      } catch (error) {
        return reply.badRequest(publicMessage(error, 'Review could not be recorded.'));
      }
    }
  );

  app.post<{ Params: CaseParams; Body: Parameters<BrokeredFundingCaseService['decide']>[1] }>(
    '/cases/:id/decisions',
    async (request, reply) => {
      const principal = auth.require(request, reply, ['admin'], true);
      if (!principal) return;
      try {
        return service.decide(request.params.id, request.body, principal.username);
      } catch (error) {
        return reply.badRequest(publicMessage(error, 'Decision could not be recorded.'));
      }
    }
  );

  app.post<{ Params: CaseParams; Body: { simulate?: boolean } }>(
    '/cases/:id/funding-observations/refresh',
    async (request, reply) => {
      const principal = auth.require(request, reply, ['admin'], true);
      if (!principal) return;
      try {
        return await service.refreshFunding(
          request.params.id,
          principal.username,
          request.body?.simulate === true
        );
      } catch (error) {
        return reply.badRequest(publicMessage(error, 'Funding observations could not be refreshed.'));
      }
    }
  );

  app.post<{ Params: CaseParams; Body: Parameters<BrokeredFundingCaseService['createPlan']>[1] }>(
    '/cases/:id/plans',
    async (request, reply) => {
      const principal = auth.require(request, reply, ['admin'], true);
      if (!principal) return;
      try {
        return reply.code(201).send(service.createPlan(request.params.id, request.body, principal.username));
      } catch (error) {
        return reply.badRequest(publicMessage(error, 'Funding plan could not be created.'));
      }
    }
  );

  app.post<{ Params: PlanParams; Body: ReauthenticatedBody }>(
    '/cases/:id/plans/:version/authorize',
    async (request, reply) => {
      const principal = auth.require(request, reply, ['admin'], true);
      if (!principal) return;
      try {
        const version = planVersion(request.params.version);
        const phrase = service.authorizationPhrase(request.params.id, version, 'AUTHORIZE');
        if (request.body?.confirmation !== phrase ||
            !auth.verifyAdminReauthentication(
              principal.username,
              request.body?.password ?? '',
              request.body?.totp ?? '',
              request.ip
            )) {
          auth.audit(principal.username, principal.role, 'case_plan_authorize', 'reauthentication_denied');
          return reply.code(403).send({ error: 'Password, fresh MFA, or plan confirmation phrase is incorrect.' });
        }
        return service.authorizePlan(request.params.id, version, principal.username);
      } catch (error) {
        return reply.badRequest(publicMessage(error, 'Funding plan could not be authorized.'));
      }
    }
  );

  app.post<{ Params: PlanParams; Body: ReauthenticatedBody }>(
    '/cases/:id/plans/:version/execute',
    async (request, reply) => {
      const principal = auth.require(request, reply, ['admin'], true);
      if (!principal) return;
      try {
        const version = planVersion(request.params.version);
        const phrase = service.authorizationPhrase(request.params.id, version, 'EXECUTE');
        if (request.body?.confirmation !== phrase ||
            !auth.verifyAdminReauthentication(
              principal.username,
              request.body?.password ?? '',
              request.body?.totp ?? '',
              request.ip
            )) {
          auth.audit(principal.username, principal.role, 'case_plan_execute', 'reauthentication_denied');
          return reply.code(403).send({ error: 'Password, fresh MFA, or plan confirmation phrase is incorrect.' });
        }
        return reply.code(202).send(await service.executePlan(
          request.params.id,
          version,
          principal.username
        ));
      } catch (error) {
        return reply.badRequest(publicMessage(error, 'Funding plan execution could not be queued.'));
      }
    }
  );

  app.post<{ Params: CaseParams }>('/cases/:id/reconcile', async (request, reply) => {
    const principal = auth.require(request, reply, ['admin'], true);
    if (!principal) return;
    try {
      return await service.reconcile(request.params.id, principal.username);
    } catch (error) {
      return reply.badRequest(publicMessage(error, 'Case reconciliation failed.'));
    }
  });

  app.get<{ Params: CaseParams }>('/cases/:id/evidence', async (request, reply) => {
    const principal = auth.require(request, reply, ['admin', 'viewer']);
    if (!principal) return;
    try {
      const bundle = service.evidenceBundle(request.params.id);
      return reply
        .header('content-type', 'application/vnd.brokered-funding-evidence+json')
        .header('content-disposition', `attachment; filename="case-${request.params.id}-evidence.json"`)
        .send(bundle);
    } catch (error) {
      return reply.badRequest(publicMessage(error, 'Evidence bundle could not be produced.'));
    }
  });
}

function planVersion(value: string) {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) throw new Error('Invalid funding-plan version.');
  return version;
}

function parseLimit(value: string | undefined) {
  const limit = Number(value ?? 100);
  return Number.isInteger(limit) && limit >= 1 && limit <= 500 ? limit : undefined;
}

function stringHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function publicMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function redactCaseForViewer(record: ReturnType<BrokeredFundingCaseService['get']>) {
  return {
    ...record,
    claims: record.claims.map(claim => ({
      ...claim,
      value: '[redacted — administrator evidence view]'
    })),
    fundingExpectation: record.fundingExpectation
      ? {
          amountMinor: record.fundingExpectation.amountMinor,
          currency: record.fundingExpectation.currency,
          exponent: record.fundingExpectation.exponent,
          reference: '[redacted]',
          destinationAccountId: '[redacted]',
          investorName: '[redacted]'
        }
      : undefined,
    providerObservations: record.providerObservations.map(observation => ({
      ...observation,
      accountId: '[redacted]',
      providerTransactionId: observation.providerTransactionId.slice(0, 8),
      reference: '[redacted]'
    }))
  };
}
