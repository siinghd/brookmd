import { test, expect, afterEach } from "bun:test";
import { BrookClient, BrookPool, sourceFingerprint } from "../src/client";
import type { PersistableSnapshot } from "../src/client";
import type { Block, FromWorker, ToWorker, WorkerLike } from "../src/types";
import { __resetWarnOnce } from "../src/warn";

/**
 * INSTANT THREAD REOPEN — the snapshot/hydrate contract.
 *
 * Reopening a long thread used to mean re-feeding its whole source through the
 * worker before the first paint. The committed wire is already a complete
 * serialization (WIRE.md §2: a committed block is emitted exactly once and is
 * final), so a persisted snapshot IS the document — hydration is a Map fill, not
 * a parse.
 *
 * These tests pin the two properties that make that safe:
 *   1. hydrate touches NO worker (the whole point — a spawned worker means WASM
 *      init and an O(history) parse crept back onto the reopen path), and
 *   2. a snapshot brookmd cannot fully understand is rejected WHOLE, never
 *      half-restored into a document that renders as if it were real.
 *
 * Everything here runs on a FakeWorker: no WASM, no parsing. Resume convergence
 * against the real parser lives in hydrate-resume.test.ts.
 */

class FakeWorker implements WorkerLike {
  sent: ToWorker[] = [];
  private listener: ((ev: { data: FromWorker }) => void) | null = null;
  private errorListener: ((ev: unknown) => void) | null = null;
  postMessage(msg: ToWorker) {
    this.sent.push(msg);
  }
  addEventListener(t: string, l: (ev: { data: FromWorker }) => void) {
    if (t === "error") this.errorListener = l as (ev: unknown) => void;
    else if (t !== "messageerror") this.listener = l;
  }
  terminate() {}
  fire(msg: FromWorker) {
    this.listener?.({ data: msg });
  }
  fireError(ev?: { message?: string }) {
    this.errorListener?.(ev ?? {});
  }
}

afterEach(() => __resetWarnOnce());

function makePool(cap = 4) {
  const created: FakeWorker[] = [];
  const pool = new BrookPool(
    () => {
      const w = new FakeWorker();
      created.push(w);
      return w;
    },
    cap,
    { bootTimeoutMs: 0 },
  );
  return { pool, created };
}

function blk(id: number, html: string, open = false): Block {
  return { id, kind: { type: "Paragraph" }, start: 0, end: html.length, html, open, speculative: false };
}

const SRC = "one\n\ntwo\n\nthree";
const BLOCKS = [blk(0, "<p>one</p>"), blk(1, "<p>two</p>"), blk(2, "<p>three</p>")];

/** A well-formed envelope for `blocks` over `source`. */
function snap(
  blocks: Block[] = BLOCKS,
  source = SRC,
  done = true,
): PersistableSnapshot {
  return {
    hydrateVersion: 1,
    blocks,
    sourceLength: source.length,
    sourceHash: sourceFingerprint(source),
    done,
  };
}

// ── The headline property: paint with no worker ────────────────────────────

test("hydrate paints the whole document and spawns no worker at all", () => {
  const { pool, created } = makePool();
  const c = new BrookClient({ pool });

  c.hydrate(snap());

  expect(c.getSnapshot().map((b) => b.html)).toEqual(["<p>one</p>", "<p>two</p>", "<p>three</p>"]);
  expect(c.getSnapshot().map((b) => b.id)).toEqual([0, 1, 2]);
  // THE POINT. A worker here means WASM init + an O(history) parse crept back
  // onto the reopen path, which is the entire thing hydration removes.
  expect(created.length).toBe(0);
  expect(pool.workerCount).toBe(0);
});

test("a hydrated document is readable through the derived views too", () => {
  const c = new BrookClient({ pool: makePool().pool });
  c.hydrate(
    snap([blk(0, "<h2>Title</h2>"), blk(1, "<p>body</p>")].map((b, i) =>
      i === 0 ? { ...b, kind: { type: "Heading", data: 2 } } : b,
    ) as Block[]),
  );
  expect(c.outline()).toEqual([{ level: 2, text: "Title", id: 0 }]);
  expect(c.toPlaintext()).toBe("Title\n\nbody");
});

test("whenReady() on a hydrated thread resolves without acquiring a worker", async () => {
  const { pool, created } = makePool();
  const c = new BrookClient({ pool });
  c.hydrate(snap());

  await c.whenReady(); // must not hang, and must not spawn
  expect(created.length).toBe(0);
  // A `ready`-gated spinner must not sit forever over a fully rendered thread.
  expect(c.ready).toBe(true);
});

test("hydrating an already-mounted client notifies its subscribers", () => {
  const c = new BrookClient({ pool: makePool().pool });
  let notifies = 0;
  c.subscribe(() => notifies++);
  c.hydrate(snap());
  expect(notifies).toBe(1);
  expect(c.getSnapshot().length).toBe(3);
});

test("onBlock does not fire for hydrated blocks (it is a PARSER-commit hook)", () => {
  const seen: number[] = [];
  const c = new BrookClient({ pool: makePool().pool, onBlock: (b) => seen.push(b.id) });
  c.hydrate(snap());
  expect(seen).toEqual([]);
});

// ── Guard rails: reject whole, never half ──────────────────────────────────

test("an unknown envelope version is refused, naming both versions", () => {
  const c = new BrookClient({ pool: makePool().pool });
  expect(() => c.hydrate({ ...snap(), hydrateVersion: 2 })).toThrow(/version 2 snapshot.*version 1/s);
  expect(c.getSnapshot()).toEqual([]); // untouched
});

test("a malformed block is refused and leaves NO partial state", () => {
  const { pool, created } = makePool();
  const c = new BrookClient({ pool });
  const bad = snap([blk(0, "<p>ok</p>"), { id: 1, html: "<p>b</p>" } as unknown as Block, blk(2, "<p>c</p>")]);

  expect(() => c.hydrate(bad)).toThrow(/block at index 1 is not a Block/);
  // The valid prefix must NOT have landed — a half-restored document renders as
  // a real one and silently lies about what the thread said.
  expect(c.getSnapshot()).toEqual([]);
  expect(created.length).toBe(0);

  // And the client is still usable: a good snapshot hydrates cleanly after.
  c.hydrate(snap());
  expect(c.getSnapshot().length).toBe(3);
});

test("duplicate block ids are refused (the id is the render key AND the map key)", () => {
  const c = new BrookClient({ pool: makePool().pool });
  expect(() => c.hydrate(snap([blk(0, "<p>a</p>"), blk(0, "<p>b</p>")]))).toThrow(/duplicate block id 0/);
  expect(c.getSnapshot()).toEqual([]);
});

test("a structurally bad envelope is refused", () => {
  const c = new BrookClient({ pool: makePool().pool });
  expect(() => c.hydrate({ ...snap(), blocks: "nope" as unknown as Block[] })).toThrow(/malformed/);
  expect(() => c.hydrate({ ...snap(), done: 1 as unknown as boolean })).toThrow(/malformed/);
  expect(() => c.hydrate({ ...snap(), sourceLength: -1 })).toThrow(/malformed/);
  expect(() => c.hydrate({ ...snap(), sourceHash: 7 as unknown as string })).toThrow(/malformed/);
  expect(() => c.hydrate(null as unknown as PersistableSnapshot)).toThrow(/expects a PersistableSnapshot/);
  expect(c.getSnapshot()).toEqual([]);
});

test("hydrating a client that already holds content throws", () => {
  const { pool, created } = makePool();
  const c = new BrookClient({ pool });
  c.append("already streaming");
  expect(() => c.hydrate(snap())).toThrow(/untouched client/);

  const d = new BrookClient({ pool });
  d.hydrate(snap());
  expect(() => d.hydrate(snap())).toThrow(/untouched client/); // not twice, either
  expect(created.length).toBe(1); // only the append-driven client made one
});

// ── A finalized thread is terminal ─────────────────────────────────────────

test("appending to a thread hydrated as done throws instead of silently forking it", () => {
  const { pool, created } = makePool();
  const c = new BrookClient({ pool });
  c.hydrate(snap(BLOCKS, SRC, true));

  expect(() => c.append(" more")).toThrow(/FINALIZED snapshot/);
  // Still no worker: the throw happens before anything is acquired.
  expect(created.length).toBe(0);
  expect(c.getSnapshot().length).toBe(3); // and the view is intact
});

test("finalize() on a thread hydrated as done is a no-op, not a worker spawn", () => {
  const { pool, created } = makePool();
  const c = new BrookClient({ pool });
  c.hydrate(snap(BLOCKS, SRC, true));

  c.finalize(); // already final — asking again must not build a parser
  expect(created.length).toBe(0);
  expect(c.getSnapshot().length).toBe(3);
});

test("a resumable hydrate without its source is view-only and says so", () => {
  const { pool, created } = makePool();
  const c = new BrookClient({ pool });
  c.hydrate(snap(BLOCKS, SRC, false)); // done:false, but no `source` passed

  expect(() => c.append(" more")).toThrow(/without its source/);
  expect(() => c.finalize()).toThrow(/without its source/);
  expect(created.length).toBe(0);
});

test("pipeFrom into a done hydrate rejects rather than quietly forking the thread", async () => {
  const { pool, created } = makePool();
  const c = new BrookClient({ pool });
  c.hydrate(snap(BLOCKS, SRC, true));

  async function* more() {
    yield " and more";
  }
  await expect(c.pipeFrom(more())).rejects.toThrow(/FINALIZED snapshot/);
  expect(created.length).toBe(0);
});

test("reset() clears hydration, returning an ordinary fresh client", () => {
  const { pool, created } = makePool();
  const c = new BrookClient({ pool });
  c.hydrate(snap(BLOCKS, SRC, true));
  c.reset();

  expect(c.getSnapshot()).toEqual([]);
  // The done-latch is gone: appending is allowed again and drives a real worker.
  expect(() => c.append("brand new")).not.toThrow();
  expect(created.length).toBe(1);
});

// ── Resume: the source is re-fed AHEAD of the caller's chunk ───────────────

test("the first append after a resumable hydrate re-feeds the source before the chunk", () => {
  const { pool, created } = makePool();
  const c = new BrookClient({ pool });
  c.hydrate(snap(BLOCKS, SRC, false), { source: SRC });
  expect(created.length).toBe(0); // nothing yet

  c.append("\n\nfour");

  const w = created[0];
  expect(w).toBeDefined();
  const appends = w.sent.filter((m) => m.type === "append") as { chunk: string }[];
  // postMessage is FIFO per worker, so the caller's chunk needs no buffer of
  // ours — it simply queues behind the history re-feed.
  expect(appends.map((m) => m.chunk)).toEqual([SRC, "\n\nfour"]);
});

test("the hydrated view stays on screen, by reference, while the parser catches up", () => {
  const { pool } = makePool();
  const c = new BrookClient({ pool });
  c.hydrate(snap(BLOCKS, SRC, false), { source: SRC });
  const before = c.getSnapshot();

  c.append("\n\nfour"); // resume issued; no patch has come back yet

  // Same ARRAY reference — a render between now and the first patch is a pure
  // no-op, so nothing flickers and nothing remounts during catch-up.
  expect(c.getSnapshot()).toBe(before);
  expect(c.getSnapshot().map((b) => b.html)).toEqual(["<p>one</p>", "<p>two</p>", "<p>three</p>"]);
});

test("a worker death during catch-up heals through the existing recovery path", async () => {
  const { pool, created } = makePool();
  const c = new BrookClient({ pool });
  c.hydrate(snap(BLOCKS, SRC, false), { source: SRC });
  c.append("\n\nfour");

  created[0].fireError({ message: "died mid-catch-up" });
  await Promise.resolve();

  // Healed onto a fresh worker, view intact, no terminal error surfaced.
  expect(c.failed).toBeNull();
  expect(c.getSnapshot().map((b) => b.html)).toEqual(["<p>one</p>", "<p>two</p>", "<p>three</p>"]);
  const refeed = created[1].sent.filter((m) => m.type === "append") as { chunk: string }[];
  expect(refeed.map((m) => m.chunk).join("")).toBe(SRC + "\n\nfour");
});

test("setContent takes over a hydrated thread without prepending a stale source", () => {
  const { pool, created } = makePool();
  const c = new BrookClient({ pool });
  c.hydrate(snap(BLOCKS, SRC, false), { source: SRC });

  // A controlled-string caller hands back the WHOLE document, so the resume
  // re-feed is redundant — feeding it too would parse the history twice.
  c.setContent(SRC + "\n\nfour");
  const appends = (created[0].sent.filter((m) => m.type === "append") as { chunk: string }[]).map(
    (m) => m.chunk,
  );
  expect(appends.join("")).toBe(SRC + "\n\nfour");
  expect(appends.filter((a) => a === SRC).length).toBeLessThanOrEqual(1);
});

test("setContent on a done hydrate reparses seamlessly instead of throwing", () => {
  const { pool, created } = makePool();
  const c = new BrookClient({ pool });
  c.hydrate(snap(BLOCKS, SRC, true));

  // A finalized thread whose text was reprocessed: the caller supplies the whole
  // new document, so this is the documented divergence swap, not an append.
  c.setContent("one\n\ntwo\n\nthree\n\nfour");
  const appends = created[0].sent.filter((m) => m.type === "append") as { chunk: string }[];
  expect(appends.map((m) => m.chunk).join("")).toBe("one\n\ntwo\n\nthree\n\nfour");
  // The hydrated view is preserved across the rebuild — the document never blanks.
  expect(c.getSnapshot().map((b) => b.html)).toEqual(["<p>one</p>", "<p>two</p>", "<p>three</p>"]);
});

// ── getPersistable ─────────────────────────────────────────────────────────

test("getPersistable → JSON → hydrate round-trips a streamed document", () => {
  const { pool, created } = makePool();
  const a = new BrookClient({ pool });
  a.append(SRC);
  created[0].fire({
    type: "patch",
    streamId: (created[0].sent[0] as { streamId: number }).streamId,
    patch: JSON.stringify({ newly_committed: BLOCKS, active: [] }),
    appendedBytes: SRC.length,
    parseMicros: 0,
    retainedBytes: 0,
    wasmMemoryBytes: 0,
    final: true,
  } as unknown as FromWorker);

  const wire = JSON.stringify(a.getPersistable());
  const b = new BrookClient({ pool });
  b.hydrate(JSON.parse(wire) as PersistableSnapshot);

  expect(b.getSnapshot()).toEqual(a.getSnapshot());
  expect(created.length).toBe(1); // the reopen added no worker
});

test("getPersistable fingerprints the retained source and tracks `done`", () => {
  const { pool, created } = makePool();
  const c = new BrookClient({ pool }); // recovery on (default) → source retained
  c.append(SRC);
  expect(c.getPersistable().done).toBe(false);
  expect(c.getPersistable().sourceLength).toBe(SRC.length);
  expect(c.getPersistable().sourceHash).toBe(sourceFingerprint(SRC));

  c.finalize();
  expect(c.getPersistable().done).toBe(true);
  expect(created.length).toBe(1);
});

test("getPersistable on an untouched hydrate re-emits the envelope verbatim", () => {
  const c = new BrookClient({ pool: makePool().pool });
  const original = snap(BLOCKS, SRC, true);
  c.hydrate(original);

  // The source is unchanged BY DEFINITION here, so re-persisting must not
  // demand a source this client (a `done` hydrate) was never given.
  const again = c.getPersistable();
  expect(again.sourceLength).toBe(original.sourceLength);
  expect(again.sourceHash).toBe(original.sourceHash);
  expect(again.done).toBe(true);
  expect(again.blocks).toEqual(original.blocks);
});

test("getPersistable(source) is required only when the client retains nothing", () => {
  const { pool } = makePool();
  const c = new BrookClient({ pool, recovery: false }); // no buffer, append-driven
  c.append(SRC);

  expect(() => c.getPersistable()).toThrow(/needs the source markdown/);
  expect(c.getPersistable(SRC).sourceHash).toBe(sourceFingerprint(SRC));
});

test("an empty client persists as an empty, correctly fingerprinted document", () => {
  const c = new BrookClient({ pool: makePool().pool });
  const s = c.getPersistable();
  expect(s).toEqual({
    hydrateVersion: 1,
    blocks: [],
    sourceLength: 0,
    sourceHash: sourceFingerprint(""),
    done: false,
  });
});

// ── sourceFingerprint ──────────────────────────────────────────────────────

test("sourceFingerprint is deterministic, 8 hex digits, and notices edits", () => {
  expect(sourceFingerprint(SRC)).toBe(sourceFingerprint(SRC));
  expect(sourceFingerprint(SRC)).toMatch(/^[0-9a-f]{8}$/);
  expect(sourceFingerprint(SRC)).not.toBe(sourceFingerprint(SRC + " "));
  expect(sourceFingerprint("ab")).not.toBe(sourceFingerprint("ba")); // order-sensitive
  expect(sourceFingerprint("héllo 🎉")).toMatch(/^[0-9a-f]{8}$/); // non-ASCII safe
});
