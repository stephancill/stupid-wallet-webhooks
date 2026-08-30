import type { Env, MatchedMessage, DeliveryHook } from "../env";
import { IDs } from "../domain/ids";
import { getObservationPayload, listEligibleSubscriptions } from "../db/repository";
import { buildWebhookJson, parseObservationData } from "./webhook-body";

/**
 * `matched-activity` queue consumer. Fans one observation out to every eligible
 * active subscription (webhook) for its (chainId, trackedAddress), enforcing
 * each subscription's activation block, then enqueues one `DeliveryHook` per
 * destination onto the `webhook-delivery` queue. Ignores unknown observations
 * and records nothing for ineligible subscriptions.
 */
export async function fanoutMatched(batch: MessageBatch<MatchedMessage>, env: Env): Promise<void> {
  const deliveries: Array<{ id: string; body: DeliveryHook }> = [];

  for (const message of batch.messages) {
    const matched = message.body;
    const observation = await getObservationPayload(env.DB, matched.observationId);
    if (observation === null) {
      message.retry(); // observation vanished; give it another chance
      continue;
    }

    const subscriptions = await listEligibleSubscriptions(
      env.DB,
      observation.chainId,
      observation.trackedAddress,
      Number(observation.blockNumber),
    );
    const data = parseObservationData(observation.data);

    for (const subscription of subscriptions) {
      const built = buildWebhookJson({
        id: observation.observationId,
        type: "activity.observed",
        data,
      });
      deliveries.push({
        id: `d-${subscription.id}:${observation.observationId}`,
        body: {
          deliveryId: IDs.delivery(),
          observationId: observation.observationId,
          eventType: "activity.observed",
          accountId: subscription.account_id,
          webhookId: subscription.webhook_id,
          chainId: observation.chainId,
          trackedAddress: observation.trackedAddress,
          blockNumber: observation.blockNumber,
          bodyJson: built.json,
        } satisfies DeliveryHook,
      });
    }
  }

  if (deliveries.length > 0) {
    await env.WEBHOOK_DELIVERY_QUEUE.sendBatch(deliveries);
  }
}
