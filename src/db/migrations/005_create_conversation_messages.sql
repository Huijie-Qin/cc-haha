CREATE TABLE IF NOT EXISTS conversation_messages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id        UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  tenant_id         UUID NOT NULL REFERENCES tenants(id),
  role              TEXT NOT NULL,
  content           JSONB NOT NULL,
  model             TEXT,
  parent_tool_use_id TEXT,
  created_at        TIMESTAMPTZ DEFAULT now()
);
