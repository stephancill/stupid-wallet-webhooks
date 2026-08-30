import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { Env } from "../env";
import { hashApiKey, stringsEqual } from "../domain/keys";
import { findApiKeyWithAccount } from "../db/repository";

export type AuthContext = {
  accountId: string;
  accountStatus: "active" | "suspended";
  apiKeyId: string;
  activeSubscriptionQuota: number;
  chainQuota: number;
};

/**
 * Authenticates a customer API request via `Authorization: Bearer <key>`.
 * Only a peppered hash is compared against the store. Suspended accounts are
 * rejected. Attaches the resolved auth context to the request.
 */
export const apiAuth = createMiddleware<{ Bindings: Env; Variables: { auth: AuthContext } }>(
  async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    if (token === "") {
      throw new HTTPException(401, { message: "Missing API key" });
    }

    const pepper = c.env.API_KEY_PEPPER;
    const keyHash = await hashApiKey({ key: token, pepper });
    const record = await findApiKeyWithAccount(c.env.DB, keyHash);
    if (record === null) {
      throw new HTTPException(401, { message: "Invalid API key" });
    }

    if (record.account.status === "suspended") {
      throw new HTTPException(403, { message: "Account is suspended" });
    }

    c.set("auth", {
      accountId: record.account.id,
      accountStatus: record.account.status,
      apiKeyId: record.apiKey.id,
      activeSubscriptionQuota: effectiveQuota(
        record.account.subscription_quota,
        c.env.SUBSCRIPTION_DEFAULT_QUOTA,
      ),
      chainQuota: effectiveQuota(record.account.chain_quota, c.env.CHAIN_DEFAULT_QUOTA),
    });
    await next();
  },
);

function effectiveQuota(override: number | null, defaultRaw: string): number {
  if (override !== null && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  const parsed = Number.parseInt(defaultRaw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1000;
}

/**
 * Guards operator-provisioning routes with a shared `Authorization: Bearer`
 * secret.
 */
export const operatorAuth = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (token === "" || c.env.OPERATOR_SECRET === "" || !stringsEqual(token, c.env.OPERATOR_SECRET)) {
    throw new HTTPException(401, { message: "Invalid operator credentials" });
  }
  await next();
});

export function authContext(c: { get: <T = unknown>(key: string) => T }): AuthContext {
  return c.get("auth");
}

export function jsonError(
  status: number,
  message: string,
  extra?: Record<string, unknown>,
): Response {
  return Response.json({ error: message, ...extra }, { status });
}
