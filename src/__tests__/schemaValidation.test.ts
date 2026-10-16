import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import Ajv from 'ajv'

const { mockQuery, mockGetCachedPrice, mockGetBestRoute, mockGetAggregatedPrice, mockGetDepth, mockGetImpact } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetCachedPrice: vi.fn(),
  mockGetBestRoute: vi.fn(),
  mockGetAggregatedPrice: vi.fn(),
  mockGetDepth: vi.fn(),
  mockGetImpact: vi.fn(),
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

vi.mock('../aggregator/vwap', () => ({
  getAggregatedPrice: mockGetAggregatedPrice,
}))

vi.mock('../pricing/depth', () => ({
  getDepth: mockGetDepth,
  getImpact: mockGetImpact,
}))

const { schemaTestPairs } = vi.hoisted(() => ({
  schemaTestPairs: [
    {
      pairKey: 'USDC/XLM',
      assetA: { code: 'XLM', issuer: null },
      assetB: { code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
    },
  ],
}))

vi.mock('../config', () => ({
  config: {
    pairs: schemaTestPairs,
    cache: { priceTtl: 10 },
  },
  activeNetwork: 'testnet',
  getNetworkConfig: (network: string) => ({
    pairs: network === 'testnet' ? schemaTestPairs : [],
  }),
}))

import { registerRESTRoutes } from '../api/rest'
import { priceResponseSchema } from '../api/schemas'

async function buildApp() {
  const app = Fastify({ logger: false })
  await registerRESTRoutes(app)
  await app.ready()
  return app
}

/** A valid aggregated-price payload matching getAggregatedPrice's return type. */
function validAggregate() {
  return {
    price: 0.1,
    sdexPrice: 0.1,
    ammPrice: 0.1,
    volume24h: 150,
    sdexVolume24h: 100,
    ammVolume24h: 50,
    vwap1m: 0.1,
    vwap5m: 0.1,
    vwap1h: 0.1,
    vwap24h: 0.1,
    priceChange24h: 1.1,
    sources: 2,
    confidence: 'high' as const,
    lastTradeAgeSeconds: 10,
    newestInputObservedAt: '2026-10-19T08:00:00.000Z',
    inputCount: 2,
    stalenessThresholdSeconds: 300,
    stale: false,
    excludedVenues: [] as string[],
    bestRoute: 'SDEX' as const,
  }
}

describe('REST response schema validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetCachedPrice.mockResolvedValue(null)
    mockGetBestRoute.mockResolvedValue({ route: 'SDEX' })
    mockGetDepth.mockResolvedValue({
      spotPrice: 0.1,
      executionPrice: 0.099,
      slippagePct: 1.0,
      asks: [],
      bids: [],
      source: 'AMM',
    })
    mockGetImpact.mockResolvedValue({
      status: 'ok',
      spotPrice: 0.1,
      availableLiquidity: 500,
      smallestSize: 100,
      ladder: [{ size: 100, output: 9.9, executionPrice: 0.099, slippagePct: 1 }],
      thresholds: [{ thresholdPct: 1, crossed: true, size: 100 }],
      source: 'AMM',
    })
  })

  it('returns 200 and a body that matches the declared /price schema', async () => {
    mockGetAggregatedPrice.mockResolvedValue(validAggregate())

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/price/XLM/USDC' })

    expect(res.statusCode).toBe(200)

    // The serialized body must independently satisfy the published schema.
    const ajv = new Ajv({ allErrors: true, allowUnionTypes: true })
    const validate = ajv.compile(priceResponseSchema as object)
    const ok = validate(res.json())
    // Surface a readable diff if the body ever drifts from the schema.
    expect(ok, ajv.errorsText(validate.errors)).toBe(true)
  })

  it('returns 200 and a body that matches the declared /price schema when string decimals are requested', async () => {
    mockGetAggregatedPrice.mockResolvedValue({
      ...validAggregate(),
      price: '0.123456789012345678',
      sdexPrice: '0.123456789012345678',
      ammPrice: '0.123456789012345678',
      volume24h: '150.000000000000000000',
      sdexVolume24h: '100.000000000000000000',
      ammVolume24h: '50.000000000000000000',
      vwap1m: '0.123456789012345678',
      vwap5m: '0.123456789012345678',
      vwap1h: '0.123456789012345678',
      vwap24h: '0.123456789012345678',
      priceChange24h: '1.100000000000000000',
    })

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/price/XLM/USDC',
      headers: { 'x-decimal-format': 'string' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.headers['x-decimal-format']).toBe('string')
    const body = res.json()
    expect(body.price).toBe('0.123456789012345678')

    const ajv = new Ajv({ allErrors: true, allowUnionTypes: true })
    const validate = ajv.compile(priceResponseSchema as object)
    const ok = validate(body)
    expect(ok, ajv.errorsText(validate.errors)).toBe(true)
  })

  it('fails (500) when the response grows an undeclared field', async () => {
    // Simulate an accidental shape change: an extra property leaks into the body.
    mockGetAggregatedPrice.mockResolvedValue({
      ...validAggregate(),
      surpriseField: 'should not be here',
    })

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/price/XLM/USDC' })

    // additionalProperties: false → serializer validation throws → 500.
    expect(res.statusCode).toBe(500)
  })

  it('fails (500) when a field changes type', async () => {
    // confidence must be one of the enum strings; a number is a shape break.
    mockGetAggregatedPrice.mockResolvedValue({
      ...validAggregate(),
      confidence: 42 as unknown as 'high',
    })

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/price/XLM/USDC' })

    expect(res.statusCode).toBe(500)
  })

  it('returns a schema-valid adaptive impact response', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/impact/XLM/USDC?thresholds=1' })

    expect(res.statusCode).toBe(200)
    expect(res.json().thresholds).toEqual([{ thresholdPct: 1, crossed: true, size: 100 }])
  })
})
