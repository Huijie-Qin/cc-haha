export type RequestContext = {
  tenantId: string
  userId: string
  role: 'owner' | 'admin' | 'member'
}

const LOCAL_CONTEXT: RequestContext = {
  tenantId: 'local',
  userId: 'local',
  role: 'owner',
}

export function isSaasMode(): boolean {
  return process.env.CC_MODE === 'saas'
}

export function extractRequestContext(req: Request): RequestContext | null {
  if (!isSaasMode()) {
    return LOCAL_CONTEXT
  }

  // In saas mode, extract from JWT — will be implemented in Phase 2
  // For now, return null to indicate auth is required but not yet implemented
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return null
  }

  // Phase 2 will replace this with JWT verification
  return null
}

export function localContext(): RequestContext {
  return LOCAL_CONTEXT
}
