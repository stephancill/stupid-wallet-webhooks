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
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/${chainId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
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
  transactionIndex: string;
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
  transactions: RpcTx[];
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
  const transactions: NormalizedTx[] = block.transactions.map((tx, index) => ({
    hash: tx.hash.toLowerCase() as `0x${string}`,
    index: tx.transactionIndex === undefined ? index : Number(hx(tx.transactionIndex)),
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
