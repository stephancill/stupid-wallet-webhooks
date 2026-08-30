#!/usr/bin/env bun
/**
 * Local webhook receiver used with a cloudflared quick tunnel so the live
 * address-notifications worker can deliver signed webhooks to a local listener.
 *
 * Every received request is appended (as JSON) to the path in CAPTURE_FILE
 * (default /tmp/opencode/webhook-captures.jsonl) and reflected to stdout so the
 * signed payload + headers can be verified after delivery.
 */

import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";

const PORT = Number(process.env.WEBHOOK_PORT ?? 8799);
const captureFile = process.env.CAPTURE_FILE ?? "/tmp/webhook-captures.jsonl";

mkdirSync(dirname(captureFile), { recursive: true });

function timestamp(): string {
  return new Date().toISOString();
}

void Bun.serve({
  port: PORT,
  async fetch(request: Request) {
    const url = new URL(request.url);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const rawBody = await request.text();

    const record = {
      receivedAt: timestamp(),
      method: request.method,
      path: url.pathname,
      headers,
      body: rawBody,
    };

    try {
      appendFileSync(captureFile, JSON.stringify(record) + "\n");
      console.error(`[${timestamp()}] ${request.method} ${url.pathname}`);
      console.error(`  webhook-id:        ${headers["webhook-id"] ?? ""}`);
      console.error(`  webhook-timestamp: ${headers["webhook-timestamp"] ?? ""}`);
      console.error(`  webhook-signature: ${headers["webhook-signature"] ?? ""}`);
      console.error(`  body: ${rawBody}`);
    } catch (error) {
      console.error("failed to record webhook:", error);
    }

    return new Response(JSON.stringify({ ok: true, received: timestamp() }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
});

console.error(`webhook receiver listening on :${PORT}, capturing to ${captureFile}`);