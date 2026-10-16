import type { FastifyInstance } from 'fastify'
import { resolveDecimalFormat, formatDecimal } from '../utils/decimals'
import { listCrashes } from '../ingester/restart'
import { listSourceFailures } from '../ingest/sourceFailures'
import { isBootComplete } from '../health'
import { price_requests_total } from '../metrics'
import { getCachedPrice, setCachedPrice } from '../redis'
import { getAggregatedPrice } from '../aggregator/vwap'
import { getBestRoute } from '../aggregator/bestRoute'
import { pgPool } from '../db'
import { config, getNetworkConfig, activeNetwork, type NetworkName } from '../config'
import { isAdminConfigured } from './auth'
import { getStaleVenues, getAllHeartbeats } from '../venueHeartbeat'
import '../middleware/network' // declares req.network on the FastifyRequest type
import {
  statusResponseSchema,
  statusErrorResponseSchema,
  priceResponseSchema,
  routeResponseSchema,
  historyResponseSchema,
  poolsResponseSchema,
  depthResponseSchema,
  impactResponseSchema,
  installResponseValidation,
} from './schemas'
import { findOverlappingGaps } from '../backfill/gaps'
import { getDepth, getImpact } from '../pricing/depth'
import {
  POOLS_DEFAULT_LIMIT,
  POOLS_MAX_LIMIT,
  decodeCursor,
  encodeCursor,
  parseLimit,
  slicePage,
} from '../pagination'

function makePairKey(a: string, b: string): string {
  return [a, b].sort().join('/')
}

export const HISTORY_DEFAULT_LIMIT = 100
export const HISTORY_MAX_LIMIT = 1000

/**
 * Resolve a requested pair against the ones this network watches.
 *
 * The issuer is honoured when the caller supplies one. It used to be discarded
 * outright — `a.split(':')[0]` — so every asset called USDC was the same asset,
 * and a request for Circle's mainnet USDC was answered with testnet USDC's
 * price, stamped `"network":"testnet"`, at 1.72 per XLM against a real ~0.18.
 *
 * That is the worst failure mode an oracle has: not a refusal, but a confident
 * wrong number. Asset codes are not unique on Stellar — anyone can issue
 * "USDC", and Horizon lists many — so the issuer is the only thing that
 * identifies an asset. A bare code still matches on code alone, since callers
 * quoting XLM or a single-issuer asset rely on that.
 */
function findPair(assetA: string, assetB: string, network: NetworkName) {
  const parse = (a: string) => {
    if (a.toLowerCase() === 'native') return { code: 'XLM', issuer: null as string | null }
    const [code, issuer] = a.split(':')
    return { code: (code ?? '').toUpperCase(), issuer: issuer ?? null }
  }
  const qA = parse(assetA)
  const qB = parse(assetB)

  const matches = (
    q: { code: string; issuer: string | null },
    side: { code: string; issuer?: string | null },
  ) => {
    if (q.code !== side.code.toUpperCase()) return false
    // Only enforce the issuer when both sides name one; XLM has none, and a
    // caller passing a bare code is not asserting which issuer they meant.
    if (!q.issuer || !side.issuer) return true
    return q.issuer === side.issuer
  }

  return getNetworkConfig(network).pairs.find(
    p =>
      (matches(qA, p.assetA) && matches(qB, p.assetB)) ||
      (matches(qA, p.assetB) && matches(qB, p.assetA)),
  )
}

export async function registerRESTRoutes(app: FastifyInstance) {
  // Validate every response against its declared schema in dev/test (no-op in
  // production). Must run before the routes below are registered so they pick
  // up the validating serializer.
  installResponseValidation(app)

  /**
   * How long the last ingester write may be stale before `/status` says so.
   *
   * Named rather than inlined because it is a published threshold: the README's
   * Datadog/Prometheus/BetterStack examples and the `degraded` contract in
   * `openapi.yaml` all quote it, and a monitor tuned to one number while the
   * service uses another is worse than no monitor.
   */
  const INGEST_STALE_AFTER_SECONDS = 300

  // GET /status — public health/monitoring endpoint (no API key required) (#273)
  app.get(
    '/status',
    {
      config: { public: true },
      schema: {
        response: {
          200: statusResponseSchema,
          503: statusErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const network = req.network ?? activeNetwork
      const mem = process.memoryUsage()
      const uptimeSeconds = Math.round(process.uptime())
      const memoryUsageMb = Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100

      let result
      try {
        result = await pgPool.query(
          `SELECT last_ledger, last_processed_at
             FROM indexer_state
            WHERE network = $1
            ORDER BY updated_at DESC
            LIMIT 1`,
          [network]
        )
      } catch (err: unknown) {
        // The driver's own message is not safe to return here. `/status` is
        // public and unauthenticated, and a pg connection failure puts the host,
        // the user and sometimes the whole connection string into
        // `err.message` — this endpoint is the most-polled surface Lens has.
        // Lens has already had to rotate a database password over exactly this
        // shape of leak on another route, so the detail goes to the log, where
        // buildLogger pipes it through redactSecrets, and the response says only
        // which dependency is down.
        req.log.error({ err }, 'status: database query failed')
        return reply.status(503).send({
          ok: false,
          status: 'unhealthy',
          error: 'Database unavailable',
          pagingCondition: 'DATABASE_DOWN',
        })
      }

      const lastProcessedAt = result.rows[0]?.last_processed_at ?? null
      const lastIndexedLedger = result.rows[0]?.last_ledger ?? null
      const ingestLagSeconds = lastProcessedAt
        ? Math.max(0, Math.round((Date.now() - new Date(lastProcessedAt).getTime()) / 1000))
        : null
      const isStale = ingestLagSeconds !== null && ingestLagSeconds > INGEST_STALE_AFTER_SECONDS
      // Process health has to be measured, or the split this endpoint exists to
      // make is cosmetic. Boot is the signal that is actually available and
      // actually distinct from data freshness: between `listen()` and
      // `markBootComplete()` the process answers requests while its ingesters
      // are not all running yet, which is a degraded *process*, not stale data.
      // It is the same signal `/ready` gates on.
      const processHealth = isBootComplete() ? ('healthy' as const) : ('degraded' as const)
      const dataHealth = isStale ? ('stale' as const) : ('healthy' as const)
      const overallStatus =
        processHealth === 'degraded' || isStale ? ('degraded' as const) : ('healthy' as const)

      return {
        ok: true,
        status: overallStatus,
        network,
        health: {
          process: processHealth,
          data: dataHealth,
        },
        process: {
          uptimeSeconds,
          memoryUsageMb,
          status: processHealth,
        },
        data: {
          lastIndexedLedger,
          lastProcessedAt,
          ingestLagSeconds,
          isStale,
        },
        watchedPairs: getNetworkConfig(network).pairs.map(p => p.pairKey),
        lastIndexedLedger,
        lastProcessedAt,
        ingestLagSeconds,
        // #508: whether the admin surface is usable at all, so an operator
        // can tell "I sent the wrong token" from "this deployment has no
        // ADMIN_TOKEN" without guessing from a 401. It reports only that the
        // token is configured, never any part of its value.
        adminConfigured: isAdminConfigured(),
        crashes: listCrashes(network).map(c => ({
          name: c.name,
          network: c.network,
          message: c.message,
          at: c.at.toISOString(),
        })),
        // #329: sources whose latest fetch failed on this network, so a venue
        // that is down is visible rather than reading as a venue with nothing
        // to report. The error message stays in the log: an upstream client
        // error can carry the upstream URL, and this route is public.
        failedSources: listSourceFailures(network).map(f => ({
          source: f.source,
          network: f.network,
          subject: f.subject,
          at: f.at.toISOString(),
        })),
        // Per-venue heartbeats — shows last-success (last read), last-write, and
        // consecutive failures for every adapter that has polled at least once. A
        // venue whose lastWrite is older than its stalenessThresholdMs is excluded
        // from aggregation; this field, plus excludedVenues on /price, makes that
        // exclusion visible rather than silent.
        venueHeartbeats: getAllHeartbeats().filter(h => h.network === network),
      }
    }
  )


  // GET /price/:assetA/:assetB
  app.get<{
    Params: { assetA: string; assetB: string }
    Querystring: {
      decimals?: string
      decimalFormat?: string
      staleThreshold?: string
      staleThresholdSeconds?: string
    }
  }>(
    '/price/:assetA/:assetB',
    { config: { scope: 'read:prices' }, schema: { response: { 200: priceResponseSchema } } },
    async (req, reply) => {
      price_requests_total.inc()
      const { assetA, assetB } = req.params
      const network = req.network ?? activeNetwork
      const pair = findPair(assetA, assetB, network)
      if (!pair) return reply.status(404).send({ error: `Pair ${assetA}/${assetB} not watched on ${network}` })

      const rawThreshold = req.query?.staleThreshold ?? req.query?.staleThresholdSeconds
      let staleThreshold: number | undefined
      if (rawThreshold !== undefined) {
        staleThreshold = parseInt(rawThreshold, 10)
        if (isNaN(staleThreshold) || staleThreshold <= 0) {
          return reply.status(400).send({ error: 'staleThreshold must be a positive integer' })
        }
      }

      const decimalFormat = resolveDecimalFormat(req)
      if (decimalFormat === 'string') {
        reply.header('x-decimal-format', 'string')
      }

      // Cache key is network-scoped and format-isolated so number and string payloads never collide,
      // and scoped to staleThreshold if customized.
      const cacheParts = [network, pair.pairKey]
      if (decimalFormat === 'string') cacheParts.push('decimals_string')
      if (staleThreshold !== undefined) cacheParts.push(`stale_${staleThreshold}`)
      const cacheKey = cacheParts.join(':')

      const cached = await getCachedPrice(cacheKey)
      if (cached) {
        try {
          reply.header('X-Cache', 'HIT')
          return JSON.parse(cached)
        } catch { /* fall through */ }
      }

      // Exclude venues whose most recent written price is older than their
      // staleness window. Prices from a dead (or quiet) adapter are NOT dropped
      // from the DB — they are simply not counted in the aggregate until the
      // adapter writes again, at which point they flow back in naturally.
      const excludedVenues = getStaleVenues(network)

      const agg = await getAggregatedPrice(pair.pairKey, network, { decimalFormat, staleThresholdSeconds: staleThreshold }, excludedVenues)
      const route = await getBestRoute(pair.assetA, pair.assetB, pair.pairKey, 1000, network)
      const result = {
        assetA: pair.assetA.code,
        assetB: pair.assetB.code,
        pairKey: pair.pairKey,
        network,
        ...agg,
        bestRoute: route.route,
        lastUpdated: new Date().toISOString(),
      }

      await setCachedPrice(cacheKey, result, config.cache.priceTtl)
      reply.header('X-Cache', 'MISS')
      return result
    }
  )

  // GET /price/:assetA/:assetB/route?amount=1000
  app.get<{
    Params: { assetA: string; assetB: string }
    Querystring: { amount?: string; network?: string }
  }>(
    '/price/:assetA/:assetB/route',
    { config: { scope: 'read:prices' }, schema: { response: { 200: routeResponseSchema } } },
    async (req, reply) => {
      const { assetA, assetB } = req.params
      const amount = parseFloat(req.query.amount ?? '1000')
      // Validate amount before the pair check: a malformed request parameter
      // is a 400 regardless of whether the pair is watched.
      if (isNaN(amount) || amount <= 0) return reply.status(400).send({ error: 'amount must be a positive number' })
      const network = req.network ?? activeNetwork
      const pair = findPair(assetA, assetB, network)
      if (!pair) return reply.status(404).send({ error: `Pair ${assetA}/${assetB} not watched on ${network}` })

      const decimalFormat = resolveDecimalFormat(req)
      const routeInfo = await getBestRoute(pair.assetA, pair.assetB, pair.pairKey, amount, network)
      if (decimalFormat === 'string') {
        reply.header('x-decimal-format', 'string')
        return {
          ...routeInfo,
          sdexPrice: String(routeInfo.sdexPrice),
          ammPrice: String(routeInfo.ammPrice),
          estimatedOutput: String(routeInfo.estimatedOutput),
          slippagePct: String(routeInfo.slippagePct),
        }
      }
      return routeInfo
    }
  )

  // GET /price/:assetA/:assetB/history?window=1h&limit=100
  app.get<{
    Params: { assetA: string; assetB: string }
    Querystring: { window?: string; limit?: string; decimals?: string; decimalFormat?: string }
  }>(
    '/price/:assetA/:assetB/history',
    { config: { scope: 'read:history' }, schema: { response: { 200: historyResponseSchema } } },
    async (req, reply) => {
      const { assetA, assetB } = req.params
      const network = req.network ?? activeNetwork
      const window = req.query.window ?? '1h'
      const limit = Math.min(parseInt(req.query.limit ?? String(HISTORY_DEFAULT_LIMIT), 10), HISTORY_MAX_LIMIT)
      const pairKey = makePairKey(assetA, assetB)
      const decimalFormat = resolveDecimalFormat(req)
      if (decimalFormat === 'string') {
        reply.header('x-decimal-format', 'string')
      }

      if (!['1m', '5m', '1h', '24h'].includes(window)) {
        return reply.status(400).send({ error: 'window must be one of: 1m, 5m, 1h, 24h' })
      }

      const result = await pgPool.query(
        `SELECT bucket, window, vwap::numeric, sdex_vwap::numeric, amm_vwap::numeric,
                volume::numeric, trade_count, open_price::numeric, close_price::numeric,
                high_price::numeric, low_price::numeric
         FROM price_aggregates
         WHERE pair_key = $1 AND window = $2 AND network = $3
         ORDER BY bucket DESC
         LIMIT $4`,
        [pairKey, window, network, limit]
      )

      const windowMs: Record<string, number> = {
        '1m': 60_000,
        '5m': 300_000,
        '1h': 3600_000,
        '24h': 86400_000,
      }
      const span = (windowMs[window] ?? 3600_000) * limit
      const now = new Date()
      const queryStart = new Date(now.getTime() - span)

      const overlappingGaps = await findOverlappingGaps({
        network,
        pair: pairKey,
        start: queryStart,
        end: now,
      })

      const gapDeclaration = overlappingGaps.length > 0 ? { incomplete: true, gaps: overlappingGaps } : {}

      return {
        pairKey,
        network,
        window,
        buckets: result.rows.map(r => ({
          bucket: r.bucket,
          vwap: formatDecimal(r.vwap, decimalFormat),
          sdexVwap: formatDecimal(r.sdex_vwap, decimalFormat),
          ammVwap: formatDecimal(r.amm_vwap, decimalFormat),
          volume: formatDecimal(r.volume, decimalFormat),
          tradeCount: r.trade_count !== null && r.trade_count !== undefined ? parseInt(String(r.trade_count), 10) : null,
          open: formatDecimal(r.open_price, decimalFormat),
          close: formatDecimal(r.close_price, decimalFormat),
          high: formatDecimal(r.high_price, decimalFormat),
          low: formatDecimal(r.low_price, decimalFormat),
        })),
        ...gapDeclaration,
      }
    }
  )

  // GET /pools?cursor=&limit=
  //
  // Latest snapshot per pool for one network, without reading history. The pool
  // ids are discovered with a recursive "skip scan" over the
  // (network, pool_id, timestamp DESC) index (jump to the next distinct pool_id
  // each step), then one LIMIT 1 index probe per pool fetches its newest row.
  // Cost is O(pools x log n); the old DISTINCT ON sorted every row of every
  // network. A quiet pool is kept with its real `timestamp`, never dropped.
  //
  // Paginated keyset-style on pool_id ASC (default limit 50, max 200): the
  // cursor carries the last page's pool_id, and the skip scan's seed query
  // resumes strictly after it, so a pool inserted mid-paging cannot shift a
  // page boundary the way an OFFSET would.
  app.get<{ Querystring: { cursor?: string; limit?: string } }>(
    '/pools',
    { config: { scope: 'read:prices' }, schema: { response: { 200: poolsResponseSchema } } },
    async (req, reply) => {
      const network = req.network ?? activeNetwork
      const decimalFormat = resolveDecimalFormat(req)
      if (decimalFormat === 'string') {
        reply.header('x-decimal-format', 'string')
      }

      const parsedLimit = parseLimit(req.query.limit, POOLS_DEFAULT_LIMIT, POOLS_MAX_LIMIT)
      if ('error' in parsedLimit) {
        return reply.status(400).send({ error: parsedLimit.error })
      }
      const { limit } = parsedLimit

      const params: unknown[] = [network]
      let seedFilter = ''
      if (req.query.cursor) {
        const decoded = decodeCursor(req.query.cursor)
        if (decoded === null) {
          return reply.status(400).send({ error: 'Invalid cursor format' })
        }
        if (decoded !== 'skip') {
          params.push(decoded.value)
          seedFilter = ` AND pool_id > $${params.length}`
        }
      }
      params.push(limit + 1) // Fetch one extra to determine hasMore

      const result = await pgPool.query(
        `WITH RECURSIVE ids AS (
           (SELECT pool_id FROM pool_snapshots WHERE network = $1${seedFilter} ORDER BY pool_id LIMIT 1)
           UNION ALL
           SELECT (SELECT s.pool_id FROM pool_snapshots s
                    WHERE s.network = $1 AND s.pool_id > ids.pool_id
                    ORDER BY s.pool_id LIMIT 1)
             FROM ids
            WHERE ids.pool_id IS NOT NULL
         )
         SELECT l.pool_id, l.asset_a, l.asset_b,
                l.reserve_a::numeric, l.reserve_b::numeric, l.spot_price::numeric, l.fee_bp, l.timestamp
           FROM ids
          CROSS JOIN LATERAL (
                SELECT * FROM pool_snapshots s
                 WHERE s.network = $1 AND s.pool_id = ids.pool_id
                 ORDER BY s.timestamp DESC
                 LIMIT 1
               ) l
          WHERE ids.pool_id IS NOT NULL
          ORDER BY l.pool_id ASC
          LIMIT $${params.length}`,
        params
      )

      const { data, hasMore } = slicePage(result.rows, limit)
      const nextCursor =
        hasMore && data.length > 0 ? encodeCursor(data[data.length - 1].pool_id, data[data.length - 1].pool_id) : null

      return {
        pools: data.map(r => ({
          pool_id: r.pool_id,
          asset_a: r.asset_a,
          asset_b: r.asset_b,
          reserve_a: formatDecimal(r.reserve_a, decimalFormat),
          reserve_b: formatDecimal(r.reserve_b, decimalFormat),
          spot_price: formatDecimal(r.spot_price, decimalFormat),
          fee_bp: r.fee_bp !== null && r.fee_bp !== undefined ? parseInt(String(r.fee_bp), 10) : null,
          timestamp: r.timestamp,
        })),
        nextCursor,
        hasMore,
      }
    }
  )

  // GET /price/:assetA/:assetB/depth?amount=1000
  app.get<{
    Params: { assetA: string; assetB: string }
    Querystring: { amount?: string; decimals?: string; decimalFormat?: string }
  }>(
    '/price/:assetA/:assetB/depth',
    {
      config: { scope: 'read:prices' },
      schema: { response: { 200: depthResponseSchema, 503: depthResponseSchema } },
    },
    async (req, reply) => {
      const { assetA, assetB } = req.params
      // Number(), not parseFloat(): parseFloat('100abc') is 100, so a typo in a
      // query string would silently price a different trade than the caller
      // asked for. Trailing junk is a 400.
      const amount = Number(req.query.amount ?? '1000')
      const network = req.network ?? activeNetwork
      const pair = findPair(assetA, assetB, network)

      if (!pair) return reply.status(404).send({ error: `Pair ${assetA}/${assetB} not watched on ${network}` })
      if (isNaN(amount) || amount <= 0) return reply.status(400).send({ error: 'amount must be a positive number' })

      // Depth reads are network-scoped on both legs (pool_snapshots and the
      // price_points subquery that names this pair's pools), so a mainnet pair
      // is never priced off a testnet pool's reserves.
      // Argument order is (network, pairKey, amount, feeOpts). network and
      // pairKey are both strings, so swapping them compiles cleanly and then
      // prices every pair against a network named "XLM/USDC" — worth reading
      // twice before editing this line.
      const depthResult = await getDepth(network, pair.pairKey, amount, {
        horizonUrl: getNetworkConfig(network).horizon.url,
      })

      // An unavailable answer is a 503, not a 200 with zeros: the pair is
      // watched, we simply cannot price it right now, and a caller retrying
      // later is the correct response to that.
      return reply.status(depthResult.status === 'unavailable' ? 503 : 200).send({
        assetA: pair.assetA.code,
        assetB: pair.assetB.code,
        // pairKey and network come from depthResult, which carries both on each
        // arm of the union. Naming pairKey here too made it a duplicate key.
        ...depthResult,
      })
    }
  )

  // GET /impact/:assetA/:assetB?thresholds=1,5,10
  app.get<{
    Params: { assetA: string; assetB: string }
    Querystring: { thresholds?: string; liquidityFraction?: string }
  }>(
    '/impact/:assetA/:assetB',
    { schema: { response: { 200: impactResponseSchema } } },
    async (req, reply) => {
      const { assetA, assetB } = req.params
      const network = req.network ?? activeNetwork
      const pair = findPair(assetA, assetB, network)
      if (!pair) return reply.status(404).send({ error: `Pair ${assetA}/${assetB} not watched on ${network}` })

      const thresholds = req.query.thresholds
        ? req.query.thresholds.split(',').map(Number)
        : [1, 5, 10]
      const liquidityFraction = req.query.liquidityFraction === undefined
        ? 0.5
        : Number(req.query.liquidityFraction)
      if (
        thresholds.length === 0 ||
        thresholds.some(value => !Number.isFinite(value) || value <= 0) ||
        !Number.isFinite(liquidityFraction) || liquidityFraction <= 0 || liquidityFraction > 1
      ) {
        return reply.status(400).send({ error: 'thresholds must be positive numbers and liquidityFraction must be between 0 and 1' })
      }

      const impact = await getImpact(pair.pairKey, { thresholds, liquidityFraction }, network)
      if (!impact) return reply.status(404).send({ error: `No AMM liquidity available for ${assetA}/${assetB}` })
      return { assetA: pair.assetA.code, assetB: pair.assetB.code, pairKey: pair.pairKey, ...impact }
    }
  )
}
