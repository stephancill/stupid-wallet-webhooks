import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { Hono } from "hono";
import { hexToBytes } from "viem";
import { createTestDatabase } from "./helpers/database";
import { ScannerShard } from "../src/scanner/ScannerShard";
import {
  submitScrSubscribe,
  submitScrUnsubscribe,
  submitWebhookDelete,
  newCommandId,
} from "../src/scanner/outbox";
import { getSubscriptionById, listEligibleSubscriptions } from "../src/db/repository";
import { deliverWebhooks } from "../src/queues/deliver";
import { webhooks } from "../src/api/webhooks";
import { subscriptions } from "../src/api/subscriptions";
import type { Env, DeliveryHook } from "../src/env";
import type { AuthContext } from "../src/api/middleware";
import { setInternalRpc } from "../src/rpc/client";

const address: `0x${string}` = `0x${"11".repeat(20)}`;
const hash = `0x${"aa".repeat(32)}`;
const undo: Array<() => void> = [];
afterEach(() => {
  for (const run of undo.splice(0)) run();
  setInternalRpc(null);
});

function setup({ cursor = 80 }: { cursor?: number | null } = {}) {
  const database = createTestDatabase();
  const { db, sqlite } = database;
  undo.push(() => sqlite.close());
  sqlite.exec(`INSERT INTO accounts (id,name,created_at,updated_at) VALUES ('a','test','now','now'),('b','other','now','now');
    INSERT INTO webhooks (id,account_id,url,created_at) VALUES ('wh','a','https://receiver.example','now'),('other','b','https://other.example','now');`);
  sqlite
    .query(
      "INSERT INTO chain_registry (chain_id,status,cursor_block,cursor_hash,created_at,updated_at) VALUES (1,'active',?,?,'now','now')",
    )
    .run(cursor, cursor === null ? null : hash);
  let head = 100;
  let unavailable = false;
  let beforeHead: (() => Promise<void>) | undefined;
  const calls: string[] = [];
  const storage = new Map<string, unknown>();
  const env = {
    DB: db,
    RPC_RACER_BASE_URL: "https://rpc.example",
    RPC_INTERNAL_SECRET: "test",
    WEBHOOK_SIGNING_MASTER: "test",
    RPC_RACER: {
      async fetch(input: string, init?: RequestInit) {
        if (input.includes("/chains/"))
          return Response.json({ chainId: 1, name: "test", blockSpeedMs: 12000 });
        const { id, method } = JSON.parse(String(init?.body));
        calls.push(method);
        if (method === "eth_blockNumber") {
          await beforeHead?.();
          return Response.json({
            jsonrpc: "2.0",
            id,
            result: unavailable ? null : `0x${head.toString(16)}`,
          });
        }
        if (method === "eth_getBlockByNumber")
          return Response.json({
            jsonrpc: "2.0",
            id,
            result: {
              number: `0x${head.toString(16)}`,
              hash,
              parentHash: hash,
              timestamp: "0x1",
              logsBloom: `0x${"00".repeat(256)}`,
              transactions: [],
            },
          });
        throw new Error(`Unexpected RPC: ${method}`);
      },
    },
    MATCHED_ACTIVITY_QUEUE: { async sendBatch() {} },
  } as unknown as Env;
  const scanner = new ScannerShard(
    {
      id: { name: "chain-1" },
      storage: {
        async get(key: string) {
          return storage.get(key);
        },
        async put(key: string, value: unknown) {
          storage.set(key, value);
        },
        async getAlarm() {
          return null;
        },
        async setAlarm() {},
      },
    } as unknown as DurableObjectState,
    env,
  );
  const dispatched: string[] = [];
  let dispatch = false;
  const namespace = {
    idFromName: (name: string) => name,
    get: () => ({
      async fetch(input: string, init?: RequestInit) {
        dispatched.push(JSON.parse(String(init?.body)).commandId);
        return dispatch ? scanner.fetch(new Request(input, init)) : new Response("ok");
      },
    }),
  } as unknown as DurableObjectNamespace;
  env.SCANNER_SHARD_1 = namespace;
  env.SCANNER_SHARD_2 = namespace;
  async function subscribe({ id = "sub", webhookId = "wh", accountId = "a" } = {}) {
    await submitScrSubscribe({
      db,
      env,
      accountId,
      webhookId,
      state: { subscriptionId: id, chainId: 1, address: hexToBytes(address) },
    });
    return newCommandId("subscribe", id);
  }
  async function apply({ commandId }: { commandId: string }) {
    await scanner.fetch(
      new Request("https://scanner.internal/apply", {
        method: "POST",
        body: JSON.stringify({ commandId }),
      }),
    );
  }
  const app = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();
  app.use("*", async (c, next) => {
    c.set("auth", {
      accountId: "a",
      apiKeyId: "key",
      activeSubscriptionQuota: 1000,
      chainQuota: 20,
    } as AuthContext);
    await next();
  });
  app.route("/webhooks", webhooks);
  app.route("/subscriptions", subscriptions);
  return {
    ...database,
    env,
    scanner,
    subscribe,
    apply,
    calls,
    dispatched,
    app,
    setHead(value: number) {
      head = value;
    },
    setUnavailable(value: boolean) {
      unavailable = value;
    },
    setBeforeHead(value: () => Promise<void>) {
      beforeHead = value;
    },
    enableDispatch() {
      dispatch = true;
    },
  };
}

describe("subscription activation boundaries", () => {
  it("serializes overlapping command redelivery and alarms across an RPC await", async () => {
    const s = setup({ cursor: 100 });
    const commandId = await s.subscribe();
    let started!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    s.setBeforeHead(async () => {
      started();
      await gate;
    });
    const first = s.apply({ commandId });
    await entered;
    const second = s.apply({ commandId });
    const alarm = s.scanner.alarm();
    await Promise.resolve();
    expect(s.calls).toEqual(["eth_blockNumber"]);
    release();
    await Promise.all([first, second, alarm]);
    expect(s.calls).toEqual(["eth_blockNumber", "eth_blockNumber"]);
    expect(
      (await getSubscriptionById({ db: s.db, subscriptionId: "sub" }))?.active_from_block,
    ).toBe(101);
  });

  it("activates at head + 1 during backlog and redelivery never moves the boundary", async () => {
    const s = setup();
    const commandId = await s.subscribe();
    expect((await getSubscriptionById({ db: s.db, subscriptionId: "sub" }))?.status).toBe(
      "pending",
    );
    await s.apply({ commandId });
    expect(
      (await getSubscriptionById({ db: s.db, subscriptionId: "sub" }))?.active_from_block,
    ).toBe(101);
    expect(await listEligibleSubscriptions(s.db, 1, address, 100)).toHaveLength(0);
    expect(await listEligibleSubscriptions(s.db, 1, address, 101)).toHaveLength(1);
    s.setHead(120);
    await s.apply({ commandId });
    expect(s.calls).toEqual(["eth_blockNumber"]);
    expect(
      (await getSubscriptionById({ db: s.db, subscriptionId: "sub" }))?.active_from_block,
    ).toBe(101);
    expect(s.sqlite.query("SELECT cursor_block FROM chain_registry").get()).toEqual({
      cursor_block: 80,
    });
  });

  it("anchors a first chain at the same head used for activation", async () => {
    const s = setup({ cursor: null });
    const commandId = await s.subscribe();
    await s.apply({ commandId });
    expect(s.sqlite.query("SELECT cursor_block,cursor_hash FROM chain_registry").get()).toEqual({
      cursor_block: 100,
      cursor_hash: hash,
    });
    expect(
      (await getSubscriptionById({ db: s.db, subscriptionId: "sub" }))?.active_from_block,
    ).toBe(101);
  });

  it("establishes boundaries when explicitly retrying unsupported subscriptions", async () => {
    const s = setup({ cursor: null });
    await s.subscribe();
    s.sqlite.exec(
      "UPDATE subscriptions SET status='unsupported'; UPDATE scanner_operations SET status='applied'; INSERT INTO scanner_operations (id,chain_id,kind,payload,status,created_at,updated_at) VALUES ('retry',1,'retry_chain','{}','pending','now','now')",
    );
    await s.apply({ commandId: "retry" });
    expect(s.sqlite.query("SELECT status,active_from_block FROM subscriptions").get()).toEqual({
      status: "active",
      active_from_block: 101,
    });
    expect(s.sqlite.query("SELECT cursor_block FROM chain_registry").get()).toEqual({
      cursor_block: 100,
    });
  });

  it("keeps RPC failures pending and retries with a real boundary", async () => {
    const s = setup();
    const commandId = await s.subscribe();
    s.setUnavailable(true);
    await s.apply({ commandId });
    expect(s.sqlite.query("SELECT status,active_from_block FROM subscriptions").get()).toEqual({
      status: "pending",
      active_from_block: null,
    });
    expect(s.sqlite.query("SELECT status,attempts FROM scanner_operations").get()).toEqual({
      status: "pending",
      attempts: 1,
    });
    s.setUnavailable(false);
    s.setHead(105);
    await s.apply({ commandId });
    expect(
      (await getSubscriptionById({ db: s.db, subscriptionId: "sub" }))?.active_from_block,
    ).toBe(106);
  });

  it("rolls back activation and acknowledgement together on a D1 failure", async () => {
    const s = setup();
    const commandId = await s.subscribe();
    s.failNextBatch();
    await expect(s.apply({ commandId })).rejects.toThrow("injected transaction failure");
    expect(s.sqlite.query("SELECT status,active_from_block FROM subscriptions").get()).toEqual({
      status: "pending",
      active_from_block: null,
    });
    expect(s.sqlite.query("SELECT status FROM scanner_operations").get()).toEqual({
      status: "pending",
    });
    await s.apply({ commandId });
    expect(
      (await getSubscriptionById({ db: s.db, subscriptionId: "sub" }))?.active_from_block,
    ).toBe(101);
  });

  it("does not resurrect a subscription deleted while the head read is in flight", async () => {
    const s = setup();
    const commandId = await s.subscribe();
    s.setBeforeHead(async () => {
      await submitScrUnsubscribe({
        db: s.db,
        env: s.env,
        state: { subscriptionId: "sub", chainId: 1, address: hexToBytes(address) },
      });
    });
    await s.apply({ commandId });
    expect((await getSubscriptionById({ db: s.db, subscriptionId: "sub" }))?.status).toBe(
      "deleting",
    );
  });
});

describe("webhook deletion", () => {
  it("atomically cascades beyond one page, preserves shared refs/history and is idempotent", async () => {
    const s = setup();
    // Distinct endpoints permit many subscriptions to the same tracked address.
    for (let i = 0; i < 60; i++) {
      s.sqlite
        .query(
          "INSERT INTO subscriptions (id,account_id,webhook_id,address,chain_id,status,active_from_block,created_at,updated_at) VALUES (?,'a','wh',?,?,'active',1,'now','now')",
        )
        .run(`s${i}`, hexToBytes(address), i + 1);
      s.sqlite
        .query(
          "INSERT INTO tracked_addresses (id,chain_id,address,ref_count,updated_at) VALUES (?,?,?,1,'now')",
        )
        .run(`t${i}`, i + 1, hexToBytes(address));
    }
    await s.subscribe({ id: "shared", webhookId: "other", accountId: "b" });
    s.sqlite.exec(
      "INSERT INTO webhook_deliveries (id,account_id,webhook_id,event_id,event_type,status,created_at,updated_at) VALUES ('d','a','wh','e','activity.observed','success','now','now')",
    );
    const request = () => s.app.request("/webhooks/wh", { method: "DELETE" }, s.env);
    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(200);
    expect(
      s.sqlite
        .query(
          "SELECT count(*) AS n FROM subscriptions WHERE webhook_id='wh' AND status='deleting'",
        )
        .get(),
    ).toEqual({ n: 60 });
    expect(s.sqlite.query("SELECT chain_id,ref_count FROM tracked_addresses").all()).toEqual([
      { chain_id: 1, ref_count: 1 },
    ]);
    expect(
      s.sqlite.query("SELECT count(*) AS n FROM scanner_operations WHERE kind='unsubscribe'").get(),
    ).toEqual({ n: 60 });
    expect(s.sqlite.query("SELECT status FROM webhook_deliveries").get()).toEqual({
      status: "success",
    });
    expect(s.sqlite.query("SELECT status FROM webhooks WHERE id='wh'").get()).toEqual({
      status: "inactive",
    });
    expect((await s.app.request("/webhooks/wh/test", { method: "POST" }, s.env)).status).toBe(409);
    expect(
      (
        await s.app.request(
          "/subscriptions",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ webhookId: "wh", address, chainIds: [1] }),
          },
          s.env,
        )
      ).status,
    ).toBe(409);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    undo.push(() => errors.mockRestore());
    await expect(s.subscribe({ id: "late" })).rejects.toThrow("active webhook");
    expect(s.sqlite.query("SELECT ref_count FROM tracked_addresses").get()).toEqual({
      ref_count: 1,
    });
  });

  it("rolls back the entire cascade on failure and repeated unsubscribe decrements once", async () => {
    const s = setup();
    await s.subscribe();
    await s.subscribe({ id: "shared", accountId: "b", webhookId: "other" });
    s.failNextBatch();
    await expect(
      submitWebhookDelete({ db: s.db, env: s.env, webhookId: "wh", accountId: "a" }),
    ).rejects.toThrow("injected transaction failure");
    expect(s.sqlite.query("SELECT status FROM webhooks WHERE id='wh'").get()).toEqual({
      status: "active",
    });
    expect(s.sqlite.query("SELECT ref_count FROM tracked_addresses").get()).toEqual({
      ref_count: 2,
    });
    const state = { subscriptionId: "sub", chainId: 1, address: hexToBytes(address) };
    expect(await submitScrUnsubscribe({ db: s.db, env: s.env, state })).toBe(true);
    expect(await submitScrUnsubscribe({ db: s.db, env: s.env, state })).toBe(true);
    expect(s.sqlite.query("SELECT ref_count FROM tracked_addresses").get()).toEqual({
      ref_count: 1,
    });
  });

  it("stops already-queued deliveries without issuing an HTTP request", async () => {
    const s = setup();
    await submitWebhookDelete({ db: s.db, env: s.env, webhookId: "wh", accountId: "a" });
    const work: DeliveryHook = {
      deliveryId: "d",
      accountId: "a",
      webhookId: "wh",
      observationId: "e",
      eventType: "activity.observed",
      chainId: 1,
      bodyJson: "{}",
    };
    const original = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      throw new Error("unexpected delivery");
    }) as unknown as typeof fetch;
    undo.push(() => {
      globalThis.fetch = original;
    });
    const batch = { messages: [{ body: work }] } as unknown as MessageBatch<DeliveryHook>;
    await deliverWebhooks(batch, s.env);
    await deliverWebhooks(batch, s.env);
    expect(requests).toBe(0);
    expect(
      s.sqlite.query("SELECT status,attempts,last_error FROM webhook_deliveries").get(),
    ).toEqual({ status: "failed", attempts: 0, last_error: "webhook inactive" });
  });
});

it("migrates missing boundaries and queues first activation where no checkpoint exists", () => {
  const { sqlite } = createTestDatabase({ migrate: false });
  undo.push(() => sqlite.close());
  sqlite.exec(`INSERT INTO accounts (id,name,created_at,updated_at) VALUES ('a','test','now','now');
    INSERT INTO webhooks (id,account_id,url,created_at) VALUES ('wh','a','https://receiver.example','now');
    INSERT INTO chain_registry (chain_id,status,cursor_block,created_at,updated_at) VALUES (1,'active',80,'now','now'),(2,'active',NULL,'now','now');
    INSERT INTO subscriptions (id,account_id,webhook_id,address,chain_id,status,created_at,updated_at) VALUES ('s1','a','wh',zeroblob(20),1,'active','now','now'),('s2','a','wh',zeroblob(20),2,'active','now','now');`);
  sqlite.exec(
    readFileSync(
      new URL("../migrations/0003_subscription_boundaries.sql", import.meta.url),
      "utf8",
    ),
  );
  expect(
    sqlite.query("SELECT id,status,active_from_block FROM subscriptions ORDER BY id").all(),
  ).toEqual([
    { id: "s1", status: "active", active_from_block: 81 },
    { id: "s2", status: "pending", active_from_block: null },
  ]);
  expect(sqlite.query("SELECT subscription_id,status FROM scanner_operations").get()).toEqual({
    subscription_id: "s2",
    status: "pending",
  });
});
