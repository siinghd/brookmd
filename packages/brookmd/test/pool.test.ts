import { test, expect } from "bun:test";
import { BrookClient, BrookPool } from "../src/client";
import type { Block, FromWorker, ToWorker, WorkerLike } from "../src/types";

// A synchronous fake worker: records what was posted to it and lets the test
// fire responses back through the registered listener. No real Worker/WASM.
// Stores the DOM error / messageerror listeners separately from the message
// channel (real Workers dispatch per event type) so a test can simulate a
// script-load failure without disturbing message routing.
class FakeWorker implements WorkerLike {
  sent: ToWorker[] = [];
  terminated = false;
  terminateCount = 0;
  private listener: ((ev: { data: FromWorker }) => void) | null = null;
  private errorListener: ((ev: unknown) => void) | null = null;
  private messageErrorListener: ((ev: unknown) => void) | null = null;
  postMessage(msg: ToWorker) {
    this.sent.push(msg);
  }
  addEventListener(t: string, l: (ev: { data: FromWorker }) => void) {
    if (t === "error") this.errorListener = l as (ev: unknown) => void;
    else if (t === "messageerror") this.messageErrorListener = l as (ev: unknown) => void;
    else this.listener = l;
  }
  terminate() {
    this.terminated = true;
    this.terminateCount++;
  }
  fire(msg: FromWorker) {
    this.listener?.({ data: msg });
  }
  fireError(ev?: { message?: string }) {
    this.errorListener?.(ev ?? {});
  }
  fireMessageError() {
    this.messageErrorListener?.({});
  }
}

// Deterministic fake timer machinery for the boot-deadline tests: records armed
// callbacks and lets the test fire or cancel them by hand.
function makeFakeTimers() {
  let nextId = 1;
  const pending = new Map<number, () => void>();
  return {
    setTimeout: (fn: () => void, _ms: number) => {
      const id = nextId++;
      pending.set(id, fn);
      return id;
    },
    clearTimeout: (h: unknown) => {
      pending.delete(h as number);
    },
    // Fire every armed timer (the boot deadline elapsing).
    flush() {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
    },
    get armed() {
      return pending.size;
    },
  };
}

function makePool(
  cap: number,
  options?: {
    bootTimeoutMs?: number;
    setTimeout?: (fn: () => void, ms: number) => unknown;
    clearTimeout?: (handle: unknown) => void;
  },
) {
  const created: FakeWorker[] = [];
  // Default the boot deadline OFF so plain tests don't arm real unref'd 20s
  // setTimeouts (harmless but a latent flake); the deadline tests opt back in by
  // injecting fake timers + a bootTimeoutMs.
  const pool = new BrookPool(() => {
    const w = new FakeWorker();
    created.push(w);
    return w;
  }, cap, { bootTimeoutMs: 0, ...options });
  return { pool, created };
}

test("one stream uses exactly one worker (lazy)", () => {
  const { pool, created } = makePool(8);
  pool.acquire(() => {});
  expect(created.length).toBe(1);
  expect(pool.workerCount).toBe(1);
});

test("each new stream gets its own worker until the cap", () => {
  const { pool, created } = makePool(3);
  for (let i = 0; i < 3; i++) pool.acquire(() => {});
  expect(created.length).toBe(3);
  expect(pool.workerCount).toBe(3);
});

test("past the cap, streams attach to the least-loaded worker", () => {
  const { pool } = makePool(2);
  const a = pool.acquire(() => {}); // worker0: 1
  const b = pool.acquire(() => {}); // worker1: 1
  const c = pool.acquire(() => {}); // cap hit → least-loaded (worker0): 2
  const d = pool.acquire(() => {}); // least-loaded (worker1): 2
  expect(pool.workerCount).toBe(2);
  // a&c share a worker; b&d share the other; the two workers differ.
  expect(a.pw).toBe(c.pw);
  expect(b.pw).toBe(d.pw);
  expect(a.pw).not.toBe(b.pw);
});

test("messages are demuxed to the owning stream's handler only", () => {
  const { pool, created } = makePool(1); // force both streams onto one worker
  const got1: FromWorker[] = [];
  const got2: FromWorker[] = [];
  const s1 = pool.acquire((m) => got1.push(m));
  const s2 = pool.acquire((m) => got2.push(m));
  expect(s1.pw).toBe(s2.pw);
  const w = created[0];

  const patch = (streamId: number): FromWorker => ({
    type: "patch", streamId, patch: JSON.stringify({ newly_committed: [], active: [] }),
    appendedBytes: 0, parseMicros: 0, retainedBytes: 0, wasmMemoryBytes: 0,
  });
  w.fire(patch(s1.streamId));
  w.fire(patch(s2.streamId));
  w.fire(patch(s1.streamId));

  expect(got1.length).toBe(2);
  expect(got2.length).toBe(1);
});

test("ready is worker-level and not delivered to stream handlers", () => {
  const { pool, created } = makePool(1);
  const got: FromWorker[] = [];
  pool.acquire((m) => got.push(m));
  created[0].fire({ type: "ready" });
  expect(got.length).toBe(0); // handler sees patch/error, never ready
});

test("whenWorkerReady resolves on ready, and immediately for later siblings", async () => {
  const { pool, created } = makePool(1);
  const s1 = pool.acquire(() => {});
  let resolved = false;
  const p = pool.whenWorkerReady(s1.pw).then(() => (resolved = true));
  expect(resolved).toBe(false); // not ready yet
  created[0].fire({ type: "ready" });
  await p;
  expect(resolved).toBe(true);
  // A second stream on the now-ready worker resolves without another message.
  const s2 = pool.acquire(() => {});
  expect(s2.pw).toBe(s1.pw);
  await pool.whenWorkerReady(s2.pw); // resolves immediately
});

test("a fatal worker error rejects whenWorkerReady and notifies every live stream", async () => {
  const { pool, created } = makePool(1); // both streams share one worker
  const got1: FromWorker[] = [];
  const got2: FromWorker[] = [];
  const s1 = pool.acquire((m) => got1.push(m));
  const s2 = pool.acquire((m) => got2.push(m));
  expect(s1.pw).toBe(s2.pw);

  const ready = pool.whenWorkerReady(s1.pw);
  // Fatal WASM-init failure — carries no real streamId.
  created[0].fire({ type: "error", streamId: -1, message: "WASM boom", fatal: true });

  await expect(ready).rejects.toThrow("WASM boom");
  // Both live streams were notified, so each client's onError can fire.
  expect(got1.at(-1)).toMatchObject({ type: "error", fatal: true, message: "WASM boom" });
  expect(got2.at(-1)).toMatchObject({ type: "error", fatal: true, message: "WASM boom" });
  // A later readiness check on the doomed worker rejects immediately too.
  await expect(pool.whenWorkerReady(s1.pw)).rejects.toThrow("WASM boom");
});

test("a non-fatal (per-stream) error routes only to that stream's handler", () => {
  const { pool, created } = makePool(1);
  const got1: FromWorker[] = [];
  const got2: FromWorker[] = [];
  const s1 = pool.acquire((m) => got1.push(m));
  pool.acquire((m) => got2.push(m));
  created[0].fire({ type: "error", streamId: s1.streamId, message: "parse oops" });
  expect(got1.length).toBe(1);
  expect(got2.length).toBe(0);
});

test("BrookClient.onError receives worker errors (no console.error fallback)", () => {
  const { pool, created } = makePool(1);
  const errors: Array<{ message: string; fatal?: boolean }> = [];
  const c = new BrookClient({ pool, onError: (e) => errors.push(e) });
  c.append("x"); // wire the worker + discover the stream id
  const sid = (created[0].sent[0] as { streamId: number }).streamId;
  created[0].fire({ type: "error", streamId: sid, message: "parse oops" });
  expect(errors.length).toBe(1);
  expect(errors[0].message).toBe("parse oops");
  expect(errors[0].fatal).toBeUndefined();
});

test("BrookClient.whenReady rejects and onError fires on a fatal init failure", async () => {
  const { pool, created } = makePool(1);
  const errors: Array<{ message: string; fatal?: boolean }> = [];
  const c = new BrookClient({ pool, onError: (e) => errors.push(e) });
  const ready = c.whenReady();
  created[0].fire({ type: "error", streamId: -1, message: "no WASM", fatal: true });
  await expect(ready).rejects.toThrow("no WASM");
  expect(errors.length).toBe(1);
  expect(errors[0].fatal).toBe(true);
});

test("a throwing stream handler can't break the fatal fan-out or the message loop", () => {
  const { pool, created } = makePool(1); // both streams share one worker
  let bNotified = false;
  pool.acquire(() => {
    throw new Error("handler boom"); // stream a's handler always throws
  });
  pool.acquire((m) => {
    if (m.type === "error" && m.fatal) bNotified = true; // stream b
  });
  // a throws, but the dispatch boundary isolates it: the fire must not throw and
  // b must still receive the fatal notification.
  expect(() =>
    created[0].fire({ type: "error", streamId: -1, message: "boom", fatal: true }),
  ).not.toThrow();
  expect(bNotified).toBe(true);
});

test("a fatally-failed worker is not re-picked by a new stream", () => {
  const { pool, created } = makePool(2);
  const s1 = pool.acquire(() => {});
  created[0].fire({ type: "error", streamId: -1, message: "dead", fatal: true });
  // A new stream must NOT land on the dead worker (it would post into it and hang).
  const s2 = pool.acquire(() => {});
  expect(s2.pw).not.toBe(s1.pw);
  expect(s2.pw.failed).toBeNull();
});

test("pipeFrom reads a stream, appends decoded chunks, and finalizes", async () => {
  const { pool, created } = makePool(1);
  const c = new BrookClient({ pool });
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(enc.encode("# Hi\n"));
      ctrl.enqueue(enc.encode("body text"));
      ctrl.close();
    },
  });
  await c.pipeFrom(stream);
  const sent = created[0].sent;
  const appends = sent
    .filter((m) => m.type === "append")
    .map((m) => (m as { chunk: string }).chunk)
    .join("");
  expect(appends).toContain("# Hi");
  expect(appends).toContain("body text");
  expect(sent.some((m) => m.type === "finalize")).toBe(true);
});

test("pipeFrom accepts a Response and finalizes an empty (null-body) one", async () => {
  const { pool, created } = makePool(1);
  const c = new BrookClient({ pool });
  // A Response-like with a null body (e.g. 204) → completed empty stream.
  await c.pipeFrom({ body: null } as unknown as Response);
  expect(created[0].sent.some((m) => m.type === "finalize")).toBe(true);
});

test("pipeFrom(AsyncIterable) appends each chunk in order and finalizes exactly once", async () => {
  const { pool, created } = makePool(1);
  const c = new BrookClient({ pool });
  async function* gen() {
    yield "a";
    yield "b";
    yield "c";
  }
  await c.pipeFrom(gen());
  const appends = created[0].sent
    .filter((m) => m.type === "append")
    .map((m) => (m as { chunk: string }).chunk);
  expect(appends).toEqual(["a", "b", "c"]);
  expect(created[0].sent.filter((m) => m.type === "finalize").length).toBe(1);
});

test("pipeFrom(AsyncIterable) with a pre-aborted signal appends nothing and never finalizes", async () => {
  const { pool, created } = makePool(1);
  const c = new BrookClient({ pool });
  const ac = new AbortController();
  ac.abort();
  async function* gen() {
    yield "a";
    yield "b";
  }
  await c.pipeFrom(gen(), { signal: ac.signal });
  // Lazy acquire: a pre-aborted pipeFrom returns before any worker-bound op, so
  // no worker is ever created — which trivially implies no append and no finalize.
  expect(created.length).toBe(0);
});

test("pipeFrom(AsyncIterable) aborted mid-stream stops appending and does not finalize", async () => {
  const { pool, created } = makePool(1);
  const c = new BrookClient({ pool });
  const ac = new AbortController();
  let openGate!: () => void;
  const gate = new Promise<void>((r) => (openGate = r));
  async function* gen() {
    yield "a";
    yield "b";
    await gate; // hold here until the test aborts + opens the gate
    yield "c";
  }
  const p = c.pipeFrom(gen(), { signal: ac.signal });
  await new Promise((r) => setTimeout(r, 0)); // let a, b append; loop now awaits the gate
  ac.abort();
  openGate();
  await p;
  const appends = created[0].sent
    .filter((m) => m.type === "append")
    .map((m) => (m as { chunk: string }).chunk);
  expect(appends).toEqual(["a", "b"]); // c is dropped by the post-abort guard
  expect(created[0].sent.some((m) => m.type === "finalize")).toBe(false);
});

test("pipeFrom(ReadableStream) aborted while stalled cancels the reader and does not finalize", async () => {
  const { pool, created } = makePool(1);
  const c = new BrookClient({ pool });
  const ac = new AbortController();
  let cancelled = false;
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(enc.encode("a")); // one chunk, then stall (never close)
    },
    cancel() {
      cancelled = true;
    },
  });
  const p = c.pipeFrom(stream, { signal: ac.signal });
  await new Promise((r) => setTimeout(r, 0)); // "a" appends; read() now pends
  ac.abort();
  await p;
  expect(cancelled).toBe(true); // abort listener cancelled the reader
  const appends = created[0].sent
    .filter((m) => m.type === "append")
    .map((m) => (m as { chunk: string }).chunk)
    .join("");
  expect(appends).toContain("a");
  expect(created[0].sent.some((m) => m.type === "finalize")).toBe(false);
});

test("onBlock fires once per committed block in document order, not for the active tail", () => {
  const { pool, created } = makePool(1);
  const got: number[] = [];
  const c = new BrookClient({ pool, onBlock: (b) => got.push(b.id) });
  c.append("x");
  const sid = (created[0].sent[0] as { streamId: number }).streamId;
  const blk = (id: number): Block => ({
    id, kind: { type: "Paragraph" }, start: 0, end: 0, html: "<p></p>", open: false, speculative: false,
  });
  created[0].fire({
    type: "patch", streamId: sid,
    patch: JSON.stringify({ newly_committed: [blk(1), blk(2)], active: [blk(3)] }),
    appendedBytes: 0, parseMicros: 0, retainedBytes: 0, wasmMemoryBytes: 0,
  });
  expect(got).toEqual([1, 2]); // committed in order; the active block (3) does not fire
});

test("reattach() re-sends config on the next append (the worker discards it on dispose)", () => {
  const { pool, created } = makePool(1);
  const c = new BrookClient({ pool, config: { gfmMath: true } });
  c.append("x"); // first message carries config
  c.destroy(); // posts dispose → the worker deletes the stored config
  c.reattach(); // StrictMode remount of the same client
  c.append("y"); // must re-send config, since the worker dropped it on dispose
  const withConfig = created[0].sent.filter(
    (m) => m.type === "append" && (m as { config?: unknown }).config !== undefined,
  );
  expect(withConfig.length).toBe(2); // the first append AND the post-reattach one
});

test("release frees the stream slot, sends dispose, keeps the worker warm", () => {
  const { pool, created } = makePool(4);
  const s = pool.acquire(() => {});
  expect(pool.workerCount).toBe(1);
  pool.release(s.streamId, s.pw);
  expect(created[0].sent).toContainEqual({ type: "dispose", streamId: s.streamId });
  expect(pool.workerCount).toBe(1); // worker stays alive
  // A subsequent stream reuses the warm (now-idle) worker rather than spawning.
  const s2 = pool.acquire(() => {});
  expect(s2.pw).toBe(s.pw);
  expect(pool.workerCount).toBe(1);
  // After release, messages for the freed stream are dropped (no handler).
  created[0].fire({
    type: "patch", streamId: s.streamId, patch: JSON.stringify({ newly_committed: [], active: [] }),
    appendedBytes: 0, parseMicros: 0, retainedBytes: 0, wasmMemoryBytes: 0,
  });
  // (No throw = pass; the handler map no longer has streamId.)
});

test("send routes a message to the stream's worker", () => {
  const { pool, created } = makePool(2);
  const s = pool.acquire(() => {});
  pool.send(s.pw, { type: "append", streamId: s.streamId, chunk: "hi" });
  expect(created[0].sent).toContainEqual({ type: "append", streamId: s.streamId, chunk: "hi" });
});

test("disposeAll terminates every worker", () => {
  const { pool, created } = makePool(4);
  pool.acquire(() => {});
  pool.acquire(() => {});
  expect(created.length).toBe(2);
  pool.disposeAll();
  expect(created.every((w) => w.terminated)).toBe(true);
  expect(pool.workerCount).toBe(0);
});

test("simulates 50 streams over an 8-worker cap (~6 each)", () => {
  const { pool } = makePool(8);
  for (let i = 0; i < 50; i++) pool.acquire(() => {});
  expect(pool.workerCount).toBe(8);
});

test("parser config rides only on a stream's first message", () => {
  const { pool, created } = makePool(2);
  const c = new BrookClient({ pool, config: { unsafeHtml: true, gfmAlerts: false, gfmFootnotes: true } });
  c.append("a");
  c.append("b");
  c.finalize();
  const withCfg = created[0].sent.filter((m) => (m as any).config !== undefined);
  expect(withCfg.length).toBe(1); // exactly the first message
  expect((withCfg[0] as any).config).toEqual({ unsafeHtml: true, gfmAlerts: false, gfmFootnotes: true });
});

test("no config → no config field on any message (worker uses defaults)", () => {
  const { pool, created } = makePool(2);
  const c = new BrookClient({ pool });
  c.append("a");
  c.finalize();
  expect(created[0].sent.every((m) => (m as any).config === undefined)).toBe(true);
});

test("outline() and toPlaintext() derive from the streamed snapshot", () => {
  const { pool, created } = makePool(1);
  const c = new BrookClient({ pool });
  c.append("x"); // wire the worker + discover the stream id
  const sid = (created[0].sent[0] as { streamId: number }).streamId;

  const heading = (id: number, level: number, text: string): Block => ({
    id, kind: { type: "Heading", data: level }, start: 0, end: 0,
    html: `<h${level}>${text}</h${level}>`, open: false, speculative: false,
  });
  const para = (id: number, html: string): Block => ({
    id, kind: { type: "Paragraph" }, start: 0, end: 0, html, open: false, speculative: false,
  });

  created[0].fire({
    type: "patch", streamId: sid,
    patch: JSON.stringify({
      newly_committed: [
        heading(1, 1, "Title"),
        para(2, "<p>Hello &amp; <strong>world</strong></p>"),
        heading(3, 2, "Sub"),
      ],
      active: [],
    }),
    appendedBytes: 0, parseMicros: 0, retainedBytes: 0, wasmMemoryBytes: 0,
  });

  expect(c.outline()).toEqual([
    { level: 1, text: "Title", id: 1 },
    { level: 2, text: "Sub", id: 3 },
  ]);
  expect(c.toPlaintext()).toBe("Title\n\nHello & world\n\nSub");
});

test("default constructor still joins a pool and streams (no behavior change)", () => {
  const { pool, created } = makePool(2);
  const c = new BrookClient({ pool });
  c.append("hello");
  expect(created[0].sent[0]).toMatchObject({ type: "append", chunk: "hello" });
});

test("warm() eagerly creates a worker and resolves once it is ready", async () => {
  const { pool, created } = makePool(8);
  let warmed = false;
  const p = pool.warm().then(() => {
    warmed = true;
  });
  expect(created.length).toBe(1); // worker built immediately → WASM init starts now
  expect(warmed).toBe(false); // but warm() awaits readiness
  created[0].fire({ type: "ready" });
  await p;
  expect(warmed).toBe(true);
});

test("warm() reuses a live worker instead of stacking new ones", () => {
  const { pool, created } = makePool(8);
  pool.warm();
  pool.warm();
  expect(created.length).toBe(1);
});

test("the first stream attaches to the warm worker (init is not wasted)", () => {
  const { pool, created } = makePool(8);
  pool.warm();
  pool.acquire(() => {}); // first real stream
  expect(created.length).toBe(1); // reused the warm worker, no new one
  expect(pool.workerCount).toBe(1);
});

test("warm() on a pool whose only worker died fatally builds a fresh one", () => {
  const { pool, created } = makePool(8);
  const s = pool.acquire(() => {});
  created[0].fire({ type: "error", streamId: -1, message: "dead", fatal: true });
  expect(s.pw.failed).not.toBeNull();
  pool.warm(); // must not hand back the dead worker
  expect(created.length).toBe(2);
});

test("a fatally-failed worker is terminated and reaped, so repeated failures never bypass the cap", () => {
  const { pool, created } = makePool(2);
  // Each failure must terminate + drop the worker (not retain it). Without
  // reaping, failed workers accumulate, `cap` is exceeded, and the pool spawns a
  // new Worker per stream forever.
  for (let i = 0; i < 5; i++) {
    pool.acquire(() => {});
    const w = created[created.length - 1];
    w.fire({ type: "error", streamId: -1, message: "dead", fatal: true });
    expect(w.terminated).toBe(true); // evicted
    expect(pool.workerCount).toBe(0); // reaped — not leaked
  }
  expect(created.length).toBe(5); // 5 distinct workers made, each reaped
  expect(pool.workerCount).toBe(0);
});

test("reset() drops a straggler patch from the previous generation (no ghost blocks)", () => {
  const { pool, created } = makePool(1);
  const c = new BrookClient({ pool });
  c.append("a"); // acquire worker + stream id (epoch 0)
  const w = created[0];
  const sid = (w.sent.find((m) => m.type === "append") as { streamId: number }).streamId;
  const mkPatch = (epoch: number, id: number, html: string): FromWorker => ({
    type: "patch",
    streamId: sid,
    patch: JSON.stringify({
      newly_committed: [{ id, kind: { type: "Paragraph" }, start: 0, end: html.length, html, open: false, speculative: false }],
      active: [],
    }),
    appendedBytes: 0, parseMicros: 0, retainedBytes: 0, wasmMemoryBytes: 0, epoch,
  });

  w.fire(mkPatch(0, 0, "<p>old</p>"));
  expect(c.getSnapshot().length).toBe(1);

  c.reset(); // clears the store and bumps the generation → epoch 1
  expect(c.getSnapshot().length).toBe(0);

  // A patch the worker emitted for the PRE-reset content (epoch 0), still in
  // flight when reset() ran, must be dropped — not re-added as a ghost block.
  w.fire(mkPatch(0, 1, "<p>ghost</p>"));
  expect(c.getSnapshot().length).toBe(0);

  // A patch from the new generation applies normally.
  w.fire(mkPatch(1, 0, "<p>new</p>"));
  expect(c.getSnapshot().map((b) => b.html)).toEqual(["<p>new</p>"]);
});

// --------------------------------------------------------------------------
// Worker-lifecycle failure detection + recovery
// --------------------------------------------------------------------------

const blk = (id: number, html: string): Block => ({
  id, kind: { type: "Paragraph" }, start: 0, end: 0, html, open: false, speculative: false,
});
const patchMsg = (streamId: number, id: number, html: string): FromWorker => ({
  type: "patch", streamId, patch: JSON.stringify({ newly_committed: [blk(id, html)], active: [] }),
  appendedBytes: 0, parseMicros: 0, retainedBytes: 0, wasmMemoryBytes: 0,
});
const appendedTo = (w: FakeWorker) =>
  w.sent.filter((m): m is Extract<ToWorker, { type: "append" }> => m.type === "append").map((m) => m.chunk).join("");
// The stream id of a worker's first append — how a test discovers the id the
// lazily-acquired client bound to.
const firstSid = (w: FakeWorker) =>
  (w.sent.find((m) => m.type === "append") as { streamId: number }).streamId;

test("a DOM error event before ready rejects waiters, fires a fatal onError, and reaps the worker", async () => {
  const { pool, created } = makePool(2, { bootTimeoutMs: 0 });
  const got: FromWorker[] = [];
  const s = pool.acquire((m) => got.push(m));
  const ready = pool.whenWorkerReady(s.pw);
  // The browser fires a DOM `error` when `new Worker(staleUrl)`'s script 404s —
  // never an in-band `message`, so only the pool's error listener catches it.
  created[0].fireError({ message: "404 not found" });
  await expect(ready).rejects.toThrow(/failed to load/);
  expect(got.at(-1)).toMatchObject({ type: "error", fatal: true });
  expect((got.at(-1) as { message: string }).message).toContain("404 not found");
  expect(created[0].terminated).toBe(true);
  expect(pool.workerCount).toBe(0); // reaped
  // A subsequent acquire lands on a FRESH worker, not the dead one.
  const s2 = pool.acquire(() => {});
  expect(s2.pw).not.toBe(s.pw);
  expect(s2.pw.failed).toBeNull();
  expect(created.length).toBe(2);
});

test("a messageerror is handled like a fatal failure (reject, fatal onError, reap)", async () => {
  const { pool, created } = makePool(1, { bootTimeoutMs: 0 });
  const got: FromWorker[] = [];
  const s = pool.acquire((m) => got.push(m));
  const ready = pool.whenWorkerReady(s.pw);
  created[0].fireMessageError();
  await expect(ready).rejects.toThrow(/deserial/);
  expect(got.at(-1)).toMatchObject({ type: "error", fatal: true });
  expect(created[0].terminated).toBe(true);
  expect(pool.workerCount).toBe(0);
});

test("the boot deadline fails a worker that never reports ready", async () => {
  const timers = makeFakeTimers();
  const { pool, created } = makePool(1, {
    bootTimeoutMs: 5000, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  const got: FromWorker[] = [];
  const s = pool.acquire((m) => got.push(m));
  const ready = pool.whenWorkerReady(s.pw);
  expect(timers.armed).toBe(1); // deadline armed on create
  timers.flush(); // the deadline elapses with no ready in sight
  await expect(ready).rejects.toThrow(/did not become ready within 5000ms/);
  expect(got.at(-1)).toMatchObject({ type: "error", fatal: true });
  expect(created[0].terminated).toBe(true);
  expect(pool.workerCount).toBe(0);
});

test("reporting ready before the deadline cancels the boot timer", () => {
  const timers = makeFakeTimers();
  const { pool, created } = makePool(1, {
    bootTimeoutMs: 5000, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  pool.acquire(() => {});
  expect(timers.armed).toBe(1);
  created[0].fire({ type: "ready" });
  expect(timers.armed).toBe(0); // cancelled on ready
  timers.flush(); // nothing left to fire — the worker stays live
  expect(created[0].terminated).toBe(false);
  expect(pool.workerCount).toBe(1);
});

test("bootTimeoutMs: 0 disables the boot deadline entirely", () => {
  const timers = makeFakeTimers();
  const { pool, created } = makePool(1, {
    bootTimeoutMs: 0, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  pool.acquire(() => {});
  expect(timers.armed).toBe(0); // no timer armed at all
  timers.flush();
  expect(created[0].terminated).toBe(false);
  expect(pool.workerCount).toBe(1);
});

test("multiple failure triggers (DOM error, fatal message, late deadline) fail the worker exactly once", async () => {
  // A no-op clearTimeout keeps the deadline callback "live" so we can prove that
  // firing it AFTER the worker already failed is a no-op (the callback's own
  // ready/failed guard) — on top of fail()'s first-cause-wins idempotence.
  const deadlines: Array<() => void> = [];
  const { pool, created } = makePool(1, {
    bootTimeoutMs: 5000,
    setTimeout: (fn) => (deadlines.push(fn), deadlines.length),
    clearTimeout: () => {},
  });
  const got: FromWorker[] = [];
  const s = pool.acquire((m) => got.push(m));
  const ready = pool.whenWorkerReady(s.pw);
  const w = created[0];
  w.fireError({ message: "first" }); // first cause wins
  w.fire({ type: "error", streamId: -1, message: "second", fatal: true }); // no-op
  for (const fn of deadlines) fn(); // late deadline fires — guarded no-op
  await expect(ready).rejects.toThrow(/failed to load: first/);
  const fatals = got.filter((m) => m.type === "error" && (m as { fatal?: boolean }).fatal);
  expect(fatals.length).toBe(1); // onError fired exactly once
  expect((fatals[0] as { message: string }).message).toContain("first");
  expect(w.terminateCount).toBe(1); // terminated exactly once
});

test("a setContent client recovers from a transient worker death by re-feeding the document", async () => {
  const { pool, created } = makePool(2, { bootTimeoutMs: 0 });
  const errors: Array<{ message: string; fatal?: boolean }> = [];
  const c = new BrookClient({ pool, onError: (e) => errors.push(e) });
  c.setContent("# A\n\nbody"); // drives worker A via setContent (retains the doc)
  const a = created[0];
  const sidA = firstSid(a);
  a.fire(patchMsg(sidA, 1, "<p>body</p>")); // A renders content
  expect(c.getSnapshot().length).toBe(1);
  const handlersBefore = pool.handlerCount; // one live stream

  a.fireError({ message: "boom" }); // A dies (stale worker URL)
  expect(a.terminated).toBe(true);
  expect(pool.workerCount).toBe(0); // A reaped
  await Promise.resolve(); // let the deferred recovery microtask run

  // A fresh worker B was acquired and re-fed the WHOLE retained document.
  expect(created.length).toBe(2);
  const b = created[1];
  expect(b.sent.map((m) => m.type)).toContain("append");
  expect(appendedTo(b)).toContain("# A\n\nbody");
  // The death healed invisibly: no onError, `failed` stayed null.
  expect(errors.length).toBe(0);
  expect(c.failed).toBeNull();
  // The dead worker's handler entry was reaped — the map didn't grow across the
  // heal (the leak that grew the process-wide default pool unbounded).
  expect(pool.handlerCount).toBe(handlersBefore);

  // B produces output → the view converges and stays healthy.
  const sidB = firstSid(b);
  b.fire(patchMsg(sidB, 1, "<p>body</p>"));
  expect(c.getSnapshot().length).toBeGreaterThan(0);
  expect(c.failed).toBeNull();
});

test("an identical re-fed document terminals after exactly one retry (no infinite recovery loop)", async () => {
  const { pool, created } = makePool(3, { bootTimeoutMs: 0 });
  const errors: Array<{ message: string; fatal?: boolean }> = [];
  const c = new BrookClient({ pool, onError: (e) => errors.push(e) });
  c.setContent("# A\n\nbody");
  const a = created[0];
  const sidA = firstSid(a);
  a.fire(patchMsg(sidA, 1, "<p>body</p>"));

  a.fireError({ message: "die 1" }); // first death → recovery re-feeds the doc
  await Promise.resolve();
  expect(created.length).toBe(2);
  const b = created[1];
  // The re-fed worker produces its append patch (as a finalize()-that-traps doc
  // would) — this must NOT re-arm recovery.
  const sidB = firstSid(b);
  b.fire(patchMsg(sidB, 1, "<p>body</p>"));
  expect(c.failed).toBeNull(); // healed so far

  // B dies again with UNCHANGED content → terminal, no third worker.
  b.fireError({ message: "die 2" });
  await Promise.resolve();
  expect(created.length).toBe(2); // no worker C — the poison doc didn't loop
  expect(c.failed).not.toBeNull();
  expect(errors.some((e) => e.fatal)).toBe(true);
});

test("a recovered client heals AGAIN once the caller advances the content", async () => {
  const { pool, created } = makePool(4, { bootTimeoutMs: 0 });
  const errors: Array<{ message: string; fatal?: boolean }> = [];
  const c = new BrookClient({ pool, onError: (e) => errors.push(e) });
  c.setContent("# A\n\nbody");
  const a = created[0];
  const sidA = firstSid(a);
  a.fire(patchMsg(sidA, 1, "<p>body</p>"));

  a.fireError({ message: "die 1" }); // death 1 → recover onto B
  await Promise.resolve();
  expect(created.length).toBe(2);
  const b = created[1];
  const sidB = firstSid(b);
  b.fire(patchMsg(sidB, 1, "<p>body</p>")); // B heals

  // Caller advances the controlled string past the recovered baseline → re-arms.
  c.setContent("# A\n\nbody more");
  expect(appendedTo(b)).toContain(" more"); // the delta went to B

  // B now dies too — but because the content advanced, recovery heals AGAIN.
  b.fireError({ message: "die 2" });
  await Promise.resolve();
  expect(created.length).toBe(3); // worker C acquired — healed again
  expect(appendedTo(created[2])).toContain("# A\n\nbody more"); // full doc re-fed
  expect(c.failed).toBeNull();
  expect(errors.length).toBe(0);
});

test("a setContent client does NOT retry a second time if the replacement worker also dies", async () => {
  const { pool, created } = makePool(2, { bootTimeoutMs: 0 });
  const errors: Array<{ message: string; fatal?: boolean }> = [];
  const c = new BrookClient({ pool, onError: (e) => errors.push(e) });
  c.setContent("# A\n\nbody");
  const a = created[0];
  const sidA = firstSid(a);
  a.fire(patchMsg(sidA, 1, "<p>body</p>"));

  a.fireError({ message: "die 1" }); // first death → recovery
  await Promise.resolve();
  expect(created.length).toBe(2);
  const b = created[1];

  // B dies BEFORE producing any patch, so recovery is not re-armed → terminal.
  b.fireError({ message: "die 2" });
  await Promise.resolve();
  expect(created.length).toBe(2); // NO third worker — no infinite retry loop
  expect(c.failed).not.toBeNull();
  expect(errors.some((e) => e.fatal)).toBe(true); // surfaced this time
});

test("`failed` transitions null → Error → null across a terminal failure and a reset", () => {
  const { pool, created } = makePool(2, { bootTimeoutMs: 0 });
  // recovery:false → a fatal is immediately terminal (no buffer, no re-feed),
  // which is exactly what makes the failed-getter transition observable here.
  const c = new BrookClient({ pool, recovery: false });
  c.append("x");
  expect(c.failed).toBeNull();
  created[0].fire({ type: "error", streamId: -1, message: "dead", fatal: true });
  expect(c.failed).not.toBeNull();
  expect(c.failed?.message).toBe("dead");

  c.reset(); // explicit caller reset clears the failure + re-arms recovery
  expect(c.failed).toBeNull();
  c.append("y");
  expect(created.length).toBe(2); // a fresh worker was acquired
  const b = created[1];
  const sidB = firstSid(b);
  b.fire(patchMsg(sidB, 1, "<p>y</p>"));
  expect(c.failed).toBeNull();
  expect(c.getSnapshot().length).toBeGreaterThan(0);
});

// --------------------------------------------------------------------------
// Append / pipeFrom-mode recovery (buffer-driven, default-on)
// --------------------------------------------------------------------------

test("append-mode recovers by re-feeding the accumulated buffer", async () => {
  const { pool, created } = makePool(2, { bootTimeoutMs: 0 });
  const errors: Array<{ message: string; fatal?: boolean }> = [];
  const c = new BrookClient({ pool, onError: (e) => errors.push(e) });
  c.append("# A\n");
  c.append("body"); // buffer = "# A\nbody"
  const a = created[0];
  a.fire(patchMsg(firstSid(a), 1, "<p>body</p>"));

  a.fireError({ message: "boom" });
  await Promise.resolve();
  expect(created.length).toBe(2);
  // The fresh worker got the FULL concatenation as one atomic re-feed.
  expect(appendedTo(created[1])).toContain("# A\nbody");
  expect(c.failed).toBeNull();
  expect(errors.length).toBe(0);
});

test("append-mode recovery keeps the view on screen (never blanks)", async () => {
  const { pool, created } = makePool(2, { bootTimeoutMs: 0 });
  const c = new BrookClient({ pool });
  c.append("hello");
  const a = created[0];
  a.fire(patchMsg(firstSid(a), 1, "<p>hello</p>"));
  expect(c.getSnapshot().length).toBe(1);

  a.fireError({ message: "boom" });
  expect(c.getSnapshot().length).toBe(1); // holds while recovery is pending
  await Promise.resolve();
  expect(c.getSnapshot().length).toBe(1); // softReset preserved it across the swap
  expect(c.failed).toBeNull();
});

test("append-mode does NOT retry twice when the replacement also dies", async () => {
  const { pool, created } = makePool(3, { bootTimeoutMs: 0 });
  const errors: Array<{ message: string; fatal?: boolean }> = [];
  const c = new BrookClient({ pool, onError: (e) => errors.push(e) });
  c.append("hello");
  const a = created[0];
  a.fire(patchMsg(firstSid(a), 1, "<p>hello</p>"));

  a.fireError({ message: "die 1" });
  await Promise.resolve();
  expect(created.length).toBe(2);
  created[1].fireError({ message: "die 2" }); // replacement dies before healing
  await Promise.resolve();
  expect(created.length).toBe(2); // no third worker
  expect(c.failed).not.toBeNull();
  expect(errors.filter((e) => e.fatal).length).toBe(1); // fatal onError exactly once
});

test("append-mode re-arms recovery once the buffer grows past the recovered length", async () => {
  const { pool, created } = makePool(4, { bootTimeoutMs: 0 });
  const errors: Array<{ message: string; fatal?: boolean }> = [];
  const c = new BrookClient({ pool, onError: (e) => errors.push(e) });
  c.append("hello");
  const a = created[0];
  a.fire(patchMsg(firstSid(a), 1, "<p>hello</p>"));

  a.fireError({ message: "die 1" }); // → recover onto B
  await Promise.resolve();
  expect(created.length).toBe(2);
  const b = created[1];
  b.fire(patchMsg(firstSid(b), 1, "<p>hello</p>")); // B heals

  c.append(" more"); // buffer "hello more" grows past recovered length → re-arm

  b.fireError({ message: "die 2" }); // dies again — but re-armed, so heals AGAIN
  await Promise.resolve();
  expect(created.length).toBe(3);
  expect(appendedTo(created[2])).toContain("hello more"); // full grown buffer re-fed
  expect(c.failed).toBeNull();
  expect(errors.length).toBe(0);
});

test("a stray append before the recovery microtask converges (old-epoch patch dropped, no dup)", async () => {
  const { pool, created } = makePool(3, { bootTimeoutMs: 0 });
  const c = new BrookClient({ pool });
  c.append("AB");
  const a = created[0];
  a.fire(patchMsg(firstSid(a), 1, "<p>AB</p>"));

  a.fireError({ message: "boom" }); // schedule recovery (not yet run)
  c.append("C"); // stray pipeFrom chunk lands first, on a fresh worker at the OLD epoch
  await Promise.resolve(); // now the recovery microtask runs

  const b = created[1];
  const strayAppend = b.sent.find((m) => m.type === "append" && m.chunk === "C") as
    | (ToWorker & { epoch?: number; streamId: number })
    | undefined;
  const resetMsg = b.sent.find((m) => m.type === "reset");
  const fullAppend = b.sent.find((m) => m.type === "append" && m.chunk === "ABC") as
    | (ToWorker & { epoch?: number; streamId: number })
    | undefined;
  expect(strayAppend).toBeDefined();
  expect(resetMsg).toBeDefined();
  expect(fullAppend).toBeDefined();
  // Ordering: append(stray) → reset → append(full).
  expect(b.sent.indexOf(strayAppend!)).toBeLessThan(b.sent.indexOf(resetMsg!));
  expect(b.sent.indexOf(resetMsg!)).toBeLessThan(b.sent.indexOf(fullAppend!));
  // The stray rode the pre-reset epoch; the re-feed rode the bumped one.
  const strayEpoch = strayAppend!.epoch!;
  const fullEpoch = fullAppend!.epoch!;
  expect(strayEpoch).toBeLessThan(fullEpoch);

  // The stray's old-epoch patch is dropped; the recovered new-epoch patch lands.
  const sidB = fullAppend!.streamId;
  b.fire({
    type: "patch", streamId: sidB, epoch: strayEpoch,
    patch: JSON.stringify({ newly_committed: [blk(9, "<p>stray-ghost</p>")], active: [] }),
    appendedBytes: 0, parseMicros: 0, retainedBytes: 0, wasmMemoryBytes: 0,
  });
  b.fire({
    type: "patch", streamId: sidB, epoch: fullEpoch, final: true,
    patch: JSON.stringify({ newly_committed: [blk(1, "<p>ABC</p>")], active: [] }),
    appendedBytes: 0, parseMicros: 0, retainedBytes: 0, wasmMemoryBytes: 0,
  });
  const htmls = c.getSnapshot().map((x) => x.html);
  expect(htmls).not.toContain("<p>stray-ghost</p>"); // old-epoch straggler dropped
  expect(htmls).toContain("<p>ABC</p>"); // recovered content present, no missing prefix
});

test("append-mode death during finalize: one retry re-feeds+re-finalizes, a second trap is terminal", async () => {
  const { pool, created } = makePool(3, { bootTimeoutMs: 0 });
  const errors: Array<{ message: string; fatal?: boolean }> = [];
  const c = new BrookClient({ pool, onError: (e) => errors.push(e) });
  c.append("doc");
  c.finalize(); // contentDone = true
  const a = created[0];
  a.fire(patchMsg(firstSid(a), 1, "<p>doc</p>"));

  a.fireError({ message: "trap 1" }); // the finalize traps
  await Promise.resolve();
  expect(created.length).toBe(2);
  const b = created[1];
  expect(appendedTo(b)).toContain("doc"); // re-fed
  expect(b.sent.some((m) => m.type === "finalize")).toBe(true); // AND re-finalized

  b.fireError({ message: "trap 2" }); // the re-fed finalize traps too
  await Promise.resolve();
  expect(created.length).toBe(2); // no third worker
  expect(c.failed).not.toBeNull();
  expect(errors.some((e) => e.fatal)).toBe(true);
});

test("reset() clears the recovery buffer (a later death re-feeds nothing → terminal)", () => {
  const { pool, created } = makePool(2, { bootTimeoutMs: 0 });
  const errors: Array<{ message: string; fatal?: boolean }> = [];
  const c = new BrookClient({ pool, onError: (e) => errors.push(e) });
  c.append("old");
  c.reset(); // clears the buffer; the (live) worker A just gets a reset
  expect(created.length).toBe(1);
  created[0].fireError({ message: "boom" }); // buffer empty → immediate terminal
  expect(created.length).toBe(1); // no recovery worker spun up
  expect(c.failed).not.toBeNull();
  expect(errors.some((e) => e.fatal)).toBe(true);
});

test("recovery:false disables buffering + recovery in BOTH modes (immediate terminal)", async () => {
  // append mode
  const p1 = makePool(2, { bootTimeoutMs: 0 });
  const e1: Array<{ fatal?: boolean }> = [];
  const c1 = new BrookClient({ pool: p1.pool, recovery: false, onError: (e) => e1.push(e) });
  c1.append("hello");
  p1.created[0].fire(patchMsg(firstSid(p1.created[0]), 1, "<p>hello</p>"));
  p1.created[0].fireError({ message: "boom" });
  await Promise.resolve();
  expect(p1.created.length).toBe(1); // no re-feed worker
  expect(c1.failed).not.toBeNull();
  expect(e1.some((e) => e.fatal)).toBe(true);

  // setContent mode
  const p2 = makePool(2, { bootTimeoutMs: 0 });
  const e2: Array<{ fatal?: boolean }> = [];
  const c2 = new BrookClient({ pool: p2.pool, recovery: false, onError: (e) => e2.push(e) });
  c2.setContent("# A\n\nbody");
  p2.created[0].fire(patchMsg(firstSid(p2.created[0]), 1, "<p>body</p>"));
  p2.created[0].fireError({ message: "boom" });
  await Promise.resolve();
  expect(p2.created.length).toBe(1); // no re-feed worker
  expect(c2.failed).not.toBeNull();
  expect(e2.some((e) => e.fatal)).toBe(true);
});

test("destroy() during a pending recovery microtask acquires no worker", async () => {
  const { pool, created } = makePool(2, { bootTimeoutMs: 0 });
  const c = new BrookClient({ pool });
  c.append("hello");
  const a = created[0];
  a.fire(patchMsg(firstSid(a), 1, "<p>hello</p>"));

  a.fireError({ message: "boom" }); // schedules the recovery microtask
  c.destroy(); // torn down before it runs
  await Promise.resolve();
  expect(created.length).toBe(1); // recover() bailed on !attached — no new worker
});

test("after recovery a setContent client keeps its diff baseline (unchanged setContent is a no-op)", async () => {
  const { pool, created } = makePool(2, { bootTimeoutMs: 0 });
  const c = new BrookClient({ pool });
  c.setContent("# A\n\nbody");
  const a = created[0];
  a.fire(patchMsg(firstSid(a), 1, "<p>body</p>"));
  a.fireError({ message: "boom" });
  await Promise.resolve();
  const b = created[1];
  const appendsBefore = b.sent.filter((m) => m.type === "append").length;
  // A React re-render passes the SAME string: recovery restored lastContent, so
  // this diffs to nothing instead of forcing a wasteful whole-document re-feed.
  c.setContent("# A\n\nbody");
  const appendsAfter = b.sent.filter((m) => m.type === "append").length;
  expect(appendsAfter).toBe(appendsBefore);
});
