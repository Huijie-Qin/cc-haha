import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { getDbClient, closeDbClient } from '../../client.js'
import { runMigrations } from '../../migrate.js'
import { createTenant, getTenant, getTenantBySlug } from '../../queries/tenants.js'

const dbUrl = process.env.DATABASE_URL
describe.skipIf(!dbUrl)('Tenant Queries', () => {
  beforeAll(async () => {
    getDbClient()
    await runMigrations()
  })

  afterAll(async () => {
    await closeDbClient()
  })

  test('createTenant inserts and returns tenant', async () => {
    const tenant = await createTenant({ name: 'Test Corp', slug: 'test-corp' })
    expect(tenant.id).toBeDefined()
    expect(tenant.name).toBe('Test Corp')
    expect(tenant.slug).toBe('test-corp')
    expect(tenant.plan).toBe('free')
  })

  test('getTenant retrieves by id', async () => {
    const created = await createTenant({ name: 'Get Test', slug: 'get-test' })
    const fetched = await getTenant(created.id)
    expect(fetched).toBeDefined()
    expect(fetched!.name).toBe('Get Test')
  })

  test('getTenantBySlug retrieves by slug', async () => {
    await createTenant({ name: 'Slug Test', slug: 'slug-test' })
    const fetched = await getTenantBySlug('slug-test')
    expect(fetched).toBeDefined()
    expect(fetched!.name).toBe('Slug Test')
  })

  test('getTenant returns null for missing id', async () => {
    const fetched = await getTenant('00000000-0000-0000-0000-000000000000')
    expect(fetched).toBeNull()
  })
})
