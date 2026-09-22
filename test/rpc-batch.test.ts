import { afterEach, describe, expect, it } from "bun:test";
import {
  ethGetLogs,
  ethGetTransactionReceipts,
  fetchBlockAndLogs,
  fetchBlocksAndLogsByRange,
  jsonRpcBatch,
  setInternalRpc,
  type JsonRpcBatchItem,
} from "../src/rpc/client";
import { TRANSFER_TOPIC, analyzeBlock, finalizeBundles } from "../src/domain/activity";
import { createTransferBloomFilter } from "../src/domain/bloom";
import fixture from "./fixtures/arbitrum-bloom.json";
import type { Hex } from "viem";

const blockNumber = BigInt(fixture.block.number);
const blockHash = fixture.block.hash as Hex;
const otherHash = `0x${"ab".repeat(32)}` as Hex;
const zeroBloom = `0x${"00".repeat(256)}` as Hex;
const fullBloom = `0x${"ff".repeat(256)}` as Hex;
const tracked = `0x${fixture.logs[0].topics[1].slice(-40)}` as Hex;
const other = `0x${fixture.logs[0].topics[2].slice(-40)}` as Hex;
const transferBloom = createTransferBloomFilter({ trackedAddresses: [tracked] });
const config = { baseUrl: "https://rpc", chainId: 42161, transferBloom };
const rawBlock = { ...fixture.block, transactions: [] };
type WireRequest = JsonRpcBatchItem & { jsonrpc: "2.0" };

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  setInternalRpc(null);
});

function installRpc({ respond }: { respond: (requests: WireRequest[], call: number) => unknown }) {
  const sent: Array<{ url: string; headers: Headers; requests: WireRequest[] }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requests = JSON.parse(String(init?.body)) as WireRequest[];
    sent.push({ url: String(input), headers: new Headers(init?.headers), requests });
    return new Response(JSON.stringify(respond(requests, sent.length)), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return sent;
}

function success({ id, result }: { id: number; result: unknown }) {
  return { jsonrpc: "2.0", id, result };
}

describe("bloom-gated block/log reads", () => {
  it("reads blocks first, fetches only bloom-positive logs by hash, and tolerates response ordering", async () => {
    setInternalRpc({ secret: "s3cr3t", fanout: 3 });
    const sent = installRpc({
      respond: (requests, call) => {
        if (call === 1) {
          expect(requests.every((r) => r.method === "eth_getBlockByNumber")).toBe(true);
          return [
            success({
              id: 2,
              result: {
                ...rawBlock,
                number: `0x${(blockNumber + 1n).toString(16)}`,
                hash: otherHash,
                logsBloom: zeroBloom,
              },
            }),
            success({ id: 1, result: rawBlock }),
          ];
        }
        expect(requests).toEqual([
          {
            jsonrpc: "2.0",
            id: 1,
            method: "eth_getLogs",
            params: [{ blockHash, topics: [TRANSFER_TOPIC] }],
          },
        ]);
        return [success({ id: 1, result: [fixture.logs[0]] })];
      },
    });
    const results = await fetchBlocksAndLogsByRange({
      ...config,
      fromBlock: blockNumber,
      toBlock: blockNumber + 1n,
    });
    expect(sent).toHaveLength(2);
    expect(sent.every((call) => call.url.includes("/internal/v1/42161?fanoutCount=3"))).toBe(true);
    expect(sent.every((call) => call.headers.get("x-internal-secret") === "s3cr3t")).toBe(true);
    expect(results.map((item) => item.block.number)).toEqual([blockNumber, blockNumber + 1n]);
    expect(results[0].block.logsBloom).toBe(fixture.block.logsBloom as Hex);
    expect(results[0].logs).toHaveLength(1);
    expect(results[1].logs).toEqual([]);
  });

  it("skips all log RPCs for negative blooms while preserving sender and incoming native activity", async () => {
    const txHash = fixture.logs[0].transactionHash as Hex;
    const sent = installRpc({
      respond: () => [
        success({
          id: 1,
          result: {
            ...rawBlock,
            logsBloom: zeroBloom,
            transactions: [
              {
                hash: txHash,
                transactionIndex: "0x0",
                from: tracked,
                to: other,
                nonce: "0x1",
                value: "0x2",
              },
            ],
          },
        }),
      ],
    });
    const result = await fetchBlockAndLogs({ ...config, blockNumber });
    expect(sent).toHaveLength(1);
    expect(result.logs).toEqual([]);
    const analyzed = analyzeBlock({ ...result, tracked: new Set([tracked, other]) });
    const observations = await finalizeBundles({
      chainId: 42161,
      block: result.block,
      drafts: analyzed.drafts,
      receipts: new Map([
        [txHash, { transactionHash: txHash, blockHash, status: 1, contractAddress: null }],
      ]),
    });
    expect(observations).toHaveLength(2);
    expect(observations.find((o) => o.trackedAddress === tracked)?.initiatedByTrackedAddress).toBe(
      true,
    );
    expect(observations.find((o) => o.trackedAddress === other)?.effects[0]).toMatchObject({
      kind: "native",
      amount: "2",
    });
  });

  it("handles bloom false positives with a successful empty exact-hash result", async () => {
    const sent = installRpc({
      respond: (_requests, call) => [
        success({ id: 1, result: call === 1 ? { ...rawBlock, logsBloom: fullBloom } : [] }),
      ],
    });
    const result = await fetchBlockAndLogs({ ...config, blockNumber });
    expect(result.logs).toEqual([]);
    expect(sent).toHaveLength(2);
  });

  it("keeps already-fetched blocks while retrying failed log reads", async () => {
    const sent = installRpc({
      respond: (_requests, call) => {
        if (call === 1) return [success({ id: 1, result: rawBlock })];
        if (call === 2)
          return [
            { jsonrpc: "2.0", id: 1, error: { code: -32005, message: "opaque provider error" } },
          ];
        return [success({ id: 1, result: [fixture.logs[0]] })];
      },
    });
    const result = await fetchBlockAndLogs({ ...config, blockNumber });
    expect(result.logs).toHaveLength(1);
    expect(sent.map((call) => call.requests[0].method)).toEqual([
      "eth_getBlockByNumber",
      "eth_getLogs",
      "eth_getLogs",
    ]);
  });

  for (const [name, result] of [
    ["null block", null],
    ["missing bloom", { ...rawBlock, logsBloom: undefined }],
    ["short bloom", { ...rawBlock, logsBloom: "0x00" }],
    ["invalid bloom hex", { ...rawBlock, logsBloom: `0x${"zz".repeat(256)}` }],
    ["wrong height", { ...rawBlock, number: "0x1" }],
    ["missing transactions", { ...rawBlock, transactions: undefined }],
    ["hash-only transactions", { ...rawBlock, transactions: [fixture.logs[0].transactionHash] }],
    ["malformed transaction", { ...rawBlock, transactions: [{}] }],
    ["invalid timestamp", { ...rawBlock, timestamp: "not-hex" }],
  ] as const) {
    it(`rejects ${name} before querying logs`, async () => {
      const sent = installRpc({ respond: () => [success({ id: 1, result })] });
      await expect(fetchBlockAndLogs({ ...config, blockNumber })).rejects.toHaveProperty(
        "name",
        "RpcReadError",
      );
      expect(sent).toHaveLength(1);
    });
  }

  for (const [name, result] of [
    ["null logs", null],
    ["non-array logs", {}],
    ["malformed log", [{}]],
    ["orphaned log", [{ ...fixture.logs[0], blockHash: otherHash }]],
    ["removed log", [{ ...fixture.logs[0], removed: true }]],
    ["invalid log index", [{ ...fixture.logs[0], logIndex: "not-hex" }]],
  ] as const) {
    it(`rejects ${name} instead of reporting no activity`, async () => {
      installRpc({
        respond: (_requests, call) => [success({ id: 1, result: call === 1 ? rawBlock : result })],
      });
      await expect(fetchBlockAndLogs({ ...config, blockNumber })).rejects.toHaveProperty(
        "name",
        "RpcReadError",
      );
    });
  }

  it("rejects log errors after bounded retries", async () => {
    const sent = installRpc({
      respond: (_requests, call) =>
        call === 1
          ? [success({ id: 1, result: rawBlock })]
          : [{ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "opaque provider error" } }],
    });
    await expect(fetchBlockAndLogs({ ...config, blockNumber })).rejects.toHaveProperty(
      "name",
      "RpcReadError",
    );
    expect(sent).toHaveLength(4);
  });

  it("also rejects wrong-hash logs on the direct exact-hash path", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify(success({ id: 1, result: [{ ...fixture.logs[0], blockHash: otherHash }] })),
      )) as unknown as typeof fetch;
    await expect(ethGetLogs({ ...config, blockHash })).rejects.toThrow("Log block hash mismatch");
  });
});

describe("strict JSON-RPC batch correlation", () => {
  const requests = [
    { id: 1, method: "eth_blockNumber", params: [] },
    { id: 2, method: "eth_blockNumber", params: [] },
  ];
  for (const [name, response] of [
    ["missing response", [success({ id: 1, result: "0x1" })]],
    ["duplicate response", [success({ id: 1, result: "0x1" }), success({ id: 1, result: "0x1" })]],
    ["unexpected id", [success({ id: 1, result: "0x1" }), success({ id: 3, result: "0x1" })]],
    ["string id", [{ jsonrpc: "2.0", id: "1", result: "0x1" }, success({ id: 2, result: "0x1" })]],
    ["missing result", [{ jsonrpc: "2.0", id: 1 }, success({ id: 2, result: "0x1" })]],
    [
      "both result and error",
      [
        { ...success({ id: 1, result: "0x1" }), error: { code: -32000, message: "error" } },
        success({ id: 2, result: "0x1" }),
      ],
    ],
    ["non-array response", success({ id: 1, result: "0x1" })],
  ] as const) {
    it(`rejects ${name}`, async () => {
      installRpc({ respond: () => response });
      await expect(jsonRpcBatch({ ...config, requests })).rejects.toHaveProperty(
        "name",
        "RpcReadError",
      );
    });
  }

  it("rejects a failed HTTP status even when the body looks successful", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(requests.map(({ id }) => success({ id, result: "0x1" }))), {
        status: 502,
      })) as unknown as typeof fetch;
    await expect(jsonRpcBatch({ ...config, requests })).rejects.toThrow("HTTP 502");
  });
});

describe("receipt batch validation", () => {
  const txHash = fixture.logs[0].transactionHash as Hex;
  it("does not send an empty batch", async () => {
    const sent = installRpc({
      respond: () => {
        throw new Error("unexpected RPC");
      },
    });
    const result = await ethGetTransactionReceipts({ ...config, txHashes: [], blockHash });
    expect(result.size).toBe(0);
    expect(sent).toHaveLength(0);
  });

  for (const [name, result] of [
    ["null receipt", null],
    [
      "wrong transaction",
      { transactionHash: otherHash, blockHash, status: "0x1", contractAddress: null },
    ],
    [
      "wrong block",
      { transactionHash: txHash, blockHash: otherHash, status: "0x1", contractAddress: null },
    ],
    [
      "invalid status",
      { transactionHash: txHash, blockHash, status: "0x2", contractAddress: null },
    ],
  ] as const) {
    it(`rejects ${name}`, async () => {
      installRpc({ respond: () => [success({ id: 1, result })] });
      await expect(
        ethGetTransactionReceipts({ ...config, txHashes: [txHash], blockHash }),
      ).rejects.toHaveProperty("name", "RpcReadError");
    });
  }
});
