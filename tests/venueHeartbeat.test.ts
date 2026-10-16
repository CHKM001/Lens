/**
 * Venue heartbeat tests — Issue #219
 *
 * Acceptance criteria covered:
 *   ✓ Every venue reports last-success, last-write and consecutive-failure count
 *   ✓ Stale venue prices are excluded from aggregates, and responses say a venue
 *     was excluded
 *   ✓ /status and /metrics both expose heartbeat data
 *   ✓ A test drives a venue to stale and asserts it leaves the aggregate
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { mockQuery, mockGetCachedPrice, mockGetBestRoute } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetCachedPrice: vi.fn(),
  mockGetBestRoute: vi.fn(),
}))

vi.mock('../src/db', () => ({
  pgPool: { query: mockQuery },
}))

vi.mock('../src/redis', () => ({
  getCachedPrice: mockGetCachedPrice,
  setCachedPrice: vi.fn(),
}))

vi.mock('../src/aggregator/bestRoute', () => ({
  getBestRoute: mockGetBestRoute,
}))

const { heartbeatTestPairs } = vi.hoisted(() => ({
  heartbeatTestPairs: [
    {
      pairKey: 'USDC/XLM',
      assetA: { code: 'XLM', issuer: null },
      assetB: { code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
    },
  ],
}))

vi.mock('../src/config', () => ({
  config: {
    pairs: heartbeatTestPairs,
    cache: { priceTtl: 10 },
  },
  activeNetwork: 'testnet',
  getNetworkConfig: (network: string) => ({
    pairs: network === 'testnet' ? heartbeatTestPairs : [],
  }),
}))

// ── Imports ───────────────────────────────────────────────────────────────────

import {
  recordVenueSuccess,
  recordVenueReadSuccess,
  recordVenueWrite,
  recordVenueFailure,
  getHeartbeat,
  getStaleVenues,
  isVenueStale,
  getAllHeartbeats,
  _resetHeartbeats,
  DEFAULT_STALENESS_MS,
} from '../src/venueHeartbeat'
import { register, venue_last_success_timestamp, venue_last_write_timestamp, venue_consecutive_failures } from '../src/metrics'
import { registerRESTRoutes } from '../src/api/rest'

// ── Helpers ───────────────────────────────────────────────────────────────────

async function buildApp() {
  const app = Fastify({ logger: false })
  await registerRESTRoutes(app)
  await app.ready()
  return app
}

/**
 * Standard mock implementation for the /price route's DB queries.
 * Passes through to a fresh-venue state (no stale sources).
 */
function mockFreshQueries(recentTrade?: string) {
  const tradeTs = recentTrade ?? new Date(Date.now() - 60_000).toISOString() // 1 min ago
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('AVG(spot_price::numeric)')) return { rows: [{ amm_price: '0.1' }] }
    if (sql.includes('last_trade FROM price_points')) return { rows: [{ last_trade: tradeTs }] }
    if (sql.includes('GROUP BY source')) return { rows: [{ source: 'SDEX', vol: '100' }] }
    if (sql.includes('COUNT(DISTINCT COALESCE(pool_id')) return { rows: [{ sources: '1' }] }
    if (sql.includes('SUM(price::numeric * base_volume::numeric)')) return { rows: [{ vwap: '0.1' }] }
    if (sql.includes('price_24h_ago')) return { rows: [{ price_24h_ago: '0.09', price_now: '0.1' }] }
    if (sql.includes('indexer_state')) return { rows: [] }
    return { rows: [] }
  })
}

// ── Heartbeat unit tests ───────────────────────────────────────────────────────

describe('venueHeartbeat unit', () => {
  beforeEach(() => {
    _resetHeartbeats()
    vi.clearAllMocks()
  })

  it('starts with no heartbeat for an unknown venue', () => {
    const hb = getHeartbeat('SDEX', 'testnet')
    expect(hb.lastSuccess).toBeNull()
    expect(hb.lastWrite).toBeNull()
    expect(hb.consecutiveFailures).toBe(0)
  })

  it('recordVenueSuccess sets lastSuccess and lastWrite, resets failures', () => {
    // prime with some failures first
    recordVenueFailure('SDEX', 'testnet')
    recordVenueFailure('SDEX', 'testnet')

    recordVenueSuccess('SDEX', 'testnet')

    const hb = getHeartbeat('SDEX', 'testnet')
    expect(hb.lastSuccess).not.toBeNull()
    expect(hb.lastWrite).not.toBeNull()
    expect(hb.consecutiveFailures).toBe(0)
  })

  it('recordVenueReadSuccess moves lastSuccess but leaves lastWrite untouched', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    recordVenueSuccess('SDEX', 'testnet')
    const write = getHeartbeat('SDEX', 'testnet').lastWrite
    vi.useRealTimers()

    // A later poll that reads successfully but has nothing new to write.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:02:00Z'))
    recordVenueReadSuccess('SDEX', 'testnet')
    vi.useRealTimers()

    const hb = getHeartbeat('SDEX', 'testnet')
    expect(hb.lastSuccess).toBe(new Date('2026-01-01T00:02:00Z').toISOString())
    // Price age (lastWrite) is unchanged: no new rows were produced.
    expect(hb.lastWrite).toBe(write)
    expect(hb.consecutiveFailures).toBe(0)
  })

  it('recordVenueWrite moves lastWrite without touching lastSuccess', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    recordVenueReadSuccess('SDEX', 'testnet')
    const read = getHeartbeat('SDEX', 'testnet').lastSuccess
    vi.useRealTimers()

    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:01:00Z'))
    recordVenueWrite('SDEX', 'testnet')
    vi.useRealTimers()

    const hb = getHeartbeat('SDEX', 'testnet')
    expect(hb.lastSuccess).toBe(read)
    expect(hb.lastWrite).toBe(new Date('2026-01-01T00:01:00Z').toISOString())
  })

  it('a quiet venue (fresh reads, old writes) still reads as alive but its price is stale', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    recordVenueSuccess('SDEX', 'testnet') // wrote a price
    vi.useRealTimers()

    // Reads keep succeeding for 10 minutes, but nothing new is written.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:10:00Z'))
    recordVenueReadSuccess('SDEX', 'testnet')
    vi.useRealTimers()

    const hb = getHeartbeat('SDEX', 'testnet')
    // The operator can see the adapter is alive (recent read, zero failures)…
    expect(hb.lastSuccess).not.toBeNull()
    expect(hb.consecutiveFailures).toBe(0)
    // …but its written price has aged past the bound and must be excluded.
    expect(isVenueStale('SDEX', 'testnet')).toBe(true)
    expect(getStaleVenues('testnet')).toContain('SDEX')
  })

  it('recordVenueFailure increments consecutiveFailures without clearing timestamps', () => {
    recordVenueSuccess('AMM', 'mainnet')
    const { lastSuccess } = getHeartbeat('AMM', 'mainnet')

    recordVenueFailure('AMM', 'mainnet')
    recordVenueFailure('AMM', 'mainnet')

    const hb = getHeartbeat('AMM', 'mainnet')
    expect(hb.consecutiveFailures).toBe(2)
    // lastSuccess is preserved so callers can see when the last good data arrived
    expect(hb.lastSuccess).toBe(lastSuccess)
  })

  it('different (venue, network) pairs are tracked independently', () => {
    recordVenueSuccess('SDEX', 'testnet')
    recordVenueFailure('SDEX', 'mainnet')
    recordVenueFailure('AMM', 'testnet')

    expect(getHeartbeat('SDEX', 'testnet').consecutiveFailures).toBe(0)
    expect(getHeartbeat('SDEX', 'mainnet').consecutiveFailures).toBe(1)
    expect(getHeartbeat('AMM', 'testnet').consecutiveFailures).toBe(1)
  })

  it('isVenueStale returns false for venues with no heartbeat entry', () => {
    // A venue that has never polled should NOT be treated as stale; it may
    // simply not apply to this pair or be in its first cycle.
    expect(isVenueStale('soroswap_amm', 'testnet')).toBe(false)
  })

  it('isVenueStale returns true after the staleness threshold elapses', () => {
    // Simulate a success 10 minutes ago by back-dating the registry entry
    recordVenueSuccess('SDEX', 'testnet')
    const hb = getHeartbeat('SDEX', 'testnet')

    // Manually push lastSuccess into the past
    const staleTime = new Date(Date.now() - DEFAULT_STALENESS_MS - 1000).toISOString()
    // @ts-expect-error — internal access for test
    const registry = (globalThis as any).__venueHeartbeatRegistry
    // The registry is module-internal, so drive it through the public API:
    // recordVenueFailure does not change lastSuccess, so we use success again
    // but fake the time by using vi.useFakeTimers.
    vi.useFakeTimers()
    vi.setSystemTime(new Date(Date.now() - DEFAULT_STALENESS_MS - 1000))
    recordVenueSuccess('SDEX', 'testnet')
    vi.useRealTimers()

    expect(isVenueStale('SDEX', 'testnet')).toBe(true)
  })

  it('getStaleVenues returns the names of stale venues on the given network', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(Date.now() - DEFAULT_STALENESS_MS - 1000))
    recordVenueSuccess('SDEX', 'testnet')
    recordVenueSuccess('AMM', 'testnet')
    vi.useRealTimers()

    // A fresh venue on the same network
    recordVenueSuccess('aquarius_amm', 'testnet')

    const stale = getStaleVenues('testnet')
    expect(stale).toContain('SDEX')
    expect(stale).toContain('AMM')
    expect(stale).not.toContain('aquarius_amm')
  })

  it('getAllHeartbeats returns all registered (venue, network) entries', () => {
    recordVenueSuccess('SDEX', 'testnet')
    recordVenueFailure('AMM', 'mainnet')

    const all = getAllHeartbeats()
    expect(all.find(h => h.venue === 'SDEX' && h.network === 'testnet')).toBeDefined()
    expect(all.find(h => h.venue === 'AMM' && h.network === 'mainnet')).toBeDefined()
  })
})

// ── Prometheus metric tests ────────────────────────────────────────────────────

describe('venue heartbeat Prometheus metrics', () => {
  beforeEach(() => {
    _resetHeartbeats()
    vi.clearAllMocks()
    venue_last_success_timestamp.reset()
    venue_last_write_timestamp.reset()
    venue_consecutive_failures.reset()
  })

  it('recordVenueSuccess sets venue_last_success_timestamp gauge', async () => {
    const before = Date.now() / 1000
    recordVenueSuccess('SDEX', 'testnet')
    const after = Date.now() / 1000

    const metric = await register.getSingleMetric('venue_last_success_timestamp')!.get()
    const series = metric.values.find(
      v => v.labels.venue === 'SDEX' && v.labels.network === 'testnet'
    )
    expect(series).toBeDefined()
    expect(series!.value).toBeGreaterThanOrEqual(before)
    expect(series!.value).toBeLessThanOrEqual(after + 1)
  })

  it('recordVenueWrite sets venue_last_write_timestamp gauge', async () => {
    const before = Date.now() / 1000
    recordVenueWrite('SDEX', 'testnet')
    const after = Date.now() / 1000

    const metric = await register.getSingleMetric('venue_last_write_timestamp')!.get()
    const series = metric.values.find(
      v => v.labels.venue === 'SDEX' && v.labels.network === 'testnet'
    )
    expect(series).toBeDefined()
    expect(series!.value).toBeGreaterThanOrEqual(before)
    expect(series!.value).toBeLessThanOrEqual(after + 1)
  })

  it('recordVenueFailure increments venue_consecutive_failures gauge', async () => {    recordVenueFailure('AMM', 'mainnet')
    recordVenueFailure('AMM', 'mainnet')

    const metric = await register.getSingleMetric('venue_consecutive_failures')!.get()
    const series = metric.values.find(
      v => v.labels.venue === 'AMM' && v.labels.network === 'mainnet'
    )
    expect(series).toBeDefined()
    expect(series!.value).toBe(2)
  })

  it('recordVenueSuccess resets venue_consecutive_failures to 0', async () => {
    recordVenueFailure('SDEX', 'testnet')
    recordVenueFailure('SDEX', 'testnet')
    recordVenueSuccess('SDEX', 'testnet')

    const metric = await register.getSingleMetric('venue_consecutive_failures')!.get()
    const series = metric.values.find(
      v => v.labels.venue === 'SDEX' && v.labels.network === 'testnet'
    )
    expect(series!.value).toBe(0)
  })

  it('/metrics endpoint exposes venue heartbeat gauges', async () => {
    recordVenueSuccess('SDEX', 'testnet')
    recordVenueFailure('AMM', 'testnet')

    const app = Fastify({ logger: false })
    app.get('/metrics', { config: { public: true } }, async (_req, reply) => {
      const { getMetrics } = await import('../src/metrics')
      reply.type('text/plain')
      return await getMetrics()
    })
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/metrics' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('venue_last_success_timestamp')
    expect(res.body).toContain('venue_last_write_timestamp')
    expect(res.body).toContain('venue_consecutive_failures')
  })
})

// ── /status heartbeat exposure ─────────────────────────────────────────────────

describe('/status venue heartbeats', () => {
  beforeEach(() => {
    _resetHeartbeats()
    vi.clearAllMocks()
    mockGetCachedPrice.mockResolvedValue(null)
    mockGetBestRoute.mockResolvedValue({ route: 'SDEX' })
    mockQuery.mockResolvedValue({ rows: [] })
  })

  it('returns an empty venueHeartbeats array when no adapters have polled', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/status' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.venueHeartbeats).toEqual([])
  })

  it('returns heartbeat data for venues that have polled', async () => {
    recordVenueSuccess('SDEX', 'testnet')
    recordVenueFailure('AMM', 'testnet')

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/status' })
    expect(res.statusCode).toBe(200)

    const body = res.json()
    const sdex = body.venueHeartbeats.find((h: any) => h.venue === 'SDEX')
    const amm = body.venueHeartbeats.find((h: any) => h.venue === 'AMM')

    expect(sdex).toBeDefined()
    expect(sdex.lastSuccess).not.toBeNull()
    expect(sdex.consecutiveFailures).toBe(0)

    expect(amm).toBeDefined()
    expect(amm.consecutiveFailures).toBe(1)
  })

  it('filters heartbeats to the requested network', async () => {
    recordVenueSuccess('SDEX', 'testnet')
    recordVenueSuccess('SDEX', 'mainnet')

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/status' })
    expect(res.statusCode).toBe(200)

    const body = res.json()
    // Default network is testnet (from our mock), so only testnet heartbeats appear
    for (const hb of body.venueHeartbeats) {
      expect(hb.network).toBe('testnet')
    }
  })
})

// ── Stale-venue exclusion from aggregation ─────────────────────────────────────

describe('stale venue exclusion from /price aggregate (AC: drive venue stale, assert excluded)', () => {
  beforeEach(() => {
    _resetHeartbeats()
    vi.clearAllMocks()
    mockGetCachedPrice.mockResolvedValue(null)
    mockGetBestRoute.mockResolvedValue({ route: 'SDEX' })
  })

  it('excludedVenues is empty when all venues are fresh', async () => {
    recordVenueSuccess('SDEX', 'testnet')
    recordVenueSuccess('AMM', 'testnet')
    mockFreshQueries()

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/price/XLM/USDC' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.excludedVenues).toEqual([])
  })

  it('drives a venue to stale and asserts it is excluded from the aggregate', async () => {
    // Both venues wrote data 10 minutes ago (beyond the 5-minute threshold)
    vi.useFakeTimers()
    vi.setSystemTime(new Date(Date.now() - DEFAULT_STALENESS_MS - 1000))
    recordVenueSuccess('SDEX', 'testnet')
    vi.useRealTimers()

    // AMM is fresh
    recordVenueSuccess('AMM', 'testnet')

    mockFreshQueries()

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/price/XLM/USDC' })
    expect(res.statusCode).toBe(200)
    const body = res.json()

    // SDEX is stale \u2014 must appear in excludedVenues
    expect(body.excludedVenues).toContain('SDEX')
    // AMM is fresh \u2014 must NOT appear
    expect(body.excludedVenues).not.toContain('AMM')

    // The SQL queries must include NOT IN ('SDEX') for the stale source
    const calls = mockQuery.mock.calls.map((c: any[]) => c[0] as string)
    const hasExclusion = calls.some(sql => sql.includes('NOT IN'))
    expect(hasExclusion).toBe(true)
  })

  it('excludes all venues when every registered venue is stale', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(Date.now() - DEFAULT_STALENESS_MS - 1000))
    recordVenueSuccess('SDEX', 'testnet')
    recordVenueSuccess('AMM', 'testnet')
    vi.useRealTimers()

    mockFreshQueries()

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/price/XLM/USDC' })
    expect(res.statusCode).toBe(200)
    const body = res.json()

    expect(body.excludedVenues).toContain('SDEX')
    expect(body.excludedVenues).toContain('AMM')
  })

  it('venues with no heartbeat are NOT excluded (first poll cycle grace)', async () => {
    // No heartbeats recorded at all — brand-new ingesters
    mockFreshQueries()

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/price/XLM/USDC' })
    expect(res.statusCode).toBe(200)
    const body = res.json()

    // No venue has been declared stale, so the exclusion list is empty
    expect(body.excludedVenues).toEqual([])
  })

  it('a venue that recovers from stale is no longer excluded', async () => {
    // Drive stale
    vi.useFakeTimers()
    vi.setSystemTime(new Date(Date.now() - DEFAULT_STALENESS_MS - 1000))
    recordVenueSuccess('SDEX', 'testnet')
    vi.useRealTimers()

    expect(isVenueStale('SDEX', 'testnet')).toBe(true)

    // Recovery: a successful poll brings it back
    recordVenueSuccess('SDEX', 'testnet')

    expect(isVenueStale('SDEX', 'testnet')).toBe(false)
    expect(getStaleVenues('testnet')).not.toContain('SDEX')
  })
})
