import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { hexToBytes, type Hex } from "viem";
import { ScannerShard } from "../src/scanner/ScannerShard";
import { setInternalRpc } from "../src/rpc/client";
import type { HeldBlock } from "../src/domain/reorg";
import fixture from "./fixtures/arbitrum-bloom.json";

const height = Number(BigInt(fixture.block.number));
const tracked = `0x${fixture.logs[0].topics[1].slice(-40)}` as Hex;
const txHash = fixture.logs[0].transactionHash;
const zeroBloom = `0x${"00".repeat(256)}`;
const block = {
  ...fixture.block,
  transactions: [
    {
      hash: txHash,
      transactionIndex: "0x1",
      from: tracked,
      to: `0x${fixture.logs[0].topics[2].slice(-40)}`,
      nonce: "0x1",
      value: "0x0",
    },
  ],
};
const receipt = {
  transactionHash: txHash,
  blockHash: block.hash,
  status: "0x1",
  contractAddress: null,
};
const realFetch = globalThis.fetch;
const restore: Array<() => void> = [];

afterEach(() => {
  globalThis.fetch = realFetch;
  setInternalRpc(null);
  for (const undo of restore.splice(0)) undo();
});

function makeScanner({
  respond,
}: {
  respond: (method: string) => { result: unknown } | { error: { code: number; message: string } };
}) {
  const anchor: HeldBlock = {
    number: height - 1,
    hash: block.parentHash,
    parentHash: `0x${"00".repeat(32)}`,
  };
  const storage = new Map<string, unknown>([["blockWindow", [anchor]]]);
  const writes: Array<{ sql: string; args: unknown[] }> = [];
  const enqueued: unknown[] = [];
  const alarms: number[] = [];
  const requests: string[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async all() {
              if (!sql.includes("FROM tracked_addresses"))
                throw new Error(`Unexpected query: ${sql}`);
              return { results: [{ address: hexToBytes(tracked) }] };
            },
            async first() {
              if (!sql.includes("FROM chain_registry")) throw new Error(`Unexpected query: ${sql}`);
              return {
                chain_id: 42161,
                status: "active",
                cursor_block: height - 1,
                cursor_hash: block.parentHash,
                block_speed_ms: 250,
              };
            },
            async run() {
              writes.push({ sql, args });
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
  const state = {
    id: { name: "chain-42161" },
    storage: {
      async get(key: string) {
        return storage.get(key);
      },
      async put(key: string, value: unknown) {
        storage.set(key, value);
      },
      async getAlarm() {
        return undefined;
      },
      async setAlarm(at: number) {
        alarms.push(at);
      },
    },
  };
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const raw = JSON.parse(String(init?.body));
    const handle = ({ id, method }: { id: number; method: string }) => {
      requests.push(method);
      return {
        jsonrpc: "2.0",
        id,
        ...(method === "eth_blockNumber" ? { result: block.number } : respond(method)),
      };
    };
    return new Response(JSON.stringify(Array.isArray(raw) ? raw.map(handle) : handle(raw)));
  }) as typeof fetch;
  const errors = spyOn(console, "error").mockImplementation(() => {});
  restore.push(() => errors.mockRestore());
  const scanner = new ScannerShard(
    state as never,
    {
      DB: db,
      RPC_RACER_BASE_URL: "https://rpc",
      // Even one failure used to permit the poisoned-block guard to skip ahead.
      SCANNER_SKIP_BLOCK_FAILURES: "1",
      MATCHED_ACTIVITY_QUEUE: {
        async sendBatch(messages: unknown[]) {
          enqueued.push(...messages);
        },
      },
    } as never,
  );
  return { scanner, anchor, storage, writes, enqueued, alarms, requests, errors };
}

describe("scanner RPC failure boundaries", () => {
  it("holds its cursor across log errors, then resumes and emits the activity once", async () => {
    let failing = true;
    const state = makeScanner({
      respond: (method) => {
        if (method === "eth_getBlockByNumber") return { result: block };
        if (method === "eth_getLogs")
          return failing
            ? { error: { code: -32000, message: "opaque upstream error" } }
            : { result: [fixture.logs[0]] };
        if (method === "eth_getTransactionReceipt") return { result: receipt };
        throw new Error(`Unexpected method: ${method}`);
      },
    });
    await state.scanner.alarm();
    await state.scanner.alarm();
    expect(state.storage.get("blockWindow")).toEqual([state.anchor]);
    expect(state.writes).toHaveLength(0);
    expect(state.enqueued).toHaveLength(0);
    expect(state.alarms).toHaveLength(2);
    expect(state.errors).toHaveBeenCalledTimes(2);

    failing = false;
    await state.scanner.alarm();
    expect((state.storage.get("blockWindow") as HeldBlock[]).at(-1)?.number).toBe(height);
    expect(state.enqueued).toHaveLength(1);
    const callsBefore = state.requests.length;
    await state.scanner.alarm();
    expect(state.requests.slice(callsBefore)).toEqual(["eth_blockNumber"]);
    expect(state.enqueued).toHaveLength(1);
  });

  for (const kind of [
    "missing bloom",
    "invalid logs",
    "mismatched logs",
    "mismatched receipt",
  ] as const) {
    it(`never skips past ${kind}, even after the old failure threshold`, async () => {
      const state = makeScanner({
        respond: (method) => {
          if (method === "eth_getBlockByNumber")
            return {
              result: {
                ...block,
                logsBloom:
                  kind === "missing bloom"
                    ? undefined
                    : kind === "mismatched receipt"
                      ? zeroBloom
                      : block.logsBloom,
              },
            };
          if (method === "eth_getLogs")
            return {
              result:
                kind === "invalid logs"
                  ? null
                  : [{ ...fixture.logs[0], blockHash: block.parentHash }],
            };
          if (method === "eth_getTransactionReceipt")
            return { result: { ...receipt, blockHash: block.parentHash } };
          throw new Error(`Unexpected method: ${method}`);
        },
      });
      await state.scanner.alarm();
      await state.scanner.alarm();
      expect(state.storage.get("blockWindow")).toEqual([state.anchor]);
      expect(state.writes).toHaveLength(0);
      expect(state.enqueued).toHaveLength(0);
      expect(state.alarms).toHaveLength(2);
      expect(state.errors).toHaveBeenCalledTimes(2);
    });
  }
});
