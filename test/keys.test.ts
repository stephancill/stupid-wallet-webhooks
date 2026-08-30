import { describe, expect, it } from "bun:test";
import {
  generateApiKey,
  hashApiKey,
  deriveWebhookSecret,
  webhookSignature,
  stringsEqual,
} from "../src/domain/keys";
import { newId, commandId, sha256Hex } from "../src/domain/ids";

describe("api key hashing", () => {
  it("generates a raw key and a peppered hash, and never stores the raw key", async () => {
    const { key, prefix } = generateApiKey();
    expect(key.startsWith("an_")).toBe(true);
    expect(prefix).toBe(key.slice(0, 12));

    const hash = await hashApiKey({ key, pepper: "PEPPER" });
    expect(hash).not.toBe(key);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // Same key + same pepper => same hash.
    expect(await hashApiKey({ key, pepper: "PEPPER" })).toBe(hash);
    // Different pepper => different hash.
    expect(await hashApiKey({ key, pepper: "OTHER" })).not.toBe(hash);
  });
});

describe("webhook signing", () => {
  it("derives a stable per-webhook secret", async () => {
    const secret = await deriveWebhookSecret({ masterSecret: "master", webhookId: "wh_1" });
    expect(await deriveWebhookSecret({ masterSecret: "master", webhookId: "wh_1" })).toBe(secret);
    expect(await deriveWebhookSecret({ masterSecret: "master", webhookId: "wh_2" })).not.toBe(
      secret,
    );
  });

  it("produces a versioned v1,hex signature over timestamp+body", async () => {
    const signature = await webhookSignature({
      secret: "s",
      body: '{"a":1}',
      timestamp: 1788080000,
    });
    expect(signature.startsWith("v1,")).toBe(true);
    expect(signature.length).toBe(67);
    const again = await webhookSignature({ secret: "s", body: '{"a":1}', timestamp: 1788080000 });
    expect(again).toBe(signature);
  });
});

describe("constant-time compare", () => {
  it("matches equal strings and rejects unequal ones", () => {
    expect(stringsEqual("abc", "abc")).toBe(true);
    expect(stringsEqual("abc", "abd")).toBe(false);
    expect(stringsEqual("abc", "abcd")).toBe(false);
  });
});

describe("ids", () => {
  it("prepends the semantical prefix and is unique", () => {
    const a = newId("wh");
    const b = newId("wh");
    expect(a.startsWith("wh_")).toBe(true);
    expect(a).not.toBe(b);
  });

  it("produces deterministic command ids and unique hashes", async () => {
    const a = await commandId("subscribe:sub_1");
    const b = await commandId("subscribe:sub_1");
    const c = await commandId("unsubscribe:sub_1");
    expect(a).toBe(b);
    expect(a.startsWith("cmd_")).toBe(true);
    expect(a).not.toBe(c);
    expect(await sha256Hex("x")).toMatch(/^[0-9a-f]{64}$/);
  });
});
