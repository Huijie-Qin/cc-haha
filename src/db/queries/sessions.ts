import { getDbClient } from '../client.js'

export type Session = {
  id: string
  tenant_id: string
  user_id: string
  title: string | null
  work_dir: string
  model: string | null
  permission_mode: string
  container_id: string | null
  status: string
  created_at: Date
  updated_at: Date
}

export type CreateSessionInput = {
  tenantId: string
  userId: string
  workDir: string
  model?: string
  permissionMode?: string
  title?: string
}

export async function createSession(input: CreateSessionInput): Promise<Session> {
  const db = getDbClient()
  const { rows } = await db.query(
    `INSERT INTO sessions (tenant_id, user_id, work_dir, model, permission_mode, title)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [input.tenantId, input.userId, input.workDir, input.model || null, input.permissionMode || 'default', input.title || null]
  )
  return rows[0]
}

export async function getSession(sessionId: string, tenantId: string): Promise<Session | null> {
  const db = getDbClient()
  const { rows } = await db.query(
    'SELECT * FROM sessions WHERE id = $1 AND tenant_id = $2',
    [sessionId, tenantId]
  )
  return rows[0] || null
}

export async function listSessions(tenantId: string, userId: string): Promise<Session[]> {
  const db = getDbClient()
  const { rows } = await db.query(
    'SELECT * FROM sessions WHERE tenant_id = $1 AND user_id = $2 ORDER BY created_at DESC',
    [tenantId, userId]
  )
  return rows
}

export async function updateSession(sessionId: string, tenantId: string, updates: Partial<Pick<Session, 'title' | 'status' | 'container_id' | 'model'>>): Promise<Session | null> {
  const db = getDbClient()
  const setClauses: string[] = []
  const values: unknown[] = []
  let paramIndex = 3

  for (const [key, value] of Object.entries(updates)) {
    setClauses.push(`${key} = $${paramIndex}`)
    values.push(value)
    paramIndex++
  }

  if (setClauses.length === 0) return getSession(sessionId, tenantId)

  setClauses.push('updated_at = now()')

  const { rows } = await db.query(
    `UPDATE sessions SET ${setClauses.join(', ')} WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [sessionId, tenantId, ...values]
  )
  return rows[0] || null
}

export async function deleteSession(sessionId: string, tenantId: string): Promise<boolean> {
  const db = getDbClient()
  const { rowCount } = await db.query(
    'DELETE FROM sessions WHERE id = $1 AND tenant_id = $2',
    [sessionId, tenantId]
  )
  return (rowCount ?? 0) > 0
}
