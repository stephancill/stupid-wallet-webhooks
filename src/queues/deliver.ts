import type { Env, DeliveryHook } from "../env";
import {
  getWebhookById,
  hasSuccessfulDelivery,
  insertDelivery,
  getDeliveryByEvent,
  updateDelivery,
} from "../db/repository";
import { deriveWebhookSecret, webhookSignature } from "../domain/keys";
import { attemptWebhookDelivery } from "../api/queues/webhookClient";
import { classifyDelivery } from "./plan";

/**
 * `webhook-delivery` consumer. For each destination message: dedupes against an
 * existing successful delivery, derives the signing secret, signs the exact
 * body, sends with a strict timeout / size cap and redirects disabled, classifies
 * the outcome, and records it in the ledger. Retryable outcomes rethrow so the
 * queue (with its backoff + dead-letter config) handles retries; permanent
 * failures are marked dead-lettered and acknowledged.
 */
export async function deliverWebhooks(batch: MessageBatch<DeliveryHook>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const work = message.body as DeliveryHook;

    // Idempotency: never redeliver something already delivered successfully.
    if (await hasSuccessfulDelivery(env.DB, work.webhookId, work.observationId, work.eventType)) {
      continue;
    }

    const webhook = await getWebhookById(env.DB, work.webhookId);
    if (webhook === null) {
      await recordDeadLetter(env, work, "webhook not found");
      continue;
    }

    await attemptOneDelivery(work, webhook.url, env);
  }
}

async function attemptOneDelivery(work: DeliveryHook, url: string, env: Env): Promise<void> {
  const existing = await getDeliveryByEvent(
    env.DB,
    work.webhookId,
    work.observationId,
    work.eventType,
  );
  const attempts = (existing?.attempts ?? 0) + 1;

  if (existing === null) {
    await insertDelivery(env.DB, {
      id: work.deliveryId,
      account_id: work.accountId,
      webhook_id: work.webhookId,
      event_id: work.observationId,
      event_type: work.eventType,
      chain_id: work.chainId,
      status: "pending",
      attempts: 0,
    });
  }

  const secret = await deriveWebhookSecret({
    masterSecret: env.WEBHOOK_SIGNING_MASTER,
    webhookId: work.webhookId,
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await webhookSignature({ secret, body: work.bodyJson, timestamp });

  const outcome = await attemptWebhookDelivery({
    url,
    body: work.bodyJson,
    headers: {
      "webhook-id": work.observationId,
      "webhook-timestamp": String(timestamp),
      "webhook-signature": signature,
    },
  });

  const deliveryId = existing?.id ?? work.deliveryId;
  const result = classifyDelivery({ delivered: outcome.delivered, retryable: outcome.retryable });

  if (result === "success") {
    await updateDelivery(env.DB, deliveryId, {
      status: "success",
      attempts,
      last_response_status: outcome.httpStatus,
      last_error: null,
    });
    return;
  }

  if (result === "retry") {
    await updateDelivery(env.DB, deliveryId, {
      status: "pending",
      attempts,
      last_response_status: outcome.httpStatus,
      last_error: outcome.error ?? "retryable failure",
    });
    throw new Error(`retryable delivery failure for ${work.observationId}`);
  }

  // Permanent failure: terminate for this destination.
  await updateDelivery(env.DB, deliveryId, {
    status: "dead_lettered",
    attempts,
    last_response_status: outcome.httpStatus,
    last_error: outcome.error ?? "permanent delivery failure",
  });
}

async function recordDeadLetter(env: Env, work: DeliveryHook, error: string): Promise<void> {
  await insertDelivery(env.DB, {
    id: work.deliveryId,
    account_id: work.accountId,
    webhook_id: work.webhookId,
    event_id: work.observationId,
    event_type: work.eventType,
    chain_id: work.chainId,
    status: "dead_lettered",
    attempts: 1,
    last_response_status: null,
    last_error: error,
  });
}
