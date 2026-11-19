CREATE TABLE IF NOT EXISTS tenants (
  id text PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  key_prefix text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL DEFAULT ARRAY['*']::text[],
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS api_keys_tenant_idx ON api_keys (tenant_id);

CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  phone_number text,
  jid text,
  qr text,
  qr_updated_at timestamptz,
  webhook_url text,
  webhook_secret text,
  webhook_events text[] NOT NULL DEFAULT '{}'::text[],
  interactive_fallback boolean NOT NULL DEFAULT true,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sessions_tenant_idx ON sessions (tenant_id);

CREATE TABLE IF NOT EXISTS media (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id text REFERENCES sessions(id) ON DELETE SET NULL,
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  mime_type text NOT NULL,
  file_name text,
  file_path text NOT NULL,
  size_bytes bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS media_tenant_idx ON media (tenant_id);
CREATE INDEX IF NOT EXISTS media_session_idx ON media (session_id);

CREATE TABLE IF NOT EXISTS messages (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  kind text NOT NULL,
  status text NOT NULL,
  remote_jid text NOT NULL,
  sender_jid text,
  is_group boolean NOT NULL DEFAULT false,
  content text,
  payload jsonb,
  media_id text REFERENCES media(id) ON DELETE SET NULL,
  wa_message_id text,
  error text,
  idempotency_key text,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS messages_idempotency_uidx
  ON messages (session_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS messages_session_created_idx
  ON messages (session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS messages_tenant_created_idx
  ON messages (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS messages_wa_id_idx
  ON messages (session_id, wa_message_id);

CREATE UNIQUE INDEX IF NOT EXISTS messages_wa_message_uidx
  ON messages (session_id, wa_message_id)
  WHERE wa_message_id IS NOT NULL;
