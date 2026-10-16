import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

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

const { stalenessTestPairs } = vi.hoisted(() => ({
  stalenessTestPairs: [
    {
      pairKey: 'USDC/XLM',
      assetA: { code: 'XLM', issuer: null },
      assetB: { code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
    },
  ],
}))

vi.mock('../src/config', () => ({
  config: {
    pairs: stalenessTestPairs,
    cache: { priceTtl: 10 },
    pricing: { staleThresholdSeconds: 300 },
  },
  activeNetwork: 'testnet',
  getNetworkConfig: (network: string) => ({
    pairs: network === 'testnet' ? stalenessTestPairs : [],
  }),
}))

import { registerRESTRoutes } from '../src/api/rest'
import { registerPriceRoutes } from '../src/routes/price'

async function buildApp() {
  const app = Fastify({ logger: false })
  await registerRESTRoutes(app)
  await registerPriceRoutes(app)
  await app.ready()
  return app
}

describe('stale price flag and freshness metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetCachedPrice.mockResolvedValue(null)
    mockGetBestRoute.mockResolvedValue({ route: 'SDEX' })
  })

  it('returns stale=true when last trade is older than 5 minutes', async () => {
    const now = new Date()
    const oldTrade = new Date(now.getTime() - 600000).toISOString() // 10m ago

    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('AVG(spot_price::numeric)')) return { rows: [{ amm_price: '0.1' }] }
      if (sql.includes('as last_observed_at')) return { rows: [{ last_observed_at: oldTrade, input_count: '5' }] }
      if (sql.includes('GROUP BY source')) return { rows: [{ source: 'SDEX', vol: '100' }] }
      if (sql.includes('COUNT(DISTINCT COALESCE(pool_id')) return { rows: [{ sources: '1' }] }
      if (sql.includes('SUM(price::numeric * base_volume::numeric)')) return { rows: [{ vwap: '0.1' }] }
      if (sql.includes('price_24h_ago')) return { rows: [{ price_24h_ago: '0.09', price_now: '0.1' }] }
      return { rows: [] }
    })

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/price/XLM/USDC' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.lastTradeAgeSeconds).toBeGreaterThan(300)
    expect(body.stale).toBe(true)
    expect(body.newestInputObservedAt).toBe(oldTrade)
    expect(body.inputCount).toBe(5)
    expect(body.stalenessThresholdSeconds).toBe(300)
  })

  it('returns stale=false when last trade is within 5 minutes', async () => {
    const now = new Date()
    const recentTrade = new Date(now.getTime() - 120000).toISOString() // 2m ago

    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('AVG(spot_price::numeric)')) return { rows: [{ amm_price: '0.1' }] }
      if (sql.includes('as last_observed_at')) return { rows: [{ last_observed_at: recentTrade, input_count: '3' }] }
      if (sql.includes('GROUP BY source')) return { rows: [{ source: 'SDEX', vol: '100' }] }
      if (sql.includes('COUNT(DISTINCT COALESCE(pool_id')) return { rows: [{ sources: '1' }] }
      if (sql.includes('SUM(price::numeric * base_volume::numeric)')) return { rows: [{ vwap: '0.1' }] }
      if (sql.includes('price_24h_ago')) return { rows: [{ price_24h_ago: '0.09', price_now: '0.1' }] }
      return { rows: [] }
    })

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/price/XLM/USDC' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.lastTradeAgeSeconds).toBeLessThan(300)
    expect(body.stale).toBe(false)
    expect(body.newestInputObservedAt).toBe(recentTrade)
    expect(body.inputCount).toBe(3)
    expect(body.stalenessThresholdSeconds).toBe(300)
  })

  it('returns stale=false when no trades exist', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('as last_observed_at')) return { rows: [{ last_observed_at: null, input_count: '0' }] }
      return { rows: [] }
    })

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/price/XLM/USDC' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.lastTradeAgeSeconds).toBeNull()
    expect(body.newestInputObservedAt).toBeNull()
    expect(body.inputCount).toBe(0)
    expect(body.stalenessThresholdSeconds).toBe(300)
    expect(body.stale).toBe(false)
  })

  it('freezes time and asserts the transition from fresh to stale on /price', async () => {
    const fixedNow = new Date('2026-10-19T12:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(fixedNow)

    try {
      // Trade happened 200 seconds before fixedNow (fresh under default 300s bound)
      const tradeTime = new Date(fixedNow.getTime() - 200_000).toISOString()

      mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes('AVG(spot_price::numeric)')) return { rows: [{ amm_price: '0.1' }] }
        if (sql.includes('as last_observed_at')) return { rows: [{ last_observed_at: tradeTime, input_count: '4' }] }
        if (sql.includes('GROUP BY source')) return { rows: [{ source: 'SDEX', vol: '100' }] }
        if (sql.includes('COUNT(DISTINCT COALESCE(pool_id')) return { rows: [{ sources: '1' }] }
        if (sql.includes('SUM(price::numeric * base_volume::numeric)')) return { rows: [{ vwap: '0.1' }] }
        if (sql.includes('price_24h_ago')) return { rows: [{ price_24h_ago: '0.09', price_now: '0.1' }] }
        return { rows: [] }
      })

      const app = await buildApp()

      // At T0: age is 200s, within 300s threshold -> stale is false
      const res1 = await app.inject({ method: 'GET', url: '/price/XLM/USDC' })
      expect(res1.statusCode).toBe(200)
      const body1 = res1.json()
      expect(body1.lastTradeAgeSeconds).toBe(200)
      expect(body1.stale).toBe(false)
      expect(body1.newestInputObservedAt).toBe(tradeTime)
      expect(body1.inputCount).toBe(4)
      expect(body1.stalenessThresholdSeconds).toBe(300)

      // Advance time by 105 seconds (age is now 305s > 300s threshold)
      vi.advanceTimersByTime(105_000)

      // At T0 + 105s: age is 305s -> transitions to stale = true
      const res2 = await app.inject({ method: 'GET', url: '/price/XLM/USDC' })
      expect(res2.statusCode).toBe(200)
      const body2 = res2.json()
      expect(body2.lastTradeAgeSeconds).toBe(305)
      expect(body2.stale).toBe(true)
      expect(body2.newestInputObservedAt).toBe(tradeTime)
      expect(body2.inputCount).toBe(4)
      expect(body2.stalenessThresholdSeconds).toBe(300)
    } finally {
      vi.useRealTimers()
    }
  })

  it('respects configurable staleThreshold query parameter on /price', async () => {
    const now = new Date()
    const tradeTime = new Date(now.getTime() - 200_000).toISOString() // 200s ago

    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('AVG(spot_price::numeric)')) return { rows: [{ amm_price: '0.1' }] }
      if (sql.includes('as last_observed_at')) return { rows: [{ last_observed_at: tradeTime, input_count: '2' }] }
      if (sql.includes('GROUP BY source')) return { rows: [{ source: 'SDEX', vol: '100' }] }
      if (sql.includes('COUNT(DISTINCT COALESCE(pool_id')) return { rows: [{ sources: '1' }] }
      if (sql.includes('SUM(price::numeric * base_volume::numeric)')) return { rows: [{ vwap: '0.1' }] }
      if (sql.includes('price_24h_ago')) return { rows: [{ price_24h_ago: '0.09', price_now: '0.1' }] }
      return { rows: [] }
    })

    const app = await buildApp()

    // Threshold 100s: 200s age > 100s threshold -> stale: true
    const resStale = await app.inject({ method: 'GET', url: '/price/XLM/USDC?staleThreshold=100' })
    expect(resStale.statusCode).toBe(200)
    const bodyStale = resStale.json()
    expect(bodyStale.stale).toBe(true)
    expect(bodyStale.stalenessThresholdSeconds).toBe(100)

    // Threshold 500s: 200s age < 500s threshold -> stale: false
    const resFresh = await app.inject({ method: 'GET', url: '/price/XLM/USDC?staleThreshold=500' })
    expect(resFresh.statusCode).toBe(200)
    const bodyFresh = resFresh.json()
    expect(bodyFresh.stale).toBe(false)
    expect(bodyFresh.stalenessThresholdSeconds).toBe(500)
  })

  it('freezes time and asserts staleness transition on TWAP endpoint', async () => {
    const fixedNow = new Date('2026-10-19T12:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(fixedNow)

    try {
      const t1 = new Date(fixedNow.getTime() - 250_000).toISOString()
      const t2 = new Date(fixedNow.getTime() - 200_000).toISOString()

      mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM price_points') && (sql.includes('ORDER BY timestamp ASC') || sql.includes('ORDER BY COALESCE(observed_at, timestamp) ASC'))) {
          return {
            rows: [
              { price: '0.10', timestamp: t1, observed_at: t1 },
              { price: '0.11', timestamp: t2, observed_at: t2 },
            ],
          }
        }
        return { rows: [] }
      })

      const app = await buildApp()

      // At T0: newest input is 200s old -> fresh
      const res1 = await app.inject({ method: 'GET', url: '/price/twap/XLM/USDC' })
      expect(res1.statusCode).toBe(200)
      const body1 = res1.json()
      expect(body1.stale).toBe(false)
      expect(body1.newestInputObservedAt).toBe(t2)
      expect(body1.inputCount).toBe(2)
      expect(body1.stalenessThresholdSeconds).toBe(300)

      // Advance time by 105s -> newest input is 305s old -> stale
      vi.advanceTimersByTime(105_000)

      const res2 = await app.inject({ method: 'GET', url: '/price/twap/XLM/USDC' })
      expect(res2.statusCode).toBe(200)
      const body2 = res2.json()
      expect(body2.stale).toBe(true)
      expect(body2.newestInputObservedAt).toBe(t2)
      expect(body2.inputCount).toBe(2)
      expect(body2.stalenessThresholdSeconds).toBe(300)

      // Query param override on TWAP
      const resOverride = await app.inject({ method: 'GET', url: '/price/twap/XLM/USDC?staleThreshold=500' })
      expect(resOverride.statusCode).toBe(200)
      const bodyOverride = resOverride.json()
      expect(bodyOverride.stale).toBe(false)
      expect(bodyOverride.stalenessThresholdSeconds).toBe(500)
    } finally {
      vi.useRealTimers()
    }
  })

  it('freezes time and asserts staleness transition on VWAP endpoint', async () => {
    const fixedNow = new Date('2026-10-19T12:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(fixedNow)

    try {
      const t1 = new Date(fixedNow.getTime() - 250_000).toISOString()
      const t2 = new Date(fixedNow.getTime() - 200_000).toISOString()

      mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM price_points') && (sql.includes('ORDER BY timestamp ASC') || sql.includes('ORDER BY COALESCE(observed_at, timestamp) ASC'))) {
          return {
            rows: [
              { price: '0.10', volume: '1000', timestamp: t1, observed_at: t1 },
              { price: '0.11', volume: '2000', timestamp: t2, observed_at: t2 },
            ],
          }
        }
        return { rows: [] }
      })

      const app = await buildApp()

      // At T0: newest input is 200s old -> fresh
      const res1 = await app.inject({ method: 'GET', url: '/price/vwap/XLM/USDC' })
      expect(res1.statusCode).toBe(200)
      const body1 = res1.json()
      expect(body1.stale).toBe(false)
      expect(body1.newestInputObservedAt).toBe(t2)
      expect(body1.inputCount).toBe(2)
      expect(body1.stalenessThresholdSeconds).toBe(300)

      // Advance time by 105s -> newest input is 305s old -> stale
      vi.advanceTimersByTime(105_000)

      const res2 = await app.inject({ method: 'GET', url: '/price/vwap/XLM/USDC' })
      expect(res2.statusCode).toBe(200)
      const body2 = res2.json()
      expect(body2.stale).toBe(true)
      expect(body2.newestInputObservedAt).toBe(t2)
      expect(body2.inputCount).toBe(2)
      expect(body2.stalenessThresholdSeconds).toBe(300)

      // Query param override on VWAP
      const resOverride = await app.inject({ method: 'GET', url: '/price/vwap/XLM/USDC?staleThreshold=500' })
      expect(resOverride.statusCode).toBe(200)
      const bodyOverride = resOverride.json()
      expect(bodyOverride.stale).toBe(false)
      expect(bodyOverride.stalenessThresholdSeconds).toBe(500)
    } finally {
      vi.useRealTimers()
    }
  })
})
