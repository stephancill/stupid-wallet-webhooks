#!/usr/bin/env bun
/**
 * Read-only bloom-impact measurement.
 *
 * For each chain with tracked addresses, samples recent block headers, evaluates
 * the production tracked set against each block's `logsBloom` using the shipped
 * `createTransferBloomFilter`/`mayContainTrackedTransfer`, and verifies a bounded
 * probe set with exact-hash `eth_getLogs`:
 *
 *   - positive probes: confirm a positive is a genuine possible match
 *   - negative probes: any match here would be a bloom false negative (a bug)
 *
 * Then reports avoided log queries and a counterfactual compute estimate using
 * Alchemy item pricing (20 CU per block read, 60 CU per log read).
 *
 * Usage:
 *   bun scripts/bloom-impact.mts [--sample 400] [--positives 50] [--negatives 40]
 *
 * Requires the local Wrangler session for the D1 read of tracked addresses.
 * Never writes to production.
 */

import { z } from "zod";
import { createTransferBloomFilter, mayContainTrackedTransfer } from "../src/domain/bloom";
import type { Hex } from "viem";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const BLOCK_CU = 20;
const LOG_CU = 60;

/** Nominal block intervals, used only to weight per-chain sample results. */
const CHAINS = {
  1: { url: "https://ethereum-rpc.publicnode.com", blockSpeedMs: 12_000 },
  10: { url: "https://optimism-rpc.publicnode.com", blockSpeedMs: 2_000 },
  100: { url: "https://gnosis-rpc.publicnode.com", blockSpeedMs: 5_000 },
  137: { url: "https://polygon-bor-rpc.publicnode.com", blockSpeedMs: 1_500 },
  8453: { url: "https://base-rpc.publicnode.com", blockSpeedMs: 2_000 },
  42161: { url: "https://arb1.arbitrum.io/rpc", blockSpeedMs: 250 },
} as const;

const headerSchema = z.array(
  z.object({
    id: z.number(),
    result: z.object({
      hash: z.string(),
      number: z.string(),
      logsBloom: z.string().regex(/^0x[0-9a-fA-F]{512}$/),
    }),
  }),
);
const logSchema = z.array(z.object({ blockHash: z.string(), topics: z.array(z.string()) }));
const trackedSchema = z.array(
  z.object({
    results: z.array(
      z.object({ chain_id: z.number(), address: z.string().regex(/^[0-9a-f]{40}$/) }),
    ),
  }),
);

function arg({ name, fallback }: { name: string; fallback: number }): number {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : Number(process.argv[index + 1]);
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

async function rpc({ url, body, attempts = 6 }: { url: string; body: unknown; attempts?: number }) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(25_000),
      });
      const parsed: unknown = JSON.parse(await response.text());
      if (Array.isArray(parsed)) return parsed;
      const single = z
        .object({ error: z.unknown().optional(), result: z.unknown().optional() })
        .parse(parsed);
      if (single.error !== undefined) throw new Error(JSON.stringify(single.error).slice(0, 160));
      if (single.result === undefined) throw new Error("RPC response had no result");
      return single.result;
    } catch (error) {
      lastError = error;
      await Bun.sleep(800 * (attempt + 1));
    }
  }
  throw lastError;
}

async function trackedAddresses(): Promise<Map<number, Hex[]>> {
  const process_ = Bun.spawn(
    [
      "bunx",
      "wrangler",
      "d1",
      "execute",
      "address-notifications-db",
      "--remote",
      "--command",
      "SELECT chain_id, lower(hex(address)) AS address FROM tracked_addresses WHERE ref_count > 0",
      "--json",
    ],
    { stdout: "pipe", stderr: "inherit" },
  );
  const raw = await new Response(process_.stdout).text();
  if ((await process_.exited) !== 0) throw new Error(raw);
  const rows = trackedSchema.parse(JSON.parse(raw)).flatMap((entry) => entry.results);
  const byChain = new Map<number, Hex[]>();
  for (const row of rows) {
    const list = byChain.get(row.chain_id) ?? [];
    list.push(`0x${row.address}` as Hex);
    byChain.set(row.chain_id, list);
  }
  return byChain;
}

async function fetchHeaders({
  url,
  start,
  end,
}: {
  url: string;
  start: bigint;
  end: bigint;
}): Promise<Array<{ hash: string; logsBloom: Hex }>> {
  const headers: Array<{ hash: string; logsBloom: Hex }> = [];
  for (let from = start; from <= end; from += 10n) {
    const size = Number(end - from + 1n > 10n ? 10n : end - from + 1n);
    const body = Array.from({ length: size }, (_, index) => ({
      jsonrpc: "2.0",
      id: index + 1,
      method: "eth_getBlockByNumber",
      params: [`0x${(from + BigInt(index)).toString(16)}`, false],
    }));
    const parsed = headerSchema.parse(await rpc({ url, body }));
    headers.push(
      ...parsed.map((entry) => ({
        hash: entry.result.hash,
        logsBloom: entry.result.logsBloom as Hex,
      })),
    );
  }
  return headers;
}

async function blockMatchCount({
  url,
  blockHash,
  topics,
}: {
  url: string;
  blockHash: string;
  topics: string[];
}): Promise<number> {
  const logs = logSchema.parse(
    await rpc({
      url,
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getLogs",
        params: [{ blockHash, topics: [TRANSFER_TOPIC] }],
      },
    }),
  );
  return logs.filter(
    (log) => topics.includes(log.topics[1] ?? "") || topics.includes(log.topics[2] ?? ""),
  ).length;
}

function sampleEvery<T>({ items, count }: { items: T[]; count: number }): T[] {
  if (items.length <= count) return items;
  const step = Math.max(1, Math.floor(items.length / count));
  return items.filter((_, index) => index % step === 0).slice(0, count);
}

const sampleSize = arg({ name: "sample", fallback: 400 });
const positiveProbeLimit = arg({ name: "positives", fallback: 50 });
const negativeProbeLimit = arg({ name: "negatives", fallback: 40 });
const tracked = await trackedAddresses();

const results = [];
for (const [chainIdRaw, chain] of Object.entries(CHAINS)) {
  const chainId = Number(chainIdRaw);
  const addresses = tracked.get(chainId) ?? [];
  if (addresses.length === 0) continue;
  const topics = addresses.map((address) => `0x${address.slice(2).padStart(64, "0")}`);
  const filter = createTransferBloomFilter({ trackedAddresses: addresses });

  const headResult = z
    .string()
    .parse(
      await rpc({
        url: chain.url,
        body: { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] },
      }),
    );
  const end = BigInt(headResult) - 40n;
  const start = end - BigInt(sampleSize - 1);
  const headers = await fetchHeaders({ url: chain.url, start, end });

  const positives = headers.filter((header) =>
    mayContainTrackedTransfer({ logsBloom: header.logsBloom, filter }),
  );
  const negativeHashes = new Set(
    headers.filter((header) => !positives.includes(header)).map((header) => header.hash),
  );

  let positiveWithMatch = 0;
  let negativeWithMatch = 0;
  let probeFailures = 0;
  const probes = [
    ...sampleEvery({ items: positives, count: positiveProbeLimit }).map((block) => ({
      block,
      positive: true,
    })),
    ...sampleEvery({
      items: headers.filter((header) => negativeHashes.has(header.hash)),
      count: negativeProbeLimit,
    }).map((block) => ({ block, positive: false })),
  ];
  for (const probe of probes) {
    try {
      const matches = await blockMatchCount({
        url: chain.url,
        blockHash: probe.block.hash,
        topics,
      });
      if (probe.positive) positiveWithMatch += matches > 0 ? 1 : 0;
      else negativeWithMatch += matches > 0 ? 1 : 0;
    } catch {
      probeFailures += 1;
    }
  }

  const blocksPerDay = 86_400_000 / chain.blockSpeedMs;
  const positivesPerDay = (blocksPerDay * positives.length) / headers.length;
  results.push({
    chainId,
    trackedAddresses: addresses.length,
    sampledBlocks: headers.length,
    sampleRange: `${start}..${end}`,
    bloomPositiveBlocks: positives.length,
    bloomPositivePercent: Number(((positives.length / headers.length) * 100).toFixed(1)),
    logQueriesAvoidedPercent: Number(((1 - positives.length / headers.length) * 100).toFixed(1)),
    probes: probes.length,
    positiveProbesWithMatch: positiveWithMatch,
    negativeProbesWithMatch: negativeWithMatch,
    probeFailures,
    estimatedDailyBlocks: Math.round(blocksPerDay),
    estimatedDailyLogQueriesAvoided: Math.round(blocksPerDay - positivesPerDay),
    estimatedDailyCuOld: Math.round(blocksPerDay * (BLOCK_CU + LOG_CU)),
    estimatedDailyCuNew: Math.round(blocksPerDay * BLOCK_CU + positivesPerDay * LOG_CU),
  });
  console.error(
    `chain ${chainId}: ${positives.length}/${headers.length} bloom-positive, ` +
      `${positiveWithMatch} positive probes with a real match, ` +
      `${negativeWithMatch} negative probes with a match (must be 0)`,
  );
}

const cuOld = results.reduce((sum, row) => sum + row.estimatedDailyCuOld, 0);
const cuNew = results.reduce((sum, row) => sum + row.estimatedDailyCuNew, 0);
const blocks = results.reduce((sum, row) => sum + row.estimatedDailyBlocks, 0);
const logsAvoided = results.reduce((sum, row) => sum + row.estimatedDailyLogQueriesAvoided, 0);
console.log(
  JSON.stringify(
    {
      chains: results,
      totals: {
        estimatedDailyBlocks: blocks,
        estimatedDailyLogQueriesAvoided: logsAvoided,
        logQueryAvoidedPercent: Number(((logsAvoided / blocks) * 100).toFixed(1)),
        estimatedDailyCuOld: cuOld,
        estimatedDailyCuNew: cuNew,
        cuReductionPercent: Number(((1 - cuNew / cuOld) * 100).toFixed(1)),
      },
    },
    null,
    2,
  ),
);
