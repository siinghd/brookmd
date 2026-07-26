import { test, expect, afterEach } from "bun:test";
import { BrookClient, BrookPool, applyPatch } from "../src/client";
import type { BlockStore } from "../src/client";
import type { Block, FromWorker, ToWorker, WorkerLike } from "../src/types";
import { __resetWarnOnce } from "../src/warn";

// REGRESSION (0.24.0 worker lifecycle):
//  1. The worker stores parser config PER STREAM ID, so a rebind onto a fresh
//     worker lands on one that has never seen ours. `configSent` was latched
//     true for the client's lifetime, so the healed parser was silently rebuilt
//     with library defaults — componentTags / blockData / gfmMath and the whole
//     `kind.data` structured channel vanished for the rest of the session.
//  2. After a TERMINAL failure the store kept the dead generation's blocks while
//     the fresh parser renumbered from zero, so the next append merged two
//     generations under colliding ids (duplicate React keys, silently
//     overwritten blocks, a shrinking document).
//  3. applyPatch published `committed.get(id)!` straight into the snapshot; a
//     desync would have put a hole in the array that the renderers deref.

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

/** The stream id this client is using on `w` (read off its first message). */
function sidOn(w: FakeWorker): number {
  const m = w.sent.find((x) => "streamId" in x) as { streamId: number } | undefined;
  return m!.streamId;
}

function patchMsg(streamId: number, committed: Block[]): FromWorker {
  return {
    type: "patch",
    streamId,
    patch: JSON.stringify({ newly_committed: committed, active: [] }),
    appendedBytes: 0,
    parseMicros: 0,
    retainedBytes: 0,
    wasmMemoryBytes: 0,
  } as unknown as FromWorker;
}

function blk(id: number, html: string): Block {
  return {
    id,
    kind: { type: "Paragraph", data: undefined },
    start: 0,
    end: 0,
    html,
    open: false,
    speculative: false,
  } as unknown as Block;
}

// ---------------------------------------------------------------------------

test("recovery re-feed carries the parser config onto the replacement worker", async () => {
  const { pool, created } = makePool();
  const client = new BrookClient({ pool, config: { blockData: true, componentTags: ["Thinking"] } });

  client.append("hello");
  const a = created[0];
  const firstAppend = a.sent.find((m) => m.type === "append") as { config?: unknown } | undefined;
  expect(firstAppend!.config).toBeDefined(); // baseline: rides the first message

  a.fire(patchMsg(sidOn(a), [blk(0, "<p>hello</p>")]));
  a.fireError({ message: "worker died" }); // transient → one-shot recovery
  await Promise.resolve();

  expect(created.length).toBe(2);
  const b = created[1];
  const refeed = b.sent.filter((m) => m.type === "append") as { config?: unknown; chunk?: string }[];
  expect(refeed.length).toBeGreaterThan(0);
  // THE FIX: the replacement worker has no config for this stream, so the
  // re-feed must carry it. Before, `configSent` stayed latched and the healed
  // parser silently reverted to library defaults.
  expect(refeed.some((m) => m.config !== undefined)).toBe(true);
  const carried = refeed.find((m) => m.config !== undefined)!.config as {
    blockData?: boolean;
    componentTags?: string[];
  };
  expect(carried.blockData).toBe(true);
  expect(carried.componentTags).toEqual(["Thinking"]);
});

test("a terminal failure restarts the generation instead of colliding block ids", () => {
  const { pool, created } = makePool();
  const errors: string[] = [];
  // recovery off → the first fatal is terminal
  const client = new BrookClient({ pool, recovery: false, onError: (e) => errors.push(e.message) });

  client.append("first document");
  const a = created[0];
  a.fire(patchMsg(sidOn(a), [blk(0, "<p>one</p>"), blk(1, "<p>two</p>")]));
  expect(client.getSnapshot().map((b) => b.id)).toEqual([0, 1]);

  a.fireError({ message: "dead" });
  expect(client.failed).not.toBeNull(); // terminal
  expect(errors.length).toBe(1);

  // The app keeps streaming. The fresh parser numbers from 0 again.
  client.append("second document");
  const b = created[1];
  expect(b).toBeDefined();
  b.fire(patchMsg(sidOn(b), [blk(0, "<p>alpha</p>")]));

  const snap = client.getSnapshot();
  const ids = snap.map((x) => x.id);
  // THE FIX: exactly one generation is present. Before, the new id 0 overwrote
  // the old id 0 in the map while committedOrder still listed both, so the
  // document rendered "alpha, two" with a duplicate React key.
  expect(new Set(ids).size).toBe(ids.length); // no duplicate ids
  expect(snap.map((x) => x.html)).toEqual(["<p>alpha</p>"]);
});

test("a transient (recoverable) failure does NOT restart the generation", async () => {
  const { pool, created } = makePool();
  const client = new BrookClient({ pool }); // recovery on by default

  client.append("hello");
  const a = created[0];
  a.fire(patchMsg(sidOn(a), [blk(0, "<p>hello</p>")]));
  a.fireError({ message: "transient" });
  await Promise.resolve();

  // The preserved view stays on screen across the heal — the restart path must
  // not fire while the one-shot recovery owns the rebuild.
  expect(client.failed).toBeNull();
  expect(client.getSnapshot().length).toBe(1);
  expect(client.getSnapshot()[0].html).toBe("<p>hello</p>");
});

test("applyPatch drops an orphaned committed id instead of publishing a hole", () => {
  const store: BlockStore = { committed: new Map(), committedOrder: [], active: [], snapshot: [] };
  applyPatch(store, { newly_committed: [blk(0, "<p>a</p>"), blk(1, "<p>b</p>")], active: [] });
  expect(store.snapshot.length).toBe(2);

  // Force the desync the non-null assertion used to assume away.
  store.committed.delete(1);
  applyPatch(store, { newly_committed: [blk(2, "<p>c</p>")], active: [] });

  expect(store.snapshot.length).toBe(2);
  expect(store.snapshot.every((b: Block) => b !== undefined && b.kind !== undefined)).toBe(true);
  expect(store.snapshot.map((b: Block) => b.html)).toEqual(["<p>a</p>", "<p>c</p>"]);
});
