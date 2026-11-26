CREATE TABLE IF NOT EXISTS analysis_configs (
  tenant_id text PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  mode text NOT NULL DEFAULT 'internal' CHECK (mode IN ('internal', 'external', 'both')),
  endpoint text,
  auth_mode text NOT NULL DEFAULT 'signature' CHECK (auth_mode IN ('signature', 'bearer', 'none')),
  secret text,
  redact boolean NOT NULL DEFAULT true,
  max_chars integer NOT NULL DEFAULT 4096,
  timeout_ms integer NOT NULL DEFAULT 10000,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS message_analysis (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('internal', 'external')),
  status text NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  label text,
  intent text,
  score double precision,
  keywords jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary text,
  raw jsonb,
  error text,
  duration_ms integer,
  analyzer_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, source)
);

CREATE INDEX IF NOT EXISTS message_analysis_tenant_created_idx
  ON message_analysis (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS message_analysis_session_idx
  ON message_analysis (session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS message_analysis_label_idx
  ON message_analysis (tenant_id, label)
  WHERE label IS NOT NULL;

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  event text NOT NULL,
  delivery_id text NOT NULL,
  target_host text,
  attempt integer NOT NULL,
  status_code integer,
  ok boolean NOT NULL,
  duration_ms integer NOT NULL,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS webhook_deliveries_tenant_created_idx
  ON webhook_deliveries (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS webhook_deliveries_delivery_idx
  ON webhook_deliveries (delivery_id);

CREATE TABLE IF NOT EXISTS api_metrics_minute (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bucket timestamptz NOT NULL,
  route text NOT NULL,
  method text NOT NULL,
  status_class text NOT NULL,
  request_count integer NOT NULL DEFAULT 0,
  total_duration_ms bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, bucket, route, method, status_class)
);

CREATE INDEX IF NOT EXISTS api_metrics_minute_bucket_idx
  ON api_metrics_minute (bucket DESC);
