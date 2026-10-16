# Ingest metrics

The ingestion side of `/metrics`, defined in [`src/metrics.ts`](../src/metrics.ts).
The HTTP layer has its own doc — [`http-metrics.md`](http-metrics.md) — because
its label design is a separate problem. Everything here shares one concern:
**Lens runs one ingester set per enabled network against a single Prometheus
registry, so an ingest metric that cannot tell the networks apart is reporting
nonsense on any deployment with more than one.**

## What is exported

| Metric | Type | Labels |
| --- | --- | --- |
| `trades_ingested_total` | Counter | `pair`, `network` |
| `amm_snapshots_total` | Counter | `pool`, `network` |
| `price_snapshots_total` | Counter | `network` |
| `ingester_abandoned_cycles_total` | Counter | `venue`, `network` |
| `last_trade_timestamp` | Gauge | `pair`, `network` |
| `venue_last_success_timestamp` | Gauge | `venue`, `network` |
| `venue_last_write_timestamp` | Gauge | `venue`, `network` |
| `venue_consecutive_failures` | Gauge | `venue`, `network` |

| Label | Values | Notes |
| --- | --- | --- |
| `network` | `testnet`, `mainnet` | The `NetworkName` of the ingester loop that produced the sample, not the process-wide `STELLAR_NETWORK`. |
| `pair` | `XLM/USDC`, … | The `pairKey` already used everywhere else in Lens. |
| `pool` | Horizon liquidity-pool id | Pre-existing label, only on `amm_snapshots_total`. |
| `venue` | `SDEX`, `AMM`, `Soroswap`, `Aquarius`, `Snapshot` | On `ingester_abandoned_cycles_total`: the ingester loop that abandoned a cycle past its deadline (#351). Bounded by the adapter registry, not by runtime data. |
| `venue` | `SDEX`, `AMM`, `aquarius_amm`, `soroswap_amm` | On the `venue_*` heartbeat gauges: the `source` a venue adapter writes to `price_points`. Matches the value used to exclude a stale venue from aggregation. |

All of these are also emitted with the registry-wide `app="lens"` default label.

## Per-venue heartbeat gauges (Issue #219)

The three `venue_*` gauges back the per-venue heartbeat registry in
[`src/venueHeartbeat.ts`](../src/venueHeartbeat.ts). A dead adapter and a quiet
venue both stop producing rows; the heartbeat tells them apart:

- `venue_last_success_timestamp` — the last successful upstream **read**. Moves on
  every poll that reaches the venue, even when it returns nothing new.
- `venue_last_write_timestamp` — the last successful **write** to `price_points`.
  This is the price's age; a venue whose `last_write` is older than its staleness
  bound is excluded from every aggregate (VWAP, `/price`, the refresh worker, and
  the rows it feeds `price_aggregates`).
- `venue_consecutive_failures` — failed reads in a row, reset to 0 on a successful
  read. Non-zero while `last_success` ages is the signal that the adapter is
  down, not merely quiet.

The same state is exposed on `/status` as `venueHeartbeats`, and the exclusion is
visible in the `/price` response as `excludedVenues`.


## Why `network` is on every ingest metric

Before this change, the ingest metrics were network-blind. On a dual-network
deployment the two loops wrote to the same series.

For the counters that is a silent merge — `trades_ingested_total` summed
testnet and mainnet trades together, so a per-network ingest rate was not
queryable at all.

`last_trade_timestamp` was worse. It is a `Gauge.set()`, not an increment, so
whichever loop ticked last won. The testnet loop at
[`src/ingesters/sdex.ts`](../src/ingesters/sdex.ts) overwrote mainnet's value
for the same pair every poll interval, and the series reported a timestamp
belonging to exactly one network while looking network-agnostic. That is the
only staleness signal Lens exports, and on a dual-network deployment it was
unusable for the job — silently, because the value still looked like a plausible
timestamp.

Each call site now passes the `network` argument it already receives
(`ingestPair(pair, network)`, `snapshotPool(pool, pair, network)`,
`ingestPoolTrades(pool, pair, network)`, `appendSnapshots(now, network)`).
The invariant is the loop's own network, never `activeNetwork` — `activeNetwork`
is a per-process constant and is exactly the value that made this bug invisible.

[`tests/ingestMetrics.test.ts`](../tests/ingestMetrics.test.ts) asserts that two
networks produce two distinct series for the same pair rather than one
overwritten one, and drives the real ingesters so a call site that forgets the
label fails the test.

## Cardinality

Series count is `pairs x networks`:

- `trades_ingested_total` and `last_trade_timestamp` — `pairs x networks`. Both
  factors are bounded by configuration: `WATCHED_PAIRS` and `ENABLED_NETWORKS`
  are single-digit, so this is tens of series, not thousands.
- `amm_snapshots_total` — `pools x networks`. Pools are discovered from Horizon
  for the configured pairs only, so this stays bounded by the same watch list.
- `price_snapshots_total` — `networks`. One series per network, full stop.
- `ingester_abandoned_cycles_total` — `venues x networks`. `venue` is the five
  ingester loops hard-coded in the adapter registry (plus the snapshot
  appender), so this is a single-digit factor like `network`, not an ID
  space: never label it with a pool id, a pair or a contract id.
- `venue_last_success_timestamp`, `venue_last_write_timestamp` and
  `venue_consecutive_failures` — `venues x networks`. Both factors are bounded by
  configuration (the adapters in `src/ingest/venues/` and `src/ingesters/`), so
  this is a handful of series, not a pair- or pool-scaled one.

**Do not add `issuer` to any of these.** It would multiply the series count by
every distinct token in the config for no gain: `pair` is the `pairKey` and
already identifies the instrument, and any question that genuinely needs the
issuer is a database question, not a Prometheus one. An issuer label is also the
label most likely to be added casually — every token *looks* like a useful
dimension until you count them.

**Do not add `pool` to `trades_ingested_total` or `last_trade_timestamp`.**
Pool ids are only known to the AMM loop, and adding them there would mean the
SDEX loop needs a synthetic value; worse, it would turn a per-pair signal into
a per-pool one. If pool-level trade volume is genuinely needed, derive it from
`price_points` in the database, or add a separate metric with a deliberate label
set rather than widening an existing one. It is easy to add a label and painful
to remove one dashboards have come to depend on.

## Queries

```promql
# Ingest rate per network
sum(rate(trades_ingested_total[5m])) by (network)

# Ingest rate for one pair, split by network
sum(rate(trades_ingested_total{pair="XLM/USDC"}[5m])) by (network)

# How stale is the feed, per network? (seconds since the last trade)
time() - last_trade_timestamp

# Staleness for one pair on one network
time() - last_trade_timestamp{pair="XLM/USDC", network="mainnet"}

# Pairs that have gone quiet in the last 15 minutes
time() - last_trade_timestamp > 900

# Which ingester loop is overrunning its cycle deadline, on which network
sum(rate(ingester_abandoned_cycles_total[15m])) by (venue, network)
```

## Suggested alerts

`time() - last_trade_timestamp` needs a threshold per pair, not one global one:
a thin pair legitimately goes hours without a trade. The expression below is a
starting point — tune it against the observed trade frequency of the pairs you
actually watch before paging anyone.

```yaml
groups:
  - name: lens-ingest
    rules:
      - alert: LensIngestStale
        expr: |
          (time() - last_trade_timestamp) > 3600
            and on (pair, network)
          (sum(increase(trades_ingested_total[6h])) by (pair, network) > 0)
        for: 15m
        labels: { severity: warning }
        annotations:
          summary: "{{ $labels.pair }} on {{ $labels.network }} has seen no trade for over an hour"
```

The `increase(...) > 0` arm is what makes this alertable rather than noisy: it
fires only for pairs that were actually trading recently enough to be expected
to trade again, so a pair that never trades does not page anyone. Adding
`network` to the label set is what makes the `and on (pair, network)` join
correct — without it the two networks' series are indistinguishable and the
threshold can be satisfied or violated by whichever network happens to be
active.
