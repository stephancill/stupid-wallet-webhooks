import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Env } from "../env";
import { operatorAuth } from "./middleware";
import {
  insertAccount as createAccount,
  getAccount,
  setAccountStatus,
  createApiKey,
  listApiKeys,
  revokeApiKey,
  listPendingCommands,
} from "../db/repository";
import { IDs } from "../domain/ids";
import { generateApiKey, hashApiKey } from "../domain/keys";
import { redispatchPending } from "../scanner/outbox";
import { upsertObservation } from "../db/repository";
import { enqueueMatched } from "../scanner/queue";

const createAccountSchema = z.object({
  name: z.string().min(1).max(128),
  subscriptionQuota: z.coerce.number().int().positive().optional(),
  chainQuota: z.coerce.number().int().positive().optional(),
});

const accountParam = z.object({ accountId: z.string().min(1) });

export const operator = new Hono<{ Bindings: Env }>();

operator.use("*", operatorAuth);

operator.post("/accounts", zValidator("json", createAccountSchema), async (c) => {
  const body = c.req.valid("json");
  const account = await createAccount(c.env.DB, {
    id: IDs.account(),
    name: body.name,
    subscription_quota: body.subscriptionQuota ?? null,
    chain_quota: body.chainQuota ?? null,
  });
  return c.json({ account: serializeAccount(account) }, 201);
});

operator.get("/accounts/:accountId", zValidator("param", accountParam), async (c) => {
  const account = await getAccount(c.env.DB, c.req.valid("param").accountId);
  if (account === null) {
    throw new HTTPException(404, { message: "Account not found" });
  }
  return c.json({ account: serializeAccount(account) });
});

operator.get("/accounts/:accountId/api-keys", zValidator("param", accountParam), async (c) => {
  const { accountId } = c.req.valid("param");
  const keys = await listApiKeys(c.env.DB, accountId);
  return c.json({
    apiKeys: keys.map((key) => ({
      id: key.id,
      prefix: key.prefix,
      name: key.name,
      status: key.status,
      createdAt: key.created_at,
    })),
  });
});

operator.post("/accounts/:accountId/api-keys", zValidator("param", accountParam), async (c) => {
  const { accountId } = c.req.valid("param");
  const account = await getAccount(c.env.DB, accountId);
  if (account === null) {
    throw new HTTPException(404, { message: "Account not found" });
  }
  const generated = generateApiKey();
  const keyHash = await hashApiKey({ key: generated.key, pepper: c.env.API_KEY_PEPPER });
  const row = await createApiKey(c.env.DB, {
    id: IDs.apiKey(),
    account_id: accountId,
    key_hash: keyHash,
    prefix: generated.prefix,
  });
  return c.json(
    { apiKeyId: row.id, apiKey: generated.key, prefix: generated.prefix }, // key shown once
    201,
  );
});

operator.delete(
  "/accounts/:accountId/api-keys/:keyId",
  zValidator("param", z.object({ accountId: z.string().min(1), keyId: z.string().min(1) })),
  async (c) => {
    const { accountId, keyId } = c.req.valid("param");
    const keys = await listApiKeys(c.env.DB, accountId);
    const owned = keys.some((key) => key.id === keyId);
    if (!owned) {
      throw new HTTPException(404, { message: "API key not found" });
    }
    const revoked = await revokeApiKey(c.env.DB, keyId);
    return c.json({ id: keyId, revoked });
  },
);

operator.post("/accounts/:accountId/suspended", zValidator("param", accountParam), async (c) => {
  return setAccountState(c, "suspended");
});
operator.post("/accounts/:accountId/reactivate", zValidator("param", accountParam), async (c) => {
  return setAccountState(c, "active");
});

async function setAccountState(
  c: {
    env: Env;
    json: (body: unknown, status?: number) => Response;
    req: { valid: (k: "param") => { accountId: string } };
  },
  status: "active" | "suspended",
): Promise<Response> {
  const { accountId } = c.req.valid("param");
  const account = await getAccount(c.env.DB, accountId);
  if (account === null) {
    throw new HTTPException(404, { message: "Account not found" });
  }
  await setAccountStatus(c.env.DB, accountId, status);
  return c.json({ accountId, status });
}

operator.get("/reconcile", async (c) => {
  const redispatched = await redispatchPending({ db: c.env.DB, env: c.env });
  return c.json({ redispatched: redispatched.length });
});

operator.get("/scanner-operations", async (c) => {
  const rows = await listPendingCommands(c.env.DB, 500);
  return c.json({
    operations: rows.map((row) => ({
      id: row.id,
      chainId: row.chain_id,
      kind: row.kind,
      status: row.status,
      subscriptionId: row.subscription_id,
      error: row.error,
      createdAt: row.created_at,
    })),
  });
});

// Local-only E2E helper: inject a synthetic matched observation and push it
// onto the matched-activity queue so the fan-out + delivery path runs in
// `wrangler dev --local`. Only enabled when ALLOW_INSECURE_TEST_WEBHOOKS=1.
const injectSchema = z.object({
  observationId: z.string().min(1),
  chainId: z.coerce.number().int().positive(),
  trackedAddress: z.string().min(1).max(64),
  blockNumber: z.string().min(1),
  blockHash: z.string().min(1),
  txHash: z.string().min(1),
  txFrom: z.string().min(1),
  data: z.record(z.unknown()),
});

operator.post("/inject", zValidator("json", injectSchema), async (c) => {
  if (c.env.ALLOW_INSECURE_TEST_WEBHOOKS !== "1") {
    throw new HTTPException(403, { message: "inject is disabled" });
  }
  const body = c.req.valid("json");
  const inserted = await upsertObservation(c.env.DB, {
    observationId: body.observationId,
    chainId: body.chainId,
    txHash: body.txHash,
    trackedAddress: body.trackedAddress,
    blockNumber: body.blockNumber,
    blockHash: body.blockHash,
    status: "observed",
    initiator: body.txFrom,
    payload: JSON.stringify(body.data),
  });
  await enqueueMatched({
    queue: c.env.MATCHED_ACTIVITY_QUEUE,
    observations: [
      {
        observationId: body.observationId,
        chainId: body.chainId,
        txHash: body.txHash,
        trackedAddress: body.trackedAddress,
        blockNumber: body.blockNumber,
        blockHash: body.blockHash,
      },
    ],
  });
  return c.json({ message: "injected", observationId: body.observationId, inserted });
});

// Operator may retry any unsupported chain.
operator.post(
  "/chains/:chainId/retry",
  zValidator("param", z.object({ chainId: z.coerce.number().int().positive() })),
  async (c) => {
    const { chainId } = c.req.valid("param");
    const { newId } = await import("../domain/ids");
    const { dispatchCommand } = await import("../scanner/outbox");
    const commandId = newId("cmd");
    const now = new Date().toISOString();
    await c.env.DB.prepare(
      "INSERT INTO scanner_operations (id, chain_id, kind, address, subscription_id, payload, status, created_at, updated_at) VALUES (?, ?, 'retry_chain', NULL, NULL, ?, 'pending', ?, ?)",
    )
      .bind(commandId, chainId, JSON.stringify({ chainId }), now, now)
      .run();
    await dispatchCommand(c.env, { id: commandId, chain_id: chainId });
    return c.json({ chainId, retry: "scheduled" });
  },
);

// Operator: pause / resume a chain's scanner (paused chains stop polling).
operator.post(
  "/chains/:chainId/pause",
  zValidator("param", z.object({ chainId: z.coerce.number().int().positive() })),
  async (c) => {
    const { chainId } = c.req.valid("param");
    const { updateChainRegistryStatus } = await import("../db/repository");
    await updateChainRegistryStatus(c.env.DB, chainId, {
      status: "paused",
      reason: "paused by operator",
    });
    return c.json({ chainId, status: "paused" });
  },
);

operator.post(
  "/chains/:chainId/resume",
  zValidator("param", z.object({ chainId: z.coerce.number().int().positive() })),
  async (c) => {
    const { chainId } = c.req.valid("param");
    const { updateChainRegistryStatus } = await import("../db/repository");
    await updateChainRegistryStatus(c.env.DB, chainId, { status: "active", reason: null });
    return c.json({ chainId, status: "active" });
  },
);

// Deliver a summary of chain health/lag from the registry (chain reporting).
operator.get("/chains", async (c) => {
  const { listChainRegistry } = await import("../db/repository");
  const rows = await listChainRegistry(c.env.DB);
  return c.json({
    chains: rows.map((r) => ({
      chainId: r.chain_id,
      name: r.name,
      status: r.status,
      reason: r.reason,
      shardId: r.shard_id,
      cursor: r.cursor_block,
      lastProbeAt: r.last_probe_at,
    })),
  });
});

function serializeAccount(account: {
  id: string;
  name: string;
  status: string;
  subscription_quota: number | null;
  chain_quota: number | null;
  created_at: string;
}): {
  id: string;
  name: string;
  status: string;
  subscriptionQuota: number | null;
  chainQuota: number | null;
  createdAt: string;
} {
  return {
    id: account.id,
    name: account.name,
    status: account.status,
    subscriptionQuota: account.subscription_quota,
    chainQuota: account.chain_quota,
    createdAt: account.created_at,
  };
}
