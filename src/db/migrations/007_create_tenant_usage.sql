CREATE TABLE IF NOT EXISTS tenant_usage (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  date            DATE NOT NULL,
  input_tokens    BIGINT DEFAULT 0,
  output_tokens   BIGINT DEFAULT 0,
  request_count   INT DEFAULT 0,
  UNIQUE(tenant_id, date)
);
