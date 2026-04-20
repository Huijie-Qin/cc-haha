/**
 * Authentication middleware
 *
 * CC_MODE=local: validates against ANTHROPIC_API_KEY (current behavior)
 * CC_MODE=saas: validates JWT and extracts RequestContext
 */

import { isSaasMode, extractRequestContext } from './context.js'

export async function validateAuth(req: Request): Promise<{ valid: boolean; error?: string }> {
  const authHeader = req.headers.get('Authorization')

  if (!authHeader) {
    return { valid: false, error: 'Missing Authorization header' }
  }

  const [scheme, token] = authHeader.split(' ')

  if (scheme !== 'Bearer' || !token) {
    return { valid: false, error: 'Invalid Authorization format. Use: Bearer <token>' }
  }

  // In saas mode, validate JWT via extractRequestContext
  if (isSaasMode()) {
    const ctx = await extractRequestContext(req)
    if (!ctx) {
      return { valid: false, error: 'Invalid or expired JWT' }
    }
    return { valid: true }
  }

  // Local mode: validate against ANTHROPIC_API_KEY
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return { valid: false, error: 'Server ANTHROPIC_API_KEY not configured' }
  }

  if (token !== apiKey) {
    return { valid: false, error: 'Invalid API key' }
  }

  return { valid: true }
}

/**
 * Helper to check auth and return 401 if invalid
 */
export async function requireAuth(req: Request): Promise<Response | null> {
  const { valid, error } = await validateAuth(req)
  if (!valid) {
    return Response.json({ error: 'Unauthorized', message: error }, { status: 401 })
  }
  return null
}
