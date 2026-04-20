import { describe, test, expect, beforeEach } from 'bun:test'
import { extractRequestContext, type RequestContext } from '../middleware/context.js'

describe('Request Context', () => {
  beforeEach(() => {
    delete process.env.CC_MODE
  })

  test('local mode returns static context', async () => {
    process.env.CC_MODE = 'local'
    const ctx = await extractRequestContext(new Request('http://localhost/api/sessions'))
    expect(ctx!.tenantId).toBe('local')
    expect(ctx!.userId).toBe('local')
    expect(ctx!.role).toBe('owner')
  })

  test('saas mode without JWT returns null', async () => {
    process.env.CC_MODE = 'saas'
    const ctx = await extractRequestContext(new Request('http://localhost/api/sessions'))
    expect(ctx).toBeNull()
  })

  test('default mode (no CC_MODE) returns local context', async () => {
    const ctx = await extractRequestContext(new Request('http://localhost/api/sessions'))
    expect(ctx!.tenantId).toBe('local')
  })

  test('saas mode with invalid JWT returns null', async () => {
    process.env.CC_MODE = 'saas'
    const req = new Request('http://localhost/api/sessions', {
      headers: { Authorization: 'Bearer invalid.jwt.token' },
    })
    const ctx = await extractRequestContext(req)
    expect(ctx).toBeNull()
  })
})
