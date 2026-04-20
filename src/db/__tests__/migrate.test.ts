import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { getDbClient, closeDbClient } from '../client.js'
import { runMigrations, getAppliedMigrations } from '../migrate.js'

// This test requires a real PostgreSQL — skip if no DATABASE_URL
const dbUrl = process.env.DATABASE_URL
describe.skipIf(!dbUrl)('Migration Runner', () => {
  beforeAll(() => {
    getDbClient()
  })

  afterAll(async () => {
    await closeDbClient()
  })

  test('runMigrations creates the migrations table', async () => {
    await runMigrations()
    const applied = await getAppliedMigrations()
    expect(applied.length).toBeGreaterThan(0)
  })

  test('runMigrations is idempotent', async () => {
    await runMigrations()
    await runMigrations()
    const applied = await getAppliedMigrations()
    // Should not double-apply
    const counts: Record<string, number> = {}
    for (const m of applied) {
      counts[m] = (counts[m] || 0) + 1
    }
    for (const [name, count] of Object.entries(counts)) {
      expect(count).toBe(1)
    }
  })
})
