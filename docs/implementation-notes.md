# Implementation Notes

Milestone working notes for the EVM Address Notifications worker.

## Milestone 1 — API and Persistence

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

## Known wrangler-dev bug (local only) and workaround

`wrangler dev --local` intermittently crashes at boot with:

```
Fatal uncaught kj::Exception: workerd/util/sqlite.c++:842:
SENTRY_DO SQLite failed; ... table _cf_ALARM has 3 columns but 2 values
were supplied: SQLITE_ERROR
```

- `SENTRY_DO` is workerd's prefix for Durable Object SQLite errors
  (cloudflare/workerd#7150).
- The base `_cf_ALARM` schema is 2 columns (`actor_id`, `scheduled_time`); the
  third `actor_name` column comes from workerd's alarm-name design
  (cloudflare/workerd#6850). When the local `_cf_ALARM` has that third column,
  workerd inserts only 2 values and aborts.
- We reproduced it and confirmed causation by adding the `actor_name` column to a
  local `metadata.sqlite` and watching `wrangler dev` crash. The poisoned
  3-column table commonly appears after `wrangler d1 migrations apply --local`.
- It is a **local dev runtime issue; production is unaffected** and unrelated to
  any of our code.
- Workaround: `scripts/fix-local.mts` deletes only the poisoned
  `metadata.sqlite` (the real D1 `*.sqlite` is preserved). It runs automatically
  after `db:migrate:local`.

## Open items / next steps

- Populate `active_from_block = head + 1` in the real scanner (Milestone 2).
- Move test delivery + delivery retries to the queue-based consumer in
  Milestone 3 (signing/retry-classification pattern already in
  `src/api/queues/webhookClient.ts`).
- Revisit a wrangler upgrade once a fix for the local `_cf_ALARM` bug is
  confirmed (bun's `minimum-release-age` currently blocks installing wrangler
  >4.125.0).