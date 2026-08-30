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

export const IDs = {
  account: () => newId("acct"),
  apiKey: () => newId("key"),
  webhook: () => newId("wh"),
  subscription: () => newId("sub"),
  trackedAddress: () => newId("ta"),
  delivery: () => newId("del"),
  testEvent: () => newId("test"),
} as const;
