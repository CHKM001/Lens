import { amm_snapshots_total, trades_ingested_total, last_trade_timestamp, markIngestSuccess } from '../../metrics'
import { config, activeNetwork, getNetworkConfig, type NetworkName } from '../../config'
import { upsertPricePoints, getIndexerState, setIndexerCursor, prisma } from '../../db'
import { resolvePageLedgers } from '../toid'
import { dispatchPriceUpdate } from '../../webhookDispatcher'
import { publishPriceUpdate } from '../../events'
import { createLogger } from '../../logger'
import { recordVenueSuccess, recordVenueFailure, recordVenueReadSuccess } from '../../venueHeartbeat'
import type { WatchedPair } from '../../types'
import type { VenueAdapter, VenuePricePoint } from './types'
import { fetchHorizonJson, HorizonRateLimitError } from './horizon'
import {
  getLastPrice,
  resetLastPrice,
  setLastPrice,
  startVenueAdapter,
} from './runner'
import { fetchWithTimeout } from '../../fetch'
import { fetchOk, fetchFailed, type FetchResult } from '../fetchResult'
import { recordSourceFailure, clearSourceFailure } from '../sourceFailures'

const log = createLogger('ingester:amm')

export function _resetLastPrice(): void {
  resetLastPrice('AMM')
}

export function _getLastPrice(network: NetworkName, pairKey: string): number | undefined {
  return getLastPrice('AMM', network, pairKey)
}

/** `price_points.source` for the Horizon AMM, and its key in the source-failure record. */
export const AMM_SOURCE = 'AMM'

/**
 * Fetch the Horizon liquidity pools for a pair (#329).
 *
 * `{ ok: true, data: [] }` means Horizon answered and there are no pools.
 * `{ ok: false }` means it did not answer usefully (network error, timeout,
 * non-2xx, a body without `_embedded.records`, or a cycle abandoned before the
 * request went out) — never to be read as "no pools". A persistent 429 is
 * still thrown (#348) so the runner backs the whole cycle off.
 */
export async function fetchPools(
  pair: WatchedPair,
  network: NetworkName = activeNetwork,
  signal?: AbortSignal
): Promise<FetchResult<any[]>> {
  try {
    if (signal?.aborted) return fetchFailed(new Error('cycle aborted before the Horizon pools request was sent'))

    const assetAStr = pair.assetA.issuer
      ? `${pair.assetA.code}:${pair.assetA.issuer}`
      : 'native'
    const assetBStr = pair.assetB.issuer
      ? `${pair.assetB.code}:${pair.assetB.issuer}`
      : 'native'

    const params = new URLSearchParams()
    params.append('reserves[]', assetAStr)
    params.append('reserves[]', assetBStr)
    params.set('limit', '10')

    const data = await fetchHorizonJson<any>(
      `${getNetworkConfig(network).horizon.url}/liquidity_pools?${params.toString()}`,
      network,
      { signal }
    )
    if (!Array.isArray(data?._embedded?.records)) {
      log.error({ pair: pair.pairKey }, 'failed to fetch pools: response has no _embedded.records')
      return fetchFailed(new Error('Horizon liquidity_pools response has no _embedded.records'))
    }
    return fetchOk(data._embedded.records)
  } catch (err) {
    // A persistent 429 is raised, not logged and swallowed: the runner counts
    // it and backs the whole cycle off, which is the point of #348.
    if (err instanceof HorizonRateLimitError) throw err
    log.error({ venue: 'AMM', network, pair: pair.pairKey, err }, 'failed to fetch pools')
    return fetchFailed(err)
  }
}

export async function snapshotPool(
  pool: any,
  pair: WatchedPair,
  network: NetworkName = activeNetwork,
  signal?: AbortSignal
): Promise<void> {
  try {
    // Cycle-deadline checkpoint (#351): this unit makes no upstream call — it
    // is two writes (pool snapshot + its zero-volume price point) — so an
    // abandoned cycle skips the whole unit instead of starting it. Once begun
    // it runs to completion; each statement is atomic and the checkpoint never
    // sits between them.
    if (signal?.aborted) return

    const r0 = pool.reserves[0]
    const r1 = pool.reserves[1]

    const code0 = r0.asset === 'native' ? 'XLM' : r0.asset.split(':')[0]
    const isForward = code0 === pair.assetA.code

    const reserveA = parseFloat(isForward ? r0.amount : r1.amount)
    const reserveB = parseFloat(isForward ? r1.amount : r0.amount)
    const spotPrice = reserveA > 0 ? reserveB / reserveA : 0
    const feeBp = pool.fee_bp ?? 30

    await prisma.poolSnapshot.create({
      data: {
        network,
        poolId: pool.id,
        assetA: pair.assetA.code,
        assetB: pair.assetB.code,
        reserveA,
        reserveB,
        spotPrice,
        totalShares: parseFloat(pool.total_shares ?? '0'),
        feeBp,
        ledger: pool.last_modified_ledger ?? 0,
        timestamp: new Date(),
      },
    })

    amm_snapshots_total.inc({ pool: pool.id, network })

    // Also record spot price as a price point (no volume — it's a snapshot, not a trade)
    if (spotPrice > 0) {
      const now = new Date()
      await upsertPricePoints(
        [
          {
            assetA: pair.assetA.code,
            assetB: pair.assetB.code,
            pairKey: pair.pairKey,
            source: 'AMM',
            poolId: pool.id,
            price: spotPrice,
            baseVolume: 0,
            counterVolume: 0,
            ledger: pool.last_modified_ledger ?? 0,
            observedAt: now,
            sourceTime: null,
            timestamp: now,
            // #237: snapshot price points have no trade event to key on, so
            // the id is derived from the pool's STATE — (pool, ledger) is the
            // version of the reserves, and two ingesters that read the same
            // ledger hold the same spot price. A `Date.now()` id here would
            // mint a fresh identity per attempt, which is exactly the random
            // key the replay absorbing rejects: retried batches and overlapping
            // instances would each insert the same observation again.
            eventId: `amm-snapshot-${pool.id}-${pool.last_modified_ledger ?? 0}`,
          },
        ],
        network
      )
      markIngestSuccess('AMM', network)

      const trackerKey = pair.pairKey
      const { previousPrice } = setLastPrice('AMM', network, trackerKey, spotPrice)

      // The snapshot wrote a fresh AMM price point from the pool's current
      // reserves, so the venue has produced new data this cycle even when no
      // trades occurred.
      recordVenueSuccess('AMM', network)

      publishPriceUpdate({
        pair: pair.pairKey,
        price: spotPrice,
        ts: new Date().toISOString(),
        network,
      })

      dispatchPriceUpdate({
        assetA: pair.assetA.code,
        assetB: pair.assetB.code,
        previousPrice,
        currentPrice: spotPrice,
        network,
      }).catch((err) => log.error({ pool: pool.id, err }, 'webhook dispatch error'))
    }
  } catch (err) {
    log.error({ pool: pool.id, err }, 'snapshot error')
  }
}

export async function ingestPoolTrades(
  pool: any,
  pair: WatchedPair,
  network: NetworkName = activeNetwork,
  signal?: AbortSignal
): Promise<void> {
  const stateId = `amm:${network}:${pool.id}`
  const state = await getIndexerState(stateId, network)
  const cursor = state.cursor ?? '0'

  try {
    if (signal?.aborted) return

    const data = await fetchHorizonJson<any>(
      `${getNetworkConfig(network).horizon.url}/liquidity_pools/${pool.id}/trades?cursor=${cursor}&limit=${config.indexer.ammPageSize}&order=asc`,
      network,
      { signal }
    )
    const records = data._embedded?.records ?? []

    if (!records.length) {
      recordVenueReadSuccess('AMM', network)
      return
    }

    // Horizon returns no `ledger` on a pool trade; it lives in the TOID prefix.
    const ledgers = resolvePageLedgers(
      records.map((t: any) => t.paging_token ?? t.id),
      state.ledger
    )
    if (ledgers === null) {
      log.error(
        { pool: pool.id, trades: records.length },
        'no ledger derivable from trades; skipping batch'
      )
      recordVenueReadSuccess('AMM', network)
      return
    }

    const points: VenuePricePoint[] = records.map((t: any, i: number) => {
      const baseCode = t.base_asset_type === 'native' ? 'XLM' : t.base_asset_code
      const isForward = baseCode === pair.assetA.code
      const price = isForward
        ? parseFloat(t.counter_amount) / parseFloat(t.base_amount)
        : parseFloat(t.base_amount) / parseFloat(t.counter_amount)

      const now = new Date()
      const sourceTime = new Date(t.ledger_close_time)

      return {
        assetA: pair.assetA.code,
        assetB: pair.assetB.code,
        pairKey: pair.pairKey,
        source: 'AMM',
        poolId: pool.id,
        price,
        baseVolume: parseFloat(t.base_amount),
        counterVolume: parseFloat(t.counter_amount),
        ledger: ledgers[i],
        observedAt: now,
        sourceTime,
        timestamp: now,
        eventId: t.id,
      }
    })

    const trackerKey = pair.pairKey

    // Cycle-deadline checkpoint (#351), ahead of the write SEQUENCE: the page
    // upsert and the cursor advance below commit together, so a cycle
    // abandoned here skips both — never one without the other. The page is
    // re-read from the same cursor next cycle and upsertPricePoints dedupes
    // on conflict, so dropping out early costs nothing but a refetch.
    if (signal?.aborted) return

    const { previousPrice, currentPrice } = setLastPrice(
      'AMM',
      network,
      trackerKey,
      points[points.length - 1].price
    )

    await upsertPricePoints(points, network)
    markIngestSuccess('AMM', network)

    trades_ingested_total.inc({ pair: pair.pairKey, network }, points.length)
    const tradeTime = points[points.length - 1].sourceTime ?? points[points.length - 1].observedAt
    last_trade_timestamp.set(
      { pair: pair.pairKey, network },
      Math.floor(tradeTime.getTime() / 1000)
    )
    recordVenueSuccess('AMM', network)

    const lastRecord = records[records.length - 1]
    await setIndexerCursor(stateId, lastRecord.paging_token, network, ledgers[ledgers.length - 1])
    log.info({ pair: pair.pairKey, pool: pool.id, trades: points.length }, 'ingested pool trades')

    publishPriceUpdate({
      pair: pair.pairKey,
      price: currentPrice,
      ts: points[points.length - 1].observedAt.toISOString(),
      network,
    })

    dispatchPriceUpdate({
      assetA: pair.assetA.code,
      assetB: pair.assetB.code,
      previousPrice,
      currentPrice,
      network,
    }).catch((err) => log.error({ pool: pool.id, err }, 'webhook dispatch error'))
  } catch (err) {
    if (err instanceof HorizonRateLimitError) throw err
    log.error({ pool: pool.id, err }, 'trade ingest error')
    recordVenueFailure('AMM', network)
  }
}

export async function ingestPair(pair: WatchedPair, network: NetworkName = activeNetwork, signal?: AbortSignal): Promise<void> {
  // An abandoned cycle (#351) never asked Horizon anything, so it is neither a
  // failure nor a success and leaves the recorded state alone.
  if (signal?.aborted) return

  let fetched: FetchResult<any[]>
  try {
    fetched = await fetchPools(pair, network, signal)
  } catch (err) {
    // The rate-limit path (#348) still throws to back the cycle off, but the
    // AMM did fail for this pair and the aggregate has to know (#329).
    recordSourceFailure(AMM_SOURCE, network, pair.pairKey, err)
    throw err
  }
  if (!fetched.ok) {
    recordSourceFailure(AMM_SOURCE, network, pair.pairKey, fetched.error)
    return
  }
  clearSourceFailure(AMM_SOURCE, network, pair.pairKey)

  const pools = fetched.data
  log.info({ pair: pair.pairKey, pools: pools.length }, 'found AMM pools')

  await Promise.all(
    pools.map(async (pool) => {
      // Cycle-deadline checkpoint (#351): skip pools whose unit has not
      // started because the cycle was abandoned mid-flight. Each pool is one
      // write unit, so skipping whole pools never tears a unit in half.
      if (signal?.aborted) return
      await snapshotPool(pool, pair, network, signal)
      if (signal?.aborted) return
      await ingestPoolTrades(pool, pair, network, signal)
    })
  )
}

export const ammAdapter: VenueAdapter<any, any> = {
  name: 'AMM',
  kind: 'amm',
  source: 'AMM',
  sourceTimeCapability: { status: 'provided', semantic: 'ledger_close' },
  classification: 'primary',
  type: 'Liquidity Pool',
  description: 'Stellar native AMM liquidity pools (Horizon)',

  isEnabled(_network: NetworkName): boolean {
    return true
  },

  getPollIntervalMs(_network: NetworkName): number {
    return config.indexer.pollIntervalMs
  },

  async discover(pair: WatchedPair, network: NetworkName): Promise<any[]> {
    const fetched = await fetchPools(pair, network)
    if (!fetched.ok) throw fetched.error
    return fetched.data
  },

  async read(pool: any, _pair: WatchedPair, _network: NetworkName): Promise<any | null> {
    return pool
  },

  derive(_raw: any, _pool: any, _pair: WatchedPair, _network: NetworkName): VenuePricePoint[] {
    return []
  },

  async write(_points: VenuePricePoint[], pool: any, pair: WatchedPair, network: NetworkName): Promise<void> {
    await snapshotPool(pool, pair, network)
    await ingestPoolTrades(pool, pair, network)
  },

  async ingestPair(pair: WatchedPair, network: NetworkName, signal?: AbortSignal): Promise<void> {
    await ingestPair(pair, network, signal)
  },

  _resetLastPrice,
  _getLastPrice,
}

export async function startAMMIngester(network: NetworkName = activeNetwork): Promise<void> {
  await startVenueAdapter(ammAdapter, network)
}
