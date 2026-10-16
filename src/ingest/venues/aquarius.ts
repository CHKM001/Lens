/**
 * Aquarius AMM Venue Adapter
 *
 * Indexes Aquarius liquidity pool (Stellar classic) reserves via the
 * Aquarius AMM API, calculates spot prices from constant-product invariants,
 * and stores them in price_points with source = 'aquarius_amm'.
 *
 * Issue: #103, #218, #329
 */

import { config, activeNetwork, getNetworkConfig, type NetworkName } from '../../config'
import { createLogger } from '../../logger'
import { recordVenueSuccess, recordVenueFailure, recordVenueReadSuccess } from '../../venueHeartbeat'
import type { WatchedPair } from '../../types'
import type { VenueAdapter, VenuePricePoint } from './types'
import {
  getLastPrice,
  resetLastPrice,
  writeVenuePricePoints,
  startVenueAdapter,
} from './runner'
import { fetchWithTimeout } from '../../fetch'
import { fetchOk, fetchFailed, type FetchResult } from '../fetchResult'
import { recordSourceFailure, clearSourceFailure } from '../sourceFailures'

const log = createLogger('ingester:aquarius')

export function _resetLastPrice(): void {
  resetLastPrice('Aquarius')
}

export function _getLastPrice(network: NetworkName, pairKey: string): number | undefined {
  return getLastPrice('Aquarius', network, pairKey)
}

export interface AquariusPool {
  pool_hash: string
  reserves: string[]
  total_shares: string
}

export interface AquariusListResponse {
  results?: AquariusPool[]
}

/** `price_points.source` for Aquarius, and its key in the source-failure record. */
export const AQUARIUS_SOURCE = 'aquarius_amm'

/**
 * Fetch Aquarius pools for a pair (#329).
 *
 * `{ ok: true, data: [] }` means Aquarius answered and has no pools for this
 * pair. `{ ok: false }` means it did not answer (network error, timeout,
 * non-2xx, or a cycle abandoned before the request went out) — the caller must
 * not read that as "no pools".
 */
export async function fetchAquariusPools(
  pair: WatchedPair,
  apiUrl: string = config.aquarius.apiUrl,
  signal?: AbortSignal
): Promise<FetchResult<AquariusPool[]>> {
  try {
    if (signal?.aborted) return fetchFailed(new Error('cycle aborted before the Aquarius request was sent'))

  const assetAStr = pair.assetA.issuer
    ? `${pair.assetA.code}:${pair.assetA.issuer}`
    : 'native'
  const assetBStr = pair.assetB.issuer
    ? `${pair.assetB.code}:${pair.assetB.issuer}`
    : 'native'

  const params = new URLSearchParams()
  params.append('assets[]', assetAStr)
  params.append('assets[]', assetBStr)

    const res = await fetchWithTimeout(`${apiUrl}?${params.toString()}`, { signal })
    if (!res.ok) {
      const err = new Error(`Aquarius API returned HTTP ${res.status}`)
      log.error({ pair: pair.pairKey, status: res.status }, 'failed to fetch pools')
      return fetchFailed(err)
    }
    const data = (await res.json()) as AquariusListResponse
    return fetchOk(data.results ?? [])
  } catch (err) {
    log.error({ pair: pair.pairKey, err }, 'failed to fetch pools')
    return fetchFailed(err)
  }
}

export function deriveAquariusPricePoints(
  pools: AquariusPool[],
  pair: WatchedPair
): VenuePricePoint[] {
  return pools.flatMap((pool) => {
    const [r0Str, r1Str] = pool.reserves
    if (!r0Str || !r1Str) return []

    const r0 = parseFloat(r0Str)
    const r1 = parseFloat(r1Str)
    if (r0 <= 0 || r1 <= 0) return []

    const now = new Date()
    return [
      {
        assetA: pair.assetA.code,
        assetB: pair.assetB.code,
        pairKey: pair.pairKey,
        source: 'aquarius_amm',
        poolId: pool.pool_hash,
        price: r1 / r0,
        baseVolume: 0,
        counterVolume: 0,
        ledger: 0,
        observedAt: now,
        sourceTime: null,
        timestamp: now,
      },
    ]
  })
}

export async function ingestAquariusPair(
  pair: WatchedPair,
  network: NetworkName = activeNetwork,
  signal?: AbortSignal
): Promise<void> {
  // An abandoned cycle (#351) never asked Aquarius anything, so it is neither
  // a failure nor a success and leaves the recorded state alone.
  if (signal?.aborted) return

  const fetched = await fetchAquariusPools(
    pair,
    getNetworkConfig(network).aquarius.apiUrl,
    signal
  )
  if (!fetched.ok) {
    // A cycle abandoned on its own deadline (#471) is our timeout, not the
    // venue going quiet, so it must not be recorded as a failure.
    if (signal?.aborted) return
    // #329: record it so the aggregate excludes Aquarius for this pair and
    // /status reports it, instead of the pair silently reading as "no pools".
    recordSourceFailure(AQUARIUS_SOURCE, network, pair.pairKey, fetched.error)
    recordVenueFailure('aquarius_amm', network)
    return
  }
  clearSourceFailure(AQUARIUS_SOURCE, network, pair.pairKey)

  const pools = fetched.data
  if (pools.length === 0) {
    // The API answered, there is just no pool for this pair: a successful read.
    recordVenueReadSuccess('aquarius_amm', network)
    return
  }

  const points = deriveAquariusPricePoints(pools, pair)
  if (points.length === 0) {
    // The pools were read but every one is empty or malformed, so there is no
    // price to record. The read itself succeeded.
    recordVenueReadSuccess('aquarius_amm', network)
    return
  }

  // Cycle-deadline checkpoint (#351): if the signal aborted while we were
  // fetching, skip the write instead of committing points from an abandoned
  // cycle. Nothing has been written yet, so skipping leaves no partial state
  // — the same pools are re-read next cycle.
  if (signal?.aborted) return

  await writeVenuePricePoints('Aquarius', points, pair, network)
  recordVenueSuccess('aquarius_amm', network)
}

export const aquariusAdapter: VenueAdapter<AquariusPool[], AquariusPool[]> = {
  name: 'Aquarius',
  kind: 'amm',
  // AQUARIUS_SOURCE is the same literal; the constant keeps the adapter and
  // the failure-tracking calls below from drifting apart.
  source: AQUARIUS_SOURCE,
  sourceTimeCapability: { status: 'unavailable' },
  classification: 'aggregator',
  type: 'Liquidity Pool',
  description: 'Aquarius AMM liquidity pools',

  isEnabled(network: NetworkName): boolean {
    return getNetworkConfig(network).aquarius?.enabled ?? false
  },

  getPollIntervalMs(_network: NetworkName): number {
    return config.indexer.pollIntervalMs
  },

  async discover(pair: WatchedPair, network: NetworkName): Promise<AquariusPool[][]> {
    const fetched = await fetchAquariusPools(pair, getNetworkConfig(network).aquarius.apiUrl)
    if (!fetched.ok) throw fetched.error
    return fetched.data.length > 0 ? [fetched.data] : []
  },

  async read(target: AquariusPool[], _pair: WatchedPair, _network: NetworkName): Promise<AquariusPool[] | null> {
    return target
  },

  derive(raw: AquariusPool[], _target: AquariusPool[], pair: WatchedPair, _network: NetworkName): VenuePricePoint[] {
    return deriveAquariusPricePoints(raw, pair)
  },

  async write(points: VenuePricePoint[], _target: AquariusPool[], pair: WatchedPair, network: NetworkName): Promise<void> {
    await writeVenuePricePoints('Aquarius', points, pair, network)
  },

  async ingestPair(pair: WatchedPair, network: NetworkName, signal?: AbortSignal): Promise<void> {
    await ingestAquariusPair(pair, network, signal)
  },

  _resetLastPrice,
  _getLastPrice,
}

export async function startAquariusIngester(network: NetworkName = activeNetwork): Promise<void> {
  await startVenueAdapter(aquariusAdapter, network)
}
