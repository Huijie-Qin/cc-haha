CREATE TABLE IF NOT EXISTS provider_configs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,
  base_url    TEXT,
  auth_token  TEXT,
  models      JSONB DEFAULT '[]',
  is_active   BOOLEAN DEFAULT false,
  created_at  TIMESTAMPTZ DEFAULT now()
);
