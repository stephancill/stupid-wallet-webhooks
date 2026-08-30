import {
  getCommand,
  markCommandApplied,
  markCommandFailed,
  setSubscriptionStatus,
  updateChainRegistryStatus,
} from "../db/repository";
import { resolveChain } from "../rpc/chain";
import type { Env } from "../env";

/**
 * Scanner shard Durable Object (Milestone 1 stub).
 *
 * In the final architecture a shard owns chain cursors, alarms, tracked sets,
 * and RPC polling. For Milestone 1 it only finalizes control-plane state from
 * the command outbox: a `subscribe` command resolves the chain over
 * evm.stupidtech.net metadata and marks the subscription active (or
 * unsupported), assigning the chain to a shard. `active_from_block` is left
 * null here and populated by the real scanner in Milestone 2.
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
    return json("Not found", 404);
  }

  /** Alarm: reconciliation for this shard is handled by the scheduled job and operator endpoint. */
  async alarm(): Promise<void> {
    // No Milestone-1 alarm work.
  }

  private async applyCommand(commandId: string): Promise<void> {
    const command = await getCommand(this.db, commandId);
    if (command === null || command.status !== "pending") {
      return;
    }

    if (command.kind === "subscribe") {
      await this.handleSubscribe(command);
    } else if (command.kind === "unsubscribe") {
      await markCommandApplied(this.db, commandId);
    } else if (command.kind === "retry_chain") {
      await this.handleRetryChain(commandId, command.chain_id);
    }
  }

  private async handleSubscribe(command: CommandRow): Promise<void> {
    const chainId = command.chain_id;
    const subscriptionId = command.subscription_id;

    const resolved = await resolveChain({
      baseUrl: this.env.RPC_RACER_BASE_URL,
      chainId,
    });

    if (resolved.ok) {
      const shardId = chainId % shardCountValue(this.env);
      await updateChainRegistryStatus(this.db, chainId, {
        status: "active",
        shard_id: shardId,
        name: resolved.chain.name,
        last_probe_at: new Date().toISOString(),
      });
      // active_from_block is left unchanged (null) by the Milestone-1 stub; the
      // real scanner sets it to head + 1 in Milestone 2.
      if (subscriptionId !== null) {
        await setSubscriptionStatus(this.db, subscriptionId, "active");
      }
      await markCommandApplied(this.db, command.id);
      return;
    }

    if (resolved.reason === "unknown_chain") {
      const shardId = chainId % shardCountValue(this.env);
      await updateChainRegistryStatus(this.db, chainId, {
        status: "unsupported",
        reason: resolved.detail ?? "Unknown chain",
        shard_id: shardId,
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

    // Transport / invalid metadata: transient. Leave the command pending so the
    // reconciliation job redelivers it, and record the failure for observability.
    await markCommandFailed(
      this.db,
      command.id,
      `Chain resolution failed (${resolved.detail ?? resolved.reason})`,
      command.attempts,
    );
  }

  private async handleRetryChain(commandId: string, chainId: number): Promise<void> {
    const resolved = await resolveChain({ baseUrl: this.env.RPC_RACER_BASE_URL, chainId });

    if (resolved.ok) {
      await updateChainRegistryStatus(this.db, chainId, {
        status: "active",
        shard_id: chainId % shardCountValue(this.env),
        name: resolved.chain.name,
        last_probe_at: new Date().toISOString(),
      });
      // Re-activate any unsupported subscriptions for this chain.
      await reactivateUnsupportedSubscriptions(this.db, chainId);
      await markCommandApplied(this.db, commandId);
      return;
    }

    if (resolved.reason === "unknown_chain") {
      await updateChainRegistryStatus(this.db, chainId, {
        status: "unsupported",
        reason: "Unknown chain",
        last_probe_at: new Date().toISOString(),
      });
      await markCommandApplied(this.db, commandId);
      return;
    }

    await markCommandFailed(this.db, commandId, "Chain resolution failed transiently", 0);
  }
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
