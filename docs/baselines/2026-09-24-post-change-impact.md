# Post-change impact — bloom-gated scanner reads

Measured **2026-09-24**, ~31 hours after the last functional deploy. Compares
matched 24-hour windows before and after the change, plus a direct
mechanism measurement of the bloom gate.

Companion to [the pre-change baseline](2026-09-22-production.md).

## What changed

Two commits, deployed 2026-09-22:

| Commit    | Deployed (UTC) | Change                                                    |
| --------- | -------------- | --------------------------------------------------------- |
| `50241ca` | 09:10:33       | Bloom-gated, exact-hash log reads + strict RPC validation |
| `0937940` | 09:40:39       | Activation boundaries + atomic webhook deactivation       |

Only documentation was deployed after that (09:46). **No other functional deploy
occurred**, so the before/after comparison is attributable to these changes.

## Measurement windows

| Window | UTC range                           | Code            |
| ------ | ----------------------------------- | --------------- |
| pre    | 2026-09-21 09:45 → 2026-09-22 09:45 | ~98% pre-change |
| mid    | 2026-09-22 09:45 → 2026-09-23 09:45 | post-change     |
| post   | 2026-09-23 09:45 → 2026-09-24 09:45 | post-change     |

All three windows returned data through 09:44:5x, so none is truncated.

## Verdict

- **The gate works as designed.** 92.6% of per-block `eth_getLogs` calls are
  avoided across the six scanned chains, and counterfactual block+log compute
  falls 69.4%. This is measured directly, not inferred.
- **The change increases HTTP request volume.** Internal gateway requests rose
  14.9% and batches 24.8%, because a bloom-positive block now needs a second
  request (blocks, then logs) instead of the previous single combined batch.
  This is worst exactly where the gate saves least: Ethereum (77.5% positive)
  and Base (56.3% positive).
- **Net gateway errors fell, but only because Arbitrum improved.** Arbitrum
  errors fell 62%; the other five chains saw errors roughly double as a rate,
  with more requests and no Alchemy safety net.
- **The billing saving is not yet observable.** Alchemy reached its spending cap
  around 2026-09-22 03:00 UTC and has served no fallbacks since, so post-change
  Alchemy usage is zero regardless of this change. The 69.4% figure is a
  mechanism estimate, not a measured invoice.

## 1. Mechanism measurement (primary result)

Method: for each chain, fetch 400 recent block headers (`eth_getBlockByNumber`,
10 per batch) from a public endpoint, evaluate the production tracked set against
each block's `logsBloom` using the shipped `src/domain/bloom.ts`, then verify a
bounded probe set with exact-hash `eth_getLogs`.

- **Positive probes** (up to 50 per chain): confirm positives are genuinely
  possible matches.
- **Negative control** (~40 per chain, evenly sampled): any match here would be a
  bloom _false negative_ — a correctness bug.

### Per-chain bloom positivity

| Chain            | Tracked addrs | Bloom-positive blocks | Log queries avoided | Blocks/day |
| ---------------- | ------------: | --------------------: | ------------------: | ---------: |
| Ethereum (1)     |             4 |                 77.5% |               22.5% |      7,200 |
| Optimism (10)    |             2 |                  1.3% |               98.8% |     43,200 |
| Gnosis (100)     |             1 |                  0.0% |                100% |     17,280 |
| Polygon (137)    |             1 |                 10.5% |               89.5% |     57,600 |
| Base (8453)      |             6 |                 56.3% |               43.8% |     43,200 |
| Arbitrum (42161) |             5 |                  0.5% |               99.5% |    345,600 |

### Counterfactual compute, weighted by real block volume

Assumes Alchemy item pricing of **20 CU** per `eth_getBlockByNumber` and **60 CU**
per `eth_getLogs`, and that the previous implementation fetched one log per
scanned block.

| Chain     |     Old CU/day |     New CU/day | Reduction |
| --------- | -------------: | -------------: | --------: |
| Ethereum  |        576,000 |        478,800 |     16.9% |
| Optimism  |      3,456,000 |        897,696 |     74.0% |
| Gnosis    |      1,382,400 |        345,600 |     75.0% |
| Polygon   |      4,608,000 |      1,514,880 |     67.1% |
| Base      |      3,456,000 |      2,323,296 |     32.8% |
| Arbitrum  |     27,648,000 |      7,015,680 |     74.6% |
| **Total** | **41,126,400** | **12,575,952** | **69.4%** |

Log queries per day: **514,080 → 38,240 (92.6% avoided)**.

### Validation

- **Zero bloom false negatives.** None of the 240 negative-control probes
  contained a matching Transfer log.
- **No positive probe contained a real match** in its window, so every sampled
  positive was a false positive. This is expected for a sparse tracked set over a
  short window, and it means these percentages are block-density statistics, not
  activity statistics.
- The savings therefore scale with the tracked-set size, not with activity. More
  subscriptions raise positivity and shrink the saving; Ethereum and Base are
  already near the point where the gate mostly adds a round trip.

## 2. Gateway traffic (internal route)

Source: `rpc_racer_metrics`. Successes are 10%-sampled and weighted; errors and
successful Alchemy fallbacks are recorded at 100%. Values are estimates. One
request may contain many JSON-RPC items.

| Metric                       |     pre |     mid |    post | Δ (pre→post) |
| ---------------------------- | ------: | ------: | ------: | -----------: |
| Requests                     | 341,789 | 396,694 | 392,605 |   **+14.9%** |
| Batch requests               | 174,065 | 219,771 | 217,182 |   **+24.8%** |
| Head polls                   | 167,714 | 176,913 | 175,423 |        +4.6% |
| HTTP errors                  |   1,355 |     824 |   1,175 |       −13.3% |
| Successful Alchemy fallbacks |   3,724 |       0 |       0 |  −100% (cap) |
| Mean latency                 |  105 ms |   79 ms |   93 ms |         −11% |

### Per chain

| Chain    | Requests        | Batches         | HTTP errors | Mean latency |
| -------- | --------------- | --------------- | ----------- | ------------ |
| Ethereum | 13,507 → 19,260 | 6,519 → 12,259  | 46 → 180    | 227 → 173 ms |
| Optimism | 73,259 → 78,066 | 36,236 → 40,171 | 118 → 196   | 86 → 81 ms   |
| Gnosis   | 31,639 → 31,949 | 15,082 → 14,896 | 4 → 9       | 53 → 60 ms   |
| Polygon  | 73,535 → 80,572 | 36,577 → 41,898 | 98 → 212    | 82 → 57 ms   |
| Base     | 70,946 → 94,468 | 35,196 → 57,629 | 70 → 188    | 87 → 104 ms  |
| Arbitrum | 78,903 → 88,290 | 44,455 → 50,329 | 1,019 → 390 | 160 → 119 ms |

The extra requests track bloom positives almost exactly: Ethereum and Base, where
most blocks test positive, gain the most batches, while Gnosis (0% positive)
gains none. Arbitrum's error count fell sharply because ranges are now 10 items
instead of 20, which fewer upstreams reject.

The pre window still had Alchemy as a fallback until ~03:00 UTC, so its error
comparison is flattered. Post-change traffic has no fallback safety net at all.

## 3. Cloudflare resource usage

Source: Cloudflare GraphQL analytics. Aggregated platform metrics, not an invoice.

| Metric                     |       pre |      post |          Δ |
| -------------------------- | --------: | --------: | ---------: |
| D1 read queries            |   331,557 |   355,499 |      +7.2% |
| D1 rows read               |   960,011 | 1,030,809 |      +7.4% |
| D1 write queries           |    52,025 |    52,761 |      +1.4% |
| Scanner DO requests        |   508,053 |   577,698 |     +13.7% |
| Scanner DO CPU seconds     |  1,088.77 |  1,768.14 | **+62.4%** |
| Scanner DO duration (GB-s) | 10,954.27 |  8,194.77 |     −25.2% |
| Scanner DO subrequests     |   339,686 |   396,944 |     +16.9% |
| rpc-racer CPU seconds      |  1,391.48 |  1,872.15 |     +34.6% |
| rpc-racer subrequests      |   960,452 | 1,043,650 |      +8.7% |

Interpretation:

- **DO CPU rose 62%** while duration fell 25%. The added cost is consistent with
  strictly validating every block, log and receipt with Zod (added in `50241ca`)
  and with the second fetch stage — more CPU per scanned block, less waiting.
- **DO duration fell**, which is the metric Durable Object billing is based on, so
  this is not a clear cost regression.
- **rpc-racer CPU rose 35%**, but public-route requests also grew 7.8% in the same
  period, so the change explains only part of it.
- Public-route traffic is **not** the scanner and is excluded from all attributions
  above.

## 4. Deliveries

Post-window customer cohort (the two temporary validation accounts were excluded
and separately cleaned up):

- **10 `activity.observed` deliveries, all on Base, all successful on the first
  attempt.** Nine observations produced them.
- No new pending, failed or dead-lettered customer deliveries.
- Latency p50 **10.97 s**, p95/p99 **13.13 s** — below the 10 s alert threshold at
  p50 but still above it at p95. Only 10 samples, so p95 is the maximum.
- The two outstanding customer dead letters still date to **2026-09-04** (HTTP
  401), unrelated to this change.

Observation volume is low because only Base had tracked addresses transacting;
the other five chains produced none.

## 5. Risks and observations

1. **Gnosis (chain 100) is flapping to `degraded`.** It reports
   `no common ancestor within retained window (deep reorg)`, with `updated_at`
   refreshing within minutes, yet its cursor tracks the head and advances. Its one
   tracked address produced no activity, so there is no delivery impact, but
   detection could be delayed and the alert is noisy. Root cause is unresolved.
2. **Extra HTTP requests on bloom-dense chains** (Ethereum, Base) are a real
   efficiency regression for the same CU saving at the margin.
3. **Scanner exceptions persist** in the post day: 13 `scriptThrewException`
   and 4 `internalError`, versus 70 `scriptThrewException` in the pre day and 3 in
   the mid day. Causes are not identifiable from analytics alone.
4. The pre-window comparison is confounded by Alchemy's cap being reached partway
   through it.

## 6. Recommended next steps

1. **Coalesce log reads across a scan pass.** Today each range that has a
   positive block issues its own log batch. Accumulating positive blocks across
   the whole pass (up to the existing 100-block bound) and issuing one gated log
   batch would keep the 69.4% CU saving while removing most of the +24.8% batch
   regression, especially on Ethereum and Base.
2. **Make the gate adaptive per chain.** Where positivity is high (Ethereum, Base),
   an inline block+logs request costs the same CU as gating but half the requests.
   Decide from observed positivity rather than a hardcoded provider rule.
3. **Instrument the scanner.** Record blocks scanned, bloom-negative blocks, log
   queries issued, receipts, validation failures and fallbacks per chain. Today
   only whole-batch counts exist, which is why this report needed an external
   replay.
4. **Resolve the Gnosis `degraded` flap** and clear stale status on successful
   scans so the alert reflects reality.
5. **Re-measure against Alchemy once its cap is lifted**, since that is the only
   direct confirmation of the CU saving.

## Reproduction

Bloom positivity (read-only; fetches headers and bounded exact-hash probes):

```bash
bun scripts/bloom-impact.mts --sample 400 --positives 50 --negatives 40
```

Repeated on a 60-block sample the script reports a ~70% compute reduction and
93.8% log-query avoidance, consistent with the 400-block figures above.

Gateway aggregation over a fixed UTC window:

```sql
SELECT blob1 AS caller, blob2 AS chain, blob3 AS method,
       blob4 AS outcome, blob5 AS provider,
       sum(double3 * _sample_interval) AS requests,
       sum(double2 * double3 * _sample_interval) AS latency_total_ms
FROM rpc_racer_metrics
WHERE timestamp >= toDateTime('<UTC start>')
  AND timestamp < toDateTime('<UTC end>')
GROUP BY caller, chain, method, outcome, provider
```
