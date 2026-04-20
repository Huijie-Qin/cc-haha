import { getDbClient } from '../client.js'

export type AuditLog = {
  id: string
  tenant_id: string
  user_id: string | null
  action: string
  resource: string | null
  details: Record<string, unknown>
  created_at: Date
}

export type LogAuditEventInput = {
  tenantId: string
  userId?: string
  action: string
  resource?: string
  details?: Record<string, unknown>
}

export type ListAuditLogsOptions = {
  limit?: number
  offset?: number
  action?: string
}

export async function logAuditEvent(input: LogAuditEventInput): Promise<AuditLog> {
  const db = getDbClient()
  const { rows } = await db.query(
    `INSERT INTO audit_logs (tenant_id, user_id, action, resource, details)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [input.tenantId, input.userId || null, input.action, input.resource || null, JSON.stringify(input.details || {})]
  )
  return rows[0]
}

export async function listAuditLogs(tenantId: string, options?: ListAuditLogsOptions): Promise<AuditLog[]> {
  const db = getDbClient()
  const limit = options?.limit ?? 100
  const offset = options?.offset ?? 0

  if (options?.action) {
    const { rows } = await db.query(
      'SELECT * FROM audit_logs WHERE tenant_id = $1 AND action = $2 ORDER BY created_at DESC LIMIT $3 OFFSET $4',
      [tenantId, options.action, limit, offset]
    )
    return rows
  }

  const { rows } = await db.query(
    'SELECT * FROM audit_logs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
    [tenantId, limit, offset]
  )
  return rows
}
