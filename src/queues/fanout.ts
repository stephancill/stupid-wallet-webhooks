import type { Env, MatchedMessage, DeliveryHook } from "../env";
import { getObservationPayload, listEligibleSubscriptions } from "../db/repository";
import { planFanOutDeliveries } from "./plan";

/**
 * `matched-activity` queue consumer. Fans one observation out to every eligible
 * active subscription (webhook) for its (chainId, trackedAddress), enforcing
 * each subscription's activation block, then enqueues one `DeliveryHook` per
 * destination onto the `webhook-delivery` queue. Ignores unknown observations.
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

    for (const planned of planFanOutDeliveries({ observation, subscriptions })) {
      deliveries.push({ id: planned.key, body: planned.body });
    }
  }

  if (deliveries.length > 0) {
    await env.WEBHOOK_DELIVERY_QUEUE.sendBatch(deliveries);
  }
}
