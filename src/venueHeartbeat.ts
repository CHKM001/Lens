/**
 * Per-venue heartbeat registry.
 *
 * Tracks the last successful read, the last row written, and the number of
 * consecutive failures for every (venue, network) pair.  The aggregation layer
 * reads this to exclude venues whose most-recent write (price age) is older than
 * their configured staleness threshold, making a dead — or merely quiet —
 * adapter visibly absent from the aggregate rather than silently inflating it
 * with stale prices.
 *
 * Issue: #219
 */

import type { NetworkName } from './config'
import {
  venue_last_success_timestamp,
  venue_last_write_timestamp,
  venue_consecutive_failures,
} from './metrics'

/** Default staleness threshold: 5 minutes. Adapters may override per venue. */
export const DEFAULT_STALENESS_MS = 5 * 60 * 1000

export interface VenueHeartbeat {
  /** ISO timestamp of the last successful upstream read (data fetched without error). */
  lastSuccess: string | null
  /** ISO timestamp of the last successful write to price_points. */
  lastWrite: string | null
  /** How many poll cycles in a row ended in a failure (reset to 0 on success). */
  consecutiveFailures: number
  /** Staleness threshold in ms; a venue whose lastWrite is older than this is excluded. */
  stalenessThresholdMs: number
}

/**
 * In-process registry, keyed by `${venue}:${network}`.
 *
 * Heartbeats are intentionally not persisted — a fresh deploy starts with all
 * venues live, and the first poll cycle immediately updates every heartbeat.
 * Persisting state would complicate tests and add a dependency with no benefit
 * since each heartbeat covers at most one poll interval of uncertainty.
 */
const registry = new Map<string, VenueHeartbeat>()

function key(venue: string, network: NetworkName): string {
  return `${venue}:${network}`
}

/**
 * Return a copy of the current heartbeat for a venue, or a zero-state if it
 * has never been registered.
 */
export function getHeartbeat(venue: string, network: NetworkName): VenueHeartbeat {
  return registry.get(key(venue, network)) ?? {
    lastSuccess: null,
    lastWrite: null,
    consecutiveFailures: 0,
    stalenessThresholdMs: DEFAULT_STALENESS_MS,
  }
}

/**
 * Return all known heartbeats as an array of `{ venue, network, ...heartbeat }`
 * objects, suitable for inclusion in `/status` responses.
 */
export function getAllHeartbeats(): Array<{ venue: string; network: NetworkName } & VenueHeartbeat> {
  return [...registry.entries()].map(([k, hb]) => {
    const [venue, network] = k.split(':') as [string, NetworkName]
    return { venue, network, ...hb }
  })
}

/**
 * Record a successful upstream READ that produced no new rows.
 *
 * This is what separates a quiet venue from a dead one. A poll that reaches the
 * upstream, gets a well-formed (possibly empty) answer, and has nothing new to
 * write is a SUCCESS: the adapter is alive. Only `lastSuccess` moves;
 * `lastWrite` is left where it was so the price's age keeps advancing and its
 * stale rows are excluded from the aggregate. `consecutiveFailures` resets to 0.
 *
 * @param venue   Ingester source name, e.g. `'aquarius_amm'` or `'SDEX'`.
 * @param network The Stellar network this ingester is reading from.
 * @param stalenessThresholdMs  Optional override for the staleness window.
 */
export function recordVenueReadSuccess(
  venue: string,
  network: NetworkName,
  stalenessThresholdMs: number = DEFAULT_STALENESS_MS,
): void {
  const now = new Date().toISOString()
  const existing = registry.get(key(venue, network))
  const updated: VenueHeartbeat = {
    lastSuccess: now,
    lastWrite: existing?.lastWrite ?? null,
    consecutiveFailures: 0,
    stalenessThresholdMs: existing?.stalenessThresholdMs ?? stalenessThresholdMs,
  }
  registry.set(key(venue, network), updated)

  venue_last_success_timestamp.set({ venue, network }, Date.now() / 1000)
  venue_consecutive_failures.set({ venue, network }, 0)
}

/**
 * Record a successful WRITE of new price_points rows.
 *
 * Moves `lastWrite` to now. The read that produced these rows is recorded
 * separately (see {@link recordVenueReadSuccess}); a write implies a recent
 * successful read, so callers that do both should use {@link recordVenueSuccess}.
 */
export function recordVenueWrite(venue: string, network: NetworkName): void {
  const now = new Date().toISOString()
  const existing = registry.get(key(venue, network)) ?? {
    lastSuccess: null,
    lastWrite: null,
    consecutiveFailures: 0,
    stalenessThresholdMs: DEFAULT_STALENESS_MS,
  }
  registry.set(key(venue, network), { ...existing, lastWrite: now })

  venue_last_write_timestamp.set({ venue, network }, Date.now() / 1000)
}

/**
 * Record a successful upstream read AND write for a venue.
 *
 * Call this after new price_points rows have been committed.  Both
 * `lastSuccess` and `lastWrite` are set to now, and `consecutiveFailures` is
 * reset to 0.
 *
 * @param venue   Ingester source name, e.g. `'aquarius_amm'` or `'SDEX'`.
 * @param network The Stellar network this ingester is reading from.
 * @param stalenessThresholdMs  Optional override for the staleness window.
 */
export function recordVenueSuccess(
  venue: string,
  network: NetworkName,
  stalenessThresholdMs: number = DEFAULT_STALENESS_MS,
): void {
  recordVenueReadSuccess(venue, network, stalenessThresholdMs)
  recordVenueWrite(venue, network)
}

/**
 * Record a failed upstream read for a venue.
 *
 * Increments `consecutiveFailures`. `lastSuccess` and `lastWrite` are left
 * untouched — the existing (possibly stale) values remain visible so callers
 * can see exactly how long ago the last good data arrived.
 *
 * @param venue   Ingester source name.
 * @param network The Stellar network this ingester is reading from.
 */
export function recordVenueFailure(venue: string, network: NetworkName): void {
  const existing = registry.get(key(venue, network)) ?? {
    lastSuccess: null,
    lastWrite: null,
    consecutiveFailures: 0,
    stalenessThresholdMs: DEFAULT_STALENESS_MS,
  }
  const updated: VenueHeartbeat = {
    ...existing,
    consecutiveFailures: existing.consecutiveFailures + 1,
  }
  registry.set(key(venue, network), updated)

  venue_consecutive_failures.set({ venue, network }, updated.consecutiveFailures)
}

/**
 * Return the set of venue names that are currently stale on the given network.
 *
 * A venue is stale when its most recent price — i.e. its last successful WRITE —
 * is older than its `stalenessThresholdMs`. Staleness is measured on write age,
 * not read age, because the thing being excluded is an old price: a venue that
 * is still reading successfully but has not produced a new row is exactly the
 * "quiet" case whose stale price must not keep influencing the aggregate.
 *
 * A venue that has never written falls back to its last successful read, so a
 * freshly registered venue that is reading fine but has not written yet is not
 * flagged; only one that has neither written nor read within the window is
 * stale. A venue that has only ever failed (no read, no write) is stale.
 *
 * Venues with no heartbeat at all (never polled) are NOT considered stale —
 * they may simply not apply to this network or may be in their first poll cycle.
 */
export function getStaleVenues(network: NetworkName): string[] {
  const now = Date.now()
  const stale: string[] = []

  for (const [k, hb] of registry.entries()) {
    const [venue, hbNetwork] = k.split(':') as [string, NetworkName]
    if (hbNetwork !== network) continue

    if (isStaleHeartbeat(hb, now)) stale.push(venue)
  }

  return stale
}

/**
 * True if this venue is currently stale on the given network.
 *
 * A venue with no heartbeat entry is NOT considered stale.
 */
export function isVenueStale(venue: string, network: NetworkName): boolean {
  const hb = registry.get(key(venue, network))
  if (!hb) return false
  return isStaleHeartbeat(hb, Date.now())
}

function isStaleHeartbeat(hb: VenueHeartbeat, now: number): boolean {
  // Price age first; fall back to the last successful read for a venue that has
  // not written anything yet.
  const reference = hb.lastWrite ?? hb.lastSuccess
  if (reference === null) return true
  return now - new Date(reference).getTime() > hb.stalenessThresholdMs
}

/**
 * Clear all heartbeat state.  Used in tests to reset between cases.
 */
export function _resetHeartbeats(): void {
  registry.clear()
}
