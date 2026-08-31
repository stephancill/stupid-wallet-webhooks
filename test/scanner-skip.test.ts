import { afterEach, describe, expect, it } from "bun:test";
import { ScannerShard } from "../src/scanner/ScannerShard";

function fakeD1() {
  const calls: string[] = [];
  return {
    calls,
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            async run() {
              calls.push(sql);
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
}

async function makeShard(envOverrides: Record<string, string>) {
  const storage = new Map<string, unknown>();
  const alarms: number[] = [];
  const db = fakeD1();
  const state = {
    id: { name: "chain-137" },
    storage: {
      async get(k: string) {
        return storage.get(k);
      },
      async put(k: string, v: unknown) {
        storage.set(k, v);
      },
      async getAlarm() {
        return undefined;
      },
      async setAlarm(at: number) {
        alarms.push(at);
      },
    },
  };
  const env = {
    RPC_RACER_BASE_URL: "https://rpc",
    RPC_INTERNAL_SECRET: "",
    ...envOverrides,
    DB: db,
  };
  const shard = new ScannerShard(state as never, env as never) as unknown as {
    blockFailures: { block: bigint; count: number } | null;
    registerBlockFailure(chainId: number, blockNumber: bigint): Promise<boolean>;
  };
  return { shard, db, alarms };
}

function mockRpcFetch(): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: { body?: string }) => {
    const req = JSON.parse(String(init?.body ?? "{}"));
    const method = Array.isArray(req) ? req[0]?.method : req.method;
    if (method === "eth_blockNumber") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "0x10" }));
    }
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          number: "0x10",
          hash: "0x" + "ab".repeat(32),
          parentHash: "0x" + "00".repeat(32),
          timestamp: "0x0",
          transactions: [],
        },
      }),
    );
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

describe("scanner skip-persistently-failing-block guard", () => {
  afterEach(() => ({ restore: undefined }));

  it("only triggers recovery after the configured number of consecutive failures", async () => {
    const restore = mockRpcFetch();
    try {
      const { shard, db, alarms } = await makeShard({ SCANNER_SKIP_BLOCK_FAILURES: "3" });
      const blockNumber = 123n;
      expect(await shard.registerBlockFailure(137, blockNumber)).toBe(false);
      expect(await shard.registerBlockFailure(137, blockNumber)).toBe(false);
      expect(await shard.registerBlockFailure(137, blockNumber)).toBe(true); // recovery
      expect(shard.blockFailures).toBeNull();
      expect(db.calls.some((s) => /cursor_block/.test(s))).toBe(true);
      expect(alarms).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("a non-repeating failure resets the counter", async () => {
    const restore = mockRpcFetch();
    try {
      const { shard } = await makeShard({ SCANNER_SKIP_BLOCK_FAILURES: "3" });
      await shard.registerBlockFailure(137, 21n);
      await shard.registerBlockFailure(137, 22n);
      expect(shard.blockFailures?.block).toBe(22n);
      expect(shard.blockFailures?.count).toBe(1);
    } finally {
      restore();
    }
  });

  it("can restore a missing alarm without running a scan inline", async () => {
    const { shard, alarms } = await makeShard({});
    const response = await (shard as unknown as ScannerShard).fetch(
      new Request("https://scanner.internal/wake", { method: "POST" }),
    );
    expect(response.status).toBe(200);
    expect(alarms).toHaveLength(1);
  });
});
