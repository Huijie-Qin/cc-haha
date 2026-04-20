import { getDbClient } from '../client.js'

export type Tenant = {
  id: string
  name: string
  slug: string
  plan: string
  settings: Record<string, unknown>
  created_at: Date
  updated_at: Date
}

export type CreateTenantInput = {
  name: string
  slug: string
  plan?: string
  settings?: Record<string, unknown>
}

export async function createTenant(input: CreateTenantInput): Promise<Tenant> {
  const db = getDbClient()
  const { rows } = await db.query(
    `INSERT INTO tenants (name, slug, plan, settings)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [input.name, input.slug, input.plan || 'free', JSON.stringify(input.settings || {})]
  )
  return rows[0]
}

export async function getTenant(id: string): Promise<Tenant | null> {
  const db = getDbClient()
  const { rows } = await db.query('SELECT * FROM tenants WHERE id = $1', [id])
  return rows[0] || null
}

export async function getTenantBySlug(slug: string): Promise<Tenant | null> {
  const db = getDbClient()
  const { rows } = await db.query('SELECT * FROM tenants WHERE slug = $1', [slug])
  return rows[0] || null
}
