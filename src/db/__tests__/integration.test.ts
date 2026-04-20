import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { getDbClient, closeDbClient } from '../client.js'
import { runMigrations } from '../migrate.js'
import * as queries from '../queries/index.js'

const dbUrl = process.env.DATABASE_URL
describe.skipIf(!dbUrl)('Phase 1 Integration', () => {
  beforeAll(async () => {
    getDbClient()
    await runMigrations()
  })

  afterAll(async () => {
    await closeDbClient()
  })

  test('full CRUD lifecycle: tenant → user → session → message', async () => {
    // Create tenant
    const tenant = await queries.createTenant({ name: 'Integration Corp', slug: 'int-corp' })
    expect(tenant.id).toBeDefined()

    // Create user
    const user = await queries.createUser({
      tenantId: tenant.id,
      email: 'dev@int-corp.com',
      displayName: 'Dev',
      role: 'owner',
    })
    expect(user.tenant_id).toBe(tenant.id)

    // Create session
    const session = await queries.createSession({
      tenantId: tenant.id,
      userId: user.id,
      workDir: '/workspace',
    })
    expect(session.tenant_id).toBe(tenant.id)

    // Add conversation message
    await queries.addMessage({
      sessionId: session.id,
      tenantId: tenant.id,
      role: 'user',
      content: { text: 'Hello' },
    })

    // Retrieve messages
    const messages = await queries.getSessionMessages(session.id, tenant.id)
    expect(messages.length).toBe(1)
    expect(messages[0].role).toBe('user')

    // List sessions for tenant
    const sessions = await queries.listSessions(tenant.id, user.id)
    expect(sessions.length).toBe(1)

    // Audit log
    await queries.logAuditEvent({
      tenantId: tenant.id,
      userId: user.id,
      action: 'session.created',
      resource: `session/${session.id}`,
    })

    const logs = await queries.listAuditLogs(tenant.id, { limit: 10 })
    expect(logs.length).toBe(1)
  })

  test('tenant isolation: tenant B cannot see tenant A data', async () => {
    const tenantA = await queries.createTenant({ name: 'Corp A', slug: 'corp-a' })
    const tenantB = await queries.createTenant({ name: 'Corp B', slug: 'corp-b' })

    await queries.createProviderConfig({
      tenantId: tenantA.id,
      name: 'A provider',
      type: 'anthropic',
    })

    const bProviders = await queries.listProviderConfigs(tenantB.id)
    expect(bProviders.length).toBe(0)
  })

  test('session update and delete', async () => {
    const tenant = await queries.createTenant({ name: 'Session Corp', slug: 'session-corp' })
    const user = await queries.createUser({
      tenantId: tenant.id,
      email: 'user@session.com',
      role: 'member',
    })

    const session = await queries.createSession({
      tenantId: tenant.id,
      userId: user.id,
      workDir: '/workspace',
      title: 'Original Title',
    })

    // Update
    const updated = await queries.updateSession(session.id, tenant.id, { title: 'Updated Title', status: 'active' })
    expect(updated!.title).toBe('Updated Title')
    expect(updated!.status).toBe('active')

    // Delete
    const deleted = await queries.deleteSession(session.id, tenant.id)
    expect(deleted).toBe(true)

    // Verify gone
    const fetched = await queries.getSession(session.id, tenant.id)
    expect(fetched).toBeNull()
  })

  test('provider config activation', async () => {
    const tenant = await queries.createTenant({ name: 'Provider Corp', slug: 'provider-corp' })

    const p1 = await queries.createProviderConfig({
      tenantId: tenant.id,
      name: 'Provider 1',
      type: 'anthropic',
    })
    const p2 = await queries.createProviderConfig({
      tenantId: tenant.id,
      name: 'Provider 2',
      type: 'openai',
    })

    // Activate provider 2
    await queries.activateProvider(tenant.id, p2.id)

    // Verify only p2 is active
    const providers = await queries.listProviderConfigs(tenant.id)
    const active = providers.find(p => p.is_active)
    expect(active!.name).toBe('Provider 2')
  })

  test('tenant usage upsert', async () => {
    const tenant = await queries.createTenant({ name: 'Usage Corp', slug: 'usage-corp' })

    const today = new Date().toISOString().split('T')[0]

    // First upsert
    await queries.upsertDailyUsage({
      tenantId: tenant.id,
      date: today,
      inputTokens: 100,
      outputTokens: 50,
      requestCount: 1,
    })

    // Second upsert (should accumulate)
    await queries.upsertDailyUsage({
      tenantId: tenant.id,
      date: today,
      inputTokens: 200,
      outputTokens: 100,
      requestCount: 1,
    })

    const usage = await queries.getUsage(tenant.id)
    expect(usage.length).toBe(1)
    expect(Number(usage[0].input_tokens)).toBe(300)
    expect(Number(usage[0].output_tokens)).toBe(150)
    expect(usage[0].request_count).toBe(2)
  })

  test('team CRUD', async () => {
    const tenant = await queries.createTenant({ name: 'Team Corp', slug: 'team-corp' })

    const team = await queries.createTeam({
      tenantId: tenant.id,
      name: 'Alpha Team',
      description: 'Test team',
    })

    expect(team.tenant_id).toBe(tenant.id)

    // Add member
    const member = await queries.addTeamMember({
      teamId: team.id,
      agentId: 'agent-1',
      name: 'Researcher',
      agentType: 'subagent',
    })
    expect(member.team_id).toBe(team.id)

    // Remove member
    const removed = await queries.removeTeamMember(member.id)
    expect(removed).toBe(true)
  })
})
