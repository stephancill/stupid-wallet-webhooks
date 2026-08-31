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
- **All chains except Polygon (137) are healthy** (lag 0, deliveries flowing).
  **137 is currently wedged at `lag ~64`** (approximately `head − 64`) and the
  code is already correct on it — this is the one open item.

## Summary of what changed (commits)

`address-notifications` (main):

| Commit | Purpose |
| --- | --- |
| `d3482b2` | Coalesce D1 cursor+head writes (cut D1 rows written ~order of magnitude) |
| `781843e` | Unit guard for D1 coalescing |
| `1f3ab4b` | Auto-recover `unresolvable`/degraded chains; operator `/re-anchor` |
| `eabcd2e` | Fetch block+logs (and receipts) via rpc-racer **batch** |
| `ae91c03` | Keep transfer-only topic filter in the batched fetch |
| `2cb2d86` | Skip empty receipts batch (fixes a "match-less block wedges scanner" bug) |
| `d6503ac` | Skip a persistently-failing block after N attempts (fetch-gap guard) |
| `b38ffe5` | DO migration: delete+recreate `ScannerShard` to force current code |

**rpc-racer** (main):

- `4980862` — `feat: support JSON-RPC batch (array) requests` (forward whole
  array, return array; `isJsonRpcResponse` accepts arrays).

### New env knobs (address-notifications)

| Var | Default | Meaning |
| --- | --- | --- |
| `SCANNER_CURSOR_D1_MS` | `8000` | Max cadence for persisting D1 cursor (coalescing) |
| `SCANNER_UNRESOLVABLE_LIMIT` | `3` | Consecutive unresolvable scans before auto re-anchor |
| `SCANNER_REANCHOR_DEPTH_BLOCKS` | `64` | Blocks behind head to re-anchor at |
| `SCANNER_SKIP_BLOCK_FAILURES` | `5` | Skip a block after N consecutive failures (`0` disables) |

## Issue status

| Chain | Status |
| --- | --- |
| 1 (Ethereum), 10 (Optimism), 100 (Gnosis), 8453 (Base) | **active, lag 0** |
| 42161 (Arbitrum) | active, draining/backlog (was 20k+, trending down) |
| **137 (Polygon)** | **active but pinned at `lag ~64`** — **OPEN** |

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
   returning *every* log (huge payloads, unfiltered matches) — fixed in `ae91c03`.
3. **Empty-batch wedge:** `ethGetTransactionReceipts([])` sent an empty JSON-RPC
   batch, which rpc-racer rejects (`400 Empty JSON-RPC batch`). Any block with no
   tracked matches threw, and the scanner retried that block forever → chains
   accumulated big backlogs (fix `2cb2d86`).
4. **Per-block save/wedge resilience:** `SCANNER_SKIP_BLOCK_FAILURES` now skips a
   block after N failures (re-anchor past it) so one poisoned block can't freeze a
   chain (`d6503a`).
5. **1337 specifically:** even after all fixes (incl. a forced DO delete/re-create,
   deployed 18:08:52Z) it remains pinned at `head − 64`. So it is **not a
   stale-code** issue. The tail/block after the cursor fails deterministically in
   a way the 5-attempt skip isn't catching, or it self-located-loop at
   `head−64` after each re-anchor. **We have not yet captured the shard's actual
   error.**

## Must-do next step (the open item)

Read the scanner's structured error for chain 137. The code already logs
`scan block fetch failed [chain 137 block …]` / `scan error on chain 137 block …`.
It is not surfacing via `wrangler tail` (DO alarm logs aren't in the tail stream).

Options, in order of preference:
1. **Enable Real-time Logs / Logpush** for `address-notifications` and filter for
   `chain 137` to read the JSON exception — fastest to the root cause.
2. Add a temporary `/operator` debug route that logs/tail the last shard error,
   or a `console.error` amplification you can scrape.

Once you know the throw, fix at the exact root (likely a receipt/parse/reorg or
`eth_getLogs` edge on Polygon 137) and confirm via re-anchor → lag 0.

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
  (live GraphQL baseline ~40k/hr → ~10k/hr). At 30-chain scale D1 was estimated
  to approach/exceed the 50M rows-written bucket (~$77/mo) — the coalescing keeps
  it ~$0, and rpc-racer batching drops that contribution to ~$2-4/mo.
- **KV**: the only namespace (`PROOF_BUNDLES`, 2 keys) is $0.

Analytics query token: `CLOUDFLARE_ANALYTICS_TOKEN` in `~/.zshrc` (read-only
Account Analytics) — use the GraphQL datasets (`d1AnalyticsAdaptiveGroups`,
`workersInvocationsAdaptive`, `durableObjectsInvocationsAdaptiveGroups`, …).

## Local / note

- `bun test` (53 pass), `bun run lint`, `bunx tsc --noEmit` all green.
- Pushes to `main` auto-deploy both workers via the Cloudflare GitHub integration
  (do not run `wrangler deploy` manually; migrations apply in the pipeline).
- `b38ffe5` delete+recreate `ScannerShard` is a one-time migration; a re-pr` may
  be needed after fixing 137's root cause to re-init that shard.