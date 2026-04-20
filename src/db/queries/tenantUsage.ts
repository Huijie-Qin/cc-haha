import { getDbClient } from '../client.js'

export type TenantUsage = {
  id: string
  tenant_id: string
  date: Date
  input_tokens: number
  output_tokens: number
  request_count: number
}

export type UpsertDailyUsageInput = {
  tenantId: string
  date: string
  inputTokens: number
  outputTokens: number
  requestCount: number
}

export type DateRange = {
  from: string
  to: string
}

export async function upsertDailyUsage(input: UpsertDailyUsageInput): Promise<TenantUsage> {
  const db = getDbClient()
  const { rows } = await db.query(
    `INSERT INTO tenant_usage (tenant_id, date, input_tokens, output_tokens, request_count)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, date) DO UPDATE SET
       input_tokens = tenant_usage.input_tokens + EXCLUDED.input_tokens,
       output_tokens = tenant_usage.output_tokens + EXCLUDED.output_tokens,
       request_count = tenant_usage.request_count + EXCLUDED.request_count
     RETURNING *`,
    [input.tenantId, input.date, input.inputTokens, input.outputTokens, input.requestCount]
  )
  return rows[0]
}

export async function getUsage(tenantId: string, dateRange?: DateRange): Promise<TenantUsage[]> {
  const db = getDbClient()

  if (dateRange) {
    const { rows } = await db.query(
      'SELECT * FROM tenant_usage WHERE tenant_id = $1 AND date >= $2 AND date <= $3 ORDER BY date',
      [tenantId, dateRange.from, dateRange.to]
    )
    return rows
  }

  const { rows } = await db.query(
    'SELECT * FROM tenant_usage WHERE tenant_id = $1 ORDER BY date DESC LIMIT 30',
    [tenantId]
  )
  return rows
}
