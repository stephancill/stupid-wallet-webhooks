import { describe, expect, it } from "bun:test";
import { computeLatencyPercentiles } from "../src/db/repository";

describe("delivery latency percentiles", () => {
  it("returns nulls with no samples", () => {
    expect(computeLatencyPercentiles([])).toEqual({
      eligibleCount: 0,
      p50Ms: null,
      p95Ms: null,
      p99Ms: null,
    });
  });

  it("filters out invalid samples and computes ordered percentiles", () => {
    const samples = [100, 200, 300, 400, 4000, -50, Number.NaN, 500];
    const { eligibleCount, p50Ms, p95Ms, p99Ms } = computeLatencyPercentiles(samples);
    // Only the finite non-negative samples are kept (6 values).
    expect(eligibleCount).toBe(6);
    expect(p50Ms).toBe(400); // index 3 of sorted [100,200,300,400,500,4000]
    expect(p95Ms).toBe(4000); // last sample for 6 elements
    expect(p99Ms).toBe(4000);
  });
});
