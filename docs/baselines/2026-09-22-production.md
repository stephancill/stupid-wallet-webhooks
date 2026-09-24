# Production baseline — 2026-09-22

Collected at approximately **09:52 UTC**, using a frozen reporting cutoff of
**09:45 UTC** to allow analytics ingestion to settle.

## Measurement windows

| Window                    | UTC start        | UTC end          |
| ------------------------- | ---------------- | ---------------- |
| Trailing 24 hours         | 2026-09-21 09:45 | 2026-09-22 09:45 |
| Before bloom optimization | 2026-09-22 08:40 | 2026-09-22 09:10 |
| After bloom optimization  | 2026-09-22 09:15 | 2026-09-22 09:45 |

The bloom optimization deployed at **09:10:33 UTC** (`50241ca`). Activation and
deletion fixes deployed at **09:40:39 UTC** (`0937940`). Consequently, the 24-hour
window is mostly the previous implementation; the after window is an initial
30-minute sample and includes deployment/lifecycle-test traffic. It is not a
24-hour steady-state measurement of the new release. A full day after both code
rollouts can first be measured at **2026-09-23 09:45 UTC**.

## RPC gateway baseline

Source: `rpc_racer_metrics` in Cloudflare Analytics Engine. Internal-route traffic
is the available proxy for scanner traffic; the caller label does not identify
individual consuming services.

Ordinary successes are sampled at 10%; gateway errors and successful Alchemy
fallbacks are recorded at 100%. Counts below apply both the application's sample
weight and Analytics Engine's `_sample_interval`, and are therefore estimates.
One request is a gateway HTTP request, potentially containing many JSON-RPC items.
Here, a successful fallback means the gateway accepted Alchemy's HTTP 2xx JSON-RPC
response; it does not prove that every batch item passed scanner validation.

### Trailing 24 hours: internal route

| Chain            | Tracked addresses now | Gateway requests | Batch requests | HTTP errors | Successful Alchemy fallbacks | Mean latency |
| ---------------- | --------------------: | ---------------: | -------------: | ----------: | ---------------------------: | -----------: |
| Ethereum (1)     |                     4 |           13,507 |          6,519 |          46 |                          361 |       227 ms |
| Optimism (10)    |                     2 |           73,259 |         36,236 |         118 |                          211 |        86 ms |
| Gnosis (100)     |                     1 |           31,639 |         15,082 |           4 |                           35 |        53 ms |
| Polygon (137)    |                     1 |           73,535 |         36,577 |          98 |                          387 |        82 ms |
| Base (8453)      |                     6 |           70,946 |         35,196 |          70 |                          216 |        87 ms |
| Arbitrum (42161) |                     5 |           78,903 |         44,455 |       1,019 |                        2,514 |       160 ms |
| **Total**        |                **19** |      **341,789** |    **174,065** |   **1,355** |                    **3,724** |            — |

Current tracked-address counts are a snapshot, not historical averages. There are
23 live subscription references across the six chains.

The shared gateway also reported 214,320 public-route requests, 35,800 HTTP errors
and 11,270 successful Alchemy fallbacks during the day. These are not included in
the internal-route table and must not be attributed to the notification scanner.

### Initial before/after comparison

Both columns cover 30 minutes.

| Metric                                | Before | After |
| ------------------------------------- | -----: | ----: |
| All internal gateway requests         |  7,891 | 7,641 |
| All internal HTTP errors              |    111 |    21 |
| Arbitrum gateway requests             |  1,844 | 1,533 |
| Arbitrum batch requests               |  1,063 |   873 |
| Arbitrum HTTP errors                  |     84 |     3 |
| Arbitrum HTTP error rate              |  4.56% | 0.20% |
| Arbitrum mean gateway latency         | 162 ms | 90 ms |
| Successful internal Alchemy fallbacks |      0 |     0 |

Arbitrum's before errors comprised 68 rate limits, 11 upstream errors, four other
client errors and one forbidden response. Afterward there were two rate limits
and one upstream error. This is an encouraging initial signal, not a controlled
causal estimate: provider health, sampling, deployments and test traffic vary.

The last recorded successful internal Alchemy fallback in the day was at
**02:54:22 UTC**, well before deployment. The account's spending cap had already
been reached. Zero fallbacks in both comparison windows therefore do **not**
establish savings or restored Alchemy availability. Failed fallback attempts are
not separately identifiable in the existing telemetry.

HTTP success also does not imply valid scanner data: null blocks or other invalid
JSON-RPC results can arrive inside HTTP 200 responses and are rejected separately
by the scanner.

## Cloudflare resource baseline

Source: Cloudflare GraphQL analytics, filtered to the notifications D1 database
and scanner Durable Object namespace. These are platform-reported analytics
aggregates, not an invoice or a dollar-cost estimate.

| Metric                          | Trailing 24 hours | Before, 30 min | After, 30 min |
| ------------------------------- | ----------------: | -------------: | ------------: |
| D1 read queries                 |           331,557 |          7,164 |         7,454 |
| D1 write queries                |            52,025 |          1,109 |         1,156 |
| D1 rows read                    |           960,011 |         21,273 |        24,909 |
| D1 rows written                 |            52,173 |          1,109 |         1,268 |
| Scanner DO invocations          |           508,053 |         11,066 |        11,950 |
| Scanner DO CPU seconds          |          1,088.77 |          24.81 |         46.88 |
| Scanner DO duration, GB-seconds |         10,954.27 |         191.74 |        184.29 |
| Scanner DO storage rows read    |           171,901 |          3,721 |         3,835 |
| Scanner DO storage rows written |           212,166 |          4,557 |         4,529 |
| Scanner DO subrequests          |           339,686 |          7,439 |         8,243 |

Scanner CPU time increased in the initial comparison while duration decreased
slightly. Do not treat reduced log queries as proof that every Cloudflare resource
metric improved; compare a full stable day before estimating overall savings.

### Invocation outcomes worth monitoring

- Day: 504,914 successful scanner invocations, 3,069 `clientDisconnected`, and
  70 `scriptThrewException`.
- Before window: 150 `clientDisconnected`, zero `scriptThrewException`.
- After window: 57 `clientDisconnected`, 14 `scriptThrewException`.
- The 14 after-window exception statuses occurred at 09:15 (2), 09:22 (2),
  09:23 (8), 09:40 (1), and 09:41 (1) UTC. Some coincide with deployment activity,
  but analytics alone does not establish their cause. Short clean live tails do
  not rule out these historical exceptions.
- No exceeded-CPU, exceeded-memory or fatal-internal errors were reported in the
  scanner periodic-usage series during the day.

## Activity and delivery baseline

Source: D1 ledger. The two temporary accounts created for this deployment's live
validation are excluded from the customer cohort below. Other accounts are
included; this is not an assertion that all remaining accounts are paying users.

### Customer cohort, trailing 24 hours

- **Seven `activity.observed` deliveries**, all on Base, all successful on their
  first HTTP attempt. No customer delivery rows created in this window are
  pending, failed or dead-lettered.
- Four Base observations were created. Multiple subscriber destinations explain
  why delivery count can exceed observation count.
- Successful customer deliveries in this window all occurred before deployment;
  this sample cannot establish post-release customer delivery latency.

| Latency segment                                     |      p50 | p95 / p99 |
| --------------------------------------------------- | -------: | --------: |
| Observation persisted → delivery completed          | 12.882 s |  16.094 s |
| Observation persisted → delivery-ledger row created | 10.795 s |  13.652 s |
| Delivery-ledger row created → completed             |  2.228 s |   3.841 s |

There are only **seven samples**; p95 and p99 both select the maximum. The largest
component is before the first delivery-ledger row, which includes queue/fanout
waiting rather than just endpoint response time. This is observed-to-delivered
latency, not block-production-to-delivery latency.

### Validation traffic and historical failures

- Deployment validation contributed three successful observed deliveries, two
  successful connectivity tests, and two deliberately suppressed deliveries to an
  endpoint deleted during the test. Suppressed rows have `attempts = 0` and
  `last_error = webhook inactive`.
- Validation's observed-delivery latencies were 8.328–9.185 seconds.
- Two existing customer-cohort dead letters date to **September 4**, outside the
  baseline window. Both received HTTP 401: one reported missing webhook headers,
  the other a timestamp outside the accepted window. They explain the current
  dead-letter alert; they are not new failures from this rollout.

## Current health snapshot

Captured **2026-09-22 09:51:39 UTC**, separately from the frozen analytics window:

- All six chains active.
- Ethereum, Optimism, Gnosis, Polygon and Base: zero reported lag.
- Arbitrum: 11 blocks / 2.75 seconds reported lag.
- Zero pending deliveries and zero pending scanner commands.
- Zero active subscriptions with a null activation boundary.
- Base still carries its pre-existing skipped-block reason; no new gap is inferred
  from that retained marker.

Lag comes from coalesced D1 cursor/head checkpoints. It is a point-in-time snapshot,
not a 24-hour lag distribution or proof that the sustained-lag objective was met.

## Measurement gaps and next comparison

Existing telemetry cannot reconstruct these exact per-chain counts:

1. Blocks processed and bloom-negative blocks.
2. Individual block/log/receipt methods inside batches.
3. Log queries avoided, repeated reads, and scanner-level RPC-validation failures.
4. Upstream race attempts and failed Alchemy fallback attempts attributable to this
   service.
5. Historical scanner lag distributions.

The earlier 99-of-100 avoided-log sample remains a short replay sample, not this
day's measured avoidance rate. Add coalesced scanner counters for the missing
items, then collect a full stable 24 hours before projecting monthly savings.

> Follow-up: the post-change measurement and counterfactual compute estimate are
> in [the 2026-09-24 impact report](2026-09-24-post-change-impact.md).

For repeatable gateway aggregation, use the same fixed UTC windows and:

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

Mean latency is `sum(latency_total_ms) / sum(requests)`. Gateway HTTP error counts
include outcomes other than `success` and `fallback`. Preserve the same validation
account exclusions for the delivery cohort when repeating this comparison.
