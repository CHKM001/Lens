/**
 * Soroswap AMM Pool Price Ingester & Venue Adapter
 *
 * Polls Soroswap Soroban pool reserves via Soroban RPC simulation,
 * calculates constant-product spot prices, and stores them in price_points
 * with source = 'soroswap_amm'. Runs independently of the SDEX and Horizon
 * AMM ingesters — a crash here cannot affect them.
 *
 * Issue: #48, #218
 */

import {
  Contract,
  rpc as SorobanRpc,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  Keypair,
  scValToNative,
  Account,
} from '@stellar/stellar-sdk'
import { config, activeNetwork, getNetworkConfig, type NetworkName } from '../../config'
import { price_rejected_total } from '../../metrics'
import { getRpcServer } from '../../network/clients'
import { upsertPricePoints } from '../../db'
import { markIngestSuccess } from '../../metrics'
import { dispatchPriceUpdate } from '../../webhookDispatcher'
import { publishPriceUpdate } from '../../events'
import { createLogger } from '../../logger'
import { fetchWithTimeout } from '../../fetch'
import { recordVenueSuccess, recordVenueFailure, recordVenueReadSuccess } from '../../venueHeartbeat'
import type { WatchedPair } from '../../types'
import type { VenueAdapter, VenuePricePoint } from './types'
import {
  getLastPrice,
  resetLastPrice,
  setLastPrice,
  startVenueAdapter,
} from './runner'

const log = createLogger('ingester:soroswap')

// ── Constants ─────────────────────────────────────────────────────────────────

// Ephemeral fee-payer account (no real funds needed for simulation)
const FEE_PAYER_KEYPAIR = Keypair.random()

export function _resetLastPrice(): void {
  resetLastPrice('Soroswap')
}

export function _getLastPrice(network: NetworkName, pairKey: string): number | undefined {
  return getLastPrice('Soroswap', network, pairKey)
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SoroswapToken {
  address: string
  symbol: string
  name: string
  decimals: number
}

export interface SoroswapTokenList {
  tokens: SoroswapToken[]
}

export interface PoolEntry {
  poolAddress: string
  tokenA: SoroswapToken
  tokenB: SoroswapToken
}

// ── Token-list helpers ────────────────────────────────────────────────────────

/**
 * Fetch Soroswap token list. Returns an empty array on failure so the ingester
 * degrades gracefully without affecting other ingesters.
 */
export async function fetchSoroswapTokenList(
  tokenListUrl: string = getNetworkConfig(activeNetwork).soroswap.tokenListUrl,
  signal?: AbortSignal
): Promise<SoroswapToken[]> {
  try {
    const res = await fetchWithTimeout(tokenListUrl, { signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as SoroswapTokenList
    return Array.isArray(data.tokens) ? data.tokens : []
  } catch (err) {
    log.error({ err }, 'failed to fetch token list')
    return []
  }
}

// ── Pool discovery ────────────────────────────────────────────────────────────

/**
 * Query the Soroswap factory contract's get_pools() to enumerate pool addresses
 * for a specific token pair. Returns an empty array on RPC failure.
 */
export async function fetchPoolsFromFactory(
  factoryAddress: string,
  tokenA: string,
  tokenB: string,
  network: NetworkName = activeNetwork
): Promise<string[]> {
  try {
    const rpc = getRpcServer(network)
    const factory = new Contract(factoryAddress)
    const account = new Account(FEE_PAYER_KEYPAIR.publicKey(), '0')
    const networkPassphrase =
      getNetworkConfig(network).network.passphrase ?? Networks.PUBLIC

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(
        factory.call(
          'get_pools',
          new Contract(tokenA).address().toScVal(),
          new Contract(tokenB).address().toScVal()
        )
      )
      .setTimeout(30)
      .build()

    const sim = await rpc.simulateTransaction(tx)

    if (SorobanRpc.Api.isSimulationError(sim)) {
      log.debug({ tokenA, tokenB, error: sim.error }, 'get_pools simulation error')
      return []
    }

    if (!sim.result?.retval) return []

    const pools = scValToNative(sim.result.retval) as string[]
    return Array.isArray(pools) ? pools : []
  } catch (err) {
    log.debug({ err }, 'fetchPoolsFromFactory error')
    return []
  }
}

// ── Reserve reading ───────────────────────────────────────────────────────────

/**
 * Read a Soroswap pool's reserves via Soroban RPC simulation.
 * Returns [reserveA, reserveB] where A is `tokenAAddress`.
 * Returns null on any RPC error.
 */
export async function fetchPoolReserves(
  poolAddress: string,
  network: NetworkName = activeNetwork
): Promise<[bigint, bigint] | null> {
  try {
    const rpc = getRpcServer(network)
    const pool = new Contract(poolAddress)
    const account = new Account(FEE_PAYER_KEYPAIR.publicKey(), '0')
    const networkPassphrase =
      getNetworkConfig(network).network.passphrase ?? Networks.PUBLIC

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(pool.call('get_reserves'))
      .setTimeout(30)
      .build()

    const sim = await rpc.simulateTransaction(tx)

    if (SorobanRpc.Api.isSimulationError(sim)) {
      log.debug({ pool: poolAddress, error: sim.error }, 'get_reserves simulation error')
      return null
    }

    if (!sim.result?.retval) return null

    const reserves = scValToNative(sim.result.retval) as [bigint | number, bigint | number]
    if (!Array.isArray(reserves) || reserves.length < 2) return null

    return [BigInt(reserves[0]), BigInt(reserves[1])]
  } catch (err) {
    log.debug({ pool: poolAddress, err }, 'fetchPoolReserves error')
    return null
  }
}

// ── Token decimals reading & caching ──────────────────────────────────────────

const tokenDecimalsCache = new Map<string, number>()

export function _resetTokenDecimalsCache(): void {
  tokenDecimalsCache.clear()
}

export function getCachedTokenDecimals(tokenAddress: string): number | undefined {
  return tokenDecimalsCache.get(tokenAddress)
}

export function setCachedTokenDecimals(tokenAddress: string, decimals: number): void {
  tokenDecimalsCache.set(tokenAddress, decimals)
}

/**
 * Read a token's decimals via Soroban RPC simulation, with caching.
 * A token's decimals never change on-chain.
 */
export async function fetchTokenDecimals(
  tokenAddress: string,
  network: NetworkName = activeNetwork
): Promise<number | null> {
  const cached = getCachedTokenDecimals(tokenAddress)
  if (cached !== undefined) return cached

  try {
    if (typeof getRpcServer !== 'function') return null
    const rpc = getRpcServer(network)
    if (!rpc) return null
    const token = new Contract(tokenAddress)
    const account = new Account(FEE_PAYER_KEYPAIR.publicKey(), '0')
    const networkPassphrase =
      getNetworkConfig(network).network.passphrase ?? Networks.PUBLIC

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(token.call('decimals'))
      .setTimeout(30)
      .build()

    const sim = await rpc.simulateTransaction(tx)

    if (SorobanRpc.Api.isSimulationError(sim)) {
      log.debug(
        { token: tokenAddress, error: sim.error },
        'decimals simulation error'
      )
      return null
    }

    if (!sim.result?.retval) return null

    const decimalsVal = scValToNative(sim.result.retval)
    const decimals = typeof decimalsVal === 'number' ? decimalsVal : Number(decimalsVal)
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
      return null
    }

    setCachedTokenDecimals(tokenAddress, decimals)
    return decimals
  } catch (err) {
    log.debug(
      { token: tokenAddress, err },
      'fetchTokenDecimals error'
    )
    return null
  }
}

// ── Spot price ────────────────────────────────────────────────────────────────

/**
 * Pure function: calculate spot price from constant-product reserves scaled by token decimals.
 * Returns 0 if either reserve is zero (empty pool guard).
 *
 * price = (reserveA / 10^decimalsA) / (reserveB / 10^decimalsB)
 *       = (reserveA / reserveB) * 10^(decimalsB - decimalsA)
 * (price of assetB denominated in assetA)
 */
export function calcSpotPrice(
  reserveA: bigint,
  reserveB: bigint,
  decimalsA: number = 7,
  decimalsB: number = 7
): number {
  if (reserveA === 0n || reserveB === 0n) return 0
  if (decimalsA === decimalsB) {
    return Number(reserveA) / Number(reserveB)
  }
  const scale = Math.pow(10, decimalsB - decimalsA)
  return (Number(reserveA) / Number(reserveB)) * scale
}

/**
 * Checks whether a derived spot price falls within the configurable sanity range.
 */
export function isPricePlausible(
  price: number,
  min: number = config.plausibility.minPrice,
  max: number = config.plausibility.maxPrice
): boolean {
  return price >= min && price <= max && Number.isFinite(price) && !Number.isNaN(price)
}

// ── Per-pool ingestion ────────────────────────────────────────────────────────

/**
 * Fetch reserves for a single pool, compute spot price, and store a price point.
 * Skips silently on empty pool or RPC failure — does not throw.
 */
export async function ingestPool(
  poolEntry: PoolEntry,
  pair: WatchedPair,
  _fetchReserves: (poolAddress: string, network?: NetworkName) => Promise<[bigint, bigint] | null> = fetchPoolReserves,
  network: NetworkName = activeNetwork,
  _fetchDecimals: (tokenAddress: string, network?: NetworkName) => Promise<number | null> = fetchTokenDecimals,
  signal?: AbortSignal
): Promise<void> {
  try {
    // Cycle-deadline checkpoint (#351): an abandoned cycle does not start
    // another RPC simulation for a pool whose unit has not begun.
    if (signal?.aborted) return

    const reserves = await _fetchReserves(poolEntry.poolAddress, network)
    if (!reserves) return

    const [reserveA, reserveB] = reserves

    const decimalsA =
      (await _fetchDecimals(poolEntry.tokenA.address, network)) ??
      poolEntry.tokenA.decimals ??
      7
    const decimalsB =
      (await _fetchDecimals(poolEntry.tokenB.address, network)) ??
      poolEntry.tokenB.decimals ??
      7

    const spotPrice = calcSpotPrice(reserveA, reserveB, decimalsA, decimalsB)

    if (spotPrice === 0) {
      log.debug({ pool: poolEntry.poolAddress, pair: pair.pairKey }, 'skipping empty pool')
      // Reserves were read and the pool is simply empty; the adapter is alive.
      recordVenueReadSuccess('soroswap_amm', network)
      return
    }

    if (!isPricePlausible(spotPrice)) {
      log.warn(
        { pair: pair.pairKey, pool: poolEntry.poolAddress, spotPrice },
        `Derived price ${spotPrice} for ${pair.pairKey} (${poolEntry.poolAddress}) outside plausible range [${config.plausibility.minPrice}, ${config.plausibility.maxPrice}] — rejecting`
      )
      price_rejected_total.inc({
        pair: pair.pairKey,
        network,
        venue: 'soroswap',
        reason: 'out_of_bounds',
      })
      return
    }

    // Cycle-deadline checkpoint (#351), ahead of the write: nothing has been
    // written yet, so skipping leaves no partial state — the reserves are
    // re-read next cycle. The write itself is one upsert, so it commits whole
    // or not at all, and Soroswap keeps no cursor whose advance could be
    // separated from it.
    if (signal?.aborted) return

    await upsertPricePoints(
      [
        {
          assetA: pair.assetA.code,
          assetB: pair.assetB.code,
          pairKey: pair.pairKey,
          source: 'soroswap_amm' as const,
          poolId: poolEntry.poolAddress,
          price: spotPrice,
          baseVolume: 0,
          counterVolume: 0,
          ledger: 0,
          timestamp: new Date(),
          // #237: Soroswap snapshots are read via RPC simulation, so there is
          // no trade id to key on. The reserves ARE the pool state — identical
          // reserves yield the identical price, so deriving the id from them
          // makes a replayed batch (or an overlapping second instance reading
          // the same state) collide on the unique index instead of inserting
          // a duplicate. Must never be Date.now()/random.
          eventId: `soroswap-${poolEntry.poolAddress}-${reserveA}-${reserveB}`,
        },
      ],
      network
    )
    markIngestSuccess('Soroswap', network)
    recordVenueSuccess('soroswap_amm', network)

    const trackerKey = pair.pairKey
    const { previousPrice } = setLastPrice('Soroswap', network, trackerKey, spotPrice)

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
    }).catch((err) => log.error({ pool: poolEntry.poolAddress, err }, 'webhook dispatch error'))

    log.info(
      { pair: pair.pairKey, pool: poolEntry.poolAddress, price: spotPrice },
      'ingested pool price'
    )
  } catch (err) {
    log.error({ pool: poolEntry.poolAddress, err }, 'ingestPool error')
    recordVenueFailure('soroswap_amm', network)
  }
}

// ── Main per-pair logic ───────────────────────────────────────────────────────

/**
 * Discover Soroswap pools for a watched pair, then snapshot each pool's price.
 * Matches pair assets to token list by symbol; filters to watched pairs only.
 */
export async function ingestPair(
  pair: WatchedPair,
  tokens: SoroswapToken[],
  factoryAddress: string,
  _fetchPools: (
    factoryAddress: string,
    tokenA: string,
    tokenB: string,
    network?: NetworkName
  ) => Promise<string[]> = fetchPoolsFromFactory,
  network: NetworkName = activeNetwork,
  signal?: AbortSignal
): Promise<void> {
  const tokenA = tokens.find(
    (t) => t.symbol.toUpperCase() === pair.assetA.code.toUpperCase()
  )
  const tokenB = tokens.find(
    (t) => t.symbol.toUpperCase() === pair.assetB.code.toUpperCase()
  )

  if (!tokenA || !tokenB) {
    log.debug({ pair: pair.pairKey }, 'no Soroswap token found; skipping')
    return
  }

  const poolAddresses = await _fetchPools(
    factoryAddress,
    tokenA.address,
    tokenB.address,
    network
  )

  if (!poolAddresses.length) {
    log.debug({ pair: pair.pairKey }, 'no pools found; skipping')
    return
  }

  // Cycle-deadline checkpoint (#351): discovery above is one bounded RPC call
  // we cannot interrupt mid-flight; this is where an abandoned cycle stops
  // instead of scheduling a reserves read per pool after its deadline.
  if (signal?.aborted) return

  await Promise.all(
    poolAddresses.map((addr) =>
      ingestPool(
        { poolAddress: addr, tokenA, tokenB },
        pair,
        fetchPoolReserves,
        network,
        // `_fetchDecimals` sits between `network` and `signal` in the
        // signature, so pass the real implementation explicitly — omitting it
        // puts the AbortSignal in its place.
        fetchTokenDecimals,
        signal
      )
    )
  )
}

export const soroswapAdapter: VenueAdapter<PoolEntry, [bigint, bigint]> = {
  name: 'Soroswap',
  kind: 'amm',
  source: 'soroswap_amm',
  classification: 'primary',
  type: 'AMM DEX',
  description: 'Soroswap constant-product automated market maker on Soroban',

  isEnabled(network: NetworkName): boolean {
    return getNetworkConfig(network).soroswap.enabled
  },

  getPollIntervalMs(network: NetworkName): number {
    return getNetworkConfig(network).soroswap.pollIntervalMs
  },

  async discover(pair: WatchedPair, network: NetworkName): Promise<PoolEntry[]> {
    const netConfig = getNetworkConfig(network)
    const tokens = await fetchSoroswapTokenList(netConfig.soroswap.tokenListUrl)
    const tokenA = tokens.find((t) => t.symbol.toUpperCase() === pair.assetA.code.toUpperCase())
    const tokenB = tokens.find((t) => t.symbol.toUpperCase() === pair.assetB.code.toUpperCase())
    if (!tokenA || !tokenB) return []

    const poolAddresses = await fetchPoolsFromFactory(
      netConfig.soroswap.factoryAddress,
      tokenA.address,
      tokenB.address,
      network
    )
    return poolAddresses.map((addr) => ({ poolAddress: addr, tokenA, tokenB }))
  },

  async read(target: PoolEntry, _pair: WatchedPair, network: NetworkName): Promise<[bigint, bigint] | null> {
    return fetchPoolReserves(target.poolAddress, network)
  },

  derive(raw: [bigint, bigint], target: PoolEntry, pair: WatchedPair, _network: NetworkName): VenuePricePoint[] {
    const [reserveA, reserveB] = raw
    const spotPrice = calcSpotPrice(
      reserveA,
      reserveB,
      target.tokenA.decimals ?? 7,
      target.tokenB.decimals ?? 7
    )
    if (spotPrice === 0) return []

    if (!isPricePlausible(spotPrice)) {
      log.warn(
        { pair: pair.pairKey, pool: target.poolAddress, spotPrice },
        `Derived price ${spotPrice} for ${pair.pairKey} (${target.poolAddress}) outside plausible range [${config.plausibility.minPrice}, ${config.plausibility.maxPrice}] — rejecting`
      )
      price_rejected_total.inc({
        pair: pair.pairKey,
        network: _network,
        venue: 'soroswap',
        reason: 'out_of_bounds',
      })
      return []
    }

    return [
      {
        assetA: pair.assetA.code,
        assetB: pair.assetB.code,
        pairKey: pair.pairKey,
        source: 'soroswap_amm',
        poolId: target.poolAddress,
        price: spotPrice,
        baseVolume: 0,
        counterVolume: 0,
        ledger: 0,
        timestamp: new Date(),
        // Same content-derived key as ingestPool above (#237): reserves, not
        // the clock, so the adapter path and the legacy path agree on identity.
        eventId: `soroswap-${target.poolAddress}-${reserveA}-${reserveB}`,
      },
    ]
  },

  async write(_points: VenuePricePoint[], target: PoolEntry, pair: WatchedPair, network: NetworkName): Promise<void> {
    await ingestPool(target, pair, fetchPoolReserves, network)
  },

  async ingestPair(pair: WatchedPair, network: NetworkName, signal?: AbortSignal): Promise<void> {
    const netConfig = getNetworkConfig(network)
    const tokens = await fetchSoroswapTokenList(netConfig.soroswap.tokenListUrl, signal)
    if (tokens.length === 0) return
    await ingestPair(pair, tokens, netConfig.soroswap.factoryAddress, fetchPoolsFromFactory, network, signal)
  },

  _resetLastPrice,
  _getLastPrice,
}

export async function startSoroswapIngester(network: NetworkName = activeNetwork): Promise<void> {
  await startVenueAdapter(soroswapAdapter, network)
}
