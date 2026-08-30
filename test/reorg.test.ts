import { describe, expect, it } from "bun:test";
import {
  findAncestor,
  orphanedHeights,
  pruneTo,
  pushWindow,
  classifyChain,
  type HeldBlock,
} from "../src/domain/reorg";

function held(start: number, count: number): HeldBlock[] {
  const blocks: HeldBlock[] = [];
  for (let i = start; i < start + count; i += 1) {
    blocks.push({
      number: i,
      hash: `0x${i.toString(16)}`.padEnd(66, "0"),
      parentHash: `0x${(i - 1).toString(16)}`.padEnd(66, "0"),
    });
  }
  return blocks;
}

describe("reorg window primitives", () => {
  it("finds a shared ancestor among held blocks", () => {
    const window = held(80, 20); // blocks 80..99
    const ancestor = findAncestor(window, window[15]?.hash ?? "");
    expect(ancestor?.number).toBe(80 + 15);
  });

  it("orthophates heights strictly above the ancestor", () => {
    const window = held(80, 20);
    const ancestor = window[10]!; // block 90
    const orphaned = orphanedHeights(window, ancestor);
    expect(orphaned).toEqual([91, 92, 93, 94, 95, 96, 97, 98, 99]);
  });

  it("prunes the window to the ancestor", () => {
    const window = held(80, 20);
    const pruned = pruneTo(window, window[10]!);
    expect(pruned).toHaveLength(11);
    expect(pruned[pruned.length - 1]?.number).toBe(90);
  });

  it("keeps the window bounded", () => {
    const many = held(1, 100);
    const capped = pushWindow([], many[many.length - 1]!, 4);
    // pushWindow appends a single block and caps at the provided limit
    expect(capped).toHaveLength(1);
    const grown = held(1, 2);
    const capped2 = pushWindow(grown, held(3, 1)[0]!, 2);
    expect(capped2).toHaveLength(2);
  });

  it("classifies ok / reorg / unresolvable", () => {
    const window = held(80, 20);
    const tip = window[window.length - 1]!;
    expect(classifyChain(window, { parentHash: tip.hash, cursorHash: tip.hash })).toEqual({
      kind: "ok",
    });
    expect(
      classifyChain(window, { parentHash: "0x0".padEnd(66, "0"), cursorHash: tip.hash }).kind,
    ).toBe("unresolvable");
    const ancestor = window[10]!;
    const before = window[9]!;
    const reorg = classifyChain(window, { parentHash: ancestor.hash, cursorHash: before.hash });
    expect(reorg.kind).toBe("reorg");
    if (reorg.kind === "reorg") {
      expect(reorg.ancestor.number).toBe(90);
      expect(reorg.orphaned[0]).toBe(91);
    }
  });
});
