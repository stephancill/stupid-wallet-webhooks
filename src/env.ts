export type Env = {
  DB: D1Database;
  SCANNER_SHARD_1: DurableObjectNamespace;
  SCANNER_SHARD_2: DurableObjectNamespace;
  MATCHED_ACTIVITY_QUEUE: Queue<MatchedMessage>;
  WEBHOOK_DELIVERY_QUEUE: Queue<DeliveryHook>;
  /** Static assets binding (`public/`). */
  ASSETS?: Fetcher;

  ALLOW_INSECURE_TEST_WEBHOOKS?: string;
  RPC_RACER_BASE_URL: string;
  RPC_INTERNAL_SECRET?: string;
  RPC_SCANNER_FANOUT?: string;
  SCANNER_SHARD_COUNT: string;
  /** Blocks processed per scan pass before yielding (default 20). */
  SCANNER_MAX_BLOCKS_PER_PASS?: string;
  /** Fastest catch-up poll cadence in ms (default 1000). */
  SCANNER_MIN_POLL_INTERVAL_MS?: string;
  SUBSCRIPTION_DEFAULT_QUOTA: string;
  CHAIN_DEFAULT_QUOTA: string;
  DELIVERY_LATENCY_ALERT_MS?: string;
  OPERATOR_SECRET: string;
  API_KEY_PEPPER: string;
  WEBHOOK_SIGNING_MASTER: string;
  RATELIMITER?: RateLimitTask;
};

/** One message per (chainId, transactionHash, trackedAddress) observation. */
export type MatchedMessage = {
  observationId: string;
  chainId: number;
  txHash: string;
  trackedAddress: string;
  blockNumber: string;
  blockHash: string;
};

/**
 * One message per (observation, destination) on the `webhook-delivery` queue.
 * `bodyJson` is the exact, pre-serialized HTTP body that gets signed and sent,
 * so retries reproduce a byte-identical, deterministically-signable payload.
 */
export type DeliveryHook = {
  deliveryId: string;
  observationId: string;
  eventType: "activity.observed" | "activity.reverted" | "webhook.test";
  accountId: string;
  webhookId: string;
  chainId: number;
  trackedAddress?: string;
  blockNumber?: string;
  bodyJson: string;
};

export type RateLimitTask = {
  limit: (options: {
    key: string;
  }) => Promise<{ success: true } | { success: false; info?: undefined }>;
};

export type ScannerEnv = Pick<
  Env,
  "DB" | "SCANNER_SHARD_1" | "SCANNER_SHARD_2" | "RPC_RACER_BASE_URL"
>;

/** Resolves the scanner shard namespace for a given shard id (0-based). */
export function shardNamespace(env: Env, shardId: number): DurableObjectNamespace {
  return shardId === 0 ? env.SCANNER_SHARD_1 : env.SCANNER_SHARD_2;
}

export function shardName(shardId: number): string {
  return shardId === 0 ? "SCANNER_SHARD_1" : "SCANNER_SHARD_2";
}

export function shardCount(env: Env): number {
  const parsed = Number.parseInt(env.SCANNER_SHARD_COUNT, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2;
}
