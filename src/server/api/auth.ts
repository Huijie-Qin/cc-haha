/**
 * Auth REST API
 *
 * POST /api/auth/register  — Register new tenant + user
 * POST /api/auth/login     — Email/password login
 * POST /api/auth/refresh   — Refresh access token
 * GET  /api/auth/me        — Get current user info (requires auth)
 */

import { isSaasMode, extractRequestContext } from '../middleware/context.js'
import { register, login, refresh, verifyToken, type RegisterInput, type LoginInput } from '../services/authService.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'

export async function handleAuthApi(
  req: Request,
  _url: URL,
  segments: string[],
): Promise<Response> {
  // Auth API only available in saas mode
  if (!isSaasMode()) {
    return Response.json(
      { error: 'NOT_AVAILABLE', message: 'Auth API is only available in SaaS mode' },
      { status: 404 }
    )
  }

  try {
    const sub = segments[2] // 'register' | 'login' | 'refresh' | 'me'

    switch (sub) {
      case 'register':
        if (req.method !== 'POST') throw new ApiError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')
        return await handleRegister(req)

      case 'login':
        if (req.method !== 'POST') throw new ApiError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')
        return await handleLogin(req)

      case 'refresh':
        if (req.method !== 'POST') throw new ApiError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')
        return await handleRefresh(req)

      case 'me':
        if (req.method !== 'GET') throw new ApiError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')
        return await handleMe(req)

      default:
        throw ApiError.notFound(`Unknown auth endpoint: ${sub}`)
    }
  } catch (error) {
    // Handle custom errors with statusCode
    if (error && typeof error === 'object' && 'statusCode' in error) {
      const e = error as { statusCode: number; code?: string; message: string }
      return Response.json(
        { error: e.code || 'ERROR', message: e.message },
        { status: e.statusCode }
      )
    }
    return errorResponse(error)
  }
}

async function handleRegister(req: Request): Promise<Response> {
  const body = await req.json() as RegisterInput

  if (!body.email || !body.password || !body.displayName || !body.tenantName || !body.tenantSlug) {
    return Response.json(
      { error: 'BAD_REQUEST', message: 'Missing required fields: email, password, displayName, tenantName, tenantSlug' },
      { status: 400 }
    )
  }

  // Validate tenant slug format
  if (!/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(body.tenantSlug)) {
    return Response.json(
      { error: 'BAD_REQUEST', message: 'Tenant slug must be 3-50 chars, lowercase alphanumeric and hyphens' },
      { status: 400 }
    )
  }

  // Validate password strength
  if (body.password.length < 8) {
    return Response.json(
      { error: 'BAD_REQUEST', message: 'Password must be at least 8 characters' },
      { status: 400 }
    )
  }

  const result = await register(body)
  return Response.json(result, { status: 201 })
}

async function handleLogin(req: Request): Promise<Response> {
  const body = await req.json() as LoginInput

  if (!body.email || !body.password || !body.tenantSlug) {
    return Response.json(
      { error: 'BAD_REQUEST', message: 'Missing required fields: email, password, tenantSlug' },
      { status: 400 }
    )
  }

  const result = await login(body)
  return Response.json(result)
}

async function handleRefresh(req: Request): Promise<Response> {
  const body = await req.json() as { refreshToken: string }

  if (!body.refreshToken) {
    return Response.json(
      { error: 'BAD_REQUEST', message: 'Missing refreshToken' },
      { status: 400 }
    )
  }

  const tokens = await refresh(body.refreshToken)
  return Response.json(tokens)
}

async function handleMe(req: Request): Promise<Response> {
  const ctx = extractRequestContext(req)
  if (!ctx) {
    return Response.json(
      { error: 'UNAUTHORIZED', message: 'Invalid or expired token' },
      { status: 401 }
    )
  }

  return Response.json({
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    role: ctx.role,
  })
}
