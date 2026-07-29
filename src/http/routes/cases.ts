import type { FastifyInstance } from 'fastify';
import type { BrokeredFundingCaseService } from '../../cases/case-service.js';
import type { BrokeredCase } from '../../cases/model.js';
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

interface SandboxWalkthroughBody {
  sourceAccountId?: string;
  amountMinor?: number;
  currency?: string;
  exponent?: number;
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
    const cases = service.list(limit);
    return principal.role === 'viewer'
      ? cases.map(redactCaseSummaryForViewer)
      : cases;
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

  app.post<{ Params: CaseParams; Body: SandboxWalkthroughBody }>(
    '/cases/:id/sandbox-walkthrough',
    async (request, reply) => {
      const principal = auth.require(request, reply, ['admin'], true);
      if (!principal) return;
      try {
        return await service.prepareSandboxWalkthrough(request.params.id, {
          sourceAccountId: request.body?.sourceAccountId ?? '',
          amountMinor: request.body?.amountMinor ?? 0,
          currency: request.body?.currency ?? '',
          ...(request.body?.exponent === undefined ? {} : { exponent: request.body.exponent })
        }, principal.username);
      } catch (error) {
        return reply.badRequest(publicMessage(error, 'Sandbox walkthrough could not be prepared.'));
      }
    }
  );

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
    // Evidence bundles include encrypted-package plaintext for auditable export.
    // Viewer access is deliberately limited to the redacted case summary route.
    const principal = auth.require(request, reply, ['admin']);
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

/**
 * A viewer is allowed a case-health summary only.  Do not spread `record` here:
 * it contains package contents' metadata, broker-entered facts, account and
 * counterparty identifiers, and the audit material reserved for administrators.
 */
function redactCaseForViewer(record: BrokeredCase) {
  return {
    id: record.id,
    caseStatus: record.caseStatus,
    fundingStatus: record.fundingStatus,
    executionStatus: record.executionStatus,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    submissions: record.submissions.map(submission => ({
      id: `submission-${submission.version}`,
      version: submission.version,
      format: submission.format,
      state: submission.state,
      scanner: submission.scanner,
      receivedAt: submission.receivedAt,
      completedAt: submission.completedAt
    })),
    artifacts: record.artifacts.map(artifact => ({
      path: '[redacted — administrator evidence view]',
      mediaType: artifact.mediaType,
      byteLength: artifact.byteLength,
      scanStatus: artifact.scanStatus
    })),
    riskFindings: record.riskFindings.map((finding, index) => {
      const isBrokerFinding = finding.code.startsWith('BROKER_');
      return {
        id: `finding-${index + 1}`,
        code: isBrokerFinding ? 'BROKER_REVIEW' : finding.code,
        severity: finding.severity,
        hardBlock: finding.hardBlock,
        createdAt: finding.createdAt,
        resolvedAt: finding.resolvedAt,
        message: isBrokerFinding
          ? 'A broker review requires administrator follow-up.'
          : finding.message,
        neededNext: isBrokerFinding
          ? 'Contact an administrator for the broker-review details.'
          : finding.neededNext
      };
    }),
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
    // Viewer access intentionally excludes provider/account data and the
    // broker-authored plan. Case and execution status above remain available.
    providerObservations: [],
    plans: record.plans.map(plan => ({
      version: plan.version,
      createdAt: plan.createdAt,
      status: plan.status,
      digest: '[redacted]'
    }))
  };
}

function redactCaseSummaryForViewer(record: ReturnType<BrokeredFundingCaseService['list']>[number]) {
  return {
    id: record.id,
    caseStatus: record.caseStatus,
    fundingStatus: record.fundingStatus,
    executionStatus: record.executionStatus,
    overallRisk: record.overallRisk,
    hardBlockCount: record.hardBlockCount,
    updatedAt: record.updatedAt,
    nextAction: 'Review this case status with an administrator.'
  };
}
