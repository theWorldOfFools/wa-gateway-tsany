import type { Db } from '../db/index.js';
import type {
  MessageDirection,
  MessageKind,
  MessageRecord,
  MessageStatus
} from '../domain.js';

interface MessageRow {
  id: string;
  tenant_id: string;
  session_id: string;
  direction: MessageDirection;
  kind: MessageKind;
  status: MessageStatus;
  remote_jid: string;
  sender_jid: string | null;
  is_group: boolean;
  content: string | null;
  payload: unknown;
  media_id: string | null;
  wa_message_id: string | null;
  error: string | null;
  idempotency_key: string | null;
  meta: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

const mapMessage = (row: MessageRow): MessageRecord => ({
  id: row.id,
  tenantId: row.tenant_id,
  sessionId: row.session_id,
  direction: row.direction,
  kind: row.kind,
  status: row.status,
  remoteJid: row.remote_jid,
  senderJid: row.sender_jid,
  isGroup: row.is_group,
  content: row.content,
  payload: row.payload,
  mediaId: row.media_id,
  waMessageId: row.wa_message_id,
  error: row.error,
  idempotencyKey: row.idempotency_key,
  meta: row.meta,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

export interface CreateMessageInput {
  id: string;
  tenantId: string;
  sessionId: string;
  direction: MessageDirection;
  kind: MessageKind;
  status: MessageStatus;
  remoteJid: string;
  senderJid?: string | null;
  isGroup?: boolean;
  content?: string | null;
  payload?: unknown;
  mediaId?: string | null;
  waMessageId?: string | null;
  idempotencyKey?: string | null;
  meta?: Record<string, unknown>;
}

export async function createMessage(
  db: Db,
  input: CreateMessageInput
): Promise<{ message: MessageRecord; inserted: boolean }> {
  const result = await db.query<MessageRow>(
    `INSERT INTO messages (
       id, tenant_id, session_id, direction, kind, status, remote_jid,
       sender_jid, is_group, content, payload, media_id, wa_message_id,
       idempotency_key, meta
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15::jsonb)
     ON CONFLICT (session_id, idempotency_key)
       WHERE idempotency_key IS NOT NULL
       DO NOTHING
     RETURNING *`,
    [
      input.id,
      input.tenantId,
      input.sessionId,
      input.direction,
      input.kind,
      input.status,
      input.remoteJid,
      input.senderJid ?? null,
      input.isGroup ?? false,
      input.content ?? null,
      input.payload === undefined ? null : JSON.stringify(input.payload),
      input.mediaId ?? null,
      input.waMessageId ?? null,
      input.idempotencyKey ?? null,
      JSON.stringify(input.meta ?? {})
    ]
  );

  const row = result.rows[0];
  if (row) return { message: mapMessage(row), inserted: true };

  if (!input.idempotencyKey) {
    throw new Error('Insert conflicted without an idempotency key');
  }
  const existing = await findByIdempotencyKey(
    db,
    input.sessionId,
    input.idempotencyKey
  );
  if (!existing) throw new Error('Insert conflicted but existing message was not found');
  return { message: existing, inserted: false };
}

export async function createInboundMessage(
  db: Db,
  input: CreateMessageInput
): Promise<MessageRecord | null> {
  const result = await db.query<MessageRow>(
    `INSERT INTO messages (
       id, tenant_id, session_id, direction, kind, status, remote_jid,
       sender_jid, is_group, content, payload, media_id, wa_message_id,
       idempotency_key, meta
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15::jsonb)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [
      input.id,
      input.tenantId,
      input.sessionId,
      input.direction,
      input.kind,
      input.status,
      input.remoteJid,
      input.senderJid ?? null,
      input.isGroup ?? false,
      input.content ?? null,
      input.payload === undefined ? null : JSON.stringify(input.payload),
      input.mediaId ?? null,
      input.waMessageId ?? null,
      input.idempotencyKey ?? null,
      JSON.stringify(input.meta ?? {})
    ]
  );
  const row = result.rows[0];
  return row ? mapMessage(row) : null;
}

export async function findByIdempotencyKey(
  db: Db,
  sessionId: string,
  key: string
): Promise<MessageRecord | null> {
  const result = await db.query<MessageRow>(
    'SELECT * FROM messages WHERE session_id = $1 AND idempotency_key = $2',
    [sessionId, key]
  );
  const row = result.rows[0];
  return row ? mapMessage(row) : null;
}

export async function findByWaMessageId(
  db: Db,
  sessionId: string,
  waMessageId: string
): Promise<MessageRecord | null> {
  const result = await db.query<MessageRow>(
    'SELECT * FROM messages WHERE session_id = $1 AND wa_message_id = $2 LIMIT 1',
    [sessionId, waMessageId]
  );
  const row = result.rows[0];
  return row ? mapMessage(row) : null;
}

export async function getMessage(
  db: Db,
  tenantId: string,
  id: string
): Promise<MessageRecord | null> {
  const result = await db.query<MessageRow>(
    'SELECT * FROM messages WHERE id = $1 AND tenant_id = $2',
    [id, tenantId]
  );
  const row = result.rows[0];
  return row ? mapMessage(row) : null;
}

export async function getMessageInternal(
  db: Db,
  id: string
): Promise<MessageRecord | null> {
  const result = await db.query<MessageRow>('SELECT * FROM messages WHERE id = $1', [id]);
  const row = result.rows[0];
  return row ? mapMessage(row) : null;
}

export interface MessageStatusPatch {
  status: MessageStatus;
  waMessageId?: string | null;
  error?: string | null;
  meta?: Record<string, unknown>;
}

export async function updateMessageStatus(
  db: Db,
  id: string,
  patch: MessageStatusPatch
): Promise<MessageRecord | null> {
  const result = await db.query<MessageRow>(
    `UPDATE messages
     SET status = $2,
         wa_message_id = COALESCE($3, wa_message_id),
         error = $4,
         meta = meta || $5::jsonb,
         updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [
      id,
      patch.status,
      patch.waMessageId ?? null,
      patch.error ?? null,
      JSON.stringify(patch.meta ?? {})
    ]
  );
  const row = result.rows[0];
  return row ? mapMessage(row) : null;
}

export async function updateMessageMeta(
  db: Db,
  id: string,
  meta: Record<string, unknown>
): Promise<void> {
  await db.query(
    'UPDATE messages SET meta = meta || $2::jsonb, updated_at = now() WHERE id = $1',
    [id, JSON.stringify(meta)]
  );
}

export async function updateStatusByWaMessageId(
  db: Db,
  sessionId: string,
  waMessageId: string,
  status: MessageStatus
): Promise<MessageRecord | null> {
  const result = await db.query<MessageRow>(
    `UPDATE messages
     SET status = $3, updated_at = now()
     WHERE session_id = $1 AND wa_message_id = $2 AND direction = 'out'
       AND status <> $3
       AND (
         CASE $3
           WHEN 'sent' THEN 2
           WHEN 'delivered' THEN 3
           WHEN 'read' THEN 4
           ELSE 0
         END
       ) > (
         CASE status
           WHEN 'sending' THEN 1
           WHEN 'sent' THEN 2
           WHEN 'delivered' THEN 3
           WHEN 'read' THEN 4
           ELSE 0
         END
       )
     RETURNING *`,
    [sessionId, waMessageId, status]
  );
  const row = result.rows[0];
  return row ? mapMessage(row) : null;
}

export interface ListMessagesFilters {
  direction?: MessageDirection;
  kind?: MessageKind;
  jid?: string;
  before?: Date;
  limit: number;
}

export async function listMessages(
  db: Db,
  tenantId: string,
  sessionId: string,
  filters: ListMessagesFilters
): Promise<MessageRecord[]> {
  const where: string[] = ['tenant_id = $1', 'session_id = $2'];
  const values: unknown[] = [tenantId, sessionId];

  const add = (clause: string, value: unknown): void => {
    values.push(value);
    where.push(clause.replace('?', `$${values.length}`));
  };

  if (filters.direction) add('direction = ?', filters.direction);
  if (filters.kind) add('kind = ?', filters.kind);
  if (filters.jid) add('remote_jid = ?', filters.jid);
  if (filters.before) add('created_at < ?', filters.before);

  values.push(filters.limit);
  const result = await db.query<MessageRow>(
    `SELECT * FROM messages
     WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC, id DESC
     LIMIT $${values.length}`,
    values
  );
  return result.rows.map(mapMessage);
}
