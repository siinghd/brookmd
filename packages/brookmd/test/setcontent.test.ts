import { test, expect } from "bun:test";
import { BrookClient, BrookPool } from "../src/client";
import type { Block, FromWorker, ToWorker, WorkerLike } from "../src/types";

// setContent is the controlled-string bridge: feed it the whole document each
// time and it diffs against the last value — prefix-extension → append the
// delta; divergence → reset + reparse. These drive a BrookClient over a fake
// worker and assert the exact message sequence it emits (no real Worker/WASM).

class FakeWorker implements WorkerLike {
  sent: ToWorker[] = [];
  private listener: ((ev: { data: FromWorker }) => void) | null = null;
  postMessage(msg: ToWorker) {
    this.sent.push(msg);
  }
  addEventListener(_t: "message", l: (ev: { data: FromWorker }) => void) {
    this.listener = l;
  }
  terminate() {}
  fire(msg: FromWorker) {
    this.listener?.({ data: msg });
  }
}

function setup() {
  const created: FakeWorker[] = [];
  const pool = new BrookPool(() => {
    const w = new FakeWorker();
    created.push(w);
    return w;
  }, 8);
  return { pool, created, client: new BrookClient({ pool }) };
}

const appendedChunks = (w: FakeWorker) =>
  w.sent.filter((m): m is Extract<ToWorker, { type: "append" }> => m.type === "append").map((m) => m.chunk);
const msgTypes = (w: FakeWorker) => w.sent.map((m) => m.type);

test("prefix-extension appends only the new suffix (no reset)", () => {
  const { client, created } = setup();
  client.setContent("# A\n\n");
  client.setContent("# A\n\nbody");
  client.setContent("# A\n\nbody more");
  const w = created[0];
  expect(appendedChunks(w)).toEqual(["# A\n\n", "body", " more"]);
  expect(msgTypes(w)).not.toContain("reset");
});

test("an unchanged string is a no-op (no extra append)", () => {
  const { client, created } = setup();
  client.setContent("x");
  client.setContent("x");
  expect(appendedChunks(created[0])).toEqual(["x"]);
});

test("divergence resets then reparses the whole new string (reset precedes the reparse append)", () => {
  const { client, created } = setup();
  client.setContent("hello world");
  client.setContent("HELLO world"); // not a prefix-extension of "hello world"
  const w = created[0];
  expect(appendedChunks(w)).toEqual(["hello world", "HELLO world"]);
  const resetIdx = w.sent.findIndex((m) => m.type === "reset");
  const lastAppendIdx = w.sent.map((m) => m.type).lastIndexOf("append");
  expect(resetIdx).toBeGreaterThanOrEqual(0);
  expect(resetIdx).toBeLessThan(lastAppendIdx); // reset, THEN reparse
});

test("{ done: true } finalizes once and is idempotent for the same content", () => {
  const { client, created } = setup();
  client.setContent("final text", { done: true });
  client.setContent("final text", { done: true }); // same content + done → no second finalize
  const w = created[0];
  expect(w.sent.filter((m) => m.type === "finalize").length).toBe(1);
});

test("a content change after done reopens via reset+reparse (a finalized parser is terminal)", () => {
  const { client, created } = setup();
  client.setContent("a", { done: true }); // append "a" + finalize → parser now terminal
  client.setContent("ab", { done: true }); // reopen: must reset + reparse, NOT append "b"
  const w = created[0];
  // The delta must NOT be appended into the finalized (dead) parser — that would
  // be silently dropped. Reopen resets and reparses the whole new string.
  expect(appendedChunks(w)).toEqual(["a", "ab"]);
  const resetIdx = w.sent.findIndex((m) => m.type === "reset");
  const lastAppendIdx = w.sent.map((m) => m.type).lastIndexOf("append");
  expect(resetIdx).toBeGreaterThanOrEqual(0); // a reset was issued
  expect(resetIdx).toBeLessThan(lastAppendIdx); // reset, THEN reparse the new string
  expect(w.sent.filter((m) => m.type === "finalize").length).toBe(2);
});

test("reset() clears the diff baseline so the next setContent re-feeds the document", () => {
  const { client, created } = setup();
  client.setContent("abc");
  client.reset(); // manual reset — worker drops the parser
  client.setContent("abc"); // baseline cleared → must re-append the whole string
  expect(appendedChunks(created[0])).toEqual(["abc", "abc"]);
});

test("reattach() clears the baseline (StrictMode dev double-mount re-feeds)", () => {
  const { client, created } = setup();
  client.setContent("hello");
  client.destroy(); // simulated unmount: dispose drops the parser
  client.reattach(); // remount the SAME instance
  client.setContent("hello"); // baseline cleared → re-append
  expect(appendedChunks(created[0])).toEqual(["hello", "hello"]);
});

// --------------------------------------------------------------------------
// PRESERVED-VIEW DIVERGENCE SWAP — the once-at-the-end reprocess path must be
// seamless: no empty frame, unchanged blocks keep object identity (and id →
// React key / DOM node key), only genuinely changed blocks re-key.
// --------------------------------------------------------------------------

function blk(id: number, html: string, open = false): Block {
  return { id, kind: { type: "Paragraph" }, start: 0, end: html.length, html, open, speculative: false };
}

// Fire a worker patch into the live client, stamped with the client's CURRENT
// generation (read from the last epoch-carrying message it sent) so the
// straggler guard doesn't drop it.
function firePatch(
  w: FakeWorker,
  patch: { newly_committed: Block[]; active: Block[] },
  opts: { final?: boolean } = {},
) {
  const sid = (w.sent[0] as { streamId: number }).streamId;
  const epochs = w.sent
    .map((m) => (m as { epoch?: number }).epoch)
    .filter((e): e is number => e !== undefined);
  w.fire({
    type: "patch",
    streamId: sid,
    patch: JSON.stringify(patch),
    appendedBytes: 0,
    parseMicros: 0,
    retainedBytes: 0,
    wasmMemoryBytes: 0,
    final: opts.final ?? false,
    epoch: epochs.length ? Math.max(...epochs) : 0,
  });
}

function expectUniqueIds(snap: Block[]) {
  const ids = snap.map((b) => b.id);
  expect(new Set(ids).size).toBe(ids.length);
}

// Drive a client to a committed 3-block finalized view (ids with streaming-style
// holes: tail reparses burn ids, so a later one-shot reparse WILL renumber).
function committedGen0(client: BrookClient, w: FakeWorker) {
  firePatch(w, {
    newly_committed: [blk(0, "<p>alpha</p>"), blk(2, "<p>beta</p>"), blk(5, "<p>gamma</p>")],
    active: [],
  });
  firePatch(w, { newly_committed: [], active: [] }, { final: true });
  return client.getSnapshot();
}

test("divergence swap: view never blanks, unchanged blocks keep identity, only the changed block re-keys", () => {
  const { client, created } = setup();
  const seen: Block[][] = [];
  client.subscribe(() => seen.push(client.getSnapshot()));
  client.setContent("v1", { done: true });
  const w = created[0];
  const gen0 = committedGen0(client, w);
  expect(gen0.map((b) => b.id)).toEqual([0, 2, 5]);

  // Post-processed final: middle block changed, ids renumber densely (0,1,2).
  client.setContent("v1 processed", { done: true });
  // Before any reparse patch lands, the displayed view is the EXACT same array.
  expect(client.getSnapshot()).toBe(gen0);
  expect(client.getSnapshot()).toBe(client.getSnapshot()); // ref-stable between notifies

  firePatch(w, {
    newly_committed: [blk(0, "<p>alpha</p>"), blk(1, "<p>beta CHANGED</p>"), blk(2, "<p>gamma</p>")],
    active: [],
  });
  const merged = client.getSnapshot();
  expect(merged.length).toBe(3);
  expect(merged[0]).toBe(gen0[0]); // identical html → OLD object, same id → memo-skips
  expect(merged[2]).toBe(gen0[2]);
  expect(merged[1].html).toBe("<p>beta CHANGED</p>"); // the one real change
  expect(merged[1]).not.toBe(gen0[1]); // fresh object (new content)…
  expect(merged[1].id).toBe(gen0[1].id); // …but the OLD id: same React key → in-place re-render, state survives
  expectUniqueIds(merged);

  firePatch(w, { newly_committed: [], active: [] }, { final: true });
  const final = client.getSnapshot();
  expect(final[0]).toBe(gen0[0]); // adopted identity survives the terminal patch
  expect(final[2]).toBe(gen0[2]);
  expectUniqueIds(final);
  expect(client.getSnapshot()).toBe(final); // post-swap reads are ref-stable

  // No subscriber ever saw an empty document.
  expect(seen.length).toBeGreaterThan(0);
  for (const snap of seen) expect(snap.length).toBeGreaterThan(0);
});

test("shorter replacement: old tail stays visible until the terminal patch, then trims", () => {
  const { client, created } = setup();
  client.setContent("v1", { done: true });
  const w = created[0];
  const gen0 = committedGen0(client, w); // 3 blocks

  client.setContent("v2 shorter", { done: true }); // reparses to only 2 blocks
  // Mid-reparse: first block committed, second still open → old blocks hold at
  // both positions (never a shrinking partial), old tail padded beyond.
  firePatch(w, {
    newly_committed: [blk(0, "<p>alpha</p>")],
    active: [blk(1, "<p>be", true)],
  });
  const mid = client.getSnapshot();
  expect(mid.length).toBe(3); // old length held pre-trim
  expect(mid[0]).toBe(gen0[0]);
  expect(mid[1]).toBe(gen0[1]); // open tail over old content → old block shown
  expect(mid[2]).toBe(gen0[2]);

  firePatch(w, { newly_committed: [blk(1, "<p>beta2</p>")], active: [] }, { final: true });
  const final = client.getSnapshot();
  expect(final.length).toBe(2); // trimmed to the new document's length
  expect(final[0]).toBe(gen0[0]);
  expect(final[1].html).toBe("<p>beta2</p>");
  expectUniqueIds(final);
});

test("setContent('') is an explicit clear and hard-resets immediately", () => {
  const { client, created } = setup();
  let notifies = 0;
  client.subscribe(() => notifies++);
  client.setContent("v1", { done: true });
  const w = created[0];
  committedGen0(client, w);
  const before = notifies;
  client.setContent("");
  expect(notifies).toBe(before + 1); // synchronous clear notify
  expect(client.getSnapshot()).toEqual([]);
});

test("chained divergence mid-reparse: the merged view carries over, original objects flow through", () => {
  const { client, created } = setup();
  client.setContent("v1", { done: true });
  const w = created[0];
  const gen0 = committedGen0(client, w);

  client.setContent("v2 diverged", { done: true });
  // Reparse only reaches block 0 before the NEXT divergence hits.
  firePatch(w, { newly_committed: [blk(0, "<p>alpha</p>")], active: [] });
  const merged1 = client.getSnapshot();
  expect(merged1[0]).toBe(gen0[0]);
  expect(merged1[2]).toBe(gen0[2]); // padding: reparse never reached it

  client.setContent("v3 diverged again", { done: true });
  expect(client.getSnapshot()).toBe(merged1); // captured merged view holds, same ref

  firePatch(w, {
    newly_committed: [blk(0, "<p>alpha</p>"), blk(1, "<p>beta</p>"), blk(2, "<p>gamma</p>")],
    active: [],
  }, { final: true });
  const final = client.getSnapshot();
  expect(final.length).toBe(3);
  expect(final[0]).toBe(gen0[0]); // survived TWO swaps by identity
  expect(final[2]).toBe(gen0[2]);
  expectUniqueIds(final);
});

test("incremental merge: unchanged positions reuse the previous view's objects across patches (linear, no re-compare churn)", () => {
  const { client, created } = setup();
  client.setContent("v1", { done: true });
  const w = created[0];
  const gen0 = committedGen0(client, w);

  // Diverge WITHOUT done: the new answer streams in over many patches.
  client.setContent("restart: ");
  firePatch(w, {
    newly_committed: [blk(0, "<p>alpha</p>"), blk(1, "<p>NEW two</p>")],
    active: [blk(2, "<p>grow", true)],
  });
  const v1 = client.getSnapshot();
  expect(v1[0]).toBe(gen0[0]);
  const remapped = v1[1];
  expect(remapped.html).toBe("<p>NEW two</p>");

  // Next patch: same committed refs, only the tail advanced. The merged view
  // must reuse the SAME objects for untouched positions — including the
  // remapped changed block (stable identity ⇒ no re-render, no re-compare).
  firePatch(w, { newly_committed: [], active: [blk(2, "<p>grow more", true)] });
  const v2 = client.getSnapshot();
  expect(v2[0]).toBe(gen0[0]);
  expect(v2[1]).toBe(remapped);
  expectUniqueIds(v2);
});

test("outline() reflects the displayed (merged) view during a swap", () => {
  const { client, created } = setup();
  client.setContent("v1", { done: true });
  const w = created[0];
  const heading: Block = {
    id: 0, kind: { type: "Heading", data: 2 }, start: 0, end: 14, html: "<h2>Title</h2>", open: false, speculative: false,
  };
  firePatch(w, { newly_committed: [heading, blk(3, "<p>body</p>")], active: [] }, { final: true });
  const before = client.outline();
  expect(before).toEqual([{ level: 2, text: "Title", id: 0 }]);

  client.setContent("v2 diverged", { done: true });
  // Mid-reparse, before any patch: outline must still describe what's rendered.
  expect(client.outline()).toEqual(before);
  firePatch(w, { newly_committed: [heading, blk(1, "<p>body CHANGED</p>")], active: [] }, { final: true });
  // Identical heading adopted → same id; a ToC built from it won't re-key.
  expect(client.outline()).toEqual([{ level: 2, text: "Title", id: 0 }]);
});

test("reattach re-feed after a completed divergence swap: no duplicate/ghost blocks (re-feed IS a swap)", () => {
  const { client, created } = setup();
  client.setContent("v1", { done: true });
  const w = created[0];
  const gen0 = committedGen0(client, w); // ids [0,2,5]

  // Divergence swap completes → the store is re-keyed by DISPLAYED ids.
  client.setContent("v1 processed", { done: true });
  firePatch(w, {
    newly_committed: [blk(0, "<p>alpha</p>"), blk(1, "<p>beta CHANGED</p>"), blk(2, "<p>gamma</p>")],
    active: [],
  }, { final: true });
  const collapsed = client.getSnapshot();
  expect(collapsed.length).toBe(3);

  // destroy() → reattach() (public API reuse across mount cycles) → re-feed.
  client.destroy();
  client.reattach();
  client.setContent("v1 processed", { done: true });
  // The re-feed preserved the displayed view (no blank), and the fresh parser's
  // raw ids must NOT be trusted against the re-keyed store.
  expect(client.getSnapshot()).toBe(collapsed);
  firePatch(w, {
    newly_committed: [blk(0, "<p>alpha</p>"), blk(1, "<p>beta CHANGED</p>"), blk(2, "<p>gamma</p>")],
    active: [],
  }, { final: true });
  const refed = client.getSnapshot();
  expect(refed.length).toBe(3); // NOT 5 — no duplicated tail
  expect(refed[0]).toBe(gen0[0]); // identical content: identity flows through
  expectUniqueIds(refed);
  expect(refed.map((b) => b.html)).toEqual(["<p>alpha</p>", "<p>beta CHANGED</p>", "<p>gamma</p>"]);
});

test("reattach re-feed MID-merge: the interrupted swap's stale padding never ghosts into the new document", () => {
  const { client, created } = setup();
  client.setContent("v1", { done: true });
  const w = created[0];
  committedGen0(client, w); // 3 blocks

  // Divergence to a 2-block doc; reparse only reaches block 0, then unmount.
  client.setContent("v2 short", { done: true });
  firePatch(w, { newly_committed: [blk(0, "<p>alpha</p>")], active: [] });
  client.destroy();
  client.reattach();

  // Re-feed the same 2-block doc; after its terminal patch the view must be
  // exactly 2 blocks — the old gen0 tail (gamma) must not survive as a ghost.
  client.setContent("v2 short", { done: true });
  firePatch(w, {
    newly_committed: [blk(0, "<p>alpha</p>"), blk(1, "<p>two</p>")],
    active: [],
  }, { final: true });
  const final = client.getSnapshot();
  expect(final.length).toBe(2);
  expect(final.map((b) => b.html)).toEqual(["<p>alpha</p>", "<p>two</p>"]);
  expectUniqueIds(final);
});

test("reattach re-feed with NO divergence ever: hole-y streamed ids don't duplicate against dense reparse ids", () => {
  // Pre-existing latent bug (independent of the swap work): a streamed store
  // keyed [0,2,5] re-fed by a fresh parser emitting dense [0,1,2] used to
  // interleave into 4+ mangled blocks via applyPatch's has(id) dedupe.
  const { client, created } = setup();
  client.setContent("v1", { done: true });
  const w = created[0];
  const gen0 = committedGen0(client, w); // ids [0,2,5]

  client.destroy();
  client.reattach();
  client.setContent("v1", { done: true }); // same doc — StrictMode-style re-feed
  firePatch(w, {
    newly_committed: [blk(0, "<p>alpha</p>"), blk(1, "<p>beta</p>"), blk(2, "<p>gamma</p>")],
    active: [],
  }, { final: true });
  const refed = client.getSnapshot();
  expect(refed.length).toBe(3); // NOT 4
  // Identical content re-fed → every block adopted by identity, zero re-renders.
  expect(refed[0]).toBe(gen0[0]);
  expect(refed[1]).toBe(gen0[1]);
  expect(refed[2]).toBe(gen0[2]);
});

test("public reset() still hard-clears even while a preserved view is live", () => {
  const { client, created } = setup();
  let notifies = 0;
  client.subscribe(() => notifies++);
  client.setContent("v1", { done: true });
  const w = created[0];
  committedGen0(client, w);
  client.setContent("v2 diverged", { done: true }); // preserved view live, raw store empty
  const before = notifies;
  client.reset();
  expect(notifies).toBe(before + 1); // displayed view counted as content → clear notify
  expect(client.getSnapshot()).toEqual([]);
});
