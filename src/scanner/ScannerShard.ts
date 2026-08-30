import {
  getCommand,
  markCommandApplied,
  markCommandFailed,
  setSubscriptionStatus,
  updateChainRegistryStatus,
  getChainRegistry,
  listTrackedAddressesForChain,
  setChainCursor,
  setActiveFromBlockForChain,
  upsertObservation,
} from "../db/repository";
import { resolveChain } from "../rpc/chain";
import {
  ethBlockNumber,
  ethGetBlockByNumber,
  ethGetLogs,
  ethGetTransactionReceipt,
} from "../rpc/client";
import { analyzeBlock, finalizeBundles, observationData } from "../domain/activity";
import { enqueueMatched } from "./queue";
import type { Env } from "../env";

const MAX_BLOCKS_PER_PASS = 20;
const MIN_POLL_INTERVAL_MS = 1_000;
const MAX_POLL_INTERVAL_MS = 30_000;

/**
 * Scanner shard Durable Object (Milestone 2). Each instance owns a single chain
 * (named `chain-<chainId>`), schedules its own alarm, and scans blocks up to the
 * chain head: it fetches the full block and its exact-block-hash logs, matches
 * tracked activity into deterministic bundles, finalizes with receipts, persists
 * observations, enqueues one message per bundle, and only then advances the
 * cursor. A reorg / parent-hash mismatch degrades the chain without advancing.
 *
 * It also finalizes Milestone-1 control-plane commands (subscribe/unsubscribe)
 * so the migration path keeps working.
 */
export class ScannerShard {
  private state: DurableObjectState;
  private env: Env;
  private db: D1Database;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.db = env.DB;
  }

  private chainId(): number {
    const name = this.state.id.name ?? "";
    const digits = name.replace(/^chain-/, "");
    const parsed = Number.parseInt(digits, 10);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/apply" && request.method === "POST") {
      let body: { commandId?: unknown };
      try {
        body = (await request.json()) as { commandId?: unknown };
      } catch {
        return json("Malformed body", 400);
      }
      if (typeof body.commandId !== "string") {
        return json("Missing commandId", 400);
      }
      await this.applyCommand(body.commandId);
      return json("ok", 200);
    }
    if (url.pathname === "/scan") {
      const chainId = this.chainId();
      if (Number.isNaN(chainId)) return json("no chain", 400);
      await this.scanChain(chainId);
      return json("ok", 200);
    }
    return json("Not found", 404);
  }

  async alarm(): Promise<void> {
    const chainId = this.chainId();
    if (Number.isNaN(chainId)) return;
    await this.scanChain(chainId);
  }

  // -------------------------------------------------------------------------
  // Scanning
  // -------------------------------------------------------------------------

  private async scanChain(chainId: number): Promise<void> {
    const tracked = await listTrackedAddressesForChain(this.db, chainId);
    if (tracked.length === 0) {
      await this.schedule(30_000);
      return;
    }
    const trackedSet = new Set(tracked) as Set<`0x${string}`>;

    let head: bigint;
    try {
      head = await ethBlockNumber({ baseUrl: this.env.RPC_RACER_BASE_URL, chainId });
    } catch {
      await this.schedule(MIN_POLL_INTERVAL_MS);
      return;
    }

    const chain = await getChainRegistry(this.db, chainId);
    const cursor = chain?.cursor_block === null ? null : (chain?.cursor_block ?? null);
    const cursorHash = chain?.cursor_hash ?? null;

    // First activation: anchor the cursor at the head (real hash) and set the
    // subscription boundary so no historical (pre-subscription) activity is
    // delivered.
    if (cursor === null) {
      const headBlock = await ethGetBlockByNumber({
        baseUrl: this.env.RPC_RACER_BASE_URL,
        chainId,
        blockNumber: head,
        includeTransactions: false,
      });
      await setChainCursor(this.db, chainId, Number(head), headBlock.hash);
      await setActiveFromBlockForChain(this.db, chainId, Number(head) + 1);
      await this.schedule(pollInterval(head, chain?.block_speed_ms ?? null));
      return;
    }

    const start = BigInt(cursor) + 1n;
    const end = head;
    if (start > end) {
      await this.schedule(pollInterval(head, chain?.block_speed_ms ?? null));
      return;
    }

    let processed = 0;
    for (
      let blockNumber = start;
      blockNumber <= end && processed < MAX_BLOCKS_PER_PASS;
      blockNumber += 1n, processed += 1
    ) {
      try {
        const block = await ethGetBlockByNumber({
          baseUrl: this.env.RPC_RACER_BASE_URL,
          chainId,
          blockNumber,
        });
        if (cursorHash !== null && block.parentHash !== cursorHash) {
          await updateChainRegistryStatus(this.db, chainId, {
            status: "degraded",
            reason: "parent-hash mismatch (probable reorg); resumable on next pass in M4",
          });
          await this.schedule(MIN_POLL_INTERVAL_MS);
          return;
        }
        await this.processBlock({ chainId, block, trackedSet });
        await setChainCursor(this.db, chainId, Number(block.number), block.hash);
      } catch (error) {
        // Incomplete processing: do not advance the cursor beyond this block.
        console.error(`scan error on chain ${chainId} block ${blockNumber}`, error);
        await this.schedule(MIN_POLL_INTERVAL_MS);
        return;
      }
    }

    const nextInterval =
      processed >= MAX_BLOCKS_PER_PASS
        ? MIN_POLL_INTERVAL_MS
        : pollInterval(head, chain?.block_speed_ms ?? null);
    await this.schedule(nextInterval);
  }

  private async processBlock({
    chainId,
    block,
    trackedSet,
  }: {
    chainId: number;
    block: import("../domain/activity").NormalizedBlock;
    trackedSet: Set<`0x${string}`>;
  }): Promise<void> {
    // Consistent read: logs are keyed by the exact block hash we just fetched.
    const logs = await ethGetLogs({
      baseUrl: this.env.RPC_RACER_BASE_URL,
      chainId,
      blockHash: block.hash,
    });

    const analyzed = analyzeBlock({ block, logs, tracked: trackedSet });

    const receipts = new Map();
    for (const txHash of analyzed.receiptHashes) {
      const receipt = await ethGetTransactionReceipt({
        baseUrl: this.env.RPC_RACER_BASE_URL,
        chainId,
        txHash: txHash as `0x${string}`,
      });
      if (receipt !== null) receipts.set(txHash, receipt);
    }

    const observations = await finalizeBundles({
      chainId,
      block,
      drafts: analyzed.drafts,
      receipts,
    });

    for (const observation of observations) {
      const inserted = await upsertObservation(this.db, {
        observationId: observation.observationId,
        chainId: observation.chainId,
        txHash: observation.transaction.hash,
        trackedAddress: observation.trackedAddress,
        blockNumber: observation.blockNumber,
        blockHash: observation.blockHash,
        status: observation.transaction.status === "success" ? "observed" : "reverted",
        initiator: observation.transaction.from,
        payload: JSON.stringify(observationData(observation)),
      });
      // Enqueue every matched observation (bundles -> queue in M3).
      void inserted;
      await enqueueMatched({
        queue: this.env.MATCHED_ACTIVITY_QUEUE,
        observations: [
          {
            observationId: observation.observationId,
            chainId: observation.chainId,
            txHash: observation.transaction.hash,
            trackedAddress: observation.trackedAddress,
            blockNumber: observation.blockNumber,
            blockHash: observation.blockHash,
          },
        ],
      });
    }
  }

  // -------------------------------------------------------------------------
  // Scheduling
  // -------------------------------------------------------------------------

  private async schedule(delayMs: number): Promise<void> {
    const at = Date.now() + delayMs;
    const existing = await this.state.storage.getAlarm();
    if (typeof existing === "number" && existing <= at) return;
    await this.state.storage.setAlarm(at);
  }

  // -------------------------------------------------------------------------
  // Control-plane command application (delegates to M1 behavior + activation)
  // -------------------------------------------------------------------------

  private async applyCommand(commandId: string): Promise<void> {
    const command = await getCommand(this.db, commandId);
    if (command === null || command.status !== "pending") return;

    if (command.kind === "subscribe") await this.handleSubscribe(command);
    else if (command.kind === "unsubscribe") await markCommandApplied(this.db, commandId);
    else if (command.kind === "retry_chain")
      await this.handleRetryChain(commandId, command.chain_id);
  }

  private async handleSubscribe(command: CommandRow): Promise<void> {
    const chainId = command.chain_id;
    const subscriptionId = command.subscription_id;
    const chain = await getChainRegistry(this.db, chainId);
    const wasActive = chain?.status === "active" || chain?.cursor_block !== null;

    const resolved = await resolveChain({ baseUrl: this.env.RPC_RACER_BASE_URL, chainId });
    if (!resolved.ok) {
      if (resolved.reason === "unknown_chain") {
        await updateChainRegistryStatus(this.db, chainId, {
          status: "unsupported",
          reason: resolved.detail ?? "Unknown chain",
          shard_id: chainId % shardCountValue(this.env),
          last_probe_at: new Date().toISOString(),
        });
        if (subscriptionId !== null) {
          await setSubscriptionStatus(this.db, subscriptionId, "unsupported", {
            reason: resolved.detail ?? "Unknown chain",
          });
        }
        await markCommandApplied(this.db, command.id);
        return;
      }
      await markCommandFailed(
        this.db,
        command.id,
        "Chain resolution failed transiently",
        command.attempts,
      );
      return;
    }

    await updateChainRegistryStatus(this.db, chainId, {
      status: "active",
      shard_id: chainId % shardCountValue(this.env),
      name: resolved.chain.name,
      last_probe_at: new Date().toISOString(),
      block_speed_ms: resolved.chain.blockSpeedMs ?? null,
    });

    if (subscriptionId !== null) {
      await setSubscriptionStatus(this.db, subscriptionId, "active");
    }

    // Start scanning immediately if this is the chain's first activation.
    if (!wasActive) {
      await this.schedule(0);
    }
    await markCommandApplied(this.db, command.id);
  }

  private async handleRetryChain(commandId: string, chainId: number): Promise<void> {
    const resolved = await resolveChain({ baseUrl: this.env.RPC_RACER_BASE_URL, chainId });
    if (!resolved.ok) {
      if (resolved.reason === "unknown_chain") {
        await updateChainRegistryStatus(this.db, chainId, {
          status: "unsupported",
          reason: "Unknown chain",
          last_probe_at: new Date().toISOString(),
        });
      } else {
        await markCommandFailed(this.db, commandId, "transient", 0);
        return;
      }
    } else {
      await updateChainRegistryStatus(this.db, chainId, {
        status: "active",
        shard_id: chainId % shardCountValue(this.env),
        name: resolved.chain.name,
        last_probe_at: new Date().toISOString(),
      });
      await reactivateUnsupportedSubscriptions(this.db, chainId);
    }
    await markCommandApplied(this.db, commandId);
  }
}

function pollInterval(head: bigint, blockSpeedMs: number | null): number {
  if (blockSpeedMs !== null && Number.isFinite(blockSpeedMs) && blockSpeedMs > 0) {
    return Math.min(
      Math.max(Math.round(blockSpeedMs / 2), MIN_POLL_INTERVAL_MS),
      MAX_POLL_INTERVAL_MS,
    );
  }
  return MIN_POLL_INTERVAL_MS;
}

async function reactivateUnsupportedSubscriptions(db: D1Database, chainId: number): Promise<void> {
  await db
    .prepare(
      "UPDATE subscriptions SET status = 'active', updated_at = ? WHERE chain_id = ? AND status = 'unsupported' AND deleted_at IS NULL",
    )
    .bind(new Date().toISOString(), chainId)
    .run();
}

function shardCountValue(env: Env): number {
  const parsed = Number.parseInt(env.SCANNER_SHARD_COUNT, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2;
}

type CommandRow = {
  id: string;
  chain_id: number;
  kind: "subscribe" | "unsubscribe" | "retry_chain";
  subscription_id: string | null;
  attempts: number;
};

function json(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
