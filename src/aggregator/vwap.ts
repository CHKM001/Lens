import { pgPool } from '../db'
import { config, type NetworkName } from '../config'
import type { DecimalFormat } from '../utils/decimals'

export const STALENESS_THRESHOLD_SECONDS = 300
export const HIGH_CONFIDENCE_MAX_AGE_SECONDS = 30
export const MEDIUM_CONFIDENCE_MAX_AGE_SECONDS = 300

/**
 * Every query in this module filters on `network`.
 *
 * `price_points` and `pool_snapshots` both carry a `network` column and index
 * it as the leading column of `(network, pair_key, timestamp)`, and the same
 * pair key exists on both chains. An unfiltered read therefore does not return
 * "the" price for a pair — it returns a volume-weighted blend of two separate
 * markets, which is a number no one traded at on either chain.
 *
 * That is why `network` is a required argument rather than an optional
 * refinement: there is no default that is correct by accident, and a caller
 * that doesn't know which chain it is quoting should refuse rather than guess.
 */
export async function calculateVWAPDetailed(
  pairKey: string,
  windowMinutes: number,
  network: NetworkName,
  source?: 'SDEX' | 'AMM',
  excludedSources: string[] = [],
): Promise<{ num: number; raw: string }> {
  const conditions: string[] = [
    `pair_key = $1`,
    `network = $2`,
    `COALESCE(observed_at, timestamp) > NOW() - ($3 || ' minutes')::interval`,
  ]
  const params: (string | number)[] = [pairKey, network, windowMinutes]

  if (source) {
    params.push(source)
    conditions.push(`source = $${params.length}`)
  }

  if (excludedSources.length > 0) {
    params.push(...excludedSources)
    const placeholders = excludedSources.map((_, i) => `$${params.length - excludedSources.length + i + 1}`).join(', ')
    conditions.push(`source NOT IN (${placeholders})`)
  }

  const result = await pgPool.query(
    `SELECT
       COALESCE(
         SUM(price::numeric * base_volume::numeric) / NULLIF(SUM(base_volume::numeric), 0),
         0
       ) AS vwap
     FROM price_points
     WHERE ${conditions.join('\n       AND ')}`,
    params
  )
  const raw = String(result.rows[0]?.vwap ?? '0')
  return { num: parseFloat(raw), raw }
}

export async function calculateVWAP(
  pairKey: string,
  windowMinutes: number,
  network: NetworkName,
  source?: 'SDEX' | 'AMM',
  excludedSources: string[] = [],
): Promise<number> {
  const detailed = await calculateVWAPDetailed(pairKey, windowMinutes, network, source, excludedSources)
  return detailed.num
}

export async function calculateOHLCV(
  pairKey: string,
  windowMinutes: number,
  network: NetworkName
): Promise<{
  open: number; high: number; low: number; close: number
  volume: number; tradeCount: number
}> {
  const result = await pgPool.query(
    `SELECT
       (SELECT price::numeric FROM price_points
        WHERE pair_key = $1 AND network = $2
          AND COALESCE(observed_at, timestamp) > NOW() - ($3 || ' minutes')::interval
        ORDER BY COALESCE(observed_at, timestamp) ASC LIMIT 1) AS open,
       MAX(price::numeric) AS high,
       MIN(price::numeric) AS low,
       (SELECT price::numeric FROM price_points
        WHERE pair_key = $1 AND network = $2
          AND COALESCE(observed_at, timestamp) > NOW() - ($3 || ' minutes')::interval
        ORDER BY COALESCE(observed_at, timestamp) DESC LIMIT 1) AS close,
       SUM(base_volume::numeric) AS volume,
       COUNT(*) AS trade_count
     FROM price_points
     WHERE pair_key = $1
       AND network = $2
       AND COALESCE(observed_at, timestamp) > NOW() - ($3 || ' minutes')::interval`,
    [pairKey, network, windowMinutes]
  )
  const row = result.rows[0]
  return {
    open: parseFloat(row?.open ?? '0'),
    high: parseFloat(row?.high ?? '0'),
    low: parseFloat(row?.low ?? '0'),
    close: parseFloat(row?.close ?? '0'),
    volume: parseFloat(row?.volume ?? '0'),
    tradeCount: parseInt(row?.trade_count ?? '0', 10),
  }
}

/**
 * Sum two decimal strings preserving exact precision without IEEE-754 loss.
 */
export function addDecimalStrings(a: string, b: string): string {
  const cleanA = (a ?? '').trim() || '0'
  const cleanB = (b ?? '').trim() || '0'
  const [aInt = '0', aFrac = ''] = cleanA.split('.')
  const [bInt = '0', bFrac = ''] = cleanB.split('.')
  const maxFracLen = Math.max(aFrac.length, bFrac.length)
  const aPadded = aFrac.padEnd(maxFracLen, '0')
  const bPadded = bFrac.padEnd(maxFracLen, '0')
  const aBig = BigInt((aInt.startsWith('-') ? '-' : '') + aInt.replace('-', '') + aPadded)
  const bBig = BigInt((bInt.startsWith('-') ? '-' : '') + bInt.replace('-', '') + bPadded)
  const sum = aBig + bBig
  const isNeg = sum < 0n
  const sumAbs = isNeg ? -sum : sum
  const sumStr = sumAbs.toString().padStart(maxFracLen + 1, '0')
  const intPart = sumStr.slice(0, sumStr.length - maxFracLen) || '0'
  const fracPart = sumStr.slice(sumStr.length - maxFracLen).replace(/0+$/, '')
  const result = (isNeg ? '-' : '') + (fracPart ? `${intPart}.${fracPart}` : intPart)
  return result === '' || result === '-0' ? '0' : result
}

/**
 * Computes exact percentage change between two decimal strings: ((now - ago) / ago) * 100
 */
export function computePriceChange(
  nowRaw: string | undefined | null,
  agoRaw: string | undefined | null,
  computedRaw?: string | null
): { num: number; raw: string } {
  if (computedRaw != null) {
    const raw = String(computedRaw)
    return { num: parseFloat(raw) || 0, raw }
  }
  const agoStr = (agoRaw != null ? String(agoRaw) : '0').trim()
  const nowStr = (nowRaw != null ? String(nowRaw) : '0').trim()
  const agoNum = parseFloat(agoStr)
  const nowNum = parseFloat(nowStr)
  if (!agoNum || agoNum === 0 || !Number.isFinite(agoNum)) {
    return { num: 0, raw: '0' }
  }
  try {
    const [aInt = '0', aFrac = ''] = agoStr.split('.')
    const [nInt = '0', nFrac = ''] = nowStr.split('.')
    const scale = Math.max(aFrac.length, nFrac.length)
    const aBig = BigInt((aInt.startsWith('-') ? '-' : '') + aInt.replace('-', '') + aFrac.padEnd(scale, '0'))
    const nBig = BigInt((nInt.startsWith('-') ? '-' : '') + nInt.replace('-', '') + nFrac.padEnd(scale, '0'))
    if (aBig === 0n) return { num: 0, raw: '0' }
    const diff = nBig - aBig
    const PRECISION = 18n
    const mult = 10n ** PRECISION
    const scaledQuotient = (diff * 100n * mult) / aBig
    const isNeg = scaledQuotient < 0n
    const absQ = isNeg ? -scaledQuotient : scaledQuotient
    const qStr = absQ.toString().padStart(Number(PRECISION) + 1, '0')
    const intPart = qStr.slice(0, qStr.length - Number(PRECISION)) || '0'
    const fracPart = qStr.slice(qStr.length - Number(PRECISION)).replace(/0+$/, '')
    const raw = (isNeg ? '-' : '') + (fracPart ? `${intPart}.${fracPart}` : intPart)
    return { num: parseFloat(raw) || 0, raw: raw === '' || raw === '-0' ? '0' : raw }
  } catch {
    const num = ((nowNum - agoNum) / agoNum) * 100
    return { num, raw: String(num) }
  }
}

export async function getPriceChange24hDetailed(
  pairKey: string,
  network: NetworkName
): Promise<{ num: number; raw: string }> {
  const result = await pgPool.query(
    `SELECT
       price_24h_ago,
       price_now,
       CASE
         WHEN price_24h_ago IS NULL OR price_24h_ago = 0 THEN 0
         ELSE ((price_now - price_24h_ago) / price_24h_ago * 100)
       END AS price_change_24h
     FROM (
       SELECT
         (SELECT price::numeric FROM price_points
          WHERE pair_key = $1 AND network = $2
            AND COALESCE(observed_at, timestamp) > NOW() - INTERVAL '24 hours'
          ORDER BY COALESCE(observed_at, timestamp) ASC LIMIT 1) AS price_24h_ago,
         (SELECT price::numeric FROM price_points
          WHERE pair_key = $1 AND network = $2
            AND COALESCE(observed_at, timestamp) > NOW() - INTERVAL '24 hours'
          ORDER BY COALESCE(observed_at, timestamp) DESC LIMIT 1) AS price_now
     ) sub`,
    [pairKey, network]
  )
  const row = result.rows[0]
  return computePriceChange(row?.price_now, row?.price_24h_ago, row?.price_change_24h)
}

export async function getPriceChange24h(pairKey: string, network: NetworkName): Promise<number> {
  const detailed = await getPriceChange24hDetailed(pairKey, network)
  return detailed.num
}

export interface AggregatedPriceNumeric {
  price: number
  sdexPrice: number
  ammPrice: number
  volume24h: number
  sdexVolume24h: number
  ammVolume24h: number
  vwap1m: number
  vwap5m: number
  vwap1h: number
  vwap24h: number
  priceChange24h: number
  sources: number
  confidence: 'high' | 'medium' | 'low' | 'unknown'
  lastTradeAgeSeconds: number | null
  newestInputObservedAt: string | null
  inputCount: number
  stalenessThresholdSeconds: number
  stale: boolean
  excludedVenues: string[]
}

export interface AggregatedPriceString {
  price: string
  sdexPrice: string
  ammPrice: string
  volume24h: string
  sdexVolume24h: string
  ammVolume24h: string
  vwap1m: string
  vwap5m: string
  vwap1h: string
  vwap24h: string
  priceChange24h: string
  sources: number
  confidence: 'high' | 'medium' | 'low' | 'unknown'
  lastTradeAgeSeconds: number | null
  newestInputObservedAt: string | null
  inputCount: number
  stalenessThresholdSeconds: number
  stale: boolean
  excludedVenues: string[]
}

export async function getAggregatedPrice(
  pairKey: string,
  network: NetworkName,
  options: { decimalFormat: 'string'; staleThresholdSeconds?: number },
  excludedSources?: string[]
): Promise<AggregatedPriceString>
export async function getAggregatedPrice(
  pairKey: string,
  network: NetworkName,
  options?: { decimalFormat?: 'number'; staleThresholdSeconds?: number },
  excludedSources?: string[]
): Promise<AggregatedPriceNumeric>
export async function getAggregatedPrice(
  pairKey: string,
  network: NetworkName,
  options?: { decimalFormat?: DecimalFormat; staleThresholdSeconds?: number },
  excludedSources?: string[]
): Promise<AggregatedPriceNumeric | AggregatedPriceString>
export async function getAggregatedPrice(
  pairKey: string,
  network: NetworkName,
  options?: { decimalFormat?: DecimalFormat; staleThresholdSeconds?: number },
  excludedSources: string[] = []
): Promise<AggregatedPriceNumeric | AggregatedPriceString> {
  const [vwap1m, vwap5m, vwap1h, vwap24h, sdexVwap24h, priceChange24h, ammSpotResult, lastTradeResult] = await Promise.all([
    calculateVWAPDetailed(pairKey, 1, network, undefined, excludedSources),
    calculateVWAPDetailed(pairKey, 5, network, undefined, excludedSources),
    calculateVWAPDetailed(pairKey, 60, network, undefined, excludedSources),
    calculateVWAPDetailed(pairKey, 1440, network, undefined, excludedSources),
    calculateVWAPDetailed(pairKey, 1440, network, 'SDEX', excludedSources),
    getPriceChange24hDetailed(pairKey, network),
    // AMM price: latest spot_price averaged across pools for this pair, on this
    // network only. Both halves of the lookup are network-filtered: the outer
    // scan of pool_snapshots, and the price_points subquery that decides which
    // pool ids count as this pair. Filtering only the outer scan would still let
    // a same-named pool on the other chain contribute its price.
    //
    // If 'AMM' is excluded we skip this sub-query by returning a null-row result
    // rather than changing the SQL structure — the ammPrice comes out as 0.
    excludedSources.includes('AMM')
      ? Promise.resolve({ rows: [{ amm_price: null }] })
      : pgPool.query(
          `SELECT AVG(spot_price::numeric) AS amm_price
           FROM (
             SELECT DISTINCT ON (ps.pool_id) ps.spot_price
             FROM pool_snapshots ps
             WHERE ps.network = $2
               AND ps.pool_id IN (
                 SELECT DISTINCT pool_id FROM price_points
                 WHERE pair_key = $1 AND network = $2 AND source = 'AMM' AND pool_id IS NOT NULL
               )
             ORDER BY ps.pool_id, ps.timestamp DESC
           ) latest`,
          [pairKey, network]
        ),
    // Newest observation time + input count, excluding stale sources so the age
    // reflects live data only. We measure against observed_at (the Lens-ingestion
    // wall-clock, NOT NULL post-migration; COALESCE to the legacy source `timestamp`
    // only for pre-migration rows) — this is a liveness clock, "when did we last
    // ingest a sample", not the age of the most recent trade at its source.
    excludedSources.length > 0
      ? pgPool.query(
          `SELECT MAX(COALESCE(observed_at, timestamp)) as last_observed_at, COUNT(*) as input_count FROM price_points
           WHERE pair_key = $1 AND network = $2
             AND source NOT IN (${excludedSources.map((_, i) => `$${i + 3}`).join(', ')})`,
          [pairKey, network, ...excludedSources]
        )
      : pgPool.query(
          `SELECT MAX(COALESCE(observed_at, timestamp)) as last_observed_at, COUNT(*) as input_count FROM price_points
           WHERE pair_key = $1 AND network = $2`,
          [pairKey, network]
        ),
  ])

  const volResult = await pgPool.query(
    `WITH per_source AS (
       SELECT
         source,
         SUM(base_volume::numeric) AS vol
       FROM price_points
       WHERE pair_key = $1
         AND network = $2
         AND COALESCE(observed_at, timestamp) > NOW() - INTERVAL '24 hours'
         ${excludedSources.length > 0
           ? `AND source NOT IN (${excludedSources.map((_, i) => `$${i + 3}`).join(', ')})`
           : ''}
       GROUP BY source
     )
     SELECT source, vol FROM per_source
     UNION ALL
     SELECT 'TOTAL' AS source, COALESCE(SUM(vol)::numeric, 0) AS vol FROM per_source`,
    [pairKey, network, ...excludedSources]
  )

  let sdexVolume24hRaw = '0'
  let ammVolume24hRaw = '0'
  let totalVolume24hRaw: string | null = null
  let sdexVolume24h = 0
  let ammVolume24h = 0
  for (const row of volResult.rows) {
    if (row.source === 'SDEX') {
      sdexVolume24hRaw = String(row.vol ?? '0')
      sdexVolume24h = parseFloat(sdexVolume24hRaw)
    } else if (row.source === 'AMM') {
      ammVolume24hRaw = String(row.vol ?? '0')
      ammVolume24h = parseFloat(ammVolume24hRaw)
    } else if (row.source === 'TOTAL' || row.source === null) {
      totalVolume24hRaw = String(row.vol ?? '0')
    }
  }

  if (totalVolume24hRaw === null) {
    totalVolume24hRaw = addDecimalStrings(sdexVolume24hRaw, ammVolume24hRaw)
  }
  const volume24h = parseFloat(totalVolume24hRaw)

  const sourcesResult = await pgPool.query(
    `SELECT COUNT(DISTINCT COALESCE(pool_id, 'sdex')) AS sources
     FROM price_points
     WHERE pair_key = $1
       AND network = $2
       AND COALESCE(observed_at, timestamp) > NOW() - INTERVAL '1 hour'
       ${excludedSources.length > 0
         ? `AND source NOT IN (${excludedSources.map((_, i) => `$${i + 3}`).join(', ')})`
         : ''}`,
    [pairKey, network, ...excludedSources]
  )

  const ammPriceRaw = String(ammSpotResult.rows[0]?.amm_price ?? '0')
  const ammPrice = parseFloat(ammPriceRaw)
  // Newest observation time (observed_at clock, see query above). lastTradeAgeSeconds
  // keeps its public name but measures time since that newest observation — i.e. how
  // long since we last ingested a live sample, which is what the stale flag enforces.
  const lastObservedAt = lastTradeResult.rows[0]?.last_observed_at
  const lastTradeAgeSeconds = lastObservedAt ? Math.floor((Date.now() - new Date(lastObservedAt).getTime()) / 1000) : null
  const sources = parseInt(sourcesResult.rows[0]?.sources ?? '0', 10)

  const rawInputCount = lastTradeResult.rows[0]?.input_count
  const inputCount = rawInputCount !== undefined
    ? parseInt(rawInputCount, 10)
    : (lastObservedAt ? Math.max(1, sources) : 0)
  const newestInputObservedAt = lastObservedAt ? new Date(lastObservedAt).toISOString() : null

  const staleThreshold = options?.staleThresholdSeconds
    ?? (config as any).pricing?.staleThresholdSeconds
    ?? parseInt(process.env.PRICE_STALE_THRESHOLD_SECONDS ?? process.env.STALENESS_BOUND_SECONDS ?? '300', 10)

  let confidence: 'high' | 'medium' | 'low' | 'unknown' = 'unknown'
  if (lastTradeAgeSeconds === null) {
    confidence = 'unknown'
  } else if (lastTradeAgeSeconds < HIGH_CONFIDENCE_MAX_AGE_SECONDS && sources > 1 && volume24h > 0) {
    confidence = 'high'
  } else if (lastTradeAgeSeconds < MEDIUM_CONFIDENCE_MAX_AGE_SECONDS) {
    confidence = 'medium'
  } else {
    confidence = 'low'
  }

  const stale = lastTradeAgeSeconds !== null && lastTradeAgeSeconds >= staleThreshold

  const isString = options?.decimalFormat === 'string'

  if (isString) {
    const stringPrice = (vwap1h.num > 0 ? vwap1h.raw : null)
      ?? (vwap24h.num > 0 ? vwap24h.raw : null)
      ?? (ammPrice > 0 ? ammPriceRaw : null)
      ?? '0'

    return {
      price: stringPrice,
      sdexPrice: sdexVwap24h.raw,
      ammPrice: ammPriceRaw,
      volume24h: totalVolume24hRaw,
      sdexVolume24h: sdexVolume24hRaw,
      ammVolume24h: ammVolume24hRaw,
      vwap1m: vwap1m.raw,
      vwap5m: vwap5m.raw,
      vwap1h: vwap1h.raw,
      vwap24h: vwap24h.raw,
      priceChange24h: priceChange24h.raw,
      sources,
      confidence,
      lastTradeAgeSeconds,
      newestInputObservedAt,
      inputCount,
      stalenessThresholdSeconds: staleThreshold,
      stale,
      excludedVenues: excludedSources,
    }
  }

  return {
    price: vwap1h.num || vwap24h.num || ammPrice || 0,
    sdexPrice: sdexVwap24h.num,
    ammPrice,
    volume24h,
    sdexVolume24h,
    ammVolume24h,
    vwap1m: vwap1m.num,
    vwap5m: vwap5m.num,
    vwap1h: vwap1h.num,
    vwap24h: vwap24h.num,
    priceChange24h: priceChange24h.num,
    sources,
    confidence,
    lastTradeAgeSeconds,
    newestInputObservedAt,
    inputCount,
    stalenessThresholdSeconds: staleThreshold,
    stale,
    excludedVenues: excludedSources,
  }
}

