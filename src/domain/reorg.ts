/**
 * Reorg primitives (Milestone 4). Pure functions over a rolling window of
 * recently-accepted blocks: locate the fork point (a shared ancestor) for a
 * candidate block, compute which held blocks are orphaned, and prune the window.
 * Unit-testable without a node.
 */

export type HeldBlock = {
  number: number;
  hash: string;
  parentHash: string;
};

const DEFAULT_WINDOW = 32;

function norm(hash: string): string {
  return hash.toLowerCase();
}

/** Returns the held block whose hash equals the candidate parent (fork point), or null. */
export function findAncestor(window: HeldBlock[], candidateParentHash: string): HeldBlock | null {
  const needle = norm(candidateParentHash);
  for (let i = window.length - 1; i >= 0; i -= 1) {
    const block = window[i];
    if (block !== undefined && norm(block.hash) === needle) return block;
  }
  return null;
}

/** Numbers of held blocks that are on the orphaned side of an ancestor. */
export function orphanedHeights(window: HeldBlock[], ancestor: HeldBlock): number[] {
  return window
    .filter((block) => block.number > ancestor.number)
    .map((block) => block.number)
    .sort((a, b) => a - b);
}

/** Prunes the window to the fork point (and everything at/below it). */
export function pruneTo(window: HeldBlock[], ancestor: HeldBlock): HeldBlock[] {
  return window.filter((block) => block.number <= ancestor.number);
}

/** Appends an accepted block, keeping the window bounded. Returns the new window. */
export function pushWindow(
  window: HeldBlock[],
  block: HeldBlock,
  limit = DEFAULT_WINDOW,
): HeldBlock[] {
  const next = [...window, block];
  return next.slice(Math.max(0, next.length - limit));
}

/**
 * Classifies a candidate block against the held window:
 *  - `ok` when its parent equals the current tip,
 *  - `reorg` when an earlier held block is the parent (how many blocks are orphaned),
 *  - `unresolvable` when no held ancestor matches (too deep / out of window).
 */
export function classifyChain(
  window: HeldBlock[],
  candidate: { parentHash: string; cursorHash: string | null },
):
  | { kind: "ok" }
  | { kind: "reorg"; ancestor: HeldBlock; orphaned: number[] }
  | { kind: "unresolvable" } {
  if (candidate.cursorHash === null) return { kind: "ok" };
  if (norm(candidate.parentHash) === norm(candidate.cursorHash)) return { kind: "ok" };
  const ancestor = findAncestor(window, candidate.parentHash);
  if (ancestor === null) return { kind: "unresolvable" };
  return { kind: "reorg", ancestor, orphaned: orphanedHeights(window, ancestor) };
}
