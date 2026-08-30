import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { Env } from "../env";
import type { AuthContext } from "./middleware";
import { authContext } from "./middleware";
import { listDeliveries, getDelivery } from "../db/repository";

const querySchema = z.object({
  webhookId: z.string().min(1).optional(),
  eventId: z.string().min(1).optional(),
  status: z.enum(["pending", "success", "failed", "dead_lettered"]).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const idParam = z.object({ deliveryId: z.string().min(1) });

export const deliveries = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();

// Delivery history, retained 30 days.
deliveries.get("/", zValidator("query", querySchema), async (c) => {
  const ctx = authContext(c);
  const query = c.req.valid("query");
  const rows = await listDeliveries(c.env.DB, ctx.accountId, {
    webhookId: query.webhookId,
    eventId: query.eventId,
    status: query.status,
    cursor: query.cursor,
    limit: query.limit ?? 50,
  });
  const hasMore = rows.length === (query.limit ?? 50) + 1;
  const page = hasMore ? rows.slice(0, query.limit ?? 50) : rows;
  const serialized = page.map((row) => serializeDelivery(row));
  return c.json({
    deliveries: serialized,
    ...(hasMore ? { nextCursor: serialized[serialized.length - 1]?.createdAt ?? null } : {}),
  });
});

deliveries.get("/:deliveryId", zValidator("param", idParam), async (c) => {
  const ctx = authContext(c);
  const row = await getDelivery(c.env.DB, c.req.valid("param").deliveryId, ctx.accountId);
  if (row === null) {
    throw new HTTPException(404, { message: "Delivery not found" });
  }
  return c.json(serializeDelivery(row));
});

function serializeDelivery(row: {
  id: string;
  webhook_id: string;
  event_id: string;
  event_type: string;
  chain_id: number | null;
  status: string;
  attempts: number;
  last_response_status: number | null;
  response_body_excerpt: string | null;
  next_retry_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}): {
  id: string;
  webhookId: string;
  eventId: string;
  eventType: string;
  chainId: number | null;
  status: string;
  attempts: number;
  lastResponseStatus: number | null;
  responseBodyExcerpt: string | null;
  nextRetryAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: row.id,
    webhookId: row.webhook_id,
    eventId: row.event_id,
    eventType: row.event_type,
    chainId: row.chain_id,
    status: row.status,
    attempts: row.attempts,
    lastResponseStatus: row.last_response_status,
    responseBodyExcerpt: row.response_body_excerpt,
    nextRetryAt: row.next_retry_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
