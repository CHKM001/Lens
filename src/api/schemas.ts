/**
 * Shared JSON Schema objects for REST response validation.
 *
 * These schemas serve two purposes:
 *   1. They are attached to routes via `{ schema: { response: { 200: ... } } }`,
 *      which lets Fastify auto-generate a correct OpenAPI/Swagger spec and use
 *      fast, schema-aware serialization.
 *   2. In non-production environments they additionally *validate* the outgoing
 *      payload (see `installResponseValidation`), so an accidental change to a
 *      response shape fails loudly in tests instead of shipping silently.
 *
 * NOTE: response validation has no runtime impact in production — it is only
 * installed when NODE_ENV !== 'production'. In production Fastify falls back to
 * its default (fast) serializer for these same schemas.
 */
import Ajv from 'ajv'
import type { FastifyInstance, FastifySchema } from 'fastify'

/**
 * One dependency probe result, shared by `/ready`.
 *
 * `reason` is a fixed phrase rather than the raw error: connection errors carry
 * the host and port, and this is a public endpoint (see src/health.ts).
 */
const dependencyCheckSchema = {
  type: 'object',
  required: ['status', 'latencyMs', 'reason'],
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['up', 'down', 'skipped'] },
    latencyMs: { type: 'integer' },
    reason: { type: ['string', 'null'] },
  },
} as const

/** GET /live */
export const liveResponseSchema = {
  type: 'object',
  required: ['ok', 'uptimeSeconds'],
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    uptimeSeconds: { type: 'integer' },
  },
} as const

/** GET /ready — same body on 200 and 503, so `ok` is what distinguishes them. */
export const readyResponseSchema = {
  type: 'object',
  required: ['ok', 'booted', 'checks', 'checkedAt'],
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    booted: { type: 'boolean' },
    checks: {
      type: 'object',
      required: ['postgres', 'redis'],
      additionalProperties: false,
      properties: {
        postgres: dependencyCheckSchema,
        redis: dependencyCheckSchema,
      },
    },
    checkedAt: { type: 'string' },
  },
} as const

/** GET /status (#273) */
export const statusResponseSchema = {
  type: 'object',
  required: [
    'ok',
    'status',
    'network',
    'health',
    'process',
    'data',
    'watchedPairs',
    'lastIndexedLedger',
    'lastProcessedAt',
    'ingestLagSeconds',
  ],
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    status: { type: 'string', enum: ['healthy', 'degraded', 'unhealthy'] },
    network: { type: 'string', enum: ['testnet', 'mainnet'] },
    health: {
      type: 'object',
      required: ['process', 'data'],
      properties: {
        process: { type: 'string', enum: ['healthy', 'degraded'] },
        data: { type: 'string', enum: ['healthy', 'stale'] },
      },
    },
    process: {
      type: 'object',
      required: ['uptimeSeconds', 'memoryUsageMb', 'status'],
      properties: {
        uptimeSeconds: { type: 'number' },
        memoryUsageMb: { type: 'number' },
        status: { type: 'string' },
      },
    },
    data: {
      type: 'object',
      required: ['lastIndexedLedger', 'lastProcessedAt', 'ingestLagSeconds', 'isStale'],
      properties: {
        lastIndexedLedger: { type: ['integer', 'null'] },
        lastProcessedAt: {},
        ingestLagSeconds: { type: ['integer', 'null'] },
        isStale: { type: 'boolean' },
      },
    },
    watchedPairs: { type: 'array', items: { type: 'string' } },
    lastIndexedLedger: { type: ['integer', 'null'] },
    lastProcessedAt: {},
    ingestLagSeconds: { type: ['integer', 'null'] },
    adminConfigured: { type: 'boolean' },
    crashes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'network', 'message', 'at'],
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          network: { type: 'string', enum: ['testnet', 'mainnet'] },
          message: { type: 'string' },
          at: { type: 'string' },
        },
      },
    },
    /** #329: sources whose latest fetch failed, per (source, subject). */
    failedSources: {
      type: 'array',
      items: {
        type: 'object',
        required: ['source', 'network', 'subject', 'at'],
        additionalProperties: false,
        properties: {
          source: { type: 'string' },
          network: { type: 'string', enum: ['testnet', 'mainnet'] },
          /** The pair key for a venue, the asset code for an oracle. */
          subject: { type: 'string' },
          at: { type: 'string' },
        },
      },
    },
    // Per-venue heartbeat state (Issue #219).
    venueHeartbeats: {
      type: 'array',
      items: {
        type: 'object',
        required: ['venue', 'network', 'lastSuccess', 'lastWrite', 'consecutiveFailures', 'stalenessThresholdMs'],
        additionalProperties: false,
        properties: {
          venue: { type: 'string' },
          network: { type: 'string', enum: ['testnet', 'mainnet'] },
          lastSuccess: { type: ['string', 'null'] },
          lastWrite: { type: ['string', 'null'] },
          consecutiveFailures: { type: 'integer' },
          stalenessThresholdMs: { type: 'integer' },
        },
      },
    },
  },
} as const

/**
 * GET /status, 503 (#273).
 *
 * `error` is a fixed, non-revealing phrase, never the driver's message: this
 * route is public and unauthenticated, and a pg failure carries the host, the
 * user and sometimes the connection string. `additionalProperties: false` is
 * what keeps a future hand from adding a `detail` field here.
 */
export const statusErrorResponseSchema = {
  type: 'object',
  required: ['ok', 'status', 'error', 'pagingCondition'],
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', const: false },
    status: { type: 'string', const: 'unhealthy' },
    error: { type: 'string' },
    pagingCondition: { type: 'string' },
  },
} as const

/** GET /price/:assetA/:assetB */
export const priceResponseSchema = {
  type: 'object',
  required: [
    'assetA',
    'assetB',
    'pairKey',
    'network',
    'price',
    'sdexPrice',
    'ammPrice',
    'volume24h',
    'sdexVolume24h',
    'ammVolume24h',
    'vwap1m',
    'vwap5m',
    'vwap1h',
    'vwap24h',
    'priceChange24h',
    'sources',
    'confidence',
    'lastTradeAgeSeconds',
    'newestInputObservedAt',
    'inputCount',
    'stalenessThresholdSeconds',
    'stale',
    'excludedVenues',
    'bestRoute',
    'lastUpdated',
  ],
  additionalProperties: false,
  properties: {
    assetA: { type: 'string' },
    assetB: { type: 'string' },
    pairKey: { type: 'string' },
    network: { type: 'string', enum: ['testnet', 'mainnet'] },
    price: { type: ['number', 'string'] },
    sdexPrice: { type: ['number', 'string'] },
    ammPrice: { type: ['number', 'string'] },
    volume24h: { type: ['number', 'string'] },
    sdexVolume24h: { type: ['number', 'string'] },
    ammVolume24h: { type: ['number', 'string'] },
    vwap1m: { type: ['number', 'string'] },
    vwap5m: { type: ['number', 'string'] },
    vwap1h: { type: ['number', 'string'] },
    vwap24h: { type: ['number', 'string'] },
    priceChange24h: { type: ['number', 'string'] },
    sources: { type: 'integer' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low', 'unknown'] },
    lastTradeAgeSeconds: { type: ['integer', 'null'] },
    newestInputObservedAt: { type: ['string', 'null'] },
    inputCount: { type: 'integer' },
    stalenessThresholdSeconds: { type: 'integer' },
    stale: { type: 'boolean' },
    // Venues whose last written price is older than their staleness threshold;
    // their prices are excluded from this aggregate. Empty when all venues are live.
    excludedVenues: { type: 'array', items: { type: 'string' } },
    bestRoute: { type: 'string', enum: ['SDEX', 'AMM', 'SPLIT', 'UNKNOWN'] },
    lastUpdated: { type: 'string' },
  },
} as const

/** Hop schema for multi-hop routes */
const routeHopSchema = {
  type: 'object',
  required: [
    'assetIn',
    'assetOut',
    'venue',
    'inputAmount',
    'outputAmount',
    'price',
    'spotPrice',
    'slippagePct',
  ],
  additionalProperties: false,
  properties: {
    assetIn: {
      type: 'object',
      required: ['code'],
      properties: {
        code: { type: 'string' },
        issuer: { type: ['string', 'null'] },
      },
    },
    assetOut: {
      type: 'object',
      required: ['code'],
      properties: {
        code: { type: 'string' },
        issuer: { type: ['string', 'null'] },
      },
    },
    venue: { type: 'string', enum: ['SDEX', 'AMM'] },
    poolId: { type: 'string' },
    inputAmount: { type: ['number', 'string'] },
    outputAmount: { type: ['number', 'string'] },
    price: { type: ['number', 'string'] },
    spotPrice: { type: ['number', 'string'] },
    slippagePct: { type: ['number', 'string'] },
  },
} as const

/** GET /price/:assetA/:assetB/route — matches RouteInfo */
export const routeResponseSchema = {
  type: 'object',
  required: [
    'route',
    'sdexPrice',
    'ammPrice',
    'estimatedOutput',
    'slippagePct',
    'recommendation',
  ],
  additionalProperties: false,
  properties: {
    route: { type: 'string', enum: ['SDEX', 'AMM', 'SPLIT', 'MULTI_HOP', 'UNKNOWN'] },
    sdexPrice: { type: ['number', 'string'] },
    ammPrice: { type: ['number', 'string'] },
    estimatedOutput: { type: ['number', 'string'] },
    slippagePct: { type: ['number', 'string'] },
    recommendation: { type: 'string' },
    network: { type: 'string', enum: ['testnet', 'mainnet'] },
    hops: {
      type: 'array',
      items: routeHopSchema,
    },
    comparison: {
      type: 'object',
      required: ['direct', 'multiHop'],
      additionalProperties: false,
      properties: {
        direct: {
          type: 'object',
          required: ['route', 'sdexPrice', 'ammPrice', 'estimatedOutput', 'slippagePct'],
          additionalProperties: false,
          properties: {
            route: { type: 'string', enum: ['SDEX', 'AMM', 'SPLIT', 'UNKNOWN'] },
            sdexPrice: { type: ['number', 'string'] },
            ammPrice: { type: ['number', 'string'] },
            estimatedOutput: { type: ['number', 'string'] },
            slippagePct: { type: ['number', 'string'] },
          },
        },
        multiHop: {
          type: ['object', 'null'],
          required: ['hops', 'hopCount', 'estimatedOutput', 'effectivePrice', 'slippagePct'],
          additionalProperties: false,
          properties: {
            hops: {
              type: 'array',
              items: routeHopSchema,
            },
            hopCount: { type: 'integer' },
            estimatedOutput: { type: ['number', 'string'] },
            effectivePrice: { type: ['number', 'string'] },
            slippagePct: { type: ['number', 'string'] },
          },
        },
      },
    },
    provenance: {
      type: 'object',
      required: ['sampledAt', 'network', 'venuesQueried', 'sampleCount', 'freshnessSeconds'],
      additionalProperties: false,
      properties: {
        sampledAt: { type: 'string' },
        network: { type: 'string' },
        venuesQueried: {
          type: 'array',
          items: { type: 'string' },
        },
        sampleCount: { type: 'integer' },
        freshnessSeconds: { type: ['number', 'null'] },
      },
    },
  },
} as const

/** GET /price/:assetA/:assetB/history */
export const historyResponseSchema = {
  type: 'object',
  required: ['pairKey', 'network', 'window', 'buckets'],
  additionalProperties: false,
  properties: {
    pairKey: { type: 'string' },
    network: { type: 'string', enum: ['testnet', 'mainnet'] },
    window: { type: 'string', enum: ['1m', '5m', '1h', '24h'] },
    incomplete: { type: 'boolean' },
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        required: ['source', 'start', 'end', 'status'],
        additionalProperties: false,
        properties: {
          source: { type: 'string' },
          start: { type: 'string' },
          end: { type: 'string' },
          status: { type: 'string', enum: ['open', 'permanent'] },
        },
      },
    },
    buckets: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'bucket',
          'vwap',
          'sdexVwap',
          'ammVwap',
          'volume',
          'tradeCount',
          'open',
          'close',
          'high',
          'low',
        ],
        additionalProperties: false,
        properties: {
          bucket: {},
          vwap: { type: ['number', 'string', 'null'] },
          sdexVwap: { type: ['number', 'string', 'null'] },
          ammVwap: { type: ['number', 'string', 'null'] },
          volume: { type: ['number', 'string', 'null'] },
          tradeCount: { type: ['integer', 'null'] },
          open: { type: ['number', 'string', 'null'] },
          close: { type: ['number', 'string', 'null'] },
          high: { type: ['number', 'string', 'null'] },
          low: { type: ['number', 'string', 'null'] },
        },
      },
    },
  },
} as const

/**
 * GET /pools
 *
 * Rows come straight from a raw SQL query whose column set may evolve, so the
 * row shape is intentionally permissive (additionalProperties allowed). The
 * envelope, however, is validated — including the cursor-pagination fields
 * every list route carries alongside its own key.
 */
export const poolsResponseSchema = {
  type: 'object',
  required: ['pools', 'nextCursor', 'hasMore'],
  additionalProperties: false,
  properties: {
    pools: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          pool_id: { type: 'string' },
          asset_a: { type: 'string' },
          asset_b: { type: 'string' },
          reserve_a: { type: ['number', 'string', 'null'] },
          reserve_b: { type: ['number', 'string', 'null'] },
          spot_price: { type: ['number', 'string', 'null'] },
          fee_bp: { type: ['integer', 'null'] },
        },
      },
    },
    nextCursor: { type: ['string', 'null'] },
    hasMore: { type: 'boolean' },
  },
} as const

export const depthResponseSchema = {
  type: 'object',
  // `status` discriminates the two arms. The priced fields are not required,
  // because an unavailable answer deliberately carries no numbers — reporting
  // a spotPrice of 0 for "no pool could price this" is the bug #219 is about.
  required: ['assetA', 'assetB', 'pairKey', 'status'],
  additionalProperties: false,
  properties: {
    assetA: { type: 'string' },
    assetB: { type: 'string' },
    pairKey: { type: 'string' },
    spotPrice: { type: ['number', 'string'] },
    executionPrice: { type: ['number', 'string'] },
    slippagePct: { type: ['number', 'string'] },
    asks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['price', 'size'],
        additionalProperties: false,
        properties: {
          price: { type: ['number', 'string'] },
          size: { type: ['number', 'string'] },
        },
      },
    },
    bids: {
      type: 'array',
      items: {
        type: 'object',
        required: ['price', 'size'],
        additionalProperties: false,
        properties: {
          price: { type: ['number', 'string'] },
          size: { type: ['number', 'string'] },
        },
      },
    },
    source: { type: 'string', enum: ['AMM', 'SDEX', 'BOTH'] },
    status: { type: 'string', enum: ['ok', 'unavailable'] },
    network: { type: 'string', enum: ['testnet', 'mainnet'] },
    reason: { type: 'string' },
    pool: {
      type: 'object',
      required: ['poolId', 'feeBp', 'feeReadAt', 'reservesObservedAt'],
      additionalProperties: false,
      properties: {
        poolId: { type: 'string' },
        // Read from the venue per pool, never assumed — see src/pricing/pool-fee.ts.
        feeBp: { type: 'number' },
        feeReadAt: { type: 'string' },
        reservesObservedAt: { type: 'string' },
      },
    },
    excludedPools: {
      type: 'array',
      items: {
        type: 'object',
        required: ['poolId', 'reason'],
        additionalProperties: false,
        properties: {
          poolId: { type: 'string' },
          reason: { type: 'string' },
        },
      },
    },
  },
} as const

/** GET /book/:assetA/:assetB */
export const bookResponseSchema = {
  type: 'object',
  required: [
    'assetA', 'assetB', 'pairKey', 'network', 'spotPrice', 'spotSource',
    'depth', 'step', 'status', 'asks', 'bids', 'provenance',
  ],
  additionalProperties: false,
  properties: {
    assetA: { type: 'string' },
    assetB: { type: 'string' },
    pairKey: { type: 'string' },
    network: { type: 'string', enum: ['testnet', 'mainnet'] },
    spotPrice: { type: ['number', 'string', 'null'] },
    spotSource: { type: ['string', 'null'], enum: ['SDEX_MID', 'SDEX_ASK', 'SDEX_BID', 'AMM_RESERVES', null] },
    depth: { type: ['number', 'string'] },
    step: { type: ['number', 'string'] },
    status: { type: 'string', enum: ['ok', 'partial', 'no_liquidity', 'no_levels_in_range', 'unavailable'] },
    asks: { type: 'array', items: { $ref: '#/definitions/BookLevel' } },
    bids: { type: 'array', items: { $ref: '#/definitions/BookLevel' } },
    provenance: {
      type: 'object',
      required: ['sampledAt', 'sampleCount', 'venues'],
      additionalProperties: false,
      properties: {
        sampledAt: { type: 'string' },
        sampleCount: { type: 'integer' },
        venues: {
          type: 'array',
          items: {
            type: 'object',
            required: ['venue', 'status', 'sampleCount', 'observedAt', 'dataAgeSeconds', 'truncated'],
            additionalProperties: false,
            properties: {
              venue: { type: 'string' },
              status: { type: 'string', enum: ['available', 'no_liquidity', 'unavailable'] },
              sampleCount: { type: 'integer' },
              observedAt: { type: ['string', 'null'] },
              dataAgeSeconds: { type: ['number', 'null'] },
              truncated: { type: 'boolean' },
            },
          },
        },
      },
    },
  },
  definitions: {
    BookLevel: {
      type: 'object',
      required: ['price', 'size', 'cumulativeSize', 'venues', 'synthetic', 'sampleCount'],
      additionalProperties: false,
      properties: {
        price: { type: ['number', 'string'] },
        size: { type: ['number', 'string'] },
        cumulativeSize: { type: ['number', 'string'] },
        venues: { type: 'array', items: { type: 'string' } },
        synthetic: { type: 'boolean' },
        sampleCount: { type: 'integer' },
      },
    },
  },
} as const

/** GET /impact/:assetA/:assetB */
export const impactResponseSchema = {
  type: 'object',
  required: ['assetA', 'assetB', 'pairKey', 'status', 'spotPrice', 'availableLiquidity', 'smallestSize', 'ladder', 'thresholds', 'source'],
  additionalProperties: false,
  properties: {
    assetA: { type: 'string' },
    assetB: { type: 'string' },
    pairKey: { type: 'string' },
    status: { type: 'string', enum: ['ok', 'insufficient_liquidity'] },
    spotPrice: { type: 'number' },
    availableLiquidity: { type: 'number' },
    smallestSize: { type: 'number' },
    ladder: {
      type: 'array',
      items: {
        type: 'object',
        required: ['size', 'output', 'executionPrice', 'slippagePct'],
        additionalProperties: false,
        properties: {
          size: { type: 'number' },
          output: { type: 'number' },
          executionPrice: { type: 'number' },
          slippagePct: { type: 'number' },
        },
      },
    },
    thresholds: {
      type: 'array',
      items: {
        type: 'object',
        required: ['thresholdPct', 'crossed', 'size'],
        additionalProperties: false,
        properties: {
          thresholdPct: { type: 'number' },
          crossed: { type: 'boolean' },
          size: { type: ['number', 'null'] },
        },
      },
    },
    source: { type: 'string', enum: ['AMM'] },
  },
} as const

/** GET /benchmark/:asset */
export const benchmarkResponseSchema = {
  type: 'object',
  required: ['asset', 'target', 'pairKey', 'currentPrice', 'currentDeviationBp', 'rolling24h'],
  additionalProperties: false,
  properties: {
    asset: { type: 'string' },
    target: { type: 'string' },
    pairKey: { type: 'string' },
    currentPrice: { type: ['number', 'string', 'null'] },
    currentDeviationBp: { type: ['number', 'string', 'null'] },
    rolling24h: {
      type: 'object',
      required: [
        'maxDeviationBp',
        'minDeviationBp',
        'maxAbsoluteDeviationBp',
        'averageDeviationBp',
        'sampleCount',
      ],
      additionalProperties: false,
      properties: {
        maxDeviationBp: { type: ['number', 'string', 'null'] },
        minDeviationBp: { type: ['number', 'string', 'null'] },
        maxAbsoluteDeviationBp: { type: ['number', 'string', 'null'] },
        averageDeviationBp: { type: ['number', 'string', 'null'] },
        sampleCount: { type: 'integer' },
      },
    },
  },
} as const

// An asset identifier, shared by the /snapshot sub-objects below. `issuer` is
// null only for the native asset (XLM); every issued asset keeps its issuer,
// since the same code from a different issuer is a different asset.
const assetIdSchema = {
  type: 'object',
  required: ['code', 'issuer'],
  additionalProperties: false,
  properties: {
    code: { type: 'string' },
    issuer: { type: ['string', 'null'] },
  },
} as const

/**
 * GET /snapshot
 *
 * The whole-network summary. `additionalProperties: false` throughout so an
 * accidental new field fails validation in dev/test rather than shipping
 * silently; nullable numbers/strings are explicit, because the endpoint
 * reports "unknown" as null with a reason instead of inventing a value.
 */
export const snapshotResponseSchema = {
  type: 'object',
  required: [
    'network',
    'asOf',
    'generatedAt',
    'window',
    'cache',
    'venues',
    'tvl',
    'volume24h',
    'topPairs',
    'pegs',
    'freshness',
  ],
  additionalProperties: false,
  properties: {
    network: { type: 'string', enum: ['testnet', 'mainnet'] },
    asOf: { type: 'string' },
    generatedAt: { type: 'string' },
    window: { type: 'string', enum: ['24h'] },
    cache: {
      type: 'object',
      required: ['ttlSeconds', 'maxAgeSeconds', 'hit', 'storedAt', 'ageSeconds'],
      additionalProperties: false,
      properties: {
        ttlSeconds: { type: 'integer' },
        maxAgeSeconds: { type: 'integer' },
        hit: { type: 'boolean' },
        storedAt: { type: 'string' },
        ageSeconds: { type: ['integer', 'null'] },
      },
    },
    venues: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'name',
          'source',
          'type',
          'enabled',
          'status',
          'samples',
          'samples24h',
          'pairs24h',
          'lastUpdated',
          'ageSeconds',
        ],
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          source: { type: 'string' },
          type: { type: 'string', enum: ['orderbook', 'amm', 'unknown'] },
          enabled: { type: ['boolean', 'null'] },
          status: { type: 'string', enum: ['reporting', 'stale', 'silent', 'disabled'] },
          samples: { type: 'integer' },
          samples24h: { type: 'integer' },
          pairs24h: { type: 'integer' },
          lastUpdated: { type: ['string', 'null'] },
          ageSeconds: { type: ['integer', 'null'] },
        },
      },
    },
    tvl: {
      type: 'object',
      required: [
        'note',
        'poolCount',
        'sampleCount',
        'lastUpdated',
        'ageSeconds',
        'stale',
        'byAsset',
        'pools',
      ],
      additionalProperties: false,
      properties: {
        note: { type: 'string' },
        poolCount: { type: 'integer' },
        sampleCount: { type: 'integer' },
        lastUpdated: { type: ['string', 'null'] },
        ageSeconds: { type: ['integer', 'null'] },
        stale: { type: 'boolean' },
        byAsset: {
          type: 'array',
          items: {
            type: 'object',
            required: ['asset', 'amount', 'pools'],
            additionalProperties: false,
            properties: {
              asset: assetIdSchema,
              amount: { type: 'number' },
              pools: { type: 'integer' },
            },
          },
        },
        pools: {
          type: 'array',
          items: {
            type: 'object',
            required: [
              'poolId',
              'pairKey',
              'assetA',
              'assetB',
              'reserveA',
              'reserveB',
              'spotPrice',
              'feeBp',
              'lastUpdated',
              'ageSeconds',
            ],
            additionalProperties: false,
            properties: {
              poolId: { type: 'string' },
              pairKey: { type: ['string', 'null'] },
              assetA: assetIdSchema,
              assetB: assetIdSchema,
              reserveA: { type: ['number', 'null'] },
              reserveB: { type: ['number', 'null'] },
              spotPrice: { type: ['number', 'null'] },
              feeBp: { type: ['integer', 'null'] },
              lastUpdated: { type: ['string', 'null'] },
              ageSeconds: { type: ['integer', 'null'] },
            },
          },
        },
      },
    },
    volume24h: {
      type: 'object',
      required: ['window', 'sampleCount', 'byVenue', 'total'],
      additionalProperties: false,
      properties: {
        window: { type: 'string', enum: ['24h'] },
        sampleCount: { type: 'integer' },
        byVenue: {
          type: 'array',
          items: {
            type: 'object',
            required: [
              'venue',
              'baseVolume',
              'counterVolume',
              'samples',
              'pairs',
              'lastUpdated',
              'ageSeconds',
            ],
            additionalProperties: false,
            properties: {
              venue: { type: 'string' },
              baseVolume: { type: 'number' },
              counterVolume: { type: 'number' },
              samples: { type: 'integer' },
              pairs: { type: 'integer' },
              lastUpdated: { type: ['string', 'null'] },
              ageSeconds: { type: ['integer', 'null'] },
            },
          },
        },
        total: {
          type: 'object',
          required: ['value', 'unit', 'reason'],
          additionalProperties: false,
          properties: {
            value: { type: ['number', 'null'] },
            unit: { ...assetIdSchema, type: ['object', 'null'] },
            reason: { type: ['string', 'null'] },
          },
        },
      },
    },
    topPairs: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'pairKey',
          'configured',
          'assetA',
          'assetB',
          'price',
          'baseVolume24h',
          'counterVolume24h',
          'samples24h',
          'venues',
          'lastUpdated',
          'ageSeconds',
        ],
        additionalProperties: false,
        properties: {
          pairKey: { type: 'string' },
          configured: { type: 'boolean' },
          assetA: { ...assetIdSchema, type: ['object', 'null'] },
          assetB: { ...assetIdSchema, type: ['object', 'null'] },
          price: { type: ['number', 'null'] },
          baseVolume24h: { type: 'number' },
          counterVolume24h: { type: 'number' },
          samples24h: { type: 'integer' },
          venues: { type: 'array', items: { type: 'string' } },
          lastUpdated: { type: ['string', 'null'] },
          ageSeconds: { type: ['integer', 'null'] },
        },
      },
    },
    pegs: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'asset',
          'target',
          'pairKey',
          'quote',
          'price',
          'deviationBp',
          'status',
          'reason',
          'samples24h',
          'lastUpdated',
        ],
        additionalProperties: false,
        properties: {
          asset: assetIdSchema,
          target: { type: 'string' },
          pairKey: { type: 'string' },
          quote: { ...assetIdSchema, type: ['object', 'null'] },
          price: { type: ['number', 'null'] },
          deviationBp: { type: ['number', 'null'] },
          status: {
            type: 'string',
            enum: ['on_peg', 'off_peg', 'no_reference', 'no_data'],
          },
          reason: { type: ['string', 'null'] },
          samples24h: { type: 'integer' },
          lastUpdated: { type: ['string', 'null'] },
        },
      },
    },
    freshness: {
      type: 'object',
      required: [
        'asOf',
        'windowStart',
        'windowEnd',
        'lastUpdated',
        'ageSeconds',
        'staleAfterSeconds',
        'stale',
        'venuesReporting',
        'venuesExpected',
        'venuesSilent',
      ],
      additionalProperties: false,
      properties: {
        asOf: { type: 'string' },
        windowStart: { type: 'string' },
        windowEnd: { type: 'string' },
        lastUpdated: { type: ['string', 'null'] },
        ageSeconds: { type: ['integer', 'null'] },
        staleAfterSeconds: { type: 'integer' },
        stale: { type: 'boolean' },
        venuesReporting: { type: 'integer' },
        venuesExpected: { type: 'integer' },
        venuesSilent: { type: 'integer' },
      },
    },
  },
} as const

export const venuesResponseSchema = {
  type: 'object',
  required: ['network', 'window', 'venues', 'excludedVenues', 'totalVolume', 'marketShares', 'periodOverPeriodPctChange'],
  additionalProperties: false,
  properties: {
    network: { type: 'string', enum: ['testnet', 'mainnet'] },
    window: { type: 'string', enum: ['24h', '7d', '30d'] },
    venues: {
      type: 'array',
      items: {
        type: 'object',
        required: ['venue', 'baseVolume', 'counterVolume', 'samples', 'pairs', 'marketShare', 'periodOverPeriodPctChange', 'lastUpdated', 'ageSeconds'],
        additionalProperties: false,
        properties: {
          venue: { type: 'string' },
          baseVolume: { type: ['number', 'string'] },
          counterVolume: { type: ['number', 'string'] },
          samples: { type: 'integer' },
          pairs: { type: 'integer' },
          marketShare: { type: 'number' },
          periodOverPeriodPctChange: { type: 'number' },
          lastUpdated: { type: ['string', 'null'] },
          ageSeconds: { type: ['integer', 'null'] },
        },
      },
    },
    excludedVenues: {
      type: 'array',
      items: { type: 'string' },
    },
    totalVolume: {
      type: 'object',
      required: ['value', 'unit', 'reason'],
      additionalProperties: false,
      properties: {
        value: { type: ['number', 'null'] },
        unit: { type: ['object', 'null'], properties: { code: { type: 'string' }, issuer: { type: ['string', 'null'] } } },
        reason: { type: ['string', 'null'] },
      },
    },
    marketShares: {
      type: 'object',
      additionalProperties: false,
      properties: {
        total: { type: 'number' },
        variance: { type: 'number' },
      },
    },
    periodOverPeriodPctChange: { type: 'number' },
  },
} as const

/** GET /pegs */
export const pegsResponseSchema = {
  type: 'object',
  required: ['network', 'pegs'],
  additionalProperties: false,
  properties: {
    network: { type: 'string', enum: ['testnet', 'mainnet'] },
    pegs: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'asset',
          'code',
          'issuer',
          'target',
          'targetPrice',
          'pairKey',
          'currentPrice',
          'currentDeviationBps',
          'worstDeviationBps',
          'window',
          'provenance',
        ],
        additionalProperties: false,
        properties: {
          asset: { type: 'string' },
          code: { type: 'string' },
          issuer: { type: ['string', 'null'] },
          target: { type: 'string' },
          targetPrice: { type: 'number' },
          pairKey: { type: ['string', 'null'] },
          currentPrice: { type: ['number', 'null'] },
          currentDeviationBps: { type: ['number', 'null'] },
          worstDeviationBps: { type: ['number', 'null'] },
          window: { type: 'string' },
          provenance: {
            type: 'object',
            required: ['venues', 'sampleCount', 'freshnessSeconds', 'lastSampleTimestamp'],
            additionalProperties: false,
            properties: {
              venues: {
                type: 'array',
                items: { type: 'string' },
              },
              sampleCount: { type: 'integer' },
              freshnessSeconds: { type: ['integer', 'null'] },
              lastSampleTimestamp: { type: ['string', 'null'] },
            },
          },
        },
      },
    },
  },
} as const

/**
 * Install response-shape validation on a Fastify instance.
 *
 * Default Fastify behaviour is to *serialize* against the response schema,
 * silently dropping unknown keys — which means a drifted shape would still
 * return 200. To make accidental shape changes fail loudly we replace the
 * serializer with one that first validates the payload against the schema and
 * throws a 500 (FST_ERR_RESPONSE_SERIALIZATION) when it does not match.
 *
 * Skipped entirely in production so there is no added runtime cost there.
 */
export function installResponseValidation(app: FastifyInstance): void {
  if (process.env.NODE_ENV === 'production') return

  const ajv = new Ajv({ allErrors: true, coerceTypes: false, allowUnionTypes: true })

  app.setSerializerCompiler(({ schema }: { schema: FastifySchema }) => {
    const validate = ajv.compile(schema as object)
    return (data: unknown) => {
      if (!validate(data)) {
        const detail = ajv.errorsText(validate.errors, { dataVar: 'response' })
        throw new Error(`Response does not match schema: ${detail}`)
      }
      return JSON.stringify(data)
    }
  })
}
