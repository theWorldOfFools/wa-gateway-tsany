import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AnalysisSource } from '../../domain.js';
import { ApiError } from '../../errors.js';
import {
  getAnalysisConfig,
  listAnalysis,
  listAnalysisForMessage,
  upsertAnalysisConfig
} from '../../repos/analysis.js';
import { getMessage } from '../../repos/messages.js';
import { getSession } from '../../repos/sessions.js';
import { validateOutboundUrl } from '../../security/url.js';
import { resolveTimeRange } from '../../analytics/range.js';
import type { HttpDeps } from '../deps.js';
import { analysisConfigDto, analysisDto } from '../dto.js';
import { parseInput } from '../validation.js';

const IdParamsSchema = z.object({ id: z.string().min(1) });

const ConfigSchema = z.object({
  enabled: z.boolean().optional(),
  mode: z.enum(['internal', 'external', 'both']).optional(),
  endpoint: z.union([z.string().trim().url().max(2_048), z.null()]).optional(),
  authMode: z.enum(['signature', 'bearer', 'none']).optional(),
  secret: z.string().trim().min(1).max(512).optional(),
  rotateSecret: z.boolean().optional(),
  redact: z.boolean().optional(),
  maxChars: z.number().int().min(1).max(20_000).optional(),
  timeoutMs: z.number().int().min(500).max(60_000).optional()
});

const TextSchema = z.object({
  text: z.string().trim().min(1).max(20_000),
  source: z.enum(['internal', 'external']).optional(),
  sessionId: z.string().trim().min(1).optional()
});

const ListQuerySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  sessionId: z.string().trim().min(1).optional(),
  source: z.enum(['internal', 'external']).optional(),
  label: z.enum(['positive', 'negative', 'neutral']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

function requireAnalysis(deps: HttpDeps) {
  if (!deps.config.ANALYSIS_ENABLED || !deps.analysis) {
    throw new ApiError(
      410,
      'analysis_disabled',
      'Message analysis is temporarily disabled'
    );
  }
  return deps.analysis;
}

export function registerAnalysisRoutes(
  app: FastifyInstance,
  deps: HttpDeps
): void {
  app.get('/analysis/config', async (request) => {
    const config = await getAnalysisConfig(
      deps.db,
      request.tenant!.id,
      deps.config
    );
    return {
      config: analysisConfigDto({
        ...config,
        enabled: config.enabled && deps.config.ANALYSIS_ENABLED
      })
    };
  });

  app.put('/analysis/config', async (request) => {
    if (!deps.config.ANALYSIS_ENABLED) {
      throw new ApiError(
        410,
        'analysis_disabled',
        'Message analysis is temporarily disabled'
      );
    }

    const body = parseInput(ConfigSchema, request.body);
    const tenantId = request.tenant!.id;
    const current = await getAnalysisConfig(deps.db, tenantId, deps.config);

    const endpoint = body.endpoint === undefined ? current.endpoint : body.endpoint;
    const mode = body.mode ?? current.mode;
    const authMode = body.authMode ?? current.authMode;

    if (mode !== 'internal' && !endpoint) {
      throw ApiError.badRequest(
        'An analyzer endpoint is required when the mode is external or both'
      );
    }
    if (endpoint) {
      await validateOutboundUrl(endpoint, {
        allowPrivate: deps.config.ALLOW_PRIVATE_ANALYSIS_ENDPOINTS
      });
    }

    const revealSecret = Boolean(
      body.rotateSecret ||
        (body.secret && body.secret !== current.secret) ||
        (endpoint && authMode !== 'none' && !current.secret)
    );
    const secret = body.rotateSecret
      ? `ansec_${randomBytes(24).toString('base64url')}`
      : body.secret ?? current.secret;

    const updated = await upsertAnalysisConfig(deps.db, tenantId, deps.config, {
      enabled: body.enabled ?? current.enabled,
      mode,
      endpoint,
      authMode,
      secret,
      redact: body.redact ?? current.redact,
      maxChars: body.maxChars ?? current.maxChars,
      timeoutMs: body.timeoutMs ?? current.timeoutMs
    });

    return {
      config: analysisConfigDto(updated),
      secret: revealSecret && secret ? secret : undefined,
      warning: revealSecret && secret
        ? 'Store the analyzer secret securely. It is only returned when it is created or rotated.'
        : undefined
    };
  });

  app.post<{ Params: { id: string } }>(
    '/analysis/messages/:id',
    async (request, reply) => {
      requireAnalysis(deps);
      const { id } = parseInput(IdParamsSchema, request.params);
      const tenantId = request.tenant!.id;

      const message = await getMessage(deps.db, tenantId, id);
      if (!message) throw ApiError.notFound('Message not found');

      const config = await getAnalysisConfig(deps.db, tenantId, deps.config);
      if (!config.enabled) {
        throw new ApiError(410, 'analysis_disabled', 'Analysis is disabled for this tenant');
      }
      if (!deps.analysisQueue) {
        throw ApiError.serviceUnavailable(
          'analysis_unavailable',
          'Analysis worker is not available'
        );
      }

      await deps.analysisQueue.enqueue(message.id);
      return reply.code(202).send({
        messageId: message.id,
        status: 'queued'
      });
    }
  );

  app.post('/analysis/text', async (request) => {
    const service = requireAnalysis(deps);
    const body = parseInput(TextSchema, request.body);
    const tenantId = request.tenant!.id;

    if (body.sessionId) {
      const session = await getSession(deps.db, tenantId, body.sessionId);
      if (!session) throw ApiError.notFound('Session not found');
    }

    try {
      const result = await service.analyzeText(tenantId, body.text, {
        source: body.source,
        sessionId: body.sessionId
      });
      return result;
    } catch (error) {
      throw ApiError.badGateway(
        'analysis_failed',
        (error as Error).message
      );
    }
  });

  app.get<{ Params: { id: string } }>(
    '/analysis/messages/:id',
    async (request) => {
      const tenantId = request.tenant!.id;
      const { id } = parseInput(IdParamsSchema, request.params);
      const message = await getMessage(deps.db, tenantId, id);
      if (!message) throw ApiError.notFound('Message not found');

      const rows = await listAnalysisForMessage(deps.db, tenantId, id);
      return { data: rows.map(analysisDto) };
    }
  );

  app.get('/analysis', async (request) => {
    const query = parseInput(ListQuerySchema, request.query ?? {});
    const tenantId = request.tenant!.id;

    if (query.sessionId) {
      const session = await getSession(deps.db, tenantId, query.sessionId);
      if (!session) throw ApiError.notFound('Session not found');
    }

    const range = resolveTimeRange(query.from, query.to);
    const rows = await listAnalysis(deps.db, tenantId, {
      ...range,
      sessionId: query.sessionId,
      source: query.source as AnalysisSource | undefined,
      label: query.label,
      limit: query.limit
    });

    return { data: rows.map(analysisDto), hasMore: rows.length === query.limit };
  });
}
