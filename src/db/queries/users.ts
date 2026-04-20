import { getDbClient } from '../client.js'

export type User = {
  id: string
  tenant_id: string
  email: string
  password_hash: string | null
  display_name: string | null
  role: string
  auth_providers: Record<string, unknown>
  created_at: Date
  updated_at: Date
}

export type CreateUserInput = {
  tenantId: string
  email: string
  passwordHash?: string
  displayName?: string
  role?: string
}

export async function createUser(input: CreateUserInput): Promise<User> {
  const db = getDbClient()
  const { rows } = await db.query(
    `INSERT INTO users (tenant_id, email, password_hash, display_name, role)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [input.tenantId, input.email, input.passwordHash || null, input.displayName || null, input.role || 'member']
  )
  return rows[0]
}

export async function getUser(id: string): Promise<User | null> {
  const db = getDbClient()
  const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [id])
  return rows[0] || null
}

export async function getUserByEmail(tenantId: string, email: string): Promise<User | null> {
  const db = getDbClient()
  const { rows } = await db.query(
    'SELECT * FROM users WHERE tenant_id = $1 AND email = $2',
    [tenantId, email]
  )
  return rows[0] || null
}
