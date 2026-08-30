# Stupid Wallet Webhooks — API Reference

Customer-facing API for receiving webhooks when an EVM address transacts or
moves native value / ERC-20 / ERC-721.

- Base URL: `https://wallet-webhooks.stupidtech.net`
- Auth: every `/v1` request requires `Authorization: Bearer <API_KEY>`
- Errors: JSON `{ "error": "<message>" }` with a descriptive HTTP status.

API keys are issued by an operator (see `skills/operator`); the raw key is shown
only once at issuance — only its hash is stored.

## Conventions

- Ethereum addresses are returned checksummed; identity is case-insensitive.
- Block numbers and `uint256` values are JSON strings.
- Requests without a valid key → `401`; a suspended account → `403`.

---

## Webhooks

### Create a webhook

```http
POST /v1/webhooks
{
  "url": "https://you.example/hook"
}
```

```json
201
{
  "id": "wh_…",
  "url": "https://you.example/hook",
  "status": "active",
  "createdAt": "2026-08-30T00:00:00.000Z",
  "signingSecret": "e5fb…"   // returned ONLY once; never shown again
}
```

The endpoint must be public HTTPS. Loopback, private, link-local, multicast and
Cloudflare-metadata destinations are rejected (`400`). Save `signingSecret` — it is
used to verify deliveries.

### List webhooks

```http
GET /v1/webhooks
```
→ `{ "webhooks": [ { id, url, status, createdAt, lastTestAt } ] }`

### Get a webhook

```http
GET /v1/webhooks/:webhookId
```

### Send a test delivery

```http
POST /v1/webhooks/:webhookId/test
```
→ `{ deliveryId, eventId, delivered, httpStatus, retryable, error }` — a signed
`webhook.test` ping to the endpoint, recorded on the delivery ledger.

### Delete a webhook

```http
DELETE /v1/webhooks/:webhookId
```
→ `{ id, deleted: true }`. Also **deactivates every active subscription** on it.

---

## Subscriptions

A subscription is an `(account, webhook, address, chainId)` tuple.

### Create subscriptions (multi-chain)

```http
POST /v1/subscriptions
{
  "address": "0x9f8f72aa9304c8b593d555f12e115b9d8452c8b9",
  "chainIds": [8453, 10, 42161],
  "webhookId": "wh_…"
}
```

The response returns **one entry per chain** because activation differs:

```json
201
{
  "subscriptions": [
    { "id": "sub_…", "address": "0x9f8…", "chainId": 8453, "status": "active",
      "activeFromBlock": "50655017", "reason": null, "createdAt": "2026-08-30T00:00:00Z" },
    { "chainId": 999999, "status": "unsupported", "message": "unknown chain" },
    { "chainId": 10, "status": "quota", "message": "distinct chain quota exceeded" }
  ]
}
```

Per-chain failures carry `status` one of: `quota`, `conflict` (tuple already
active), `unsupported`, or `error`. Each created subscription starts `pending`
and becomes `active` (with `activeFromBlock = head + 1`) or `unsupported` once
the scanner resolves/registers the chain.

Other:
- `GET /v1/subscriptions` (optional `?webhookId=`)
- `GET /v1/subscriptions/:subscriptionId`
- `DELETE /v1/subscriptions/:subscriptionId` → deactivates (`deleting`)

### Quotas

Defaults per account: **1,000 active subscriptions** and **20 distinct chains**
(operator can override per account). Exceeding either returns a per-chain
`quota` failure without over-creating.

### Activation semantics

No historical backfill. Activity is only delivered for blocks
`>= activeFromBlock` (enforced even if scanning started earlier).

---

## Chains

```http
GET /v1/chains
GET /v1/chains/:chainId
POST /v1/chains/:chainId/retry
```

- `GET /v1/chains` → `{ chains: [ { chainId, name, status, reason, cursorBlock } ] }`
- `GET /v1/chains/:chainId` →
  `{ chainId, name, shortName, isTestnet, blockSpeedMs, status, reason, cursorBlock }`
  (`404` unknown chain, `502` transient resolution failure).
- `POST /v1/chains/:chainId/retry` — re-probe an **unsupported** chain. Authorized
  only when you hold an unsupported subscription on that chain (`403` otherwise)
  and rate-limited to one pending retry per chain (`429`).

---

## Delivery ledger (30 days)

```http
GET /v1/webhook-deliveries
GET /v1/webhook-deliveries/:deliveryId
```

Filters / params: `webhookId`, `eventId`, `status`
(`pending | success | failed | dead_lettered`), `cursor`, `limit` (max 100).

```json
{ "deliveries": [ {
    "id": "del_…", "webhookId": "wh_…", "eventId": "evt_…",
    "eventType": "activity.observed", "chainId": 8453,
    "status": "success", "attempts": 1,
    "lastResponseStatus": 200, "nextRetryAt": null, "lastError": null,
    "createdAt": "…", "updatedAt": "…"
} ] }
```

`nextCursor` is returned when more pages exist. Secrets and response bodies are
never exposed; rows are pruned after 30 days.

---

## Verification & delivery behaviour

Each delivery is a signed `POST` with headers:

```text
webhook-id:        evt_…
webhook-timestamp: 1788400000
webhook-signature: v1,<hex>
```

The signature is HMAC-SHA256 over the exact body, keyed with the webhook's
`signingSecret`:

```text
HMAC(secret, `${timestamp}.${body}`)   → hex, compared to the `v1,` payload
```

Honour a **±5 minute** replay tolerance on `webhook-timestamp`.

Delivery is **at-least-once** with deterministic `webhook-id`s — dedupe on
`webhook-id`. Failures retry with exponential backoff (~24h) then move to a
dead-letter queue (surfaced as `dead_lettered`; an operator can replay it).

Payload `data` carries raw on-chain values (uint256 as strings) — no token
metadata, decimals, or prices.