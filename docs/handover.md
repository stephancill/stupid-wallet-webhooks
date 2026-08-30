# Handover — EVM Address Notifications

Operator and maintainer handover. Product spec in `docs/implementation-plan.md`;
build notes in `docs/implementation-notes.md`.

## What this is

A multi-tenant Cloudflare Workers service that signs and delivers webhooks for
EVM activity (top-level txs, native value, ERC-20, ERC-721). Milestones 1–4 are
implemented; **Milestone 5 (pilot) is live on Ethereum mainnet** and in progress.

## Architecture (one paragraph)

A Hono worker exposes `/v1` (customer) and `/operator` (operator) routes over D1,
Durable Objects, and Queues. Subscriptions are written to D1 and dispatched as
idempotent commands to a per-chain `ScannerShard` Durable Object, which scans
blocks via rpc-racer (`evm.stupidtech.net`), matches
`(transaction, trackedAddress)` into deterministic observations, persists them,
and enqueues one message per bundle. `matched-activity` feeds the fan-out
consumer → `webhook-delivery` → signed HTTP with retries and a DLQ.

## Live deployment

- Worker: `address-notifications`
- URL: `https://address-notifications.stephan-cloudflare.workers.dev`
- D1: `address-notifications-db` (`abb46259-a808-4350-bc3c-cbd8201f85ef`)
- Queues: `matched-activity`, `webhook-delivery`, `webhook-delivery-dlq`
- Durable Objects: `ScannerShard` x2
- Cron: reconcile every 5 min

### Secrets (set on the Worker; not in git)
| Secret | Purpose |
|---|---|
| `OPERATOR_SECRET` | Bearer for `/operator/*` |
| `API_KEY_PEPPER` | Peppers customer API-key hashes |
| `WEBHOOK_SIGNING_MASTER` | Derives each webhook's signing secret |
| `RPC_INTERNAL_SECRET` | Must equal rpc-racer `INTERNAL_SECRET` (scanner uses private route) |

The generated values are **not** in the repo. Locally they live under
`/private/var/folders/…/T/opencode/` (`operator-secret`, `internal-secret`, etc.)
on the machine where they were created. **Treat them as compromised if that
folder is shared; rotate with**:
`wrangler secret put NAME --remote < <(echo NEWVALUE)` (use a real secret store in
production).

## Local development

```bash
bun install
cp .dev.vars.example .dev.vars      # set secrets for local
bun run db:migrate:local
bun run dev                          # wrangler dev --local :8787
bun test                             # 41 unit tests
bun run fork-test                    # Anvil fork across a target chain + tx (scanner+matcher)
```

Note: local dev uses bun, which is why the `process` hack in `src/rpc/client.ts`
only ever bit the deployed worker (workerd has no `process`). The guard tests for
`typeof process !== "undefined"`.

## Deploy

```bash
cd <notifications repo>
wrangler deploy
# then migrations (first time)
wrangler d1 migrations apply address-notifications-db --remote
# and secrets (each new env)
for s in OPERATOR_SECRET API_KEY_PEPPER WEBHOOK_SIGNING_MASTER RPC_INTERNAL_SECRET; do
  read -s v; echo "$v" | wrangler secret put "$s"
done
```

rpc-racer auto-deploys from its GitHub `main`; its shared `INTERNAL_SECRET` is set
via that repo's `wrangler secret put INTERNAL_SECRET`.

## Operator API (auth: `Authorization: Bearer <OPERATOR_SECRET>`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/operator/metrics` | Chain status/lag, counters, alerts |
| GET | `/operator/chains` | Per-chain summary |
| GET | `/operator/chains/:chainId` | One chain incl. lag |
| POST | `/operator/chains/:id/scan` | Force an out-of-band scan |
| POST | `/operator/chains/:id/pause` | Pause scanning |
| POST | `/operator/chains/:id/resume` | Resume scanning |
| POST | `/operator/dlq/replay` | Re-enqueue dead-lettered webhooks |
| GET | `/operator/scanner-operations` | Pending scanner commands |
| POST | `/operator/reconcile` | Re-dispatch pending commands |
| POST | `/operator/accounts` | Create account |
| POST | `/operator/accounts/:id/api-keys` | Create API key |
| GET | `/operator/accounts/:id/api-keys` | List keys |
| DELETE | `/operator/accounts/:id/api-keys/:key` | Revoke |
| POST | `/operator/accounts/:id/suspended` / `reactivate` | Suspend/reactivate |

## Customer API (Bearer: account API key)

`/v1` webhooks (+ create returns signing secret once), `/v1/webhook-deliveries`
(30-day ledger), `/v1/subscriptions` (address + chainIds + webhookId), and
`/v1/chains[/:id]`. Subscriptions are `pending → active|unsupported` once the
scanner resolves/registers the chain.

## How the scanner reaches a chain

With `RPC_INTERNAL_SECRET` set, the scanner calls
`POST <RPC_RACER_BASE_URL>/internal/v1/:chain?fanoutCount=5` with
`x-internal-secret`; otherwise it falls back to the public `/v1/:chain`. rpc-racer
now falls back to **Alchemy** on rate-limit/CU-degraded upstreams, so unkeyed
public quotas don't stall scanning.

## Remaining steps (the not-yet-done pilot work)

1. **Subscribe more target chains** — create real subscriptions on Base (8453),
   Optimism (10), and Arbitrum (42161) (mainnet already live).
2. **Validate an `activity.observed` webhook end-to-end** — have a tracked
   address transact (or wait for activity) on a live chain, then confirm the
   signed delivery through `/v1/webhook-deliveries`.
3. **Enforce quotas for the pilot** — default 1,000 subscriptions / 20 chains;
   add operator overrides and account API rate limiting if required.
4. **Delivery-latency alerting** — `GET /operator/metrics` covers lag/dead-
   letters; a true observed→delivered p95 needs per-delivery timing or
   distributed tracing (add later).
5. **Optional hardening** — move off `workers_dev=true` to a custom domain/route;
   add auth/TLS rules; consider a bound-Worker test proving it never uses the
   public rpc-racer budget.
6. **Retention cleanup** — 30-day delivery rows / 7-day observations are
   documented but a cleanup (scheduled) job is not yet wired.

## Gotchas

- `src/rpc/client.ts` uses `process.env.RPC_DIRECT_URL` only in bun (fork tests);
  that code is inert in workerd. Do not reintroduce `process` without the guard.
- Local queue consumers don't run (miniflare doesn't loop produced messages to a
  `queue()` handler) — test the delivery path with `scripts/fork-test.mts` and
  the `/operator/inject` helper rather than `wrangler dev`.
- Wrangler must be ≥ `4.126.0` (fixes the local `_cf_ALARM` crash).