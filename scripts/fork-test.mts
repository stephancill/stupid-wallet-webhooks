#!/usr/bin/env bun
/**
 * Integration test against a real chain fork using Anvil.
 *
 * Spawns `anvil` forking one of the target chains with a block time, scans new
 * blocks with the production scanner client + matcher, sends a funded dev-account
 * transaction that a tracked address authors, and asserts the observation.
 *
 * Env:
 *   FORK_RPC_URL  - upstream to fork (default: evm.stupidtech.net Base)
 *   ANVIL_PORT    - anvil RPC port (default 1337)
 * Run:  bun run fork-test
 */
import { spawn } from "node:child_process";
import {
  jsonRpc,
  ethBlockNumber,
  ethGetBlockByNumber,
  ethGetLogs,
  ethGetTransactionReceipt,
} from "../src/rpc/client";
import {
  analyzeBlock,
  finalizeBundles,
  type NormalizedBlock,
  type Receipt,
} from "../src/domain/activity";

const ANVIL = process.env.ANVIL_BIN ?? "anvil";
const PORT = Number(process.env.ANVIL_PORT ?? 1337);
const RPC = `http://127.0.0.1:${PORT}`;
const ALCHEMY = process.env.ALCHEMY_API_KEY;
const TARGET =
  process.env.FORK_RPC_URL ??
  (ALCHEMY
    ? `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY}`
    : "https://evm.stupidtech.net/v1/8453");
const BLOCK_TIME = Number(process.env.ANVIL_BLOCK_TIME ?? 0);
const CHAIN_ID = Number(process.env.ANVIL_CHAIN_ID ?? 8453);

// Anvil's default test accounts are unlocked and funded.
const ACCOUNT0 = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"; // tracked author
const ACCOUNT1 = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8"; // tracked recipient
const TRACKED = new Set([ACCOUNT0, ACCOUNT1]);

const BASE = "http://unused.local"; // ignored when RPC_DIRECT_URL is set
process.env.RPC_DIRECT_URL = RPC;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function startAnvil(): Promise<{ stop: () => void }> {
  const args = [
    "--fork-url",
    TARGET,
    "--chain-id",
    String(CHAIN_ID),
    "--port",
    String(PORT),
    "--silent",
  ];
  if (BLOCK_TIME > 0) args.push("--block-time", String(BLOCK_TIME));
  const proc = spawn(ANVIL, args, { stdio: "ignore" });
  const stop = () => {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* noop */
    }
  };
  await waitForRpc();
  return { stop };
}

async function waitForRpc(): Promise<void> {
  for (let i = 0; i < 150; i += 1) {
    try {
      await ethBlockNumber({ baseUrl: BASE, chainId: CHAIN_ID });
      return;
    } catch {
      await delay(500);
    }
  }
  throw new Error("anvil did not start");
}

type ObsEvent = {
  observationId: string;
  txHash: string;
  value: string;
  status: string;
};

async function scanNewBlocks(anchor: bigint): Promise<ObsEvent[]> {
  const observed: ObsEvent[] = [];
  const head = await ethBlockNumber({ baseUrl: BASE, chainId: CHAIN_ID });
  for (let b = anchor + 1n; b <= head; b += 1n) {
    const block: NormalizedBlock = await ethGetBlockByNumber({
      baseUrl: BASE,
      chainId: CHAIN_ID,
      blockNumber: b,
    });
    const logs = await ethGetLogs({ baseUrl: BASE, chainId: CHAIN_ID, blockHash: block.hash });
    const analyzed = analyzeBlock({ block, logs, tracked: TRACKED });
    const receipts = new Map<string, Receipt>();
    for (const txHash of analyzed.receiptHashes) {
      const r = await ethGetTransactionReceipt({
        baseUrl: BASE,
        chainId: CHAIN_ID,
        txHash: txHash as `0x${string}`,
      });
      if (r !== null) receipts.set(txHash, r);
    }
    const observations = await finalizeBundles({
      chainId: CHAIN_ID,
      block,
      drafts: analyzed.drafts,
      receipts,
    });
    for (const o of observations) {
      observed.push({
        observationId: o.observationId,
        txHash: o.transaction.hash,
        value: o.transaction.value,
        status: o.transaction.status,
      });
    }
  }
  return observed;
}

function sendTransfer(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "cast",
      [
        "send",
        "--json",
        "--rpc-url",
        RPC,
        "--from",
        ACCOUNT0,
        "--unlocked",
        "--value",
        "1ether",
        ACCOUNT1,
      ],
      { stdio: "pipe", env: process.env },
    );
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error("cast send failed: " + out));
      const json = out.slice(out.indexOf("{"));
      try {
        const parsed = JSON.parse(json);
        if (typeof parsed.transactionHash === "string") return resolve(parsed.transactionHash);
      } catch {
        /* fall through */
      }
      const match = /transactionHash\s+0x[0-9a-fA-F]{64}/u.exec(out);
      if (match) {
        const hex = match[0].split("0x")[1];
        return resolve(`0x${hex}`);
      }
      reject(new Error("no transactionHash in cast output: " + out));
    });
  });
}

async function main(): Promise<void> {
  const { stop } = await startAnvil();
  try {
    const head0 = await ethBlockNumber({ baseUrl: BASE, chainId: CHAIN_ID });
    console.log(`anvil up; fork head #${head0}`);

    const txHash = await sendTransfer();
    console.log(`sent transfer ${txHash.slice(0, 18)}… from tracked ${ACCOUNT0.slice(0, 10)}`);
    // Force a block so the pending transfer is mined deterministically.
    await jsonRpc({ baseUrl: BASE, chainId: CHAIN_ID, method: "anvil_mine", params: ["0x1"] });

    // Re-scan from the anchor each cycle (Anvil mines a timed block each interval
    // and the tx can land in head0+1 or a later one).
    let matched: ObsEvent | null = null;
    for (let i = 0; i < 40 && !matched; i += 1) {
      await delay(1500);
      const observed = await scanNewBlocks(head0);
      for (const o of observed) {
        if (o.txHash.toLowerCase() === txHash.toLowerCase()) {
          matched = o;
          break;
        }
      }
    }

    if (matched === null) {
      console.error("FAIL: never observed the sent transaction on the fork");
      process.exit(1);
    }
    console.log("\nMATCHED observation:", matched.observationId);
    console.log("  tx:", matched.txHash);
    console.log("  value:", matched.value, "| status:", matched.status);
    console.log("\nPASS: anvil fork scanned a real transaction into a matched observation");
  } finally {
    stop();
  }
}

await main();
