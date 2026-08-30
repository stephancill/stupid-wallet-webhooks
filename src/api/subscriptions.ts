import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Env } from "../env";
import type { AuthContext } from "./middleware";
import { authContext } from "./middleware";
import {
  getWebhook,
  getSubscription,
  listSubscriptions,
  hasActiveSubscription,
  countActiveSubscriptions,
  listActiveChainIds,
  type SubscriptionRow,
} from "../db/repository";
import { IDs } from "../domain/ids";
import { normalizeAddressInput, addressBlobToHex } from "../domain/address";
import { submitScrSubscribe, submitScrUnsubscribe, DuplicateTupleError } from "../scanner/outbox";

const createSchema = z.object({
  address: z.string().min(1).max(128),
  chainIds: z.array(z.coerce.number().int().positive()).min(1).max(100),
  webhookId: z.string().min(1).max(64),
});

export const subscriptions = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();

subscriptions.get("/", async (c) => {
  const ctx = authContext(c);
  const rows = await listSubscriptions(
    c.env.DB,
    ctx.accountId,
    c.req.query("webhookId") ?? undefined,
  );
  return c.json({ subscriptions: rows.map(serializeSubscription) });
});

subscriptions.get("/:subscriptionId", async (c) => {
  const ctx = authContext(c);
  const sub = await getSubscription(c.env.DB, c.req.param("subscriptionId"), ctx.accountId);
  if (sub === null) {
    throw new HTTPException(404, { message: "Subscription not found" });
  }
  return c.json(serializeSubscription(sub));
});

subscriptions.post("/", zValidator("json", createSchema), async (c) => {
  const ctx = authContext(c);
  const body = c.req.valid("json");

  const webhook = await getWebhook(c.env.DB, body.webhookId, ctx.accountId);
  if (webhook === null) {
    throw new HTTPException(400, { message: "webhookId must belong to this account" });
  }

  let normalized;
  try {
    normalized = normalizeAddressInput(body.address);
  } catch {
    throw new HTTPException(400, { message: "Invalid EVM address" });
  }

  const chainIds = [...new Set(body.chainIds)];
  const subscriptionQuota = ctx.activeSubscriptionQuota;
  const chainQuota = ctx.chainQuota;

  const existingChains = new Set(await listActiveChainIds(c.env.DB, ctx.accountId));
  let subsUsed = await countActiveSubscriptions(c.env.DB, ctx.accountId);
  let chainsUsed = existingChains.size;

  const createdSubscriptions: SubscriptionRow[] = [];
  const failures: { chainId: number; status: string; message: string }[] = [];

  for (const chainId of chainIds) {
    const tupleExists = await hasActiveSubscription(
      c.env.DB,
      ctx.accountId,
      webhook.id,
      normalized.blob,
      chainId,
    );
    if (tupleExists) {
      failures.push({
        chainId,
        status: "conflict",
        message: "subscription already active for this tuple",
      });
      continue;
    }
    if (subsUsed >= subscriptionQuota) {
      failures.push({ chainId, status: "quota", message: "active subscription quota exceeded" });
      continue;
    }
    const isNewChain = !existingChains.has(chainId);
    if (isNewChain && chainsUsed >= chainQuota) {
      failures.push({ chainId, status: "quota", message: "distinct chain quota exceeded" });
      continue;
    }

    const subscriptionId = IDs.subscription();
    try {
      await submitScrSubscribe({
        db: c.env.DB,
        env: c.env,
        state: { subscriptionId, chainId, address: normalized.blob },
        accountId: ctx.accountId,
        webhookId: webhook.id,
      });
    } catch (error) {
      if (error instanceof DuplicateTupleError) {
        failures.push({ chainId, status: "conflict", message: error.message });
        continue;
      }
      throw error;
    }

    subsUsed += 1;
    if (isNewChain) {
      existingChains.add(chainId);
      chainsUsed += 1;
    }

    const created = await getSubscription(c.env.DB, subscriptionId, ctx.accountId);
    if (created !== null) {
      createdSubscriptions.push(created);
    } else {
      failures.push({ chainId, status: "error", message: "subscription could not be read back" });
    }
  }

  return c.json(
    { subscriptions: [...createdSubscriptions.map(serializeSubscription), ...failures] },
    createdSubscriptions.length === 0 ? 400 : 201,
  );
});

subscriptions.delete("/:subscriptionId", async (c) => {
  const ctx = authContext(c);
  const sub = await getSubscription(c.env.DB, c.req.param("subscriptionId"), ctx.accountId);
  if (sub === null) {
    throw new HTTPException(404, { message: "Subscription not found" });
  }

  const ok = await submitScrUnsubscribe({
    db: c.env.DB,
    env: c.env,
    state: { subscriptionId: sub.id, chainId: sub.chain_id, address: toUint8(sub.address) },
  });
  if (!ok) {
    throw new HTTPException(404, { message: "Subscription not found" });
  }
  return c.json({ id: sub.id, status: "deleting", deleted: true });
});

function serializeSubscription(row: SubscriptionRow): {
  id: string;
  address: string;
  chainId: number;
  status: string;
  activeFromBlock: string | null;
  reason: string | null;
  createdAt: string;
} {
  return {
    id: row.id,
    address: addressBlobToHex(toUint8(row.address)),
    chainId: row.chain_id,
    status: row.status,
    activeFromBlock: row.active_from_block === null ? null : String(row.active_from_block),
    reason: row.reason,
    createdAt: row.created_at,
  };
}

function toUint8(value: Uint8Array | ArrayBuffer): Uint8Array {
  return value instanceof ArrayBuffer ? new Uint8Array(value) : value;
}
