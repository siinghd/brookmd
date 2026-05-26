import { test, expect } from "bun:test";
import { applyPatch, emptyBlockStore } from "../src/client";
import type { Block } from "../src/types";

function blk(id: number, html: string, open = false): Block {
  return { id, kind: { type: "Paragraph" }, start: 0, end: html.length, html, open, speculative: false };
}

// These tests pin the contract that prevents extra React re-renders: a
// committed block's object reference is stable across patches, so the
// `blocksEqual` memo on BlockView short-circuits and the block never
// re-renders (hence never re-parses, for the components path) as the stream
// grows. Only the active tail churns.

test("committed block keeps a stable reference across later patches", () => {
  const store = emptyBlockStore();
  const b1 = blk(1, "<p>first</p>");
  applyPatch(store, { newly_committed: [b1], active: [blk(2, "<p>act", true)] });
  const snap1 = store.snapshot;
  expect(snap1[0]).toBe(b1); // committed object is exactly what we put in

  // Next patch grows only the active tail; block 1 is NOT re-sent.
  applyPatch(store, { newly_committed: [], active: [blk(2, "<p>active grown</p>", true)] });

  expect(store.snapshot[0]).toBe(b1); // SAME reference → memo skips re-render
  expect(store.snapshot).not.toBe(snap1); // but a fresh array → list-level change detected
  expect(store.snapshot[1]).not.toBe(snap1[1]); // active tail legitimately re-renders
});

test("block order is preserved as blocks commit incrementally", () => {
  const store = emptyBlockStore();
  applyPatch(store, { newly_committed: [blk(1, "a")], active: [] });
  applyPatch(store, { newly_committed: [blk(2, "b"), blk(3, "c")], active: [blk(4, "d", true)] });
  expect(store.snapshot.map((b) => b.id)).toEqual([1, 2, 3, 4]);
});

test("re-committing a block (revised content) replaces its reference, not duplicates", () => {
  const store = emptyBlockStore();
  const b1 = blk(1, "a");
  applyPatch(store, { newly_committed: [b1], active: [] });
  const b1v2 = blk(1, "a-revised");
  applyPatch(store, { newly_committed: [b1v2], active: [] });
  expect(store.snapshot[0]).toBe(b1v2); // changed → new ref → SHOULD re-render
  expect(store.snapshot[0]).not.toBe(b1);
  expect(store.snapshot.length).toBe(1); // same id replaced in place, not appended
});

test("a no-op patch (no commits, same active refs) yields equal block references", () => {
  const store = emptyBlockStore();
  const a = blk(5, "<p>x</p>", true);
  applyPatch(store, { newly_committed: [], active: [a] });
  const first = store.snapshot[0];
  applyPatch(store, { newly_committed: [], active: [a] }); // identical active reference
  expect(store.snapshot[0]).toBe(first); // unchanged active object → memo skips
});
