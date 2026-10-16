import { Asset } from '@stellar/stellar-sdk'
import { trades_ingested_total, last_trade_timestamp, markIngestSuccess } from '../../metrics'
import { config, activeNetwork, type NetworkName } from '../../config'
import { getHorizonServer } from '../../network/clients'
import { upsertPricePoints, getIndexerState, setIndexerCursor } from '../../db'
import { resolvePageLedgers } from '../../ingesters/toid'
import { dispatchPriceUpdate } from '../../webhookDispatcher'
import { publishPriceUpdate } from '../../events'
import { createLogger } from '../../logger'
import { recordVenueSuccess, recordVenueFailure, recordVenueReadSuccess } from '../../venueHeartbeat'
import type { WatchedPair } from '../../types'
import type { VenueAdapter, VenuePricePoint } from './types'
import {
  getLastPrice,
  resetLastPrice,
  setLastPrice,
  startVenueAdapter,
} from './runner'

const log = createLogger('ingester:sdex')

export function _resetLastPrice(): void {
  resetLastPrice('SDEX')
}

export function _getLastPrice(network: NetworkName, pairKey: string): number | undefined {
  return getLastPrice('SDEX', network, pairKey)
}

function toAsset(asset: { code: string; issuer: string | null }): Asset {
  if (!asset.issuer || asset.code === 'XLM') return Asset.native()
  return new Asset(asset.code, asset.issuer)
}

export interface SdexRawTrades {
  records: any[]
  cursor: string
  stateId: string
  lastLedger: number | null
}

export async function fetchSdexTrades(
  pair: WatchedPair,
  network: NetworkName = activeNetwork,
  signal?: AbortSignal
): Promise<SdexRawTrades | null> {
  const stateId = `sdex:${network}:${pair.pairKey}`
  const state = await getIndexerState(stateId, network)
  const cursor = state.cursor ?? '0'

  try {
    // Cycle-deadline checkpoint (#351): an already-abandoned cycle must not
    // start a fresh round trip. The SDK call below cannot take our signal
    // mid-flight, but it is one bounded HTTP request — we only ever refuse to
    // *begin* one on behalf of an abandoned cycle.
    if (signal?.aborted) return null

    const assetA = toAsset(pair.assetA)
    const assetB = toAsset(pair.assetB)

    const trades = await getHorizonServer(network)
      .trades()
      .forAssetPair(assetA, assetB)
      .cursor(cursor)
      .limit(config.indexer.sdexPageSize)
      .order('asc')
      .call()

    const records = trades.records
    if (!records.length) {
      // Horizon answered successfully with no new trades: the adapter is alive,
      // it just has nothing to write. Recording the read keeps a quiet venue
      // distinguishable from a dead one.
      recordVenueReadSuccess('SDEX', network)
      return null
    }

    return {
      records,
      cursor,
      stateId,
      lastLedger: state.ledger,
    }
  } catch (err) {
    log.error({ pair: pair.pairKey, err }, 'error fetching trades')
    recordVenueFailure('SDEX', network)
    return null
  }
}

export function deriveSdexPricePoints(
  raw: SdexRawTrades,
  pair: WatchedPair,
  network: NetworkName = activeNetwork
): { points: VenuePricePoint[]; finalLedger: number; lastPagingToken: string } | null {
  const { records, stateId, lastLedger } = raw

  // Horizon returns no `ledger` on a trade; it lives in the TOID prefix.
  const ledgers = resolvePageLedgers(
    records.map((t: any) => t.paging_token ?? t.id),
    lastLedger,
  )
  if (ledgers === null) {
    log.error(
      { pair: pair.pairKey, trades: records.length },
      'no ledger derivable from trades; skipping batch'
    )
    // The read succeeded; the batch is just not persistable this cycle.
    recordVenueReadSuccess('SDEX', network)
    return null
  }

  const points: VenuePricePoint[] = records.map((t: any, i: number) => {
    const baseCode = t.base_asset_type === 'native' ? 'XLM' : t.base_asset_code
    const isForward = baseCode === pair.assetA.code

    const price = isForward
      ? parseFloat(t.price.n) / parseFloat(t.price.d)
      : parseFloat(t.price.d) / parseFloat(t.price.n)

    return {
      assetA: pair.assetA.code,
      assetB: pair.assetB.code,
      pairKey: pair.pairKey,
      source: 'SDEX',
      price,
      baseVolume: parseFloat(t.base_amount),
      counterVolume: parseFloat(t.counter_amount),
      ledger: ledgers[i],
      timestamp: new Date(t.ledger_close_time),
      eventId: t.id,
    }
  })

  const lastRecord = records[records.length - 1]
  return {
    points,
    finalLedger: ledgers[ledgers.length - 1],
    lastPagingToken: lastRecord.paging_token,
  }
}

export async function writeSdexPricePoints(
  derived: { points: VenuePricePoint[]; finalLedger: number; lastPagingToken: string },
  pair: WatchedPair,
  network: NetworkName = activeNetwork
): Promise<void> {
  const { points, finalLedger, lastPagingToken } = derived
  if (points.length === 0) return

  const stateId = `sdex:${network}:${pair.pairKey}`
  const trackerKey = pair.pairKey
  const { previousPrice, currentPrice } = setLastPrice('SDEX', network, trackerKey, points[points.length - 1].price)

  await upsertPricePoints(points, network)
  markIngestSuccess('SDEX', network)

  trades_ingested_total.inc({ pair: pair.pairKey, network }, points.length)
  last_trade_timestamp.set(
    { pair: pair.pairKey, network },
    Math.floor(points[points.length - 1].timestamp.getTime() / 1000)
  )
  recordVenueSuccess('SDEX', network)

  await setIndexerCursor(stateId, lastPagingToken, network, finalLedger)
  log.info({ pair: pair.pairKey, trades: points.length }, 'ingested trades')

  publishPriceUpdate({
    pair: pair.pairKey,
    price: currentPrice,
    ts: points[points.length - 1].timestamp.toISOString(),
    network,
  })

  dispatchPriceUpdate({
    assetA: pair.assetA.code,
    assetB: pair.assetB.code,
    previousPrice,
    currentPrice,
    network,
  }).catch((err) => log.error({ pair: pair.pairKey, err }, 'webhook dispatch error'))
}

export async function ingestPair(pair: WatchedPair, network: NetworkName = activeNetwork, signal?: AbortSignal): Promise<void> {
  const raw = await fetchSdexTrades(pair, network, signal)
  if (!raw) return

  const derived = deriveSdexPricePoints(raw, pair, network)
  if (!derived || derived.points.length === 0) return

  // Cycle-deadline checkpoint (#351), placed before the write SEQUENCE as a
  // whole: `writeSdexPricePoints` commits the page upsert and the cursor
  // advance together, so a cycle abandoned here skips both — never one
  // without the other. Skipping merely re-reads the same page next cycle;
  // `upsertPricePoints` uses skipDuplicates, so the replay is idempotent.
  if (signal?.aborted) return

  await writeSdexPricePoints(derived, pair, network)
}

export const sdexAdapter: VenueAdapter<WatchedPair, SdexRawTrades> = {
  name: 'SDEX',
  kind: 'orderbook',
  source: 'SDEX',
  classification: 'primary',
  type: 'Order Book',
  description: "Stellar's Classic Order Book (SDEX)",

  isEnabled(_network: NetworkName): boolean {
    return true
  },

  getPollIntervalMs(_network: NetworkName): number {
    return config.indexer.pollIntervalMs
  },

  async discover(pair: WatchedPair, _network: NetworkName): Promise<WatchedPair[]> {
    return [pair]
  },

  async read(target: WatchedPair, _pair: WatchedPair, network: NetworkName): Promise<SdexRawTrades | null> {
    return fetchSdexTrades(target, network)
  },

  derive(raw: SdexRawTrades, _target: WatchedPair, pair: WatchedPair, network: NetworkName): VenuePricePoint[] {
    const derived = deriveSdexPricePoints(raw, pair, network)
    return derived ? derived.points : []
  },

  async write(_points: VenuePricePoint[], _target: WatchedPair, pair: WatchedPair, network: NetworkName): Promise<void> {
    await ingestPair(pair, network)
  },

  async ingestPair(pair: WatchedPair, network: NetworkName, signal?: AbortSignal): Promise<void> {
    await ingestPair(pair, network, signal)
  },

  _resetLastPrice,
  _getLastPrice,
}

export async function startSDEXIngester(network: NetworkName = activeNetwork): Promise<void> {
  await startVenueAdapter(sdexAdapter, network)
}
