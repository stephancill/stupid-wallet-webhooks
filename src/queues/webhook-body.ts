/**
 * Deterministic webhook body construction. The `data` object is kept in the
 * byte order it was serialized during ingestion, so parsing it back and
 * re-serializing produces a byte-identical body — reproducible signatures and
 * fixtures across retries.
 */
export function buildWebhookJson({
  id,
  type,
  data,
}: {
  id: string;
  type: "activity.observed" | "activity.reverted" | "webhook.test";
  data: Record<string, unknown>;
}): { json: string; createdAt: string } {
  const blockTimestamp = typeof data.blockTimestamp === "string" ? data.blockTimestamp : "";
  const createdAt =
    blockTimestamp === ""
      ? new Date().toISOString()
      : new Date(Number(blockTimestamp) * 1000).toISOString();
  return {
    json: JSON.stringify({ id, type, createdAt, data }),
    createdAt,
  };
}

/** Parses a persisted observation `data` string back to an object. */
export function parseObservationData(dataRaw: string): Record<string, unknown> {
  const parsed = JSON.parse(dataRaw);
  if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>;
  return {};
}
