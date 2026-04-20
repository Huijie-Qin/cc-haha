/**
 * Authentication middleware
 *
 * CC_MODE=local: validates against ANTHROPIC_API_KEY (current behavior)
 * CC_MODE=saas: validates JWT and extracts RequestContext (Phase 2)
 */

import { isSaasMode, extractRequestContext } from './context.js'

export function validateAuth(req: Request): { valid: boolean; error?: string } {
  const authHeader = req.headers.get('Authorization')

  if (!authHeader) {
    return { valid: false, error: 'Missing Authorization header' }
  }

  const [scheme, token] = authHeader.split(' ')

  if (scheme !== 'Bearer' || !token) {
    return { valid: false, error: 'Invalid Authorization format. Use: Bearer <token>' }
  }

  // In saas mode, the token is a JWT — validation happens via extractRequestContext in Phase 2
  if (isSaasMode()) {
    const ctx = extractRequestContext(req)
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
export function requireAuth(req: Request): Response | null {
  const { valid, error } = validateAuth(req)
  if (!valid) {
    return Response.json({ error: 'Unauthorized', message: error }, { status: 401 })
  }
  return null
}
