import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  addedJobs, queueNames, workers,
  mockUpsert, mockSetCachedPrice,
  mockCalculateVWAP, mockCalculateOHLCV, mockGetAggregatedPrice, mockGetBestRoute,
} = vi.hoisted(() => ({
  addedJobs: [] as Array<{ queue: string; name: string; data: any; opts: any }>,
  queueNames: [] as string[],
  workers: [] as Array<{ name: string; processor: (job: any) => Promise<void> }>,
  mockUpsert: vi.fn(),
  mockSetCachedPrice: vi.fn(),
  mockCalculateVWAP: vi.fn(),
  mockCalculateOHLCV: vi.fn(),
  mockGetAggregatedPrice: vi.fn(),
  mockGetBestRoute: vi.fn(),
}))

vi.mock('bullmq', () => {
  class Queue {
    name: string
    constructor(name: string) {
      this.name = name
      queueNames.push(name)
    }
    async add(name: string, data: any, opts?: any) {
      addedJobs.push({ queue: this.name, name, data, opts })
      return { id: '1' }
    }
    async close() {}
  }
  class Worker {
    name: string
    processor: (job: any) => Promise<void>
    constructor(name: string, processor: (job: any) => Promise<void>) {
      this.name = name
      this.processor = processor
      workers.push({ name, processor })
    }
    on() {}
    async close() {}
  }
  return { Queue, Worker }
})

vi.mock('../db', () => ({
  prisma: { priceAggregate: { upsert: mockUpsert } },
  pgPool: { query: vi.fn() },
}))

vi.mock('../redis', () => ({ setCachedPrice: mockSetCachedPrice }))

vi.mock('../aggregator/vwap', () => ({
  calculateVWAP: mockCalculateVWAP,
  calculateOHLCV: mockCalculateOHLCV,
  getAggregatedPrice: mockGetAggregatedPrice,
}))

vi.mock('../aggregator/bestRoute', () => ({ getBestRoute: mockGetBestRoute }))

const { mainnetPair, testnetPair } = vi.hoisted(() => ({
  mainnetPair: {
    pairKey: 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN/XLM',
    assetA: { code: 'USDC', issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' },
    assetB: { code: 'XLM', issuer: null },
  },
  testnetPair: {
    pairKey: 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5/XLM',
    assetA: { code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
    assetB: { code: 'XLM', issuer: null },
  },
}))

vi.mock('../config', () => ({
  // activeNetwork and config.pairs are what the pre-fix worker read. They stay
  // here so a regression fails on an assertion rather than at import time.
  activeNetwork: 'testnet',
  config: { cache: { priceTtl: 10 }, pairs: [testnetPair] },
  getNetworkConfig: (network: string) => ({
    pairs: network === 'mainnet' ? [mainnetPair] : [testnetPair],
  }),
}))

import { createAggregateQueue, startAggregateWorker, scheduleAggregateRefresh } from '../jobs/aggregateRefresh'
import { recordVenueSuccess, _resetHeartbeats, DEFAULT_STALENESS_MS } from '../venueHeartbeat'

describe('aggregateRefresh runs once per enabled network', () => {
  beforeEach(() => {
    addedJobs.length = 0
    queueNames.length = 0
    workers.length = 0
    vi.clearAllMocks()
    mockCalculateVWAP.mockResolvedValue(0.25)
    mockCalculateOHLCV.mockResolvedValue({ open: 0.2, high: 0.3, low: 0.2, close: 0.25, volume: 100, tradeCount: 3 })
    mockGetAggregatedPrice.mockResolvedValue({ price: 0.25 })
    mockGetBestRoute.mockResolvedValue({ route: 'SDEX' })
    mockSetCachedPrice.mockResolvedValue(undefined)
    mockUpsert.mockResolvedValue({})
  })

  it('names the queue and the worker after the network', () => {
    createAggregateQueue('testnet')
    createAggregateQueue('mainnet')
    startAggregateWorker('testnet')
    startAggregateWorker('mainnet')

    expect(queueNames).toEqual(['testnet:aggregate-refresh', 'mainnet:aggregate-refresh'])
    expect(workers.map(w => w.name)).toEqual(['testnet:aggregate-refresh', 'mainnet:aggregate-refresh'])
  })

  it('schedules that network’s pairs, not the active network’s', async () => {
    const mainnetQueue = createAggregateQueue('mainnet')
    const testnetQueue = createAggregateQueue('testnet')

    await scheduleAggregateRefresh(mainnetQueue as never, 'mainnet')
    await scheduleAggregateRefresh(testnetQueue as never, 'testnet')

    // A repeatable job plus a startup run, per pair.
    expect(addedJobs).toHaveLength(4)
    expect(addedJobs.every(j => j.data.network === j.queue.split(':')[0])).toBe(true)

    const mainnetJobs = addedJobs.filter(j => j.queue === 'mainnet:aggregate-refresh')
    expect(mainnetJobs.map(j => j.data.pairKey)).toEqual([mainnetPair.pairKey, mainnetPair.pairKey])
    expect(mainnetJobs[0].opts).toEqual({ repeat: { every: 60_000 }, jobId: `refresh:mainnet:${mainnetPair.pairKey}` })

    const testnetJobs = addedJobs.filter(j => j.queue === 'testnet:aggregate-refresh')
    expect(testnetJobs.map(j => j.data.pairKey)).toEqual([testnetPair.pairKey, testnetPair.pairKey])
    expect(testnetJobs[0].opts.jobId).toBe(`refresh:testnet:${testnetPair.pairKey}`)
  })

  it('reads, caches and upserts the mainnet worker’s job under mainnet', async () => {
    startAggregateWorker('mainnet')
    const { processor } = workers[0]

    await processor({ data: { pairKey: mainnetPair.pairKey, pair: mainnetPair, network: 'mainnet' } })

    expect(mockGetAggregatedPrice).toHaveBeenCalledWith(mainnetPair.pairKey, 'mainnet', undefined, [])
    expect(mockGetBestRoute).toHaveBeenCalledWith(
      mainnetPair.assetA, mainnetPair.assetB, mainnetPair.pairKey, 1000, 'mainnet'
    )
    for (const call of mockCalculateVWAP.mock.calls) {
      expect(call).toContain('mainnet')
    }
    for (const call of mockCalculateOHLCV.mock.calls) {
      expect(call).toContain('mainnet')
    }
    expect(mockSetCachedPrice).toHaveBeenCalledWith(
      `mainnet:${mainnetPair.pairKey}`, expect.objectContaining({ network: 'mainnet' }), 10
    )

    // One bucket per window, every one of them stamped with the worker's network.
    expect(mockUpsert).toHaveBeenCalledTimes(4)
    expect(mockUpsert.mock.calls.map(([arg]) => arg.where.network_pairKey_window_bucket.window))
      .toEqual(['1m', '5m', '1h', '24h'])
    for (const [arg] of mockUpsert.mock.calls) {
      expect(arg.where.network_pairKey_window_bucket.network).toBe('mainnet')
      expect(arg.where.network_pairKey_window_bucket.pairKey).toBe(mainnetPair.pairKey)
      expect(arg.create.network).toBe('mainnet')
    }
  })

  it('a testnet worker never writes a mainnet row', async () => {
    startAggregateWorker('testnet')
    await workers[0].processor({ data: { pairKey: testnetPair.pairKey, pair: testnetPair, network: 'testnet' } })

    for (const [arg] of mockUpsert.mock.calls) {
      expect(arg.where.network_pairKey_window_bucket.network).toBe('testnet')
      expect(arg.create.network).toBe('testnet')
    }
    expect(mockSetCachedPrice).toHaveBeenCalledWith(
      `testnet:${testnetPair.pairKey}`, expect.objectContaining({ network: 'testnet' }), 10
    )
  })

  it('drops a stale venue from the cached payload and the precomputed buckets', async () => {
    _resetHeartbeats()
    // SDEX wrote a price 10 minutes ago and has since gone stale.
    vi.useFakeTimers()
    vi.setSystemTime(new Date(Date.now() - DEFAULT_STALENESS_MS - 1000))
    recordVenueSuccess('SDEX', 'mainnet')
    vi.useRealTimers()

    startAggregateWorker('mainnet')
    await workers[0].processor({ data: { pairKey: mainnetPair.pairKey, pair: mainnetPair, network: 'mainnet' } })

    // The aggregate is computed with SDEX excluded…
    expect(mockGetAggregatedPrice).toHaveBeenCalledWith(mainnetPair.pairKey, 'mainnet', undefined, ['SDEX'])
    // …and every window's VWAP/exclusion list carries that exclusion.
    for (const call of mockCalculateVWAP.mock.calls) {
      expect(call[call.length - 1]).toEqual(['SDEX'])
    }
  })
})
