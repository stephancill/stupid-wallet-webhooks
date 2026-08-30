import { nowISO } from "./timestamp";
import { bytesToHex as _bytesToHex, hexToBytes as _hexToBytes } from "viem";

export type AccountRow = {
  id: string;
  name: string;
  status: "active" | "suspended";
  subscription_quota: number | null;
  chain_quota: number | null;
  created_at: string;
  updated_at: string;
};

export type ApiKeyRow = {
  id: string;
  account_id: string;
  key_hash: string;
  prefix: string;
  name: string | null;
  status: "active" | "revoked";
  created_at: string;
  revoked_at: string | null;
};

export interface ApiKeyWithAccount {
  apiKey: ApiKeyRow;
  account: AccountRow;
}

export type WebhookRow = {
  id: string;
  account_id: string;
  url: string;
  status: "active" | "inactive";
  created_at: string;
  last_test_at: string | null;
};

export type WebhookDeliveryRow = {
  id: string;
  account_id: string;
  webhook_id: string;
  event_id: string;
  event_type: "activity.observed" | "activity.reverted" | "webhook.test";
  chain_id: number | null;
  status: "pending" | "success" | "failed" | "dead_lettered";
  attempts: number;
  last_response_status: number | null;
  response_body_excerpt: string | null;
  next_retry_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export type SubscriptionRow = {
  id: string;
  account_id: string;
  webhook_id: string;
  address: Uint8Array | ArrayBuffer;
  chain_id: number;
  status: "pending" | "active" | "unsupported" | "deleting";
  reason: string | null;
  active_from_block: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type ChainRegistryRow = {
  chain_id: number;
  name: string | null;
  status: "pending" | "active" | "degraded" | "unsupported" | "paused";
  reason: string | null;
  shard_id: number | null;
  last_probe_at: string | null;
  cursor_block: number | null;
  cursor_hash: string | null;
  block_speed_ms: number | null;
  last_head_block: number | null;
  created_at: string;
  updated_at: string;
};

export type ScannerCommandRow = {
  id: string;
  chain_id: number;
  kind: "subscribe" | "unsubscribe" | "retry_chain";
  address: Uint8Array | ArrayBuffer | null;
  subscription_id: string | null;
  payload: string;
  status: "pending" | "applied" | "failed";
  error: string | null;
  attempts: number;
  created_at: string;
  applied_at: string | null;
};

export const enumSubscriptionStatus = ["pending", "active", "unsupported", "deleting"] as const;
export type SubscriptionStatus = (typeof enumSubscriptionStatus)[number];

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function toAccountRow(row: Record<string, unknown>): AccountRow {
  return {
    id: String(row.id),
    name: String(row.name),
    status: row.status === "suspended" ? "suspended" : "active",
    subscription_quota: row.subscription_quota === null ? null : Number(row.subscription_quota),
    chain_quota: row.chain_quota === null ? null : Number(row.chain_quota),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function toApiKeyRow(row: Record<string, unknown>): ApiKeyRow {
  return {
    id: String(row.id),
    account_id: String(row.account_id),
    key_hash: String(row.key_hash),
    prefix: String(row.prefix),
    name: row.name === null ? null : String(row.name),
    status: row.status === "revoked" ? "revoked" : "active",
    created_at: String(row.created_at),
    revoked_at: row.revoked_at === null ? null : String(row.revoked_at),
  };
}

function toWebhookRow(row: Record<string, unknown>): WebhookRow {
  return {
    id: String(row.id),
    account_id: String(row.account_id),
    url: String(row.url),
    status: row.status === "inactive" ? "inactive" : "active",
    created_at: String(row.created_at),
    last_test_at: row.last_test_at === null ? null : String(row.last_test_at),
  };
}

function toSubscriptionRow(row: Record<string, unknown>): SubscriptionRow {
  const rawStatus = String(row.status);
  const status = (enumSubscriptionStatus as readonly string[]).includes(rawStatus)
    ? (rawStatus as SubscriptionRow["status"])
    : "deleting";
  return {
    id: String(row.id),
    account_id: String(row.account_id),
    webhook_id: String(row.webhook_id),
    address: row.address as Uint8Array | ArrayBuffer,
    chain_id: Number(row.chain_id),
    status,
    reason: row.reason === null ? null : String(row.reason),
    active_from_block: row.active_from_block === null ? null : Number(row.active_from_block),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    deleted_at: row.deleted_at === null ? null : String(row.deleted_at),
  };
}

function toChainRegistryRow(row: Record<string, unknown>): ChainRegistryRow {
  const raw = String(row.status);
  const valid = ["pending", "active", "degraded", "unsupported", "paused"] as const;
  const status = (valid as readonly string[]).includes(raw)
    ? (raw as ChainRegistryRow["status"])
    : "pending";
  return {
    chain_id: Number(row.chain_id),
    name: row.name === null ? null : String(row.name),
    status,
    reason: row.reason === null ? null : String(row.reason),
    shard_id: row.shard_id === null ? null : Number(row.shard_id),
    last_probe_at: row.last_probe_at === null ? null : String(row.last_probe_at),
    cursor_block: row.cursor_block === null ? null : Number(row.cursor_block),
    cursor_hash: row.cursor_hash === null ? null : String(row.cursor_hash),
    block_speed_ms: row.block_speed_ms === null ? null : Number(row.block_speed_ms),
    last_head_block: row.last_head_block === null ? null : Number(row.last_head_block),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function toScannerCommandRow(row: Record<string, unknown>): ScannerCommandRow {
  return {
    id: String(row.id),
    chain_id: Number(row.chain_id),
    kind: row.kind as ScannerCommandRow["kind"],
    address: row.address === null ? null : (row.address as Uint8Array | ArrayBuffer),
    subscription_id: row.subscription_id === null ? null : String(row.subscription_id),
    payload: String(row.payload),
    status: row.status as ScannerCommandRow["status"],
    error: row.error === null ? null : String(row.error),
    attempts: Number(row.attempts),
    created_at: String(row.created_at),
    applied_at: row.applied_at === null ? null : String(row.applied_at),
  };
}

// ---------------------------------------------------------------------------
// Accounts and API keys
// ---------------------------------------------------------------------------

export async function insertAccount(
  db: D1Database,
  account: {
    id: string;
    name: string;
    subscription_quota?: number | null;
    chain_quota?: number | null;
  },
): Promise<AccountRow> {
  const ts = nowISO();
  await db
    .prepare(
      "INSERT INTO accounts (id, name, status, subscription_quota, chain_quota, created_at, updated_at) VALUES (?, ?, 'active', ?, ?, ?, ?)",
    )
    .bind(
      account.id,
      account.name,
      account.subscription_quota ?? null,
      account.chain_quota ?? null,
      ts,
      ts,
    )
    .run();
  return {
    id: account.id,
    name: account.name,
    status: "active",
    subscription_quota: account.subscription_quota ?? null,
    chain_quota: account.chain_quota ?? null,
    created_at: ts,
    updated_at: ts,
  };
}

export async function getAccount(db: D1Database, accountId: string): Promise<AccountRow | null> {
  const row = await db
    .prepare("SELECT * FROM accounts WHERE id = ?")
    .bind(accountId)
    .first<Record<string, unknown>>();
  return row === null ? null : toAccountRow(row);
}

export async function setAccountStatus(
  db: D1Database,
  accountId: string,
  status: "active" | "suspended",
): Promise<void> {
  await db
    .prepare("UPDATE accounts SET status = ?, updated_at = ? WHERE id = ?")
    .bind(status, nowISO(), accountId)
    .run();
}

export async function createApiKey(
  db: D1Database,
  apiKey: {
    id: string;
    account_id: string;
    key_hash: string;
    prefix: string;
    name?: string | null;
  },
): Promise<ApiKeyRow> {
  const ts = nowISO();
  await db
    .prepare(
      "INSERT INTO api_keys (id, account_id, key_hash, prefix, name, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)",
    )
    .bind(apiKey.id, apiKey.account_id, apiKey.key_hash, apiKey.prefix, apiKey.name ?? null, ts)
    .run();
  return {
    ...apiKey,
    name: apiKey.name ?? null,
    status: "active",
    created_at: ts,
    revoked_at: null,
  };
}

export async function listApiKeys(db: D1Database, accountId: string): Promise<ApiKeyRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM api_keys WHERE account_id = ? ORDER BY created_at DESC")
    .bind(accountId)
    .all<Record<string, unknown>>();
  return results.map(toApiKeyRow);
}

export async function revokeApiKey(db: D1Database, keyId: string): Promise<boolean> {
  const res = await db
    .prepare(
      "UPDATE api_keys SET status = 'revoked', revoked_at = ? WHERE id = ? AND status = 'active'",
    )
    .bind(nowISO(), keyId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

// Returns the active API key row + its account, or null when the hash matches nothing active.
export async function findApiKeyWithAccount(
  db: D1Database,
  keyHash: string,
): Promise<AuthRecord | null> {
  const row = await db
    .prepare(
      "SELECT ak.*, a.name AS account_name, a.status AS account_status, a.subscription_quota, a.chain_quota, a.created_at AS account_created_at, a.updated_at AS account_updated_at FROM api_keys ak JOIN accounts a ON a.id = ak.account_id WHERE ak.key_hash = ? AND ak.status = 'active'",
    )
    .bind(keyHash)
    .first<Record<string, unknown>>();
  if (row === null) {
    return null;
  }
  const apiKey = toApiKeyRow(row);
  const account: AccountRow = {
    id: String(row.account_id),
    name: String(row.account_name),
    status: row.account_status === "suspended" ? "suspended" : "active",
    subscription_quota: row.subscription_quota === null ? null : Number(row.subscription_quota),
    chain_quota: row.chain_quota === null ? null : Number(row.chain_quota),
    created_at: String(row.account_created_at),
    updated_at: String(row.account_updated_at),
  };
  return { apiKey, account };
}

export type AuthRecord = { apiKey: ApiKeyRow; account: AccountRow };

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export async function createWebhook(
  db: D1Database,
  webhook: { id: string; account_id: string; url: string },
): Promise<WebhookRow> {
  const ts = nowISO();
  await db
    .prepare(
      "INSERT INTO webhooks (id, account_id, url, status, created_at) VALUES (?, ?, ?, 'active', ?)",
    )
    .bind(webhook.id, webhook.account_id, webhook.url, ts)
    .run();
  return {
    id: webhook.id,
    account_id: webhook.account_id,
    url: webhook.url,
    status: "active",
    created_at: ts,
    last_test_at: null,
  };
}

export async function getWebhook(
  db: D1Database,
  webhookId: string,
  accountId: string,
): Promise<WebhookRow | null> {
  const row = await db
    .prepare("SELECT * FROM webhooks WHERE id = ? AND account_id = ?")
    .bind(webhookId, accountId)
    .first<Record<string, unknown>>();
  return row === null ? null : toWebhookRow(row);
}

export async function listWebhooks(db: D1Database, accountId: string): Promise<WebhookRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM webhooks WHERE account_id = ? ORDER BY created_at DESC")
    .bind(accountId)
    .all<Record<string, unknown>>();
  return results.map(toWebhookRow);
}

export async function deleteWebhook(
  db: D1Database,
  webhookId: string,
  accountId: string,
): Promise<boolean> {
  const res = await db
    .prepare("DELETE FROM webhooks WHERE id = ? AND account_id = ?")
    .bind(webhookId, accountId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

export async function insertSubscription(
  db: D1Database,
  sub: {
    id: string;
    account_id: string;
    webhook_id: string;
    address: Uint8Array;
    chain_id: number;
    status: "pending";
  },
): Promise<void> {
  const ts = nowISO();
  await db
    .prepare(
      "INSERT INTO subscriptions (id, account_id, webhook_id, address, chain_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(sub.id, sub.account_id, sub.webhook_id, sub.address, sub.chain_id, sub.status, ts, ts)
    .run();
}

// Returns undefined when the unique active tuple already exists.
export async function insertSubscriptionIfAbsent(
  db: D1Database,
  sub: {
    id: string;
    account_id: string;
    webhook_id: string;
    address: Uint8Array;
    chain_id: number;
  },
): Promise<boolean> {
  const ts = nowISO();
  const res = await db
    .prepare(
      "INSERT OR IGNORE INTO subscriptions (id, account_id, webhook_id, address, chain_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)",
    )
    .bind(sub.id, sub.account_id, sub.webhook_id, sub.address, sub.chain_id, ts, ts)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function getSubscription(
  db: D1Database,
  subscriptionId: string,
  accountId: string,
): Promise<SubscriptionRow | null> {
  const row = await db
    .prepare("SELECT * FROM subscriptions WHERE id = ? AND account_id = ?")
    .bind(subscriptionId, accountId)
    .first<Record<string, unknown>>();
  return row === null ? null : toSubscriptionRow(row);
}

export async function listSubscriptions(
  db: D1Database,
  accountId: string,
  webhookId?: string,
  chainId?: number,
  address?: Uint8Array,
  cursor?: string,
  limit = 50,
): Promise<SubscriptionRow[]> {
  const conditions: string[] = ["account_id = ?"];
  const params: Array<string | number | Uint8Array> = [accountId];
  if (webhookId !== undefined) {
    conditions.push("webhook_id = ?");
    params.push(webhookId);
  }
  if (chainId !== undefined) {
    conditions.push("chain_id = ?");
    params.push(chainId);
  }
  if (address !== undefined) {
    conditions.push("address = ?");
    params.push(address);
  }
  if (cursor !== undefined) {
    conditions.push("id > ?");
    params.push(cursor);
  }
  params.push(limit + 1);
  const { results } = await db
    .prepare(
      `SELECT * FROM subscriptions WHERE ${conditions.join(" AND ")} ORDER BY id ASC LIMIT ?`,
    )
    .bind(...params)
    .all<Record<string, unknown>>();
  return results.map(toSubscriptionRow);
}

export async function countActiveSubscriptions(db: D1Database, accountId: string): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS count FROM subscriptions WHERE account_id = ? AND deleted_at IS NULL AND status != 'deleting'",
    )
    .bind(accountId)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}

export async function countDistinctChains(db: D1Database, accountId: string): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(DISTINCT chain_id) AS count FROM subscriptions WHERE account_id = ? AND deleted_at IS NULL AND status != 'deleting'",
    )
    .bind(accountId)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}

/** Returns the distinct active chain ids for an account. */
export async function listActiveChainIds(db: D1Database, accountId: string): Promise<number[]> {
  const { results } = await db
    .prepare(
      "SELECT DISTINCT chain_id AS chain_id FROM subscriptions WHERE account_id = ? AND deleted_at IS NULL AND status != 'deleting' ORDER BY chain_id ASC",
    )
    .bind(accountId)
    .all<{ chain_id: number }>();
  return results.map((row) => Number(row.chain_id));
}

/** True when an active (non-deleting) subscription exists for the tuple. */
export async function hasActiveSubscription(
  db: D1Database,
  accountId: string,
  webhookId: string,
  address: Uint8Array,
  chainId: number,
): Promise<boolean> {
  const row = await db
    .prepare(
      "SELECT id FROM subscriptions WHERE account_id = ? AND webhook_id = ? AND address = ? AND chain_id = ? AND deleted_at IS NULL AND status != 'deleting' LIMIT 1",
    )
    .bind(accountId, webhookId, address, chainId)
    .first<{ id: string }>();
  return row !== null;
}

export async function markSubscriptionDeleting(
  db: D1Database,
  subscriptionId: string,
  accountId: string,
  reason = "deleted by user",
): Promise<boolean> {
  const ts = nowISO();
  const res = await db
    .prepare(
      "UPDATE subscriptions SET status = 'deleting', deleted_at = ?, updated_at = ?, reason = ? WHERE id = ? AND account_id = ? AND deleted_at IS NULL",
    )
    .bind(ts, ts, reason, subscriptionId, accountId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function setSubscriptionStatus(
  db: D1Database,
  subscriptionId: string,
  status: SubscriptionRow["status"],
  fields: { reason?: string | null; active_from_block?: number | null } = {},
): Promise<void> {
  const sets: string[] = ["status = ?", "updated_at = ?"];
  const params: unknown[] = [status, nowISO()];
  if (fields.reason !== undefined) {
    sets.push("reason = ?");
    params.push(fields.reason);
  }
  if (fields.active_from_block !== undefined) {
    sets.push("active_from_block = ?");
    params.push(fields.active_from_block);
  }
  params.push(subscriptionId);
  await db
    .prepare(`UPDATE subscriptions SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...params)
    .run();
}

// ---------------------------------------------------------------------------
// Tracked addresses (reference counts)
// ---------------------------------------------------------------------------

export async function incrementTrackedAddress(
  db: D1Database,
  chainId: number,
  address: Uint8Array,
): Promise<void> {
  const ts = nowISO();
  await db
    .prepare(
      "INSERT INTO tracked_addresses (chain_id, address, ref_count, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(chain_id, address) DO UPDATE SET ref_count = ref_count + 1, updated_at = excluded.updated_at",
    )
    .bind(chainId, address, ts)
    .run();
}

export async function decrementTrackedAddress(
  db: D1Database,
  chainId: number,
  address: Uint8Array,
): Promise<void> {
  await db
    .prepare(
      "UPDATE tracked_addresses SET ref_count = ref_count - 1, updated_at = ? WHERE chain_id = ? AND address = ? AND ref_count > 0",
    )
    .bind(nowISO(), chainId, address)
    .run();
}

export async function deleteZeroRefTrackedAddresses(
  db: D1Database,
  chainId: number,
  address: Uint8Array,
): Promise<void> {
  await db
    .prepare("DELETE FROM tracked_addresses WHERE chain_id = ? AND address = ? AND ref_count <= 0")
    .bind(chainId, address)
    .run();
}

// ---------------------------------------------------------------------------
// Chain registry
// ---------------------------------------------------------------------------

export async function upsertChainRegistry(
  db: D1Database,
  chain: { chain_id: number; name?: string | null; status?: ChainRegistryRow["status"] },
): Promise<void> {
  const ts = nowISO();
  await db
    .prepare(
      "INSERT INTO chain_registry (chain_id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(chain_id) DO UPDATE SET name = COALESCE(excluded.name, chain_registry.name), updated_at = excluded.updated_at",
    )
    .bind(chain.chain_id, chain.name ?? null, chain.status ?? "pending", ts, ts)
    .run();
}

export async function getChainRegistry(
  db: D1Database,
  chainId: number,
): Promise<ChainRegistryRow | null> {
  const row = await db
    .prepare("SELECT * FROM chain_registry WHERE chain_id = ?")
    .bind(chainId)
    .first<Record<string, unknown>>();
  return row === null ? null : toChainRegistryRow(row);
}

export async function listChainRegistry(db: D1Database): Promise<ChainRegistryRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM chain_registry ORDER BY chain_id ASC")
    .all<Record<string, unknown>>();
  return results.map(toChainRegistryRow);
}

export async function updateChainRegistryStatus(
  db: D1Database,
  chainId: number,
  fields: {
    status?: ChainRegistryRow["status"];
    reason?: string | null;
    shard_id?: number | null;
    name?: string | null;
    last_probe_at?: string | null;
    block_speed_ms?: number | null;
    cursor_block?: number | null;
    cursor_hash?: string | null;
  },
): Promise<void> {
  const sets: string[] = ["updated_at = ?"];
  const params: unknown[] = [nowISO()];
  if (fields.status !== undefined) {
    sets.push("status = ?");
    params.push(fields.status);
  }
  if (fields.reason !== undefined) {
    sets.push("reason = ?");
    params.push(fields.reason);
  }
  if (fields.shard_id !== undefined) {
    sets.push("shard_id = ?");
    params.push(fields.shard_id);
  }
  if (fields.name !== undefined) {
    sets.push("name = ?");
    params.push(fields.name);
  }
  if (fields.last_probe_at !== undefined) {
    sets.push("last_probe_at = ?");
    params.push(fields.last_probe_at);
  }
  if (fields.block_speed_ms !== undefined) {
    sets.push("block_speed_ms = ?");
    params.push(fields.block_speed_ms);
  }
  if (fields.cursor_block !== undefined) {
    sets.push("cursor_block = ?");
    params.push(fields.cursor_block);
  }
  if (fields.cursor_hash !== undefined) {
    sets.push("cursor_hash = ?");
    params.push(fields.cursor_hash);
  }
  params.push(chainId);
  await db
    .prepare(`UPDATE chain_registry SET ${sets.join(", ")} WHERE chain_id = ?`)
    .bind(...params)
    .run();
}

/** True when a non-applied retry_chain command exists for the chain. */
export async function hasPendingRetryCommand(db: D1Database, chainId: number): Promise<boolean> {
  const row = await db
    .prepare(
      "SELECT id FROM scanner_operations WHERE chain_id = ? AND kind = 'retry_chain' AND status = 'pending' LIMIT 1",
    )
    .bind(chainId)
    .first<{ id: string }>();
  return row !== null;
}

// ---------------------------------------------------------------------------
// Scanner command outbox
// ---------------------------------------------------------------------------

export type ScannerCommand = {
  id: string;
  chain_id: number;
  kind: ScannerCommandRow["kind"];
  address?: Uint8Array | null;
  subscription_id?: string | null;
  payload: string;
};

export async function insertCommand(db: D1Database, command: ScannerCommand): Promise<void> {
  const ts = nowISO();
  await db
    .prepare(
      "INSERT INTO scanner_operations (id, chain_id, kind, address, subscription_id, payload, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT(id) DO NOTHING",
    )
    .bind(
      command.id,
      command.chain_id,
      command.kind,
      command.address ?? null,
      command.subscription_id ?? null,
      command.payload,
      ts,
      ts,
    )
    .run();
}

export async function getCommand(
  db: D1Database,
  commandId: string,
): Promise<ScannerCommandRow | null> {
  const row = await db
    .prepare("SELECT * FROM scanner_operations WHERE id = ?")
    .bind(commandId)
    .first<Record<string, unknown>>();
  return row === null ? null : toScannerCommandRow(row);
}

export async function listPendingCommands(
  db: D1Database,
  limit = 200,
): Promise<ScannerCommandRow[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM scanner_operations WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?",
    )
    .bind(limit)
    .all<Record<string, unknown>>();
  return results.map(toScannerCommandRow);
}

export async function markCommandApplied(db: D1Database, commandId: string): Promise<void> {
  await db
    .prepare(
      "UPDATE scanner_operations SET status = 'applied', applied_at = ?, updated_at = ? WHERE id = ?",
    )
    .bind(nowISO(), nowISO(), commandId)
    .run();
}

export async function markCommandFailed(
  db: D1Database,
  commandId: string,
  error: string,
  prevAttempts: number,
): Promise<void> {
  await db
    .prepare(
      "UPDATE scanner_operations SET status = 'failed', attempts = ?, error = ?, updated_at = ? WHERE id = ?",
    )
    .bind(prevAttempts + 1, error, nowISO(), commandId)
    .run();
}

export async function resetFailedCommand(db: D1Database, commandId: string): Promise<void> {
  await db
    .prepare(
      "UPDATE scanner_operations SET status = 'pending', error = NULL, updated_at = ? WHERE id = ? AND status = 'failed'",
    )
    .bind(nowISO(), commandId)
    .run();
}

// ---------------------------------------------------------------------------
// Webhook deliveries
// ---------------------------------------------------------------------------

export type DeliveryInsert = {
  id: string;
  account_id: string;
  webhook_id: string;
  event_id: string;
  event_type: WebhookDeliveryRow["event_type"];
  chain_id: number | null;
  status: WebhookDeliveryRow["status"];
  attempts: number;
  last_response_status?: number | null;
  last_error?: string | null;
};

export async function insertDelivery(db: D1Database, delivery: DeliveryInsert): Promise<void> {
  const ts = nowISO();
  await db
    .prepare(
      "INSERT OR IGNORE INTO webhook_deliveries (id, account_id, webhook_id, event_id, event_type, chain_id, status, attempts, last_response_status, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      delivery.id,
      delivery.account_id,
      delivery.webhook_id,
      delivery.event_id,
      delivery.event_type,
      delivery.chain_id,
      delivery.status,
      delivery.attempts,
      delivery.last_response_status ?? null,
      delivery.last_error ?? null,
      ts,
      ts,
    )
    .run();
}

export async function listDeliveries(
  db: D1Database,
  accountId: string,
  filters: {
    webhookId?: string;
    eventId?: string;
    status?: WebhookDeliveryRow["status"];
    cursor?: string;
    limit?: number;
  },
): Promise<WebhookDeliveryRow[]> {
  const limit = Math.min(filters.limit ?? 50, 100);
  const conditions = ["account_id = ?"];
  const params: unknown[] = [accountId];
  if (filters.webhookId !== undefined) {
    conditions.push("webhook_id = ?");
    params.push(filters.webhookId);
  }
  if (filters.eventId !== undefined) {
    conditions.push("event_id = ?");
    params.push(filters.eventId);
  }
  if (filters.status !== undefined) {
    conditions.push("status = ?");
    params.push(filters.status);
  }
  if (filters.cursor !== undefined) {
    conditions.push("created_at < ?");
    params.push(filters.cursor);
  }
  params.push(limit + 1);
  const { results } = await db
    .prepare(
      `SELECT * FROM webhook_deliveries WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(...params)
    .all<Record<string, unknown>>();
  return results.map(toDeliveryRow);
}

export async function getDelivery(
  db: D1Database,
  deliveryId: string,
  accountId: string,
): Promise<WebhookDeliveryRow | null> {
  const row = await db
    .prepare("SELECT * FROM webhook_deliveries WHERE id = ? AND account_id = ?")
    .bind(deliveryId, accountId)
    .first<Record<string, unknown>>();
  return row === null ? null : toDeliveryRow(row);
}

export type WebhookDeliveryRowType = {
  id: string;
  account_id: string;
  webhook_id: string;
  event_id: string;
  event_type: WebhookDeliveryRow["event_type"];
  chain_id: number | null;
  status: WebhookDeliveryRow["status"];
  attempts: number;
  last_response_status: number | null;
  response_body_excerpt: string | null;
  next_retry_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

function toDeliveryRow(row: Record<string, unknown>): WebhookDeliveryRow {
  return {
    id: String(row.id),
    account_id: String(row.account_id),
    webhook_id: String(row.webhook_id),
    event_id: String(row.event_id),
    event_type: row.event_type as WebhookDeliveryRow["event_type"],
    chain_id: row.chain_id === null ? null : Number(row.chain_id),
    status: row.status as WebhookDeliveryRow["status"],
    attempts: Number(row.attempts),
    last_response_status:
      row.last_response_status === null ? null : Number(row.last_response_status),
    response_body_excerpt:
      row.response_body_excerpt === null ? null : String(row.response_body_excerpt),
    next_retry_at: row.next_retry_at === null ? null : String(row.next_retry_at),
    last_error: row.last_error === null ? null : String(row.last_error),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

// ---------------------------------------------------------------------------
// Scanner: tracked addresses, cursors, observations
// ---------------------------------------------------------------------------

/** Active tracked addresses for a chain (ref_count > 0), as lowercase hex. */
export async function listTrackedAddressesForChain(
  db: D1Database,
  chainId: number,
): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT address FROM tracked_addresses WHERE chain_id = ? AND ref_count > 0")
    .bind(chainId)
    .all<{ address: Uint8Array | ArrayBuffer }>();
  return results.map((row) => addressBytesToHex(row.address));
}

export async function setChainCursor(
  db: D1Database,
  chainId: number,
  cursor_block: number,
  cursor_hash: string,
): Promise<void> {
  await db
    .prepare(
      "UPDATE chain_registry SET cursor_block = ?, cursor_hash = ?, updated_at = ? WHERE chain_id = ?",
    )
    .bind(cursor_block, cursor_hash, nowISO(), chainId)
    .run();
}

/** Records the most recently observed head so chain lag can be computed. */
export async function setChainHead(
  db: D1Database,
  chainId: number,
  headBlock: number,
): Promise<void> {
  await db
    .prepare("UPDATE chain_registry SET last_head_block = ?, updated_at = ? WHERE chain_id = ?")
    .bind(headBlock, nowISO(), chainId)
    .run();
}

/** Pure percentile bucketing for latency samples (used by deliveryLatencyStats). */
export function computeLatencyPercentiles(samples: number[]): {
  eligibleCount: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
} {
  const latencies = samples.filter((ms) => Number.isFinite(ms) && ms >= 0).sort((a, b) => a - b);
  if (latencies.length === 0) {
    return { eligibleCount: 0, p50Ms: null, p95Ms: null, p99Ms: null };
  }
  const percentile = (ratio: number): number =>
    latencies[Math.min(latencies.length - 1, Math.floor(ratio * latencies.length))];
  return {
    eligibleCount: latencies.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
  };
}

/** Computes the observed-to-delivered p95/p99 for successful activity deliveries. */
export async function deliveryLatencyStats(db: D1Database): Promise<{
  eligibleCount: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
}> {
  // Restrict to the last 24h so latency reflects current health, not history.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { results } = await db
    .prepare(
      `SELECT wd.updated_at AS updated_at, obs.created_at AS observed_at
       FROM webhook_deliveries wd
       JOIN activity_observations obs ON obs.id = wd.event_id
       WHERE wd.event_type = 'activity.observed'
         AND wd.status = 'success'
         AND wd.updated_at >= ?`,
    )
    .bind(since)
    .all<{ updated_at: string; observed_at: string }>();
  const samples = results.map((row) => Date.parse(row.updated_at) - Date.parse(row.observed_at));
  return computeLatencyPercentiles(samples);
}

/** Deletes retained rows past their documented retention (7d obs, 30d deliveries). */
export async function runRetentionCleanup(db: D1Database): Promise<{
  observationsDeleted: number;
  deliveriesDeleted: number;
}> {
  const now = Date.now();
  const obsCutoff = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  const delCutoff = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  const obs = await db
    .prepare("DELETE FROM activity_observations WHERE created_at < ?")
    .bind(obsCutoff)
    .run();
  const del = await db
    .prepare("DELETE FROM webhook_deliveries WHERE created_at < ?")
    .bind(delCutoff)
    .run();
  return {
    observationsDeleted: obs.meta.changes ?? 0,
    deliveriesDeleted: del.meta.changes ?? 0,
  };
}

/** Computes per-chain lag plus a set of alerts for the operator surface. */
export async function observeSummary(
  db: D1Database,
  options: { latencyAlertMs?: number } = {},
): Promise<{
  chains: Array<{
    chainId: number;
    status: string;
    cursor: number | null;
    head: number | null;
    lag: number | null;
    reason: string | null;
  }>;
  deliveries: { pending: number; success: number; failed: number; dead_lettered: number };
  observations: { observed: number; reverted: number };
  deliveryLatency: {
    eligibleCount: number;
    p50Ms: number | null;
    p95Ms: number | null;
    p99Ms: number | null;
  };
  pendingCommands: number;
  alerts: Array<{ severity: string; message: string }>;
}> {
  const [rows, del, obs, pendingRow, latency] = await Promise.all([
    listChainRegistry(db),
    db
      .prepare("SELECT status, COUNT(*) AS c FROM webhook_deliveries GROUP BY status")
      .all<{ status: string; c: number }>(),
    db
      .prepare("SELECT status, COUNT(*) AS c FROM activity_observations GROUP BY status")
      .all<{ status: string; c: number }>(),
    db
      .prepare("SELECT COUNT(*) AS c FROM scanner_operations WHERE status = 'pending'")
      .first<{ c: number }>(),
    deliveryLatencyStats(db),
  ]);

  const lag = (cursor: number | null, head: number | null): number | null =>
    cursor !== null && head !== null ? Math.max(0, head - cursor) : null;

  const chains = rows.map((chain) => ({
    chainId: chain.chain_id,
    status: chain.status,
    cursor: chain.cursor_block,
    head: chain.last_head_block,
    lag: lag(chain.cursor_block, chain.last_head_block),
    reason: chain.reason,
  }));

  const count = (list: Array<{ status: string; c: number }>, key: string) =>
    list.find((r) => r.status === key)?.c ?? 0;
  const deliveries = {
    pending: count(del?.results ?? [], "pending"),
    success: count(del?.results ?? [], "success"),
    failed: count(del?.results ?? [], "failed"),
    dead_lettered: count(del?.results ?? [], "dead_lettered"),
  };

  const alerts: Array<{ severity: string; message: string }> = [];
  for (const chain of chains) {
    if (chain.status === "degraded")
      alerts.push({
        severity: "warning",
        message: `chain ${chain.chainId} is degraded (${chain.reason ?? "unknown"})`,
      });
    if (chain.status === "paused")
      alerts.push({ severity: "warning", message: `chain ${chain.chainId} is paused` });
    if (chain.lag !== null && chain.lag > 2)
      alerts.push({
        severity: "warning",
        message: `chain ${chain.chainId} is ${chain.lag} blocks behind`,
      });
  }
  if (deliveries.dead_lettered > 0)
    alerts.push({
      severity: "critical",
      message: `${deliveries.dead_lettered} dead-lettered delivery(ies) (run /dlq/replay)`,
    });
  const pendingCommands = Number(pendingRow?.c ?? 0);
  if (pendingCommands > 0)
    alerts.push({ severity: "warning", message: `${pendingCommands} pending scanner command(s)` });

  // Alert when successful observed→delivered p95 degrades, once we have enough
  // samples in the window to be meaningful. Threshold defaults to 10s and can be
  // tuned via DELIVERY_LATENCY_ALERT_MS.
  const latencyAlertMs = options.latencyAlertMs ?? 10_000;
  if (latency.eligibleCount >= 5 && latency.p95Ms !== null && latency.p95Ms > latencyAlertMs) {
    alerts.push({
      severity: "warning",
      message: `observed→delivered p95 ${latency.p95Ms}ms exceeds ${latencyAlertMs}ms (${latency.eligibleCount} deliveries)`,
    });
  }

  return {
    chains,
    deliveries,
    observations: {
      observed: count(obs?.results ?? [], "observed"),
      reverted: count(obs?.results ?? [], "reverted"),
    },
    deliveryLatency: {
      eligibleCount: latency.eligibleCount,
      p50Ms: latency.p50Ms,
      p95Ms: latency.p95Ms,
      p99Ms: latency.p99Ms,
    },
    pendingCommands,
    alerts,
  };
}

/** Sets the activation boundary on active subscriptions that don't have one yet. */
export async function setActiveFromBlockForChain(
  db: D1Database,
  chainId: number,
  fromBlock: number,
): Promise<void> {
  await db
    .prepare(
      "UPDATE subscriptions SET active_from_block = ?, updated_at = ? WHERE chain_id = ? AND status = 'active' AND deleted_at IS NULL AND active_from_block IS NULL",
    )
    .bind(fromBlock, nowISO(), chainId)
    .run();
}

export type ObservationInsert = {
  observationId: string;
  chainId: number;
  txHash: string;
  trackedAddress: string;
  blockNumber: string;
  blockHash: string;
  status: "observed" | "reverted";
  initiator: string;
  payload: string;
};

export async function upsertObservation(
  db: D1Database,
  observation: ObservationInsert,
): Promise<boolean> {
  const created = await db
    .prepare(
      "INSERT INTO activity_observations (id, chain_id, tx_hash, tracked_address, block_number, block_hash, status, initiator, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
    )
    .bind(
      observation.observationId,
      observation.chainId,
      hexToBytes(observation.txHash),
      hexToBytes(observation.trackedAddress),
      Number(observation.blockNumber),
      hexToBytes(observation.blockHash),
      observation.status,
      observation.initiator, // TEXT column: store the raw hex string
      observation.payload,
      nowISO(),
    )
    .run();
  return (created.meta.changes ?? 0) > 0;
}

/** Marks every observed observation in a now-orphaned block as `reverted`. */
export async function markObservationsRevertedByBlock(
  db: D1Database,
  chainId: number,
  blockNumber: number,
): Promise<number> {
  const res = await db
    .prepare(
      "UPDATE activity_observations SET status = 'reverted', reverted_at = ? WHERE chain_id = ? AND block_number = ? AND status = 'observed'",
    )
    .bind(nowISO(), chainId, blockNumber)
    .run();
  return res.meta.changes ?? 0;
}

/** Marks a reorged block's observations reverted and returns them (for fan-out). */
export async function markBlockRevertedAndList(
  db: D1Database,
  chainId: number,
  blockNumber: number,
): Promise<
  Array<{ observationId: string; trackedAddress: string; blockNumber: string; blockHash: string }>
> {
  const { results } = await db
    .prepare(
      "SELECT id, tracked_address, block_hash FROM activity_observations WHERE chain_id = ? AND block_number = ? AND status = 'observed'",
    )
    .bind(chainId, blockNumber)
    .all<{
      id: string;
      tracked_address: Uint8Array | ArrayBuffer;
      block_hash: Uint8Array | ArrayBuffer;
    }>();
  const rows = results.map((r) => ({
    observationId: String(r.id),
    trackedAddress: addressBytesToHex(r.tracked_address),
    blockHash: _bytesToHex(
      r.block_hash instanceof ArrayBuffer ? new Uint8Array(r.block_hash) : r.block_hash,
    ),
    blockNumber: String(blockNumber),
  }));
  await db
    .prepare(
      "UPDATE activity_observations SET status = 'reverted', reverted_at = ? WHERE chain_id = ? AND block_number = ? AND status = 'observed'",
    )
    .bind(nowISO(), chainId, blockNumber)
    .run();
  return rows;
}

/** All terminal dead-lettered deliveries with the data needed to replay them. */
export async function listDeadLetterDeliveries(
  db: D1Database,
  limit = 500,
): Promise<
  Array<{
    deliveryId: string;
    webhookId: string;
    eventId: string;
    eventType: string;
    accountId: string;
    chainId: number | null;
  }>
> {
  const { results } = await db
    .prepare(
      "SELECT id, chain_id, webhook_id, event_id, event_type, account_id FROM webhook_deliveries WHERE status = 'dead_lettered' ORDER BY created_at ASC LIMIT ?",
    )
    .bind(limit)
    .all<Record<string, unknown>>();
  return results.map((r) => ({
    deliveryId: String(r.id),
    webhookId: String(r.webhook_id),
    eventId: String(r.event_id),
    eventType: String(r.event_type),
    accountId: String(r.account_id),
    chainId: r.chain_id === null ? null : Number(r.chain_id),
  }));
}

/** Marks a dead-lettered delivery pending so the next pass redelivers it. */
export async function reopenDelivery(db: D1Database, deliveryId: string): Promise<void> {
  await db
    .prepare(
      "UPDATE webhook_deliveries SET status = 'pending', last_error = NULL, updated_at = ? WHERE id = ?",
    )
    .bind(nowISO(), deliveryId)
    .run();
}

/** Lightweight metrics aggregates from the control/store tables. */
export async function metricsSummary(db: D1Database): Promise<{
  activeChains: number;
  observations: { observed: number; reverted: number };
  deliveries: { pending: number; success: number; failed: number; dead_lettered: number };
  pendingCommands: number;
}> {
  const [activeChains, obsRows, delRows, pendingCommands] = await Promise.all([
    db
      .prepare("SELECT COUNT(*) AS c FROM chain_registry WHERE status IN ('active','degraded')")
      .first<{ c: number }>(),
    db
      .prepare("SELECT status, COUNT(*) AS c FROM activity_observations GROUP BY status")
      .all<{ status: string; c: number }>(),
    db
      .prepare("SELECT status, COUNT(*) AS c FROM webhook_deliveries GROUP BY status")
      .all<{ status: string; c: number }>(),
    db
      .prepare("SELECT COUNT(*) AS c FROM scanner_operations WHERE status = 'pending'")
      .first<{ c: number }>(),
  ]);
  const count = (rows: Array<{ status: string; c: number }>, key: string) =>
    rows.find((r) => r.status === key)?.c ?? 0;
  return {
    activeChains: Number(activeChains?.c ?? 0),
    observations: {
      observed: count(obsRows?.results ?? [], "observed"),
      reverted: count(obsRows?.results ?? [], "reverted"),
    },
    deliveries: {
      pending: count(delRows?.results ?? [], "pending"),
      success: count(delRows?.results ?? [], "success"),
      failed: count(delRows?.results ?? [], "failed"),
      dead_lettered: count(delRows?.results ?? [], "dead_lettered"),
    },
    pendingCommands: Number(pendingCommands?.c ?? 0),
  };
}

function hexToBytes(hex: string): Uint8Array {
  return _hexToBytes(hex as `0x${string}`);
}

function addressBytesToHex(bytes: Uint8Array | ArrayBuffer): string {
  const u8 = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  return _bytesToHex(u8);
}

// ---------------------------------------------------------------------------
// Milestone 3: fanout + delivery
// ---------------------------------------------------------------------------

/** Observable row lookup used by the fanout consumer. */
export type ObservationRow = {
  observationId: string;
  chainId: number;
  blockNumber: string;
  blockHash: string;
  trackedAddress: string;
  data: string; // the stored observation `data` JSON
};

export async function getObservationPayload(
  db: D1Database,
  observationId: string,
): Promise<ObservationRow | null> {
  const row = await db
    .prepare("SELECT * FROM activity_observations WHERE id = ?")
    .bind(observationId)
    .first<Record<string, unknown>>();
  if (row === null) return null;
  return {
    observationId: String(row.id),
    chainId: Number(row.chain_id),
    blockNumber: String(row.block_number),
    blockHash: _bytesToHex(row.block_hash as Uint8Array),
    trackedAddress: _bytesToHex(row.tracked_address as Uint8Array),
    data: String(row.payload),
  };
}

/**
 * Subscriptions on a chain+address that are active and eligible to receive
 * activity (active_from_block null or <= the activity block).
 */
export async function listEligibleSubscriptions(
  db: D1Database,
  chainId: number,
  trackedAddress: string,
  fromBlock: number,
): Promise<
  Array<{ id: string; account_id: string; webhook_id: string; active_from_block: number | null }>
> {
  const { results } = await db
    .prepare(
      "SELECT id, account_id, webhook_id, active_from_block FROM subscriptions WHERE chain_id = ? AND address = ? AND status = 'active' AND deleted_at IS NULL AND (active_from_block IS NULL OR active_from_block <= ?)",
    )
    .bind(chainId, hexToBytes(trackedAddress), fromBlock)
    .all<{
      id: string;
      account_id: string;
      webhook_id: string;
      active_from_block: number | null;
    }>();
  return results.map((r) => ({
    id: r.id,
    account_id: r.account_id,
    webhook_id: r.webhook_id,
    active_from_block: r.active_from_block === null ? null : Number(r.active_from_block),
  }));
}

/** Webhook without account scoping (used by the delivery consumer). */
export async function getWebhookById(
  db: D1Database,
  webhookId: string,
): Promise<WebhookRow | null> {
  const row = await db
    .prepare("SELECT * FROM webhooks WHERE id = ?")
    .bind(webhookId)
    .first<Record<string, unknown>>();
  return row === null ? null : toWebhookRow(row);
}

/** True when a delivery for (webhook, event, type) already succeeded. */
export async function hasSuccessfulDelivery(
  db: D1Database,
  webhookId: string,
  eventId: string,
  eventType: WebhookDeliveryRow["event_type"],
): Promise<boolean> {
  const row = await db
    .prepare(
      "SELECT 1 FROM webhook_deliveries WHERE webhook_id = ? AND event_id = ? AND event_type = ? AND status = 'success' LIMIT 1",
    )
    .bind(webhookId, eventId, eventType)
    .first();
  return row !== null;
}

/** A delivery row for a (webhook, event, type), if any. */
export async function getDeliveryByEvent(
  db: D1Database,
  webhookId: string,
  eventId: string,
  eventType: WebhookDeliveryRow["event_type"],
): Promise<WebhookDeliveryRow | null> {
  const row = await db
    .prepare(
      "SELECT * FROM webhook_deliveries WHERE webhook_id = ? AND event_id = ? AND event_type = ?",
    )
    .bind(webhookId, eventId, eventType)
    .first<Record<string, unknown>>();
  return row === null ? null : toDeliveryRow(row);
}

export async function updateDelivery(
  db: D1Database,
  deliveryId: string,
  fields: {
    status: WebhookDeliveryRow["status"];
    attempts: number;
    last_response_status?: number | null;
    last_error?: string | null;
    next_retry_at?: string | null;
  },
): Promise<void> {
  const sets = ["status = ?", "attempts = ?", "updated_at = ?"];
  const params: unknown[] = [fields.status, fields.attempts, nowISO()];
  if (fields.last_response_status !== undefined) {
    sets.push("last_response_status = ?");
    params.push(fields.last_response_status);
  }
  if (fields.last_error !== undefined) {
    sets.push("last_error = ?");
    params.push(fields.last_error);
  }
  if (fields.next_retry_at !== undefined) {
    sets.push("next_retry_at = ?");
    params.push(fields.next_retry_at);
  }
  params.push(deliveryId);
  await db
    .prepare(`UPDATE webhook_deliveries SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...params)
    .run();
}
