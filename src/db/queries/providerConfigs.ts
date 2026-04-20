import { getDbClient } from '../client.js'

export type ProviderConfig = {
  id: string
  tenant_id: string
  name: string
  type: string
  base_url: string | null
  auth_token: string | null
  models: unknown[]
  is_active: boolean
  created_at: Date
}

export type CreateProviderConfigInput = {
  tenantId: string
  name: string
  type: string
  baseUrl?: string
  authToken?: string
  models?: unknown[]
}

export async function createProviderConfig(input: CreateProviderConfigInput): Promise<ProviderConfig> {
  const db = getDbClient()
  const { rows } = await db.query(
    `INSERT INTO provider_configs (tenant_id, name, type, base_url, auth_token, models, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, true)
     RETURNING *`,
    [input.tenantId, input.name, input.type, input.baseUrl || null, input.authToken || null, JSON.stringify(input.models || [])]
  )
  return rows[0]
}

export async function listProviderConfigs(tenantId: string): Promise<ProviderConfig[]> {
  const db = getDbClient()
  const { rows } = await db.query(
    'SELECT * FROM provider_configs WHERE tenant_id = $1 ORDER BY created_at',
    [tenantId]
  )
  // Mask auth tokens in list view
  return rows.map((r: ProviderConfig) => ({ ...r, auth_token: r.auth_token ? '***masked***' : null }))
}

export async function getProviderConfig(providerId: string, tenantId: string): Promise<ProviderConfig | null> {
  const db = getDbClient()
  const { rows } = await db.query(
    'SELECT * FROM provider_configs WHERE id = $1 AND tenant_id = $2',
    [providerId, tenantId]
  )
  return rows[0] || null
}

export async function activateProvider(tenantId: string, providerId: string): Promise<void> {
  const db = getDbClient()
  await db.query('BEGIN')
  try {
    await db.query('UPDATE provider_configs SET is_active = false WHERE tenant_id = $1', [tenantId])
    await db.query('UPDATE provider_configs SET is_active = true WHERE id = $1 AND tenant_id = $2', [providerId, tenantId])
    await db.query('COMMIT')
  } catch (err) {
    await db.query('ROLLBACK')
    throw err
  }
}

export async function deleteProviderConfig(providerId: string, tenantId: string): Promise<boolean> {
  const db = getDbClient()
  const { rowCount } = await db.query(
    'DELETE FROM provider_configs WHERE id = $1 AND tenant_id = $2',
    [providerId, tenantId]
  )
  return (rowCount ?? 0) > 0
}
