# Implementation Notes

Milestone working notes for the Stupid Wallet Webhooks worker.

> **Incident**: 2026-08-31 rpc-racer JSON-RPC batching + Polygon chain 137 stuck —
> full handover in `docs/incidents/2026-08-31-polygon-137-and-rpc-batching.md`.

## Milestone 5 — Production deployment & pilot (in progress)

### Cost: D1 write reduction for the scanner (new)

Cost exercised via GraphQL analytics: `address-notifications` D1 writes are
"dominated by `setChainCursor` — a `chain_registry` UPDATE fired once per
scanned block (~564k rows/day across 4 chains; a single fast chain like
Arbitrum ~0.25s blocks is ~345k/day). At 30 chains this linearly approaches/exceeds
the **50M rows-written/month** D1 included quota (→ $1/1M past it).

Fixes in `src/scanner/ScannerShard.ts`:

- **Coalesce D1 cursor + head writes** — `pendingTip`/`pendingHead` +
  `maybeFlushCursor()` persist `chain_registry.cursor` and `last_head_block` in
  a single UPDATE at most once per `SCANNER_CURSOR_D1_MS` (new env, default
  `8000`, in `wrangler.toml` / `.dev.vars.example`). This replaces the
  per-block cursor UPDATE and the per-poll head UPDATE. Slow chains
  (Ethereum ~12s) stay at their natural cadence; fast chains (~0.25–2s) drop
  from per-block to ≤1 per 8s (roughly 4×–32×).
- **Resume position is the DO block window, not D1 cursor** — so a throttled D1
  cursor never causes blocks to be re-scanned (and their observations
  re-enqueued). Falls back to the D1 cursor when the window is empty (cold start).
- **Window persistence moved out of the block loop** — `saveWindow` now happens
  once per scan pass (not once per block), cutting Durable Object storage writes
  ~pass-length x.
- **Idempotent fan-out guard** — `processBlock` enqueues a delivery only when
  `upsertObservation` reports the row was newly created (`ON CONFLICT DO
NOTHING`), so a rare mid-pass resume never double-delivers a webhook.
- **Unit guard** — `test/scanner-coalesce.test.ts` asserts `maybeFlushCursor`
  writes ≤1 `chain_registry` UPDATE per interval and always carries the latest
  tip, so a future refactor can't silently regress to per-block D1 writes.

Lag alert is time-based (`lagMs > 10s`), so an ≤8s D1-cursor staleness stays
under the alert threshold; the operator lag metric remains accurate at D1
granularity.

**Result** — D1 cursor + window writes collapse to roughly ~10-14× their
earlier volume on fast chains and ~unchanged on sparse chains. 30-chain D1
estimate drops from ~$77/mo to ~$0-2 (under the 50M/mo bucket).

### Degraded-chain auto-recovery

Live operator metrics showed chains could park forever in the scanner's
`unresolvable` branch ("no common ancestor within retained window") and stay
`degraded` behind. Root cause: `classifyChain` returning `unresolvable` was
terminal — `scanChain` degraded and retried the same block forever.

Inventory (chains 1 & 100 were ~13–17h behind at the time, so pre-dating the
D1-write work). Fix in `src/scanner/ScannerShard.ts` + `src/api/operator.ts`:

- **Auto re-anchor**: after `SCANNER_UNRESOLVABLE_LIMIT` (default 3) consecutive
  unresolvable scans, re-anchor at `head − SCANNER_REANCHOR_DEPTH_BLOCKS`
  (default 64) and resume scanning the trailing window forward. Idempotent
  observation upserts + the enqueue guard mean nothing double-delivers; the
  deep gap is logged/skipped (it was already unreachable while parked).
- **Head stays honest on anomaly paths**: `persistHeadOnly` still records
  `last_head_block` while parked, so the operator lag metric doesn't fabricate a
  huge backlog (this undoes the head-staleness side-effect of cursor coalescing).
- **Operator override**: `POST /operator/chains/:chainId/re-anchor` forces an
  immediate resync regardless of the threshold counter.
- The unresolvable counter is stored in DO storage so it survives shard
  re-creation between alarms.

Follow-up from the Polygon 137 incident: a successful re-anchor updated the DO
window and D1 cursor but did not schedule another alarm. Recovery therefore
parked the chain at exactly `head - SCANNER_REANCHOR_DEPTH_BLOCKS` (lag 64 by
default). `recoverFromUnresolvable` now schedules the next catch-up scan itself,
covering automatic, poisoned-block, and operator-triggered re-anchors. The
scanner recovery test asserts that an alarm is set.

### RPC batching for rpc-racer (cost)

The scanner's per-block RPC churn is the biggest driver of rpc-racer Worker
requests (~$7-8/mo at 6 chains). The scanner now collapses per-block calls into
fewer HTTP requests:

- **`block + logs` in one batch** — `fetchBlockAndLogs` (src/rpc/client.ts)
  sends `eth_getBlockByNumber` + `eth_getLogs` as one JSON-RPC **batch** in a
  single HTTP POST, halving the most common per-block request count (previously
  two separate calls).
- **batched receipts** — `ethGetTransactionReceipts` fetches all matched txs'
  receipts for a block in one batch instead of one call per tx.
- Corollary: `processBlock` now receives the logs from the scan loop (no
  extra `eth_getLogs` call) and batches its receipts.
- Requires rpc-racer to accept JSON-RPC **arrays** (new) — it validates a single
  object today; batch is a small rpc-racer change (accept array, forward whole,
  return array).

Measured effect expected: rpc-racer requests per block drop from ~3 → ~1-2 and
its request-cost falls to the $2-4/mo range at current 6-chain scale.

### Deployed resources (Cloudflare)

- Worker: `address-notifications` → **https://wallet-webhooks.stupidtech.net** (custom domain; workers.dev disabled)
- D1: `address-notifications-db` (`abb46259-a808-4350-bc3c-cbd8201f85ef`), migrations `0001`+`0002` applied remotely
- Queues: `matched-activity`, `webhook-delivery`, `webhook-delivery-dlq`
- Durable Objects: `ScannerShard` (`SCANNER_SHARD_1`, `SCANNER_SHARD_2`)
- Vars: `RPC_RACER_BASE_URL`, `RPC_SCANNER_FANOUT=5`, shard/quota defaults
- Secrets set: `OPERATOR_SECRET`, `API_KEY_PEPPER`, `WEBHOOK_SIGNING_MASTER`,
  `RPC_INTERNAL_SECRET` (shared with rpc-racer's `INTERNAL_SECRET`)
- Cron: reconciliation every 5 minutes
- `workers_dev = false` on a custom domain `wallet-webhooks.stupidtech.net`

### rpc-racer Milestone-0 support (live)

- `POST /internal/v1/:chain` — service-bound route, gate by `x-internal-secret`
  equal to `INTERNAL_SECRET` (bypasses the public rate limit)
- `fanoutCount` query param (`1..5`, default 5)
- Caller-labelled metrics (`caller: public|internal`)
- Consistency integration test (`scripts/integration-test.mjs`)
- **Alchemy fallback now also triggers on rate-limit / CU-degraded upstreams**
  (not just state-availability), so low/unkeyed public CUs are backstopped

### Scanner now live on Ethereum mainnet

- Verified: chain 1 `status=active`, `cursor`/`head` advancing, `lag=0`
- The scanner uses the internal rpc-racer route with `fanoutCount=5` when
  `RPC_INTERNAL_SECRET` is set.

### Bugs found & fixed during deploy

- **`process is not defined`**: `src/rpc/client.ts` read `process.env` in the
  endpoint builder; workerd defines no `process`, so the deployed scanner threw
  on every RPC. Guarded with `typeof process !== "undefined"` (only the bun
  fork/integration path uses `RPC_DIRECT_URL`). This was the actual reason the
  remote scanner never advanced its cursor.
- Scanner `RPC_SCANNER_FANOUT` raised to 5 (at 2, the few sampled upstreams were
  too often the ones being throttled/`525`).

### Operator ops surface added

- `POST /operator/chains/:chainId/scan` (out-of-band scan trigger),
- `POST /operator/chains/:chainId/pause` / `/resume`,
- `POST /operator/dlq/replay`,
- `GET /operator/metrics` (lag + alerts), `GET /operator/chains[/:chainId]`.

### Pilot completion (this pass)

- **More target chains live**: real subscriptions created for the test wallet on
  Base (8453), Optimism (10), and Arbitrum (42161) (mainnet already live). All
  verified `active` with cursors advancing and the activation boundary
  (`active_from_block = head + 1`) set by the scanner.
- **End-to-end `activity.observed` validated**: funded the test wallet on Base
  (`0xA0BFe1A0fc5B83d784e8599EfdED93655158E405`), subscribed it, sent a signed
  value transfer via `cast`, and confirmed the scanner produced an observation,
  the fan-out enqueued a delivery, the webhook was delivered with a **valid
  HMAC-SHA256 signature** (verified against the webhook's signing secret), and
  the ledger recorded `success` (HTTP 200). Also observed a second, independent
  delivery: an inbound ERC-20 transfer to the wallet on Optimism.
- **Retention cleanup wired** (`src/db/repository.ts`, `runRetentionCleanup`):
  the scheduled handler now deletes `activity_observations` (>7d) and
  `webhook_deliveries` (>30d) every 5 minutes alongside reconciliation.
- **Delivery-latency alerting added**: `observeSummary` now computes an
  observed→delivered `deliveryLatency` block (p50/p95/p99) over successful
  `activity.observed` deliveries in the last 24h (joined back to the observation
  `created_at`) and raises a warning when measured p95 exceeds
  `DELIVERY_LATENCY_ALERT_MS` (default 10s) with ≥5 samples. Percentile
  computation extracted as a pure, unit-tested helper
  (`computeLatencyPercentiles`, `test/retention.test.ts`). Suite now 43 tests.
- **Quotas verified live**: operator overrides on both dimensions behave
  correctly — a `subscriptionQuota:1` account accepted exactly one and rejected
  the rest (`"quota": active subscription quota exceeded`); a `chainQuota:1`
  account rejected a second distinct chain
  (`"quota": distinct chain quota exceeded`). Defaults (1,000 / 20) remain in
  effect for override-free accounts.
- **Multi-chain delivery validated**: bridged a small amount of Base ETH to
  Optimism and Arbitrum via **relay.link** (`scripts/bridge-relay.mts`), then
  sent value transfers from the test wallet on all three chains. `activity.observed`
  webhooks were delivered (HTTP 200) for **Base, Optimism, and Arbitrum** — 10
  successful deliveries across the pilot webhook, all reproducible through the
  delivery ledger. (relay deposit txs: `0xbe4b…9c` → OP, `0xd30b…ba9` → ARB.)

### Feedback from the live run

- **Observed→delivered p95 ≈ 19.6s** across the two validated deliveries — above
  the 10s pilot target. This is dominated by scanner poll cadence + queue polling
  latency, not signing/fan-out cost. Worth tightening poll intervals or delivery
  concurrency as the pilot accumulates samples.
- **Arbitrum momentarily fell ~40 blocks behind** right after activation (its
  activation backfilled from the head and fast block cadence). It recovers by
  cursor advancement; keep an eye on lag in `/operator/metrics`.

### Latency + lag tuning (pilot)

- **Scanner cadence/cap is now env-configurable**: `SCANNER_MAX_BLOCKS_PER_PASS`
  (default 100) limits blocks per alarm pass; `SCANNER_MIN_POLL_INTERVAL_MS`
  (default 500ms) is the fastest catch-up cadence while a backlog remains. The
  shard still relaxes to `blockSpeedMs/2` once caught up.
- **Arbitrum lag fixed in practice**: under the retuned cadence, Arbitrum dropped
  from ~85 blocks behind to ~12 (~3s) and stays there; its 250 ms block cadence
  is no longer mis-alerted as "2 blocks behind".
- **Lag reporting is time-aware**: `observeSummary` now returns `lagMs`
  (`blocks × block_speed_ms`) per chain and raises the behind-alert only when a
  chain is >10s behind in wall-clock terms (robust across fast cadences).
- **Delivery-latency segmentation** (this is the key pilot finding):
  `/operator/metrics` now splits observed→delivered into the p95 of two legs:
  - `observeToAttempt` ≈ **18.9s** — observation persisted → Webhook‑delivery
    queue consumer bid (i.e. the two‑queue fan‑out/fan‑out hop latency).
  - `attemptToDelivered` ≈ **0.8s** — the actual HMAC‑signed HTTP POST.
    Together with the observed p95 of 19.6s, this proves the 10s-latency target is
    not spent on scanning/signing/delivering — it is **the two sequential Cloudflare
    Queues** (each ~8s of consumer polling cadence). Meeting the p95-within-10s exit
    criterion with this two-queue architecture likely requires a high-freshness
    single-queue delivery fast path (a real design tradeoff vs. the documented
    decoupling) — flagged for a decision.

**In-design latency tuning (measured)**: raised the queue consumers'
`max_concurrency` (5/8) and lowered `max_batch_timeout` (2s/3s). Fresh Base
deliveries dropped from ~13–15s to ~9–11.5s `observeToAttempt` — a modest,
noisy gain — but the ~8s per-hop Cloudflare Queue consumer wake is now the
binding floor, so p95 in the two-queue design remains around (not comfortably
under) 10s. Meaningfully sub-10s still needs either a single (fast) queue hop or
a lower-latency queue-consumer regime.

### Local webhook receiver + tunnel (test tooling)

- `scripts/webhook-receiver.mts`: a Bun HTTP receiver that logs every request
  (headers incl. `webhook-id/timestamp/signature`, body) to a JSONL file
  (`CAPTURE_FILE`) for verifying signed webhooks locally.
- Pair it with a `cloudflared tunnel --url http://localhost:8799` quick tunnel to
  give the live worker a real HTTPS endpoint that backhauls to the local
  listener during pilot validation.

## Milestone 4 — Reorgs and Operations

### What shipped

- **Reorg window + fork-point detection** (`src/domain/reorg.ts`, pure + 5 tests):
  - rolling window of recently-accepted blocks (`findAncestor`, `orphanedHeights`,
    `pruneTo`, `pushWindow`, `classifyChain`).
- **Scanner integration** (`ScannerShard`): a per-chain rolling window is kept in
  Durable-Object storage. When a child block's `parentHash` no longer matches the
  accepted tip, the scanner:
  - finds the shared ancestor in the window;
  - `markObservationsRevertedByBlock` flips any observed observations in orphaned
    blocks to `reverted` (with `reverted_at`);
  - prunes the window, rewinds the cursor to the ancestor, and replays the
    canonical blocks;
  - if no ancestor is in-window, it degrades the chain for operator review.
- **Operator controls** (`/operator`): `POST /chains/:id/pause` and
  `POST /chains/:id/resume` (paused chains stop polling), plus
  `GET /operator/chains` health/lag summary. `chain_registry.status` gains
  `paused`. Reorg window + observation revert behavior unit-tested.

### Deferred (documented)

- Fanning reverted observations out as `activity.reverted` webhooks (delivery of
  a reverted event is a straightforward extension of the M3 delivery consumer).
- Full metrics suite + DLQ replay tooling and the restart/timeout/deep-reorg
  failure injections still require a controlled test environment.

### Observability (added after M4)

- `chain_registry.last_head_block` (migration `0002`) records the observed head
  so per-chain **lag** (head − cursor) is computable.
- `GET /operator/metrics` returns per-chain status + lag, delivery/observation
  counters, pending commands, and an **alert set** (degraded/paused chains,
  chain behind >2 blocks, dead-lettered deliveries, pending reconciliation).
- `GET /operator/chains/:chainId` returns per-chain lag detail.
- The scanner records the observed head each poll.

## Milestone 3 — Fanout and Webhook Delivery

Implemented from `docs/implementation-plan.md` §Milestone 3 and §Webhook Delivery.

### What shipped

- **Two-queue fanout/delivery path** completes the architecture:
  - **`matched-activity`** (produced by the M2 scanner) is consumed by
    `src/queues/fanout.ts` → looks up the persisted observation, enumerates
    `active` subscriptions for (chainId, trackedAddress), **enforces each
    subscription's activation block** (`active_from_block <= blockNumber`), and
    enqueues one `DeliveryHook` per destination onto **`webhook-delivery`**.
  - **`webhook-delivery`** is consumed by `src/queues/deliver.ts`:
    HMAC-SHA256 signing over the exact body, strict timeout + response-size cap,
    redirects disabled, retry classification (2xx success / retryable
    `408/409/425/429/5xx` / other 4xx permanent), and a ledger update each
    attempt.
- **Idempotency / dedupe:** `webhook_deliveries` has a unique
  (webhookId, eventId, eventType) constraint; the consumer skips anything
  already delivered successfully, so duplicate queue deliveries don't re-send.
- **Retries + DLQ:** the consumer `throw`s on retryable failure so Cloudflare
  Queues retries with backoff; exhausted deliveries move to the
  `webhook-delivery-dlq` dead-letter queue (`max_retries = 8`), and their state
  is also reflected in `webhook_deliveries` for the delivery-history API.
- **Deterministic bodies:** `src/queues/webhook-body.ts` reconstructs the exact
  bytes from the stored observation `data`, so retries are byte-identical and
  signatures/fixtures are reproducible (unit-tested).
- Both consumers are dispatched from the worker's `queue()` handler by queue name.

### Tests

3 new unit tests (`test/queues.test.ts`) covering byte-stable webhook bodies,
`createdAt` derivation from `blockTimestamp`, and observation `data` parsing.
**Suite now 30 tests.**

### Test caveat (local dev)

Local `wrangler dev` has no HTTP path to _push_ a message onto `matched-activity`
or observe a rejected `webhook-delivery` retry, so the full queue round-trip is
best exercised with a controlled chain (produce a matched message) plus a real
receiver under Cloudflare/test harness. The pure boundaries (matching, signing,
bodies, classification) are unit-tested; the delivery HTTP client classifies
outcomes. **The scanner+matching side is covered against a real chain by
`scripts/fork-test.mts`** (Anvil fork of a target chain + funded test accounts),
which drove the `RPC_DIRECT_URL` override in `src/rpc/client.ts`.

--- Earlier milestones below ---

## Milestone 2 — Scanner and Matching

Implemented from `docs/implementation-plan.md` §Milestone 2 and §Activity Model.

### What shipped

- **`src/domain/activity.ts`** — pure matching module:
  - Strict `Transfer` log decoding (ERC-20: exactly 3 topics + one 32-byte data
    word; ERC-721: 4 topics, token id in topic 3). Malformed lookalikes are
    counted, never emitted.
  - `analyzeBlock`: one draft per `(transaction, trackedAddress)` for tracked
    senders (every mined tx, including zero-value and reverted), token effects
    oriented by tracked participant (self when both sides tracked), and incoming
    native candidates.
  - `finalizeBundles`: joins receipts, resolves `success`/`reverted`, drops
    effects on reverted txs, orders deterministically (native first, then tokens
    by logIndex), and attaches deterministic observation + effect ids. Throws on
    a missing/mismatched receipt so the cursor is never advanced on incomplete
    processing.
  - No outbound native effect for the initiator (transaction.value represents
    it); `createdContractAddress` from successful contract-creation receipts.
- **`src/domain/ids.ts`** — deterministic `observationId` (bundle key + block
  hash, the webhook event id), `bundleKey`, and `effectId`.
- **`src/rpc/client.ts`** — rpc-racer JSON-RPC client (`eth_blockNumber`,
  `eth_getBlockByNumber`, `eth_getLogs` keyed by the exact block hash,
  `eth_getTransactionReceipt`) with timeouts + bounded retries. Returns
  normalized block/log/receipt types.
- **`src/scanner/queue.ts`** + `MATCHED_ACTIVITY_QUEUE` producer binding — one
  message per matched bundle (the Milestone-3 fanout consumer reads this).
- **`src/scanner/ScannerShard.ts`** rewritten as a per-chain scanner:
  - Owns cursors (`chain_registry.cursor_block/hash`), scheduled alarms, and
    reads the tracked set from D1 each pass.
  - First activation anchors the cursor at the head (real block hash) and sets
    `active_from_block = head + 1` (no historical backfill).
  - Processes blocks up to the head sequentially, bounded per pass
    (`MAX_BLOCKS_PER_PASS`), advances cursor only after persist + enqueue
    succeed, and degrades on a parent-hash mismatch (resumable reorg handling
    lands in M4).
  - Still applies the Milestone-1 control-plane commands (subscribe/unsubscribe/
    retry_chain) so the migration path is preserved.
- Repository additions for the scanner: `listTrackedAddressesForChain`,
  `setChainCursor`, `setActiveFromBlockForChain`, `upsertObservation`.

### Tests

12 new unit tests (`test/activity.test.ts`) covering ERC-20/ERC-721 decoding,
malformed/non-transfer counting, sender bundles with no effects, outgoing token,
reverted sender (no effects), native dropped on reverted, self-transfers, effect
ordering, and deterministic ids. Total suite: 27 tests, all passing.

### Live-run note

Confirmed working on Wrangler `4.126.0` (the `_cf_ALARM` fix): a subscribe
dispatches to the scanner Durable Object, its alarm fires, and `scanChain`
bootstraps the cursor at the real head (verified: cursor advanced to a live
height with a real hash, status `active`, no parse/alarm errors). The remaining
limit is not tooling: to observe a _matched_ observation persist and enqueue,
real tracked-address activity must land in a new block (or a controlled chain),
which Milestone 3's fanout consumer reads.

--- Earlier milestones below ---

Implemented the API + persistence layer from `docs/implementation-plan.md`.

### What was built

- Hono Cloudflare Worker scaffold with `wrangler` (D1, two `ScannerShard`
  Durable Objects, alarms cron reconciliation trigger).
- D1 migration `0001_init.sql` with the plan's control-plane tables (accounts,
  api_keys, webhooks, subscriptions, tracked_addresses, chain_registry,
  scanner_operations, activity_observations, webhook_deliveries), a partial
  unique index on the active-subscription tuple, and delivery/observation
  indexes.
- **API keys**: only a peppered HMAC-SHA256 hash is stored; webhook signing
  secrets are derived deterministically from a master secret + webhook id
  (never stored) and returned once.
- **Customer routes** (`/v1`, `Bearer` auth):
  - Webhook CRUD (create returns the signing secret once), list, delete
    (cascades to deactivating active subscriptions), and signed test delivery
    recorded to the delivery ledger.
  - Webhook-delivery history (30-day) with cursor pagination and filters.
  - Subscription CRUD with exact one-webhook mapping, account quotas (active
    subscriptions limit + distinct-chain limit), chain resolution, and explicit
    per-chain results for quota/conflict failures.
  - Chains: metadata resolution over `evm.stupidtech.net` + manual capability
    retry guarded by holding an unsupported subscription.
- **Operator routes** (`/operator`, shared-secret guard): create account,
  create/revoke API key, suspend/reactivate, list ops, reconcile, operator chain
  retry. Driven by `scripts/operator.mjs`.
- **Scanner command outbox** with deterministic idempotent ids, one D1 batch
  write, then dispatch to the owning shard DO; **reconciliation** redelivers
  unapplied commands (also via the worker's scheduled handler / cron).
- **ScannerShard Durable Object** (Milestone-1 stub): finalizes control-plane
  state from the outbox — resolves the chain over evm.stupidtech.net metadata,
  assigns a shard, and marks subscriptions `active`/`unsupported`.
- SSRF-safe webhook URL validation; signed test delivery with outcome
  classification recorded to the ledger.
- 15 unit tests (address normalization, key hashing/signing, deterministic ids
  and command ids, webhook URL validation).

### Decisions (confirmed with the user)

- No scanner in M1: subscriptions are created `pending` and transition to
  `active`/`unsupported` when the stub scanner resolves the chain.
- Operator provisioning via CLI script + operator routes guarded by
  `OPERATOR_SECRET`.
- Local-first: bindings wired in `wrangler.toml` but nothing deployed.
- Chain resolution hits the public `evm.stupidtech.net` over HTTP for now; the
  Milestone-0 service binding will replace it.

### Verified end-to-end (local `wrangler dev`)

create account → provision API key → create webhook → multi-chain subscribe
(`[1, 8453]`) → both `active` → duplicate tuple returns `conflict` → list →
delete (`deleting`) → re-subscribe the same tuple succeeds.

## Wrangler local-dev bug — resolved by upgrade

Wrangler `4.125.0` bundled a workerd whose local `_cf_ALARM` alarm-table handling
could boot-crash `wrangler dev --local` (particularly after
`wrangler d1 migrations apply --local`), leaving a mixed 2/3-column `_cf_ALARM`
and failing with `table _cf_ALARM has 3 columns but 2 values were supplied`.
This was fixed upstream in workerd (STOR-5374 / issue #6850), which is bundled
in Wrangler `4.126.0`+.

- Verified: on Wrangler `4.126.0`, wiping `.wrangler`, running all `d1
migrations apply --local`, and booting `wrangler dev --local` succeeded twice
  in a row (previously this exact sequence crashed on 4.125.0). The old
  `scripts/fix-local.mts` workaround was removed; `db:migrate:local` is now the
  plain migration command.
- The bug is local-dev-only; production is unaffected.

## Open items / next steps

See `docs/handover.md` for the full operator handover. This pass completed the
pilot's chain coverage, end-to-end webhook validation, retention cleanup,
delivery-latency alerting, and latency/lag tuning (All detailed under the
Milestone 5 section above). Still open:

- **Delivery latency (accepted for pilot)**: observed p95 ≈ 10s after the
  in-design tuning (concurrency + fast flush); the residual is the two-queue
  Cloudflare consumer wake cadence, which is acceptable for the pilot. A
  single-hop fast path or lower-latency queue regime remains documented as the
  lever if a future tier needs reliably sub-10s delivery.
- **Custom domain / hardening** ✅ — served on `https://wallet-webhooks.stupidtech.net`
  and `workers.dev` is **disabled**; the ephemeral host is retired. Optional
  edge-auth/TLS rules remain an nicety.
- **Bound-Worker test** ✅ (`test/rpc-bound.test.ts`) — asserts the scanner's RPC
  client hits only rpc-racer's private `/internal/v1/…` route (with
  `x-internal-secret`) whenever `RPC_INTERNAL_SECRET` is configured, and never a
  public `/v1/…` endpoint. Suite now 47 tests.
- **Per-attempt delivery timing / distributed tracing** for exact send-time
  measurement beyond the timestamp-based p95 approximation.
- **Local dev queue round-trip** can't run (miniflare doesn't loop produced
  messages to a worker's own `queue()` consumer); verified empirically — not a
  defect.
