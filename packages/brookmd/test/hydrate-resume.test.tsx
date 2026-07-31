import { test, expect, beforeAll } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { GlobalWindow } from "happy-dom";
import { createElement, act } from "react";
import type { Root } from "react-dom/client";
import { BrookClient, BrookPool, sourceFingerprint, applyPatch, emptyBlockStore } from "../src/client";
import type { PersistableSnapshot } from "../src/client";
import { WorkerCore, type ParserLike } from "../src/worker-core";
import { mountBrookMarkdown } from "../src/dom";
import { BrookMarkdown } from "../src/react";
import type { Block, FromWorker, Patch, ToWorker, WorkerLike } from "../src/types";

/**
 * INSTANT THREAD REOPEN against the REAL parser.
 *
 * hydrate.test.ts pins the envelope and the guard rails with a FakeWorker; this
 * file proves the two things only real parsing can show:
 *
 *   PARITY — a hydrated mount is byte-identical to the live-streamed mount it
 *   was captured from, in BOTH renderers. Hydrated blocks are ordinary
 *   committed blocks; if they were not, the reopened thread would render subtly
 *   differently from the one the user closed.
 *
 *   CONVERGENCE — resuming a hydrated thread lands on the same document a
 *   never-hydrated continuous stream produces, over randomized chunkings and
 *   resume points, with the hydrated blocks keeping their ids across the swap
 *   (so nothing remounts when the background re-parse catches up).
 *
 * The client is driven end-to-end through a real `WorkerCore` + real
 * `BrookParser` running in-process — the production path with `postMessage`
 * replaced by a direct call, so message ordering, the readiness gate, epochs and
 * the recovery machinery are all the real ones.
 */

const wasmUrl = new URL("../src/wasm/brook_md_core_bg.wasm", import.meta.url);
const haveWasm = existsSync(wasmUrl);

if (!haveWasm) {
  // eslint-disable-next-line no-console
  console.warn("[hydrate-resume] src/wasm not built — run `bun run build:wasm`; skipping.");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let wasm: any;
let createRoot: (c: Element) => Root;

beforeAll(async () => {
  const win = new GlobalWindow();
  const g = globalThis as Record<string, unknown>;
  g.document = win.document;
  g.window = win;
  g.navigator = win.navigator;
  g.HTMLElement = win.HTMLElement;
  g.Element = win.Element;
  g.Node = win.Node;
  (g as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ createRoot } = await import("react-dom/client"));
  if (!haveWasm) return;
  const glue = "../src/wasm/brook_md_core.js"; // runtime specifier: no collection-time failure
  wasm = await import(glue);
  wasm.initSync({ module: readFileSync(wasmUrl) });
});

// ── In-process worker: the real WorkerCore over the real BrookParser ───────

class InProcWorker implements WorkerLike {
  private core: WorkerCore;
  private listener: ((ev: { data: FromWorker }) => void) | null = null;
  constructor() {
    this.core = new WorkerCore({
      makeParser: (): ParserLike => {
        const p = new wasm.BrookParser();
        p.setWireDelta(true);
        return p as ParserLike;
      },
      post: (msg) => this.listener?.({ data: msg }),
      memBytes: () => 0,
      schedule: (fn) => queueMicrotask(fn),
    });
    // The pool registers its listener right after the factory returns, so open
    // the readiness gate one microtask later — exactly the real ordering, where
    // WASM init resolves after the worker script has wired itself up.
    queueMicrotask(() => this.core.markReady());
  }
  postMessage(msg: ToWorker) {
    this.core.handle(msg);
  }
  addEventListener(t: string, l: (ev: { data: FromWorker }) => void) {
    if (t === "message") this.listener = l;
  }
  terminate() {}
}

function wasmPool(): BrookPool {
  return new BrookPool(() => new InProcWorker(), 4, { bootTimeoutMs: 0 });
}

/** Let every queued flush + patch land. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

// ── Corpus ─────────────────────────────────────────────────────────────────

const DOC = [
  "# Reopening a thread",
  "",
  "A paragraph with **bold**, _italic_, `code` and a [link](https://example.com).",
  "",
  "## Code",
  "",
  "```ts",
  "export function add(a: number, b: number): number {",
  "  return a + b; // a comment",
  "}",
  "```",
  "",
  "- first item",
  "- second item with `inline`",
  "- third item",
  "",
  "1. ordered one",
  "2. ordered two",
  "",
  "| col a | col b |",
  "| --- | ---: |",
  "| 1 | 2 |",
  "| 3 | 4 |",
  "",
  "> A blockquote with **emphasis**.",
  "",
  "---",
  "",
  "Trailing prose after a rule, with an autolink https://example.org and text.",
  "",
  "### Deeper heading",
  "",
  "Final paragraph of the thread.",
  "",
].join("\n");

/** Deterministic PRNG so a failing seed is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function chunkify(s: string, rnd: () => number): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    const n = 1 + Math.floor(rnd() * 40);
    out.push(s.slice(i, i + n));
    i += n;
  }
  return out;
}

/** The comparable shape of a rendered document: content and state, not ids
 *  (ids are chunk-dependent in a live stream — see the id note below). */
function shape(blocks: Block[]) {
  return blocks.map((b) => ({
    html: b.html,
    type: b.kind.type,
    open: b.open,
    speculative: b.speculative,
  }));
}

/** Stream `chunks` into a fresh client and settle. */
async function streamAll(pool: BrookPool, chunks: string[], done = true): Promise<BrookClient> {
  const c = new BrookClient({ pool });
  for (const ch of chunks) c.append(ch);
  if (done) c.finalize();
  await settle();
  return c;
}

const IT = haveWasm ? test : test.skip;

// ── PARITY: a hydrated mount is the live mount ─────────────────────────────

IT("DOM renderer: a hydrated mount is byte-identical to the live-streamed mount", async () => {
  const pool = wasmPool();
  const live = await streamAll(pool, chunkify(DOC, mulberry32(1)));

  const hostA = document.createElement("div");
  const a = mountBrookMarkdown(live, hostA as unknown as HTMLElement, { batch: false });
  const liveHtml = hostA.innerHTML;
  expect(liveHtml.length).toBeGreaterThan(200); // the corpus really rendered

  const wire = JSON.stringify(live.getPersistable());
  const reopened = new BrookClient({ pool });
  reopened.hydrate(JSON.parse(wire) as PersistableSnapshot);

  const hostB = document.createElement("div");
  const b = mountBrookMarkdown(reopened, hostB as unknown as HTMLElement, { batch: false });

  // Hydrated blocks are ORDINARY committed blocks — the renderer cannot tell
  // where they came from, and the reopened thread renders what the user closed.
  expect(hostB.innerHTML).toBe(liveHtml);
  a.destroy();
  b.destroy();
});

IT("React renderer: a hydrated mount is byte-identical to the live-streamed mount", async () => {
  const pool = wasmPool();
  const live = await streamAll(pool, chunkify(DOC, mulberry32(2)));

  const hostA = document.createElement("div");
  const rootA = createRoot(hostA as never);
  await act(async () => {
    rootA.render(createElement(BrookMarkdown, { client: live }));
  });
  const liveHtml = (hostA as unknown as { innerHTML: string }).innerHTML;
  expect(liveHtml.length).toBeGreaterThan(200);

  const wire = JSON.stringify(live.getPersistable());
  const reopened = new BrookClient({ pool });
  reopened.hydrate(JSON.parse(wire) as PersistableSnapshot);

  const hostB = document.createElement("div");
  const rootB = createRoot(hostB as never);
  await act(async () => {
    rootB.render(createElement(BrookMarkdown, { client: reopened }));
  });

  expect((hostB as unknown as { innerHTML: string }).innerHTML).toBe(liveHtml);
  await act(async () => {
    rootA.unmount();
    rootB.unmount();
  });
});

IT("a mid-stream (unfinalized) snapshot also re-mounts identically", async () => {
  const pool = wasmPool();
  const chunks = chunkify(DOC, mulberry32(3));
  const cut = Math.floor(chunks.length * 0.6);
  const live = await streamAll(pool, chunks.slice(0, cut), false);

  const hostA = document.createElement("div");
  const a = mountBrookMarkdown(live, hostA as unknown as HTMLElement, { batch: false });

  const snapshot = live.getPersistable();
  expect(snapshot.done).toBe(false); // still streaming — the open tail is captured too
  const reopened = new BrookClient({ pool });
  reopened.hydrate(JSON.parse(JSON.stringify(snapshot)) as PersistableSnapshot);

  const hostB = document.createElement("div");
  const b = mountBrookMarkdown(reopened, hostB as unknown as HTMLElement, { batch: false });
  expect(hostB.innerHTML).toBe(hostA.innerHTML);
  a.destroy();
  b.destroy();
});

// ── RESUME: convergence with a never-hydrated continuous stream ────────────

IT("resume converges on the continuous stream's document, over chunkings and cut points", async () => {
  const pool = wasmPool();
  let cases = 0;

  for (let seed = 1; seed <= 12; seed++) {
    const chunks = chunkify(DOC, mulberry32(seed * 97));
    // A cut somewhere in the interior: enough history to matter, enough tail to
    // still be streaming.
    const cut = 1 + Math.floor((chunks.length - 2) * ((seed % 5) + 1) / 6);
    const prefix = chunks.slice(0, cut).join("");

    // The control: one uninterrupted stream, never hydrated.
    const cont = await streamAll(pool, chunks);
    const control = cont.getSnapshot();

    // Close the thread mid-stream and persist it.
    const before = new BrookClient({ pool });
    for (const ch of chunks.slice(0, cut)) before.append(ch);
    await settle();
    const wire = JSON.stringify(before.getPersistable());
    const hydratedIds = before.getSnapshot().map((b) => b.id);
    before.destroy();

    // Reopen it and keep streaming.
    const after = new BrookClient({ pool });
    after.hydrate(JSON.parse(wire) as PersistableSnapshot, { source: prefix });
    for (const ch of chunks.slice(cut)) after.append(ch);
    after.finalize();
    await settle();
    const resumed = after.getSnapshot();

    expect(shape(resumed)).toEqual(shape(control));

    // Ids must be unique (they are React keys / DOM node keys)...
    const ids = resumed.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    // ...and every block that was already on screen keeps the id it was
    // hydrated with, so the background catch-up swaps in without remounting a
    // single block the reader is looking at.
    expect(ids.slice(0, hydratedIds.length)).toEqual(hydratedIds);
    cases++;
  }
  expect(cases).toBe(12);
});

IT("resume renders the same DOM a continuous stream would have", async () => {
  const pool = wasmPool();
  const chunks = chunkify(DOC, mulberry32(41));
  const cut = Math.floor(chunks.length / 2);
  const prefix = chunks.slice(0, cut).join("");

  const cont = await streamAll(pool, chunks);
  const hostA = document.createElement("div");
  const a = mountBrookMarkdown(cont, hostA as unknown as HTMLElement, { batch: false });

  const before = new BrookClient({ pool });
  for (const ch of chunks.slice(0, cut)) before.append(ch);
  await settle();
  const wire = JSON.stringify(before.getPersistable());
  before.destroy();

  const after = new BrookClient({ pool });
  after.hydrate(JSON.parse(wire) as PersistableSnapshot, { source: prefix });
  const hostB = document.createElement("div");
  const b = mountBrookMarkdown(after, hostB as unknown as HTMLElement, { batch: false });
  for (const ch of chunks.slice(cut)) after.append(ch);
  after.finalize();
  await settle();

  expect(hostB.innerHTML).toBe(hostA.innerHTML);
  a.destroy();
  b.destroy();
});

IT("a resumed thread can be persisted and hydrated again", async () => {
  const pool = wasmPool();
  const chunks = chunkify(DOC, mulberry32(7));
  const cut = Math.floor(chunks.length / 3);
  const prefix = chunks.slice(0, cut).join("");

  const before = new BrookClient({ pool });
  for (const ch of chunks.slice(0, cut)) before.append(ch);
  await settle();
  const first = JSON.stringify(before.getPersistable());

  const after = new BrookClient({ pool });
  after.hydrate(JSON.parse(first) as PersistableSnapshot, { source: prefix });
  for (const ch of chunks.slice(cut)) after.append(ch);
  after.finalize();
  await settle();

  // The second capture describes the WHOLE document, not just the resumed tail.
  const second = after.getPersistable();
  expect(second.done).toBe(true);
  expect(second.sourceLength).toBe(DOC.length);
  expect(second.sourceHash).toBe(sourceFingerprint(DOC));

  const third = new BrookClient({ pool });
  third.hydrate(JSON.parse(JSON.stringify(second)) as PersistableSnapshot);
  expect(shape(third.getSnapshot())).toEqual(shape(after.getSnapshot()));
});

IT("a stale source at resume self-heals: the fresh parse wins", async () => {
  const pool = wasmPool();
  const chunks = chunkify(DOC, mulberry32(11));
  const cut = Math.floor(chunks.length / 2);

  const before = new BrookClient({ pool });
  for (const ch of chunks.slice(0, cut)) before.append(ch);
  await settle();
  const wire = JSON.stringify(before.getPersistable());
  before.destroy();

  // The caller's stored source moved on since the snapshot was taken (an edit
  // upstream). hydrate does NOT verify html against source, so the blocks are
  // painted as captured — but the resume re-parse is authoritative.
  const edited = "# EDITED TITLE\n\nthe thread was rewritten upstream\n";
  const after = new BrookClient({ pool });
  after.hydrate(JSON.parse(wire) as PersistableSnapshot, { source: edited });
  after.finalize(); // resume + finalize
  await settle();

  const control = await streamAll(pool, [edited]);
  expect(shape(after.getSnapshot())).toEqual(shape(control.getSnapshot()));
});

IT("appends land in order when they arrive before the catch-up completes", async () => {
  const pool = wasmPool();
  const chunks = chunkify(DOC, mulberry32(23));
  const cut = Math.floor(chunks.length / 2);
  const prefix = chunks.slice(0, cut).join("");

  const before = new BrookClient({ pool });
  for (const ch of chunks.slice(0, cut)) before.append(ch);
  await settle();
  const wire = JSON.stringify(before.getPersistable());
  const painted = before.getSnapshot();
  before.destroy();

  const after = new BrookClient({ pool });
  after.hydrate(JSON.parse(wire) as PersistableSnapshot, { source: prefix });
  // Every remaining chunk is fired SYNCHRONOUSLY, with zero settling — all of
  // them arrive while the history re-parse is still queued.
  for (const ch of chunks.slice(cut)) after.append(ch);
  // Nothing has come back yet, so the reader is still looking at the hydrated
  // document — unchanged, same references, nothing re-rendered.
  expect(after.getSnapshot().map((b) => b.html)).toEqual(painted.map((b) => b.html));
  after.finalize();
  await settle();

  const control = await streamAll(pool, chunks);
  expect(shape(after.getSnapshot())).toEqual(shape(control.getSnapshot()));
});

// ── The measurement that justifies all of this ─────────────────────────────

IT("hydrating a large thread is dramatically cheaper than re-parsing it", () => {
  // ~2000 blocks of realistic chat prose — the shape of a long thread.
  const parts: string[] = [];
  for (let i = 0; i < 400; i++) {
    parts.push(`## Section ${i}`);
    parts.push(
      `Paragraph ${i} with **bold**, _italic_, \`code\` and a [link](https://example.com/${i}). ` +
        `Filler so the block is a realistic size for a model answer rather than a toy one.`,
    );
    parts.push("```ts\nexport const v" + i + " = " + i + ";\n```");
    parts.push(`- item a ${i}\n- item b ${i}\n- item c ${i}`);
    parts.push(`> quoted ${i}`);
  }
  const doc = parts.join("\n\n") + "\n";

  // What reopening costs today: the whole source back through the parser.
  const reParse = () => {
    const t0 = performance.now();
    const p = new wasm.BrookParser();
    p.setWireDelta(true);
    const store = emptyBlockStore();
    applyPatch(store, JSON.parse(p.append(doc)) as Patch);
    applyPatch(store, JSON.parse(p.finalize()) as Patch);
    return { ms: performance.now() - t0, blocks: store.snapshot };
  };

  const first = reParse();
  const wire = JSON.stringify({
    hydrateVersion: 1,
    blocks: first.blocks,
    sourceLength: doc.length,
    sourceHash: sourceFingerprint(doc),
    done: true,
  } satisfies PersistableSnapshot);

  const hydrateOnce = () => {
    const t0 = performance.now();
    const c = new BrookClient({ pool: wasmPool() });
    c.hydrate(JSON.parse(wire) as PersistableSnapshot);
    const n = c.getSnapshot().length;
    return { ms: performance.now() - t0, n };
  };

  // Best-of, so a stray GC pause in either path cannot decide the assertion.
  let parseMs = Infinity;
  let hydrateMs = Infinity;
  let n = 0;
  for (let i = 0; i < 3; i++) {
    parseMs = Math.min(parseMs, reParse().ms);
    const h = hydrateOnce();
    hydrateMs = Math.min(hydrateMs, h.ms);
    n = h.n;
  }

  expect(n).toBeGreaterThan(1500); // it really is a large thread
  // Measured ~10-20x on a 1 MB / 2250-block document (hydrate ≈ 5 ms vs a
  // 51 ms one-shot re-parse and 110 ms re-streamed in 2 KB chunks). Gate well
  // below that so CI noise can never flip it, while still failing loudly if
  // hydration ever regresses into doing real work.
  expect(hydrateMs * 3).toBeLessThan(parseMs);
});
