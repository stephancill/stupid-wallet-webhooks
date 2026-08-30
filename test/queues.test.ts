import { describe, expect, it } from "bun:test";
import { buildWebhookJson, parseObservationData } from "../src/queues/webhook-body";

describe("webhook body construction", () => {
  const data = {
    chainId: 1,
    trackedAddress: "0x1111",
    blockTimestamp: "1700000000",
    transaction: { hash: "0xaaa", status: "success" },
    effects: [{ id: "eff", kind: "erc20" }],
  };

  it("produces byte-stable JSON (reproducible signatures)", () => {
    const a = buildWebhookJson({ id: "evt_x", type: "activity.observed", data });
    const b = buildWebhookJson({ id: "evt_x", type: "activity.observed", data });
    expect(a.json).toBe(b.json);
    // Expected exact string, so fixtures are reproducible.
    expect(a.json).toBe(
      '{"id":"evt_x","type":"activity.observed","createdAt":"2023-11-14T22:13:20.000Z","data":{"chainId":1,"trackedAddress":"0x1111","blockTimestamp":"1700000000","transaction":{"hash":"0xaaa","status":"success"},"effects":[{"id":"eff","kind":"erc20"}]}}',
    );
  });

  it("derives createdAt from the block timestamp", () => {
    const { createdAt } = buildWebhookJson({ id: "evt_x", type: "activity.observed", data });
    expect(createdAt).toBe("2023-11-14T22:13:20.000Z");
  });

  it("parses persisted observation data back to an object", () => {
    const parsed = parseObservationData(JSON.stringify(data));
    expect(parsed.chainId).toBe(1);
    expect(parsed.effects as unknown[]).toHaveLength(1);
  });
});
