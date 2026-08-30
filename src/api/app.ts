import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Env } from "../env";
import { apiAuth } from "./middleware";
import { webhooks } from "./webhooks";
import { subscriptions } from "./subscriptions";
import { chains } from "./chains";
import { deliveries } from "./deliveries";
import { operator } from "./operator";
import { siteHtml } from "../web/site";

export const v1 = new Hono<{ Bindings: Env }>();
v1.use("*", apiAuth);
v1.route("/webhooks", webhooks);
v1.route("/subscriptions", subscriptions);
v1.route("/chains", chains);
v1.route("/webhook-deliveries", deliveries);

export function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/operator", operator);
  app.route("/v1", v1);

  // Landing page + favicon at the custom-domain root (API stays under /v1 & /operator).
  app.get("/favicon.png", (c) => serveAsset(c, "/favicon.png"));
  app.get("/apple-touch-icon.png", (c) => serveAsset(c, "/apple-touch-icon.png"));
  app.get("/", (c) => c.html(siteHtml));

  app.notFound((_c) => makeError("Not found", 404));
  app.onError((error, _c) => {
    if (error instanceof HTTPException) {
      return Response.json({ error: error.message || "Request failed" }, { status: error.status });
    }
    console.error("unhandled error", error);
    return makeError("Internal error", 500);
  });
  return app;
}

export function makeError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

/** Serves a static asset from the `public/` ASSETS binding when present. */
async function serveAsset(
  c: { env: Env; req: { raw: Request } },
  path: string,
): Promise<Response> {
  const { ASSETS } = c.env;
  if (ASSETS === undefined) {
    return makeError("Not found", 404);
  }
  const url = new URL(path, c.req.raw.url);
  const res = await ASSETS.fetch(new Request(url.toString(), c.req.raw));
  return res.status === 404 ? makeError("Not found", 404) : res;
}
