import { describe, test, expect, afterEach } from 'bun:test'
import { getDbClient, closeDbClient, isDbConnected } from '../client.js'

describe('DB Client', () => {
  afterEach(async () => {
    await closeDbClient()
  })

  test('isDbConnected returns false when no client initialized', () => {
    expect(isDbConnected()).toBe(false)
  })

  test('getDbClient throws when DATABASE_URL not set', () => {
    const original = process.env.DATABASE_URL
    delete process.env.DATABASE_URL
    expect(() => getDbClient()).toThrow('DATABASE_URL not configured')
    process.env.DATABASE_URL = original
  })

  test('getDbClient returns a pool when DATABASE_URL is set', () => {
    process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test'
    const client = getDbClient()
    expect(client).toBeDefined()
    expect(typeof client.query).toBe('function')
  })

  test('getDbClient returns same instance on repeated calls', () => {
    process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test'
    const a = getDbClient()
    const b = getDbClient()
    expect(a).toBe(b)
  })

  test('closeDbClient resets the singleton', async () => {
    process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test'
    getDbClient()
    await closeDbClient()
    expect(isDbConnected()).toBe(false)
  })
})
