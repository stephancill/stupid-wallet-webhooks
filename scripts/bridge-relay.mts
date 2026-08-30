#!/usr/bin/env bun
/**
 * Relay.link bridge helper for the pilot.
 *
 * Bridges native ETH from Base (8453) to a destination chain so the funded
 * test wallet can pay gas there. Reads the quote from relay's /quote/v2 and
 * submits the deposit transaction on Base via viem.
 *
 * Usage:
 *   RELAY_WALLET_KEY=<privkey> DEST_CHAIN_ID=<10|42161> AMOUNT_WEI=<wei> \
 *     bun scripts/bridge-relay.mts
 */

import { readFileSync } from "node:fs";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const ZERO = "0x0000000000000000000000000000000000000000";

const walletKeyPath = process.env.RELAY_WALLET_KEY ?? "";
const pk = (
  walletKeyPath ? readFileSync(walletKeyPath, "utf8") : (process.env.RELAY_WALLET_PK ?? "")
).trim();
if (!pk) {
  console.error("set RELAY_WALLET_KEY (path to a file containing the key)");
  process.exit(1);
}

const originChainId = 8453;
const destinationChainId = Number(process.env.DESTINATION_CHAIN_ID ?? "0");
const amount = process.env.AMOUNT_WEI ?? "80000000000000";

const account = privateKeyToAccount(pk as `0x${string}`);
const user = account.address;

console.error(`quoting Base->chain ${destinationChainId} amount ${amount} wei for ${user}`);
const quoteRes = await fetch("https://api.relay.link/quote/v2", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    user,
    originChainId,
    destinationChainId,
    originCurrency: ZERO,
    destinationCurrency: ZERO,
    amount,
    tradeType: "EXACT_INPUT",
  }),
});
const quote = (await quoteRes.json()) as any;
const step = quote.steps?.[0];
const item = step?.items?.[0];
const tx: Record<string, string> = item?.data ?? {};
if (!tx.to || !tx.data) {
  console.error("no deposit transaction in quote:", JSON.stringify(quote).slice(0, 800));
  process.exit(1);
}
console.log("deposit tx:", {
  to: tx.to,
  chainId: tx.chainId,
  value: tx.value,
  requestId: step.requestId,
});

const client = createWalletClient({
  account,
  chain: base,
  transport: http("https://evm.stupidtech.net/v1/8453"),
});
const hash = await client.sendTransaction({
  account,
  to: tx.to as `0x${string}`,
  data: tx.data as `0x${string}`,
  value: BigInt(tx.value ?? "0"),
  gas: BigInt(300000),
});
console.log(`bridge deposit submitted: ${hash}`);
console.log(`requestId: ${step.requestId}`);
