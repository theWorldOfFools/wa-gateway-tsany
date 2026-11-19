import type { Db } from '../db/index.js';
import type { ApiKeyRecord } from '../domain.js';

interface ApiKeyRow {
  id: string;
  tenant_id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  scopes: string[];
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

const mapApiKey = (row: ApiKeyRow): ApiKeyRecord => ({
  id: row.id,
  tenantId: row.tenant_id,
  name: row.name,
  keyPrefix: row.key_prefix,
  keyHash: row.key_hash,
  scopes: row.scopes,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
  revokedAt: row.revoked_at
});

export interface CreateApiKeyInput {
  id: string;
  tenantId: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  scopes?: string[];
}

export async function createApiKey(db: Db, input: CreateApiKeyInput): Promise<ApiKeyRecord> {
  const result = await db.query<ApiKeyRow>(
    `INSERT INTO api_keys (id, tenant_id, name, key_prefix, key_hash, scopes)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      input.id,
      input.tenantId,
      input.name,
      input.keyPrefix,
      input.keyHash,
      input.scopes ?? ['*']
    ]
  );
  const row = result.rows[0];
  if (!row) throw new Error('Failed to create API key');
  return mapApiKey(row);
}

export async function findActiveApiKeyByHash(
  db: Db,
  keyHash: string
): Promise<ApiKeyRecord | null> {
  const result = await db.query<ApiKeyRow>(
    `SELECT * FROM api_keys
     WHERE key_hash = $1 AND revoked_at IS NULL
     LIMIT 1`,
    [keyHash]
  );
  const row = result.rows[0];
  return row ? mapApiKey(row) : null;
}

export async function listApiKeys(db: Db, tenantId: string): Promise<ApiKeyRecord[]> {
  const result = await db.query<ApiKeyRow>(
    `SELECT * FROM api_keys
     WHERE tenant_id = $1
     ORDER BY created_at DESC`,
    [tenantId]
  );
  return result.rows.map(mapApiKey);
}

export async function revokeApiKey(
  db: Db,
  tenantId: string,
  id: string
): Promise<boolean> {
  const result = await db.query(
    `UPDATE api_keys
     SET revoked_at = now()
     WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL`,
    [id, tenantId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function countActiveApiKeys(db: Db, tenantId: string): Promise<number> {
  const result = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM api_keys
     WHERE tenant_id = $1 AND revoked_at IS NULL`,
    [tenantId]
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function touchApiKey(db: Db, id: string): Promise<void> {
  await db.query(
    `UPDATE api_keys
     SET last_used_at = now()
     WHERE id = $1
       AND (last_used_at IS NULL OR last_used_at < now() - interval '5 minutes')`,
    [id]
  );
}
