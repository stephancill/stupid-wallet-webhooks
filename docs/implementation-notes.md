# Implementation Notes

Milestone working notes for the EVM Address Notifications worker.

## Milestone 5 — Production deployment & pilot (in progress)

### Deployed resources (Cloudflare)

- Worker: `address-notifications` → **https://address-notifications.stephan-cloudflare.workers.dev**
- D1: `address-notifications-db` (`abb46259-a808-4350-bc3c-cbd8201f85ef`), migrations `0001`+`0002` applied remotely
- Queues: `matched-activity`, `webhook-delivery`, `webhook-delivery-dlq`
- Durable Objects: `ScannerShard` (`SCANNER_SHARD_1`, `SCANNER_SHARD_2`)
- Vars: `RPC_RACER_BASE_URL`, `RPC_SCANNER_FANOUT=5`, shard/quota defaults
- Secrets set: `OPERATOR_SECRET`, `API_KEY_PEPPER`, `WEBHOOK_SIGNING_MASTER`,
  `RPC_INTERNAL_SECRET` (shared with rpc-racer's `INTERNAL_SECRET`)
- Cron: reconciliation every 5 minutes
- `workers_dev = true` (public URL for the pilot)

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

See `docs/handover.md` for the full operator handover. Immediate items:

- **Pilot chain coverage**: subscribe Base (8453), Optimism (10), Arbitrum (42161)
  in addition to the mainnet chain already live.
- **Observe a real `activity.observed` webhook** end-to-end (needs a tracked
  address to transact on one of the live chains).
- **Enforce quotas**: defaults are in place (1,000 subscriptions / 20 chains);
  add operator overrides / rate-limit enforcement for the pilot if desired.
- **Delivery p95 latency / lag alerting**: `GET /operator/metrics` surfaces
  lag + dead-letters; true observed→delivered latency p95 needs distributed
  tracing or a per-delivery timing metric, still to add.
- **Local dev queue round-trip** can't run (miniflare doesn't loop produced
  messages to a worker's own `queue()` consumer); verified empirically — not a
  defect.
