export type Env = {
  DB: D1Database;
  SCANNER_SHARD_1: DurableObjectNamespace;
  SCANNER_SHARD_2: DurableObjectNamespace;
  RPC_RACER_BASE_URL: string;
  SCANNER_SHARD_COUNT: string;
  SUBSCRIPTION_DEFAULT_QUOTA: string;
  CHAIN_DEFAULT_QUOTA: string;
  OPERATOR_SECRET: string;
  API_KEY_PEPPER: string;
  WEBHOOK_SIGNING_MASTER: string;
  RATELIMITER?: RateLimitTask;
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
