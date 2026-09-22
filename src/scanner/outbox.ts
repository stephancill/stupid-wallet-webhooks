import type { Env } from "../env";
import { commandId } from "../domain/ids";
import { listPendingCommands, type ScannerCommandRow } from "../db/repository";
import { bytesToHex } from "viem";

/**
 * Scanner command outbox. Control-plane changes and their scanner commands are
 * committed to D1 in a single batch, then the command is dispatched to the
 * owning scanner shard. A reconciliation job redelivers unapplied commands,
 * closing the window where D1 commits but the process dies before dispatch.
 */

export type SubLocalState = {
  subscriptionId: string;
  chainId: number;
  address: Uint8Array;
  chainName?: string;
};

export async function newCommandId(
  kind: "subscribe" | "unsubscribe",
  subscriptionId: string,
): Promise<string> {
  // SQL cascades use the same deterministic unsubscribe id for every subscription.
  if (kind === "unsubscribe") return `cmd_unsubscribe_${subscriptionId}`;
  return commandId(`${kind}:${subscriptionId}`);
}

function shardCount(env: Env): number {
  const parsed = Number.parseInt(env.SCANNER_SHARD_COUNT, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2;
}

function shardNamespaceFor(env: Env, chainId: number): DurableObjectNamespace {
  return chainId % shardCount(env) === 0 ? env.SCANNER_SHARD_1 : env.SCANNER_SHARD_2;
}

/** Dispatches a command row to its owning scanner shard Durable Object. */
export async function dispatchCommand(
  env: Env,
  command: Pick<ScannerCommandRow, "id" | "chain_id">,
): Promise<void> {
  const namespace = shardNamespaceFor(env, command.chain_id);
  const stub = namespace.get(namespace.idFromName(`chain-${command.chain_id}`));
  const response = await stub.fetch("https://scanner.internal/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commandId: command.id }),
  });
  if (!response.ok)
    throw new Error(`Scanner command ${command.id} dispatch failed: HTTP ${response.status}`);
}

function trackedAddressId(chainId: number, address: Uint8Array): string {
  return `ta_${chainId}_${bytesToHex(address)}`;
}

/**
 * Commits a pending subscription together with its tracked-address reference,
 * chain registry entry, and idempotent scanner command in one D1 batch, then
 * dispatches the command. If the same tuple is already active (or a concurrent
 * request won the race), the partial unique index rejects the insert and the
 * whole batch rolls back, leaving no partial state; a thrown DuplicateTupleError
 * lets the caller report a conflict.
 */
export async function submitScrSubscribe({
  db,
  env,
  state,
  accountId,
  webhookId,
}: {
  db: D1Database;
  env: Env;
  state: SubLocalState;
  accountId: string;
  webhookId: string;
}): Promise<void> {
  const id = await newCommandId("subscribe", state.subscriptionId);
  const now = new Date().toISOString();

  let changes = 0;
  try {
    const results = await db.batch([
      db
        .prepare(
          "INSERT INTO subscriptions (id, account_id, webhook_id, address, chain_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)",
        )
        .bind(state.subscriptionId, accountId, webhookId, state.address, state.chainId, now, now),
      db
        .prepare(
          "INSERT INTO tracked_addresses (id, chain_id, address, ref_count, updated_at) VALUES (?, ?, ?, 1, ?) ON CONFLICT(chain_id, address) DO UPDATE SET ref_count = ref_count + 1, updated_at = excluded.updated_at",
        )
        .bind(trackedAddressId(state.chainId, state.address), state.chainId, state.address, now),
      db
        .prepare(
          "INSERT INTO chain_registry (chain_id, name, status, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?) ON CONFLICT(chain_id) DO UPDATE SET name = COALESCE(excluded.name, chain_registry.name), updated_at = excluded.updated_at",
        )
        .bind(state.chainId, state.chainName ?? null, now, now),
      db
        .prepare(
          "INSERT INTO scanner_operations (id, chain_id, kind, address, subscription_id, payload, status, created_at, updated_at) VALUES (?, ?, 'subscribe', ?, ?, ?, 'pending', ?, ?)",
        )
        .bind(
          id,
          state.chainId,
          state.address,
          state.subscriptionId,
          JSON.stringify({ chainId: state.chainId, subscriptionId: state.subscriptionId }),
          now,
          now,
        ),
    ]);
    for (const result of results) {
      changes += result.meta.changes ?? 0;
    }
  } catch (error) {
    // Only a genuine active-tuple violation should read as a duplicate; log
    // anything else so real D1 errors surface instead of being mislabeled.
    const isUniqueViolation = error instanceof Error && /unique constraint/im.test(error.message);
    if (!isUniqueViolation) {
      console.error("subscription batch failed", error);
      throw error;
    }
    throw new DuplicateTupleError();
  }

  if (changes === 0) {
    // Insert was rejected (already-active tuple); treat as a duplicate.
    throw new DuplicateTupleError();
  }

  await dispatchCommand(env, { id, chain_id: state.chainId });
}

/**
 * Marks a subscription deleting, decrements the tracked-address reference, and
 * commits an idempotent unsubscribe command in one batch, then dispatches it.
 * Repeated deletion succeeds without decrementing reference counts again.
 */
export async function submitScrUnsubscribe({
  db,
  env,
  state,
}: {
  db: D1Database;
  env: Env;
  state: SubLocalState;
}): Promise<boolean> {
  const id = await newCommandId("unsubscribe", state.subscriptionId);
  const now = new Date().toISOString();

  const subscription = await db
    .prepare("SELECT id FROM subscriptions WHERE id = ?")
    .bind(state.subscriptionId)
    .first();
  if (subscription === null) return false;
  await db.batch(
    unsubscribeStatements({ db, scope: "s.id = ?", params: [state.subscriptionId], now }),
  );

  await dispatchCommand(env, { id, chain_id: state.chainId });
  return true;
}

/** All scoped subscriptions, references and outbox commands change in one transaction. */
function unsubscribeStatements({
  db,
  scope,
  params,
  now,
}: {
  db: D1Database;
  scope: string;
  params: string[];
  now: string;
}): D1PreparedStatement[] {
  const live = `${scope} AND s.deleted_at IS NULL AND s.status != 'deleting'`;
  const references = `SELECT COUNT(*) FROM subscriptions s WHERE ${live} AND s.chain_id = tracked_addresses.chain_id AND s.address = tracked_addresses.address`;
  return [
    db
      .prepare(
        `INSERT OR IGNORE INTO scanner_operations (id, chain_id, kind, address, subscription_id, payload, status, created_at, updated_at) SELECT 'cmd_unsubscribe_' || s.id, s.chain_id, 'unsubscribe', s.address, s.id, json_object('chainId', s.chain_id, 'subscriptionId', s.id), 'pending', ?, ? FROM subscriptions s WHERE ${live}`,
      )
      .bind(now, now, ...params),
    db
      .prepare(
        `UPDATE tracked_addresses SET ref_count = ref_count - (${references}), updated_at = ? WHERE (${references}) > 0`,
      )
      .bind(...params, now, ...params),
    db
      .prepare(
        `DELETE FROM tracked_addresses WHERE ref_count <= 0 AND EXISTS (SELECT 1 FROM subscriptions s WHERE ${live} AND s.chain_id = tracked_addresses.chain_id AND s.address = tracked_addresses.address)`,
      )
      .bind(...params),
    db
      .prepare(
        `UPDATE subscriptions AS s SET status = 'deleting', deleted_at = ?, updated_at = ? WHERE ${live}`,
      )
      .bind(now, now, ...params),
  ];
}

/** Soft-delete the endpoint and its complete cascade, including > one API page. */
export async function submitWebhookDelete({
  db,
  env,
  webhookId,
  accountId,
}: {
  db: D1Database;
  env: Env;
  webhookId: string;
  accountId: string;
}): Promise<void> {
  await db.batch([
    db
      .prepare("UPDATE webhooks SET status = 'inactive' WHERE id = ? AND account_id = ?")
      .bind(webhookId, accountId),
    ...unsubscribeStatements({
      db,
      scope: "s.webhook_id = ? AND s.account_id = ?",
      params: [webhookId, accountId],
      now: new Date().toISOString(),
    }),
  ]);
  // Large cascades are durable immediately; reconciliation dispatches the remainder.
  const { results } = await db
    .prepare(
      "SELECT o.id, o.chain_id FROM scanner_operations o JOIN subscriptions s ON s.id = o.subscription_id WHERE s.webhook_id = ? AND s.account_id = ? AND o.kind = 'unsubscribe' AND o.status = 'pending' LIMIT 200",
    )
    .bind(webhookId, accountId)
    .all<{ id: string; chain_id: number }>();
  for (const command of results) await dispatchCommand(env, command);
}

/** Redelivers every pending scanner command through the reconciliation job. */
export async function redispatchPending({
  db,
  env,
}: {
  db: D1Database;
  env: Env;
}): Promise<ScannerCommandRow[]> {
  const pending = await listPendingCommands(db);
  for (const row of pending) {
    await dispatchCommand(env, { id: row.id, chain_id: row.chain_id });
  }
  return pending;
}

export class DuplicateTupleError extends Error {
  constructor() {
    super("An active subscription already exists for this webhook, address, and chain.");
    this.name = "DuplicateTupleError";
  }
}
