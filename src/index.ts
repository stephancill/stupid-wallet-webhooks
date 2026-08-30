import type { Env } from "./env";
import { createApp } from "./api/app";
import { ScannerShard } from "./scanner/ScannerShard";
import { redispatchPending } from "./scanner/outbox";

const app = createApp();

export { ScannerShard };

export default {
  fetch: app.fetch.bind(app),

  // Scheduled reconciliation: redeliver unapplied scanner commands so a
  // control-plane commit that never reached a shard still gets applied.
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        await redispatchPending({ db: env.DB, env });
      })(),
    );
  },
};
