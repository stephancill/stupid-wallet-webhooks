/**
 * EVM RPC client over the rpc-racer service binding. Fetch blocks first, then
 * use their blooms to avoid irrelevant log reads. Required logs are queried by
 * exact block hash and every response is validated before scanner progress.
 */

import { TRANSFER_TOPIC } from "../domain/activity";
import type { NormalizedLog, NormalizedTx, NormalizedBlock, Receipt } from "../domain/activity";
import { mayContainTrackedTransfer, type TransferBloomFilter } from "../domain/bloom";
import {
  isRpcReadError,
  parseRpcData,
  quantitySchema,
  rpcBatchResponseSchema,
  rpcBlockSchema,
  rpcLogsSchema,
  rpcLogSchema,
  rpcReceiptSchema,
  rpcResponseSchema,
  rpcReadError,
} from "./schema";

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
type InternalRpcConfig = { secret: string; fanout: number; fetcher?: Fetcher };
let internalRpc: InternalRpcConfig | null = null;

export function setInternalRpc(config: InternalRpcConfig | null): void {
  internalRpc = config;
}

/**
 * Resolves which `fetch` to use for a JSON-RPC request. When a service-binding
 * fetcher is active it is used (no external egress / no extra request fee);
 * otherwise the request goes through the global client (local / fork tooling or
 * the pre-binding HTTP path).
 */
function rpcFetch(endpoint: string, init: RequestInit): Promise<Response> {
  const fetcher = internalRpc?.fetcher;
  if (fetcher !== undefined) {
    return fetcher.fetch(endpoint, init);
  }
  return fetch(endpoint, init);
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
    // Service-binding transport reaches the private route without extra request
    // fees; when no fetcher is configured we keep the private HTTP path.
    if (internalRpc.fetcher !== undefined) {
      return `https://rpc-racer.internal/internal/v1/${chainId}?fanoutCount=${internalRpc.fanout}`;
    }
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
      const response = await rpcFetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`RPC HTTP ${response.status}`);
      }
      const body = parseRpcData({
        schema: rpcResponseSchema,
        value: await response.json(),
        context: method,
      });
      if (body.id !== id)
        throw rpcReadError({ message: `Unexpected RPC response id for ${method}` });
      if (body.error) {
        throw rpcReadError({
          message: `RPC ${method} (${body.error.code}): ${body.error.message}`,
        });
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
  throw isRpcReadError(lastError)
    ? lastError
    : rpcReadError({ message: `RPC ${method} failed: ${String(lastError)}`, cause: lastError });
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
  return hx(parseRpcData({ schema: quantitySchema, value: hex, context: "head" }));
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
  const raw = await jsonRpc<unknown>({
    baseUrl,
    chainId,
    method: "eth_getBlockByNumber",
    params: [`0x${blockNumber.toString(16)}`, includeTransactions],
    signal,
  });
  return normalizeBlock({ raw, blockNumber, includeTransactions });
}

export type JsonRpcBatchItem = {
  id: number;
  method: string;
  params: unknown[];
};

type JsonRpcBatchResponseItem = { id: number; result: unknown };

/**
 * Send several JSON-RPC calls in a single HTTP POST (batch). rpc-racer forwards
 * the whole array as one Worker request. Providers still bill each RPC item.
 * Require exactly one successful response per request and return request order.
 */
export async function jsonRpcBatch({
  baseUrl,
  chainId,
  requests,
  signal,
}: {
  baseUrl: string;
  chainId: number | string;
  requests: JsonRpcBatchItem[];
  signal?: AbortSignal;
}): Promise<JsonRpcBatchResponseItem[]> {
  if (requests.length === 0) return [];
  const expectedIds = new Set(requests.map((request) => request.id));
  if (expectedIds.size !== requests.length) throw new Error("Duplicate RPC request ids");
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
      const response = await rpcFetch(endpoint, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`RPC HTTP ${response.status}`);
      }
      const parsed = parseRpcData({
        schema: rpcBatchResponseSchema,
        value: await response.json(),
        context: "batch response",
      });
      const byId = new Map<number, JsonRpcBatchResponseItem>();
      for (const item of parsed) {
        if (typeof item.id !== "number" || !expectedIds.has(item.id) || byId.has(item.id)) {
          throw rpcReadError({ message: "Unexpected or duplicate RPC response id" });
        }
        if (item.error) {
          throw rpcReadError({
            message: `RPC item ${item.id} (${item.error.code}): ${item.error.message}`,
          });
        }
        byId.set(item.id, { id: item.id, result: item.result });
      }
      if (byId.size !== requests.length)
        throw rpcReadError({ message: "Missing RPC batch responses" });
      return requests.map((request) => byId.get(request.id)!);
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
  throw isRpcReadError(lastError)
    ? lastError
    : rpcReadError({ message: `RPC batch failed: ${String(lastError)}`, cause: lastError });
}

/**
 * Single-block replay uses the same bloom and exact-hash path as range reads.
 */
export async function fetchBlockAndLogs({
  baseUrl,
  chainId,
  blockNumber,
  transferBloom,
  signal,
}: {
  baseUrl: string;
  chainId: number;
  blockNumber: bigint;
  transferBloom: TransferBloomFilter;
  signal?: AbortSignal;
}): Promise<{ block: NormalizedBlock; logs: NormalizedLog[] }> {
  const [result] = await fetchBlocksAndLogsByRange({
    baseUrl,
    chainId,
    fromBlock: blockNumber,
    toBlock: blockNumber,
    transferBloom,
    signal,
  });
  return result;
}

export type BlockAndLogs = {
  block: NormalizedBlock;
  logs: NormalizedLog[];
};

/**
 * Fetch a bounded batch of full blocks, then only the exact-hash Transfer logs
 * whose blooms might contain a tracked participant. Negative blooms need no RPC.
 */
export async function fetchBlocksAndLogsByRange({
  baseUrl,
  chainId,
  fromBlock,
  toBlock,
  transferBloom,
  signal,
}: {
  baseUrl: string;
  chainId: number;
  fromBlock: bigint;
  toBlock: bigint;
  transferBloom: TransferBloomFilter;
  signal?: AbortSignal;
}): Promise<BlockAndLogs[]> {
  const count = Number(toBlock - fromBlock) + 1;
  if (count <= 0) return [];

  const requests: JsonRpcBatchItem[] = [];
  for (let index = 0; index < count; index += 1) {
    const hex = `0x${(fromBlock + BigInt(index)).toString(16)}`;
    requests.push({ id: index + 1, method: "eth_getBlockByNumber", params: [hex, true] });
  }

  const responses = await jsonRpcBatch({
    baseUrl,
    chainId,
    requests,
    signal,
  });
  const out: BlockAndLogs[] = responses.map((response, index) => ({
    block: normalizeBlock({ raw: response.result, blockNumber: fromBlock + BigInt(index) }),
    logs: [],
  }));
  const candidates = out.filter(({ block }) =>
    mayContainTrackedTransfer({ logsBloom: block.logsBloom, filter: transferBloom }),
  );
  const logResponses = await jsonRpcBatch({
    baseUrl,
    chainId,
    requests: candidates.map(({ block }, index) => ({
      id: index + 1,
      method: "eth_getLogs",
      params: [{ blockHash: block.hash, topics: [TRANSFER_TOPIC] }],
    })),
    signal,
  });
  for (let index = 0; index < candidates.length; index += 1) {
    candidates[index].logs = normalizeLogs({
      raw: logResponses[index].result,
      blockHash: candidates[index].block.hash,
    });
  }
  return out;
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
  const raw = await jsonRpc<unknown>({
    baseUrl,
    chainId,
    method: "eth_getLogs",
    params: [{ blockHash, topics: [TRANSFER_TOPIC] }],
    signal,
  });
  return normalizeLogs({ raw, blockHash });
}

/** Batch versions: fetch many receipts in one HTTP request. */
export async function ethGetTransactionReceipts({
  baseUrl,
  chainId,
  txHashes,
  blockHash,
  signal,
}: {
  baseUrl: string;
  chainId: number;
  txHashes: `0x${string}`[];
  blockHash: `0x${string}`;
  signal?: AbortSignal;
}): Promise<Map<`0x${string}`, Receipt>> {
  if (txHashes.length === 0) {
    // No receipts needed — do not send an (invalid) empty batch.
    return new Map();
  }
  const responses = await jsonRpcBatch({
    baseUrl,
    chainId,
    requests: txHashes.map((txHash, i) => ({
      id: i + 1,
      method: "eth_getTransactionReceipt",
      params: [txHash],
    })),
    signal,
  });
  const out = new Map<`0x${string}`, Receipt>();
  txHashes.forEach((txHash, i) => {
    const receipt = normalizeReceipt(responses[i].result);
    if (
      receipt.transactionHash !== txHash.toLowerCase() ||
      receipt.blockHash !== blockHash.toLowerCase()
    ) {
      throw rpcReadError({ message: `Mismatched receipt for ${txHash}` });
    }
    out.set(txHash.toLowerCase() as `0x${string}`, receipt);
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
  const raw = await jsonRpc<unknown>({
    baseUrl,
    chainId,
    method: "eth_getTransactionReceipt",
    params: [txHash],
    signal,
  });
  if (raw === null) return null;
  const receipt = normalizeReceipt(raw);
  if (receipt.transactionHash !== txHash.toLowerCase()) {
    throw rpcReadError({ message: `Mismatched receipt for ${txHash}` });
  }
  return receipt;
}

function hx(hex: string): bigint {
  return BigInt(hex);
}

function normalizeLogs({
  raw,
  blockHash,
}: {
  raw: unknown;
  blockHash: `0x${string}`;
}): NormalizedLog[] {
  const logs = parseRpcData({ schema: rpcLogsSchema, value: raw, context: "logs" });
  return logs.map((log) => {
    if (log.blockHash.toLowerCase() !== blockHash.toLowerCase()) {
      throw rpcReadError({ message: `Log block hash mismatch for ${blockHash}` });
    }
    return normalizeLog(log);
  });
}

function normalizeLog(raw: unknown): NormalizedLog {
  const log = parseRpcData({ schema: rpcLogSchema, value: raw, context: "log" });
  return {
    address: to20(log.address),
    topics: log.topics.map((t) => t.toLowerCase() as `0x${string}`),
    data: log.data.toLowerCase() as `0x${string}`,
    logIndex: Number(hx(log.logIndex)),
    transactionHash: log.transactionHash.toLowerCase() as `0x${string}`,
    blockHash: log.blockHash.toLowerCase() as `0x${string}`,
  };
}

function normalizeReceipt(raw: unknown): Receipt {
  const receipt = parseRpcData({ schema: rpcReceiptSchema, value: raw, context: "receipt" });
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

function normalizeBlock({
  raw,
  blockNumber,
  includeTransactions = true,
}: {
  raw: unknown;
  blockNumber: bigint;
  includeTransactions?: boolean;
}): NormalizedBlock {
  const block = parseRpcData({
    schema: rpcBlockSchema,
    value: raw,
    context: `block ${blockNumber}`,
  });
  if (hx(block.number) !== blockNumber) {
    throw rpcReadError({ message: `Block number mismatch for ${blockNumber}` });
  }
  const transactions: NormalizedTx[] = [];
  for (const tx of block.transactions) {
    if (typeof tx === "string") {
      if (includeTransactions)
        throw rpcReadError({ message: `Missing full transactions for block ${blockNumber}` });
      continue;
    }
    transactions.push({
      hash: tx.hash.toLowerCase() as `0x${string}`,
      index: Number(hx(tx.transactionIndex)),
      from: to20(tx.from),
      to: tx.to === null ? null : to20(tx.to),
      nonce: hx(tx.nonce).toString(),
      value: hx(tx.value),
    });
  }
  return {
    number: hx(block.number),
    hash: block.hash.toLowerCase() as `0x${string}`,
    parentHash: block.parentHash.toLowerCase() as `0x${string}`,
    timestamp: Number(hx(block.timestamp)),
    logsBloom: block.logsBloom.toLowerCase() as `0x${string}`,
    transactions,
  };
}

export { to20, normalizeLog, normalizeReceipt, normalizeBlock };
