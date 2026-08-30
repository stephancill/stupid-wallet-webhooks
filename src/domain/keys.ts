/**
 * Key and signature primitives. API keys are hashed with a server-side pepper
 * before storage; webhook signing secrets are derived deterministically from a
 * master secret and webhook id (never stored).
 */

const encoder = new TextEncoder();

/** Generates a new random API key plus the short prefix shown in listings. */
export function generateApiKey(): { key: string; prefix: string } {
  const randoms = crypto.getRandomValues(new Uint8Array(16));
  const hex = [...randoms].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const key = `an_${crypto.randomUUID().replace(/-/g, "")}${hex}`;
  return { key, prefix: key.slice(0, 12) };
}

/** Returns the peppered hash stored for an API key. Uses HMAC-SHA256. */
export function hashApiKey({ key, pepper }: { key: string; pepper: string }): Promise<string> {
  return hmacHex({ key: pepper, value: key });
}

/** Derives a webhook's stable signing secret from the master secret + id. */
export function deriveWebhookSecret({
  masterSecret,
  webhookId,
}: {
  masterSecret: string;
  webhookId: string;
}): Promise<string> {
  return hmacHex({ key: masterSecret, value: `webhook:${webhookId}` });
}

/** HMAC-SHA256 signature over the raw body, for webhook delivery headers. */
export async function webhookSignature({
  secret,
  body,
  timestamp,
}: {
  secret: string;
  body: string;
  timestamp: number;
}): Promise<string> {
  const signedPayload = `${timestamp}.${body}`;
  const signature = await hmacHex({ key: secret, value: signedPayload });
  return `v1,${signature}`;
}

async function hmacHex({ key, value }: { key: string; value: string }): Promise<string> {
  const keyBuf = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", keyBuf, encoder.encode(value));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison for secret checks. */
export function stringsEqual(a: string, b: string): boolean {
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  if (aBytes.length !== bBytes.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < aBytes.length; index += 1) {
    // eslint-disable-next-line no-bitwise
    diff |= (aBytes[index] ?? 0) ^ (bBytes[index] ?? 0);
  }
  return diff === 0;
}
