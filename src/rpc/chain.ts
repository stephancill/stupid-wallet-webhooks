/**
 * Chain metadata resolution. For Milestone 1 this reaches the rpc-racer worker
 * over HTTP at the public base URL (control-plane volume only). Milestone 0
 * swaps this for a private service binding.
 */

import { z } from "zod";

export const chainInfoSchema = z.object({
  chainId: z.number().int().positive(),
  name: z.string(),
  shortName: z.string().optional(),
  chainSlug: z.string().optional(),
  isTestnet: z.boolean().optional(),
  aliases: z.array(z.string()).optional(),
  rpcUrlCount: z.number().int().nonnegative().optional(),
  blockSpeedMs: z.number().finite().positive().optional(),
});

export type ChainInfo = z.infer<typeof chainInfoSchema>;

export type ChainResolveResult =
  | { ok: true; chain: ChainInfo }
  | { ok: false; reason: "unknown_chain" | "transport" | "invalid"; detail?: string };

export async function resolveChain({
  baseUrl,
  chainId,
  fetcher,
  signal,
}: {
  baseUrl: string;
  chainId: number | string;
  fetcher?: Fetcher;
  signal?: AbortSignal;
}): Promise<ChainResolveResult> {
  try {
    const url = `${baseUrl.replace(/\/$/, "")}/v1/chains/${chainId}`;
    const doFetch = (input: string, init?: RequestInit) =>
      fetcher !== undefined ? fetcher.fetch(input, init) : fetch(input, init);
    const response = await doFetch(url, {
      headers: { accept: "application/json" },
      signal,
    });

    if (response.status === 404) {
      let detail: string | undefined;
      try {
        const parsed = rpcErrorSchema.safeParse(await response.json());
        detail = parsed.success ? parsed.data.error : undefined;
      } catch {
        // ignore body parse failure
      }
      return { ok: false, reason: "unknown_chain", detail };
    }

    if (!response.ok) {
      return { ok: false, reason: "transport", detail: `HTTP ${response.status}` };
    }

    const parsed = chainInfoSchema.safeParse(await response.json());
    if (!parsed.success) {
      return { ok: false, reason: "invalid", detail: "Malformed chain metadata" };
    }
    return { ok: true, chain: parsed.data };
  } catch (error) {
    return { ok: false, reason: "transport", detail: errorMessage(error) };
  }
}

const rpcErrorSchema = z.object({ error: z.string().optional() });

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") {
    return "aborted";
  }
  return error instanceof Error ? error.message : "unknown error";
}

/** Determines whether a chain resolves regardless of its block-speed estimate. */
export function isResolvableChain(
  result: ChainResolveResult,
): result is { ok: true; chain: ChainInfo } {
  return result.ok;
}
