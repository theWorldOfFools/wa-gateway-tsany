import type { Db } from '../db/index.js';
import type { DashboardSession, Tenant, User } from '../domain.js';

interface DashboardSessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: Date;
  expires_at: Date;
  last_seen_at: Date;
  user_agent: string | null;
  ip: string | null;
}

interface DashboardAuthRow extends DashboardSessionRow {
  user_email: string;
  user_name: string | null;
  user_password_hash: string;
  user_created_at: Date;
  user_updated_at: Date;
  user_last_login_at: Date | null;
  tenant_id: string;
  tenant_name: string;
  tenant_created_at: Date;
}

const mapSession = (row: DashboardSessionRow): DashboardSession => ({
  id: row.id,
  userId: row.user_id,
  tokenHash: row.token_hash,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  lastSeenAt: row.last_seen_at,
  userAgent: row.user_agent,
  ip: row.ip
});

export interface DashboardAuthRecord {
  session: DashboardSession;
  user: User;
  tenant: Tenant;
}

export interface CreateDashboardSessionInput {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  userAgent?: string | null;
  ip?: string | null;
}

export async function createDashboardSession(
  db: Db,
  input: CreateDashboardSessionInput
): Promise<DashboardSession> {
  const result = await db.query<DashboardSessionRow>(
    `INSERT INTO dashboard_sessions
       (id, user_id, token_hash, expires_at, user_agent, ip)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      input.id,
      input.userId,
      input.tokenHash,
      input.expiresAt,
      input.userAgent ?? null,
      input.ip ?? null
    ]
  );
  const row = result.rows[0];
  if (!row) throw new Error('Failed to create dashboard session');
  return mapSession(row);
}

export async function findDashboardAuthByTokenHash(
  db: Db,
  tokenHash: string
): Promise<DashboardAuthRecord | null> {
  const result = await db.query<DashboardAuthRow>(
    `SELECT
       ds.*,
       u.email AS user_email,
       u.name AS user_name,
       u.password_hash AS user_password_hash,
       u.created_at AS user_created_at,
       u.updated_at AS user_updated_at,
       u.last_login_at AS user_last_login_at,
       t.id AS tenant_id,
       t.name AS tenant_name,
       t.created_at AS tenant_created_at
     FROM dashboard_sessions ds
     JOIN users u ON u.id = ds.user_id
     JOIN tenants t ON t.id = u.tenant_id
     WHERE ds.token_hash = $1 AND ds.expires_at > now()
     LIMIT 1`,
    [tokenHash]
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    session: mapSession(row),
    user: {
      id: row.user_id,
      tenantId: row.tenant_id,
      email: row.user_email,
      name: row.user_name,
      passwordHash: row.user_password_hash,
      createdAt: row.user_created_at,
      updatedAt: row.user_updated_at,
      lastLoginAt: row.user_last_login_at
    },
    tenant: {
      id: row.tenant_id,
      name: row.tenant_name,
      createdAt: row.tenant_created_at
    }
  };
}

export async function deleteDashboardSessionByTokenHash(
  db: Db,
  tokenHash: string
): Promise<void> {
  await db.query('DELETE FROM dashboard_sessions WHERE token_hash = $1', [tokenHash]);
}

export async function deleteOtherDashboardSessions(
  db: Db,
  userId: string,
  keepSessionId: string
): Promise<void> {
  await db.query(
    'DELETE FROM dashboard_sessions WHERE user_id = $1 AND id <> $2',
    [userId, keepSessionId]
  );
}

export async function deleteExpiredDashboardSessions(db: Db): Promise<void> {
  await db.query('DELETE FROM dashboard_sessions WHERE expires_at < now()');
}

export async function touchDashboardSession(
  db: Db,
  sessionId: string
): Promise<void> {
  await db.query(
    `UPDATE dashboard_sessions
     SET last_seen_at = now()
     WHERE id = $1
       AND last_seen_at < now() - interval '5 minutes'`,
    [sessionId]
  );
}
