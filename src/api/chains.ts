import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { Env } from "../env";
import type { AuthContext } from "./middleware";
import { authContext } from "./middleware";
import { resolveChain } from "../rpc/chain";
import { getChainRegistry, listChainRegistry, hasPendingRetryCommand } from "../db/repository";
import { newId } from "../domain/ids";
import { dispatchCommand } from "../scanner/outbox";

const chainParam = z.object({ chainId: z.coerce.number().int().positive() });

export const chains = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();

chains.get("/", async (c) => {
  const rows = await listChainRegistry(c.env.DB);
  return c.json({
    chains: rows.map((row) => ({
      chainId: row.chain_id,
      name: row.name,
      status: row.status,
      reason: row.reason,
      cursorBlock: row.cursor_block,
    })),
  });
});

chains.get("/:chainId", zValidator("param", chainParam), async (c) => {
  const { chainId } = c.req.valid("param");
  const resolved = await resolveChain({ baseUrl: c.env.RPC_RACER_BASE_URL, chainId });
  const registry = await getChainRegistry(c.env.DB, chainId);

  if (!resolved.ok) {
    throw new HTTPException(resolved.reason === "unknown_chain" ? 404 : 502, {
      message: resolved.detail ?? "Chain could not be resolved",
    });
  }

  return c.json({
    chainId: resolved.chain.chainId,
    name: resolved.chain.name,
    shortName: resolved.chain.shortName,
    isTestnet: resolved.chain.isTestnet ?? false,
    blockSpeedMs: resolved.chain.blockSpeedMs,
    status: registry?.status ?? null,
    reason: registry?.reason ?? null,
    cursorBlock: registry?.cursor_block ?? null,
  });
});

/**
 * Manual capability retry. Authorized when the account holds an unsupported
 * subscription on the chain. Rate-limited to one pending retry per chain so the
 * endpoint can't be used as an RPC amplification path.
 */
chains.post("/:chainId/retry", zValidator("param", chainParam), async (c) => {
  const ctx = authContext(c);
  const { chainId } = c.req.valid("param");

  const authorized = await accountHasUnsupportedSubscription(c.env.DB, ctx.accountId, chainId);
  if (!authorized) {
    throw new HTTPException(403, { message: "No unsupported subscription for this chain" });
  }

  if (await hasPendingRetryCommand(c.env.DB, chainId)) {
    throw new HTTPException(429, { message: "Retry already pending for this chain" });
  }

  const commandId = newId("cmd");
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    "INSERT INTO scanner_operations (id, chain_id, kind, address, subscription_id, payload, status, created_at, updated_at) VALUES (?, ?, 'retry_chain', NULL, NULL, ?, 'pending', ?, ?)",
  )
    .bind(commandId, chainId, JSON.stringify({ chainId }), now, now)
    .run();

  await dispatchCommand(c.env, { id: commandId, chain_id: chainId });
  return c.json({ chainId, retry: "scheduled" });
});

async function accountHasUnsupportedSubscription(
  db: D1Database,
  accountId: string,
  chainId: number,
): Promise<boolean> {
  const row = await db
    .prepare(
      "SELECT id FROM subscriptions WHERE account_id = ? AND chain_id = ? AND status = 'unsupported' AND deleted_at IS NULL LIMIT 1",
    )
    .bind(accountId, chainId)
    .first<{ id: string }>();
  return row !== null;
}
