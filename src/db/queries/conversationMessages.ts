import { getDbClient } from '../client.js'

export type ConversationMessage = {
  id: string
  session_id: string
  tenant_id: string
  role: string
  content: unknown
  model: string | null
  parent_tool_use_id: string | null
  created_at: Date
}

export type AddMessageInput = {
  sessionId: string
  tenantId: string
  role: string
  content: unknown
  model?: string
  parentToolUseId?: string
}

export async function addMessage(input: AddMessageInput): Promise<ConversationMessage> {
  const db = getDbClient()
  const { rows } = await db.query(
    `INSERT INTO conversation_messages (session_id, tenant_id, role, content, model, parent_tool_use_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [input.sessionId, input.tenantId, input.role, JSON.stringify(input.content), input.model || null, input.parentToolUseId || null]
  )
  return rows[0]
}

export async function getSessionMessages(sessionId: string, tenantId: string): Promise<ConversationMessage[]> {
  const db = getDbClient()
  const { rows } = await db.query(
    'SELECT * FROM conversation_messages WHERE session_id = $1 AND tenant_id = $2 ORDER BY created_at',
    [sessionId, tenantId]
  )
  return rows
}

export async function getRecentMessages(sessionId: string, tenantId: string, limit: number): Promise<ConversationMessage[]> {
  const db = getDbClient()
  const { rows } = await db.query(
    'SELECT * FROM conversation_messages WHERE session_id = $1 AND tenant_id = $2 ORDER BY created_at DESC LIMIT $3',
    [sessionId, tenantId, limit]
  )
  return rows.reverse()
}
