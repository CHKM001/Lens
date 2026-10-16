/**
 * Unit tests for the Aquarius AMM venue adapter.
 */

const mocks = vi.hoisted(() => ({
  config: {
    aquarius: { enabled: true, apiUrl: 'https://amm.aquarius.network/api/v1/pools/' },
    indexer: { pollIntervalMs: 5000 },
  },
  pairsRegistry: {
    getActivePairs: vi.fn().mockReturnValue([]),
  },
}))

vi.mock('../config', () => ({
  config: mocks.config,
  activeNetwork: 'testnet',
  // startAquariusIngester / ingestAquariusPair resolve the per-network Aquarius
  // block via getNetworkConfig(network); the mock returns the same shape for
  // whichever network is asked for.
  getNetworkConfig: () => mocks.config,
}))
vi.mock('../pairsRegistry', () => mocks.pairsRegistry)
vi.mock('../db', () => ({ upsertPricePoints: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../webhookDispatcher', () => ({ dispatchPriceUpdate: vi.fn().mockResolvedValue(undefined) }))

import { fetchAquariusPools, startAquariusIngester } from '../ingest/venues/aquarius'

const mockPair = {
  pairKey: 'USDC/XLM',
  assetA: { code: 'XLM', issuer: null },
  assetB: { code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
}

describe('fetchAquariusPools', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    global.fetch = vi.fn()
  })

  it('queries the configured Aquarius API URL for the network', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    })

    await fetchAquariusPools(mockPair as any, 'https://testnet.example.com/pools/')

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('https://testnet.example.com/pools/?'),
      expect.anything()
    )
  })

  it('falls back to config.aquarius.apiUrl when no override is passed', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    })

    await fetchAquariusPools(mockPair as any)

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining(mocks.config.aquarius.apiUrl),
      expect.anything()
    )
  })

  it('throws on a non-ok response so the caller can record a read failure', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 503 })

    await expect(fetchAquariusPools(mockPair as any)).rejects.toThrow('Aquarius API returned 503')
  })
})

describe('startAquariusIngester', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not start the polling loop when Aquarius is disabled on the active network', async () => {
    mocks.config.aquarius.enabled = false

    await startAquariusIngester()

    expect(mocks.pairsRegistry.getActivePairs).not.toHaveBeenCalled()

    mocks.config.aquarius.enabled = true
  })
})
