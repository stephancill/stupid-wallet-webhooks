import { afterEach, describe, expect, it } from "bun:test";
import {
  ethGetTransactionReceipts,
  fetchBlockAndLogs,
  fetchBlocksAndLogsByRange,
  setInternalRpc,
} from "../src/rpc/client";
import { TRANSFER_TOPIC } from "../src/domain/activity";

/**
 * Proves the scanner fetches a block + its logs in ONE batched HTTP request to
 * rpc-racer's internal route (not two), which is what collapses rpc-racer
 * Worker requests per block.
 */
describe("block+logs RPC batch", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    setInternalRpc(null);
  });

  it("sends one array to the internal route and returns block+logs", async () => {
    setInternalRpc({ secret: "s3cr3t", fanout: 3 });

    const sent: Array<{ url: string; method: string; headers: Headers; body: unknown }> = [];
    const blockHash = ("0x" + "ab".repeat(32)) as `0x${string}`;
    const responseArray = [
      {
        jsonrpc: "2.0",
        id: 1,
        result: {
          number: "0x10",
          hash: blockHash,
          parentHash: "0x" + "00".repeat(32),
          timestamp: "0x641f9f00",
          transactions: [],
        },
      },
      {
        jsonrpc: "2.0",
        id: 2,
        result: [
          {
            address: "0x" + "11".repeat(20),
            topics: [TRANSFER_TOPIC],
            data: "0x0",
            logIndex: "0x0",
            transactionHash: "0x" + "22".repeat(32),
            blockHash,
          },
        ],
      },
    ];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({
        url: String(input),
        method: (init?.method ?? "GET") as string,
        headers: new Headers(init?.headers),
        body: init?.body,
      });
      return new Response(JSON.stringify(responseArray), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const { block, logs } = await fetchBlockAndLogs({
      baseUrl: "https://evm.stupidtech.net",
      chainId: 8453,
      blockNumber: 16n,
    });

    expect(sent).toHaveLength(1);
    const req = sent[0];
    expect(req.url).toContain("/internal/v1/8453");
    expect(req.headers.get("x-internal-secret")).toBe("s3cr3t");

    const parsedBody = JSON.parse(req.body as string);
    expect(parsedBody).toHaveLength(2);
    expect(parsedBody.map((x: { method: string }) => x.method)).toEqual([
      "eth_getBlockByNumber",
      "eth_getLogs",
    ]);
    // logs must keep the transfer-only topic filter (not every log in the block).
    expect(parsedBody[1].params[0].topics).toEqual([TRANSFER_TOPIC]);

    expect(block.number).toBe(16n);
    expect(logs).toHaveLength(1);
  });
});

describe("receipts batch", () => {
  it("does not send an (invalid) empty batch when there are no receipts", async () => {
    const real = globalThis.fetch;
    let called = 0;
    globalThis.fetch = (async () => {
      called += 1;
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "should not reach" } }),
        { status: 400 },
      );
    }) as unknown as typeof fetch;
    const m = await ethGetTransactionReceipts({
      baseUrl: "https://evm.stupidtech.net",
      chainId: 1,
      txHashes: [],
    });
    expect(called).toBe(0);
    expect(m.size).toBe(0);
    globalThis.fetch = real;
  });
});

describe("range batch (bounded block prefetch)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    setInternalRpc(null);
  });

  it("sends 2 JSON-RPC items per block and returns them in order", async () => {
    setInternalRpc({ secret: "s3cr3t", fanout: 3 });

    const sent: Array<{ body: unknown }> = [];
    const hashA = ("0x" + "aa".repeat(32)) as `0x${string}`;
    const hashB = ("0x" + "bb".repeat(32)) as `0x${string}`;
    const responseArray = [
      {
        jsonrpc: "2.0",
        id: 1,
        result: {
          number: "0x10",
          hash: hashA,
          parentHash: "0x" + "00".repeat(32),
          timestamp: "0x641f9f00",
          transactions: [],
        },
      },
      { jsonrpc: "2.0", id: 2, result: [] },
      {
        jsonrpc: "2.0",
        id: 3,
        result: {
          number: "0x11",
          hash: hashB,
          parentHash: hashA,
          timestamp: "0x641f9f0c",
          transactions: [],
        },
      },
      {
        jsonrpc: "2.0",
        id: 4,
        result: [
          {
            address: "0x" + "11".repeat(20),
            topics: [TRANSFER_TOPIC],
            data: "0x0",
            logIndex: "0x0",
            transactionHash: "0x" + "22".repeat(32),
            blockHash: hashB,
          },
        ],
      },
    ];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ body: init?.body });
      return new Response(JSON.stringify(responseArray), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const blocks = await fetchBlocksAndLogsByRange({
      baseUrl: "https://evm.stupidtech.net",
      chainId: 8453,
      fromBlock: 16n,
      toBlock: 17n,
    });

    expect(sent).toHaveLength(1);
    const parsedBody = JSON.parse(sent[0].body as string) as Array<{ method: string }>;
    expect(parsedBody).toHaveLength(4);
    expect(parsedBody.map((x) => x.method)).toEqual([
      "eth_getBlockByNumber",
      "eth_getLogs",
      "eth_getBlockByNumber",
      "eth_getLogs",
    ]);

    expect(blocks).toHaveLength(2);
    expect(blocks[0].block.number).toBe(16n);
    expect(blocks[1].block.number).toBe(17n);
    expect(blocks[0].logs).toHaveLength(0);
    expect(blocks[1].logs).toHaveLength(1);
  });
});
