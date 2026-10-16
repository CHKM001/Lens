import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const { mockQuery, mockGetCachedPrice, mockSetCachedPrice, mockGetBestRoute, mockGetDepth } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetCachedPrice: vi.fn(),
  mockSetCachedPrice: vi.fn(),
  mockGetBestRoute: vi.fn(),
  mockGetDepth: vi.fn(),
}))

vi.mock('../src/db', () => ({
  pgPool: { query: mockQuery },
}))

vi.mock('../src/redis', () => ({
  getCachedPrice: mockGetCachedPrice,
  setCachedPrice: mockSetCachedPrice,
}))

vi.mock('../src/aggregator/bestRoute', () => ({
  getBestRoute: mockGetBestRoute,
}))

vi.mock('../src/pricing/depth', () => ({
  getDepth: mockGetDepth,
}))

const { decimalTestPairs } = vi.hoisted(() => ({
  decimalTestPairs: [
    {
      pairKey: 'USDC/XLM',
      assetA: { code: 'XLM', issuer: null },
      assetB: { code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
    },
  ],
}))

vi.mock('../src/config', () => ({
  config: {
    pairs: decimalTestPairs,
    cache: { priceTtl: 10 },
  },
  activeNetwork: 'testnet',
  getNetworkConfig: (network: string) => ({
    pairs: network === 'testnet' ? decimalTestPairs : [],
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

describe('Issue #248: Decimal values cross API boundary as JSON numbers', () => {
  const EIGHTEEN_DECIMAL_PRICE = '0.123456789012345678'

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetCachedPrice.mockResolvedValue(null)
    mockGetBestRoute.mockResolvedValue({
      route: 'SDEX',
      sdexPrice: 0.12345678901234568,
      ammPrice: 0.12,
      estimatedOutput: 123.45678901234568,
      slippagePct: 0.05,
      recommendation: 'SDEX is best',
    })
    mockGetDepth.mockResolvedValue({
      spotPrice: 0.12345678901234568,
      executionPrice: 0.123,
      slippagePct: 0.01,
      asks: [{ price: 0.12345678901234568, size: 1000 }],
      bids: [{ price: 0.12, size: 1000 }],
      source: 'BOTH',
    })
  })

  it('proves standard JavaScript Number loses precision on 18-decimal quantities', () => {
    // Demonstration of L097 / #248: A Decimal(36,18) converted to a JS double truncates
    const floatCoerced = Number(EIGHTEEN_DECIMAL_PRICE)
    expect(floatCoerced.toString()).not.toBe(EIGHTEEN_DECIMAL_PRICE)
    expect(floatCoerced.toString()).toBe('0.12345678901234568')
  })

  it('defaults to JSON numbers for backward compatibility when no header/query is sent', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM price_points') && sql.includes('AS vwap')) {
        return { rows: [{ vwap: EIGHTEEN_DECIMAL_PRICE }] }
      }
      if (sql.includes('AVG(spot_price::numeric) AS amm_price')) {
        return { rows: [{ amm_price: '0' }] }
      }
      if (sql.includes('as last_observed_at')) {
        return { rows: [{ last_observed_at: new Date() }] }
      }
      if (sql.includes('GROUP BY source')) {
        return { rows: [{ source: 'SDEX', vol: '150.5' }] }
      }
      if (sql.includes('COUNT(DISTINCT COALESCE(pool_id')) {
        return { rows: [{ sources: '2' }] }
      }
      return { rows: [] }
    })

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/price/XLM/USDC',
    })

    expect(res.statusCode).toBe(200)
    expect(res.headers['x-decimal-format']).toBeUndefined()

    const body = res.json()
    expect(typeof body.price).toBe('number')
    expect(typeof body.volume24h).toBe('number')
    // Standard double precision rounding
    expect(body.price).toBe(0.12345678901234568)
  })

  it('asserts an 18-decimal value survives a round trip intact with X-Decimal-Format: string', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM price_points') && sql.includes('AS vwap')) {
        return { rows: [{ vwap: EIGHTEEN_DECIMAL_PRICE }] }
      }
      if (sql.includes('AVG(spot_price::numeric) AS amm_price')) {
        return { rows: [{ amm_price: '0.000000000000000000' }] }
      }
      if (sql.includes('as last_observed_at')) {
        return { rows: [{ last_observed_at: new Date() }] }
      }
      if (sql.includes('GROUP BY source')) {
        return { rows: [{ source: 'SDEX', vol: '500.123456789012345678' }] }
      }
      if (sql.includes('COUNT(DISTINCT COALESCE(pool_id')) {
        return { rows: [{ sources: '3' }] }
      }
      return { rows: [] }
    })

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/price/XLM/USDC',
      headers: {
        'x-decimal-format': 'string',
      },
    })

    expect(res.statusCode).toBe(200)
    expect(res.headers['x-decimal-format']).toBe('string')

    // Character-by-character round trip assertion on the raw JSON body
    expect(res.body).toContain(`"price":"${EIGHTEEN_DECIMAL_PRICE}"`)

    const body = res.json()
    expect(typeof body.price).toBe('string')
    expect(body.price).toBe(EIGHTEEN_DECIMAL_PRICE)
    expect(body.vwap1h).toBe(EIGHTEEN_DECIMAL_PRICE)
    expect(typeof body.volume24h).toBe('string')
    expect(body.sdexVolume24h).toBe('500.123456789012345678')
  })

  it('negotiates decimal strings via Accept: application/json; decimals=strings', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM price_points') && sql.includes('AS vwap')) {
        return { rows: [{ vwap: EIGHTEEN_DECIMAL_PRICE }] }
      }
      if (sql.includes('AVG(spot_price::numeric) AS amm_price')) {
        return { rows: [{ amm_price: '0' }] }
      }
      if (sql.includes('as last_observed_at')) {
        return { rows: [{ last_observed_at: new Date() }] }
      }
      if (sql.includes('GROUP BY source')) {
        return { rows: [{ source: 'SDEX', vol: '100' }] }
      }
      if (sql.includes('COUNT(DISTINCT COALESCE(pool_id')) {
        return { rows: [{ sources: '1' }] }
      }
      return { rows: [] }
    })

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/price/XLM/USDC',
      headers: {
        accept: 'application/json; decimals=strings',
      },
    })

    expect(res.statusCode).toBe(200)
    expect(res.headers['x-decimal-format']).toBe('string')
    expect(res.json().price).toBe(EIGHTEEN_DECIMAL_PRICE)
  })

  it('negotiates decimal strings via ?decimals=strings query parameter', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM price_points') && sql.includes('AS vwap')) {
        return { rows: [{ vwap: EIGHTEEN_DECIMAL_PRICE }] }
      }
      if (sql.includes('AVG(spot_price::numeric) AS amm_price')) {
        return { rows: [{ amm_price: '0' }] }
      }
      if (sql.includes('as last_observed_at')) {
        return { rows: [{ last_observed_at: new Date() }] }
      }
      if (sql.includes('GROUP BY source')) {
        return { rows: [{ source: 'SDEX', vol: '100' }] }
      }
      if (sql.includes('COUNT(DISTINCT COALESCE(pool_id')) {
        return { rows: [{ sources: '1' }] }
      }
      return { rows: [] }
    })

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/price/XLM/USDC?decimals=strings',
    })

    expect(res.statusCode).toBe(200)
    expect(res.headers['x-decimal-format']).toBe('string')
    expect(res.json().price).toBe(EIGHTEEN_DECIMAL_PRICE)
  })

  it('isolates cache entries between number and string decimal formats', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM price_points') && sql.includes('AS vwap')) {
        return { rows: [{ vwap: EIGHTEEN_DECIMAL_PRICE }] }
      }
      if (sql.includes('AVG(spot_price::numeric) AS amm_price')) {
        return { rows: [{ amm_price: '0' }] }
      }
      if (sql.includes('as last_observed_at')) {
        return { rows: [{ last_observed_at: new Date() }] }
      }
      if (sql.includes('GROUP BY source')) {
        return { rows: [{ source: 'SDEX', vol: '100' }] }
      }
      if (sql.includes('COUNT(DISTINCT COALESCE(pool_id')) {
        return { rows: [{ sources: '1' }] }
      }
      return { rows: [] }
    })

    const app = await buildApp()

    // 1. Request with string decimals
    await app.inject({
      method: 'GET',
      url: '/price/XLM/USDC',
      headers: { 'x-decimal-format': 'string' },
    })

    expect(mockGetCachedPrice).toHaveBeenCalledWith('testnet:USDC/XLM:decimals_string')
    expect(mockSetCachedPrice).toHaveBeenCalledWith(
      'testnet:USDC/XLM:decimals_string',
      expect.objectContaining({ price: EIGHTEEN_DECIMAL_PRICE }),
      expect.any(Number)
    )

    // 2. Request with default number decimals
    await app.inject({
      method: 'GET',
      url: '/price/XLM/USDC',
    })

    expect(mockGetCachedPrice).toHaveBeenCalledWith('testnet:USDC/XLM')
    expect(mockSetCachedPrice).toHaveBeenCalledWith(
      'testnet:USDC/XLM',
      expect.objectContaining({ price: expect.any(Number) }),
      expect.any(Number)
    )
  })

  it('preserves 18-decimal values in TWAP and VWAP endpoints when string format is requested', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('price_points') && sql.includes('price::numeric as price')) {
        return {
          rows: [
            {
              price: EIGHTEEN_DECIMAL_PRICE,
              volume: '100.000000000000000000',
              timestamp: new Date(),
            },
          ],
        }
      }
      return { rows: [] }
    })

    const app = await buildApp()

    // TWAP
    const twapRes = await app.inject({
      method: 'GET',
      url: '/price/twap/XLM/USDC',
      headers: { 'x-decimal-format': 'string' },
    })
    expect(twapRes.statusCode).toBe(200)
    expect(twapRes.headers['x-decimal-format']).toBe('string')
    expect(twapRes.json().twap).toBe(EIGHTEEN_DECIMAL_PRICE)

    // VWAP
    const vwapRes = await app.inject({
      method: 'GET',
      url: '/price/vwap/XLM/USDC',
      headers: { 'x-decimal-format': 'string' },
    })
    expect(vwapRes.statusCode).toBe(200)
    expect(vwapRes.headers['x-decimal-format']).toBe('string')
    expect(vwapRes.json().vwap).toBe(EIGHTEEN_DECIMAL_PRICE)
    expect(vwapRes.json().volumeTotal).toBe('100.000000000000000000')
  })

  it('serializes decimal quantities as strings on /pools and /price/:a/:b/route', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('pool_snapshots')) {
        return {
          rows: [
            {
              pool_id: 'pool_123',
              asset_a: 'XLM',
              asset_b: 'USDC',
              reserve_a: '1000000.123456789012345678',
              reserve_b: '500000.987654321098765432',
              spot_price: EIGHTEEN_DECIMAL_PRICE,
              fee_bp: 30,
              timestamp: new Date().toISOString(),
            },
          ],
        }
      }
      return { rows: [] }
    })

    const app = await buildApp()

    // /pools
    const poolsRes = await app.inject({
      method: 'GET',
      url: '/pools',
      headers: { 'x-decimal-format': 'string' },
    })
    expect(poolsRes.statusCode).toBe(200)
    expect(poolsRes.headers['x-decimal-format']).toBe('string')
    const pool = poolsRes.json().pools[0]
    expect(pool.spot_price).toBe(EIGHTEEN_DECIMAL_PRICE)
    expect(pool.reserve_a).toBe('1000000.123456789012345678')
    expect(pool.reserve_b).toBe('500000.987654321098765432')

    // /route
    const routeRes = await app.inject({
      method: 'GET',
      url: '/price/XLM/USDC/route',
      headers: { 'x-decimal-format': 'string' },
    })
    expect(routeRes.statusCode).toBe(200)
    expect(routeRes.headers['x-decimal-format']).toBe('string')
    expect(typeof routeRes.json().sdexPrice).toBe('string')
    expect(typeof routeRes.json().estimatedOutput).toBe('string')
    expect(typeof routeRes.json().slippagePct).toBe('string')
  })

  it('preserves 18-decimal precision on volume24h and priceChange24h without IEEE-754 loss', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM price_points') && sql.includes('AS vwap')) {
        return { rows: [{ vwap: EIGHTEEN_DECIMAL_PRICE }] }
      }
      if (sql.includes('AVG(spot_price::numeric) AS amm_price')) {
        return { rows: [{ amm_price: '0.000000000000000000' }] }
      }
      if (sql.includes('as last_observed_at')) {
        return { rows: [{ last_observed_at: new Date() }] }
      }
      if (sql.includes('GROUP BY source')) {
        return {
          rows: [
            { source: 'SDEX', vol: '500.123456789012345678' },
            { source: 'AMM', vol: '100.000000000000000001' },
          ],
        }
      }
      if (sql.includes('price_24h_ago')) {
        return {
          rows: [
            {
              price_24h_ago: '100.000000000000000000',
              price_now: '150.123456789012345678',
            },
          ],
        }
      }
      if (sql.includes('COUNT(DISTINCT COALESCE(pool_id')) {
        return { rows: [{ sources: '2' }] }
      }
      return { rows: [] }
    })

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/price/XLM/USDC',
      headers: {
        'x-decimal-format': 'string',
      },
    })

    expect(res.statusCode).toBe(200)
    expect(res.headers['x-decimal-format']).toBe('string')
    const body = res.json()
    expect(body.sdexVolume24h).toBe('500.123456789012345678')
    expect(body.ammVolume24h).toBe('100.000000000000000001')
    // Exact 18-decimal sum with 0 floating-point loss:
    expect(body.volume24h).toBe('600.123456789012345679')
    // Exact 18-decimal percentage change:
    expect(body.priceChange24h).toBe('50.123456789012345678')
  })
})

