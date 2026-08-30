import { describe, expect, it } from "bun:test";
import { planFanOutDeliveries, classifyDelivery, shouldSkip } from "../src/queues/plan";

const observation = {
  observationId: "evt_x",
  chainId: 1,
  trackedAddress: "0x1111111111111111111111111111111111111111",
  blockNumber: "100",
  data: JSON.stringify({
    chainId: 1,
    trackedAddress: "0x1111",
    blockTimestamp: "1700000000",
    transaction: { hash: "0xaaa", status: "success" },
    effects: [],
  }),
};

const sub = (
  over: Partial<{
    id: string;
    account_id: string;
    webhook_id: string;
    active_from_block: number | null;
  }>,
) => ({
  id: "sub_a",
  account_id: "acct_a",
  webhook_id: "wh_a",
  active_from_block: null,
  ...over,
});

describe("fan-out planning", () => {
  it("emits one delivery per eligible subscription", () => {
    const plans = planFanOutDeliveries({
      observation,
      subscriptions: [sub({}), sub({ webhook_id: "wh_b", id: "sub_b" })],
    });
    expect(plans).toHaveLength(2);
    expect(plans[0].body.webhookId).toBe("wh_a");
  });

  it("skips subscriptions whose activation block is after the observation", () => {
    const plans = planFanOutDeliveries({
      observation,
      subscriptions: [
        sub({ active_from_block: 101 }),
        sub({ active_from_block: 50 }),
        sub({ active_from_block: null }),
      ],
    });
    expect(plans).toHaveLength(2); // only the >= 50-block and null-activation subs
  });

  it("produces byte-stable bodyJson for identical inputs", () => {
    const a = planFanOutDeliveries({ observation, subscriptions: [sub({})] });
    const b = planFanOutDeliveries({ observation, subscriptions: [sub({})] });
    expect(a[0]?.body.bodyJson).toBe(b[0]?.body.bodyJson);
  });
});

describe("delivery classification", () => {
  it("classifies outcomes", () => {
    expect(classifyDelivery({ delivered: true, retryable: false })).toBe("success");
    expect(classifyDelivery({ delivered: false, retryable: true })).toBe("retry");
    expect(classifyDelivery({ delivered: false, retryable: false })).toBe("dead_lettered");
  });

  it("dedup gate", () => {
    expect(shouldSkip(true)).toBe(true);
    expect(shouldSkip(false)).toBe(false);
  });
});
