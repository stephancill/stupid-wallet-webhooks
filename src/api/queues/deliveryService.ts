import type { Env } from "../../env";
import { IDs } from "../../domain/ids";
import { deriveWebhookSecret, webhookSignature } from "../../domain/keys";
import type { WebhookRow } from "../../db/repository";
import { insertDelivery } from "../../db/repository";
import { attemptWebhookDelivery, type DeliveryAttempt } from "./webhookClient";

export type TestDeliveryResult = {
  deliveryId: string;
  eventId: string;
  attempt: DeliveryAttempt;
};

/**
 * Performs a synchronous `webhook.test` delivery for a webhook and records the
 * outcome in the delivery ledger. Used by `POST /v1/webhooks/:id/test`; the
 * general observed-activity path lives in Milestone 3 on the delivery queue.
 */
export async function deliverTestWebhook({
  env,
  db,
  webhook,
}: {
  env: Env;
  db: D1Database;
  webhook: WebhookRow;
}): Promise<TestDeliveryResult> {
  const eventId = IDs.testEvent();
  const deliveryId = IDs.delivery();
  const createdAt = new Date().toISOString();

  const payload = JSON.stringify({
    id: eventId,
    type: "webhook.test",
    createdAt,
    data: {
      webhookId: webhook.id,
    },
  });

  const secret = await deriveWebhookSecret({
    masterSecret: env.WEBHOOK_SIGNING_MASTER,
    webhookId: webhook.id,
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await webhookSignature({ secret, body: payload, timestamp });

  const attempt: DeliveryAttempt = {
    delivered: false,
    httpStatus: null,
    retryable: false,
    error: null,
  };

  try {
    const outcome = await attemptWebhookDelivery({
      url: webhook.url,
      body: payload,
      headers: {
        "webhook-id": eventId,
        "webhook-timestamp": String(timestamp),
        "webhook-signature": signature,
      },
    });
    Object.assign(attempt, outcome);
  } catch (error) {
    attempt.delivered = false;
    attempt.retryable = true;
    attempt.error = error instanceof Error ? error.message : "Delivery failed";
  }

  const status = attempt.delivered ? "success" : "failed";
  await insertDelivery(db, {
    id: deliveryId,
    account_id: webhook.account_id,
    webhook_id: webhook.id,
    event_id: eventId,
    event_type: "webhook.test",
    chain_id: null,
    status,
    attempts: 1,
    last_response_status: attempt.httpStatus,
    last_error: attempt.error,
  });

  return { deliveryId, eventId, attempt };
}
