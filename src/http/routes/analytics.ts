import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveTimeRange } from '../../analytics/range.js';
import { ApiError } from '../../errors.js';
import {
  getAnalysisStats,
  getApiStats,
  getMessageStats,
  getTimeSeries,
  getTopChats,
  getWebhookStats
} from '../../repos/analytics.js';
import { getSession } from '../../repos/sessions.js';
import type { HttpDeps } from '../deps.js';
import { parseInput } from '../validation.js';

const QuerySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  sessionId: z.string().trim().min(1).optional(),
  bucket: z.enum(['hour', 'day']).default('day')
});

const LimitQuerySchema = QuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(50).default(10)
});

async function resolveSession(
  deps: HttpDeps,
  tenantId: string,
  sessionId: string | undefined
): Promise<void> {
  if (!sessionId) return;
  const session = await getSession(deps.db, tenantId, sessionId);
  if (!session) throw ApiError.notFound('Session not found');
}

export function registerAnalyticsRoutes(
  app: FastifyInstance,
  deps: HttpDeps
): void {
  app.get('/analytics/summary', async (request) => {
    const query = parseInput(QuerySchema, request.query ?? {});
    const tenantId = request.tenant!.id;
    await resolveSession(deps, tenantId, query.sessionId);
    const range = resolveTimeRange(query.from, query.to);
    const stats = await getMessageStats(deps.db, tenantId, range, query.sessionId);
    const analysis = await getAnalysisStats(deps.db, tenantId, range);

    return {
      ...stats,
      deliveryRate: stats.outbound === 0 ? 0 : stats.delivered / stats.outbound,
      analysis
    };
  });

  app.get('/analytics/timeseries', async (request) => {
    const query = parseInput(QuerySchema, request.query ?? {});
    const tenantId = request.tenant!.id;
    await resolveSession(deps, tenantId, query.sessionId);
    const range = resolveTimeRange(query.from, query.to);
    const rows = await getTimeSeries(
      deps.db,
      tenantId,
      range,
      query.bucket,
      query.sessionId
    );
    return { data: rows };
  });

  app.get('/analytics/top-chats', async (request) => {
    const query = parseInput(LimitQuerySchema, request.query ?? {});
    const tenantId = request.tenant!.id;
    await resolveSession(deps, tenantId, query.sessionId);
    const range = resolveTimeRange(query.from, query.to);
    const rows = await getTopChats(
      deps.db,
      tenantId,
      range,
      query.sessionId,
      query.limit
    );
    return { data: rows };
  });

  app.get('/analytics/webhook', async (request) => {
    const query = parseInput(QuerySchema, request.query ?? {});
    const range = resolveTimeRange(query.from, query.to);
    return getWebhookStats(deps.db, request.tenant!.id, range);
  });

  app.get('/analytics/api', async (request) => {
    const query = parseInput(QuerySchema, request.query ?? {});
    const range = resolveTimeRange(query.from, query.to);
    return getApiStats(deps.db, request.tenant!.id, range);
  });
}
