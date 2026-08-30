/**
 * Minimal webhook HTTP client for Milestone 1. Performs a signed POST with a
 * strict timeout and response-size cap, disables redirects, and classifies the
 * outcome (success / permanent failure / retryable). Milestone 3 will evolve
 * this into the queue-backed delivery consumer with backoff and a DLQ.
 */

const DELIVERY_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 4096;

export type DeliveryAttempt = {
  delivered: boolean;
  httpStatus: number | null;
  retryable: boolean;
  error: string | null;
};

const RETRYABLE_STATUSES = new Set([408, 409, 425, 429]);

function isPermanentFailureStatus(status: number): boolean {
  return status >= 400 && status < 500 && !RETRYABLE_STATUSES.has(status);
}

export async function attemptWebhookDelivery({
  url,
  body,
  headers,
}: {
  url: string;
  body: string;
  headers: Record<string, string>;
}): Promise<DeliveryAttempt> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("Delivery timeout"), DELIVERY_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
      signal: controller.signal,
      redirect: "manual",
    });

    const bodyText = await readLimitedBody(response);

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      return {
        delivered: false,
        httpStatus: response.status,
        retryable: true,
        error: "Redirect disallowed",
      };
    }
    if (response.ok) {
      return { delivered: true, httpStatus: response.status, retryable: false, error: null };
    }
    if (isRetryableStatus(response.status)) {
      return { delivered: false, httpStatus: response.status, retryable: true, error: null };
    }
    if (isPermanentFailureStatus(response.status)) {
      return {
        delivered: false,
        httpStatus: response.status,
        retryable: false,
        error: excerpt(bodyText),
      };
    }
    return {
      delivered: false,
      httpStatus: response.status,
      retryable: true,
      error: excerpt(bodyText),
    };
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === "AbortError";
    return {
      delivered: false,
      httpStatus: null,
      retryable: true,
      error: isTimeout
        ? "Delivery timed out"
        : error instanceof Error
          ? error.message
          : "Delivery failed",
    };
  } finally {
    clearTimeout(timeout);
  }
}

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status) || status >= 500;
}

/** Reads up to MAX_RESPONSE_BYTES of a response body, then cancels. */
async function readLimitedBody(response: Response): Promise<string> {
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total <= MAX_RESPONSE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) {
        total += value.byteLength;
        chunks.push(value);
      }
    }
  } finally {
    await reader.cancel();
  }
  const all = concatUint8(chunks).slice(0, MAX_RESPONSE_BYTES);
  return new TextDecoder().decode(all);
}

function concatUint8(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function excerpt(value: string): string | null {
  if (value.length === 0) {
    return null;
  }
  return value.length > 256 ? `${value.slice(0, 256)}…` : value;
}
