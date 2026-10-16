import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('../db', () => ({
  pgPool: { query: mockQuery },
}))

import {
  calculateVWAP,
  calculateOHLCV,
  getPriceChange24h,
  getAggregatedPrice,
  HIGH_CONFIDENCE_MAX_AGE_SECONDS,
  MEDIUM_CONFIDENCE_MAX_AGE_SECONDS,
} from '../aggregator/vwap'
import type { NetworkName } from '../config'

const PAIR = 'XLM/USDC'
const NETWORK: NetworkName = 'testnet'

describe('aggregator/vwap.ts', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  describe('exported constants', () => {
    it('exports HIGH_CONFIDENCE_MAX_AGE_SECONDS as 30', () => {
      expect(HIGH_CONFIDENCE_MAX_AGE_SECONDS).toBe(30)
    })

    it('exports MEDIUM_CONFIDENCE_MAX_AGE_SECONDS as 300', () => {
      expect(MEDIUM_CONFIDENCE_MAX_AGE_SECONDS).toBe(300)
    })
  })

  describe('calculateVWAP', () => {
    it('calculates VWAP without source filter', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ vwap: '0.125000' }],
      })

      const result = await calculateVWAP(PAIR, 60, NETWORK)

      expect(result).toBe(0.125)
      expect(mockQuery).toHaveBeenCalledTimes(1)
      const [sql, params] = mockQuery.mock.calls[0]
      expect(sql).toContain('WHERE pair_key = $1')
      expect(sql).toContain('AND network = $2')
      expect(sql).toContain("AND COALESCE(observed_at, timestamp) > NOW() - ($3 || ' minutes')::interval")
      expect(sql).not.toContain('AND source = $4')
      expect(params).toEqual([PAIR, NETWORK, 60])
    })

    it('calculates VWAP with source filter (SDEX)', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ vwap: '0.120000' }],
      })

      const result = await calculateVWAP(PAIR, 60, NETWORK, 'SDEX')

      expect(result).toBe(0.12)
      expect(mockQuery).toHaveBeenCalledTimes(1)
      const [sql, params] = mockQuery.mock.calls[0]
      expect(sql).toContain('AND source = $4')
      expect(params).toEqual([PAIR, NETWORK, 60, 'SDEX'])
    })

    it('calculates VWAP with source filter (AMM)', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ vwap: '0.130000' }],
      })

      const result = await calculateVWAP(PAIR, 15, NETWORK, 'AMM')

      expect(result).toBe(0.13)
      expect(mockQuery).toHaveBeenCalledTimes(1)
      const [sql, params] = mockQuery.mock.calls[0]
      expect(sql).toContain('AND source = $4')
      expect(params).toEqual([PAIR, NETWORK, 15, 'AMM'])
    })

    it('returns 0 when rows are empty or vwap is null', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] })
      const res1 = await calculateVWAP(PAIR, 60, NETWORK)
      expect(res1).toBe(0)

      mockQuery.mockResolvedValueOnce({ rows: [{ vwap: null }] })
      const res2 = await calculateVWAP(PAIR, 60, NETWORK)
      expect(res2).toBe(0)
    })
  })

  describe('calculateOHLCV', () => {
    it('returns mapped OHLCV metrics parsing numbers properly', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            open: '0.10',
            high: '0.15',
            low: '0.08',
            close: '0.12',
            volume: '15000.5',
            trade_count: '42',
          },
        ],
      })

      const result = await calculateOHLCV(PAIR, 60, NETWORK)

      expect(result).toEqual({
        open: 0.1,
        high: 0.15,
        low: 0.08,
        close: 0.12,
        volume: 15000.5,
        tradeCount: 42,
      })
      const [sql, params] = mockQuery.mock.calls[0]
      expect(sql).toContain('AS open')
      expect(sql).toContain('MAX(price::numeric) AS high')
      expect(sql).toContain('MIN(price::numeric) AS low')
      expect(sql).toContain('AS close')
      expect(sql).toContain('SUM(base_volume::numeric) AS volume')
      expect(sql).toContain('COUNT(*) AS trade_count')
      expect(params).toEqual([PAIR, NETWORK, 60])
    })

    it('defaults fields to 0 when query returns no row or null values', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] })

      const result = await calculateOHLCV(PAIR, 60, NETWORK)

      expect(result).toEqual({
        open: 0,
        high: 0,
        low: 0,
        close: 0,
        volume: 0,
        tradeCount: 0,
      })
    })
  })

  describe('getPriceChange24h', () => {
    it('computes 24h percentage change when price_24h_ago > 0', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ price_24h_ago: '100', price_now: '125' }],
      })

      const change = await getPriceChange24h(PAIR, NETWORK)

      expect(change).toBe(25)
      const [sql, params] = mockQuery.mock.calls[0]
      expect(sql).toContain("INTERVAL '24 hours'")
      expect(params).toEqual([PAIR, NETWORK])
    })

    it('returns negative percentage change when price dropped', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ price_24h_ago: '100', price_now: '75' }],
      })

      const change = await getPriceChange24h(PAIR, NETWORK)

      expect(change).toBe(-25)
    })

    it('returns 0 when price_24h_ago is 0 or missing (prevent division by zero)', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ price_24h_ago: '0', price_now: '100' }],
      })
      expect(await getPriceChange24h(PAIR, NETWORK)).toBe(0)

      mockQuery.mockResolvedValueOnce({ rows: [] })
      expect(await getPriceChange24h(PAIR, NETWORK)).toBe(0)
    })
  })

  describe('getAggregatedPrice', () => {
    function setupAggregatedPriceMocks(options: {
      vwap1m?: number
      vwap5m?: number
      vwap1h?: number
      vwap24h?: number
      sdexVwap24h?: number
      priceChange24h?: number
      ammPrice?: number
      lastTradeDate?: Date | null
      sdexVol?: number
      ammVol?: number
      sources?: number
    }) {
      const {
        vwap1m = 0,
        vwap5m = 0,
        vwap1h = 0,
        vwap24h = 0,
        sdexVwap24h = 0,
        priceChange24h = 0,
        ammPrice = 0,
        lastTradeDate = null,
        sdexVol = 0,
        ammVol = 0,
        sources = 0,
      } = options

      mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
        // vwap queries:
        if (sql.includes('SUM(price::numeric * base_volume::numeric)')) {
          const windowMin = params[2]
          const isSourceSDEX = sql.includes('AND source = $4') && params[3] === 'SDEX'

          if (isSourceSDEX && windowMin === 1440) {
            return { rows: [{ vwap: String(sdexVwap24h) }] }
          }
          if (windowMin === 1) return { rows: [{ vwap: String(vwap1m) }] }
          if (windowMin === 5) return { rows: [{ vwap: String(vwap5m) }] }
          if (windowMin === 60) return { rows: [{ vwap: String(vwap1h) }] }
          if (windowMin === 1440) return { rows: [{ vwap: String(vwap24h) }] }
          return { rows: [{ vwap: '0' }] }
        }

        // 24h price change
        if (sql.includes('price_24h_ago')) {
          return { rows: [{ price_24h_ago: '100', price_now: String(100 + priceChange24h) }] }
        }

        // AMM spot query
        if (sql.includes('AVG(spot_price::numeric) AS amm_price')) {
          return { rows: [{ amm_price: String(ammPrice) }] }
        }

        // Last trade timestamp
        if (sql.includes('as last_observed_at')) {
          return { rows: [{ last_observed_at: lastTradeDate ? lastTradeDate.toISOString() : null }] }
        }

        // Volume by source
        if (sql.includes('GROUP BY source')) {
          return {
            rows: [
              { source: 'SDEX', vol: String(sdexVol) },
              { source: 'AMM', vol: String(ammVol) },
            ],
          }
        }

        // Sources count
        if (sql.includes('COUNT(DISTINCT COALESCE(pool_id')) {
          return { rows: [{ sources: String(sources) }] }
        }

        throw new Error(`Unexpected query in test: ${sql}`)
      })
    }

    describe('fallback chain: vwap1h || vwap24h || ammPrice || 0', () => {
      it('uses vwap1h when available', async () => {
        setupAggregatedPriceMocks({
          vwap1h: 1.5,
          vwap24h: 1.4,
          ammPrice: 1.3,
        })

        const res = await getAggregatedPrice(PAIR, NETWORK)
        expect(res.price).toBe(1.5)
        expect(res.vwap1h).toBe(1.5)
        expect(res.vwap24h).toBe(1.4)
        expect(res.ammPrice).toBe(1.3)
      })

      it('falls back to vwap24h when vwap1h is 0', async () => {
        setupAggregatedPriceMocks({
          vwap1h: 0,
          vwap24h: 1.4,
          ammPrice: 1.3,
        })

        const res = await getAggregatedPrice(PAIR, NETWORK)
        expect(res.price).toBe(1.4)
      })

      it('falls back to ammPrice when both vwap1h and vwap24h are 0', async () => {
        setupAggregatedPriceMocks({
          vwap1h: 0,
          vwap24h: 0,
          ammPrice: 1.3,
        })

        const res = await getAggregatedPrice(PAIR, NETWORK)
        expect(res.price).toBe(1.3)
      })

      it('falls back to 0 when vwap1h, vwap24h, and ammPrice are all 0', async () => {
        setupAggregatedPriceMocks({
          vwap1h: 0,
          vwap24h: 0,
          ammPrice: 0,
        })

        const res = await getAggregatedPrice(PAIR, NETWORK)
        expect(res.price).toBe(0)
      })
    })

    describe('confidence ladder boundaries', () => {
      const FIXED_NOW = 1700000000000

      beforeEach(() => {
        vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW)
      })

      // Boundary 1: null age -> unknown
      it('returns confidence="unknown" and lastTradeAgeSeconds=null when lastTrade is null', async () => {
        setupAggregatedPriceMocks({
          lastTradeDate: null,
          sources: 5,
          sdexVol: 100,
        })

        const res = await getAggregatedPrice(PAIR, NETWORK)
        expect(res.lastTradeAgeSeconds).toBeNull()
        expect(res.confidence).toBe('unknown')
      })

      // Boundary 2: age = 29s (< HIGH_CONFIDENCE_MAX_AGE_SECONDS = 30)
      it('returns confidence="high" at age = 29s (< 30) when sources > 1 and volume24h > 0', async () => {
        const tradeTime = new Date(FIXED_NOW - 29 * 1000)
        setupAggregatedPriceMocks({
          lastTradeDate: tradeTime,
          sources: 2,
          sdexVol: 10,
        })

        const res = await getAggregatedPrice(PAIR, NETWORK)
        expect(res.lastTradeAgeSeconds).toBe(29)
        expect(res.confidence).toBe('high')
      })

      // Boundary 3: age = 30s (= HIGH_CONFIDENCE_MAX_AGE_SECONDS)
      it('returns confidence="medium" at age = 30s (boundary of high threshold) even with multiple sources and volume', async () => {
        const tradeTime = new Date(FIXED_NOW - 30 * 1000)
        setupAggregatedPriceMocks({
          lastTradeDate: tradeTime,
          sources: 2,
          sdexVol: 10,
        })

        const res = await getAggregatedPrice(PAIR, NETWORK)
        expect(res.lastTradeAgeSeconds).toBe(30)
        expect(res.confidence).toBe('medium')
      })

      // Boundary 4: age < 30s but sources <= 1 -> falls to medium
      it('returns confidence="medium" at age < 30s when sources <= 1', async () => {
        const tradeTime = new Date(FIXED_NOW - 10 * 1000)
        setupAggregatedPriceMocks({
          lastTradeDate: tradeTime,
          sources: 1,
          sdexVol: 100,
        })

        const res = await getAggregatedPrice(PAIR, NETWORK)
        expect(res.lastTradeAgeSeconds).toBe(10)
        expect(res.confidence).toBe('medium')
      })

      // Boundary 5: age < 30s but volume24h <= 0 -> falls to medium
      it('returns confidence="medium" at age < 30s when volume24h is 0', async () => {
        const tradeTime = new Date(FIXED_NOW - 10 * 1000)
        setupAggregatedPriceMocks({
          lastTradeDate: tradeTime,
          sources: 2,
          sdexVol: 0,
          ammVol: 0,
        })

        const res = await getAggregatedPrice(PAIR, NETWORK)
        expect(res.lastTradeAgeSeconds).toBe(10)
        expect(res.confidence).toBe('medium')
      })

      // Boundary 6: age = 299s (< MEDIUM_CONFIDENCE_MAX_AGE_SECONDS = 300)
      it('returns confidence="medium" at age = 299s (< 300)', async () => {
        const tradeTime = new Date(FIXED_NOW - 299 * 1000)
        setupAggregatedPriceMocks({
          lastTradeDate: tradeTime,
          sources: 1,
          sdexVol: 0,
        })

        const res = await getAggregatedPrice(PAIR, NETWORK)
        expect(res.lastTradeAgeSeconds).toBe(299)
        expect(res.confidence).toBe('medium')
      })

      // Boundary 7: age = 300s (= MEDIUM_CONFIDENCE_MAX_AGE_SECONDS)
      it('returns confidence="low" at age = 300s (boundary of medium threshold)', async () => {
        const tradeTime = new Date(FIXED_NOW - 300 * 1000)
        setupAggregatedPriceMocks({
          lastTradeDate: tradeTime,
          sources: 3,
          sdexVol: 1000,
        })

        const res = await getAggregatedPrice(PAIR, NETWORK)
        expect(res.lastTradeAgeSeconds).toBe(300)
        expect(res.confidence).toBe('low')
      })

      // Boundary 8: age > 300s -> low
      it('returns confidence="low" at age > 300s', async () => {
        const tradeTime = new Date(FIXED_NOW - 500 * 1000)
        setupAggregatedPriceMocks({
          lastTradeDate: tradeTime,
          sources: 2,
          sdexVol: 50,
        })

        const res = await getAggregatedPrice(PAIR, NETWORK)
        expect(res.lastTradeAgeSeconds).toBe(500)
        expect(res.confidence).toBe('low')
      })
    })

    describe('stale boundary at exactly 299 and 300 seconds', () => {
      const FIXED_NOW = 1700000000000

      beforeEach(() => {
        vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW)
      })

      it('asserts stale is false at exactly 299 seconds', async () => {
        const tradeTime = new Date(FIXED_NOW - 299 * 1000)
        setupAggregatedPriceMocks({
          lastTradeDate: tradeTime,
        })

        const res = await getAggregatedPrice(PAIR, NETWORK)
        expect(res.lastTradeAgeSeconds).toBe(299)
        expect(res.stale).toBe(false)
      })

      it('asserts stale is true at exactly 300 seconds', async () => {
        const tradeTime = new Date(FIXED_NOW - 300 * 1000)
        setupAggregatedPriceMocks({
          lastTradeDate: tradeTime,
        })

        const res = await getAggregatedPrice(PAIR, NETWORK)
        expect(res.lastTradeAgeSeconds).toBe(300)
        expect(res.stale).toBe(true)
      })

      it('asserts stale is false when lastTrade is null', async () => {
        setupAggregatedPriceMocks({
          lastTradeDate: null,
        })

        const res = await getAggregatedPrice(PAIR, NETWORK)
        expect(res.lastTradeAgeSeconds).toBeNull()
        expect(res.stale).toBe(false)
      })
    })

    describe('volume and source aggregation', () => {
      it('correctly aggregates SDEX and AMM volumes and reports sources count', async () => {
        setupAggregatedPriceMocks({
          sdexVol: 450.5,
          ammVol: 150.25,
          sources: 3,
        })

        const res = await getAggregatedPrice(PAIR, NETWORK)
        expect(res.sdexVolume24h).toBe(450.5)
        expect(res.ammVolume24h).toBe(150.25)
        expect(res.volume24h).toBe(600.75)
        expect(res.sources).toBe(3)
      })
    })
  })
})
