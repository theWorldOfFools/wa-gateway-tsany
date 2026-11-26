import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import type {
  AnalysisAuthMode,
  AnalysisConfigRecord,
  AnalysisMode,
  AnalysisResultData,
  AnalysisSource,
  AnalysisStatus,
  MessageAnalysisRecord
} from '../domain.js';

interface AnalysisConfigRow {
  tenant_id: string;
  enabled: boolean;
  mode: AnalysisMode;
  endpoint: string | null;
  auth_mode: AnalysisAuthMode;
  secret: string | null;
  redact: boolean;
  max_chars: number;
  timeout_ms: number;
  created_at: Date;
  updated_at: Date;
}

interface AnalysisRow {
  id: string;
  tenant_id: string;
  session_id: string;
  message_id: string;
  source: AnalysisSource;
  status: AnalysisStatus;
  label: string | null;
  intent: string | null;
  score: number | null;
  keywords: string[] | null;
  summary: string | null;
  raw: unknown;
  error: string | null;
  duration_ms: number | null;
  analyzer_version: string | null;
  created_at: Date;
  updated_at: Date;
}

const mapConfig = (row: AnalysisConfigRow): AnalysisConfigRecord => ({
  tenantId: row.tenant_id,
  enabled: row.enabled,
  mode: row.mode,
  endpoint: row.endpoint,
  authMode: row.auth_mode,
  secret: row.secret,
  redact: row.redact,
  maxChars: row.max_chars,
  timeoutMs: row.timeout_ms,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const mapAnalysis = (row: AnalysisRow): MessageAnalysisRecord => {
  const result: AnalysisResultData | null =
    row.status === 'completed' && row.label !== null
      ? {
          label: row.label as AnalysisResultData['label'],
          intent: row.intent ?? 'other',
          score: row.score ?? 0,
          keywords: row.keywords ?? [],
          summary: row.summary ?? ''
        }
      : null;

  return {
    id: row.id,
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    messageId: row.message_id,
    source: row.source,
    status: row.status,
    result,
    raw: row.raw,
    error: row.error,
    durationMs: row.duration_ms,
    analyzerVersion: row.analyzer_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
};

export function defaultAnalysisConfig(
  tenantId: string,
  config: Config
): AnalysisConfigRecord {
  const now = new Date();
  return {
    tenantId,
    enabled: true,
    mode: 'internal',
    endpoint: null,
    authMode: 'signature',
    secret: null,
    redact: true,
    maxChars: config.ANALYSIS_MAX_TEXT_CHARS,
    timeoutMs: config.ANALYSIS_EXTERNAL_TIMEOUT_MS,
    createdAt: now,
    updatedAt: now
  };
}

export async function getAnalysisConfig(
  db: Db,
  tenantId: string,
  config: Config
): Promise<AnalysisConfigRecord> {
  const result = await db.query<AnalysisConfigRow>(
    'SELECT * FROM analysis_configs WHERE tenant_id = $1',
    [tenantId]
  );
  const row = result.rows[0];
  return row ? mapConfig(row) : defaultAnalysisConfig(tenantId, config);
}

export type AnalysisConfigPatch = Partial<
  Omit<AnalysisConfigRecord, 'tenantId' | 'createdAt' | 'updatedAt'>
>;

export async function upsertAnalysisConfig(
  db: Db,
  tenantId: string,
  config: Config,
  patch: AnalysisConfigPatch
): Promise<AnalysisConfigRecord> {
  const current = await getAnalysisConfig(db, tenantId, config);
  const next = { ...current, ...patch };

  const result = await db.query<AnalysisConfigRow>(
    `INSERT INTO analysis_configs (
       tenant_id, enabled, mode, endpoint, auth_mode, secret, redact,
       max_chars, timeout_ms
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (tenant_id) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       mode = EXCLUDED.mode,
       endpoint = EXCLUDED.endpoint,
       auth_mode = EXCLUDED.auth_mode,
       secret = EXCLUDED.secret,
       redact = EXCLUDED.redact,
       max_chars = EXCLUDED.max_chars,
       timeout_ms = EXCLUDED.timeout_ms,
       updated_at = now()
     RETURNING *`,
    [
      tenantId,
      next.enabled,
      next.mode,
      next.endpoint,
      next.authMode,
      next.secret,
      next.redact,
      next.maxChars,
      next.timeoutMs
    ]
  );

  const row = result.rows[0];
  if (!row) throw new Error('Failed to persist analysis configuration');
  return mapConfig(row);
}

export interface SaveAnalysisInput {
  tenantId: string;
  sessionId: string;
  messageId: string;
  source: AnalysisSource;
  status: AnalysisStatus;
  result?: AnalysisResultData | null;
  raw?: unknown;
  error?: string | null;
  durationMs?: number | null;
  analyzerVersion?: string | null;
}

export async function saveAnalysis(
  db: Db,
  input: SaveAnalysisInput
): Promise<MessageAnalysisRecord> {
  const result = input.result ?? null;
  const query = await db.query<AnalysisRow>(
    `INSERT INTO message_analysis (
       id, tenant_id, session_id, message_id, source, status, label,
       intent, score, keywords, summary, raw, error, duration_ms, analyzer_version
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12::jsonb,$13,$14,$15)
     ON CONFLICT (message_id, source) DO UPDATE SET
       status = EXCLUDED.status,
       label = EXCLUDED.label,
       intent = EXCLUDED.intent,
       score = EXCLUDED.score,
       keywords = EXCLUDED.keywords,
       summary = EXCLUDED.summary,
       raw = EXCLUDED.raw,
       error = EXCLUDED.error,
       duration_ms = EXCLUDED.duration_ms,
       analyzer_version = EXCLUDED.analyzer_version,
       updated_at = now()
     RETURNING *`,
    [
      randomUUID(),
      input.tenantId,
      input.sessionId,
      input.messageId,
      input.source,
      input.status,
      result?.label ?? null,
      result?.intent ?? null,
      result?.score ?? null,
      JSON.stringify(result?.keywords ?? []),
      result?.summary ?? null,
      input.raw === undefined ? null : JSON.stringify(input.raw),
      input.error ?? null,
      input.durationMs ?? null,
      input.analyzerVersion ?? null
    ]
  );

  const row = query.rows[0];
  if (!row) throw new Error('Failed to persist analysis result');
  return mapAnalysis(row);
}

export async function listAnalysisForMessage(
  db: Db,
  tenantId: string,
  messageId: string
): Promise<MessageAnalysisRecord[]> {
  const result = await db.query<AnalysisRow>(
    `SELECT * FROM message_analysis
     WHERE tenant_id = $1 AND message_id = $2
     ORDER BY created_at ASC`,
    [tenantId, messageId]
  );
  return result.rows.map(mapAnalysis);
}

export interface AnalysisFilter {
  from: Date;
  to: Date;
  sessionId?: string;
  source?: AnalysisSource;
  label?: string;
  limit: number;
}

export async function listAnalysis(
  db: Db,
  tenantId: string,
  filter: AnalysisFilter
): Promise<MessageAnalysisRecord[]> {
  const conditions = ['tenant_id = $1', 'created_at >= $2', 'created_at <= $3'];
  const values: unknown[] = [tenantId, filter.from, filter.to];

  if (filter.sessionId) {
    values.push(filter.sessionId);
    conditions.push(`session_id = $${values.length}`);
  }
  if (filter.source) {
    values.push(filter.source);
    conditions.push(`source = $${values.length}`);
  }
  if (filter.label) {
    values.push(filter.label);
    conditions.push(`label = $${values.length}`);
  }
  values.push(filter.limit);
  const limitParam = `$${values.length}`;

  const result = await db.query<AnalysisRow>(
    `SELECT * FROM message_analysis
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT ${limitParam}`,
    values
  );
  return result.rows.map(mapAnalysis);
}

export interface WebhookDeliveryInput {
  tenantId: string;
  sessionId: string;
  event: string;
  deliveryId: string;
  targetHost: string | null;
  attempt: number;
  statusCode: number | null;
  ok: boolean;
  durationMs: number;
  error: string | null;
}

export async function recordWebhookDelivery(
  db: Db,
  input: WebhookDeliveryInput
): Promise<void> {
  await db.query(
    `INSERT INTO webhook_deliveries (
       id, tenant_id, session_id, event, delivery_id, target_host,
       attempt, status_code, ok, duration_ms, error
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      randomUUID(),
      input.tenantId,
      input.sessionId,
      input.event,
      input.deliveryId,
      input.targetHost,
      input.attempt,
      input.statusCode,
      input.ok,
      input.durationMs,
      input.error
    ]
  );
}
