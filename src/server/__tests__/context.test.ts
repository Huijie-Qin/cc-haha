import { describe, test, expect, beforeEach } from 'bun:test'
import { extractRequestContext, type RequestContext } from '../middleware/context.js'

describe('Request Context', () => {
  beforeEach(() => {
    delete process.env.CC_MODE
  })

  test('local mode returns static context', () => {
    process.env.CC_MODE = 'local'
    const ctx = extractRequestContext(new Request('http://localhost/api/sessions'))
    expect(ctx!.tenantId).toBe('local')
    expect(ctx!.userId).toBe('local')
    expect(ctx!.role).toBe('owner')
  })

  test('saas mode without JWT returns null', () => {
    process.env.CC_MODE = 'saas'
    const ctx = extractRequestContext(new Request('http://localhost/api/sessions'))
    expect(ctx).toBeNull()
  })

  test('default mode (no CC_MODE) returns local context', () => {
    const ctx = extractRequestContext(new Request('http://localhost/api/sessions'))
    expect(ctx!.tenantId).toBe('local')
  })

  test('saas mode with Bearer token still returns null (Phase 2 placeholder)', () => {
    process.env.CC_MODE = 'saas'
    const req = new Request('http://localhost/api/sessions', {
      headers: { Authorization: 'Bearer some.jwt.token' },
    })
    const ctx = extractRequestContext(req)
    // Phase 2 will implement JWT verification, for now returns null
    expect(ctx).toBeNull()
  })
})
