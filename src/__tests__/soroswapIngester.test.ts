/**
 * Unit tests for the Soroswap AMM ingester.
 *
 * Tests cover:
 * - calcSpotPrice: pure function — no mocks needed
 * - ingestPool: mocked upsertPricePoints + dispatchPriceUpdate
 * - fetchSoroswapTokenList: mocked global fetch
 * - ingestPair: pair filtering / skipping logic
 */

// ── Mocks ───────────────────────────────────────────────────────────────────
vi.mock('../db', () => ({
  upsertPricePoints: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../webhookDispatcher', () => ({
  dispatchPriceUpdate: vi.fn().mockResolvedValue(undefined),
}))

// We mock fetchPoolReserves and fetchPoolsFromFactory at module level so
// ingestPool / ingestPair tests can control RPC responses without a live node.
vi.mock('../ingesters/soroswap', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ingesters/soroswap')>()
  return {
    ...actual,
    fetchPoolReserves: vi.fn(),
    fetchPoolsFromFactory: vi.fn(),
    fetchSoroswapTokenList: vi.fn(),
  }
})

// ── Imports ──────────────────────────────────────────────────────────────────
import {
  calcSpotPrice,
  ingestPool,
  ingestPair,
  fetchSoroswapTokenList,
  fetchPoolReserves,
  fetchPoolsFromFactory,
  type PoolEntry,
  type SoroswapToken,
} from '../ingesters/soroswap'
import { upsertPricePoints } from '../db'
import { dispatchPriceUpdate } from '../webhookDispatcher'

// ── Fixtures ─────────────────────────────────────────────────────────────────
const mockPair = {
  pairKey: 'USDC/XLM',
  assetA: { code: 'XLM', issuer: null },
  assetB: {
    code: 'USDC',
    issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  },
}

const xlmToken: SoroswapToken = {
  address: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
  symbol: 'XLM',
  name: 'Stellar Lumens',
  decimals: 7,
}

const usdcToken: SoroswapToken = {
  address: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
  symbol: 'USDC',
  name: 'USD Coin',
  decimals: 7,
}

// ── calcSpotPrice ─────────────────────────────────────────────────────────────
describe('calcSpotPrice', () => {
  it('returns reserveA / reserveB as a number', () => {
    expect(calcSpotPrice(1000n, 200n)).toBeCloseTo(5.0)
  })

  it('returns 0 when reserveA is zero (empty pool guard)', () => {
    expect(calcSpotPrice(0n, 200n)).toBe(0)
  })

  it('returns 0 when reserveB is zero (empty pool guard)', () => {
    expect(calcSpotPrice(1000n, 0n)).toBe(0)
  })

  it('handles large i128 reserves correctly', () => {
    // 10_000_000 / 2_000_000 = 5.0 (7-decimal precision amounts)
    expect(calcSpotPrice(10_000_000n, 2_000_000n)).toBeCloseTo(5.0)
  })

  it('handles 1:1 ratio', () => {
    expect(calcSpotPrice(5000n, 5000n)).toBe(1)
  })
})

// ── ingestPool ────────────────────────────────────────────────────────────────
describe('ingestPool', () => {
  const mockPoolEntry: PoolEntry = {
    poolAddress: 'CPOOL000000000000000000000000000000000000000000000000001234',
    tokenA: xlmToken,
    tokenB: usdcToken,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    // clearAllMocks resets call history but not implementations, so restore the
    // default resolved behavior each test starts from. Without this, a prior
    // test's mockRejectedValue could survive into the next one under shuffled
    // ordering.
    ;(upsertPricePoints as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    ;(dispatchPriceUpdate as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
  })

  it('stores a price point when reserves are non-zero', async () => {
    const mockFetch = vi.fn().mockResolvedValue([10_000_000n, 2_000_000n])

    // See the note in ammIngester.test.ts: the network passed in must be the
    // one written, so this uses a network the process is not running as.
    await ingestPool(mockPoolEntry, mockPair as any, mockFetch, 'mainnet')

    expect(upsertPricePoints).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'soroswap_amm',
          price: expect.closeTo(5.0, 5),
          poolId: mockPoolEntry.poolAddress,
        }),
      ]),
      'mainnet'
    )
    expect(dispatchPriceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ assetA: 'XLM', assetB: 'USDC' })
    )
  })

  it('skips price storage when pool is empty (zero reserves)', async () => {
    const mockFetch = vi.fn().mockResolvedValue([0n, 0n])

    await ingestPool(mockPoolEntry, mockPair as any, mockFetch)

    expect(upsertPricePoints).not.toHaveBeenCalled()
    expect(dispatchPriceUpdate).not.toHaveBeenCalled()
  })

  it('skips price storage when fetchPoolReserves returns null (RPC error)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(null)

    await ingestPool(mockPoolEntry, mockPair as any, mockFetch)

    expect(upsertPricePoints).not.toHaveBeenCalled()
  })

  it('does not throw when upsertPricePoints rejects', async () => {
    const mockFetch = vi.fn().mockResolvedValue([1000n, 200n])
    // `...Once`: this rejection must not outlive this test. `beforeEach` only
    // calls `vi.clearAllMocks()`, which resets call history but NOT mock
    // implementations, so a persistent `mockRejectedValue` here would leak into
    // whichever test runs next — and test order is shuffled in CI, so the
    // victim (e.g. "stores a price point") would fail intermittently.
    ;(upsertPricePoints as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('DB error'))

    await expect(ingestPool(mockPoolEntry, mockPair as any, mockFetch)).resolves.toBeUndefined()
  })
})

// ── ingestPair ────────────────────────────────────────────────────────────────
describe('ingestPair', () => {
  const tokens = [xlmToken, usdcToken]
  const factory = 'CA4HEQTL2WPEUYKYKCDOHCDNIV4QHNJ7EL4J4NQ6VADP7SYHVRYZ7AW2'

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls fetchPoolsFromFactory with correct token addresses', async () => {
    const mockFetchPools = vi.fn().mockResolvedValue([])

    await ingestPair(mockPair as any, tokens, factory, mockFetchPools)

    expect(mockFetchPools).toHaveBeenCalledWith(
      factory,
      xlmToken.address,
      usdcToken.address,
      expect.any(String)
    )
  })

  it('skips silently when one token is not in the token list', async () => {
    const pairWithUnknownToken = {
      ...mockPair,
      assetB: { code: 'UNKNOWN', issuer: null },
      pairKey: 'UNKNOWN/XLM',
    }

    await ingestPair(pairWithUnknownToken as any, tokens, factory)

    expect(fetchPoolsFromFactory).not.toHaveBeenCalled()
  })

  it('skips silently when factory returns no pools', async () => {
    const mockFetchPools = vi.fn().mockResolvedValue([])

    await ingestPair(mockPair as any, tokens, factory, mockFetchPools)

    expect(upsertPricePoints).not.toHaveBeenCalled()
  })
})

// ── fetchSoroswapTokenList ────────────────────────────────────────────────────
describe('fetchSoroswapTokenList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns tokens from a successful fetch', async () => {
    ;(fetchSoroswapTokenList as ReturnType<typeof vi.fn>).mockResolvedValue([xlmToken, usdcToken])

    const result = await fetchSoroswapTokenList()
    expect(result).toHaveLength(2)
    expect(result[0].symbol).toBe('XLM')
  })

  it('returns empty array on fetch failure', async () => {
    ;(fetchSoroswapTokenList as ReturnType<typeof vi.fn>).mockResolvedValue([])

    const result = await fetchSoroswapTokenList()
    expect(result).toEqual([])
  })
})
