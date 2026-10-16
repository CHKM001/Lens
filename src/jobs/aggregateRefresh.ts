import { Queue, Worker } from 'bullmq'
import { config, getNetworkConfig, type NetworkName } from '../config'
import { prisma } from '../db'
import { setCachedPrice } from '../redis'
import { calculateVWAP, calculateOHLCV, getAggregatedPrice } from '../aggregator/vwap'
import { getBestRoute } from '../aggregator/bestRoute'
import { createLogger } from '../logger'
import { getStaleVenues } from '../venueHeartbeat'

const log = createLogger('job:aggregate-refresh')

/**
 * One queue, worker and job stream per network. Everything a job touches —
 * the queue it lives on, the pairs it iterates, every aggregator read, the
 * cache key and the price_aggregates upsert — is stamped with that job's
 * network, so a second enabled network gets its own aggregates instead of
 * having them overwritten by whichever network ran last.
 */
function queueName(network: NetworkName): string {
  return `${network}:aggregate-refresh`
}

function redisConnection() {
  const url = process.env.REDIS_URL
  if (url) return { url }
  return { host: 'localhost', port: 6379 }
}

export function createAggregateQueue(network: NetworkName) {
  return new Queue(queueName(network), { connection: redisConnection() })
}

export function startAggregateWorker(network: NetworkName) {
  const worker = new Worker(
    queueName(network),
    async (job) => {
      const { pairKey, pair } = job.data
      try {
        // A venue whose last written price is older than its staleness bound
        // is dropped from every aggregate computed here, exactly as the live
        // /price route does. Without this the refresh worker would keep blending
        // a dead adapter's last price into the cached payload and into the
        // price_aggregates rows that history and the screener read.
        const excludedVenues = getStaleVenues(network)

        const agg = await getAggregatedPrice(pairKey, network, undefined, excludedVenues)
        const route = await getBestRoute(pair.assetA, pair.assetB, pairKey, 1000, network)

        const result = {
          assetA: pair.assetA.code,
          assetB: pair.assetB.code,
          pairKey,
          // The cache key this is stored under is what /price/:a/:b reads, so
          // the payload has to carry the same network the route stamps — a
          // cache hit is served verbatim, network field included.
          network,
          ...agg,
          bestRoute: route.route,
          lastUpdated: new Date(),
        }

        // Cache in Redis — network-scoped so the two chains' payloads for the
        // same pairKey never overwrite each other, and so it matches the key
        // /price/:a/:b reads.
        await setCachedPrice(`${network}:${pairKey}`, result, config.cache.priceTtl)

        // Upsert aggregate buckets for each window
        const windows: Array<{ key: string; minutes: number }> = [
          { key: '1m', minutes: 1 },
          { key: '5m', minutes: 5 },
          { key: '1h', minutes: 60 },
          { key: '24h', minutes: 1440 },
        ]

        const bucket = new Date()
        bucket.setSeconds(0, 0)

        for (const w of windows) {
          const [vwap, sdexVwap, ammVwap, ohlcv] = await Promise.all([
            calculateVWAP(pairKey, w.minutes, network, undefined, excludedVenues),
            calculateVWAP(pairKey, w.minutes, network, 'SDEX', excludedVenues),
            calculateVWAP(pairKey, w.minutes, network, 'AMM', excludedVenues),
            calculateOHLCV(pairKey, w.minutes, network),
          ])

          if (vwap === 0) continue

          await prisma.priceAggregate.upsert({
            where: { network_pairKey_window_bucket: { network, pairKey, window: w.key, bucket } },
            create: {
              network, pairKey, window: w.key, bucket,
              vwap, sdexVwap: sdexVwap || null, ammVwap: ammVwap || null,
              volume: ohlcv.volume, tradeCount: ohlcv.tradeCount,
              openPrice: ohlcv.open || null, closePrice: ohlcv.close || null,
              highPrice: ohlcv.high || null, lowPrice: ohlcv.low || null,
            },
            update: {
              vwap, sdexVwap: sdexVwap || null, ammVwap: ammVwap || null,
              volume: ohlcv.volume, tradeCount: ohlcv.tradeCount,
              closePrice: ohlcv.close || null, highPrice: ohlcv.high || null, lowPrice: ohlcv.low || null,
            },
          })
        }

        log.info({ network, pair: pairKey, price: agg.price, route: route.route }, 'refreshed aggregate')
      } catch (err) {
        log.error({ network, pair: pairKey, err }, 'aggregate refresh failed')
      }
    },
    { connection: redisConnection(), concurrency: 5 }
  )

  worker.on('failed', (job, err) => {
    log.error({ err }, 'aggregate refresh job failed')
  })

  return worker
}

export async function scheduleAggregateRefresh(queue: Queue, network: NetworkName) {
  // Repeat every 60 seconds for each pair this network watches
  for (const pair of getNetworkConfig(network).pairs) {
    await queue.add(
      'refresh',
      { pairKey: pair.pairKey, pair, network },
      { repeat: { every: 60_000 }, jobId: `refresh:${network}:${pair.pairKey}` }
    )
    // Also run immediately on startup
    await queue.add('refresh', { pairKey: pair.pairKey, pair, network })
  }
}
