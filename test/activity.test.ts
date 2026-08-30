import { describe, expect, it } from "bun:test";
import {
  TRANSFER_TOPIC,
  analyzeBlock,
  finalizeBundles,
  classifyTransferLog,
  type NormalizedBlock,
  type NormalizedLog,
  type Receipt,
} from "../src/domain/activity";

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TOKEN = "0x1111111111111111111111111111111111111111";

function pad(hex: string): `0x${string}` {
  const bare = hex.replace(/^0x/, "").toLowerCase();
  return `0x${bare.padStart(64, "0")}` as `0x${string}`;
}

function hexOf(n: bigint | number): string {
  return `0x${BigInt(n).toString(16).padStart(64, "0")}`;
}

function transferLog(opts: {
  index: number;
  from: string;
  to: string;
  amount?: bigint;
  tokenId?: bigint;
  txHash: string;
  blockHash: string;
}): NormalizedLog {
  const is721 = opts.tokenId !== undefined;
  return {
    address: TOKEN,
    topics: ([TRANSFER_TOPIC, pad(opts.from), pad(opts.to)] as `0x${string}`[]).concat(
      is721 ? [hexOf(opts.tokenId as bigint) as `0x${string}`] : [],
    ),
    data: is721 ? "0x" : (hexOf(opts.amount as bigint) as `0x${string}`),
    logIndex: opts.index,
    transactionHash: opts.txHash as `0x${string}`,
    blockHash: opts.blockHash as `0x${string}`,
  };
}

function block(
  txs: Array<{
    hash: string;
    from: string;
    to: string | null;
    index: number;
    nonce: string;
    value: bigint;
  }>,
): NormalizedBlock {
  return {
    number: 100n,
    hash: "0xaaa",
    parentHash: "0x999",
    timestamp: 1700000000,
    transactions: txs.map((t) => ({
      hash: t.hash as `0x${string}`,
      index: t.index,
      from: t.from as `0x${string}`,
      to: (t.to as `0x${string}`) ?? null,
      nonce: t.nonce,
      value: t.value,
    })),
  };
}

function receipt(txHash: string, status: number): Receipt {
  return {
    transactionHash: txHash as `0x${string}`,
    blockHash: "0xaaa",
    status,
    contractAddress: null,
  };
}

describe("Transfer log classification", () => {
  it("decodes a strict ERC-20 transfer", () => {
    const log = transferLog({
      index: 0,
      from: A,
      to: B,
      amount: 1_000_000n,
      txHash: "0x1",
      blockHash: "0xaaa",
    });
    const result = classifyTransferLog(log);
    if (!result.ok) throw new Error(result.reason);
    expect(result.effect.kind).toBe("erc20");
    if (result.effect.kind === "erc20") {
      expect(result.effect.amount).toBe(1_000_000n);
      expect(result.effect.from).toBe(A);
      expect(result.effect.to).toBe(B);
    }
  });

  it("decodes a strict ERC-721 transfer from 4 topics", () => {
    const log = transferLog({
      index: 0,
      from: A,
      to: B,
      tokenId: 42n,
      txHash: "0x1",
      blockHash: "0xaaa",
    });
    const result = classifyTransferLog(log);
    expect(result.ok).toBe(true);
    if (result.ok && result.effect.kind === "erc721") {
      expect(result.effect.tokenId).toBe(42n);
    }
  });

  it("counts non-Transfer logs and malformed lookalikes", () => {
    const notTransfer: NormalizedLog = {
      address: TOKEN,
      topics: ["0x" + "00".repeat(32)] as `0x${string}`[],
      data: "0x",
      logIndex: 0,
      transactionHash: "0x1",
      blockHash: "0xaaa",
    };
    const tx = { hash: "0x1", from: A, to: B, index: 0, nonce: "0", value: 0n };
    const analyzed = analyzeBlock({
      block: block([tx]),
      logs: [notTransfer],
      tracked: new Set([A]),
    });
    expect(analyzed.nonTransferLogs).toBe(1);
    expect(analyzed.malformedTransferLogs).toBe(0);
  });

  it("counts a Transfer log with wrong topic count as malformed", () => {
    const malformed: NormalizedLog = {
      address: TOKEN,
      topics: [TRANSFER_TOPIC, pad(A)] as `0x${string}`[],
      data: "0x",
      logIndex: 0,
      transactionHash: "0x1",
      blockHash: "0xaaa",
    };
    const ctx = { hash: "0x1", from: A, to: B, index: 0, nonce: "0", value: 0n };
    const analyzed = analyzeBlock({
      block: block([ctx]),
      logs: [malformed],
      tracked: new Set([A]),
    });
    expect(analyzed.malformedTransferLogs).toBe(1);
  });
});

describe("matching and bundling", () => {
  it("creates a sender bundle even with zero value and no logs", async () => {
    const txs = [{ hash: "0x1", from: A, to: B, index: 0, nonce: "0", value: 0n }];
    const analyzed = analyzeBlock({ block: block(txs), logs: [], tracked: new Set([A]) });
    expect(analyzed.drafts).toHaveLength(1);
    expect(analyzed.drafts[0]?.trackedAddress).toBe(A);
    const observations = await finalizeBundles({
      chainId: 1,
      block: block(txs),
      drafts: analyzed.drafts,
      receipts: new Map([[txs[0].hash as `0x${string}`, receipt(txs[0].hash, 1)]]),
    });
    expect(observations).toHaveLength(1);
    expect(observations[0]?.transaction.status).toBe("success");
    expect(observations[0]?.effects).toHaveLength(0);
  });

  it("adds an outgoing token effect to a tracked sender", async () => {
    const txs = [{ hash: "0x1", from: A, to: TOKEN, index: 0, nonce: "0", value: 0n }];
    const logs = [
      transferLog({ index: 0, from: A, to: B, amount: 5n, txHash: "0x1", blockHash: "0xaaa" }),
    ];
    const analyzed = analyzeBlock({ block: block(txs), logs, tracked: new Set([A]) });
    const observations = await finalizeBundles({
      chainId: 1,
      block: block(txs),
      drafts: analyzed.drafts,
      receipts: new Map([[txs[0].hash as `0x${string}`, receipt(txs[0].hash, 1)]]),
    });
    expect(observations[0]?.effects).toHaveLength(1);
    const effect = observations[0]?.effects[0];
    expect(effect?.kind).toBe("erc20");
    expect(effect?.direction).toBe("outgoing");
  });

  it("marks a reverted tracked sender transaction reverted with no effects", async () => {
    const txs = [{ hash: "0x1", from: A, to: B, index: 0, nonce: "0", value: 0n }];
    const analyzed = analyzeBlock({ block: block(txs), logs: [], tracked: new Set([A]) });
    const observations = await finalizeBundles({
      chainId: 1,
      block: block(txs),
      drafts: analyzed.drafts,
      receipts: new Map([[txs[0].hash as `0x${string}`, receipt(txs[0].hash, 0)]]),
    });
    expect(observations[0]?.transaction.status).toBe("reverted");
    expect(observations[0]?.effects).toHaveLength(0);
  });

  it("drops a native incoming effect when the transaction reverted", async () => {
    const txs = [{ hash: "0x1", from: A, to: B, index: 0, nonce: "0", value: 100n }];
    const analyzed = analyzeBlock({ block: block(txs), logs: [], tracked: new Set([B]) });
    expect(analyzed.drafts[0]?.nativeIncomingAmount).toBe(100n);
    const observations = await finalizeBundles({
      chainId: 1,
      block: block(txs),
      drafts: analyzed.drafts,
      receipts: new Map([[txs[0].hash as `0x${string}`, receipt(txs[0].hash, 0)]]),
    });
    expect(observations[0]?.transaction.status).toBe("reverted");
    expect(observations[0]?.effects).toHaveLength(0);
  });

  it("emits native incoming to a tracked recipient and drops outbound native for the initiator", async () => {
    const txs = [{ hash: "0x1", from: A, to: B, index: 0, nonce: "0", value: 100n }];
    const analyzed = analyzeBlock({ block: block(txs), logs: [], tracked: new Set([A, B]) });
    // A gets a sender bundle (no native outbound), B gets a native incoming bundle.
    const obsA = analyzed.drafts.filter((d) => d.trackedAddress === A)[0];
    const obsB = analyzed.drafts.filter((d) => d.trackedAddress === B)[0];
    expect(obsA?.nativeIncomingAmount).toBe(null);
    expect(obsB?.nativeIncomingAmount).toBe(100n);

    const observations = await finalizeBundles({
      chainId: 1,
      block: block(txs),
      drafts: analyzed.drafts,
      receipts: new Map([[txs[0].hash as `0x${string}`, receipt(txs[0].hash, 1)]]),
    });
    const forA = observations.find((o) => o.trackedAddress === A);
    const forB = observations.find((o) => o.trackedAddress === B);
    expect(forA?.effects).toHaveLength(0);
    expect(forB?.effects).toHaveLength(1);
    expect(forB?.effects[0]?.kind).toBe("native");
    expect(forB?.effects[0]?.direction).toBe("incoming");
  });

  it("emits a single self effect when one tracked address is both sides of a token transfer", async () => {
    const txs = [{ hash: "0x1", from: A, to: TOKEN, index: 0, nonce: "0", value: 0n }];
    const logs = [
      transferLog({ index: 0, from: A, to: A, amount: 7n, txHash: "0x1", blockHash: "0xaaa" }),
    ];
    const analyzed = analyzeBlock({ block: block(txs), logs, tracked: new Set([A]) });
    const observations = await finalizeBundles({
      chainId: 1,
      block: block(txs),
      drafts: analyzed.drafts,
      receipts: new Map([[txs[0].hash as `0x${string}`, receipt(txs[0].hash, 1)]]),
    });
    expect(observations).toHaveLength(1);
    expect(observations[0]?.effects).toHaveLength(1);
    expect(observations[0]?.effects[0]?.direction).toBe("self");
  });

  it("orders effects deterministically: native first, then token by logIndex", async () => {
    const txs = [{ hash: "0x1", from: A, to: B, index: 0, nonce: "0", value: 10n }];
    const logs = [
      transferLog({ index: 1, from: A, to: B, amount: 5n, txHash: "0x1", blockHash: "0xaaa" }),
      transferLog({ index: 0, from: A, to: B, amount: 7n, txHash: "0x1", blockHash: "0xaaa" }),
    ];
    const analyzed = analyzeBlock({ block: block(txs), logs, tracked: new Set([B]) });
    const observations = await finalizeBundles({
      chainId: 1,
      block: block(txs),
      drafts: analyzed.drafts,
      receipts: new Map([[txs[0].hash as `0x${string}`, receipt(txs[0].hash, 1)]]),
    });
    const effects = observations[0]?.effects ?? [];
    expect(effects.map((e) => e.kind)).toEqual(["native", "erc20", "erc20"]);
    expect(effects[1]?.logIndex).toBe(0);
    expect(effects[2]?.logIndex).toBe(1);
  });

  it("assigns deterministic observation and effect ids", async () => {
    const txs = [{ hash: "0xabc", from: A, to: B, index: 0, nonce: "0", value: 10n }];
    const logs = [
      transferLog({ index: 0, from: A, to: B, amount: 5n, txHash: "0xabc", blockHash: "0xaaa" }),
    ];
    const analyzed = analyzeBlock({ block: block(txs), logs, tracked: new Set([B]) });
    const first = await finalizeBundles({
      chainId: 7,
      block: block(txs),
      drafts: analyzed.drafts,
      receipts: new Map([[txs[0].hash as `0x${string}`, receipt(txs[0].hash, 1)]]),
    });
    const second = await finalizeBundles({
      chainId: 7,
      block: block(txs),
      drafts: analyzed.drafts,
      receipts: new Map([[txs[0].hash as `0x${string}`, receipt(txs[0].hash, 1)]]),
    });
    expect(first[0]?.observationId).toBe(second[0]?.observationId);
    expect(first[0]?.effects[0]?.id).toBe(second[0]?.effects[0]?.id);
    expect(first[0]?.observationId.startsWith("evt_")).toBe(true);
  });
});
