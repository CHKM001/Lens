import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../db', () => ({
  pgPool: { query: mockQuery },
}))

import { calculateVWAP, calculateOHLCV, getPriceChange24h, getAggregatedPrice } from '../aggregator/vwap'
import type { NetworkName } from '../config'

// ── A seeded stand-in for the two `price_points`/`pool_snapshots` tables ──────
//
// `price_points` and `pool_snapshots` both carry a `network` column, and the
// same pair key exists on both chains. These tests seed one pair on both
// networks with deliberately unrelated prices and assert the two come back
// apart — a query that forgets its network predicate returns the pooled
// average of the two markets, which is a number nobody traded at.

const PAIR = 'USDC/XLM'

interface SeedPoint {
  network: NetworkName
  pairKey: string
  source: 'SDEX' | 'AMM'
  price: number
  baseVolume: number
  ageSeconds: number
  poolId?: string
}

interface SeedPool {
  network: NetworkName
  poolId: string
  spotPrice: number
  reserveA: number
  reserveB: number
  feeBp: number
  ageSeconds: number
}

const points: SeedPoint[] = [
  { network: 'testnet', pairKey: PAIR, source: 'SDEX', price: 0.10, baseVolume: 100, ageSeconds: 23 * 3600 },
  { network: 'testnet', pairKey: PAIR, source: 'SDEX', price: 0.20, baseVolume: 300, ageSeconds: 120 },
  { network: 'testnet', pairKey: PAIR, source: 'SDEX', price: 0.25, baseVolume: 100, ageSeconds: 90 },
  { network: 'testnet', pairKey: PAIR, source: 'AMM', price: 0.30, baseVolume: 100, ageSeconds: 5, poolId: 'tn-pool' },
  { network: 'mainnet', pairKey: PAIR, source: 'SDEX', price: 0.50, baseVolume: 100, ageSeconds: 23 * 3600 },
  { network: 'mainnet', pairKey: PAIR, source: 'SDEX', price: 0.60, baseVolume: 100, ageSeconds: 120 },
  { network: 'mainnet', pairKey: PAIR, source: 'SDEX', price: 0.55, baseVolume: 300, ageSeconds: 90 },
  { network: 'mainnet', pairKey: PAIR, source: 'AMM', price: 0.45, baseVolume: 400, ageSeconds: 5, poolId: 'mn-pool' },
]

const pools: SeedPool[] = [
  { network: 'testnet', poolId: 'tn-pool', spotPrice: 0.30, reserveA: 10_000, reserveB: 3_000, feeBp: 30, ageSeconds: 5 },
  { network: 'mainnet', poolId: 'mn-pool', spotPrice: 0.45, reserveA: 10_000, reserveB: 4_500, feeBp: 30, ageSeconds: 5 },
]

const now = Date.now()
const at = (ageSeconds: number) => new Date(now - ageSeconds * 1000)

/**
 * Which network the query filters on, read out of the SQL itself.
 *
 * Returns null when the statement carries no `network = $n` predicate at all —
 * i.e. exactly the pre-fix behaviour, where every row on both chains was in
 * scope and the answer was a blend.
 */
function boundNetwork(sql: string, params: unknown[]): string | null {
  const m = sql.match(/network\s*=\s*\$(\d+)/i)
  return m ? String(params[Number(m[1]) - 1]) : null
}

/** The window the query limits itself to, in minutes, or null for no bound. */
function boundWindowMinutes(sql: string, params: unknown[]): number | null {
  const minutes = sql.match(/\(\$(\d+) \|\| ' minutes'\)::interval/)
  if (minutes) return Number(params[Number(minutes[1]) - 1])
  if (sql.includes("INTERVAL '24 hours'")) return 1440
  if (sql.includes("INTERVAL '1 hour'")) return 60
  return null
}

function rowsInWindow(network: string | null, pairKey: string, windowMinutes: number | null, source?: string) {
  return points.filter(
    p =>
      (network === null || p.network === network) &&
      p.pairKey === pairKey &&
      (source === undefined || p.source === source) &&
      (windowMinutes === null || p.ageSeconds <= windowMinutes * 60)
  )
}

function inWindow(ageSeconds: number, windowMinutes: number | null): boolean {
  return windowMinutes === null || ageSeconds <= windowMinutes * 60
}

function vwapOf(rows: SeedPoint[]): string {
  const numerator = rows.reduce((acc, r) => acc + r.price * r.baseVolume, 0)
  const denominator = rows.reduce((acc, r) => acc + r.baseVolume, 0)
  return String(denominator === 0 ? 0 : numerator / denominator)
}

function installSeededDb() {
  mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const network = boundNetwork(sql, params)
    const windowMinutes = boundWindowMinutes(sql, params)
    const pairKey = String(params[0])

    // 24h price change: oldest and newest price in the window.
    if (sql.includes('price_24h_ago')) {
      const rows = rowsInWindow(network, pairKey, windowMinutes)
      // Largest ageSeconds is the oldest row, matching `ORDER BY timestamp`.
      const sorted = [...rows].sort((a, b) => b.ageSeconds - a.ageSeconds)
      return {
        rows: [{
          price_24h_ago: String(sorted[0]?.price ?? 0),
          price_now: String(sorted[sorted.length - 1]?.price ?? 0),
        }],
      }
    }

    // Latest spot price per pool, averaged across the pools holding this pair.
    if (sql.includes('AVG(spot_price::numeric)')) {
      const poolIds = new Set(
        rowsInWindow(network, pairKey, null, 'AMM').map(p => p.poolId).filter((id): id is string => !!id)
      )
      const latest = pools
        .filter(p => (network === null || p.network === network) && poolIds.has(p.poolId) && inWindow(p.ageSeconds, windowMinutes))
        .sort((a, b) => a.ageSeconds - b.ageSeconds)
      const avg = latest.length === 0 ? 0 : latest.reduce((acc, p) => acc + p.spotPrice, 0) / latest.length
      return { rows: [{ amm_price: String(avg) }] }
    }

    if (sql.includes('as last_observed_at')) {
      const rows = rowsInWindow(network, pairKey, windowMinutes)
      const newest = rows.reduce<SeedPoint | undefined>((acc, r) => (!acc || r.ageSeconds < acc.ageSeconds ? r : acc), undefined)
      return { rows: [{ last_observed_at: newest ? at(newest.ageSeconds) : null }] }
    }

    if (sql.includes('COUNT(DISTINCT COALESCE(pool_id')) {
      const rows = rowsInWindow(network, pairKey, windowMinutes)
      const sources = new Set(rows.map(r => r.poolId ?? 'sdex'))
      return { rows: [{ sources: String(sources.size) }] }
    }

    if (sql.includes('GROUP BY source')) {
      const rows = rowsInWindow(network, pairKey, windowMinutes)
      const bySource = new Map<string, number>()
      for (const r of rows) bySource.set(r.source, (bySource.get(r.source) ?? 0) + r.baseVolume)
      return { rows: [...bySource].map(([source, vol]) => ({ source, vol: String(vol) })) }
    }

    // OHLCV: open/close bracket the window, high/low/volume/count cover it.
    if (sql.includes('AS high')) {
      const rows = rowsInWindow(network, pairKey, windowMinutes).sort((a, b) => b.ageSeconds - a.ageSeconds)
      const prices = rows.map(r => r.price)
      return {
        rows: [{
          open: prices[0],
          high: prices.length ? Math.max(...prices) : 0,
          low: prices.length ? Math.min(...prices) : 0,
          close: prices[prices.length - 1],
          volume: String(rows.reduce((acc, r) => acc + r.baseVolume, 0)),
          trade_count: String(rows.length),
        }],
      }
    }

    // VWAP, optionally narrowed to a single source.
    if (sql.includes('SUM(price::numeric * base_volume::numeric)')) {
      const source = sql.includes('AND source = $') ? String(params[3]) : undefined
      return { rows: [{ vwap: vwapOf(rowsInWindow(network, pairKey, windowMinutes, source)) }] }
    }

    throw new Error(`unhandled query: ${sql}`)
  })
}

describe('aggregator network scoping', () => {
  beforeEach(() => {
    mockQuery.mockReset()
    installSeededDb()
  })

  it('calculateVWAP returns a different price per network for the same pairKey', async () => {
    const testnet = await calculateVWAP(PAIR, 60, 'testnet')
    const mainnet = await calculateVWAP(PAIR, 60, 'mainnet')

    // Volume-weighted within each network only.
    expect(testnet).toBeCloseTo(0.23, 12)   // (0.20*300 + 0.25*100 + 0.30*100) / 500
    expect(mainnet).toBeCloseTo(0.50625, 12) // (0.60*100 + 0.55*300 + 0.45*400) / 800
    expect(testnet).not.toBe(mainnet)
    // The pooled answer a network-blind query returns is neither of them.
    expect(testnet).not.toBeCloseTo(0.4, 12)
    expect(mainnet).not.toBeCloseTo(0.4, 12)
  })

  it('calculateVWAP honours the source filter within one network', async () => {
    expect(await calculateVWAP(PAIR, 60, 'testnet', 'SDEX')).toBeCloseTo(0.2125, 12)   // 85 / 400
    expect(await calculateVWAP(PAIR, 60, 'mainnet', 'SDEX')).toBeCloseTo(0.5625, 12)   // 225 / 400
    expect(await calculateVWAP(PAIR, 60, 'testnet', 'AMM')).toBeCloseTo(0.30, 12)
    expect(await calculateVWAP(PAIR, 60, 'mainnet', 'AMM')).toBeCloseTo(0.45, 12)
  })

  it('calculateOHLCV reads only the requested network', async () => {
    const testnet = await calculateOHLCV(PAIR, 60, 'testnet')
    const mainnet = await calculateOHLCV(PAIR, 60, 'mainnet')

    expect(testnet).toEqual({ open: 0.20, high: 0.30, low: 0.20, close: 0.30, volume: 500, tradeCount: 3 })
    expect(mainnet).toEqual({ open: 0.60, high: 0.60, low: 0.45, close: 0.45, volume: 800, tradeCount: 3 })
  })

  it('getPriceChange24h compares a network against itself', async () => {
    // testnet: 0.10 -> 0.30, mainnet: 0.50 -> 0.45.
    expect(await getPriceChange24h(PAIR, 'testnet')).toBeCloseTo(200, 6)
    expect(await getPriceChange24h(PAIR, 'mainnet')).toBeCloseTo(-10, 6)
  })

  it('getAggregatedPrice prices each network from its own rows', async () => {
    const testnet = await getAggregatedPrice(PAIR, 'testnet')
    const mainnet = await getAggregatedPrice(PAIR, 'mainnet')

    expect(testnet.price).toBeCloseTo(0.23, 12)
    expect(mainnet.price).toBeCloseTo(0.50625, 12)
    expect(testnet.sdexPrice).toBeCloseTo(0.19, 12)   // 95 / 500
    expect(mainnet.sdexPrice).toBeCloseTo(0.55, 12)   // 275 / 500
    expect(testnet.ammPrice).toBeCloseTo(0.30, 12)    // tn-pool only
    expect(mainnet.ammPrice).toBeCloseTo(0.45, 12)    // mn-pool only
    expect(testnet.volume24h).toBeCloseTo(600, 6)     // 500 SDEX + 100 AMM
    expect(mainnet.volume24h).toBeCloseTo(900, 6)     // 500 SDEX + 400 AMM
    expect(testnet.priceChange24h).toBeCloseTo(200, 6)
    expect(mainnet.priceChange24h).toBeCloseTo(-10, 6)
  })

  it('binds the network as a query parameter on every statement it issues', async () => {
    await getAggregatedPrice(PAIR, 'mainnet')

    expect(mockQuery).toHaveBeenCalled()
    for (const [sql, params] of mockQuery.mock.calls) {
      expect(sql, `no network predicate in: ${sql}`).toMatch(/network\s*=\s*\$\d+/i)
      expect(params).toContain('mainnet')
    }
  })
})
