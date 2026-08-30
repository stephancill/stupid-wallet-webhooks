import type { Env, MatchedMessage, DeliveryHook } from "./env";
import { createApp } from "./api/app";
import { ScannerShard } from "./scanner/ScannerShard";
import { redispatchPending } from "./scanner/outbox";
import { runRetentionCleanup } from "./db/repository";
import { fanoutMatched } from "./queues/fanout";
import { deliverWebhooks } from "./queues/deliver";

const app = createApp();

export { ScannerShard };

export default {
  fetch: app.fetch.bind(app),

  // Scheduled reconciliation: redeliver unapplied scanner commands so a
  // control-plane commit that never reached a shard still gets applied, and
  // clear expired observations (7d) and delivery rows (30d) per retention.
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        await redispatchPending({ db: env.DB, env });
        await runRetentionCleanup(env.DB);
      })(),
    );
  },

  // Queue consumers (Milestone 3): fan matched activity out to subscriptions,
  // then deliver signed webhooks per destination.
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    if (batch.queue === "matched-activity") {
      await fanoutMatched(batch as unknown as MessageBatch<MatchedMessage>, env);
    } else if (batch.queue === "webhook-delivery") {
      await deliverWebhooks(batch as unknown as MessageBatch<DeliveryHook>, env);
    }
  },
};
