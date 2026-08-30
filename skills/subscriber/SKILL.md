---
name: subscriber
description: >-
  Help a customer of Stupid Wallet Webhooks set up and use the public API: create
  a webhook endpoint, subscribe an EVM address on one or more chains, list/delete
  subscriptions, inspect the 30-day delivery ledger, and verify an inbound webhook
  HMAC-SHA256 signature. Use when the user wants to receive signed webhooks for
  address/chain activity, configure an endpoint, check delivery receipts, or
  validate a webhook payload. The operator-side provisioning is in the `operator`
  skill.
---

# Subscriber — Stupid Wallet Webhooks

Base URL: `https://wallet-webhooks.stupidtech.net`

Authenticate every `/v1` request with `Authorization: Bearer <API_KEY>`. API keys
are provisioned by an operator and shown only once; only a hash is stored.

## 1. Create a webhook

```bash
curl -s -X POST -H "Authorization: Bearer $API_KEY" -H "content-type: application/json" \
  -d '{"url":"https://your-endpoint.example/hook"}' $BASE/v1/webhooks
```

Returns the `id` and — **only on creation** — the `signingSecret`. The URL must be
public HTTPS (loopback/private/metadata destinations are rejected).

## 2. Subscribe an address across chains

```bash
curl -s -X POST -H "Authorization: Bearer $API_KEY" -H "content-type: application/json" \
  -d '{"address":"0x9f8f72aa9304c8b593d555f12e115b9d8452c8b9","chainIds":[8453,10,42161],"webhookId":"wh_..."}' \
  $BASE/v1/subscriptions
```

The response returns one entry per chain; each is `pending` → `active | unsupported`
once the scanner resolves/registers the chain, and gets an `activeFromBlock`.
Duplicate (`accountId, webhookId, address, chainId`) tuples return `conflict`; a
deleted (`deleting`) subscription can be re-created.

- List: `GET /v1/subscriptions`
- Get: `GET /v1/subscriptions/:id`
- Deactivate: `DELETE /v1/subscriptions/:id`
- Chains: `GET /v1/chains` / `GET /v1/chains/:chainId`

Defaults: up to 1,000 active subscriptions and 20 distinct chains per account
(operator can set overrides). No historical backfill — activity starts at
`activeFromBlock`.

## 3. Check the delivery ledger (30 days)

```bash
curl -s -H "Authorization: Bearer $API_KEY" "$BASE/v1/webhook-deliveries?status=success"
```

Filters: `webhookId`, `eventId`, `status` (`pending|success|failed|dead_lettered`),
`cursor`, `limit`. Each row exposes `attempts`, `lastResponseStatus`, `lastError`,
`nextRetryAt` — never secret material.

## 4. Verify an inbound webhook

Each delivery is a signed POST with headers:

- `webhook-id` (the event id)
- `webhook-timestamp` (unix seconds)
- `webhook-signature` = `v1,<hex>`

The signature is HMAC-SHA256 over the **exact request body**: `HMAC(${timestamp}.${body})`,
keyed with the webhook's `signingSecret` (derived from the master secret; you
received it at webhook creation). Example (Bun/WebCrypto):

```ts
const secret = "e5fb...";      // signingSecret from webhook creation
const timestamp = headers["webhook-timestamp"];
const expected = await crypto.subtle
  .importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  .then((k) => crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`${timestamp}.${body}`)))
  .then((sig) => [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join(""));
const valid = headers["webhook-signature"] === `v1,${expected}`; // honor ±5min on timestamp
```

## Gotchas

- Delivery is at-least-once with deterministic `eventId`s — dedupe on `webhook-id`.
- Retries use exponential backoff (~24h) then a dead-letter queue; exhausted
  deliveries surface as `dead_lettered` on the ledger (operator can replay).
- Payload `data` contains raw on-chain values (uint256 as strings); no token
  metadata/decimals/prices.