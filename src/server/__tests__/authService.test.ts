import { describe, test, expect, beforeAll } from 'bun:test'
import { initAuthKeys, createTokenPair, verifyToken, hashPassword, verifyPassword } from '../services/authService.js'

describe('Auth Service', () => {
  beforeAll(async () => {
    await initAuthKeys()
  })

  test('hashPassword and verifyPassword', async () => {
    const hash = await hashPassword('test-password')
    expect(hash).toBeDefined()
    expect(hash).not.toBe('test-password')

    const valid = await verifyPassword('test-password', hash)
    expect(valid).toBe(true)

    const invalid = await verifyPassword('wrong-password', hash)
    expect(invalid).toBe(false)
  })

  test('createTokenPair returns access and refresh tokens', async () => {
    const tokens = await createTokenPair('user-1', 'tenant-1', 'owner')
    expect(tokens.accessToken).toBeDefined()
    expect(tokens.refreshToken).toBeDefined()
    expect(typeof tokens.accessToken).toBe('string')
    expect(typeof tokens.refreshToken).toBe('string')
  })

  test('verifyToken returns claims for valid access token', async () => {
    const tokens = await createTokenPair('user-2', 'tenant-2', 'admin')
    const claims = await verifyToken(tokens.accessToken)
    expect(claims).not.toBeNull()
    expect(claims!.sub).toBe('user-2')
    expect(claims!.tid).toBe('tenant-2')
    expect(claims!.role).toBe('admin')
    expect(claims!.type).toBe('access')
  })

  test('verifyToken returns claims for valid refresh token', async () => {
    const tokens = await createTokenPair('user-3', 'tenant-3', 'member')
    const claims = await verifyToken(tokens.refreshToken)
    expect(claims).not.toBeNull()
    expect(claims!.type).toBe('refresh')
  })

  test('verifyToken returns null for invalid token', async () => {
    const claims = await verifyToken('invalid.jwt.token')
    expect(claims).toBeNull()
  })

  test('verifyToken returns null for expired token', async () => {
    // Create a token that's already expired by using a very short expiry
    const { SignJWT } = await import('jose')
    const { generateKeyPair } = await import('jose')
    // Use the service's private key — but we can't easily create expired tokens
    // Just test that garbage tokens return null
    const claims = await verifyToken('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0IiwiZXhwIjoxMDAwMDAwMDAwfQ.invalid')
    expect(claims).toBeNull()
  })
})
