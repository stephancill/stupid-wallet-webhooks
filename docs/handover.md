# Handover — Stupid Wallet Webhooks

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
- URL: `https://wallet-webhooks.stupidtech.net`
- D1: `address-notifications-db` (`abb46259-a808-4350-bc3c-cbd8201f85ef`)
- Queues: `matched-activity`, `webhook-delivery`, `webhook-delivery-dlq`
- Durable Objects: `ScannerShard` x2
- Cron: reconcile every 5 min

### Secrets (set on the Worker; not in git)

| Secret                   | Purpose                                                             |
| ------------------------ | ------------------------------------------------------------------- |
| `OPERATOR_SECRET`        | Bearer for `/operator/*`                                            |
| `API_KEY_PEPPER`         | Peppers customer API-key hashes                                     |
| `WEBHOOK_SIGNING_MASTER` | Derives each webhook's signing secret                               |
| `RPC_INTERNAL_SECRET`    | Must equal rpc-racer `INTERNAL_SECRET` (scanner uses private route) |

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

| Method | Path                                              | Purpose                            |
| ------ | ------------------------------------------------- | ---------------------------------- |
| GET    | `/operator/metrics`                               | Chain status/lag, counters, alerts |
| GET    | `/operator/chains`                                | Per-chain summary                  |
| GET    | `/operator/chains/:chainId`                       | One chain incl. lag                |
| POST   | `/operator/chains/:id/scan`                       | Force an out-of-band scan          |
| POST   | `/operator/chains/:id/pause`                      | Pause scanning                     |
| POST   | `/operator/chains/:id/resume`                     | Resume scanning                    |
| POST   | `/operator/dlq/replay`                            | Re-enqueue dead-lettered webhooks  |
| GET    | `/operator/scanner-operations`                    | Pending scanner commands           |
| POST   | `/operator/reconcile`                             | Re-dispatch pending commands       |
| POST   | `/operator/accounts`                              | Create account                     |
| POST   | `/operator/accounts/:id/api-keys`                 | Create API key                     |
| GET    | `/operator/accounts/:id/api-keys`                 | List keys                          |
| DELETE | `/operator/accounts/:id/api-keys/:key`            | Revoke                             |
| POST   | `/operator/accounts/:id/suspended` / `reactivate` | Suspend/reactivate                 |

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

This is currently an external HTTP fetch through `evm.stupidtech.net`, not a
Cloudflare service binding. The existing bound-RPC test proves that configured
scanner traffic uses the private `/internal` route rather than the rate-limited
public route; it does not prove service-binding transport.

## Approved cost-reduction work

Approved on 2026-09-04 following a 48-hour Cloudflare usage review. Implement
all three workstreams below. They span this repository and the sibling
`rpc-racer` repository.

### Measured baseline

Window: 2026-09-02 12:22 UTC to 2026-09-04 12:22 UTC.

- `rpc-racer`: 2.172M Worker requests and 8.26M CPU-ms (more than 99% of
  account-wide Worker requests and CPU in the window).
- Scanner → rpc-racer: 1.803M requests (83% of rpc-racer traffic).
- Durable Objects: 3.067M requests, 29,805 GB-s, 7.011M SQL rows written.
- rpc-racer's `MetricsDurableObject`: 2.287M requests and 6.385M rows written;
  its per-request persistence is the main projected overage.
- `address-notifications` scanner: 774,846 alarm invocations. Arbitrum alone
  produced 876,343 internal RPC requests (49% of scanner RPC traffic).
- D1, Queues, KV, and R2 remain comfortably inside included usage.

At this rate, Workers-platform usage projects to roughly $88–89/month including
the $5 Workers Paid minimum. These are Analytics GraphQL estimates rather than
invoice data; Cloudflare may sample analytics datasets.

### 1. Replace per-request metrics DO persistence

In `rpc-racer`, move request telemetry out of Durable Object storage and into a
Workers Analytics Engine dataset (suggested name: `rpc_racer_metrics`).

- Capture caller (`public`/`internal`), chain, method, outcome/status, fallback,
  winning provider, latency, and a sample weight in one data point.
- Record failures and fallback responses at 100%; sample ordinary successes at
  10%. Queries must apply the sample weight when calculating totals.
- Use native Workers GraphQL analytics for authoritative aggregate
  request/error/CPU totals; use Analytics Engine for rpc-racer-specific
  dimensions.
- Keep provider-health and block-speed state operationally separate from
  telemetry. Provider health may remain in a DO, but updates must be
  coalesced/rate-limited and must not write counters or latency arrays for every
  request.
- Preserve the documented `/stats` contract with a bounded rolling summary, or
  explicitly document and approve a breaking change before altering it.
- Remove the current ineffective caller labelling: `caller` is passed into the
  metrics record but is not persisted or returned today.

Acceptance:

- Normal rpc-racer requests no longer cause per-request DO storage writes.
- Cloudflare analytics can split traffic by caller, chain, method, outcome, and
  fallback usage.
- Provider cooldown/recovery behavior and `/stats` compatibility have tests.
- After 24 hours, rpc-racer metrics-DO writes are at least 95% below this
  baseline without losing error/fallback visibility.

Workers Analytics Engine is currently unbilled. Its announced Workers Paid
allowance is 10M writes/month, then $0.25/M; 10% success sampling should remain
inside the allowance at this traffic level.

### 2. Use a real rpc-racer service binding

Replace the scanner's external custom-domain fetch with a Cloudflare service
binding to the `rpc-racer` Worker.

- Add an `RPC_RACER` service binding in this repository's `wrangler.toml` and
  corresponding `Fetcher` environment type.
- Pass the binding through the scanner RPC client and call the private
  `/internal/v1/:chain` route through `RPC_RACER.fetch()`.
- Retain `RPC_INTERNAL_SECRET` as defense in depth unless the rpc-racer private
  route is redesigned to be service-binding-only.
- Keep the external base URL only for local/fork tooling where no service
  binding is available; production must fail loudly rather than silently fall
  back to billable public HTTP.
- Replace/extend `test/rpc-bound.test.ts` so it verifies the binding is used and
  that no production scanner request reaches `evm.stupidtech.net` externally.

Acceptance:

- Production scanner RPC traffic appears as service-bound traffic and does not
  incur an additional Worker request charge.
- Missing production binding configuration fails visibly.
- Public rpc-racer clients and rate limits are unchanged.

At the measured rate this should remove approximately 1.8M externally routed
requests per 48 hours and bring projected billable Worker requests below the
account's 10M/month allowance.

### 3. Poll less and fetch bounded block ranges

Reduce both ScannerShard alarm churn and rpc-racer invocations while preserving
ordered processing and reorg safety.

- Separate caught-up polling from backlog catch-up. Initial targets:
  - caught-up interval: approximately one `blockSpeedMs`, with a 2s minimum;
  - backlog interval: retain the current 500ms fast retry/catch-up cadence.
- Introduce separate environment knobs rather than reusing
  `SCANNER_MIN_POLL_INTERVAL_MS` for both behaviors.
- Fetch several consecutive blocks and their Transfer logs in one rpc-racer
  JSON-RPC batch after reading the head. Use a bounded, configurable range
  (initial target: at most 10 blocks/request).
- Validate each block/log pair, process blocks sequentially, and stop at the
  first parent/hash mismatch. Ignore later prefetched results after a reorg.
- Keep matched transaction receipts batched. Add bounded fallback behavior for
  upstreams that reject a large batch; do not silently skip blocks.
- Cache stable per-chain control data inside the DO where safe, while retaining
  D1 as canonical and reconciliation as the recovery path.

Acceptance:

- Scanner RPC requests fall by at least 50% versus the 1.803M/48h baseline.
- Scanner alarm invocations fall by at least 40% versus the 774,846/48h
  baseline.
- No historical backfill, ordering, activation-boundary, matching, or reorg
  semantics change.
- Per-chain lag remains within the pilot objective: p95 delivery within
  `max(10 seconds, 2 block intervals)` and no chain remains more than 10 seconds
  behind for five minutes.
- Compare 24 hours of post-deploy Workers, DO, D1, queue, and delivery-latency
  metrics against this baseline before further cadence/fanout tuning.

### Implementation order

1. Add Analytics Engine telemetry and decouple provider health from metrics
   persistence in rpc-racer.
2. Add the service binding and production binding-only scanner path.
3. Add separate scanner cadences and bounded multi-block batches.
4. Deploy each repository through its existing main-branch pipeline; do not
   deploy manually.
5. Re-run the 48-hour cost analysis after all changes are live.

## Remaining steps (pilot work)

Status as of this pass (most items done — see `docs/implementation-notes.md`):

1. **Subscribe more target chains** — ✅ Base (8453), Optimism (10), Arbitrum (42161)
   subscribed and `active` (mainnet already live).
2. **Validate an `activity.observed` webhook end-to-end** — ✅ funded test wallet
   on Base, transacted from it via `cast`, confirmed the signed delivery through
   `/v1/webhook-deliveries`, and verified the HMAC-SHA256 signature cryptographically
   (delivered via a local receiver + `cloudflared` quick tunnel).
3. **Enforce quotas for the pilot** — ✅ verified live: default 1,000/20 plus
   operator overrides for both subscription and chain quotas both enforced.
4. **Delivery-latency alerting** — ✅ `deliveryLatency` (p50/95/99) with an
   **`observeToAttempt` / `attemptToDelivered` segment split** is in
   `/operator/metrics` (p95 alert per `DELIVERY_LATENCY_ALERT_MS`). After
   in-design tuning the observed p95 is acceptably **~10s**; the residual
   observe→attempt cost is the two-queue consumer wake cadence (a single-hop
   fast path remains documented if a future tier needs reliably sub-10s).
5. **Optional hardening** — ✅ custom domain `https://wallet-webhooks.stupidtech.net`
   (workers.dev disabled) and ✅ a private-route test proving configured scanner
   traffic never uses the public rpc-racer budget. A real service binding is now
   approved cost-reduction work above; optional edge auth/TLS remains a nicety.
6. **Retention cleanup** — ✅ scheduled job now deletes 30-day delivery rows and
   7-day observations (wired in the 5-min cron).

## Gotchas

- `src/rpc/client.ts` uses `process.env.RPC_DIRECT_URL` only in bun (fork tests);
  that code is inert in workerd. Do not reintroduce `process` without the guard.
- Local queue consumers don't run (miniflare doesn't loop produced messages to a
  `queue()` handler) — test the delivery path with `scripts/fork-test.mts` and
  the `/operator/inject` helper rather than `wrangler dev`.
- Wrangler must be ≥ `4.126.0` (fixes the local `_cf_ALARM` crash).
