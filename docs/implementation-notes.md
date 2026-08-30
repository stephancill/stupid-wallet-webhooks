# Implementation Notes

Milestone working notes for the EVM Address Notifications worker.

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

Under `wrangler dev --local`, chain activation/`eth_*` reads work via the
public rpc-racer feed and the cursor boots correctly; delivering new mined
blocks depends on the local DO alarm scheduler firing, which is flaky in local
mode (alarms are managed by the same workerd `_cf_ALARM` machinery). Deployed /
`--remote`, controlled-chain, or test-scheduled fixtures are the way to observe
continuous scanning; Milestone 3 adds the fanout consumer and full delivery.

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

- Move test delivery + delivery retries to the queue-based consumer in
  Milestone 3 (signing/retry-classification pattern already in
  `src/api/queues/webhookClient.ts`).
- Wrangler is on `4.126.0` (includes the local `_cf_ALARM` fix). Under bun's
  `minimum-release-age`, `4.127.1` is not yet installable; there is no remaining
  `fix-local` workaround needed.
