import { afterEach, describe, expect, it } from "bun:test";
import { fetchBlockAndLogs, setInternalRpc } from "../src/rpc/client";
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

    expect(block.number).toBe(16n);
    expect(logs).toHaveLength(1);
  });
});
