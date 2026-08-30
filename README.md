# EVM Address Notifications

Multi-tenant service that lets customers subscribe to EVM addresses and receive
signed webhooks for top-level transactions, native value, ERC-20, and ERC-721
activity. See `docs/implementation-plan.md` for the full product spec and
`docs/implementation-notes.md` for build notes.

> Milestone status: **Milestone 1 (API + persistence)** implemented. Scanner
> (M2), fanout/webhook delivery (M3), reorgs (M4), and the production pilot (M5)
> remain.

## Stack

Cloudflare Workers · Hono · D1 · Durable Objects · Queues (later) · Zod · viem ·
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

Operator endpoints live under `/operator` with `Authorization: Bearer <operator-secret>`.

## Queues (M3)

- `matched-activity`: produced by the scanner (one message per
  transaction-address bundle); consumed by the fan-out.
- `webhook-delivery`: one message per (observation, destination); consumer signs
  an deterministic `HMAC-SHA256` body, sends with a strict timeout/redirects
  disabled, classifies retries, dedupes by `(webhookId, eventId, eventType)`,
  and moves exhausted deliveries to `webhook-delivery-dlq`.

## Checks

```bash
bun run check    # lint + format
bun test         # unit tests
bunx tsc --noEmit
```
