import type { Db } from '../db/index.js';

export interface TimeRange {
  from: Date;
  to: Date;
}

function sessionCondition(
  sessionId: string | undefined,
  values: unknown[],
  column = 'session_id'
): string {
  if (!sessionId) return '';
  values.push(sessionId);
  return ` AND ${column} = $${values.length}`;
}

export async function getMessageStats(
  db: Db,
  tenantId: string,
  range: TimeRange,
  sessionId?: string
): Promise<{
  inbound: number;
  outbound: number;
  failed: number;
  delivered: number;
  total: number;
}> {
  const values: unknown[] = [tenantId, range.from, range.to];
  const condition = sessionCondition(sessionId, values);

  const result = await db.query<{
    inbound: string;
    outbound: string;
    failed: string;
    delivered: string;
  }>(
    `SELECT
       count(*) FILTER (WHERE direction = 'in')::text AS inbound,
       count(*) FILTER (WHERE direction = 'out')::text AS outbound,
       count(*) FILTER (WHERE status = 'failed')::text AS failed,
       count(*) FILTER (
         WHERE direction = 'out' AND status IN ('sent', 'delivered', 'read')
       )::text AS delivered
     FROM messages
     WHERE tenant_id = $1 AND created_at >= $2 AND created_at <= $3${condition}`,
    values
  );

  const row = result.rows[0];
  const inbound = Number(row?.inbound ?? 0);
  const outbound = Number(row?.outbound ?? 0);
  return {
    inbound,
    outbound,
    failed: Number(row?.failed ?? 0),
    delivered: Number(row?.delivered ?? 0),
    total: inbound + outbound
  };
}

export async function getTimeSeries(
  db: Db,
  tenantId: string,
  range: TimeRange,
  bucket: 'hour' | 'day',
  sessionId?: string
): Promise<Array<{ bucket: Date; inbound: number; outbound: number; failed: number }>> {
  const values: unknown[] = [tenantId, range.from, range.to];
  const condition = sessionCondition(sessionId, values);

  const result = await db.query<{
    bucket: Date;
    inbound: string;
    outbound: string;
    failed: string;
  }>(
    `SELECT
       date_trunc($4, created_at AT TIME ZONE 'UTC') AS bucket,
       count(*) FILTER (WHERE direction = 'in')::text AS inbound,
       count(*) FILTER (WHERE direction = 'out')::text AS outbound,
       count(*) FILTER (WHERE status = 'failed')::text AS failed
     FROM messages
     WHERE tenant_id = $1 AND created_at >= $2 AND created_at <= $3${condition}
     GROUP BY 1
     ORDER BY 1`,
    [...values, bucket]
  );

  return result.rows.map((row) => ({
    bucket: row.bucket,
    inbound: Number(row.inbound),
    outbound: Number(row.outbound),
    failed: Number(row.failed)
  }));
}

export async function getTopChats(
  db: Db,
  tenantId: string,
  range: TimeRange,
  sessionId: string | undefined,
  limit: number
): Promise<
  Array<{ jid: string; total: number; inbound: number; outbound: number }>
> {
  const values: unknown[] = [tenantId, range.from, range.to];
  const condition = sessionCondition(sessionId, values);
  values.push(limit);

  const result = await db.query<{
    jid: string;
    total: string;
    inbound: string;
    outbound: string;
  }>(
    `SELECT
       remote_jid AS jid,
       count(*)::text AS total,
       count(*) FILTER (WHERE direction = 'in')::text AS inbound,
       count(*) FILTER (WHERE direction = 'out')::text AS outbound
     FROM messages
     WHERE tenant_id = $1 AND created_at >= $2 AND created_at <= $3${condition}
     GROUP BY remote_jid
     ORDER BY count(*) DESC
     LIMIT $${values.length}`,
    values
  );

  return result.rows.map((row) => ({
    jid: row.jid,
    total: Number(row.total),
    inbound: Number(row.inbound),
    outbound: Number(row.outbound)
  }));
}

export async function getWebhookStats(
  db: Db,
  tenantId: string,
  range: TimeRange
): Promise<{
  attempts: number;
  successful: number;
  failed: number;
  successRate: number;
  avgDurationMs: number;
  byEvent: Array<{ event: string; attempts: number; successful: number }>;
  recentFailures: Array<{
    event: string;
    statusCode: number | null;
    error: string | null;
    createdAt: Date;
  }>;
}> {
  const [totals, byEvent, failures] = await Promise.all([
    db.query<{
      attempts: string;
      successful: string;
      avg_duration: string | null;
    }>(
      `SELECT
         count(*)::text AS attempts,
         count(*) FILTER (WHERE ok)::text AS successful,
         avg(duration_ms)::text AS avg_duration
       FROM webhook_deliveries
       WHERE tenant_id = $1 AND created_at >= $2 AND created_at <= $3`,
      [tenantId, range.from, range.to]
    ),
    db.query<{ event: string; attempts: string; successful: string }>(
      `SELECT
         event,
         count(*)::text AS attempts,
         count(*) FILTER (WHERE ok)::text AS successful
       FROM webhook_deliveries
       WHERE tenant_id = $1 AND created_at >= $2 AND created_at <= $3
       GROUP BY event
       ORDER BY count(*) DESC`,
      [tenantId, range.from, range.to]
    ),
    db.query<{
      event: string;
      status_code: number | null;
      error: string | null;
      created_at: Date;
    }>(
      `SELECT event, status_code, error, created_at
       FROM webhook_deliveries
       WHERE tenant_id = $1 AND created_at >= $2 AND created_at <= $3 AND NOT ok
       ORDER BY created_at DESC
       LIMIT 10`,
      [tenantId, range.from, range.to]
    )
  ]);

  const row = totals.rows[0];
  const attempts = Number(row?.attempts ?? 0);
  const successful = Number(row?.successful ?? 0);

  return {
    attempts,
    successful,
    failed: attempts - successful,
    successRate: attempts === 0 ? 0 : successful / attempts,
    avgDurationMs: Math.round(Number(row?.avg_duration ?? 0)),
    byEvent: byEvent.rows.map((item) => ({
      event: item.event,
      attempts: Number(item.attempts),
      successful: Number(item.successful)
    })),
    recentFailures: failures.rows.map((item) => ({
      event: item.event,
      statusCode: item.status_code,
      error: item.error,
      createdAt: item.created_at
    }))
  };
}

export async function getApiStats(
  db: Db,
  tenantId: string,
  range: TimeRange
): Promise<{
  requests: number;
  errorRate: number;
  avgDurationMs: number;
  byRoute: Array<{
    route: string;
    method: string;
    requests: number;
    avgDurationMs: number;
    errors: number;
  }>;
}> {
  const [totals, byRoute] = await Promise.all([
    db.query<{ requests: string; errors: string; avg_duration: string | null }>(
      `SELECT
         coalesce(sum(request_count), 0)::text AS requests,
         coalesce(sum(request_count) FILTER (WHERE status_class >= '4'), 0)::text AS errors,
         CASE WHEN coalesce(sum(request_count), 0) = 0 THEN '0'
              ELSE (sum(total_duration_ms) / sum(request_count))::text END AS avg_duration
       FROM api_metrics_minute
       WHERE tenant_id = $1 AND bucket >= $2 AND bucket <= $3`,
      [tenantId, range.from, range.to]
    ),
    db.query<{
      route: string;
      method: string;
      requests: string;
      avg_duration: string;
      errors: string;
    }>(
      `SELECT
         route,
         method,
         sum(request_count)::text AS requests,
         (sum(total_duration_ms) / sum(request_count))::text AS avg_duration,
         coalesce(sum(request_count) FILTER (WHERE status_class >= '4'), 0)::text AS errors
       FROM api_metrics_minute
       WHERE tenant_id = $1 AND bucket >= $2 AND bucket <= $3
       GROUP BY route, method
       ORDER BY sum(request_count) DESC
       LIMIT 20`,
      [tenantId, range.from, range.to]
    )
  ]);

  const row = totals.rows[0];
  const requests = Number(row?.requests ?? 0);
  return {
    requests,
    errorRate: requests === 0 ? 0 : Number(row?.errors ?? 0) / requests,
    avgDurationMs: Math.round(Number(row?.avg_duration ?? 0)),
    byRoute: byRoute.rows.map((item) => ({
      route: item.route,
      method: item.method,
      requests: Number(item.requests),
      avgDurationMs: Math.round(Number(item.avg_duration)),
      errors: Number(item.errors)
    }))
  };
}

export async function getAnalysisStats(
  db: Db,
  tenantId: string,
  range: TimeRange
): Promise<{
  total: number;
  completed: number;
  failed: number;
  avgDurationMs: number;
  byLabel: Array<{ label: string; count: number }>;
  byIntent: Array<{ intent: string; count: number }>;
  bySource: Array<{ source: string; count: number }>;
}> {
  const [totals, labels, intents, sources] = await Promise.all([
    db.query<{
      total: string;
      completed: string;
      failed: string;
      avg_duration: string | null;
    }>(
      `SELECT
         count(*)::text AS total,
         count(*) FILTER (WHERE status = 'completed')::text AS completed,
         count(*) FILTER (WHERE status = 'failed')::text AS failed,
         avg(duration_ms)::text AS avg_duration
       FROM message_analysis
       WHERE tenant_id = $1 AND created_at >= $2 AND created_at <= $3`,
      [tenantId, range.from, range.to]
    ),
    db.query<{ label: string; count: string }>(
      `SELECT label, count(*)::text AS count
       FROM message_analysis
       WHERE tenant_id = $1 AND created_at >= $2 AND created_at <= $3 AND label IS NOT NULL
       GROUP BY label ORDER BY count(*) DESC`,
      [tenantId, range.from, range.to]
    ),
    db.query<{ intent: string; count: string }>(
      `SELECT intent, count(*)::text AS count
       FROM message_analysis
       WHERE tenant_id = $1 AND created_at >= $2 AND created_at <= $3 AND intent IS NOT NULL
       GROUP BY intent ORDER BY count(*) DESC LIMIT 20`,
      [tenantId, range.from, range.to]
    ),
    db.query<{ source: string; count: string }>(
      `SELECT source, count(*)::text AS count
       FROM message_analysis
       WHERE tenant_id = $1 AND created_at >= $2 AND created_at <= $3
       GROUP BY source ORDER BY count(*) DESC`,
      [tenantId, range.from, range.to]
    )
  ]);

  const row = totals.rows[0];
  return {
    total: Number(row?.total ?? 0),
    completed: Number(row?.completed ?? 0),
    failed: Number(row?.failed ?? 0),
    avgDurationMs: Math.round(Number(row?.avg_duration ?? 0)),
    byLabel: labels.rows.map((item) => ({
      label: item.label,
      count: Number(item.count)
    })),
    byIntent: intents.rows.map((item) => ({
      intent: item.intent,
      count: Number(item.count)
    })),
    bySource: sources.rows.map((item) => ({
      source: item.source,
      count: Number(item.count)
    }))
  };
}
