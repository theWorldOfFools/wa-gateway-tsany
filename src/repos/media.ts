import type { Db } from '../db/index.js';
import type { MediaRecord, MessageDirection } from '../domain.js';

interface MediaRow {
  id: string;
  tenant_id: string;
  session_id: string | null;
  direction: MessageDirection;
  mime_type: string;
  file_name: string | null;
  file_path: string;
  size_bytes: string | number;
  created_at: Date;
}

const mapMedia = (row: MediaRow): MediaRecord => ({
  id: row.id,
  tenantId: row.tenant_id,
  sessionId: row.session_id,
  direction: row.direction,
  mimeType: row.mime_type,
  fileName: row.file_name,
  filePath: row.file_path,
  sizeBytes: Number(row.size_bytes),
  createdAt: row.created_at
});

export interface CreateMediaInput {
  id: string;
  tenantId: string;
  sessionId: string | null;
  direction: MessageDirection;
  mimeType: string;
  fileName?: string | null;
  filePath: string;
  sizeBytes: number;
}

export async function createMedia(db: Db, input: CreateMediaInput): Promise<MediaRecord> {
  const result = await db.query<MediaRow>(
    `INSERT INTO media (
       id, tenant_id, session_id, direction, mime_type, file_name, file_path, size_bytes
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      input.id,
      input.tenantId,
      input.sessionId,
      input.direction,
      input.mimeType,
      input.fileName ?? null,
      input.filePath,
      input.sizeBytes
    ]
  );
  const row = result.rows[0];
  if (!row) throw new Error('Failed to create media record');
  return mapMedia(row);
}

export async function getMedia(
  db: Db,
  tenantId: string,
  id: string
): Promise<MediaRecord | null> {
  const result = await db.query<MediaRow>(
    'SELECT * FROM media WHERE id = $1 AND tenant_id = $2',
    [id, tenantId]
  );
  const row = result.rows[0];
  return row ? mapMedia(row) : null;
}

export async function listMediaForSession(
  db: Db,
  tenantId: string,
  sessionId: string
): Promise<MediaRecord[]> {
  const result = await db.query<MediaRow>(
    'SELECT * FROM media WHERE tenant_id = $1 AND session_id = $2',
    [tenantId, sessionId]
  );
  return result.rows.map(mapMedia);
}

export async function deleteMediaForSession(
  db: Db,
  tenantId: string,
  sessionId: string
): Promise<MediaRecord[]> {
  const result = await db.query<MediaRow>(
    `DELETE FROM media
     WHERE tenant_id = $1 AND session_id = $2
     RETURNING *`,
    [tenantId, sessionId]
  );
  return result.rows.map(mapMedia);
}

export async function listExpiredMedia(
  db: Db,
  retentionDays: number,
  limit = 500
): Promise<MediaRecord[]> {
  const result = await db.query<MediaRow>(
    `SELECT * FROM media
     WHERE created_at < now() - ($1::int * interval '1 day')
     ORDER BY created_at ASC
     LIMIT $2`,
    [retentionDays, limit]
  );
  return result.rows.map(mapMedia);
}

export async function deleteMediaByIds(db: Db, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.query('DELETE FROM media WHERE id = ANY($1::text[])', [ids]);
}
