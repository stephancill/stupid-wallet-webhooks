# Handover — rpc-racer batching & Polygon chain 137 stuck

Date: 2026-08-31
Scope: `address-notifications` (this repo) + `rpc-racer` (sibling repo), live
pilot service `https://wallet-webhooks.stupidtech.net`.

## TL;DR

- We reduced the scanner's per-block RPC load on **rpc-racer** (the biggest
  driver of the service's rpc-racer Worker bill) by shipping **JSON-RPC batch**
  support in rpc-racer and batching `block + logs + receipts` on the scanner.
- Along the way we found and fixed several **chain-stuck** recovery and correctness
  bugs (degraded-chain auto-re-anchor, D1 write coalescing, an empty-batch
  wedge, and a skip-poisoned-block guard).
- Polygon's `lag 64` wedge was a lost-alarm bug after re-anchoring, not a
  Polygon block parsing failure. Recovery now schedules its own continuation,
  and scheduled reconciliation restores missing alarms for active chains.

## Summary of what changed (commits)

`address-notifications` (main):

| Commit    | Purpose                                                                   |
| --------- | ------------------------------------------------------------------------- |
| `d3482b2` | Coalesce D1 cursor+head writes (cut D1 rows written ~order of magnitude)  |
| `781843e` | Unit guard for D1 coalescing                                              |
| `1f3ab4b` | Auto-recover `unresolvable`/degraded chains; operator `/re-anchor`        |
| `eabcd2e` | Fetch block+logs (and receipts) via rpc-racer **batch**                   |
| `ae91c03` | Keep transfer-only topic filter in the batched fetch                      |
| `2cb2d86` | Skip empty receipts batch (fixes a "match-less block wedges scanner" bug) |
| `d6503ac` | Skip a persistently-failing block after N attempts (fetch-gap guard)      |
| `a46b395` | Schedule catch-up after every successful re-anchor                        |
| `32e5442` | Remove the invalid ScannerShard delete/recreate migration                 |
| `0a6b0e1` | Reconcile missing active-chain alarms every five minutes                  |
| `3db4196` | Flush the authoritative DO tip when a scan is already caught up           |
| `446d2c5` | Replace stale past alarms instead of treating them as pending             |

**rpc-racer** (main):

- `4980862` — `feat: support JSON-RPC batch (array) requests` (forward whole
  array, return array; `isJsonRpcResponse` accepts arrays).

### New env knobs (address-notifications)

| Var                             | Default | Meaning                                                  |
| ------------------------------- | ------- | -------------------------------------------------------- |
| `SCANNER_CURSOR_D1_MS`          | `8000`  | Max cadence for persisting D1 cursor (coalescing)        |
| `SCANNER_UNRESOLVABLE_LIMIT`    | `3`     | Consecutive unresolvable scans before auto re-anchor     |
| `SCANNER_REANCHOR_DEPTH_BLOCKS` | `64`    | Blocks behind head to re-anchor at                       |
| `SCANNER_SKIP_BLOCK_FAILURES`   | `5`     | Skip a block after N consecutive failures (`0` disables) |

## Issue status

| Chain                                                         | Status          |
| ------------------------------------------------------------- | --------------- |
| 1 (Ethereum), 10 (Optimism), 100 (Gnosis), 8453 (Base), 42161 | active, lag 0-3 |
| **137 (Polygon)**                                             | active, lag 0   |

`operator/metrics` delivers: `deliveries { pending: 0, success N, failed: 0,
dead_lettered: 0 }` — no dead letters; webhooks flowing.

## Root cause chain (so far)

1. **rpc-racer Polygon upstream is flaky/paywalled.** The keccak.io node in
   rpc-racer's chain-137 pool returns HTTP 403 "api key required" for many
   requests/blocks. It's intermittent — sometimes the whole batch returns 200
   with full data (`eth_getBlockByNumber` + `eth_getLogs(topics)`, 245 transfer
   logs, consistent hash), sometimes 403. The user reported fixing rpc-racer's
   degraded/fallback classification upstream (keccak errors shouldn't win; Alchemy
   fallback engages), verified 8/8 and 9/9 clean.
2. **Scanner batching exposed the volume/cost** but also a real client bug: the
   initial `fetchBlockAndLogs` sent `eth_getLogs` **without a topics filter**,
   returning _every_ log (huge payloads, unfiltered matches) — fixed in `ae91c03`.
3. **Empty-batch wedge:** `ethGetTransactionReceipts([])` sent an empty JSON-RPC
   batch, which rpc-racer rejects (`400 Empty JSON-RPC batch`). Any block with no
   tracked matches threw, and the scanner retried that block forever → chains
   accumulated big backlogs (fix `2cb2d86`).
4. **Per-block save/wedge resilience:** `SCANNER_SKIP_BLOCK_FAILURES` now skips a
   block after N failures (re-anchor past it) so one poisoned block can't freeze a
   chain (`d6503ac`).
5. **Polygon's next block was valid.** The persisted cursor was block `92997278`
   (`0xa109…de9`). Block `92997279` fetched cleanly; its parent was exactly that
   cursor hash, and its 119 transactions / 382 Transfer logs produced no tracked
   matches. Five internal fanout-5 batch requests returned the same block and log
   set. There was no deterministic receipt, parser, or reorg error to capture.
6. **The exact `lag 64` was the recovery anchor.** On the fifth block failure,
   `recoverFromUnresolvable` saved `head − 64` as the new cursor, but neither it
   nor the poisoned-block caller scheduled another alarm. The alarm invocation
   then returned, leaving no future event that could scan `cursor + 1`.
7. **A stale alarm defeated the first wake fix.** `schedule(0)` kept any existing
   alarm with an earlier timestamp, including Polygon's dead timestamp in the
   past. Cron `/wake` requests returned 200 but did not replace it. `schedule`
   now preserves only future alarms; direct scans then showed the cursor advance
   by roughly 100 blocks per pass and continue advancing from follow-up alarms.
8. **Caught-up scans could leave D1 stale.** A fast catch-up inside the
   eight-second coalescing window returned early on later no-work scans without
   flushing the DO window tip. The caught-up path now stages and checkpoints the
   authoritative DO tip, keeping operator lag honest.
9. **The attempted DO reset never deployed.** Cloudflare rejects a
   `deleted_classes = ["ScannerShard"]` migration while the class still has a
   binding (`10061`). Removing that invalid migration unblocked deployment; DOs
   receive current Worker code without being recreated.

## Resolution

- `recoverFromUnresolvable` now schedules a catch-up alarm after every successful
  re-anchor, including automatic, poisoned-block, and operator-triggered paths.
- The five-minute reconciliation cron sends a lightweight `/wake` request to
  every active/degraded shard. It only restores an immediate alarm, so D1's
  active chain registry now bounds recovery from a lost DO alarm to one cron
  interval.
- Alarm scheduling distinguishes future alarms from stale timestamps, and the
  caught-up path checkpoints the DO cursor after the D1 write budget expires.
- Tests cover post-re-anchor scheduling, missing-alarm restoration, and stale
  past-alarm replacement. Full suite: 55 tests.
- Live verification: one operator scan restarted the corrected alarm chain;
  subsequent scans advanced without operator calls and reduced Polygon lag from
  `3575` to `0`, finishing at cursor/head `93001748`. Deliveries remained healthy
  (24 successful, zero pending/failed/dead-lettered), all chains ended at lag
  `0-3`, and no chain/scanner alert remained.

### Repro (scope the 403 / batch serving)

```bash
B=0x58b00cd   # a block the scanner was stuck on
curl -sS -D - -X POST 'https://evm.stupidtech.net/v1/137' -H 'content-type: application/json' \
  --data "[
    {\"jsonrpc\":\"2.0\",\"method\":\"eth_getBlockByNumber\",\"params\":[\"$B\",true],\"id\":1},
    {\"jsonrpc\":\"2.0\",\"method\":\"eth_getLogs\",
     \"params\":[{\"fromBlock\":\"$B\",\"toBlock\":\"$B\",
                 \"topics\":[\"0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef\"]}],\"id\":2}
  ]"
```

Loop it 5-8 times; watch for intermittent 403 (keccak). The scanner uses the
internal route `/internal/v1/137?fanoutCount=5` with `RPC_INTERNAL_SECRET`.

## Now / how to verify

- Health + lag: `GET /operator/metrics` (Bearer `OPERATOR_SECRET`).
- Force a chain resync: `POST /operator/chains/:chainId/re-anchor` (or `/scan`).
- Webhook receive test: `scripts/webhook-receiver.mts` (bun) + a funded cast/bridge.

## Cost (measured — the original point)

- The scanner's raster batch cut per-block rpc-racer requests from ~3 to ~1-2,
  and the D1 cursor coalescing cut `address-notifications-db` rowsWritten ~4×
  (live GraphQL baseline ~40k/hr → approximately 10k/hr). At 30-chain scale D1
  was estimated to approach/exceed the 50M rows-written bucket (approximately
  $77/mo) — the coalescing keeps
  it ~$0, and rpc-racer batching drops that contribution to ~$2-4/mo.
- **KV**: the only namespace (`PROOF_BUNDLES`, 2 keys) is $0.

Analytics query token: `CLOUDFLARE_ANALYTICS_TOKEN` in `~/.zshrc` (read-only
Account Analytics) — use the GraphQL datasets (`d1AnalyticsAdaptiveGroups`,
`workersInvocationsAdaptive`, `durableObjectsInvocationsAdaptiveGroups`, …).

## Local / note

- `bun test` (55 pass), `bun run lint`, `bunx tsc --noEmit` all green.
- Pushes to `main` auto-deploy both workers via the Cloudflare GitHub integration
  (do not run `wrangler deploy` manually; migrations apply in the pipeline).
- Do not reintroduce `b38ffe5`'s delete/recreate migration; it is invalid while
  the deployment binds `ScannerShard`.
