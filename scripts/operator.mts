#!/usr/bin/env bun
/**
 * Operator CLI for account / API-key provisioning. Calls the worker operator
 * endpoints guarded by the OPERATOR_SECRET header.
 *
 * Usage:
 *   OPERATOR_BASE_URL=http://localhost:8787 OPERATOR_SECRET=... bun scripts/operator.mts add-account Acme
 *   bun scripts/operator.mts create-api-key <accountId>
 *   bun scripts/operator.mts revoke <accountId> <keyId>
 *   bun scripts/operator.mts suspend <accountId>
 *   bun scripts/operator.mts reactivate <accountId>
 *   bun scripts/operator.mts ops                # list pending scanner operations
 *   bun scripts/operator.mts reconcile
 */

const baseUrl = process.env.OPERATOR_BASE_URL ?? "http://localhost:8787";
const secret = process.env.OPERATOR_SECRET ?? "";

if (secret === "") {
  console.error("OPERATOR_SECRET is not set");
  process.exit(1);
}

async function request(path: string, options: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
      ...options.headers,
    },
  });
  const body = await response.text();
  console.log(`${response.status} ${path}\n${body}`);
  if (!response.ok) {
    process.exitCode = 1;
  }
  return body;
}

const [, , command, ...args] = process.argv;

switch (command) {
  case "add": {
    const [name, quotaArg, chainQuotaArg] = args;
    if (name === undefined) {
      console.error("usage: operator add <name> [subscriptionQuota] [chainQuota]");
      process.exit(1);
    }
    await request("/operator/accounts", {
      method: "POST",
      body: JSON.stringify({
        name,
        ...(quotaArg !== undefined ? { subscriptionQuota: Number(quotaArg) } : {}),
        ...(chainQuotaArg !== undefined ? { chainQuota: Number(chainQuotaArg) } : {}),
      }),
    });
    break;
  }
  case "create-api-key": {
    const [accountId] = args;
    if (accountId === undefined) {
      console.error("usage: create-api-key <accountId>");
      process.exit(1);
    }
    await request(`/operator/accounts/${accountId}/api-keys`, { method: "POST" });
    break;
  }
  case "revoke": {
    const [accountId, keyId] = args;
    if (accountId === undefined || keyId === undefined) {
      console.error("usage: revoke <accountId> <keyId>");
      process.exit(1);
    }
    await request(`/operator/accounts/${accountId}/api-keys/${keyId}`, { method: "DELETE" });
    break;
  }
  case "suspend": {
    const [accountId] = args;
    if (accountId === undefined) {
      console.error("usage: suspend <accountId>");
      process.exit(1);
    }
    await request(`/operator/accounts/${accountId}/suspended`, { method: "POST" });
    break;
  }
  case "reactivate": {
    const [accountId] = args;
    if (accountId === undefined) {
      console.error("usage: reactivate <accountId>");
      process.exit(1);
    }
    await request(`/operator/accounts/${accountId}/reactivate`, { method: "POST" });
    break;
  }
  case "ops":
    await request("/operator/scanner-operations");
    break;
  case "reconcile":
    await request("/operator/reconcile");
    break;
  default:
    console.error("unknown command:", command);
    process.exit(1);
}
