import type { Db } from '../db/index.js';
import type { SessionStatus, WaSession } from '../domain.js';

interface SessionRow {
  id: string;
  tenant_id: string;
  name: string;
  status: SessionStatus;
  phone_number: string | null;
  jid: string | null;
  qr: string | null;
  qr_updated_at: Date | null;
  webhook_url: string | null;
  webhook_secret: string | null;
  webhook_events: string[];
  interactive_fallback: boolean;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

const mapSession = (row: SessionRow): WaSession => ({
  id: row.id,
  tenantId: row.tenant_id,
  name: row.name,
  status: row.status,
  phoneNumber: row.phone_number,
  jid: row.jid,
  qr: row.qr,
  qrUpdatedAt: row.qr_updated_at,
  webhookUrl: row.webhook_url,
  webhookSecret: row.webhook_secret,
  webhookEvents: row.webhook_events,
  interactiveFallback: row.interactive_fallback,
  lastError: row.last_error,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

export async function createSession(
  db: Db,
  id: string,
  tenantId: string,
  name: string
): Promise<WaSession> {
  const result = await db.query<SessionRow>(
    `INSERT INTO sessions (id, tenant_id, name)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [id, tenantId, name]
  );
  const row = result.rows[0];
  if (!row) throw new Error('Failed to create session');
  return mapSession(row);
}

export async function getSession(
  db: Db,
  tenantId: string,
  id: string
): Promise<WaSession | null> {
  const result = await db.query<SessionRow>(
    'SELECT * FROM sessions WHERE id = $1 AND tenant_id = $2',
    [id, tenantId]
  );
  const row = result.rows[0];
  return row ? mapSession(row) : null;
}

export async function getSessionById(db: Db, id: string): Promise<WaSession | null> {
  const result = await db.query<SessionRow>('SELECT * FROM sessions WHERE id = $1', [id]);
  const row = result.rows[0];
  return row ? mapSession(row) : null;
}

export async function listSessions(db: Db, tenantId: string): Promise<WaSession[]> {
  const result = await db.query<SessionRow>(
    `SELECT * FROM sessions
     WHERE tenant_id = $1
     ORDER BY created_at DESC`,
    [tenantId]
  );
  return result.rows.map(mapSession);
}

export async function listAllSessions(db: Db): Promise<WaSession[]> {
  const result = await db.query<SessionRow>('SELECT * FROM sessions ORDER BY created_at ASC');
  return result.rows.map(mapSession);
}

export interface SessionStatePatch {
  status?: SessionStatus;
  phoneNumber?: string | null;
  jid?: string | null;
  qr?: string | null;
  qrUpdatedAt?: Date | null;
  lastError?: string | null;
}

export async function updateSessionState(
  db: Db,
  id: string,
  patch: SessionStatePatch
): Promise<void> {
  const assignments: string[] = ['updated_at = now()'];
  const values: unknown[] = [];

  const add = (column: string, value: unknown): void => {
    values.push(value);
    assignments.push(`${column} = $${values.length}`);
  };

  if (patch.status !== undefined) add('status', patch.status);
  if (patch.phoneNumber !== undefined) add('phone_number', patch.phoneNumber);
  if (patch.jid !== undefined) add('jid', patch.jid);
  if (patch.qr !== undefined) add('qr', patch.qr);
  if (patch.qrUpdatedAt !== undefined) add('qr_updated_at', patch.qrUpdatedAt);
  if (patch.lastError !== undefined) add('last_error', patch.lastError);

  if (values.length === 0) return;

  values.push(id);
  await db.query(
    `UPDATE sessions SET ${assignments.join(', ')} WHERE id = $${values.length}`,
    values
  );
}

export interface WebhookPatch {
  url: string | null;
  secret: string | null;
  events: string[];
  interactiveFallback: boolean;
}

export async function updateSessionWebhook(
  db: Db,
  id: string,
  patch: WebhookPatch
): Promise<void> {
  await db.query(
    `UPDATE sessions
     SET webhook_url = $2,
         webhook_secret = $3,
         webhook_events = $4,
         interactive_fallback = $5,
         updated_at = now()
     WHERE id = $1`,
    [id, patch.url, patch.secret, patch.events, patch.interactiveFallback]
  );
}

export async function countSessionsForTenant(db: Db, tenantId: string): Promise<number> {
  const result = await db.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM sessions WHERE tenant_id = $1',
    [tenantId]
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function countAllSessions(db: Db): Promise<number> {
  const result = await db.query<{ count: string }>('SELECT count(*)::text AS count FROM sessions');
  return Number(result.rows[0]?.count ?? 0);
}

export async function deleteSession(
  db: Db,
  tenantId: string,
  id: string
): Promise<boolean> {
  const result = await db.query(
    'DELETE FROM sessions WHERE id = $1 AND tenant_id = $2',
    [id, tenantId]
  );
  return (result.rowCount ?? 0) > 0;
}
