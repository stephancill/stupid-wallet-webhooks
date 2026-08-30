/**
 * Webhook URL validation. Rejects non-HTTPS URLs and destinations that are
 * loopback, private, link-local, multicast, or Cloudflare metadata — before
 * any request is sent. Redirects are disabled at delivery time so a resolved
 * endpoint can't hop to a private target after validation.
 */

export type UrlValidation = { ok: true; url: string } | { ok: false; reason: string };

function isPrivateIpLiteral(host: string): boolean {
  const lower = host.toLowerCase();
  // IPv6 literal (bracketed or bare).
  if (lower.includes(":")) {
    const normalized = lower.startsWith("[") && lower.endsWith("]") ? lower.slice(1, -1) : lower;
    if (
      normalized === "::1" ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("::ffff:127.") ||
      normalized === "0:0:0:0:0:0:0:1"
    ) {
      return true;
    }
    return false;
  }

  const parts = lower.split(".");
  if (parts.length !== 4) {
    return false;
  }
  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (octets.some((value) => Number.isNaN(value) || value < 0 || value > 255)) {
    return false;
  }
  const [a, b] = octets as [number, number, number, number];
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true; // includes 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 224) return true; // multicast/reserved
  return lower === "255.255.255.255";
}

function isPrivateHostname(host: string): boolean {
  const lower = host.toLowerCase();
  return (
    lower === "localhost" ||
    lower.endsWith(".localhost") ||
    lower.endsWith(".local") ||
    lower.endsWith(".internal") ||
    lower.endsWith(".onion") ||
    lower.endsWith(".lan")
  );
}

export function validateWebhookUrl(
  raw: string,
  options: { allowInsecure?: boolean } = {},
): UrlValidation {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: "URL is not valid" };
  }

  if (parsed.protocol !== "https:" && !(options.allowInsecure && parsed.protocol === "http:")) {
    return { ok: false, reason: "URL must use https" };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, reason: "URL must not contain credentials" };
  }

  const host = parsed.hostname;
  if (!(options.allowInsecure && isLoopbackHost(host))) {
    if (isPrivateHostname(host) || isPrivateIpLiteral(host)) {
      return { ok: false, reason: "Webhook URL must target a public internet address" };
    }
  }

  return { ok: true, url: parsed.toString() };
}

function isLoopbackHost(host: string): boolean {
  const lower = host.toLowerCase();
  return (
    lower === "localhost" ||
    lower === "127.0.0.1" ||
    lower === "::1" ||
    lower === "[::1]" ||
    lower.startsWith("127.")
  );
}
