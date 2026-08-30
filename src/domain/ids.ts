/**
 * Identifier helpers. Entity ids are random-prefixed ids; commands and
 * event/observation ids use deterministic content hashes so retries replay to
 * the same id (idempotency) and reorg compensation can address the exact
 * observation that was delivered.
 */

const ID_ENTROPY_LENGTH = 24;

const encoder = new TextEncoder();

export function sha256Hex(input: string): Promise<string> {
  return crypto.subtle
    .digest("SHA-256", encoder.encode(input))
    .then((digest) =>
      [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    );
}

/** Random unique id with a semantic prefix, e.g. `wh_ab12...`. */
export function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(ID_ENTROPY_LENGTH / 2));
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${hex}`;
}

/** Deterministic id from a canonical string. Used for scanner command idempotency. */
export async function commandId(canonical: string): Promise<string> {
  const hash = await sha256Hex(canonical);
  return `cmd_${hash}`;
}

function truncatedHash(prefix: string, canonical: string, length = 56): Promise<string> {
  return sha256Hex(canonical).then((hash) => `${prefix}_${hash.slice(0, length)}`);
}

/**
 * Observation (webhook event) id. Deterministic per logical bundle
 * (chainId, txHash, trackedAddress) plus block hash, so duplicate delivery and
 * reorg compensation address the exact same observation.
 */
export function observationId({
  chainId,
  txHash,
  trackedAddress,
  blockHash,
}: {
  chainId: number;
  txHash: string;
  trackedAddress: string;
  blockHash: string;
}): Promise<string> {
  return truncatedHash("evt", `${chainId}|${txHash}|${trackedAddress}|${blockHash}`);
}

/** Logger bundle key shared by bundle/observation/effect ids. */
export function bundleKey({
  chainId,
  txHash,
  trackedAddress,
}: {
  chainId: number;
  txHash: string;
  trackedAddress: string;
}): string {
  return `${chainId}|${txHash}|${trackedAddress}`;
}

/**
 * Effect id: observation id + effect discriminator (`native` or a token log
 * index). Deterministic with the observation id.
 */
export function effectId({
  observationId: obsId,
  kind,
  logIndex,
}: {
  observationId: string;
  kind: "native" | "erc20" | "erc721";
  logIndex?: number;
}): Promise<string> {
  return truncatedHash("eff", `${obsId}|${kind}${logIndex === undefined ? "" : `|${logIndex}`}`);
}

export const IDs = {
  account: () => newId("acct"),
  apiKey: () => newId("key"),
  webhook: () => newId("wh"),
  subscription: () => newId("sub"),
  trackedAddress: () => newId("ta"),
  delivery: () => newId("del"),
  testEvent: () => newId("test"),
} as const;
