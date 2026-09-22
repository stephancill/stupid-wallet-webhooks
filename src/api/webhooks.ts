import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Env } from "../env";
import type { AuthContext } from "./middleware";
import { authContext } from "./middleware";
import { createWebhook, getWebhook, listWebhooks } from "../db/repository";
import { IDs } from "../domain/ids";
import { deriveWebhookSecret } from "../domain/keys";
import { validateWebhookUrl } from "../domain/webhook";
import { deliverTestWebhook } from "./queues/deliveryService";
import { submitWebhookDelete } from "../scanner/outbox";

const createSchema = z.object({
  url: z.string().min(1).max(2048),
});

export const webhooks = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();

// List webhooks
webhooks.get("/", async (c) => {
  const ctx = authContext(c);
  const rows = await listWebhooks(c.env.DB, ctx.accountId);
  return c.json({
    webhooks: rows.map((row) => ({
      id: row.id,
      url: row.url,
      status: row.status,
      createdAt: row.created_at,
      lastTestAt: row.last_test_at,
    })),
  });
});

// Create webhook
webhooks.post("/", zValidator("json", createSchema), async (c) => {
  const ctx = authContext(c);
  const { url } = c.req.valid("json");

  const validation = validateWebhookUrl(url, {
    allowInsecure: c.env.ALLOW_INSECURE_TEST_WEBHOOKS === "1",
  });
  if (!validation.ok) {
    throw new HTTPException(400, { message: validation.reason });
  }

  const webhook = await createWebhook(c.env.DB, {
    id: IDs.webhook(),
    account_id: ctx.accountId,
    url: validation.url,
  });
  const secret = await deriveWebhookSecret({
    masterSecret: c.env.WEBHOOK_SIGNING_MASTER,
    webhookId: webhook.id,
  });

  return c.json(
    {
      id: webhook.id,
      url: webhook.url,
      status: webhook.status,
      createdAt: webhook.created_at,
      signingSecret: secret, // returned only once; it is derived, never stored
    },
    201,
  );
});

// Get one webhook
webhooks.get("/:webhookId", async (c) => {
  const ctx = authContext(c);
  const webhook = await getWebhook(c.env.DB, c.req.param("webhookId"), ctx.accountId);
  if (webhook === null) {
    throw new HTTPException(404, { message: "Webhook not found" });
  }
  return c.json({
    id: webhook.id,
    url: webhook.url,
    status: webhook.status,
    createdAt: webhook.created_at,
    lastTestAt: webhook.last_test_at,
  });
});

// Test delivery
webhooks.post("/:webhookId/test", async (c) => {
  const ctx = authContext(c);
  const webhook = await getWebhook(c.env.DB, c.req.param("webhookId"), ctx.accountId);
  if (webhook === null) {
    throw new HTTPException(404, { message: "Webhook not found" });
  }
  if (webhook.status !== "active") throw new HTTPException(409, { message: "Webhook is inactive" });

  const result = await deliverTestWebhook({ env: c.env, db: c.env.DB, webhook });
  return c.json({
    deliveryId: result.deliveryId,
    eventId: result.eventId,
    delivered: result.attempt.delivered,
    httpStatus: result.attempt.httpStatus,
    retryable: result.attempt.retryable,
    error: result.attempt.error,
  });
});

// Delete webhook (also deactivates its subscriptions)
webhooks.delete("/:webhookId", async (c) => {
  const ctx = authContext(c);
  const webhookId = c.req.param("webhookId");
  const webhook = await getWebhook(c.env.DB, webhookId, ctx.accountId);
  if (webhook === null) {
    throw new HTTPException(404, { message: "Webhook not found" });
  }

  await submitWebhookDelete({ db: c.env.DB, env: c.env, webhookId, accountId: ctx.accountId });
  return c.json({ id: webhookId, deleted: true });
});
