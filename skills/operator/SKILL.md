---
name: operator
description: >-
  Operate the Stupid Wallet Webhooks service (Cloudflare Worker at
  https://wallet-webhooks.stupidtech.net). Use when the user wants operator-level
  actions: create accounts and API keys, inspect per-chain health/lag/metrics,
  pause or resume scanning, redeliver unapplied scanner commands, replay
  dead-lettered webhooks, deploy the Worker or apply D1 migrations, or
  troubleshoot delivery/failing webhooks. The subscriber-facing (customer) API is
  covered by the `subscriber` skill.
---

# Operator — Stupid Wallet Webhooks

Cloudflare Worker (`address-notifications`) delivering signed webhooks for EVM
address activity. Production URL: `https://wallet-webhooks.stupidtech.net` (custom
domain; workers.dev disabled). Canonical control-plane store is D1
(`address-notifications-db`).

## Before you start

- The operator API is guarded by `Authorization: Bearer <OPERATOR_SECRET>`.
- `OPERATOR_SECRET` is **never committed**. For local runs it lives in `.dev.vars`;
  for remote use it is set on the Worker (fetch it from the operator's secret
  stash, typically the machine that holds the temp secrets).
- The operator CLI reads `OPERATOR_SECRET` and `OPERATOR_BASE_URL`:

```bash
export OPERATOR_SECRET=... OPERATOR_BASE_URL=https://wallet-webhooks.stupidtech.net
bun scripts/operator.mts add Acme
bun scripts/operator.mts create-api-key <accountId>   # returns the full key once
bun scripts/operator.mts revoke <accountId> <keyId>
bun scripts/operator.mts suspend <accountId>
bun scripts/operator.mts reactivate <accountId>
bun scripts/operator.mts reconcile
bun scripts/operator.mts ops
```

## Health & metrics

```bash
curl -s -H "Authorization: Bearer $OPERATOR_SECRET" $OPERATOR_BASE_URL/operator/metrics
```

`/operator/metrics` returns per-chain status/cursor/head and **lag** (+ `lagMs`,
`blockSpeedMs`), delivery counters (pending/success/failed/dead_lettered),
`observations`, and `deliveryLatency` p50/p95/p99 plus a **segments** split of
observeToAttempt vs attemptToDelivered, `pendingCommands`, and an `alerts` array.
Treat any `severity:critical` (dead-lettered deliveries) as an action item.

## Common operations

- **Per-chain detail**: `GET /operator/chains/:chainId`
- **Force an out-of-band scan**: `POST /operator/chains/:chainId/scan`
- **Pause / resume scanning**: `POST /operator/chains/:chainId/pause` |
  `/resume`
- **Pending scanner commands**: `GET /operator/scanner-operations`
- **Re-dispatch pending commands**: `POST /operator/reconcile` (also runs on the
  5-minute cron)
- **Replay dead-lettered webhooks**: `POST /operator/dlq/replay` (re-enqueues
  exhausted `webhook-delivery` deliveries)

## Provisioning

```bash
# account (optional quota overrides: subscriptionQuota, chainQuota)
curl -s -X POST -H "Authorization: Bearer $OPERATOR_SECRET" \
  -H "content-type: application/json" \
  -d '{"name":"Acme","subscriptionQuota":100,"chainQuota":10}' \
  $OPERATOR_BASE_URL/operator/accounts

# issue a key for an account (raw key returned ONCE; only its hash is stored)
curl -s -X POST -H "Authorization: Bearer $OPERATOR_SECRET" \
  $OPERATOR_BASE_URL/operator/accounts/<accountId>/api-keys

# list keys, revoke
GET  $OPERATOR_BASE_URL/operator/accounts/<accountId>/api-keys
DELETE $OPERATOR_BASE_URL/operator/accounts/<accountId>/api-keys/<keyId>
```

## Deploy & migrations

```bash
wrangler deploy          # push current main to the Worker
wrangler d1 migrations apply address-notifications-db --remote   # after schema changes
```

Scanner cadence hooks are env vars: `SCANNER_MAX_BLOCKS_PER_PASS`,
`SCANNER_MIN_POLL_INTERVAL_MS`; delivery-latency alert threshold:

`DELIVERY_LATENCY_ALERT_MS`. New env knobs need a redeploy or `wrangler vars`.

## Secrets

- `OPERATOR_SECRET`, `API_KEY_PEPPER`, `WEBHOOK_SIGNING_MASTER`,
  `RPC_INTERNAL_SECRET` are set via `wrangler secret put <NAME>` (never commit).
  `RPC_INTERNAL_SECRET` must equal rpc-racer's `INTERNAL_SECRET`.
- Verify on the live Worker, not local `wrangler dev`.

## Gotchas

- Local `wrangler dev` queue consumers do not run (miniflare won't loop a
  produced message to the worker's own `queue()` consumer); test the delivery
  path with a real chain/tunnel rather than local dev.
- The scanner reaches chains via rpc-racer; keep `RPC_INTERNAL_SECRET` present so
  it uses the private `/internal` route instead of the public budget.