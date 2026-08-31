/**
 * EVM RPC client over the rpc-racer proxy. For Milestone 2 this reaches the
 * public endpoint over HTTP (the plan's Milestone 0 private service binding and
 * lower fanout land later). Reads use the block hash created by
 * `eth_getBlockByNumber` to query logs, so a lagging upstream can't return an
 * incomplete empty log set for a freshly mined height.
 */

import { TRANSFER_TOPIC } from "../domain/activity";
import type { NormalizedLog, NormalizedTx, NormalizedBlock, Receipt } from "../domain/activity";

export type RpcResult =
  | {
      ok: true;
      value: unknown;
    }
  | {
      ok: false;
      reason: string;
    };

const RETRIES = 3;
const BASE_TIMEOUT_MS = 5_000;

/**
 * Resolves where a JSON-RPC call should be sent. `RPC_DIRECT_URL` (set by the
 * fork/integration test or a scanner override) sends plain JSON-RPC and ignores
 * the chain selector; otherwise we use the rpc-racer path. When the internal
 * scanner config is enabled (shared secret + low fan-out) we target rpc-racer's
 * `/internal/v1/:chainId` route, which bypasses the public per-IP rate limit.
 */
type InternalRpcConfig = { secret: string; fanout: number };
let internalRpc: InternalRpcConfig | null = null;

export function setInternalRpc(config: InternalRpcConfig | null): void {
  internalRpc = config;
}

export function ENDPOINT({
  baseUrl,
  chainId,
}: {
  baseUrl: string;
  chainId: number | string;
}): string {
  // RPC_DIRECT_URL is a bun (test/fork) escape hatch; `process` doesn't exist in
  // the Workers runtime, so guard it.
  const direct = typeof process !== "undefined" ? process.env.RPC_DIRECT_URL : undefined;
  if (typeof direct === "string" && direct.trim().length > 0) {
    return direct.trim().replace(/\/$/, "");
  }
  const base = baseUrl.replace(/\/$/, "");
  if (internalRpc !== null) {
    return `${base}/internal/v1/${chainId}?fanoutCount=${internalRpc.fanout}`;
  }
  return `${base}/v1/${chainId}`;
}

export async function jsonRpc<T>({
  baseUrl,
  chainId,
  method,
  params,
  id = 1,
  signal,
}: {
  baseUrl: string;
  chainId: number | string;
  method: string;
  params: unknown[];
  id?: number;
  signal?: AbortSignal;
}): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < RETRIES; attempt += 1) {
    const controller = new AbortController();
    const parent = signal;
    const onAbort = () => controller.abort();
    if (parent?.aborted) throw new Error("aborted");
    parent?.addEventListener("abort", onAbort, { once: true });

    const timeoutMs = BASE_TIMEOUT_MS * (attempt + 1);
    const timeout = setTimeout(() => controller.abort("RPC timeout"), timeoutMs);
    try {
      const endpoint = ENDPOINT({ baseUrl, chainId });
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (internalRpc !== null && internalRpc.secret !== "") {
        headers["x-internal-secret"] = internalRpc.secret;
      }
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id }),
        signal: controller.signal,
      });
      if (!response.ok && response.status !== 502) {
        throw new Error(`RPC HTTP ${response.status}`);
      }
      const body = (await response.json()) as {
        result?: unknown;
        error?: { message?: string };
      };
      if (body.error) {
        throw new Error(body.error.message ?? "RPC error");
      }
      return body.result as T;
    } catch (error) {
      lastError = error;
      if (parent?.aborted) throw error;
      if (error instanceof Error && error.message === "aborted") throw error;
      const isTimeout = error instanceof Error && error.name === "AbortError";
      if (!isTimeout) {
        await sleep(100 * 2 ** attempt);
      }
    } finally {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", onAbort);
    }
  }
  throw lastError;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function ethBlockNumber({
  baseUrl,
  chainId,
  signal,
}: {
  baseUrl: string;
  chainId: number;
  signal?: AbortSignal;
}): Promise<bigint> {
  const hex = await jsonRpc<`0x${string}`>({
    baseUrl,
    chainId,
    method: "eth_blockNumber",
    params: [],
    signal,
  });
  return hx(hex);
}

export async function ethGetBlockByNumber({
  baseUrl,
  chainId,
  blockNumber,
  includeTransactions = true,
  signal,
}: {
  baseUrl: string;
  chainId: number;
  blockNumber: bigint;
  includeTransactions?: boolean;
  signal?: AbortSignal;
}): Promise<NormalizedBlock> {
  const raw = await jsonRpc<RpcBlock>({
    baseUrl,
    chainId,
    method: "eth_getBlockByNumber",
    params: [`0x${blockNumber.toString(16)}`, includeTransactions],
    signal,
  });
  if (raw === null) throw new Error(`block ${blockNumber} not found`);
  return normalizeBlock(raw);
}

export type JsonRpcBatchItem = {
  id: number;
  method: string;
  params: unknown[];
};

type JsonRpcBatchResponseItem = { id: unknown; result?: unknown; error?: { message?: string } };

/**
 * Send several JSON-RPC calls in a single HTTP POST (batch). rpc-racer forwards
 * the whole array as one Worker request and returns the array, collapsing N HTTP
 * round-trips into 1 (and thus N billable requests into 1).
 */
export async function jsonRpcBatch<
  T extends Array<{ id: unknown; result?: unknown; error?: { message?: string } }>,
>({
  baseUrl,
  chainId,
  requests,
  signal,
}: {
  baseUrl: string;
  chainId: number | string;
  requests: JsonRpcBatchItem[];
  signal?: AbortSignal;
}): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < RETRIES; attempt += 1) {
    const controller = new AbortController();
    const parent = signal;
    const onAbort = () => controller.abort("aborted");
    if (parent?.aborted) throw new Error("aborted");
    parent?.addEventListener("abort", onAbort, { once: true });

    const timeoutMs = BASE_TIMEOUT_MS * (attempt + 1);
    const timeout = setTimeout(() => controller.abort("RPC timeout"), timeoutMs);
    try {
      const endpoint = ENDPOINT({ baseUrl, chainId });
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (internalRpc !== null && internalRpc.secret !== "") {
        headers["x-internal-secret"] = internalRpc.secret;
      }
      const body = JSON.stringify(
        requests.map((r) => ({ jsonrpc: "2.0", method: r.method, params: r.params, id: r.id })),
      );
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      if (!response.ok && response.status !== 502) {
        throw new Error(`RPC HTTP ${response.status}`);
      }
      const parsed = (await response.json()) as T;
      if (!Array.isArray(parsed)) {
        throw new Error("Expected a JSON-RPC batch response");
      }
      return parsed;
    } catch (error) {
      lastError = error;
      if (parent?.aborted) throw error;
      if (error instanceof Error && error.message === "aborted") throw error;
      const isTimeout = error instanceof Error && error.name === "AbortError";
      if (!isTimeout) {
        await sleep(100 * 2 ** attempt);
      }
    } finally {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", onAbort);
    }
  }
  throw lastError;
}

/**
 * Fetch a block and its logs in one batch HTTP request (instead of two). The
 * block header + canonical hash comes back with logs for the same block number;
 * logs are filtered to the block hash so a lagging upstream can't inject an
 * unrelated/empty log set for the polled height.
 */
export async function fetchBlockAndLogs({
  baseUrl,
  chainId,
  blockNumber,
  signal,
}: {
  baseUrl: string;
  chainId: number;
  blockNumber: bigint;
  signal?: AbortSignal;
}): Promise<{ block: NormalizedBlock; logs: NormalizedLog[] }> {
  const hex = `0x${blockNumber.toString(16)}`;
  const responses = await jsonRpcBatch<JsonRpcBatchResponseItem[]>({
    baseUrl,
    chainId,
    requests: [
      { id: 1, method: "eth_getBlockByNumber", params: [hex, true] },
      // Keep the same topic filter as the non-batched path so we only pull
      // transfer logs (not every log in the block).
      {
        id: 2,
        method: "eth_getLogs",
        params: [{ fromBlock: hex, toBlock: hex, topics: [TRANSFER_TOPIC] }],
      },
    ],
    signal,
  });
  const byId = new Map<number, JsonRpcBatchResponseItem>(responses.map((r) => [Number(r.id), r]));
  const blockItem = byId.get(1);
  const logsItem = byId.get(2);
  if (blockItem?.result === undefined) {
    throw new Error(`block ${blockNumber} not found`);
  }
  const block = normalizeBlock(blockItem.result as RpcBlock);
  const logsRaw = Array.isArray(logsItem?.result) ? (logsItem.result as RpcLog[]) : [];
  const logs = logsRaw
    .filter((log) => log.blockHash.toLowerCase() === block.hash.toLowerCase())
    .map(normalizeLog);
  return { block, logs };
}

/** Fetches transfer logs for a specific block hash; rejects on any mismatch. */
export async function ethGetLogs({
  baseUrl,
  chainId,
  blockHash,
  signal,
}: {
  baseUrl: string;
  chainId: number;
  blockHash: `0x${string}`;
  signal?: AbortSignal;
}): Promise<NormalizedLog[]> {
  const raw = await jsonRpc<RpcLog[]>({
    baseUrl,
    chainId,
    method: "eth_getLogs",
    params: [{ blockHash, topics: [TRANSFER_TOPIC] }],
    signal,
  });
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((log) => log.blockHash.toLowerCase() === blockHash.toLowerCase())
    .map(normalizeLog);
}

/** Batch versions: fetch many receipts in one HTTP request. */
export async function ethGetTransactionReceipts({
  baseUrl,
  chainId,
  txHashes,
  signal,
}: {
  baseUrl: string;
  chainId: number;
  txHashes: `0x${string}`[];
  signal?: AbortSignal;
}): Promise<Map<`0x${string}`, Receipt>> {
  const responses = await jsonRpcBatch<JsonRpcBatchResponseItem[]>({
    baseUrl,
    chainId,
    requests: txHashes.map((txHash, i) => ({
      id: i + 1,
      method: "eth_getTransactionReceipt",
      params: [txHash],
    })),
    signal,
  });
  const byId = new Map<number, JsonRpcBatchResponseItem>(responses.map((r) => [Number(r.id), r]));
  const out = new Map<`0x${string}`, Receipt>();
  txHashes.forEach((txHash, i) => {
    const res = byId.get(i + 1)?.result;
    if (res !== undefined && res !== null) {
      out.set(txHash.toLowerCase() as `0x${string}`, normalizeReceipt(res as RpcReceipt));
    }
  });
  return out;
}

export async function ethGetTransactionReceipt({
  baseUrl,
  chainId,
  txHash,
  signal,
}: {
  baseUrl: string;
  chainId: number;
  txHash: `0x${string}`;
  signal?: AbortSignal;
}): Promise<Receipt | null> {
  const raw = await jsonRpc<RpcReceipt | null>({
    baseUrl,
    chainId,
    method: "eth_getTransactionReceipt",
    params: [txHash],
    signal,
  });
  if (raw === null) return null;
  return normalizeReceipt(raw);
}

type RpcLog = {
  address: string;
  topics: string[];
  data: string;
  logIndex: string;
  transactionHash: string;
  blockHash: string;
};

type RpcReceipt = {
  transactionHash: string;
  blockHash: string;
  status: string;
  contractAddress: string | null;
};

type RpcTx = {
  hash: string;
  transactionIndex?: string;
  from: string;
  to: string | null;
  nonce: string;
  value: string;
};

type RpcBlock = {
  number: string;
  hash: string;
  parentHash: string;
  timestamp: string;
  transactions: Array<RpcTx | string>;
} | null;

function hx(hex: string): bigint {
  return BigInt(hex);
}

function normalizeLog(log: RpcLog): NormalizedLog {
  return {
    address: to20(log.address),
    topics: log.topics.map((t) => t.toLowerCase() as `0x${string}`),
    data: log.data.toLowerCase() as `0x${string}`,
    logIndex: Number(hx(log.logIndex)),
    transactionHash: log.transactionHash.toLowerCase() as `0x${string}`,
    blockHash: log.blockHash.toLowerCase() as `0x${string}`,
  };
}

function normalizeReceipt(receipt: RpcReceipt): Receipt {
  return {
    transactionHash: receipt.transactionHash.toLowerCase() as `0x${string}`,
    blockHash: receipt.blockHash.toLowerCase() as `0x${string}`,
    status: hx(receipt.status),
    contractAddress: receipt.contractAddress === null ? null : to20(receipt.contractAddress),
  };
}

function to20(hex: string): `0x${string}` {
  const slice = hex.length >= 40 ? hex.slice(hex.length - 40) : hex;
  return `0x${slice.toLowerCase()}` as `0x${string}`;
}

function normalizeBlock(block: RpcBlock): NormalizedBlock {
  if (block === null) throw new Error("null block");
  const entries = Array.isArray(block.transactions) ? block.transactions : [];
  const transactions: NormalizedTx[] = entries
    .filter((tx): tx is RpcTx => typeof tx === "object" && tx !== null)
    .map((tx) => ({
      hash: tx.hash.toLowerCase() as `0x${string}`,
      index: tx.transactionIndex === undefined ? 0 : Number(hx(tx.transactionIndex)),
      from: to20(tx.from),
      to: tx.to === null ? null : to20(tx.to),
      nonce: hx(tx.nonce).toString(),
      value: hx(tx.value),
    }));
  return {
    number: hx(block.number),
    hash: block.hash.toLowerCase() as `0x${string}`,
    parentHash: block.parentHash.toLowerCase() as `0x${string}`,
    timestamp: Number(hx(block.timestamp)),
    transactions,
  };
}

export { to20, normalizeLog, normalizeReceipt, normalizeBlock };
