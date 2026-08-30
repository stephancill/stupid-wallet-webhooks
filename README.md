# Stupid Wallet Webhooks

Multi-tenant service that lets customers subscribe to EVM addresses and receive
signed webhooks for top-level transactions, native value, ERC-20, and ERC-721
activity.

## Stack

Cloudflare Workers · Hono · D1 · Durable Objects · Queues · Zod · viem ·
(stupid tech) template.

## Dev setup

```bash
bun install
cp .dev.vars.example .dev.vars   # edit secrets
bun run db:migrate:local          # apply migrations
bun run dev                       # wrangler dev --local on :8787
```

## Operator CLI

```bash
export OPERATOR_SECRET=... OPERATOR_BASE_URL=http://localhost:8787
bun scripts/operator.mts add Acme
bun scripts/operator.mts create-api-key <accountId>   # returns the key once
bun scripts/operator.mts revoke <accountId> <keyId>
bun scripts/operator.mts suspend <accountId>
bun scripts/operator.mts reactivate <accountId>
bun scripts/operator.mts reconcile
bun scripts/operator.mts ops
```

## Public API (auth: `Authorization: Bearer <api-key>`)

| Method | Path                         | Purpose                                                   |
| ------ | ---------------------------- | --------------------------------------------------------- |
| POST   | `/v1/webhooks`               | Create webhook (returns signing secret once)              |
| GET    | `/v1/webhooks`               | List webhooks                                             |
| GET    | `/v1/webhooks/:id`           | Get a webhook                                             |
| POST   | `/v1/webhooks/:id/test`      | Signed test delivery                                      |
| DELETE | `/v1/webhooks/:id`           | Delete a webhook (deactivates its subscriptions)          |
| GET    | `/v1/webhook-deliveries`     | 30-day delivery history (paginated)                       |
| GET    | `/v1/webhook-deliveries/:id` | One delivery                                              |
| GET    | `/v1/subscriptions`          | List subscriptions                                        |
| POST   | `/v1/subscriptions`          | Create subscriptions (`address`, `chainIds`, `webhookId`) |
| GET    | `/v1/subscriptions/:id`      | Get a subscription                                        |
| DELETE | `/v1/subscriptions/:id`      | Deactivate a subscription                                 |
| GET    | `/v1/chains`                 | List known chains + product status                        |
| GET    | `/v1/chains/:id`             | Chain metadata + product status                           |
| POST   | `/v1/chains/:id/retry`       | Manual capability retry (needs an unsupported sub)        |

Operator endpoints live under `/operator` with `Authorization: Bearer <operator-secret>`:

```
GET  /operator/metrics           # chain lag, counters, and alerts
POST /operator/dlq/replay          # re-enqueue dead-lettered webhook deliveries
GET  /operator/chains              # per-chain status/cursor summary
GET  /operator/chains/:chainId      # one chain incl. lag
POST /operator/chains/:id/pause|/resume
GET  /operator/scanner-operations  # pending scanner commands
```

## Queues

- `matched-activity`: produced by the scanner (one message per
  transaction-address bundle); consumed by the fan-out.
- `webhook-delivery`: one message per (observation, destination); consumer signs
  an deterministic `HMAC-SHA256` body, sends with a strict timeout/redirects
  disabled, classifies retries, dedupes by `(webhookId, eventId, eventType)`,
  and moves exhausted deliveries to `webhook-delivery-dlq`.

## Skills

Agent skills for working in this repo live under `skills/`:

- `skills/operator` — operating the live service (metrics/lag, provisioning,
  pause/resume, DLQ replay, deploy/migrations, secrets).
- `skills/subscriber` — using the public customer API (webhooks, subscriptions,
  delivery ledger, signature verification).

## Checks

```bash
bun run check    # lint + format
bun test         # unit tests
bunx tsc --noEmit

# Real-chain integration: Anvil fork of a target chain + funded test accounts.
# Requires `cast`/`anvil` (foundry) and optionally ALCHEMY_API_KEY to fork from
# Alchemy (defaults to `evm.stupidtech.net` Base otherwise).
bun run fork-test
#   FORK_RPC_URL=... ANVIL_CHAIN_ID=8453 ANVIL_BLOCK_TIME=2 bun run fork-test
```

The `fork-test` sparns an Anvil fork of a target chain, sends a signed value
transfer from a tracked (prefunded) test account, and asserts the matcher turns
that real transaction into an `activity.observed` observation.
