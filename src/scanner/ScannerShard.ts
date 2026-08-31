import {
  getCommand,
  markCommandApplied,
  markCommandFailed,
  setSubscriptionStatus,
  updateChainRegistryStatus,
  getChainRegistry,
  listTrackedAddressesForChain,
  setChainCursor,
  setChainCursorAndHead,
  setActiveFromBlockForChain,
  upsertObservation,
  markBlockRevertedAndList,
  listEligibleSubscriptions,
} from "../db/repository";
import { resolveChain } from "../rpc/chain";
import {
  ethBlockNumber,
  ethGetBlockByNumber,
  ethGetTransactionReceipts,
  setInternalRpc,
  fetchBlockAndLogs,
} from "../rpc/client";
import { analyzeBlock, finalizeBundles, observationData } from "../domain/activity";
import { classifyChain, pushWindow, pruneTo, type HeldBlock } from "../domain/reorg";
import { planRevertedDeliveries } from "../queues/plan";
import { enqueueMatched } from "./queue";
import type { DeliveryHook, Env } from "../env";

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

  /** Highest successfully scanned block tip pending a D1 checkpoint. */
  private pendingTip: { number: number; hash: string } | null = null;
  /** Head observed this scan (flushed together with the cursor on a budget). */
  private pendingHead: number | null = null;
  /** Last epoch-ms we wrote the D1 cursor for this shard (cached, then DO-backed). */
  private cursorFlushAt: number | null = null;
  /** Consecutive failures on the same block (drives the skip-a-poisoned-block guard). */
  private blockFailures: { block: bigint; count: number } | null = null;

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
    if (url.pathname === "/wake" && request.method === "POST") {
      await this.schedule(0);
      return json("ok", 200);
    }
    // Operator override: force re-anchoring to a recent head and rescan, even if
    // the consecutive-unresolvable threshold hasn't been reached.
    if (url.pathname === "/re-anchor") {
      const chainId = this.chainId();
      if (Number.isNaN(chainId)) return json("no chain", 400);
      let head: bigint;
      try {
        head = await ethBlockNumber({ baseUrl: this.env.RPC_RACER_BASE_URL, chainId });
      } catch {
        return json("head read failed", 502);
      }
      await this.state.storage.put("unresolvableCount", 0);
      await this.recoverFromUnresolvable(chainId, Number(head));
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
    // Use rpc-racer's private path (bypasses the public rate limit) when we have
    // the shared secret configured; otherwise fall back to the public feed.
    const secret = this.env.RPC_INTERNAL_SECRET?.trim();
    if (secret) {
      const fanout = Number.parseInt(this.env.RPC_SCANNER_FANOUT ?? "2", 10);
      setInternalRpc({ secret, fanout: Number.isFinite(fanout) && fanout > 0 ? fanout : 2 });
    }
    const tracked = await listTrackedAddressesForChain(this.db, chainId);
    if (tracked.length === 0) {
      await this.schedule(this.catchUpMs());
      return;
    }
    const trackedSet = new Set(tracked) as Set<`0x${string}`>;

    let head: bigint;
    try {
      head = await ethBlockNumber({ baseUrl: this.env.RPC_RACER_BASE_URL, chainId });
    } catch (error) {
      console.error(`scan: head read failed [chain ${chainId}]`, String(error));
      await this.schedule(this.catchUpMs());
      return;
    }
    // Coalesce the head write with the cursor checkpoint (no per-poll UPDATE).
    this.pendingHead = Number(head);

    const chain = await getChainRegistry(this.db, chainId);
    if (chain?.status === "paused") {
      await this.schedule(30_000);
      return;
    }

    // Resume position. The Durable Object's block window is authoritative and
    // current; the D1 cursor is only a coarse checkpoint persisted on a budget
    // (see `maybeFlushCursor`). Prefer the window so a throttled D1 cursor never
    // causes blocks to be re-scanned (and their observations re-enqueued).
    let window = await this.loadWindow();
    const windowTip = window.length > 0 ? window[window.length - 1] : null;
    const cursor = windowTip ? windowTip.number : (chain?.cursor_block ?? null);
    const cursorHash = windowTip ? windowTip.hash : (chain?.cursor_hash ?? null);

    // First activation: anchor the cursor at the head (real hash) and set it as
    // the tip of the rolling window.
    if (cursor === null) {
      const headBlock = await ethGetBlockByNumber({
        baseUrl: this.env.RPC_RACER_BASE_URL,
        chainId,
        blockNumber: head,
        includeTransactions: false,
      });
      window = [{ number: Number(head), hash: headBlock.hash, parentHash: headBlock.parentHash }];
      this.pendingTip = { number: Number(head), hash: headBlock.hash };
      await setChainCursor(this.db, chainId, Number(head), headBlock.hash);
      await setActiveFromBlockForChain(this.db, chainId, Number(head) + 1);
      await this.saveWindow(window);
      await this.schedule(
        pollInterval(head, chain?.block_speed_ms ?? null, this.catchUpMs(), MAX_POLL_INTERVAL_MS),
      );
      return;
    }

    const start = BigInt(cursor) + 1n;
    const end = head;
    if (start > end) {
      await this.schedule(
        pollInterval(head, chain?.block_speed_ms ?? null, this.catchUpMs(), MAX_POLL_INTERVAL_MS),
      );
      return;
    }

    let processed = 0;
    let blockNumber = start;
    let lastHash = cursorHash;

    while (blockNumber <= end && processed < this.maxBlocksPerPass()) {
      // One batched request fetches the block header + its logs (instead of two
      // calls), cutting rpc-racer requests per block roughly in half.
      let block: import("../domain/activity").NormalizedBlock;
      let logs: import("../domain/activity").NormalizedLog[];
      try {
        ({ block, logs } = await fetchBlockAndLogs({
          baseUrl: this.env.RPC_RACER_BASE_URL,
          chainId,
          blockNumber,
        }));
      } catch (error) {
        console.error(
          `scan block fetch failed [chain ${chainId} block ${blockNumber}]`,
          String(error),
        );
        if (await this.registerBlockFailure(chainId, blockNumber)) return;
        await this.schedule(this.catchUpMs());
        return;
      }
      const verdict = classifyChain(window, { parentHash: block.parentHash, cursorHash: lastHash });

      if (verdict.kind === "ok") {
        try {
          await this.processBlock({ chainId, block, logs, trackedSet });
        } catch (error) {
          console.error(`scan error on chain ${chainId} block ${blockNumber}`, error);
          if (await this.registerBlockFailure(chainId, blockNumber)) return;
          await this.schedule(this.catchUpMs());
          return;
        }
        this.blockFailures = null;
        const held = {
          number: Number(block.number),
          hash: block.hash,
          parentHash: block.parentHash,
        };
        window = pushWindow(window, held);
        lastHash = block.hash;
        // Persist the cursor to D1 on a time budget (not per block) and defer the
        // durable window write to the end of the pass.
        this.pendingTip = { number: Number(block.number), hash: block.hash };
        await this.maybeFlushCursor();
        blockNumber += 1n;
        processed += 1;
      } else if (verdict.kind === "reorg") {
        let revertedTotal = 0;
        const revertedDeliveries: Array<{ id: string; body: DeliveryHook }> = [];
        for (const orphan of verdict.orphaned) {
          const revertedRows = await markBlockRevertedAndList(this.db, chainId, orphan);
          revertedTotal += revertedRows.length;
          for (const row of revertedRows) {
            const subs = await listEligibleSubscriptions(
              this.db,
              chainId,
              row.trackedAddress,
              Number(row.blockNumber),
            );
            for (const planned of planRevertedDeliveries({
              observation: { ...row, chainId },
              subscriptions: subs,
            })) {
              revertedDeliveries.push({ id: planned.key, body: planned.body });
            }
          }
        }
        if (revertedDeliveries.length > 0) {
          await this.env.WEBHOOK_DELIVERY_QUEUE.sendBatch(revertedDeliveries);
        }
        window = pruneTo(window, verdict.ancestor);
        await this.saveWindow(window);
        await setChainCursor(this.db, chainId, verdict.ancestor.number, verdict.ancestor.hash);
        lastHash = verdict.ancestor.hash;
        console.log(
          `reorg on chain ${chainId}: depth ${verdict.orphaned.length}, ${revertedTotal} observation(s) reverted; replaying`,
        );
        // Replay this block now that its parent is the found ancestor; we do not
        // advance `blockNumber`, so the loop reprocesses it canonically.
      } else {
        // Unresolvable (no shared ancestor in the retained window). Park as
        // degraded for a few consecutive tries; if it persists, the cursor is
        // unrecoverable, so re-anchor to a recent canonical block and rescan the
        // trailing window (idempotent + dedup-guarded, so nothing double-delivers).
        const tries = ((await this.state.storage.get<number>("unresolvableCount")) ?? 0) + 1;
        await this.state.storage.put("unresolvableCount", tries);
        if (tries < this.unresolvableLimit()) {
          await updateChainRegistryStatus(this.db, chainId, {
            status: "degraded",
            reason: "no common ancestor within retained window (deep reorg)",
          });
          // Keep metrics honest: the anomaly path still records the observed head.
          await this.persistHeadOnly(chainId, Number(head));
          await this.schedule(this.catchUpMs());
          return;
        }
        await this.state.storage.put("unresolvableCount", 0);
        await this.recoverFromUnresolvable(chainId, Number(head));
        await this.schedule(this.catchUpMs());
        return;
      }
    }

    // Durably persist the accepted window (the Durable Object's authoritative
    // cursor). The D1 checkpoint remains time-budgeted via `maybeFlushCursor`.
    await this.saveWindow(window);
    await this.maybeFlushCursor();

    const nextInterval =
      processed >= this.maxBlocksPerPass()
        ? this.catchUpMs()
        : pollInterval(head, chain?.block_speed_ms ?? null, this.catchUpMs(), MAX_POLL_INTERVAL_MS);
    await this.schedule(nextInterval);
  }

  private async loadWindow(): Promise<HeldBlock[]> {
    const stored = await this.state.storage.get<HeldBlock[]>("blockWindow");
    return Array.isArray(stored) ? stored : [];
  }

  private async saveWindow(window: HeldBlock[]): Promise<void> {
    await this.state.storage.put("blockWindow", window);
  }

  /** Consecutive `unresolvable` scans before the shard auto re-anchors (env, default 3). */
  private unresolvableLimit(): number {
    const parsed = Number.parseInt(this.env.SCANNER_UNRESOLVABLE_LIMIT ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 3;
  }

  /** Blocks behind the head to re-anchor at when the cursor is unrecoverable (default 64). */
  private reanchorDepth(): number {
    const parsed = Number.parseInt(this.env.SCANNER_REANCHOR_DEPTH_BLOCKS ?? "", 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 64;
  }

  /** Skip a block that keeps failing after this many consecutive attempts (default 5; 0 disables). */
  private skipBlockFailuresAfter(): number {
    const parsed = Number.parseInt(this.env.SCANNER_SKIP_BLOCK_FAILURES ?? "", 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 5;
  }

  /**
   * Tracks per-block failures. Returns `true` only when a block has failed too
   * many times and a recovery re-anchor was performed (the caller must then stop
   * the scan pass). A persistent single-block failure (a poisoned/odd block or a
   * one-off upstream bug) must not wedge the whole chain forever.
   */
  private async registerBlockFailure(chainId: number, blockNumber: bigint): Promise<boolean> {
    const limit = this.skipBlockFailuresAfter();
    if (limit <= 0) return false;
    if (this.blockFailures === null || this.blockFailures.block !== blockNumber) {
      this.blockFailures = { block: blockNumber, count: 0 };
    }
    this.blockFailures.count += 1;
    if (this.blockFailures.count < limit) return false;

    console.warn(
      `chain ${chainId}: block ${String(blockNumber)} failed ${limit}x; skipping via re-anchor (gap)`,
    );
    this.blockFailures = null;
    const head = await this.observeHead(chainId);
    await this.recoverFromUnresolvable(chainId, head, {
      depth: limit > 0 ? 0 : undefined,
      reason: `gap: skipped persistently-failing block ${String(blockNumber)}`,
    });
    return true;
  }

  /** Best-effort current head (number) or 0 when the read fails. */
  private async observeHead(chainId: number): Promise<number> {
    try {
      return Number(await ethBlockNumber({ baseUrl: this.env.RPC_RACER_BASE_URL, chainId }));
    } catch {
      return 0;
    }
  }

  /** Records just the observed head on an anomaly/early-return path (keeps lag honest). */
  private async persistHeadOnly(chainId: number, headBlock: number): Promise<void> {
    await setChainCursorAndHead(this.db, chainId, null, null, headBlock).catch(() => {
      /* best-effort */
    });
  }

  /**
   * Recover from an unrecoverable cursor: re-anchor at `head − reanchorDepth` and
   * rescan the trailing window forward to the head. Lesser/older activity in the
   * deep gap is skipped (it was already unreachable while parked degraded).
   */
  private async recoverFromUnresolvable(
    chainId: number,
    headBlock: number,
    opts: { depth?: number; reason?: string } = {},
  ): Promise<void> {
    const depth = opts.depth ?? this.reanchorDepth();
    const from = Math.max(1, headBlock - depth);
    let anchorBlock: { number: number; hash: string; parentHash: string } | null = null;
    try {
      const raw = await ethGetBlockByNumber({
        baseUrl: this.env.RPC_RACER_BASE_URL,
        chainId,
        blockNumber: BigInt(from),
        includeTransactions: false,
      });
      if (raw) {
        anchorBlock = { number: Number(raw.number), hash: raw.hash, parentHash: raw.parentHash };
      }
    } catch (error) {
      console.error(`re-anchor head read failed [chain ${chainId}]`, String(error));
    }
    if (anchorBlock === null) return;
    this.pendingTip = { number: anchorBlock.number, hash: anchorBlock.hash };
    this.pendingHead = headBlock;
    await this.saveWindow([anchorBlock]);
    await setChainCursorAndHead(this.db, chainId, anchorBlock.number, anchorBlock.hash, headBlock);
    await updateChainRegistryStatus(this.db, chainId, {
      status: "active",
      reason: opts.reason ?? null,
    });
    await this.schedule(this.catchUpMs());
    console.log(
      `re-anchored chain ${chainId} after cursor gap: rescan from ${anchorBlock.number} to head ${headBlock}`,
    );
  }

  private async processBlock({
    chainId,
    block,
    logs,
    trackedSet,
  }: {
    chainId: number;
    block: import("../domain/activity").NormalizedBlock;
    logs: import("../domain/activity").NormalizedLog[];
    trackedSet: Set<`0x${string}`>;
  }): Promise<void> {
    // `logs` are fetched in the same batched request as the block header, so
    // this phase needs no extra RPC call just to get them (receipts below only
    // run for the handful of tracked matches).
    const analyzed = analyzeBlock({ block, logs, tracked: trackedSet });

    const receipts = await ethGetTransactionReceipts({
      baseUrl: this.env.RPC_RACER_BASE_URL,
      chainId,
      txHashes: [...new Set(analyzed.receiptHashes)] as `0x${string}`[],
    });

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
      // Enqueue only observations we actually created. `upsertObservation` is
      // idempotent (DO NOTHING on the deterministic id); when a resume / retry
      // reprocesses an already-persisted observation, skip the enqueue so we never
      // re-deliver a webhook for the same (chainId, tx, address, blockHash) event.
      if (inserted) {
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

  /** Blocks scanned in one alarm pass before the shard yields (env, default 100). */
  private maxBlocksPerPass(): number {
    const parsed = Number.parseInt(this.env.SCANNER_MAX_BLOCKS_PER_PASS ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 100;
  }

  /** Max cadence (ms) for persisting the D1 cursor, even for very fast chains. */
  private cursorFlushIntervalMs(): number {
    const parsed = Number.parseInt(this.env.SCANNER_CURSOR_D1_MS ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 8000;
  }

  /**
   * Coalesce D1 `chain_registry.cursor` writes. Between alarm passes the
   * Durable Object's own block window is the authoritative cursor, so D1 only
   * needs a coarse checkpoint bounded by `SCANNER_CURSOR_D1_MS`. This collapses
   * the per-block UPDATE that was the dominant D1 write on fast-cadence chains
   * (e.g. Arbitrum ~0.25s blocks) while leaving sparse chains (Ethereum ~12s)
   * effectively at their natural cadence.
   */
  private async maybeFlushCursor(): Promise<void> {
    if (!this.pendingTip && this.pendingHead === null) return;
    const now = Date.now();
    if (this.cursorFlushAt === null) {
      const stored = await this.state.storage.get<number>("cursorFlushAt");
      this.cursorFlushAt = typeof stored === "number" ? stored : 0;
    }
    if (now - this.cursorFlushAt < this.cursorFlushIntervalMs()) return;
    await setChainCursorAndHead(
      this.db,
      this.chainId(),
      this.pendingTip?.number ?? null,
      this.pendingTip?.hash ?? null,
      this.pendingHead ?? null,
    );
    this.cursorFlushAt = now;
    await this.state.storage.put("cursorFlushAt", now);
  }

  /** Fastest poll cadence while a backlog remains (env, default 500ms). */
  private catchUpMs(): number {
    const parsed = Number.parseInt(this.env.SCANNER_MIN_POLL_INTERVAL_MS ?? "", 10);
    return Number.isFinite(parsed) && parsed >= 100 ? parsed : 1000;
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

function pollInterval(
  head: bigint,
  blockSpeedMs: number | null,
  minIntervalMs: number,
  maxIntervalMs: number,
): number {
  if (blockSpeedMs !== null && Number.isFinite(blockSpeedMs) && blockSpeedMs > 0) {
    return Math.min(Math.max(Math.round(blockSpeedMs / 2), minIntervalMs), maxIntervalMs);
  }
  return minIntervalMs;
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
