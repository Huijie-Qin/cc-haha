CREATE TABLE IF NOT EXISTS sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  user_id         UUID NOT NULL REFERENCES users(id),
  title           TEXT,
  work_dir        TEXT NOT NULL,
  model           TEXT,
  permission_mode TEXT DEFAULT 'default',
  container_id    TEXT,
  status          TEXT NOT NULL DEFAULT 'idle',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);
