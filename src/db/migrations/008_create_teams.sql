CREATE TABLE IF NOT EXISTS teams (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  name            TEXT NOT NULL,
  description     TEXT,
  lead_agent_id   TEXT,
  lead_session_id UUID REFERENCES sessions(id),
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, name)
);

CREATE TABLE IF NOT EXISTS team_members (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id     UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  agent_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  agent_type  TEXT,
  model       TEXT,
  color       TEXT,
  status      TEXT NOT NULL DEFAULT 'idle',
  session_id  UUID REFERENCES sessions(id),
  joined_at   TIMESTAMPTZ DEFAULT now()
);
