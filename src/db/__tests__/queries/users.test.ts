import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { getDbClient, closeDbClient } from '../../client.js'
import { runMigrations } from '../../migrate.js'
import { createTenant } from '../../queries/tenants.js'
import { createUser, getUser, getUserByEmail } from '../../queries/users.js'

const dbUrl = process.env.DATABASE_URL
describe.skipIf(!dbUrl)('User Queries', () => {
  let tenantId: string

  beforeAll(async () => {
    getDbClient()
    await runMigrations()
    const tenant = await createTenant({ name: 'User Test', slug: 'user-test' })
    tenantId = tenant.id
  })

  afterAll(async () => {
    await closeDbClient()
  })

  test('createUser inserts and returns user', async () => {
    const user = await createUser({
      tenantId,
      email: 'alice@test.com',
      passwordHash: 'hashed_pw',
      displayName: 'Alice',
      role: 'owner',
    })
    expect(user.id).toBeDefined()
    expect(user.email).toBe('alice@test.com')
    expect(user.role).toBe('owner')
    expect(user.tenant_id).toBe(tenantId)
  })

  test('getUserByEmail finds user within tenant', async () => {
    const user = await getUserByEmail(tenantId, 'alice@test.com')
    expect(user).toBeDefined()
    expect(user!.display_name).toBe('Alice')
  })

  test('getUserByEmail returns null for wrong tenant', async () => {
    const otherTenant = await createTenant({ name: 'Other', slug: 'other-tenant-x' })
    const user = await getUserByEmail(otherTenant.id, 'alice@test.com')
    expect(user).toBeNull()
  })

  test('getUser retrieves by id', async () => {
    const created = await createUser({
      tenantId,
      email: 'bob@test.com',
      displayName: 'Bob',
    })
    const fetched = await getUser(created.id)
    expect(fetched).toBeDefined()
    expect(fetched!.email).toBe('bob@test.com')
  })
})
