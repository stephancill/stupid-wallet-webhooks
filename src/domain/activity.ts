/**
 * Milestone-2 activity model: strict ERC-20/ERC-721 log decoding, tracked
 * sender + incoming-native matching, and deterministic transaction-address
 * bundle → observation construction. Pure functions so the matching invariants
 * from the plan can be unit-tested with fixtures.
 */

import { hexToBigInt } from "viem";
import { observationId, effectId } from "./ids";

/** keccak256("Transfer(address,address,uint256)") */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Top-20-byte value inside a padded 32-byte topic, lowercased. */
export function topicToAddress(topic: `0x${string}`): `0x${string}` {
  const slice = topic.length >= 40 ? topic.slice(topic.length - 40) : topic;
  return `0x${slice.toLowerCase()}` as `0x${string}`;
}

function to20Hex(hex: `0x${string}`): `0x${string}` {
  const slice = hex.length >= 40 ? hex.slice(hex.length - 40) : hex;
  return `0x${slice.toLowerCase()}` as `0x${string}`;
}

export type NormalizedLog = {
  address: `0x${string}`;
  topics: `0x${string}`[];
  data: `0x${string}`;
  logIndex: number;
  transactionHash: `0x${string}`;
  blockHash: `0x${string}`;
};

export type NormalizedTx = {
  hash: `0x${string}`;
  index: number;
  from: `0x${string}`;
  to: `0x${string}` | null;
  nonce: string;
  value: bigint;
};

export type NormalizedBlock = {
  number: bigint;
  hash: `0x${string}`;
  parentHash: `0x${string}`;
  timestamp: number;
  transactions: NormalizedTx[];
};

export type Receipt = {
  transactionHash: `0x${string}`;
  blockHash: `0x${string}`;
  status: number | bigint;
  contractAddress: `0x${string}` | null;
};

export type DecodedTransfer =
  | {
      kind: "erc20";
      logIndex: number;
      assetAddress: `0x${string}`;
      from: `0x${string}`;
      to: `0x${string}`;
      amount: bigint;
    }
  | {
      kind: "erc721";
      logIndex: number;
      assetAddress: `0x${string}`;
      from: `0x${string}`;
      to: `0x${string}`;
      tokenId: bigint;
    };

export type TransferDecodeResult =
  | { ok: true; effect: DecodedTransfer }
  | { ok: false; reason: string };

/**
 * Strict Transfer log decoding. ERC-20 requires exactly three topics and one
 * 32-byte data word. ERC-721 requires four topics with the token id in topic 3.
 * Anything else is counted as malformed and never emitted.
 */
export function classifyTransferLog(log: NormalizedLog): TransferDecodeResult {
  if (log.topics.length === 0 || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) {
    return { ok: false, reason: "not-a-transfer" };
  }

  if (log.topics.length === 3 && log.data.length === 66) {
    return {
      ok: true,
      effect: {
        kind: "erc20",
        logIndex: log.logIndex,
        assetAddress: log.address.toLowerCase() as `0x${string}`,
        from: topicToAddress(log.topics[1]),
        to: topicToAddress(log.topics[2]),
        amount: hexToBigInt(log.data as `0x${string}`),
      },
    };
  }

  if (log.topics.length === 4) {
    return {
      ok: true,
      effect: {
        kind: "erc721",
        logIndex: log.logIndex,
        assetAddress: log.address.toLowerCase() as `0x${string}`,
        from: topicToAddress(log.topics[1]),
        to: topicToAddress(log.topics[2]),
        tokenId: hexToBigInt(log.topics[3] as `0x${string}`),
      },
    };
  }

  return { ok: false, reason: "unexpected-topics-or-data" };
}

/** Token effect exactly as it appears in a bundle (ids assigned on finalize). */
export type TokenEffectEvent = {
  kind: "erc20" | "erc721";
  direction: "incoming" | "outgoing" | "self";
  logIndex: number;
  from: `0x${string}`;
  to: `0x${string}`;
  assetAddress: `0x${string}`;
  amount?: bigint;
  tokenId?: bigint;
};

export type BundleDraft = {
  trackedAddress: `0x${string}`;
  initiatedByTrackedAddress: boolean;
  txHash: `0x${string}`;
  txIndex: number;
  txFrom: `0x${string}`;
  txTo: `0x${string}` | null;
  nonce: string;
  value: bigint;
  tokenEffects: TokenEffectEvent[];
  nativeIncomingFrom: `0x${string}` | null;
  nativeIncomingAmount: bigint | null;
};

export type AnalyzeResult = {
  drafts: BundleDraft[];
  receiptHashes: string[];
  malformedTransferLogs: number;
  nonTransferLogs: number;
};

/**
 * Analyzes a block + its logs against a tracked set. Produces one draft per
 * (transaction, trackedAddress) with any tracked involvement and the set of
 * receipts required to finalize status.
 */
export function analyzeBlock({
  block,
  logs,
  tracked,
}: {
  block: NormalizedBlock;
  logs: NormalizedLog[];
  tracked: Set<`0x${string}`>;
}): AnalyzeResult {
  const drafts = new Map<string, BundleDraft>();
  const key = (txHash: string, trackedAddress: string) => `${txHash}:${trackedAddress}`;

  const txByHash = new Map(block.transactions.map((tx) => [tx.hash, tx]));

  const ensureDraft = (tx: NormalizedTx, trackedAddress: `0x${string}`): BundleDraft => {
    const k = key(tx.hash, trackedAddress);
    const existing = drafts.get(k);
    if (existing !== undefined) return existing;
    const draft: BundleDraft = {
      trackedAddress,
      initiatedByTrackedAddress: tx.from.toLowerCase() === trackedAddress,
      txHash: tx.hash,
      txIndex: tx.index,
      txFrom: to20Hex(tx.from),
      txTo: tx.to === null ? null : to20Hex(tx.to),
      nonce: tx.nonce,
      value: tx.value,
      tokenEffects: [],
      nativeIncomingFrom: null,
      nativeIncomingAmount: null,
    };
    drafts.set(k, draft);
    return draft;
  };

  let malformedTransferLogs = 0;
  let nonTransferLogs = 0;

  // 1. Every mined top-level transaction authored by a tracked address becomes
  //    a bundle (successful or reverted, zero or nonzero value).
  for (const tx of block.transactions) {
    const from = to20Hex(tx.from);
    if (tracked.has(from)) {
      ensureDraft(tx, from);
    }
  }

  // 2. Decoded token effects attach to the bundle of every tracked participant.
  for (const log of logs) {
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) {
      nonTransferLogs += 1;
      continue;
    }
    const decoded = classifyTransferLog(log);
    if (!decoded.ok) {
      malformedTransferLogs += 1;
      continue;
    }
    const capture = decoded.effect;
    const tx = txByHash.get(log.transactionHash);
    if (tx === undefined) continue;

    const from = capture.from;
    const to = capture.to;
    const isFromTracked = tracked.has(from);
    const isToTracked = tracked.has(to);

    const body = {
      kind: capture.kind,
      logIndex: capture.logIndex,
      from,
      to,
      assetAddress: capture.assetAddress,
      ...(capture.kind === "erc20" ? { amount: capture.amount } : {}),
      ...(capture.kind === "erc721" ? { tokenId: capture.tokenId } : {}),
    };

    if (isFromTracked && isToTracked) {
      ensureDraft(tx, from).tokenEffects.push({ ...body, direction: "self" });
    } else if (isFromTracked) {
      ensureDraft(tx, from).tokenEffects.push({ ...body, direction: "outgoing" });
    } else if (isToTracked) {
      ensureDraft(tx, to).tokenEffects.push({ ...body, direction: "incoming" });
    }
  }

  // 3. Incoming native: a value-bearing transfer whose `to` is tracked becomes
  //    a native effect on that recipient's bundle (receipt status is checked at
  //    finalize; reverted value is dropped there).
  for (const tx of block.transactions) {
    if (tx.to === null || tx.value <= 0n) continue;
    const to = to20Hex(tx.to);
    if (tracked.has(to)) {
      const draft = ensureDraft(tx, to);
      draft.nativeIncomingFrom = to20Hex(tx.from);
      draft.nativeIncomingAmount = tx.value;
    }
  }

  return {
    drafts: [...drafts.values()],
    receiptHashes: [...new Set(txHashesOf(drafts))],
    malformedTransferLogs,
    nonTransferLogs,
  };
}

function txHashesOf(drafts: Map<string, BundleDraft>): string[] {
  return [...drafts.values()].map((d) => d.txHash);
}

export type Effect = {
  id: string;
  kind: "native" | "erc20" | "erc721";
  direction: "incoming" | "outgoing" | "self";
  logIndex: number | null;
  from: `0x${string}`;
  to: `0x${string}`;
  assetAddress?: `0x${string}`;
  amount?: string;
  tokenId?: string;
};

export type Observation = {
  observationId: string;
  chainId: number;
  trackedAddress: `0x${string}`;
  initiatedByTrackedAddress: boolean;
  blockNumber: string;
  blockHash: `0x${string}`;
  blockTimestamp: string;
  transaction: {
    hash: `0x${string}`;
    index: number;
    from: `0x${string}`;
    to: `0x${string}` | null;
    status: "success" | "reverted";
    nonce: string;
    value: string;
    createdContractAddress?: `0x${string}`;
  };
  effects: Effect[];
};

/**
 * Finalizes drafts with their receipts. Resolves status, drops effects from
 * reverted transactions, orders effects deterministically (incoming native
 * first, then tokens ascending by logIndex), and attaches deterministic
 * observation + effect ids.
 *
 * Throws when a required receipt is missing or its block hash mismatches, so
 * the caller never advances its cursor on incomplete processing.
 */
export async function finalizeBundles({
  chainId,
  block,
  drafts,
  receipts,
}: {
  chainId: number;
  block: NormalizedBlock;
  drafts: BundleDraft[];
  receipts: Map<`0x${string}`, Receipt>;
}): Promise<Observation[]> {
  const observations: Observation[] = [];

  for (const draft of drafts) {
    const receipt = receipts.get(draft.txHash);
    if (receipt === undefined || receipt.blockHash.toLowerCase() !== block.hash.toLowerCase()) {
      throw new Error(`missing or mismatched receipt for ${draft.txHash}`);
    }
    const successful = isSuccess(receipt.status);
    const obsId = await observationId({
      chainId,
      txHash: draft.txHash,
      trackedAddress: draft.trackedAddress,
      blockHash: block.hash,
    });

    const effects: Effect[] = [];
    if (successful) {
      if (draft.nativeIncomingAmount !== null && draft.nativeIncomingFrom !== null) {
        effects.push({
          id: await effectId({ observationId: obsId, kind: "native" }),
          kind: "native",
          direction: "incoming",
          logIndex: null,
          from: draft.nativeIncomingFrom,
          to: draft.trackedAddress,
          amount: draft.nativeIncomingAmount.toString(),
        });
      }
      const orderedToken = [...draft.tokenEffects].sort((a, b) => a.logIndex - b.logIndex);
      for (const token of orderedToken) {
        effects.push({
          id: await effectId({ observationId: obsId, kind: token.kind, logIndex: token.logIndex }),
          kind: token.kind,
          direction: token.direction,
          logIndex: token.logIndex,
          from: token.from,
          to: token.to,
          assetAddress: token.assetAddress,
          ...(token.amount !== undefined ? { amount: token.amount.toString() } : {}),
          ...(token.tokenId !== undefined ? { tokenId: token.tokenId.toString() } : {}),
        });
      }
    }

    observations.push({
      observationId: obsId,
      chainId,
      trackedAddress: draft.trackedAddress,
      initiatedByTrackedAddress: draft.initiatedByTrackedAddress,
      blockNumber: block.number.toString(),
      blockHash: block.hash,
      blockTimestamp: String(block.timestamp),
      transaction: {
        hash: draft.txHash,
        index: draft.txIndex,
        from: draft.txFrom,
        to: draft.txTo,
        status: successful ? "success" : "reverted",
        nonce: draft.nonce,
        value: draft.value.toString(),
        ...(successful && receipt.contractAddress !== null
          ? { createdContractAddress: receipt.contractAddress }
          : {}),
      },
      effects,
    });
  }

  observations.sort((a, b) =>
    a.transaction.hash < b.transaction.hash
      ? -1
      : a.transaction.hash > b.transaction.hash
        ? 1
        : a.trackedAddress < b.trackedAddress
          ? -1
          : 1,
  );
  return observations;
}

export function isSuccess(status: number | bigint): boolean {
  return typeof status === "bigint" ? status !== 0n : status !== 0;
}

/** Builds the stored/delivered `data` payload for an observation. */
export function observationData(observation: Observation): Record<string, unknown> {
  return {
    chainId: observation.chainId,
    trackedAddress: observation.trackedAddress,
    initiatedByTrackedAddress: observation.initiatedByTrackedAddress,
    blockNumber: observation.blockNumber,
    blockHash: observation.blockHash,
    blockTimestamp: observation.blockTimestamp,
    transaction: observation.transaction,
    effects: observation.effects,
  };
}
