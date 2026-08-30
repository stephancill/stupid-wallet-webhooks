import type { DeliveryHook } from "../env";
import { IDs } from "../domain/ids";
import { buildWebhookJson, parseObservationData } from "./webhook-body";

/**
 * Pure fan-out planning: given an observation and a set of eligible
 * subscriptions, emits one delivery per destination, also enforcing each
 * subscription's activation block. This is deterministic and unit-testable
 * without a queue.
 */
export function planFanOutDeliveries({
  observation,
  subscriptions,
}: {
  observation: {
    observationId: string;
    chainId: number;
    trackedAddress: string;
    blockNumber: string;
    data: string;
  };
  subscriptions: Array<{
    id: string;
    account_id: string;
    webhook_id: string;
    active_from_block: number | null;
  }>;
}): Array<{ key: string; body: DeliveryHook }> {
  const data = parseObservationData(observation.data);
  const block = Number(observation.blockNumber);
  const out: Array<{ key: string; body: DeliveryHook }> = [];

  for (const subscription of subscriptions) {
    if (subscription.active_from_block !== null && subscription.active_from_block > block) {
      continue; // not yet eligible for this block
    }
    const built = buildWebhookJson({
      id: observation.observationId,
      type: "activity.observed",
      data,
    });
    out.push({
      key: `d-${subscription.webhook_id}:${observation.observationId}`,
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
      },
    });
  }
  return out;
}

/** Classifies a webhook attempt outcome into a stable delivery status. */
export function classifyDelivery({
  delivered,
  retryable,
}: {
  delivered: boolean;
  retryable: boolean;
}): "success" | "retry" | "dead_lettered" {
  if (delivered) return "success";
  return retryable ? "retry" : "dead_lettered";
}

/** True when a prior successful delivery makes this redelivery a no-op. */
export function shouldSkip(hasSucceededWhileAccounted: boolean): boolean {
  return hasSucceededWhileAccounted;
}
