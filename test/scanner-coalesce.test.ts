import { afterEach, describe, expect, it } from "bun:test";
import { ScannerShard } from "../src/scanner/ScannerShard";

type D1Like = {
  calls: Array<{ sql: string; args: unknown[] }>;
  prepare(sql: string): {
    bind(...args: unknown[]): { run(): Promise<{ meta: { changes: number } }> };
  };
};

function fakeD1(): D1Like {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  return {
    calls,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() {
              calls.push({ sql, args });
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
}

/** Construct a real `ScannerShard` wired to an in-memory DO storage + fake D1. */
function makeShard(db: D1Like, intervalMs: string) {
  const storage = new Map<string, unknown>();
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
      async setAlarm() {},
    },
  };
  const env = { SCANNER_CURSOR_D1_MS: intervalMs, DB: db };
  const shard = new ScannerShard(state as never, env as never) as unknown as {
    pendingTip: { number: number; hash: string } | null;
    pendingHead: number | null;
    maybeFlushCursor(): Promise<void>;
  };
  const written = () => db.calls.filter((c) => /UPDATE chain_registry/.test(c.sql)).length;
  return { shard, written };
}

/**
 * Guards the scanner D1 cursor-write coalescing: `maybeFlushCursor` must persist
 * `chain_registry` at most once per `SCANNER_CURSOR_D1_MS`, always carrying the
 * latest tip, and must persist nothing when there is no pending tip/head.
 */
describe("scanner D1 cursor/head coalescing", () => {
  const realNow = Date.now;
  let nowMs = 1_000_000;
  afterEach(() => {
    globalThis.Date.now = realNow;
  });

  it("writes at most one D1 row per interval and carries the latest tip", async () => {
    globalThis.Date.now = () => nowMs;
    try {
      const db = fakeD1();
      const { shard, written } = makeShard(db, "1000");

      shard.pendingHead = 170;
      shard.pendingTip = { number: 100, hash: "0x64" };
      await shard.maybeFlushCursor();
      await shard.maybeFlushCursor(); // no-op: still within the interval
      expect(written()).toBe(1);

      // Many blocks in the same interval produce no extra writes.
      for (let b = 101; b <= 140; b++) {
        shard.pendingTip = { number: b, hash: `0x${b.toString(16)}` };
        await shard.maybeFlushCursor();
      }
      expect(written()).toBe(1);

      // Once the interval elapses, flush again with the latest tip only.
      nowMs += 1000;
      shard.pendingTip = { number: 141, hash: "0x8d" };
      await shard.maybeFlushCursor();
      expect(written()).toBe(2);
      expect(db.calls[1].args[0]).toBe(141);
    } finally {
      globalThis.Date.now = realNow;
    }
  });

  it("writes nothing when nothing is pending", async () => {
    globalThis.Date.now = () => nowMs;
    try {
      const db = fakeD1();
      const { shard, written } = makeShard(db, "1000");
      await shard.maybeFlushCursor();
      expect(written()).toBe(0);
    } finally {
      globalThis.Date.now = realNow;
    }
  });
});
