import { verifyToken } from '../services/authService.js'

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

export async function extractRequestContext(req: Request): Promise<RequestContext | null> {
  if (!isSaasMode()) {
    return LOCAL_CONTEXT
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return null
  }

  const token = authHeader.slice(7)
  const claims = await verifyToken(token)
  if (!claims || claims.type !== 'access') {
    return null
  }

  return {
    tenantId: claims.tid,
    userId: claims.sub,
    role: claims.role as RequestContext['role'],
  }
}

export function localContext(): RequestContext {
  return LOCAL_CONTEXT
}
