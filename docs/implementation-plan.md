# Stupid Wallet Notifications

## Product Definition

Build a standalone, multi-tenant service that lets customers subscribe to EVM addresses and receive signed webhooks when those addresses submit top-level transactions or send or receive native assets, ERC-20 tokens, or ERC-721 tokens.

The service uses Stupid Tech RPC as its only blockchain access layer:

- Chain discovery and metadata: `GET https://evm.stupidtech.net/v1/chains/:chainId`
- JSON-RPC access: the `rpc-racer` Cloudflare Worker through a private service binding
- Public product API: a separate Cloudflare Worker backed by D1, Durable Objects, and Queues

The service is an activity notifier, not a general-purpose indexer. It retains only subscription state, recent reorg state, webhook delivery state, and short-lived operational data.

## MVP Decisions

| Area                    | Decision                                                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Product model           | Standalone multi-tenant API                                                                                                             |
| Authentication          | Account API keys provisioned by an operator                                                                                             |
| Delivery                | Signed HTTPS webhooks                                                                                                                   |
| Networks                | Any chain resolved by Stupid Tech RPC that passes capability checks                                                                     |
| Activity timing         | Emit `observed` events at the chain head                                                                                                |
| Reorg behavior          | Emit `reverted` events for previously observed activity that becomes orphaned                                                           |
| Top-level transactions  | Every mined transaction whose `from` address is tracked, including zero-value and reverted transactions                                 |
| Notification unit       | One transaction bundle per `(chainId, transactionHash, trackedAddress)`                                                                 |
| Native activity         | Successful incoming top-level value transfers; outgoing value is represented by the bundle's transaction value                          |
| Token activity          | Standard ERC-20 and ERC-721 `Transfer` effects bundled by transaction and tracked address                                               |
| Default quotas          | 1,000 active subscriptions and 20 distinct chains per account, with operator overrides                                                  |
| Webhook mapping         | Every subscription targets exactly one webhook endpoint                                                                                 |
| Delivery history        | Expose all webhook delivery outcomes for 30 days                                                                                        |
| Contract creation value | Do not emit an incoming native effect for the created contract in the MVP                                                               |
| Unsupported chains      | Retain unsupported subscriptions and retry capability checks only on explicit manual request                                            |
| Pilot objective         | p95 delivery within `max(10 seconds, 2 block intervals)` of first block observation; alert when more than 2 blocks behind for 5 minutes |
| History                 | No historical backfill; subscriptions begin at an explicit activation block                                                             |
| Internal transfers      | Out of scope                                                                                                                            |
| ERC-1155                | Out of scope for MVP                                                                                                                    |
| Token metadata          | Out of scope for MVP; webhook payloads contain raw on-chain values                                                                      |

"Any chain" is best-effort, not an assertion that every Chainlist entry works. A chain is usable only when Stupid Tech RPC resolves it and its upstreams successfully support the required RPC behavior.

## Success Criteria

The MVP is complete when it can:

1. Provision an account, API key, and webhook endpoint.
2. Create and remove address subscriptions on arbitrary usable EVM chains.
3. Start scanning when a chain gains its first tracked address and stop when it loses its last one.
4. Detect every mined top-level transaction from a tracked address, successful incoming native transfers, and standard ERC-20/ERC-721 transfers.
5. Deliver one signed, idempotent webhook per matching transaction and tracked address without coupling block ingestion to subscriber fanout.
6. Recover after Worker restarts, RPC failures, duplicate queue delivery, and delayed alarms.
7. Detect shallow reorgs and send compensating `reverted` webhooks.
8. Report per-chain lag, RPC failures, matched activity, and webhook delivery health.

## System Architecture

```text
API client
    |
    v
Stupid Wallet Notifications Worker
    |-- D1: accounts, API keys, webhooks, subscriptions, delivery ledger
    |-- Scanner shard Durable Objects: active chains, tracked sets, cursors
    |
    v
Stupid Tech RPC service binding
    |-- chain registry and block-speed metadata
    |-- races public EVM RPC upstreams
    |-- Alchemy fallback where supported
    |
    v
Matched Transaction Bundle Queue
    |
    v
Fanout Consumer -- D1 subscriber lookup --> Webhook Delivery Queue
                                               |
                                               v
                                      Webhook Delivery Consumer
```

Use two queues rather than one:

- `matched-activity` carries one transaction bundle per `(chainId, transactionHash, trackedAddress)`.
- `webhook-delivery` carries one message per webhook destination and supports independent retries and a dead-letter queue.

This keeps blockchain ingestion independent from both subscriber fanout and slow customer endpoints.

## Stupid Tech RPC Integration

### Required `rpc-racer` Changes

The public endpoint is currently limited to 60 requests per minute per source IP. The scanner must not use that public access path directly.

Add a private integration to `rpc-racer` with these properties:

1. Bind the notifications Worker directly to the `rpc-racer` Worker using a Cloudflare service binding.
2. Authenticate internal requests with a shared Cloudflare secret before bypassing public rate limiting.
3. Keep the existing public API and its rate limits unchanged.
4. Record internal calls in RPC metrics with a distinct caller label.
5. Support an internal consistency-safe block read:
   - Fetch the full block first.
   - Query logs by the returned `blockHash`, not only by height.
   - Reject logs whose `blockHash` differs from the fetched block.
   - Return the winning upstream and latency for diagnostics.
6. Allow a lower race fanout for scanner traffic. Five upstream requests for every head, block, and log request would make continuous scanning unnecessarily expensive.

The smallest safe interface is still JSON-RPC over the service binding. The scanner calls:

```text
eth_blockNumber
eth_getBlockByNumber(height, true)
eth_getLogs({ blockHash, topics: [TRANSFER_TOPIC] })
eth_getTransactionReceipt(txHash) when a tracked sender or possible incoming native match exists
```

`eth_getLogs` must use the exact block hash from `eth_getBlockByNumber`. This prevents a lagging or forked upstream from returning a successful but incomplete empty log result for a just-produced height.

### Chain Activation Probe

When a chain receives its first subscription:

1. Resolve `GET /v1/chains/:chainId` through the service binding.
2. Reject unknown chains.
3. Read `blockSpeedMs`; use a conservative default if it is absent.
4. Probe `eth_chainId` and require it to match the requested chain ID.
5. Probe the latest full block.
6. Probe an exact-block-hash `eth_getLogs` query for the transfer topic.
7. Mark the chain `active`, `degraded`, or `unsupported` with the observed reason.

A temporary probe failure leaves the subscription pending and follows the bounded transient retry policy. A deterministic capability failure marks the chain and affected subscriptions unsupported and exposes the reason through the API. Unsupported chains are not probed periodically; recovery requires an explicit manual retry.

### RPC Request Policy

- Head checks use race fanout 1 by default and retry through another upstream on failure.
- Full blocks and logs use race fanout 2 by default.
- Requests have bounded timeouts and exponential backoff with jitter.
- HTTP 429 and 5xx responses are retryable.
- Invalid JSON-RPC data, a chain-ID mismatch, a block-hash mismatch, or malformed block data fail loudly and do not advance the cursor.
- The scanner records logical gateway requests separately from upstream attempts.

## Public API

All customer endpoints are versioned under `/v1` and require `Authorization: Bearer <api-key>`. Store only a keyed hash of each API key in D1. API keys are scoped to one account.

### Accounts and API Keys

Account and initial API-key creation are operator-only for the MVP. Self-service signup, billing, and a dashboard are deferred.

Required operator operations:

```text
create account
create/revoke API key
suspend/reactivate account
```

### Webhooks

```text
POST   /v1/webhooks
GET    /v1/webhooks
DELETE /v1/webhooks/:webhookId
POST   /v1/webhooks/:webhookId/test
GET    /v1/webhook-deliveries
GET    /v1/webhook-deliveries/:deliveryId
```

Creation accepts an HTTPS URL and returns the signing secret once. Reject loopback, private, link-local, and Cloudflare metadata destinations to prevent SSRF.

Delivery-history endpoints expose observed and reverted webhook outcomes for 30 days. Support cursor pagination and filters for webhook ID, event ID, delivery status, and creation time. Return attempt count, last response status, next retry time, and terminal failure reason, but never return signing secrets or arbitrary response bodies.

### Subscriptions

```text
POST   /v1/subscriptions
GET    /v1/subscriptions
GET    /v1/subscriptions/:subscriptionId
DELETE /v1/subscriptions/:subscriptionId
```

Create request:

```json
{
  "address": "0x0000000000000000000000000000000000000000",
  "chainIds": [1, 8453],
  "webhookId": "wh_..."
}
```

Each normalized per-chain subscription targets exactly one `webhookId`. To send the same address activity to another endpoint, create another subscription for that webhook. The unique active-subscription key is `(accountId, webhookId, address, chainId)`.

Default account limits are:

```text
active subscriptions: 1,000
distinct subscribed chains: 20
```

Both limits are operator-configurable per account. A multi-chain create request is evaluated per chain and returns explicit quota failures without creating entries beyond the limit.

Create response records one result per chain because activation can differ:

```json
{
  "subscriptions": [
    {
      "id": "sub_...",
      "address": "0x0000000000000000000000000000000000000000",
      "chainId": 8453,
      "status": "active",
      "activeFromBlock": "34900123"
    }
  ]
}
```

Use string values for block numbers and uint256 values in JSON.

Subscription status is one of:

```text
pending | active | unsupported | deleting
```

Address normalization requirements:

- Validate with `viem`.
- Store the canonical 20-byte value as a D1 `BLOB`.
- Return a checksummed address in API responses.
- Treat address identity as case-insensitive.

### Chains

```text
GET /v1/chains/:chainId
POST /v1/chains/:chainId/retry
```

Return Stupid Tech RPC metadata plus product-specific status, last probe result, current scanner cursor, and lag when the chain is active.

An authenticated account may request a manual capability retry only when it has an unsupported subscription for that chain. Operators may also retry it. Rate-limit retries to one per chain per hour so this endpoint cannot be used as an RPC amplification path. Unsupported subscriptions are retained but are not retried on a schedule.

## Activity Model

### Canonical Payload

```ts
type ActivityWebhook = {
  id: string;
  type: "activity.observed" | "activity.reverted";
  createdAt: string;
  data: {
    chainId: number;
    trackedAddress: `0x${string}`;
    initiatedByTrackedAddress: boolean;
    blockNumber: string;
    blockHash: `0x${string}`;
    blockTimestamp: string;
    transaction: {
      hash: `0x${string}`;
      index: number;
      from: `0x${string}`;
      to?: `0x${string}`;
      status: "success" | "reverted";
      nonce: string;
      value: string;
      createdContractAddress?: `0x${string}`;
    };
    effects: Array<
      | {
          id: string;
          kind: "native";
          direction: "incoming";
          from: `0x${string}`;
          to: `0x${string}`;
          amount: string;
        }
      | {
          id: string;
          kind: "erc20";
          direction: "incoming" | "outgoing" | "self";
          logIndex: number;
          from: `0x${string}`;
          to: `0x${string}`;
          assetAddress: `0x${string}`;
          amount: string;
        }
      | {
          id: string;
          kind: "erc721";
          direction: "incoming" | "outgoing" | "self";
          logIndex: number;
          from: `0x${string}`;
          to: `0x${string}`;
          assetAddress: `0x${string}`;
          tokenId: string;
        }
    >;
  };
};
```

`transaction.value` is the raw transaction value in wei, including when the transaction reverted and no value was transferred. `transaction.to` is absent for contract creation. A successful contract creation may include `createdContractAddress` from its receipt. Native effect amounts are raw wei values, ERC-20 effect amounts are raw token-unit values, and ERC-721 effects contain the token ID.

Do not fetch token names, symbols, decimals, prices, or images in the ingestion path.

### Matching and Bundling

Build candidate bundles in memory using `(transactionHash, trackedAddress)` as the key:

- Create a bundle for every mined top-level transaction whose normalized `from` address is tracked, whether it is successful or reverted and whether its value is zero or nonzero.
- Add an incoming native effect when `value > 0`, `to` is tracked, and the receipt status is successful.
- Decode a standard ERC-20 effect from a Transfer log with three topics and one 32-byte data word.
- Decode a standard ERC-721 effect from a Transfer log with four topics and the token ID in topic 3.
- Add each decoded token effect to the bundle for every tracked sender or recipient represented by that log.
- If one tracked address is both sender and recipient in a token log, add one effect with `direction: "self"`.
- Ignore and count malformed and non-standard lookalike logs.

One bundle can therefore contain zero, one, or many effects. A tracked sender transaction with no relevant transfer logs still produces a bundle. A reverted tracked sender transaction produces a bundle with `status: "reverted"` and no effects.

Do not add an outgoing native effect when the tracked address initiated the transaction; `transaction.value` already represents it. When tracked address A sends value to separately tracked address B, A receives one sender bundle with the value on the transaction and B receives one recipient bundle with an incoming native effect. If a tracked address sends value to itself, it receives one sender bundle with no native effect.

Contract-creation transactions have no top-level `to` address. The sender bundle is supported, including `transaction.value` and a successful receipt's `createdContractAddress`, but the MVP does not emit an incoming native effect for a subscription to the newly created contract.

Token effects remain explicit entries because one contract call can cause multiple semantically distinct transfers. Only effects involving the tracked address are included; unrelated router, pool, or intermediary logs are discarded.

Order effects deterministically: the incoming native effect first when present, followed by token effects in ascending `logIndex`. This keeps retries byte-stable and makes webhook signatures and fixtures reproducible.

Every candidate bundle must be joined with its transaction receipt. The receipt supplies status and prevents a false incoming native effect when a transaction with nonzero value reverted. The receipt's `blockHash` must equal the block being processed.

If one customer tracks two addresses involved in the same transaction, the service emits one bundle per tracked address. This keeps subscription fanout and direction semantics deterministic. Account-level cross-address aggregation is out of scope for the MVP.

### IDs and Idempotency

Use three identifier levels:

- Logical bundle key: chain ID, transaction hash, and tracked address.
- Observation ID: logical bundle key plus block hash.
- Effect ID: observation ID plus `native` or token log index.

The observation ID is the webhook event ID and delivery deduplication key. Including the block hash lets the service identify and revert an orphaned observation if the same transaction later appears in another block.

## Scanner Design

### Sharding

Start with two scanner shard Durable Objects. Store an explicit `shard_id` for each active chain; do not derive permanent ownership only from `hash(chainId) % shardCount`, because changing the shard count would silently move chains without migrating their cursors.

Each shard owns multiple chains and schedules one alarm for its earliest due chain. Limit concurrent outbound RPC work to six connections per Durable Object invocation.

Persist in each shard's SQLite storage:

- chain assignment and status;
- next poll time and current poll interval;
- last fully processed height and hash;
- recent block hash and parent-hash window;
- tracked addresses for each chain;
- recent matched observation IDs needed for reorg compensation.

D1 remains the canonical control-plane store. Durable Object storage is the scanner's operational state and is reconciled against D1 periodically.

### Activation Semantics

No historical activity is delivered by default.

Each subscription receives an `active_from_block`. Scanner registration and D1 state changes must be idempotent. If activation races with scanner progress, rewind only as far as the earliest newly activated block and rely on observation IDs to suppress duplicate delivery to existing subscriptions.

When the first tracked address is activated on a chain:

1. Run the chain capability probe.
2. Assign the chain to a scanner shard.
3. Read the current head.
4. Set the initial cursor to that head.
5. Set the subscription's `active_from_block` to `head + 1`.
6. Start polling.

When an additional subscription is added, its own `active_from_block` prevents old catch-up activity from being delivered to it.

When the last tracked address is removed, stop polling and retain the final cursor only for a short operational retention period.

### Polling

Initial interval:

```text
clamp(blockSpeedMs / 2, 1 second, 5 seconds)
```

Use a one-second minimum initially because Durable Object alarms are not intended as a sub-second scheduler. A future low-latency mode should use a different scheduling mechanism rather than assuming 500 ms alarms are reliable.

For every due chain:

1. Call `eth_blockNumber`.
2. If the head has not advanced, schedule the next poll.
3. Process each missing height sequentially for that chain.
4. Fetch the full block.
5. Fetch Transfer logs using that block's hash.
6. Find tracked sender transactions and decode relevant token effects locally.
7. Create candidate bundles keyed by transaction hash and tracked address.
8. Add candidate incoming native effects.
9. Fetch and verify one receipt for each unique candidate transaction hash.
10. Remove native effects from reverted transactions and finalize transaction status.
11. Enqueue one matched observation per finalized transaction-address bundle.
12. Persist the block hash and advance the cursor only after every required operation succeeds.

Different chains can run concurrently. Blocks within one chain remain ordered to simplify cursor and reorg handling.

Cap the number of blocks processed per alarm invocation. If a chain remains behind, persist progress and schedule immediate continuation so one recovering chain cannot monopolize a shard.

### Reorgs

Retain a rolling 32-block cursor and matched-observation window.

Before accepting block N, require its `parentHash` to equal the persisted hash for N-1. On mismatch:

1. Walk backward through retained local history and canonical RPC blocks.
2. Find the common ancestor.
3. Emit one `activity.reverted` event for every delivered observation in orphaned blocks.
4. Delete orphaned cursor entries.
5. Replay the replacement canonical blocks.

If no common ancestor exists within 32 blocks, stop the chain and mark it `degraded` for operator intervention. Do not silently continue from an unknown state.

The MVP does not emit a later `confirmed` event. Consumers that need finality can delay acting on observed events using chain-specific confirmation policies.

## Control-Plane Consistency

Subscription writes in D1 and scanner updates in Durable Objects cannot be one atomic transaction. Use an idempotent command outbox:

```text
D1 transaction
  -> write subscription/reference-count change
  -> write scanner command with deterministic command ID

after commit
  -> dispatch command to assigned scanner shard
  -> mark command applied
```

A scheduled reconciliation job redispatches unapplied commands and compares D1 active-chain assignments with Durable Object state. Scanner command handlers are idempotent.

This closes the failure window where D1 commits but the process dies before notifying the scanner.

## D1 Data Model

Use migrations for these logical tables:

```text
accounts
api_keys
webhooks
subscriptions
tracked_addresses
chain_registry
scanner_commands
activity_observations
webhook_deliveries
```

Important constraints and indexes:

- Unique API-key hash.
- Unique `(account_id, webhook_id, address, chain_id)` active subscription.
- Indexed `(chain_id, address)` fanout lookup.
- Unique `(chain_id, address)` tracked-address reference count.
- Unique scanner command ID.
- Unique observation ID.
- Unique `(observation_id, webhook_id, event_type)` delivery.

`subscriptions` includes `active_from_block`, status, creation time, and deletion time. Fanout selects only active subscriptions whose `active_from_block <= activity.blockNumber`.

Activity and delivery rows have explicit retention. Keep activity observations for seven days to cover queue retries and reorg handling. Keep all webhook delivery outcomes, including successful, failed, and dead-letter deliveries, for 30 days and expose them through the authenticated delivery-history API.

## Webhook Delivery

### Signing

Use HMAC-SHA256 over the exact request body with headers similar to:

```text
webhook-id: evt_...
webhook-timestamp: 1788080000
webhook-signature: v1,<hex-signature>
```

Include the timestamp in the signed input and document a five-minute replay tolerance. Support overlapping current and previous secrets during secret rotation.

### Retry Policy

- Success: any 2xx response.
- Retry: timeout, network error, 408, 409, 425, 429, and 5xx.
- Permanent failure: other 4xx responses.
- Exponential retry over approximately 24 hours.
- Honor a bounded `Retry-After` value.
- Move exhausted deliveries to a dead-letter queue and expose their state through logs/operations tooling.
- Apply a strict request timeout and response-size limit.

Delivery is at least once. Consumers deduplicate by webhook event `id`.

## Security

- Hash API keys with a server-side pepper; never store plaintext keys.
- Encrypt webhook signing secrets at rest or derive per-webhook signing keys from a master secret and webhook ID.
- Require HTTPS webhook URLs.
- Resolve and reject private, loopback, link-local, multicast, and metadata IP ranges before delivery and after redirects.
- Disable redirects for webhook requests initially.
- Validate all API, queue, D1, and RPC boundaries with Zod.
- Apply account-level API rate limits plus the default quota of 1,000 active subscriptions and 20 distinct subscribed chains, with operator-configurable overrides.
- Keep the `rpc-racer` internal secret and D1 access unavailable to customer code.
- Redact API keys, webhook secrets, and RPC URLs containing credentials from logs.

## Observability

At minimum, record:

```text
active_chains
tracked_chain_addresses
chain_head
chain_cursor
blocks_behind
head_polls_total
blocks_processed_total
rpc_requests_total by method and chain
rpc_upstream_attempts_total
rpc_latency_ms
rpc_failures_total by reason
transactions_processed_total
tracked_sender_transactions_total by status
transfer_logs_processed_total
malformed_transfer_logs_total
matched_transaction_bundles_total by sender/recipient role
matched_effects_total by kind and direction
reorgs_total and reorg_depth
queue_retries_total
webhook_attempts_total by status class
webhook_delivery_latency_ms
observed_to_delivered_ms
dead_letter_deliveries
scanner_alarm_duration_ms
```

Primary alerts:

- `blocks_behind` remains above 2 blocks for 5 minutes.
- Observed-to-delivered webhook latency p95 exceeds `max(10 seconds, 2 block intervals)`.
- A chain is degraded or unsupported after previously being active.
- RPC error rate or latency rises sharply.
- Queue age grows.
- Webhook dead letters occur.
- A reorg exceeds the retained window.

## Repository Shape

Use one TypeScript Cloudflare Worker project for the notification service:

```text
src/
  api/
  scanner/
  queues/
  rpc/
  db/
  domain/
migrations/
test/
docs/
wrangler.toml
```

Use Bun, TypeScript, Hono, Zod, viem, D1, Durable Objects, and Cloudflare Queues. Keep domain decoding and ID construction as pure functions with unit tests.

The required `rpc-racer` changes remain in its existing repository and should be implemented and deployed before enabling live scanner traffic.

## Delivery Plan

### Milestone 0: RPC Foundation

- Add the private authenticated service-binding path to `rpc-racer`.
- Add configurable internal race fanout and caller-labelled metrics.
- Verify exact-block-hash `eth_getLogs` behavior.
- Add integration tests for Ethereum, Base, Optimism, and Arbitrum.
- Measure upstream request amplification and response bytes.

Exit criterion: a bound test Worker can safely perform sustained head, full-block, log, and receipt reads without using the public rate-limit budget.

### Milestone 1: API and Persistence

- Scaffold the notification Worker and local Cloudflare resources.
- Add D1 migrations.
- Add operator account/API-key provisioning.
- Implement webhook CRUD, test delivery, and 30-day delivery-history endpoints.
- Implement subscription CRUD, exact one-webhook mapping, account quotas, and chain resolution.
- Add the scanner command outbox and reconciliation job.

Exit criterion: an authenticated account can create a webhook and activate/deactivate subscriptions with deterministic D1 state.

### Milestone 2: Scanner and Matching

- Implement scanner shard assignment and alarms.
- Implement chain probes, cursor persistence, catch-up, and bounded retries.
- Implement tracked-sender transaction matching, incoming native matching, and shared receipt verification.
- Implement strict ERC-20/ERC-721 log decoding.
- Group all relevant effects into deterministic transaction-address bundles.
- Implement deterministic bundle, observation, and effect IDs.
- Enqueue one matched observation per bundle.

Exit criterion: fixture tests and live-chain tests produce one bundle per transaction and tracked address, preserve every relevant transfer as an effect, report reverted sender transactions, avoid duplicate outbound native effects, and never advance a cursor after incomplete processing.

### Milestone 3: Fanout and Webhooks

- Implement matched-bundle fanout by chain and tracked address.
- Enforce each subscription's activation block.
- Implement delivery queue, HMAC signing, retry classification, and DLQ.
- Add SSRF protections and secret rotation.
- Add delivery deduplication and retention cleanup.

Exit criterion: one transaction-address bundle fans out to all eligible webhook destinations, retries safely, and remains idempotent under duplicate queue delivery.

### Milestone 4: Reorgs and Operations

- Persist the rolling block and observation window.
- Implement ancestor search, rewind, replay, and `activity.reverted` events.
- Add chain health, lag, queue, and webhook metrics.
- Add operator endpoints or scripts for chain pause/resume, command replay, and DLQ replay.
- Run failure tests for restarts, timeouts, rate limits, malformed RPC responses, and deep reorgs.

Exit criterion: injected shallow reorgs and transient failures recover without missed canonical activity or duplicate customer-visible observations.

### Milestone 5: Production Pilot

- Begin with real subscriptions on Ethereum, Base, Optimism, and Arbitrum while leaving arbitrary-chain activation enabled.
- Enforce the default 1,000-subscription and 20-chain account quotas.
- Observe RPC request amplification, bytes, scanner duration, and webhook reliability for at least one week.
- Tune poll intervals and race fanout from measurements.
- Document unsupported chains and recurring upstream limitations.

Exit criterion: the pilot measures against p95 delivery within `max(10 seconds, 2 block intervals)` of first observation, alerts when a chain remains more than 2 blocks behind for 5 minutes, and establishes cost per active chain well enough to widen access.

## Test Strategy

### Unit Tests

- Address normalization and BLOB conversion.
- ERC-20/ERC-721 classification and malformed logs.
- Successful, reverted, zero-value, value-bearing, and contract-creation sender transactions.
- Native receipt-status, deduplication, and block-hash validation.
- Self-transfer handling.
- Multi-log transaction bundling and unrelated-log exclusion.
- Bundle, observation, effect, and command ID determinism.
- Poll scheduling, retry classification, and webhook signatures.

### Integration Tests

- D1 subscription/reference-count transitions.
- Outbox redelivery after partial failure.
- Duplicate matched messages and duplicate webhook messages.
- One transaction producing multiple relevant and unrelated transfer logs.
- One transaction involving two separately tracked addresses.
- Quota enforcement and per-chain partial failure for multi-chain subscription creation.
- Unsupported-chain manual retry authorization, cooldown, and state transition.
- Subscription activation while a chain is catching up.
- Chain activation/deactivation and shard reconciliation.
- RPC timeout, 429, null block, mismatched block hash, and empty exact-hash logs.

### End-to-End Tests

- Send controlled successful, reverted, zero-value, contract-creation, native, ERC-20, and ERC-721 transactions on a testnet.
- Verify observed webhook payloads and signatures.
- Force queue retries with a test webhook receiver.
- Simulate a reorg with a local EVM node and verify reverted events.

Do not rely only on live public-chain tests; deterministic fixtures and a controllable local chain are required for failure and reorg coverage.

## Explicit Non-Goals

- Historical backfill.
- Internal transfers and execution traces.
- Incoming native effects for value supplied during contract creation.
- ERC-1155.
- Token metadata, balances, prices, or portfolio state.
- Arbitrary contract event indexing.
- Transaction simulation.
- Guaranteed support for every chain present in Chainlist.
- Direct APNs, FCM, email, SMS, or WebPush delivery.
- Customer dashboard, self-service signup, and billing.
- Exactly-once delivery; the contract is at-least-once with deterministic IDs.

## Later Extensions

- ERC-1155 TransferSingle and TransferBatch.
- Confirmation or finalized event lifecycle.
- Direct APNs/FCM delivery.
- Customer-managed per-chain confirmation depth.
- Token metadata enrichment outside the ingestion path.
- Historical backfill as a separate bounded job.
- Address matcher partitioning when a shard's tracked set approaches memory limits.
- Paid plans, higher quota tiers, self-service account management, and usage analytics.
