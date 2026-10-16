import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const { mockQuery, mockGetCachedPrice, mockGetBestRoute } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetCachedPrice: vi.fn(),
  mockGetBestRoute: vi.fn(),
}))

vi.mock('../db', () => ({
  pgPool: { query: mockQuery },
}))

vi.mock('../redis', () => ({
  getCachedPrice: mockGetCachedPrice,
  setCachedPrice: vi.fn(),
}))

vi.mock('../aggregator/bestRoute', () => ({
  getBestRoute: mockGetBestRoute,
}))

const { testnetPairs, mainnetPairs } = vi.hoisted(() => ({
  testnetPairs: [
    {
      pairKey: 'USDC/XLM',
      assetA: { code: 'XLM', issuer: null },
      assetB: { code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
    },
  ],
  mainnetPairs: [
    {
      pairKey: 'USDC/XLM',
      assetA: { code: 'XLM', issuer: null },
      assetB: { code: 'USDC', issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' },
    },
  ],
}))

vi.mock('../config', () => ({
  config: {
    pairs: testnetPairs,
    cache: { priceTtl: 10 },
  },
  activeNetwork: 'testnet',
  getNetworkConfig: (network: string) => ({
    pairs: network === 'mainnet' ? mainnetPairs : testnetPairs,
  }),
}))

import { registerRESTRoutes } from '../api/rest'
import { registerPriceRoutes } from '../routes/price'
import { registerNetworkSelector } from '../middleware/network'

async function buildApp() {
  const app = Fastify({ logger: false })
  // The real request path: the network selector resolves ?network onto
  // req.network, which is what the handler reads.
  await app.register(registerNetworkSelector)
  await registerRESTRoutes(app)
  await registerPriceRoutes(app)
  await app.ready()
  return app
}

describe('GET /price/:assetA/:assetB confidence score', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetCachedPrice.mockResolvedValue(null)
    mockGetBestRoute.mockResolvedValue({ route: 'SDEX' })
  })

  it('returns high confidence for recent trades with multiple sources', async () => {
    const now = new Date()
    const recent = new Date(now.getTime() - 10000).toISOString() // 10s ago

    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('AVG(spot_price::numeric)')) return { rows: [{ amm_price: '0.1' }] }
      if (sql.includes('MAX(timestamp) as last_trade')) return { rows: [{ last_trade: recent }] }
      if (sql.includes('GROUP BY source')) return { rows: [{ source: 'SDEX', vol: '100' }, { source: 'AMM', vol: '50' }] }
      if (sql.includes('COUNT(DISTINCT COALESCE(pool_id')) return { rows: [{ sources: '2' }] }
      if (sql.includes('SUM(price::numeric * base_volume::numeric)')) return { rows: [{ vwap: '0.1' }] }
      if (sql.includes('price_24h_ago')) return { rows: [{ price_24h_ago: '0.09', price_now: '0.1' }] }
      return { rows: [] }
    })

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/price/XLM/USDC' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.volume24h).toBeGreaterThan(0)
    expect(body.sources).toBe(2)
    expect(body.confidence).toBe('high')
    expect(body.lastTradeAgeSeconds).toBeLessThan(30)
  })

  it('returns medium confidence for trades within 5 minutes', async () => {
    const now = new Date()
    const twoMinAgo = new Date(now.getTime() - 120000).toISOString() // 2m ago

    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('AVG(spot_price::numeric)')) return { rows: [{ amm_price: '0.1' }] }
      if (sql.includes('MAX(timestamp) as last_trade')) return { rows: [{ last_trade: twoMinAgo }] }
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
    expect(body.confidence).toBe('medium')
  })

  it('returns low confidence for old trades', async () => {
    const now = new Date()
    const tenMinAgo = new Date(now.getTime() - 600000).toISOString() // 10m ago

    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('MAX(timestamp) as last_trade')) return { rows: [{ last_trade: tenMinAgo }] }
      if (sql.includes('COUNT(DISTINCT COALESCE(pool_id')) return { rows: [{ sources: '1' }] }
      if (sql.includes('GROUP BY source')) return { rows: [{ source: 'SDEX', vol: '100' }] }
      if (sql.includes('SUM(price::numeric * base_volume::numeric)')) return { rows: [{ vwap: '0.1' }] }
      if (sql.includes('price_24h_ago')) return { rows: [{ price_24h_ago: '0.09', price_now: '0.1' }] }
      return { rows: [] }
    })

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/price/XLM/USDC' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.confidence).toBe('low')
  })

  it('returns unknown confidence when no trades found', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('MAX(timestamp) as last_trade')) return { rows: [{ last_trade: null }] }
      return { rows: [] }
    })

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/price/XLM/USDC' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.confidence).toBe('unknown')
    expect(body.lastTradeAgeSeconds).toBeNull()
  })
})

describe('TWAP/VWAP Input Validation', () => {
  it('rejects TWAP with invalid window', async () => {
    const app = await buildApp()
    const res1 = await app.inject({ method: 'GET', url: '/price/twap/XLM/USDC?window=abc' })
    expect(res1.statusCode).toBe(400)
    expect(res1.json().code).toBe('VALIDATION_ERROR')
    const res2 = await app.inject({ method: 'GET', url: '/price/twap/XLM/USDC?window=0' })
    expect(res2.statusCode).toBe(400)
    expect(res2.json().code).toBe('VALIDATION_ERROR')
    const res3 = await app.inject({ method: 'GET', url: '/price/twap/XLM/USDC?window=99999' })
    expect(res3.statusCode).toBe(400)
    expect(res3.json().code).toBe('VALIDATION_ERROR')
  })

  it('rejects TWAP with invalid sampleInterval', async () => {
    const app = await buildApp()
    const res1 = await app.inject({ method: 'GET', url: '/price/twap/XLM/USDC?sampleInterval=abc' })
    expect(res1.statusCode).toBe(400)
    expect(res1.json().code).toBe('VALIDATION_ERROR')
  })

  it('rejects TWAP with invalid method', async () => {
    const app = await buildApp()
    const res1 = await app.inject({ method: 'GET', url: '/price/twap/XLM/USDC?method=bogus' })
    expect(res1.statusCode).toBe(400)
    const body = res1.json()
    expect(body.code).toBe('VALIDATION_ERROR')
    expect(body.error).toMatch(/Invalid method/)
  })

  it('rejects VWAP with invalid method', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/price/vwap/XLM/USDC?method=bogus' })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('VALIDATION_ERROR')
  })

  it('rejects VWAP with invalid window', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/price/vwap/XLM/USDC?window=abc' })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('VALIDATION_ERROR')
  })

  it('accepts boundary window values 1 and 1440', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const app = await buildApp()
    // window=1 and window=1440 are the schema bounds; both must pass validation
    // (computeTWAP is reached — it returns empty rows, which is fine here).
    for (const window of [1, 1440]) {
      const res = await app.inject({ method: 'GET', url: `/price/twap/XLM/USDC?window=${window}` })
      // 200 with empty data or 500 from empty computation — but never 400
      expect(res.statusCode).not.toBe(400)
    }
    await app.close()
  })
})

describe('TWAP/VWAP error handling', () => {
  // The pg driver puts the connection string in its error messages, so echoing
  // err.message would publish the Postgres credentials to any caller.
  it('returns 500 without leaking the database error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockQuery.mockRejectedValue(
      new Error('connection refused postgres://lens:hunter2@db.internal:5432/lens')
    )
    const app = await buildApp()

    for (const url of ['/price/twap/XLM/USDC', '/price/vwap/XLM/USDC']) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode).toBe(500)
      expect(res.body).not.toMatch(/hunter2/)
      expect(res.body).not.toMatch(/postgres:\/\//)
    }

    spy.mockRestore()
    await app.close()
  })
})

describe('GET /price/:assetA/:assetB network scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetCachedPrice.mockResolvedValue(null)
    mockGetBestRoute.mockResolvedValue({ route: 'SDEX' })
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('AVG(spot_price::numeric)')) return { rows: [{ amm_price: '0.1' }] }
      if (sql.includes('MAX(timestamp) as last_trade')) {
        return { rows: [{ last_trade: new Date(Date.now() - 10000).toISOString() }] }
      }
      if (sql.includes('GROUP BY source')) return { rows: [{ source: 'SDEX', vol: '100' }] }
      if (sql.includes('COUNT(DISTINCT COALESCE(pool_id')) return { rows: [{ sources: '1' }] }
      if (sql.includes('SUM(price::numeric * base_volume::numeric)')) return { rows: [{ vwap: '0.1' }] }
      if (sql.includes('price_24h_ago')) return { rows: [{ price_24h_ago: '0.09', price_now: '0.1' }] }
      return { rows: [] }
    })
  })

  it('scopes every DB read to the requested network and labels the response with it', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/price/XLM/USDC?network=mainnet' })

    expect(res.statusCode).toBe(200)
    expect(res.json().network).toBe('mainnet')

    // Every statement the request issued filters on — and binds — mainnet, so
    // the `network` field above describes where the numbers came from rather
    // than which network the request asked for.
    expect(mockQuery).toHaveBeenCalled()
    for (const [sql, params] of mockQuery.mock.calls) {
      expect(sql, `no network predicate in: ${sql}`).toMatch(/network\s*=\s*\$\d+/i)
      expect(params).toContain('mainnet')
    }
  })

  it('does not let a testnet request read mainnet rows', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/price/XLM/USDC?network=testnet' })

    expect(res.statusCode).toBe(200)
    expect(res.json().network).toBe('testnet')
    for (const params of mockQuery.mock.calls) {
      expect(params[1]).not.toContain('mainnet')
    }
  })

  it('serves the network-labelled payload the refresh worker cached', async () => {
    // The worker writes the same `${network}:${pairKey}` key this route reads,
    // and a cache hit is returned verbatim — so the cached payload's own
    // network field is what reaches the caller.
    mockGetCachedPrice.mockResolvedValue(JSON.stringify({
      assetA: 'XLM',
      assetB: 'USDC',
      pairKey: 'USDC/XLM',
      network: 'mainnet',
      price: 0.18,
      sdexPrice: 0.18,
      ammPrice: 0,
      volume24h: 0,
      sdexVolume24h: 0,
      ammVolume24h: 0,
      vwap1m: 0,
      vwap5m: 0,
      vwap1h: 0.18,
      vwap24h: 0.18,
      priceChange24h: 0,
      sources: 1,
      confidence: 'medium',
      lastTradeAgeSeconds: 60,
      stale: false,
      excludedVenues: [],
      bestRoute: 'SDEX',
      lastUpdated: '2026-09-27T00:00:00.000Z',
    }))

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/price/XLM/USDC?network=mainnet' })

    expect(res.statusCode).toBe(200)
    expect(res.headers['x-cache']).toBe('HIT')
    expect(mockGetCachedPrice).toHaveBeenCalledWith('mainnet:USDC/XLM')
    expect(res.json().network).toBe('mainnet')
    // Nothing was re-read from the database on a hit.
    expect(mockQuery).not.toHaveBeenCalled()
  })
})

describe('GET /price/twap/:assetA/:assetB network scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockQuery.mockResolvedValue({ rows: [] })
  })

  it('filters on network, passes it to query, and echoes network in response', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/price/twap/XLM/USDC?network=mainnet' })

    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(json.network).toBe('mainnet')

    expect(mockQuery).toHaveBeenCalled()
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toMatch(/network\s*=\s*\$3/i)
    expect(params[2]).toBe('mainnet')
  })

  it('rejects an invalid network parameter with 400', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/price/twap/XLM/USDC?network=invalidnet' })
    expect(res.statusCode).toBe(400)
  })

  it('defaults to activeNetwork when no network parameter is specified', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/price/twap/XLM/USDC' })

    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(json.network).toBe('testnet')

    expect(mockQuery).toHaveBeenCalled()
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toMatch(/network\s*=\s*\$3/i)
    expect(params[2]).toBe('testnet')
  })
})

