import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'crypto'
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'

// ── Mock Prisma (mirrors the pattern used by webhooks.test.ts) ─────────────────
vi.mock('../db', () => ({
  prisma: {
    apiKey: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
}))

import { prisma } from '../db'
import {
  registerApiKeyAuth,
  hashApiKey,
  extractBearer,
  lookupApiKey,
} from '../api/auth'
import { registerAdminRoutes, generateApiKey } from '../api/admin'
import { register, api_key_auth_failures_total, admin_auth_failures_total } from '../metrics'

const mockFindUnique = prisma.apiKey.findUnique as unknown as ReturnType<typeof vi.fn>
const mockCreate = prisma.apiKey.create as unknown as ReturnType<typeof vi.fn>
const mockUpdate = prisma.apiKey.update as unknown as ReturnType<typeof vi.fn>

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

async function apiKeyAuthFailureCount(reason: string): Promise<number> {
  const metric = await api_key_auth_failures_total.get()
  return metric.values.find((value) => value.labels.reason === reason)?.value ?? 0
}

/** Builds an app with auth enabled + one protected and one public route. */
async function buildAuthedApp() {
  const app = Fastify()
  // Auth must register before rate-limit: both run in `onRequest`, and the
  // limiter reads req.apiKey, which the auth hook populates.
  await app.register(registerApiKeyAuth)
  await app.register(rateLimit, {
    max: (req) => req.apiKey?.ratePerMin ?? 100,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.apiKey?.id ?? req.ip,
  })
  app.get('/price/test', async () => ({ ok: true }))
  app.get('/status', { config: { public: true } }, async () => ({ ok: true }))
  await app.ready()
  return app
}

beforeEach(() => {
  mockFindUnique.mockReset()
  mockCreate.mockReset()
  mockUpdate.mockReset()
})

describe('hashApiKey / extractBearer', () => {
  it('hashes keys with SHA-256 (never stores plaintext)', () => {
    expect(hashApiKey('lens_secret')).toBe(sha256('lens_secret'))
    // 64 hex chars = SHA-256
    expect(hashApiKey('x')).toMatch(/^[a-f0-9]{64}$/)
  })

  it('extracts the bearer token, case-insensitively', () => {
    expect(extractBearer('Bearer abc123')).toBe('abc123')
    expect(extractBearer('bearer  spaced ')).toBe('spaced')
    expect(extractBearer(undefined)).toBeNull()
    expect(extractBearer('Basic abc')).toBeNull()
  })
})

describe('lookupApiKey', () => {
  it('looks up by hash and returns context for a valid key', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'key-1', label: 'acme', ratePerMin: 120, ratePerDay: 50000, revokedAt: null,
    })
    const ctx = await lookupApiKey('lens_plain')
    expect(mockFindUnique).toHaveBeenCalledWith({ where: { hash: sha256('lens_plain') } })
    expect(ctx).toEqual({ id: 'key-1', label: 'acme', ratePerMin: 120, ratePerDay: 50000 })
  })

  it('returns null for an unknown key', async () => {
    mockFindUnique.mockResolvedValue(null)
    expect(await lookupApiKey('nope')).toBeNull()
  })

  it('returns null for a revoked key', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'key-1', label: 'acme', ratePerMin: 60, ratePerDay: 1000, revokedAt: new Date(),
    })
    expect(await lookupApiKey('lens_plain')).toBeNull()
  })

  it('returns null for an expired key', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'key-1',
      label: 'acme',
      ratePerMin: 60,
      ratePerDay: 1000,
      revokedAt: null,
      expiresAt: new Date(Date.now() - 1000),
    })
    expect(await lookupApiKey('lens_plain')).toBeNull()
  })
})

describe('API key auth hook', () => {
  it('returns 401 when no key is provided', async () => {
    const before = await apiKeyAuthFailureCount('missing')
    const app = await buildAuthedApp()
    const res = await app.inject({ method: 'GET', url: '/price/test' })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ error: 'Unauthorized' })
    expect(res.json().code).toBe('missing')
    expect(await apiKeyAuthFailureCount('missing')).toBe(before + 1)
    expect(mockFindUnique).not.toHaveBeenCalled()
  })

  it('counts malformed authorization separately from missing credentials', async () => {
    const before = await apiKeyAuthFailureCount('malformed')
    const app = await buildAuthedApp()
    const res = await app.inject({
      method: 'GET',
      url: '/price/test',
      headers: { authorization: 'Basic value' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ code: 'malformed' })
    expect(await apiKeyAuthFailureCount('malformed')).toBe(before + 1)
  })

  it('returns 401 for an invalid key', async () => {
    const before = await apiKeyAuthFailureCount('unknown')
    mockFindUnique.mockResolvedValue(null)
    const app = await buildAuthedApp()
    const res = await app.inject({
      method: 'GET',
      url: '/price/test',
      headers: { authorization: 'Bearer wrong' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('unknown')
    expect(res.json().message).toBe('Unknown API key.')
    expect(await apiKeyAuthFailureCount('unknown')).toBe(before + 1)
  })

  it('returns 401 for a revoked key', async () => {
    const before = await apiKeyAuthFailureCount('revoked')
    mockFindUnique.mockResolvedValue({
      id: 'key-1', label: 'acme', ratePerMin: 60, ratePerDay: 1000, revokedAt: new Date(),
    })
    const app = await buildAuthedApp()
    const res = await app.inject({
      method: 'GET',
      url: '/price/test',
      headers: { authorization: 'Bearer revoked' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('revoked')
    expect(res.json().message).toBe('Revoked API key. Request a replacement key.')
    expect(await apiKeyAuthFailureCount('revoked')).toBe(before + 1)
  })

  it('returns a distinct code and message for an expired key', async () => {
    const before = await apiKeyAuthFailureCount('expired')
    mockFindUnique.mockResolvedValue({
      id: 'key-1',
      label: 'acme',
      ratePerMin: 60,
      ratePerDay: 1000,
      revokedAt: null,
      expiresAt: new Date(Date.now() - 1000),
    })
    const app = await buildAuthedApp()
    const res = await app.inject({
      method: 'GET',
      url: '/price/test',
      headers: { authorization: 'Bearer test-expired-api-key' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('expired')
    expect(res.json().message).toBe('Expired API key. Request a replacement key.')
    expect(await apiKeyAuthFailureCount('expired')).toBe(before + 1)
  })

  it('allows a valid key through and attaches metadata', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'key-1', label: 'acme', ratePerMin: 120, ratePerDay: 50000, revokedAt: null,
    })
    const app = await buildAuthedApp()
    const res = await app.inject({
      method: 'GET',
      url: '/price/test',
      headers: { authorization: 'Bearer good' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })

  it('lets public routes through without a key', async () => {
    const app = await buildAuthedApp()
    const res = await app.inject({ method: 'GET', url: '/status' })
    expect(res.statusCode).toBe(200)
    expect(mockFindUnique).not.toHaveBeenCalled()
  })
})

describe('per-key rate quotas', () => {
  it('honors each key’s own ratePerMin (429 after the quota)', async () => {
    // A key allowed only 2 requests/min.
    mockFindUnique.mockResolvedValue({
      id: 'key-limited', label: 'small', ratePerMin: 2, ratePerDay: 1000, revokedAt: null,
    })
    const app = await buildAuthedApp()
    const headers = { authorization: 'Bearer limited' }

    const r1 = await app.inject({ method: 'GET', url: '/price/test', headers })
    const r2 = await app.inject({ method: 'GET', url: '/price/test', headers })
    const r3 = await app.inject({ method: 'GET', url: '/price/test', headers })

    expect(r1.statusCode).toBe(200)
    expect(r2.statusCode).toBe(200)
    expect(r3.statusCode).toBe(429) // quota exhausted
  })

  it('tracks quotas independently per key', async () => {
    const app = await buildAuthedApp()
    // First key: limited to 1/min.
    mockFindUnique.mockResolvedValue({
      id: 'key-a', label: 'a', ratePerMin: 1, ratePerDay: 100, revokedAt: null,
    })
    const a1 = await app.inject({ method: 'GET', url: '/price/test', headers: { authorization: 'Bearer a' } })
    const a2 = await app.inject({ method: 'GET', url: '/price/test', headers: { authorization: 'Bearer a' } })
    expect(a1.statusCode).toBe(200)
    expect(a2.statusCode).toBe(429)

    // Second, distinct key gets its own fresh bucket.
    mockFindUnique.mockResolvedValue({
      id: 'key-b', label: 'b', ratePerMin: 1, ratePerDay: 100, revokedAt: null,
    })
    const b1 = await app.inject({ method: 'GET', url: '/price/test', headers: { authorization: 'Bearer b' } })
    expect(b1.statusCode).toBe(200)
  })
})

describe('admin endpoints', () => {
  const ORIGINAL = process.env.ADMIN_TOKEN
  beforeEach(() => { process.env.ADMIN_TOKEN = 'admin-secret' })
  afterEach(() => {
    // Node stringifies undefined → "undefined"; delete to truly clear.
    if (ORIGINAL === undefined) delete process.env.ADMIN_TOKEN
    else process.env.ADMIN_TOKEN = ORIGINAL
  })

  async function buildAdminApp() {
    const app = Fastify()
    await registerAdminRoutes(app)
    await app.ready()
    return app
  }

  it('generateApiKey produces a prefixed opaque key', () => {
    const k = generateApiKey()
    expect(k).toMatch(/^lens_[a-f0-9]{48}$/)
  })

  it('rejects minting without the admin token', async () => {
    const before = (await admin_auth_failures_total.get()).values[0]?.value ?? 0
    const app = await buildAdminApp()
    const res = await app.inject({
      method: 'POST', url: '/admin/keys', payload: { label: 'x' },
    })
    expect(res.statusCode).toBe(401)
    expect(mockCreate).not.toHaveBeenCalled()
    expect((await admin_auth_failures_total.get()).values[0]?.value).toBe(before + 1)
  })

  it('mints a key and returns the plaintext once (stored as hash only)', async () => {
    mockCreate.mockImplementation(async ({ data }: any) => ({
      id: 'new-id', createdAt: new Date(), ratePerMin: 60, ratePerDay: 10000, monthlyQuotaCents: 10000, dailyQuotaCents: 500, overagePolicy: 'block', ...data,
    }))
    const app = await buildAdminApp()
    const res = await app.inject({
      method: 'POST',
      url: '/admin/keys',
      headers: { 'x-admin-token': 'admin-secret' },
      payload: { label: 'acme', ratePerMin: 120, ratePerDay: 50000 },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.key).toMatch(/^lens_[a-f0-9]{48}$/)
    expect(body.label).toBe('acme')
    const stored = mockCreate.mock.calls[0][0].data
    expect(stored.hash).toBe(sha256(body.key))
    expect(stored.hash).not.toBe(body.key)
  })

  it('accepts quota configuration on key creation', async () => {
    mockCreate.mockImplementation(async ({ data }: any) => ({
      id: 'new-id', createdAt: new Date(), ratePerMin: 60, ratePerDay: 10000, ...data,
    }))
    const app = await buildAdminApp()
    const res = await app.inject({
      method: 'POST',
      url: '/admin/keys',
      headers: { 'x-admin-token': 'admin-secret' },
      payload: { label: 'acme', monthlyQuotaCents: 20000, dailyQuotaCents: 1000, overagePolicy: 'allow_overage' },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.monthlyQuotaCents).toBe(20000)
    expect(body.dailyQuotaCents).toBe(1000)
    expect(body.overagePolicy).toBe('allow_overage')
  })

  // ── Body validation (issue #506): reject bad quotas/policies, don't coerce ──
  async function postKey(payload: unknown) {
    const app = await buildAdminApp()
    return app.inject({
      method: 'POST',
      url: '/admin/keys',
      headers: { 'x-admin-token': 'admin-secret' },
      payload: payload as object,
    })
  }

  it('rejects a negative rate and names the field, without touching the database', async () => {
    const res = await postKey({ label: 'acme', ratePerMin: -5 })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/ratePerMin/)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('rejects a fractional quota', async () => {
    const res = await postKey({ label: 'acme', monthlyQuotaCents: 10.5 })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/monthlyQuotaCents/)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('rejects a zero rate (a key that can never call anything)', async () => {
    const res = await postKey({ label: 'acme', ratePerDay: 0 })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/ratePerDay/)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('rejects an out-of-range value above the Int column ceiling', async () => {
    const res = await postKey({ label: 'acme', dailyQuotaCents: 9_999_999_999 })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/dailyQuotaCents/)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('rejects an unknown overagePolicy instead of silently defaulting to block', async () => {
    const res = await postKey({ label: 'acme', overagePolicy: 'refund_everything' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/overagePolicy/)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('rejects a per-day rate below the per-minute rate', async () => {
    const res = await postKey({ label: 'acme', ratePerMin: 100, ratePerDay: 50 })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/ratePerDay/)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('rejects a blank (whitespace-only) label', async () => {
    const res = await postKey({ label: '   ' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/label/)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('accepts valid rates and policy at the boundary', async () => {
    mockCreate.mockImplementation(async ({ data }: any) => ({
      id: 'new-id', createdAt: new Date(), ratePerMin: 60, ratePerDay: 10000, ...data,
    }))
    const res = await postKey({ label: 'acme', ratePerMin: 60, ratePerDay: 60, overagePolicy: 'charge_402' })
    expect(res.statusCode).toBe(201)
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })

  it('revokes a key by id', async () => {
    mockFindUnique.mockResolvedValue({ id: 'key-1', revokedAt: null })
    mockUpdate.mockResolvedValue({ id: 'key-1', revokedAt: new Date() })
    const app = await buildAdminApp()
    const res = await app.inject({
      method: 'DELETE',
      url: '/admin/keys/key-1',
      headers: { 'x-admin-token': 'admin-secret' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: 'key-1', revoked: true })
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: 'key-1' },
      data: { revokedAt: expect.any(Date) },
    })
  })

  it('returns 404 revoking a non-existent key', async () => {
    mockFindUnique.mockResolvedValue(null)
    const app = await buildAdminApp()
    const res = await app.inject({
      method: 'DELETE',
      url: '/admin/keys/missing',
      headers: { 'x-admin-token': 'admin-secret' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('registers authentication counters in the Prometheus registry', async () => {
    const output = await register.metrics()
    expect(output).toContain('api_key_auth_failures_total')
    expect(output).toContain('admin_auth_failures_total')
  })
})
