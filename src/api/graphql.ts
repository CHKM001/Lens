import type { FastifyInstance } from 'fastify'
import { ErrorWithProps } from 'mercurius'
import { price_requests_total } from '../metrics'
import mercurius, { withFilter, defaultErrorFormatter, type MercuriusContext } from 'mercurius'
import { GraphQLError, type ExecutionResult } from 'graphql'
import { randomUUID } from 'node:crypto'
import { getCachedPrice } from '../redis'
import { getAggregatedPrice } from '../aggregator/vwap'
import { getBestRoute } from '../aggregator/bestRoute'
import { getStaleVenues } from '../venueHeartbeat'
import { pgPool } from '../db'
import { config, activeNetwork, type NetworkName } from '../config'
import { parseAssetStr, getActivePairs } from '../pairsRegistry'
import { reflectorOracleAdapter } from '../ingest/oracles/reflector'
import type { OracleAdapter } from '../ingest/oracles/adapter'
import { compareOracles } from '../services/oracleComparison'
import {
  ALLOWED_SORT_FIELDS,
  MARKET_CAP_CODE,
  MARKET_CAP_UNSUPPORTED,
  runScreener,
  ScreenerCursorError,
  ScreenerSortError,
  SCREENER_DEFAULT_LIMIT,
  SCREENER_MAX_LIMIT,
} from '../services/screener'
import { priceEmitter, PRICE_PUBLISHED, type PricePublishedEvent } from '../events'
import { HISTORY_INTERVAL_SECONDS, MAX_HISTORY_POINTS } from './history'
import { getMaxGraphQLQueryDepth, queryDepthValidationRules } from './queryDepth'

const WINDOW_SECONDS: Record<string, number> = {
  ...HISTORY_INTERVAL_SECONDS,
  '24h': 86400,
}

// Mercurius pubsub topic that carries every new price. A single app-level
// listener bridges the ingesters' in-process `priceEmitter` onto this topic;
// each subscriber then filters it down to the pair they asked for.
const PRICE_TOPIC = 'PRICE_UPDATED'
// Error codes that resolvers raise on purpose; their messages are written for
// the caller and are safe to return as-is. Anything else is treated as an
// unexpected internal failure and masked. UNSUPPORTED_PARAMETER carries the
// screener's market_cap rejection (shared with the REST route).
const USER_FACING_CODES = new Set([
  'INVALID_INPUT',
  'PAIR_NOT_FOUND',
  'UNAUTHORIZED',
  'UNSUPPORTED_PARAMETER',
])
const INTERNAL_ERROR_MESSAGE = 'Internal server error'

function isUserFacing(err: GraphQLError): boolean {
  // No originalError means graphql-js itself rejected the document (syntax or
  // validation), which only describes the caller's own query.
  const original = err.originalError as
    | { extensions?: { code?: unknown }; errors?: unknown; statusCode?: unknown }
    | undefined
  if (!original) return true
  // Mercurius wraps document validation failures (and other request-level
  // 4xx faults) in a Fastify error before they reach the formatter.
  if (Array.isArray(original.errors)) return true
  if (typeof original.statusCode === 'number' && original.statusCode < 500) return true
  const code = original.extensions?.code
  return typeof code === 'string' && USER_FACING_CODES.has(code)
}

export function formatGraphQLErrors(execution: ExecutionResult, ctx: MercuriusContext) {
  const requestId = String(ctx?.reply?.request?.id ?? randomUUID())
  const log = ctx?.reply?.log ?? ctx?.app?.log

  const errors = (execution.errors ?? []).map(err => {
    if (isUserFacing(err)) return err
    log?.error({ err: err.originalError ?? err, requestId, path: err.path }, 'unexpected graphql error')
    return new GraphQLError(INTERNAL_ERROR_MESSAGE, {
      path: err.path,
      extensions: { code: 'INTERNAL_SERVER_ERROR', requestId },
    })
  })

  return defaultErrorFormatter({ ...execution, errors }, ctx)
}

export const schema = `
  type Asset {
    code: String!
    issuer: String
  }

  type Pair {
    pairKey: String!
    network: String!
    assetA: Asset!
    assetB: Asset!
    latestPrice: Float
    lastUpdated: String
  }

  type AggregatedPrice {
    assetA: String!
    assetB: String!
    pairKey: String!
    price: Float!
    sdexPrice: Float!
    ammPrice: Float!
    bestRoute: String!
    volume24h: Float!
    sdexVolume24h: Float!
    ammVolume24h: Float!
    vwap1m: Float!
    vwap5m: Float!
    vwap1h: Float!
    vwap24h: Float!
    priceChange24h: Float!
    lastUpdated: String!
    sources: Int!
    confidence: String!
    lastTradeAgeSeconds: Int
    """Venues excluded from this aggregate because their last written price is stale."""
    excludedVenues: [String!]!
  }

  type RouteInfo {
    route: String!
    sdexPrice: Float!
    ammPrice: Float!
    estimatedOutput: Float!
    slippagePct: Float!
    recommendation: String!
    network: String
  }

  type PriceBucket {
    bucket: String!
    window: String!
    vwap: Float!
    sdexVwap: Float
    ammVwap: Float
    volume: Float!
    tradeCount: Int!
    open: Float
    close: Float
    high: Float
    low: Float
  }

  type PriceUpdate {
    pair: String!
    price: Float!
    ts: String!
    """Which chain the price came from — testnet or mainnet."""
    network: String!
  }

  enum OracleSourceStatus {
    NOT_CONFIGURED
    AVAILABLE
    UNREACHABLE
    EMPTY
  }

  type OracleSource {
    name: String!
    price: Float
    timestamp: String
    deviationPct: Float
    """
    UNREACHABLE means the adapter failed; EMPTY means it is configured but
    returned no quote.
    """
    status: OracleSourceStatus!
    ageSeconds: Int
  }

  type OracleComparison {
    asset: String!
    network: String!
    lens: Float
    reflector: Float
    deviationPct: Float
    status: String!
    fetchedAt: String!
    oracles: [OracleSource!]!
  }

  """
  Sort order for the \`screener\` query.
  """
  enum ScreenerSortOrder {
    ASC
    DESC
  }

  """
  Filters for the \`screener\` query — the same filters REST GET /screener
  accepts. Every field is optional; an omitted field does not filter.

  \`marketCap\` is declared only so it can be rejected with an explanation,
  mirroring the REST route: Lens has no circulating supply data to compute a
  market cap from. Passing it fails the query with UNSUPPORTED_PARAMETER
  rather than being silently ignored.
  """
  input ScreenerFilters {
    volume: Float
    change24hMin: Float
    change24hMax: Float
    priceMin: Float
    priceMax: Float
    liquidity: Float
    marketCap: Float
  }

  """
  One row of screener results. \`liquidityUnit\` is the quote asset of
  \`pairKey\`; liquidity is summed AMM reserve value denominated in it.
  """
  type ScreenerRow {
    pairKey: String!
    volume: Float!
    price: Float!
    change24h: Float!
    liquidity: Float!
    liquidityUnit: String!
  }

  """
  One page of screener results, cursor-paginated exactly like REST
  GET /screener: pass \`nextCursor\` back as \`cursor\` for the following page;
  it is null on the last page. \`hasMore\` reports whether another page exists.
  """
  type ScreenerPage {
    network: String!
    rows: [ScreenerRow!]!
    nextCursor: String
    hasMore: Boolean!
  }

  type Query {
    """
    Aggregated price for a pair. Three outcomes are kept distinct:

    - Malformed asset input (an asset that is not CODE or CODE:ISSUER) fails
      with a GraphQL error whose extensions.code is INVALID_INPUT.
    - A well-formed pair that is not tracked on the active network fails with
      a GraphQL error whose extensions.code is PAIR_NOT_FOUND.
    - A tracked pair with no trade data yet is not an error: it resolves to an
      AggregatedPrice with zeroed figures rather than null or an error.

    The result is only null if the resolver itself cannot produce a payload;
    clients should branch on extensions.code, not on null.
    """
    getPrice(assetA: String!, assetB: String!): AggregatedPrice
    getBestRoute(assetA: String!, assetB: String!, amount: Float!): RouteInfo
    """
    Returns historical price aggregate buckets for a pair over an optional [from, to] time range.

    The time range is inclusive at both ends: a bucket is included if bucket >= from and bucket <= to.
    Because both endpoints are inclusive, querying adjacent windows (e.g. [t0, t1] and [t1, t2]) will
    return the boundary bucket at t1 in both results.
    """
    getPriceHistory(
      assetA: String!
      assetB: String!
      window: String!
      limit: Int
      from: String
      to: String
    ): [PriceBucket]
    listPairs: [String]! @deprecated(reason: "Use 'pairs' instead")
    pairs: [Pair!]!
    """
    Compares the Lens price for an asset against every configured oracle.
    The network argument defaults to the active network.
    """
    oracle(asset: String!, network: String): OracleComparison
    """
    The pair screener: filter, sort and cursor-paginate tracked pairs. Shares
    its implementation, filters, sort fields and cursor pagination with REST
    GET /screener, and resolves against the active network.

    - \`sortBy\` accepts the REST route's fields: volume, change_24h, price,
      liquidity. Sorting on \`market_cap\` fails with the same explanation REST
      gives (UNSUPPORTED_PARAMETER is reserved for the \`marketCap\` filter):
      Lens has no circulating supply data to compute it from.
    - \`limit\` is clamped to [1, ${SCREENER_MAX_LIMIT}] like REST, never
      rejected.
    """
    screener(
      filters: ScreenerFilters
      sortBy: String = "volume"
      order: ScreenerSortOrder = DESC
      cursor: String
      limit: Int = ${SCREENER_DEFAULT_LIMIT}
    ): ScreenerPage!
  }

  type Subscription {
    """
    Streams a PriceUpdate every time an ingester records a new price for the
    given pair.

    The network argument narrows the stream to one chain. It is optional, and
    omitting it delivers every enabled network — the right default only if you
    read the network field on each message, since a dual-network deployment
    otherwise interleaves two chains prices on one stream.
    """
    priceUpdated(pair: String!, network: String): PriceUpdate!
  }
`

function makePairKey(a: string, b: string): string {
  return [a, b].sort().join('/')
}

function findPair(assetA: string, assetB: string) {
  const normalize = (a: string) => a.toLowerCase() === 'native' ? 'XLM' : a.split(':')[0].toUpperCase()
  const cA = normalize(assetA)
  const cB = normalize(assetB)
  return config.pairs.find(p => {
    const pA = p.assetA.code.toUpperCase()
    const pB = p.assetB.code.toUpperCase()
    return (cA === pA && cB === pB) || (cA === pB && cB === pA)
  })
}

const oracleAdapters: OracleAdapter[] = [reflectorOracleAdapter]

const resolvers = {
  Query: {
    async getPrice(_: unknown, { assetA, assetB }: { assetA: string; assetB: string }) {
      price_requests_total.inc()
      for (const [field, value] of [['assetA', assetA], ['assetB', assetB]] as const) {
        if (!parseAssetStr(value)) {
          throw new ErrorWithProps(
            `Invalid ${field}: expected CODE or CODE:ISSUER, got "${value}"`,
            { code: 'INVALID_INPUT', field },
          )
        }
      }
      const pair = findPair(assetA, assetB)
      if (!pair) {
        throw new ErrorWithProps(
          `Pair ${assetA}/${assetB} is not tracked on ${activeNetwork}`,
          { code: 'PAIR_NOT_FOUND' },
        )
      }
      const pairKey = pair.pairKey

      // These queries carry no network argument, so they resolve against the
      // active network's pair list (findPair above) and read that same
      // network's price data — scoped, not pooled across both chains.
      // Per-request network selection on the GraphQL surface is separate work.
      // The cache key is network-prefixed to match the REST route and the
      // refresh worker, so no deployment can serve another network's cached
      // payload under a network-less key.
      const cacheKey = `${activeNetwork}:${pairKey}`
      const cached = await getCachedPrice(cacheKey)
      if (cached) {
        try { return JSON.parse(cached) } catch { /* fall through */ }
      }

      const agg = await getAggregatedPrice(pairKey, activeNetwork, undefined, getStaleVenues(activeNetwork))
      const route = await getBestRoute(pair.assetA, pair.assetB, pairKey, 1000, activeNetwork)
      return {
        assetA, assetB, pairKey, ...agg,
        bestRoute: route.route,
        lastUpdated: new Date().toISOString(),
      }
    },

    async getBestRoute(
      _: unknown,
      { assetA, assetB, amount }: { assetA: string; assetB: string; amount: number }
    ) {
      const pair = findPair(assetA, assetB)
      if (!pair) return null
      return getBestRoute(pair.assetA, pair.assetB, pair.pairKey, amount)
    },

    async getPriceHistory(
      _: unknown,
      {
        assetA,
        assetB,
        window,
        limit = 100,
        from,
        to,
      }: {
        assetA: string
        assetB: string
        window: string
        limit?: number
        from?: string
        to?: string
      }
    ) {
      let fromDate: Date | undefined
      let toDate: Date | undefined

      if (from !== undefined && from !== null) {
        fromDate = new Date(from)
        if (isNaN(fromDate.getTime())) {
          throw new ErrorWithProps('from must be a valid ISO 8601 date', { code: 'INVALID_INPUT' })
        }
      }

      if (to !== undefined && to !== null) {
        toDate = new Date(to)
        if (isNaN(toDate.getTime())) {
          throw new ErrorWithProps('to must be a valid ISO 8601 date', { code: 'INVALID_INPUT' })
        }
      }

      if (fromDate && toDate && fromDate.getTime() > toDate.getTime()) {
        throw new ErrorWithProps('from must be before to', { code: 'INVALID_INPUT' })
      }

      const intervalSecs = WINDOW_SECONDS[window] ?? HISTORY_INTERVAL_SECONDS[window] ?? 60

      if (fromDate || toDate) {
        const effectiveTo = toDate ?? new Date()
        const effectiveFrom = fromDate ?? new Date(effectiveTo.getTime() - 24 * 60 * 60 * 1000)
        const spanSecs = (effectiveTo.getTime() - effectiveFrom.getTime()) / 1000
        if (spanSecs / intervalSecs > MAX_HISTORY_POINTS) {
          throw new ErrorWithProps(
            `requested window is too large for interval=${window} (max ${MAX_HISTORY_POINTS} points); narrow the range or use a coarser interval`,
            { code: 'INVALID_INPUT' }
          )
        }
      }

      const pairKey = makePairKey(assetA, assetB)
      const conditions: string[] = ['pair_key = $1', 'window = $2']
      const params: any[] = [pairKey, window]

      if (fromDate) {
        params.push(fromDate)
        conditions.push(`bucket >= $${params.length}`)
      }

      if (toDate) {
        params.push(toDate)
        conditions.push(`bucket <= $${params.length}`)
      }

      params.push(Math.min(limit, 1000))
      const limitParam = `$${params.length}`

      const result = await pgPool.query(
        `SELECT bucket, window, vwap::float, sdex_vwap::float, amm_vwap::float,
                volume::float, trade_count, open_price::float, close_price::float,
                high_price::float, low_price::float
         FROM price_aggregates
         WHERE ${conditions.join(' AND ')}
         ORDER BY bucket DESC
         LIMIT ${limitParam}`,
        params
      )
      return result.rows.map(r => ({
        bucket: (r.bucket instanceof Date ? r.bucket : new Date(r.bucket)).toISOString(),
        window: r.window,
        vwap: r.vwap,
        sdexVwap: r.sdex_vwap,
        ammVwap: r.amm_vwap,
        volume: r.volume,
        tradeCount: r.trade_count,
        open: r.open_price,
        close: r.close_price,
        high: r.high_price,
        low: r.low_price,
      }))
    },

    listPairs() {
      return getActivePairs().map(p => p.pairKey)
    },

    async pairs() {
      const activePairs = getActivePairs()
      if (activePairs.length === 0) {
        return []
      }

      const result = await pgPool.query(
        `SELECT p.pair_key, l.price, l.timestamp
           FROM unnest($2::text[]) AS p(pair_key)
          CROSS JOIN LATERAL (
                SELECT price, timestamp
                  FROM price_points
                 WHERE network = $1
                   AND pair_key = p.pair_key
                 ORDER BY timestamp DESC
                 LIMIT 1
               ) l`,
        [activeNetwork, activePairs.map(p => p.pairKey)]
      )

      const latestPrices = new Map<string, { price: number; timestamp: Date }>()
      result.rows.forEach(row => {
        latestPrices.set(row.pair_key, {
          price: parseFloat(row.price),
          timestamp: row.timestamp,
        })
      })

      return activePairs.map(p => {
        const latest = latestPrices.get(p.pairKey)
        return {
          pairKey: p.pairKey,
          network: activeNetwork,
          assetA: p.assetA,
          assetB: p.assetB,
          latestPrice: latest?.price ?? null,
          lastUpdated: latest?.timestamp ? (latest.timestamp instanceof Date ? latest.timestamp.toISOString() : new Date(latest.timestamp).toISOString()) : null,
        }
      })
    },

    async oracle(_: unknown, { asset, network }: { asset: string; network?: string | null }) {
      if (network != null && network !== 'testnet' && network !== 'mainnet') {
        throw new ErrorWithProps('network must be one of: testnet, mainnet', {
          code: 'INVALID_INPUT',
          field: 'network',
        })
      }
      const comparison = await compareOracles(
        asset.toUpperCase(),
        (network ?? activeNetwork) as NetworkName,
        oracleAdapters
      )
      if (!comparison) return null
      return {
        ...comparison,
        oracles: comparison.oracles.map(o => ({ ...o, status: o.status.toUpperCase() })),
      }
    },

    async screener(
      _: unknown,
      {
        filters,
        sortBy,
        order,
        cursor,
        limit,
      }: {
        filters?: {
          volume?: number | null
          change24hMin?: number | null
          change24hMax?: number | null
          priceMin?: number | null
          priceMax?: number | null
          liquidity?: number | null
          marketCap?: number | null
        } | null
        sortBy?: string | null
        order?: 'ASC' | 'DESC' | null
        cursor?: string | null
        limit?: number | null
      }
    ) {
      // market_cap is rejected with the same explanation REST gives, rather
      // than being quietly ignored: the `marketCap` filter exists only to be
      // refused, and `sortBy: "market_cap"` gets the same treatment below.
      if (filters?.marketCap != null) {
        throw new ErrorWithProps(MARKET_CAP_UNSUPPORTED, {
          code: MARKET_CAP_CODE,
          field: 'marketCap',
        })
      }
      // Mirrors REST: sortBy is a validated string parameter, so an invalid
      // value (market_cap included) is an input error carrying the
      // market_cap explanation when that is the reason.
      const sortField = sortBy ?? 'volume'
      if (sortField === 'market_cap') {
        throw new ErrorWithProps(MARKET_CAP_UNSUPPORTED, {
          code: 'INVALID_INPUT',
          field: 'sortBy',
        })
      }
      if (!(ALLOWED_SORT_FIELDS as readonly string[]).includes(sortField)) {
        throw new ErrorWithProps(`sortBy must be one of: ${ALLOWED_SORT_FIELDS.join(', ')}`, {
          code: 'INVALID_INPUT',
          field: 'sortBy',
        })
      }
      try {
        // Filtering, sorting, cursor pagination and the limit clamp are the
        // REST route's implementation (src/services/screener.ts); this layer
        // only maps GraphQL naming (camelCase) onto it. The network is the
        // active one, matching every other GraphQL query here.
        const page = await runScreener({
          network: activeNetwork,
          filters: {
            volume: filters?.volume ?? undefined,
            change_24h_min: filters?.change24hMin ?? undefined,
            change_24h_max: filters?.change24hMax ?? undefined,
            price_min: filters?.priceMin ?? undefined,
            price_max: filters?.priceMax ?? undefined,
            liquidity: filters?.liquidity ?? undefined,
          },
          sortBy: sortField,
          order: order?.toLowerCase() ?? 'desc',
          cursor,
          limit: limit ?? SCREENER_DEFAULT_LIMIT,
        })
        return {
          network: page.network,
          rows: page.data.map(row => ({
            pairKey: row.pair_key,
            volume: row.volume,
            price: row.price,
            change24h: row.change_24h,
            liquidity: row.liquidity,
            liquidityUnit: row.liquidity_unit,
          })),
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
        }
      } catch (error) {
        if (error instanceof ScreenerCursorError || error instanceof ScreenerSortError) {
          throw new ErrorWithProps(error.message, {
            code: 'INVALID_INPUT',
            field: error instanceof ScreenerCursorError ? 'cursor' : 'sortBy',
          })
        }
        throw error
      }
    },
  },

  Subscription: {
    priceUpdated: {
      subscribe: withFilter<
        { priceUpdated: PricePublishedEvent },
        unknown,
        MercuriusContext,
        { pair: string; network?: string | null }
      >(
        (_root, _args, { pubsub }) => pubsub.subscribe(PRICE_TOPIC),
        // Both loops publish to one topic, so the network filter has to happen
        // here. Omitting `network` keeps every chain — the message carries its
        // own `network` field, so the subscriber can still tell them apart.
        (payload, { pair, network }) =>
          payload.priceUpdated.pair === pair &&
          // == null, not === undefined: a client that passes the variable
          // explicitly sends null rather than omitting it, and both mean
          // "every network". Comparing against undefined alone would filter
          // out every message for those clients.
          (network == null || payload.priceUpdated.network === network)
      ),
    },
  },
}

export async function registerGraphQL(app: FastifyInstance) {
  const maxQueryDepth = getMaxGraphQLQueryDepth()

  await app.register(mercurius, {
    schema,
    resolvers,
    graphiql: true,
    // Mercurius 16.9.0 supplies the selected operation name to this callback.
    // Its built-in queryDepth option neither expands fragments nor distinguishes
    // an unselected operation in a multi-operation document. A callback cannot
    // be used with Mercurius's document cache, so disable that cache rather
    // than weakening the operation-aware validation policy.
    cache: false,
    validationRules: ({ operationName }) => queryDepthValidationRules(maxQueryDepth, operationName),
    errorFormatter: formatGraphQLErrors,
    path: '/graphql',
    subscription: {
      // Speak the `graphql-transport-ws` subprotocol (the modern `graphql-ws`
      // library) rather than the legacy `subscriptions-transport-ws`.
      fullWsTransport: true,
      wsDefaultSubprotocol: 'graphql-transport-ws',
    },
  })

  // Bridge: forward every price the ingesters emit onto the GraphQL pubsub
  // topic. Mercurius wraps the payload under the subscription field name so
  // `withFilter` and the resolver receive `{ priceUpdated: <event> }`.
  const onPricePublished = (event: PricePublishedEvent) => {
    app.graphql.pubsub.publish({
      topic: PRICE_TOPIC,
      payload: { priceUpdated: event },
    })
  }
  priceEmitter.on(PRICE_PUBLISHED, onPricePublished)

  // Detach the listener when the server shuts down so repeated
  // register/close cycles (e.g. in tests) don't leak listeners.
  app.addHook('onClose', async () => {
    priceEmitter.off(PRICE_PUBLISHED, onPricePublished)
  })
}
