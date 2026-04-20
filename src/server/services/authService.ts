/**
 * Authentication Service — JWT creation/verification, password hashing
 *
 * Uses RS256 (RSA-PSS) for JWT signing. The signing key is loaded from
 * JWT_PRIVATE_KEY / JWT_PUBLIC_KEY PEM environment variables. If not set,
 * generates an ephemeral key pair on startup (suitable for dev only).
 */

import { SignJWT, jwtVerify, importPKCS8, importSPKI, exportJWK, generateKeyPair } from 'jose'
import bcrypt from 'bcryptjs'
import { getDbClient } from '../../db/client.js'
import { createTenant } from '../../db/queries/tenants.js'
import { createUser, getUserByEmail } from '../../db/queries/users.js'

// ─── Configuration ──────────────────────────────────────────────────────────

const ACCESS_TOKEN_TTL = '15m'
const REFRESH_TOKEN_TTL = '7d'
const BCRYPT_ROUNDS = 12

// ─── Key Management ─────────────────────────────────────────────────────────

let privateKey: CryptoKey | null = null
let publicKey: CryptoKey | null = null

export async function initAuthKeys(): Promise<void> {
  const privPem = process.env.JWT_PRIVATE_KEY
  const pubPem = process.env.JWT_PUBLIC_KEY

  if (privPem && pubPem) {
    privateKey = await importPKCS8(privPem, 'RS256')
    publicKey = await importSPKI(pubPem, 'RS256')
    console.log('[Auth] Loaded JWT keys from environment')
  } else {
    // Generate ephemeral key pair for development
    const { publicKey: pub, privateKey: priv } = await generateKeyPair('RS256', {
      modulusLength: 2048,
    })
    privateKey = priv
    publicKey = pub
    console.log('[Auth] Generated ephemeral JWT key pair (set JWT_PRIVATE_KEY/JWT_PUBLIC_KEY for production)')
  }
}

function getPrivateKey(): CryptoKey {
  if (!privateKey) throw new Error('Auth keys not initialized. Call initAuthKeys() first.')
  return privateKey
}

function getPublicKey(): CryptoKey {
  if (!publicKey) throw new Error('Auth keys not initialized. Call initAuthKeys() first.')
  return publicKey
}

// ─── Token Types ─────────────────────────────────────────────────────────────

export type TokenPair = {
  accessToken: string
  refreshToken: string
}

export type JwtClaims = {
  sub: string   // userId
  tid: string   // tenantId
  role: string  // owner | admin | member
  type: 'access' | 'refresh'
}

// ─── Token Operations ───────────────────────────────────────────────────────

export async function createTokenPair(userId: string, tenantId: string, role: string): Promise<TokenPair> {
  const accessToken = await new SignJWT({ sub: userId, tid: tenantId, role, type: 'access' })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt()
    .setExpirationTime(ACCESS_TOKEN_TTL)
    .sign(getPrivateKey())

  const refreshToken = await new SignJWT({ sub: userId, tid: tenantId, role, type: 'refresh' })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt()
    .setExpirationTime(REFRESH_TOKEN_TTL)
    .sign(getPrivateKey())

  return { accessToken, refreshToken }
}

export async function verifyToken(token: string): Promise<JwtClaims | null> {
  try {
    const { payload } = await jwtVerify(token, getPublicKey(), {
      algorithms: ['RS256'],
    })
    return payload as unknown as JwtClaims
  } catch {
    return null
  }
}

// ─── Password Operations ────────────────────────────────────────────────────

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS)
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash)
}

// ─── Registration ────────────────────────────────────────────────────────────

export type RegisterInput = {
  email: string
  password: string
  displayName: string
  tenantName: string
  tenantSlug: string
}

export type RegisterResult = {
  tenant: { id: string; name: string; slug: string }
  user: { id: string; email: string; displayName: string; role: string }
  tokens: TokenPair
}

export async function register(input: RegisterInput): Promise<RegisterResult> {
  const db = getDbClient()

  // Check if tenant slug already exists
  const { rows: existingTenants } = await db.query(
    'SELECT id FROM tenants WHERE slug = $1',
    [input.tenantSlug]
  )
  if (existingTenants.length > 0) {
    throw Object.assign(new Error('Tenant slug already taken'), { statusCode: 409, code: 'TENANT_SLUG_TAKEN' })
  }

  // Create tenant
  const tenant = await createTenant({
    name: input.tenantName,
    slug: input.tenantSlug,
  })

  // Hash password
  const passwordHash = await hashPassword(input.password)

  // Create user as owner of the new tenant
  const user = await createUser({
    tenantId: tenant.id,
    email: input.email,
    passwordHash,
    displayName: input.displayName,
    role: 'owner',
  })

  // Generate tokens
  const tokens = await createTokenPair(user.id, tenant.id, 'owner')

  return {
    tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
    user: { id: user.id, email: user.email, displayName: user.display_name || '', role: user.role },
    tokens,
  }
}

// ─── Login ───────────────────────────────────────────────────────────────────

export type LoginInput = {
  email: string
  password: string
  tenantSlug: string
}

export type LoginResult = {
  tenant: { id: string; name: string; slug: string }
  user: { id: string; email: string; displayName: string; role: string }
  tokens: TokenPair
}

export async function login(input: LoginInput): Promise<LoginResult> {
  const db = getDbClient()

  // Find tenant by slug
  const { rows: tenants } = await db.query(
    'SELECT id, name, slug FROM tenants WHERE slug = $1',
    [input.tenantSlug]
  )
  if (tenants.length === 0) {
    throw Object.assign(new Error('Tenant not found'), { statusCode: 404, code: 'TENANT_NOT_FOUND' })
  }
  const tenant = tenants[0]

  // Find user by email within tenant
  const user = await getUserByEmail(tenant.id, input.email)
  if (!user) {
    throw Object.assign(new Error('Invalid credentials'), { statusCode: 401, code: 'INVALID_CREDENTIALS' })
  }

  // Verify password
  if (!user.password_hash) {
    throw Object.assign(new Error('Password login not available for this account'), { statusCode: 400, code: 'NO_PASSWORD' })
  }

  const valid = await verifyPassword(input.password, user.password_hash)
  if (!valid) {
    throw Object.assign(new Error('Invalid credentials'), { statusCode: 401, code: 'INVALID_CREDENTIALS' })
  }

  // Generate tokens
  const tokens = await createTokenPair(user.id, tenant.id, user.role)

  return {
    tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
    user: { id: user.id, email: user.email, displayName: user.display_name || '', role: user.role },
    tokens,
  }
}

// ─── Refresh ─────────────────────────────────────────────────────────────────

export async function refresh(refreshToken: string): Promise<TokenPair> {
  const claims = await verifyToken(refreshToken)
  if (!claims || claims.type !== 'refresh') {
    throw Object.assign(new Error('Invalid refresh token'), { statusCode: 401, code: 'INVALID_REFRESH_TOKEN' })
  }

  // Verify user still exists and is active
  const db = getDbClient()
  const { rows } = await db.query('SELECT role FROM users WHERE id = $1', [claims.sub])
  if (rows.length === 0) {
    throw Object.assign(new Error('User no longer exists'), { statusCode: 401, code: 'USER_NOT_FOUND' })
  }

  return createTokenPair(claims.sub, claims.tid, rows[0].role)
}
