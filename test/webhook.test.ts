import { describe, expect, it } from "bun:test";
import { validateWebhookUrl } from "../src/domain/webhook";

describe("webhook URL validation", () => {
  it("accepts a public https URL", () => {
    const result = validateWebhookUrl("https://example.com/hook");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url).toBe("https://example.com/hook");
    }
  });

  it("rejects non-https", () => {
    expect(validateWebhookUrl("http://example.com/hook").ok).toBe(false);
    expect(validateWebhookUrl("ftp://example.com/hook").ok).toBe(false);
  });

  it("rejects credentials in the URL", () => {
    expect(validateWebhookUrl("https://user:pass@example.com/hook").ok).toBe(false);
  });

  it("rejects localhost and hostname-based internal destinations", () => {
    expect(validateWebhookUrl("https://localhost/hook").ok).toBe(false);
    expect(validateWebhookUrl("https://foo.local/hook").ok).toBe(false);
    expect(validateWebhookUrl("https://foo.internal/hook").ok).toBe(false);
  });

  it("rejects private and link-local IP literals", () => {
    expect(validateWebhookUrl("https://127.0.0.1/hook").ok).toBe(false);
    expect(validateWebhookUrl("https://10.0.0.5/hook").ok).toBe(false);
    expect(validateWebhookUrl("https://192.168.1.1/hook").ok).toBe(false);
    expect(validateWebhookUrl("https://172.16.0.1/hook").ok).toBe(false);
    expect(validateWebhookUrl("https://169.254.169.254/hook").ok).toBe(false);
    expect(validateWebhookUrl("https://[::1]/hook").ok).toBe(false);
  });

  it("rejects malformed URLs", () => {
    expect(validateWebhookUrl("not a url").ok).toBe(false);
  });
});
