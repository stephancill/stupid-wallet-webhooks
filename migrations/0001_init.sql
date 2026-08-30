-- Milestone 1: control-plane persistence.
-- All tables are D1/SQLite STRICT. Block numbers and uint256 values are stored
-- as INTEGER or TEXT; addresses are stored as canonical 20-byte BLOBs.

-- Accounts (multi-tenant). Operator-created only for the MVP.
CREATE TABLE accounts (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active', -- active | suspended
  subscription_quota INTEGER, -- operator override; NULL = use default
  chain_quota       INTEGER,  -- operator override; NULL = use default
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
) STRICT;

-- API keys. Only a keyed (peppered) hash of each key is stored.
CREATE TABLE api_keys (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  prefix       TEXT NOT NULL, -- short display prefix, never the full key
  name         TEXT,
  status       TEXT NOT NULL DEFAULT 'active', -- active | revoked
  created_at   TEXT NOT NULL,
  revoked_at   TEXT,
  FOREIGN KEY (account_id) REFERENCES accounts(id)
) STRICT;

CREATE INDEX idx_api_keys_account ON api_keys(account_id, status);

-- Webhook endpoints. Signing secrets are derived deterministically from a
-- master secret + webhook id, never stored raw.
CREATE TABLE webhooks (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL,
  url           TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active', -- active | inactive
  created_at    TEXT NOT NULL,
  last_test_at  TEXT,
  FOREIGN KEY (account_id) REFERENCES accounts(id)
) STRICT;

CREATE INDEX idx_webhooks_account ON webhooks(account_id);

-- Subscriptions. The unique active-subscription key is
-- (account_id, webhook_id, address, chain_id).
CREATE TABLE subscriptions (
  id               TEXT PRIMARY KEY,
  account_id       TEXT NOT NULL,
  webhook_id       TEXT NOT NULL,
  address          BLOB NOT NULL,
  chain_id         INTEGER NOT NULL,
  status           TEXT NOT NULL, -- pending | active | unsupported | deleting
  reason           TEXT,
  active_from_block INTEGER, -- set when the scanner activates the subscription
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  deleted_at       TEXT,
  FOREIGN KEY (account_id) REFERENCES accounts(id),
  FOREIGN KEY (webhook_id) REFERENCES webhooks(id)
) STRICT;

-- Available for fanout while a subscription is active.
CREATE INDEX idx_subscriptions_fanout ON subscriptions(chain_id, address, status);
CREATE INDEX idx_subscriptions_account ON subscriptions(account_id, status);
-- One active subscription per tuple; deleting rows fall outside this index so
-- the same tuple can be re-subscribed after deletion.
CREATE UNIQUE INDEX idx_subscriptions_active
  ON subscriptions(account_id, webhook_id, address, chain_id)
  WHERE status IN ('pending', 'active', 'unsupported');

-- Reference count of active subscriptions per (chain_id, address). Drives
-- scanner start/stop.
CREATE TABLE tracked_addresses (
  id          TEXT PRIMARY KEY,
  chain_id    INTEGER NOT NULL,
  address     BLOB NOT NULL,
  ref_count   INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL,
  UNIQUE (chain_id, address)
) STRICT;

-- Per-chain operational state, reconciled between D1 and scanner shards.
CREATE TABLE chain_registry (
  chain_id       INTEGER PRIMARY KEY,
  name           TEXT,
  status         TEXT NOT NULL DEFAULT 'pending', -- pending | active | degraded | unsupported
  reason         TEXT,
  shard_id       INTEGER,
  last_probe_at  TEXT,
  cursor_block   INTEGER,
  cursor_hash    TEXT,
  block_speed_ms INTEGER,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
) STRICT;

-- Scanner command outbox. Written atomically with control-plane changes and
-- applied => by the assigned scanner shard. Idempotent by deterministic id.
CREATE TABLE scanner_operations (
  id              TEXT PRIMARY KEY, -- deterministic command id
  chain_id        INTEGER NOT NULL,
  kind            TEXT NOT NULL, -- activate_chain | deactivate_chain | add_address | remove_address | retry_chain
  address         BLOB,
  subscription_id TEXT,
  payload         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | applied | failed
  error           TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  applied_at      TEXT,
  updated_at      TEXT NOT NULL
) STRICT;

CREATE INDEX idx_scanner_operations_pending ON scanner_operations(status, created_at);
CREATE INDEX idx_scanner_operations_chain ON scanner_operations(chain_id);

-- Observed activity, retained ~7 days to cover queue retries and reorgs.
CREATE TABLE activity_observations (
  id             TEXT PRIMARY KEY, -- observation id, used as webhook event id
  chain_id       INTEGER NOT NULL,
  tx_hash        BLOB NOT NULL,
  tracked_address BLOB NOT NULL,
  block_number   INTEGER NOT NULL,
  block_hash     BLOB NOT NULL,
  status         TEXT NOT NULL DEFAULT 'observed', -- observed | reverted
  initiator      TEXT NOT NULL, -- tx `from`
  payload        TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  reverted_at    TEXT
) STRICT;

CREATE INDEX idx_observations_chain_block ON activity_observations(chain_id, block_number);

-- Webhook delivery ledger, retained 30 days and surfaced through the API.
CREATE TABLE webhook_deliveries (
  id                  TEXT PRIMARY KEY,
  account_id          TEXT NOT NULL,
  webhook_id          TEXT NOT NULL,
  event_id            TEXT NOT NULL, -- webhook event id (observation id, test id, ...)
  event_type          TEXT NOT NULL, -- activity.observed | activity.reverted | webhook.test
  chain_id            INTEGER,
  status              TEXT NOT NULL, -- pending | success | failed | dead_lettered
  attempts            INTEGER NOT NULL DEFAULT 0,
  last_response_status INTEGER,
  response_body_excerpt TEXT,
  next_retry_at       TEXT,
  last_error          TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (webhook_id, event_id, event_type),
  FOREIGN KEY (account_id) REFERENCES accounts(id),
  FOREIGN KEY (webhook_id) REFERENCES webhooks(id)
) STRICT;

CREATE INDEX idx_deliveries_created ON webhook_deliveries(account_id, created_at);
CREATE INDEX idx_deliveries_event ON webhook_deliveries(webhook_id, event_id);