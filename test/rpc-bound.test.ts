import { describe, expect, it, afterEach } from "bun:test";
import { ENDPOINT, jsonRpc, setInternalRpc } from "../src/rpc/client";

afterEach(() => setInternalRpc(null));

/**
 * Bound-Worker test: proves the scanner's JSON-RPC client is pinned to
 * rpc-racer's private `/internal/v1/:chainId` route (carrying the shared secret)
 * whenever the internal config is active, so it never spends the public
 * per-IP rate-limit budget.
 */
describe("RPC endpoint selection (bound-Worker internal route)", () => {
  it("builds the private internal route when internal config is set", () => {
    setInternalRpc({ secret: "s", fanout: 5 });
    expect(ENDPOINT({ baseUrl: "https://evm.stupidtech.net/", chainId: 8453 })).toBe(
      "https://evm.stupidtech.net/internal/v1/8453?fanoutCount=5",
    );
  });

  it("uses a rpc-racer.internal service-bound URL when a fetcher is configured", () => {
    setInternalRpc({ secret: "s", fanout: 3, fetcher: {} as Fetcher });
    expect(ENDPOINT({ baseUrl: "https://evm.stupidtech.net/", chainId: 10 })).toBe(
      "https://rpc-racer.internal/internal/v1/10?fanoutCount=3",
    );
  });

  it("routes JSON-RPC through the service-binding fetcher when provided", async () => {
    const calls: Array<{ url: string; headers: Headers; body: string }> = [];
    const fetcher = {
      fetch: async (input: string, init?: RequestInit) => {
        calls.push({
          url: String(input),
          headers: new Headers(init?.headers),
          body: String(init?.body),
        });
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x5" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    } as unknown as Fetcher;
    const origFetch = globalThis.fetch;
    let globalFetchCalled = 0;
    globalThis.fetch = (async () => {
      globalFetchCalled += 1;
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch;
    setInternalRpc({ secret: "s3cr3t", fanout: 3, fetcher });
    try {
      const head = await jsonRpc({
        baseUrl: "https://evm.stupidtech.net",
        chainId: 8453,
        method: "eth_blockNumber",
        params: [],
      });
      expect(head).toBe("0x5");
      expect(globalFetchCalled).toBe(0);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toMatch(/^https:\/\/rpc-racer\.internal\/internal\/v1\/8453/);
      expect(calls[0].headers.get("x-internal-secret")).toBe("s3cr3t");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("falls back to the public /v1/ route when no internal config is active", () => {
    setInternalRpc(null);
    expect(ENDPOINT({ baseUrl: "https://evm.stupidtech.net", chainId: 10 })).toBe(
      "https://evm.stupidtech.net/v1/10",
    );
  });

  it("never calls a public /v1/ endpoint while internal config is active", async () => {
    setInternalRpc({ secret: "s3cr3t", fanout: 3 });

    const calls: Array<{ url: string; headers: Headers; body: string }> = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: String(init?.body),
      });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x10" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const head = await jsonRpc({
        baseUrl: "https://evm.stupidtech.net",
        chainId: 8453,
        method: "eth_blockNumber",
        params: [],
      });
      expect(head).toBe("0x10");
      expect(calls).toHaveLength(1);
      const call = calls[0];
      expect(call.url).toContain("/internal/v1/8453");
      expect(call.url).toMatch(/^https:\/\/evm\.stupidtech\.net\/internal\//);
      expect(call.url).not.toBe("https://evm.stupidtech.net/v1/8453");
      expect(call.headers.get("x-internal-secret")).toBe("s3cr3t");
      expect(JSON.parse(call.body).method).toBe("eth_blockNumber");
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("uses the public route (the default) only when internal config is absent", async () => {
    setInternalRpc(null);
    const calls: Array<string> = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      await jsonRpc({
        baseUrl: "https://evm.stupidtech.net",
        chainId: 10,
        method: "eth_blockNumber",
        params: [],
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain("/v1/10");
    } finally {
      globalThis.fetch = orig;
    }
  });
});
