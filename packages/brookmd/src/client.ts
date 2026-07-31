import { warnOnce } from "./warn";
import type { Block, FromWorker, ParserConfig, Patch, ToWorker, WorkerLike } from "./types-core";
// The `new Worker(new URL(..., import.meta.url))` construction lives in
// ./asset-urls so React Native can swap it out: the package's `react-native`
// field (package.json) redirects asset-urls.js -> asset-urls.native.js
// (import.meta-free, no Web Worker) for Metro. See asset-urls.ts.
import { createWorker } from "./asset-urls";
import { noteSplice } from "./splice";

/**
 * The ordered-block store backing a stream, extracted as a pure function so
 * its reference-stability contract is testable without a Worker.
 *
 * **The contract that prevents extra React re-renders:** a block, once
 * committed, is never re-sent by the parser, so `applyPatch` never replaces it
 * in the map. Its object reference stays identical across every later patch —
 * which is exactly what `blocksEqual` (the BlockView memo) checks, so committed
 * blocks never re-render (and never re-parse) as the stream grows. Only the
 * `active` tail gets fresh references each patch, and only it re-renders.
 */
export interface BlockStore {
  committed: Map<number, Block>;
  committedOrder: number[];
  active: Block[];
  snapshot: Block[];
}

export function emptyBlockStore(): BlockStore {
  return { committed: new Map(), committedOrder: [], active: [], snapshot: [] };
}

/** A heading entry for building a table of contents — see {@link BrookClient.outline}. */
export interface OutlineEntry {
  /** Heading level 1–6. */
  level: number;
  /** Plain-text heading content (tags stripped, entities decoded). */
  text: string;
  /** Stable block id — usable as a scroll target / React key. */
  id: number;
}

/** Envelope version of {@link PersistableSnapshot}. Bumped only when the shape
 *  changes incompatibly, and versioned INDEPENDENTLY of both the package and
 *  the parser wire contract (WIRE.md) — see the type's note. */
const HYDRATE_VERSION = 1;

/**
 * A self-contained, JSON-serializable capture of everything a stream currently
 * renders — produced by {@link BrookClient.getPersistable}, restored by
 * {@link BrookClient.hydrate}.
 *
 * Reopening a long thread normally re-feeds its whole source through the parser
 * before the first paint (O(source), and it blocks the reopen). Persist this
 * next to the thread instead and restoring it is pure JSON handling: the blocks
 * go straight into the store and both renderers mount them as ordinary
 * committed blocks — **no worker, no WASM, no parse**.
 *
 * NOT the wire contract. The parser↔renderer wire (WIRE.md) is a separate,
 * separately-versioned boundary; this envelope is a brookmd *package* format
 * that only {@link BrookClient.hydrate} consumes.
 */
export interface PersistableSnapshot {
  /** Envelope version. {@link BrookClient.hydrate} refuses anything it does not
   *  know how to read, so a stored snapshot never half-restores. */
  hydrateVersion: number;
  /**
   * The blocks exactly as {@link BrookClient.getSnapshot} showed them at
   * capture: the committed history plus whatever tail was on screen. Plain
   * JSON — a `Block` carries no hidden state (the renderers' splice bookkeeping
   * lives in a WeakMap, never on the block), so `JSON.stringify` round-trips it.
   */
  blocks: Block[];
  /** UTF-16 length of the markdown that produced `blocks`. */
  sourceLength: number;
  /** {@link sourceFingerprint} of that markdown. A staleness check — "is the
   *  source I stored still the one these blocks came from?" — and deliberately
   *  nothing more: not a checksum, not security. */
  sourceHash: string;
  /** Whether the captured stream had been finalized. A `done` snapshot is a
   *  terminal document: it needs no source and can never be resumed. */
  done: boolean;
}

/**
 * 32-bit FNV-1a over a string's UTF-16 code units, as 8 hex digits. Backs
 * {@link PersistableSnapshot.sourceHash}: cheap enough to run over a megabyte
 * of markdown, sharp enough to notice that a stored source changed. Exported so
 * a caller can make the same staleness decision brookmd does —
 * `snap.sourceHash === sourceFingerprint(mySource)`. Not a security primitive.
 */
export function sourceFingerprint(source: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    h ^= source.charCodeAt(i);
    // The FNV prime via Math.imul: a 32-bit wrapping multiply, no float rounding.
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Shape-check one entry of a persisted `blocks` array. Restoring a malformed
 *  snapshot must fail WHOLE rather than half-fill the store: a partially
 *  restored document renders as a real one and silently lies to the reader. */
function isPersistedBlock(b: unknown): b is Block {
  if (typeof b !== "object" || b === null) return false;
  const x = b as Record<string, unknown>;
  return (
    typeof x.id === "number" &&
    Number.isFinite(x.id) &&
    typeof x.html === "string" &&
    typeof x.start === "number" &&
    typeof x.end === "number" &&
    typeof x.open === "boolean" &&
    typeof x.speculative === "boolean" &&
    typeof x.kind === "object" &&
    x.kind !== null &&
    typeof (x.kind as Record<string, unknown>).type === "string"
  );
}

/** Strip tags (→ space) and decode the small entity set the core emits, then
 *  collapse whitespace. INVARIANT: the simple `<[^>]*>` strip is only safe
 *  because every input here is HTML the Rust core produced via escape_html /
 *  escape_attr — which escape `>` inside attribute values, so no `>` ever
 *  appears except as a real tag close. This must NOT be fed externally-authored
 *  HTML. `&amp;` decodes last so `&amp;lt;` → `&lt;`, not `<`. */
function htmlToText(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export function applyPatch(store: BlockStore, patch: Patch): void {
  for (const b of patch.newly_committed) {
    if (!store.committed.has(b.id)) store.committedOrder.push(b.id);
    store.committed.set(b.id, b);
  }
  // Wire delta mode (WIRE.md §11): an active entry may carry an `html_delta`
  // splice instead of full `html` — reconstruct against the PREVIOUS active
  // region (still in store.active here) so everything downstream only ever
  // sees full Blocks. JS strings are UTF-16, so `keep_units` is the offset.
  // The parser only emits a delta against a block it emitted in the previous
  // patch; a missing base means dropped/reordered patches — fail loudly (the
  // caller routes it through the malformed-patch error path).
  const active: Block[] = new Array(patch.active.length);
  for (let i = 0; i < patch.active.length; i++) {
    const entry = patch.active[i];
    if ("html_delta" in entry) {
      const { html_delta, ...rest } = entry;
      const prev = store.active.find((b) => b.id === entry.id);
      if (!prev) throw new Error(`brookmd: html_delta for block ${entry.id} without a base`);
      const next = { ...rest, html: prev.html.slice(0, html_delta.keep_units) + html_delta.append };
      active[i] = next;
      // Publish the splice the wire already proved (see splice.ts): renderers
      // apply it to the DOM in O(new bytes) instead of re-setting the whole
      // innerHTML. `Block.html` above is still the full string — this is
      // additional internal plumbing, not a change to the public shape.
      noteSplice(next, prev, html_delta.keep_units);
    } else {
      active[i] = entry;
    }
  }
  store.active = active;
  // Fresh array each patch (immutable for React reference checks), but the
  // committed entries inside it are the same object references as before.
  // INVARIANT (lines above): every id pushed to committedOrder is `set` in the
  // same iteration, and nothing in the package ever deletes from the map — so no
  // lookup can miss. Belt-and-braces anyway: if that invariant ever breaks, DROP
  // the orphan rather than publish a hole. A hole reaches `key={b.id}` in the
  // React renderer and `b.id` in the DOM renderer, and takes down the whole
  // document; one missing block is survivable, a blank page is not.
  const next: Block[] = new Array(store.committedOrder.length + store.active.length);
  let w = 0;
  for (let i = 0; i < store.committedOrder.length; i++) {
    const b = store.committed.get(store.committedOrder[i]);
    if (b === undefined) {
      if (typeof process !== "undefined" && process.env.NODE_ENV !== "production") {
        warnOnce(
          "orphan-committed",
          `brookmd: committed block ${store.committedOrder[i]} is missing from the store and was dropped. ` +
            `This is a bug in brookmd — please report it.`,
        );
      }
      continue;
    }
    next[w++] = b;
  }
  for (let i = 0; i < store.active.length; i++) {
    const b = store.active[i];
    if (b === undefined) {
      if (typeof process !== "undefined" && process.env.NODE_ENV !== "production") {
        warnOnce("orphan-active", `brookmd: active block at index ${i} is undefined and was dropped.`);
      }
      continue;
    }
    next[w++] = b;
  }
  if (w !== next.length) next.length = w; // only ever runs in the broken case
  store.snapshot = next;
}

// --------------------------------------------------------------------------
// Worker pool
// --------------------------------------------------------------------------

interface PoolWorker {
  worker: WorkerLike;
  ready: boolean;
  /** Set once the worker fails fatally (WASM init, a DOM load `error`, a
   *  `messageerror`, or the boot deadline); whenWorkerReady rejects with this
   *  thereafter. */
  failed: Error | null;
  streamCount: number;
  /** Live stream ids on this worker — so a fatal failure can notify each one. */
  streamIds: Set<number>;
  readyWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }>;
  /** Handle for the boot deadline that fails a worker which never reports ready.
   *  Opaque (a `number` in the browser, a `Timeout` in Node/bun, or a test
   *  fake's id) — cleared on ready, on failure, and on pool disposal. */
  bootTimer: unknown;
}

/**
 * A pool of Web Workers, each multiplexing many `BrookParser`s keyed by stream
 * id. This is what lets brookmd scale past `hardwareConcurrency` concurrent
 * streams without oversubscribing OS threads: 50 streams share (at most) the
 * cap's worth of workers instead of spawning 50.
 *
 * Worker creation is **lazy and load-aware**: while under the cap, each new
 * stream gets its own worker (so 1 stream = 1 worker, identical to the old
 * behavior); once at the cap, new streams attach to the least-loaded worker.
 *
 * The constructor injects a `WorkerLike` factory so the routing and lifecycle
 * logic is unit-testable with a fake worker — no real Worker or WASM needed.
 */
export class BrookPool {
  private workers: PoolWorker[] = [];
  private handlers = new Map<number, (msg: FromWorker) => void>();
  private nextStreamId = 1;

  // Per-worker boot deadline: if a worker reports neither ready nor a fatal
  // failure within this window it is failed with a clear message — the miss that
  // otherwise leaves `<div class="brook-md">` permanently empty (a stale hashed
  // worker URL 404s after a redeploy: the DOM fires `error`, but a browser that
  // somehow swallowed it would hang forever). `0` / non-finite disables it.
  private bootTimeoutMs: number;
  // Timer machinery, injectable so the deadline is testable with fake timers.
  private startTimer: (fn: () => void, ms: number) => unknown;
  private cancelTimer: (handle: unknown) => void;

  constructor(
    private factory: () => WorkerLike,
    private cap: number,
    options: {
      bootTimeoutMs?: number;
      setTimeout?: (fn: () => void, ms: number) => unknown;
      clearTimeout?: (handle: unknown) => void;
    } = {},
  ) {
    this.bootTimeoutMs = options.bootTimeoutMs ?? 20_000;
    this.startTimer = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancelTimer =
      options.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Reserve a stream id and assign a worker, registering its message handler. */
  acquire(handler: (msg: FromWorker) => void): { streamId: number; pw: PoolWorker } {
    const streamId = this.nextStreamId++;
    const pw = this.pick();
    pw.streamCount++;
    pw.streamIds.add(streamId);
    this.handlers.set(streamId, handler);
    return { streamId, pw };
  }

  /** Free a stream's parser in its worker; keep the worker warm for siblings. */
  release(streamId: number, pw: PoolWorker): void {
    this.handlers.delete(streamId);
    pw.streamIds.delete(streamId);
    pw.streamCount = Math.max(0, pw.streamCount - 1);
    try {
      pw.worker.postMessage({ type: "dispose", streamId });
    } catch {
      /* worker already gone */
    }
  }

  /** Inverse of {@link release}: re-register a stream's handler so it receives
   *  patches again. For React StrictMode's dev double-mount, which destroys a
   *  client on the simulated unmount and remounts the SAME instance. The worker
   *  lazily recreates the disposed parser on the next append. */
  reattach(streamId: number, pw: PoolWorker, handler: (msg: FromWorker) => void): void {
    if (!this.handlers.has(streamId)) {
      pw.streamCount++;
      pw.streamIds.add(streamId);
    }
    this.handlers.set(streamId, handler);
  }

  send(pw: PoolWorker, msg: ToWorker): void {
    pw.worker.postMessage(msg);
  }

  /** Resolves when the given worker has finished WASM init; rejects if it failed. */
  whenWorkerReady(pw: PoolWorker): Promise<void> {
    if (pw.ready) return Promise.resolve();
    if (pw.failed) return Promise.reject(pw.failed);
    return new Promise((resolve, reject) => pw.readyWaiters.push({ resolve, reject }));
  }

  /**
   * Eagerly spin up one worker so WASM init starts BEFORE the first stream —
   * taking the one-time init off the first-token critical path (e.g. call
   * `getDefaultPool().warm()` on app load / route entry). Reuses a live worker
   * if one exists; the warm worker is the one the first stream attaches to (it
   * has spare capacity), so the work is not wasted. Resolves when that worker has
   * finished initializing WASM; rejects if init fails fatally. Browser-only (it
   * constructs a `Worker`).
   */
  warm(): Promise<void> {
    const live = this.workers.filter((w) => !w.failed);
    const pw = live[0] ?? this.create();
    return this.whenWorkerReady(pw);
  }

  /** Terminate every worker (test teardown / full shutdown). */
  disposeAll(): void {
    for (const pw of this.workers) {
      this.clearBootTimer(pw);
      try {
        pw.worker.terminate();
      } catch {
        /* ignore */
      }
    }
    this.workers = [];
    this.handlers.clear();
  }

  get workerCount(): number {
    return this.workers.length;
  }

  /** Live stream→handler registrations. Introspection for tests/diagnostics —
   *  a fatal failure reaps the dead worker's entries, so this must not grow
   *  across a worker death + recovery cycle. */
  get handlerCount(): number {
    return this.handlers.size;
  }

  // Create a new worker while under cap and every live worker is busy; otherwise
  // attach to the least-loaded LIVE worker. A fatally-failed worker is never
  // handed out (a stream on it would post into a dead worker and hang) — it is
  // retained only to reject outstanding whenWorkerReady waiters.
  private pick(): PoolWorker {
    const live = this.workers.filter((w) => !w.failed);
    if (this.workers.length < this.cap && live.every((w) => w.streamCount > 0)) {
      return this.create();
    }
    if (live.length === 0) return this.create();
    return live.reduce((a, b) => (b.streamCount < a.streamCount ? b : a));
  }

  private create(): PoolWorker {
    const pw: PoolWorker = {
      worker: this.factory(),
      ready: false,
      failed: null,
      streamCount: 0,
      streamIds: new Set(),
      readyWaiters: [],
      bootTimer: null,
    };
    // Detect a worker that dies BEFORE it can post anything back in-band: a
    // browser fires a DOM `error` on the Worker object when the script 404s (a
    // stale hashed URL after a redeploy) and a `messageerror` when a posted
    // message can't be deserialized — neither of which arrives as a `message`
    // event, so without these listeners the `ready` promise would hang forever.
    // Register these BEFORE `message`: (1) real Workers can fire a load error
    // immediately, and (2) the unit-test fakes store a SINGLE listener slot
    // regardless of type, so letting the `message` registration land LAST leaves
    // their routing pointed at the message handler exactly as before. The
    // try/catch guards keep a fake that lacks these channels from throwing.
    try {
      pw.worker.addEventListener("error", (ev) => {
        const detail = ev.message;
        this.fail(pw, new Error(`brookmd worker failed to load${detail ? `: ${detail}` : ""}`));
      });
    } catch {
      /* a fake without an error channel */
    }
    try {
      pw.worker.addEventListener("messageerror", () => {
        this.fail(pw, new Error("brookmd worker message could not be deserialized"));
      });
    } catch {
      /* a fake without a messageerror channel */
    }
    pw.worker.addEventListener("message", (ev) => this.onMessage(pw, ev.data));
    // Push BEFORE arming the deadline so a (degenerate) synchronously-firing
    // injected timer runs fail() with pw already in `workers[]` — otherwise the
    // reap's indexOf would miss it and leak the slot.
    this.workers.push(pw);
    this.startBootTimer(pw);
    return pw;
  }

  // Arm the per-worker boot deadline (no-op when disabled). Uses the injected
  // timer so tests drive it deterministically, and `.unref()`s the handle (when
  // present) so a pending deadline never keeps a Node/bun process alive.
  private startBootTimer(pw: PoolWorker): void {
    if (!(this.bootTimeoutMs > 0) || !Number.isFinite(this.bootTimeoutMs)) return;
    const timer = this.startTimer(() => {
      // The clear paths (ready/failure/dispose) normally cancel us first; this
      // guard covers a fake timer that fires anyway.
      if (!pw.ready && !pw.failed) {
        this.fail(pw, new Error(`brookmd worker did not become ready within ${this.bootTimeoutMs}ms`));
      }
    }, this.bootTimeoutMs);
    (timer as { unref?: () => void } | null)?.unref?.();
    pw.bootTimer = timer;
  }

  private clearBootTimer(pw: PoolWorker): void {
    if (pw.bootTimer !== null) {
      this.cancelTimer(pw.bootTimer);
      pw.bootTimer = null;
    }
  }

  private onMessage(pw: PoolWorker, msg: FromWorker): void {
    if (msg.type === "ready") {
      pw.ready = true;
      this.clearBootTimer(pw);
      const waiters = pw.readyWaiters;
      pw.readyWaiters = [];
      for (const w of waiters) w.resolve();
      return;
    }
    if (msg.type === "error" && msg.fatal) {
      // A fatal (WASM-init) failure dooms every stream on this worker — route it
      // through the same unified path as a DOM load error / messageerror / boot
      // deadline so the fan-out, waiter rejection, and reap are identical.
      this.fail(pw, new Error(msg.message));
      return;
    }
    this.dispatch(msg.streamId, msg);
  }

  /**
   * Idempotent fatal-failure handler shared by every trigger: an in-band
   * `{type:"error",fatal:true}` (WASM init), a DOM load `error`, a
   * `messageerror`, and the boot deadline. First cause wins; later calls no-op.
   *
   * A fatally failed worker dooms every stream on it. Reject anyone awaiting
   * readiness, then dispatch a synthetic fatal error to each live stream so its
   * client's `onError` fires exactly as for a WASM-init fatal (the message
   * carries no real streamId to route by). Finally evict the worker: terminate
   * it and drop it from the pool — a dead worker can never parse again, so
   * retaining it would leak an OS thread per failure and keep counting against
   * `cap` until pick()'s cap branch dies and spawns workers unbounded. Reaping
   * restores the cap and lets a fresh worker be made.
   */
  private fail(pw: PoolWorker, err: Error): void {
    if (pw.failed) return; // idempotent — first cause wins
    pw.failed = err;
    this.clearBootTimer(pw);
    const waiters = pw.readyWaiters;
    pw.readyWaiters = [];
    for (const w of waiters) {
      try {
        w.reject(err);
      } catch {
        /* a waiter's rejection handler is the caller's problem, not ours */
      }
    }
    const msg: FromWorker = { type: "error", streamId: -1, message: err.message, fatal: true };
    for (const sid of pw.streamIds) this.dispatch(sid, msg);
    // Drop the dead worker's handler entries. The worker is terminated and can
    // never post again, and a recovering client re-acquires a fresh stream id
    // (ids are never reused), so these entries would otherwise dangle forever —
    // the process-wide default pool's handler map would grow unbounded across
    // repeated worker deaths + recoveries.
    for (const sid of pw.streamIds) this.handlers.delete(sid);
    try {
      pw.worker.terminate();
    } catch {
      /* already gone */
    }
    const idx = this.workers.indexOf(pw);
    if (idx !== -1) this.workers.splice(idx, 1);
  }

  // Route a message to a stream's handler, isolating a throwing client callback
  // (e.g. a user-supplied onError) so it can neither break the worker message
  // loop nor starve sibling streams sharing this worker.
  private dispatch(streamId: number, msg: FromWorker): void {
    try {
      this.handlers.get(streamId)?.(msg);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("brookmd: stream message handler threw", e);
    }
  }
}

/** Per-generation id offset for merged divergence views (see BrookClient's
 *  `idNamespace`). 2^32 sits far above any real per-generation block id while
 *  leaving room for 2^21 divergences inside Number.MAX_SAFE_INTEGER. */
const ID_NAMESPACE_STRIDE = 0x1_0000_0000;

function poolCap(): number {
  const hc = typeof navigator !== "undefined" ? navigator.hardwareConcurrency : 0;
  return Math.min(hc || 4, 8);
}

let defaultPool: BrookPool | null = null;

/** The process-wide default pool every `BrookClient` shares unless given one. */
export function getDefaultPool(): BrookPool {
  if (!defaultPool) {
    defaultPool = new BrookPool(
      () => createWorker(),
      poolCap(),
    );
  }
  return defaultPool;
}

/** TEST-ONLY: drop the process-wide default pool so the next {@link getDefaultPool}
 *  rebuilds it (lazily, with the current global `Worker`). Lets a test file that
 *  drives the default pool start from a clean, deterministic state regardless of
 *  which other file warmed it first in bun's shared test process. Not part of the
 *  public API and a no-op for normal runtime use. */
export function __resetDefaultPool(): void {
  defaultPool = null;
}

// --------------------------------------------------------------------------
// Client
// --------------------------------------------------------------------------

/**
 * Subscriber-driven store backing a single streaming parser. Each client owns
 * one stream within a shared {@link BrookPool}; many clients multiplex over a
 * small set of workers (see the pool for the scaling story).
 *
 * The store exposes:
 *   - subscribe(listener): for React's useSyncExternalStore
 *   - getSnapshot(): the current ordered list of blocks
 *   - getMetrics(): per-stream perf metrics
 *
 * Mutation methods:
 *   - append(chunk): forward to the worker
 *   - finalize(): mark the stream done
 *   - reset(): start fresh
 */
export class BrookClient {
  private pool: BrookPool;
  private pw: PoolWorker | null = null;
  private streamId = 0;
  private config?: ParserConfig;
  private configSent = false;
  /** Set when ensureAcquired rebound this stream onto a fresh worker+parser
   *  after a fatal failure; consumed by the next content-bearing op. */
  private pendingRebind = false;
  private listeners = new Set<() => void>();
  private store: BlockStore = emptyBlockStore();
  private onError?: (err: { message: string; fatal?: boolean }) => void;
  private onBlock?: (block: Block) => void;
  private attached = true;
  // Diff baseline for setContent(): the full string fed in so far, and whether
  // it has been finalized. Cleared by reset()/reattach() (the worker drops the
  // parser there, so the baseline is stale and the document must be re-fed).
  private lastContent = "";
  private contentDone = false;

  // --- Worker-failure recovery ---
  // The terminal fatal error for this client's stream: non-null once its worker
  // failed AND (if a recovery was attempted) the replacement also failed. Null
  // while a recovery is in flight / succeeded, and reset by reset(). Surfaced by
  // the `failed` getter.
  private failedError: Error | null = null;
  // Whether auto-recovery (and the buffer that feeds it) is enabled — off by the
  // `recovery: false` constructor option. When off, nothing is buffered and a
  // fatal worker death is immediately terminal in BOTH modes.
  private recovery = true;
  // The full document driven into this stream so far — accumulated in append()
  // (so it captures BOTH manual append/pipeFrom AND setContent, which drives via
  // append(delta)). It is the baseline re-fed after a transient worker death.
  // resetParser() clears it and the ensuing re-feed rebuilds it, so it stays
  // exactly equal to the live document on every path.
  private recoveryBuffer = "";
  // Buffer length captured at the last completed re-feed. append()'s growth
  // re-arm compares against it: once the caller drives the buffer PAST this, a
  // future death may heal again. Set to Infinity while a recovery is pending
  // (fatal → microtask) so a stray chunk arriving before recover() runs can't
  // spuriously re-arm; set to the re-fed length once recover() completes. Its
  // "!== Infinity" also stands in for "a recovery is outstanding" in the
  // setContent divergence re-arm below.
  private recoveredLen = Infinity;
  // One-shot guard: set when a fatal failure schedules an auto-recovery re-feed
  // so a replacement worker that also dies is NOT retried a second time. Re-armed
  // (cleared) only when the caller drives NEW content — never on a mere
  // successful patch, because a finalize()-that-traps document emits an append
  // patch before it re-traps, and re-arming there would loop the same poison doc
  // through workers forever. Two complementary re-arm rules clear it: append()'s
  // buffer-GROWTH check (streaming past the recovered length) and setContent()'s
  // DIVERGENCE check (content differs from the re-fed buffer — catches a
  // same-length-or-shorter replacement the growth check misses). Also cleared on
  // an explicit caller reset().
  private recoveryAttempted = false;
  // Whether any chunk has been appended in this generation. Read only by
  // getPersistable's source fallback, to tell "nothing was ever driven" (whose
  // source is the empty document) from "driven, but this client did not retain
  // it" — the one configuration, recovery off plus manual appends, where the
  // source is genuinely unknown and the caller must supply it.
  private appendedAny = false;

  // Opt-in rAF coalescing (see constructor `coalesce`). When on AND
  // requestAnimationFrame exists, intra-frame emit()s collapse into ONE
  // rAF-scheduled flush to listeners — the React useSyncExternalStore path then
  // renders once per frame instead of once per patch (the DOM renderer already
  // batches to 1/frame independently). Lossless: committed blocks are
  // reference-stable, so a dropped intermediate notify only skips a tail-only
  // render that the next flush supersedes. The finalize/done patch is exempt and
  // flushes synchronously, never deferred to the next frame.
  private coalesce = false;
  private rafHandle: number | null = null;
  // Set by finalize(); the next patch's emit flushes synchronously (a 'done'
  // notification must not be deferred a frame) and clears it. Belt-and-suspenders
  // alongside the per-patch `final` flag, which is the authoritative signal.
  private finalizePending = false;
  // Stream generation, bumped on reset(). Stamped on every worker message and
  // echoed back on each patch; a patch whose epoch is older than this is a
  // pre-reset straggler and is dropped before it can repopulate the cleared store.
  private epoch = 0;

  // --- Preserved-view divergence swap (setContent's reset+reparse path) ---
  // The displayed snapshot captured by softReset(). While set, getSnapshot()
  // returns a positional merge of this view over the rebuilding store, so the
  // document never blanks out during a divergence reparse and unchanged blocks
  // keep their object identity AND id (React key / DOM node key) across the
  // swap. It persists after the reparse completes — dropping it would revert
  // the adopted ids and remount every block one notify later.
  private staleSnapshot: Block[] | null = null;
  // Set when the reparse's terminal (final) patch lands: the merge stops
  // padding with the old document's tail, so a shorter replacement trims to the
  // new length on that very notify.
  private staleTrimmed = false;
  // Id offset applied to non-adopted new blocks in a merged view. A divergence
  // reparse restarts core block ids at 0 (fresh parser), and streamed ids are
  // chunk-dependent (tail reparses burn ids) — so a changed block's new id can
  // collide with a retained old block's id in the same merged snapshot.
  // Bumped by ID_NAMESPACE_STRIDE per generation, which keeps every merged id
  // provably unique: adopted ids are all below the current namespace.
  private idNamespace = 0;
  // getSnapshot() cache: (store.snapshot ref, trimmed) → merged array. Repeated
  // reads between notifies must return the SAME reference — the
  // useSyncExternalStore cached-snapshot contract.
  private mergeCache: { base: Block[]; trimmed: boolean; view: Block[] } | null = null;
  /** Set by mergeStale when it had to compact a hole out of the view, so
   *  getSnapshot skips caching a view whose indices no longer track `base`. */
  private mergeDropped = false;

  // --- Hydration (see getPersistable / hydrate) ---
  // Set by hydrate(): this store was FILLED FROM JSON, never parsed, so no
  // worker has ever seen this document. Sticky until reset() — a resumed client
  // is still "a hydrated client" as far as getPersistable is concerned.
  private hydrated = false;
  // The restored envelope's own fields, kept so the resume can re-check
  // staleness and so getPersistable() can re-emit an untouched snapshot exactly.
  private hydratedDone = false;
  private hydratedLength = 0;
  private hydratedHash = "";
  // The original markdown behind a hydrated snapshot (hydrate's `source`), held
  // ONLY until the resume re-feed consumes it. Null for a `done` snapshot, which
  // is terminal and needs none.
  private hydratedSource: string | null = null;
  // Latch: the resume re-feed has been issued, or the caller took over by
  // driving the whole document itself. From here append()/finalize() behave
  // exactly as on any other client.
  private resumed = false;

  // Perf
  private appendedBytes = 0;
  private patchCount = 0;
  private totalParseMicros = 0;
  private lastPatchMs = 0;
  private firstAppendMs = 0;
  private retainedBytes = 0;
  private wasmMemoryBytes = 0;
  // Render-path observability (advanced ONLY when an onRenderMetrics hook is
  // wired into a renderer; zero-cost otherwise). renderCount = React BlockView
  // body renders; rebuildCount = DOM node rebuilds.
  private renderCount = 0;
  private rebuildCount = 0;

  /**
   * @param options.pool   worker pool to join (defaults to the shared
   *   process-wide pool — pass a dedicated `BrookPool` only for isolation).
   * @param options.config per-stream parser flags (see {@link ParserConfig});
   *   omitted fields use library defaults. Applied once, immutable thereafter.
   * @param options.onError invoked on a worker/parse error or a fatal WASM-init
   *   failure (`fatal: true`). Without it, errors are only `console.error`d and
   *   a load failure surfaces solely as a rejected {@link BrookClient.whenReady}.
   * @param options.onBlock invoked once per block as it commits (in document
   *   order, after the store updates) — for side effects like lazily
   *   highlighting a finished code block or analytics. A committed block never
   *   re-fires; the streaming tail does not (subscribe for live tail updates).
   *   NOTE: this is a PARSER-commit hook — the block carries the parser's raw
   *   id. During a setContent divergence swap the rendered view may show that
   *   block under a different id (an adopted old id, or a namespaced one), so
   *   correlate with rendered blocks via subscribe()+getSnapshot(), not this id.
   * @param options.coalesce opt-in (default `false`): collapse multiple
   *   intra-frame patch notifications into ONE `requestAnimationFrame`-scheduled
   *   flush to subscribers, so a React `useSyncExternalStore` consumer renders at
   *   most once per frame instead of once per patch. Lossless — committed blocks
   *   are reference-stable, so only superseded tail-only renders are skipped. The
   *   stream-completion (finalize) patch always flushes synchronously, and a
   *   pending frame is cancelled on `reset()`/`destroy()`. No effect when
   *   `requestAnimationFrame` is unavailable (e.g. SSR) — emits stay synchronous.
   * @param options.recovery opt-out (default `true`): transparently heal a
   *   TRANSIENT worker death. The client buffers the full driven document and, on
   *   a fatal worker failure, re-acquires a fresh worker and re-feeds it exactly
   *   once — the displayed view stays on screen, so a worker that 404s after a
   *   redeploy (or otherwise dies mid-stream) recovers invisibly instead of
   *   freezing the render. If the replacement ALSO dies the error surfaces
   *   (`failed` / `onError`). Set `false` to disable both the buffering and the
   *   auto-recovery — a fatal failure then goes straight to terminal.
   */
  constructor(
    options: {
      pool?: BrookPool;
      config?: ParserConfig;
      onError?: (err: { message: string; fatal?: boolean }) => void;
      onBlock?: (block: Block) => void;
      coalesce?: boolean;
      recovery?: boolean;
    } = {},
  ) {
    this.pool = options.pool ?? getDefaultPool();
    this.config = options.config;
    this.onError = options.onError;
    this.onBlock = options.onBlock;
    this.coalesce = options.coalesce ?? false;
    this.recovery = options.recovery ?? true;
  }

  /**
   * Lazily reserve this client's stream id and bind it to a pool worker. The
   * SOLE place that calls pool.acquire() — so the worker is created on the FIRST
   * worker-bound operation (append/finalize/reset/pipeFrom/whenReady), never at
   * construct time. This is what makes `new BrookClient()` SSR-safe: nothing here
   * runs during an SSR render (which only subscribes + reads the snapshot).
   *
   * Idempotent: once this.pw is set it returns it immediately and never
   * re-acquires — this.pw is never nulled (destroy() deliberately keeps it so
   * StrictMode's destroy()→reattach() on the SAME instance re-registers the same
   * slot). Note: streamId/worker assignment now follows first-worker-bound-op
   * order, not construction order — a client constructed first no longer
   * necessarily owns the lowest streamId. This affects neither the pool cap nor
   * multiplexing (pick() is unchanged and remains the only path to create()).
   */
  private ensureAcquired(): PoolWorker {
    if (this.pw && !this.pw.failed) return this.pw;
    // A previously-acquired worker that failed fatally (WASM-init failure or a
    // trap that poisoned the shared instance) was evicted from the pool; drop the
    // stale reference and re-acquire so this stream can recover onto a fresh
    // worker (the caller already received the fatal onError).
    const rebinding = this.pw !== null;
    this.pw = null;
    const { streamId, pw } = this.pool.acquire((msg) => this.onMessage(msg));
    this.streamId = streamId;
    this.pw = pw;
    if (rebinding) {
      // The worker keeps parser config per streamId, so a DIFFERENT worker (or
      // even the same one under a new streamId) has never seen ours. Without
      // this the healed parser is rebuilt with library defaults — gfmMath,
      // componentTags, blockData and the whole `kind.data` structured channel
      // silently disappear for the rest of the session.
      this.configSent = false;
      // The fresh parser numbers blocks from 0 again while our store still holds
      // the dead generation's blocks. Merging the two would collide ids, so the
      // next content-bearing op starts a clean generation instead. Deferred (not
      // done here) because resetParser() calls back into ensureAcquired().
      this.pendingRebind = true;
    }
    return pw;
  }

  /**
   * A worker rebind left the store holding a dead generation's blocks while the
   * fresh parser restarts ids at 0. Called by the ops that actually feed the
   * parser, before they do. Recovery's re-feed handles this itself (it re-parses
   * the whole document over a preserved view) and clears the flag; this is the
   * path where recovery is off or already spent, where the honest outcome is a
   * clean restart rather than two generations interleaved under colliding ids.
   */
  private settleRebind(): void {
    if (!this.pendingRebind) return;
    // Only a TERMINAL failure gets here. While the one-shot recovery microtask is
    // queued, `failedError` is still null and the re-feed owns the rebuild — it
    // re-parses the whole buffered document over a preserved view. Restarting
    // underneath it would clear `recoveryBuffer` and heal the wrong document.
    if (this.failedError === null) return;
    this.pendingRebind = false;
    if (this.store.snapshot.length === 0 && !this.staleSnapshot) return;
    if (typeof process !== "undefined" && process.env.NODE_ENV !== "production") {
      warnOnce(
        "rebind-reset",
        "brookmd: the parser was rebuilt on a new worker after a fatal failure, so the " +
          "document restarted. Blocks rendered before the failure were dropped because the " +
          "fresh parser renumbers from zero. Enable `recovery` (the default) to re-feed and " +
          "heal invisibly instead.",
      );
    }
    this.resetParser();
  }

  get ready(): boolean {
    // A hydrated document is already readable with no worker in the picture.
    // Reporting `false` there would leave a `ready`-gated spinner sitting over a
    // fully rendered thread forever.
    if (this.hydrationPending) return true;
    return this.pw?.ready ?? false;
  }

  /** True while a hydrated document has never been handed to a parser: the
   *  store holds restored blocks and no worker exists. Cleared once the resume
   *  re-feed is issued (or the caller re-drives the whole document itself). */
  private get hydrationPending(): boolean {
    return this.hydrated && !this.resumed;
  }

  /**
   * The fatal error that killed this client's worker, or `null` if healthy.
   *
   * Non-null only once a failure is TERMINAL: a worker that died with recovery
   * off or nothing buffered to re-feed, or a client (either mode) whose one-shot
   * auto-recovery re-feed ALSO hit a dying worker. It stays `null` throughout a
   * successful transient recovery (the death heals invisibly) and is cleared
   * again by {@link reset}. Pairs with `onError`, which fires on the same
   * terminal failure.
   */
  get failed(): Error | null {
    return this.failedError;
  }

  whenReady(): Promise<void> {
    // A hydrated document is on screen already and no parser has been asked
    // for — resolve without acquiring. This is what keeps "reopen a finished
    // thread" free of WASM entirely: a readiness gate must not be the thing that
    // spawns the worker hydration exists to avoid.
    if (this.hydrationPending) return Promise.resolve();
    const pw = this.ensureAcquired();
    return this.pool.whenWorkerReady(pw);
  }

  // The config rides on the first message a stream sends; the worker applies it
  // when it creates the parser. postMessage is FIFO per worker, so it always
  // lands before any append is processed. Returns undefined after the first use.
  private firstConfig(): ParserConfig | undefined {
    if (this.configSent || !this.config) return undefined;
    this.configSent = true;
    return this.config;
  }

  append(chunk: string) {
    // First content-bearing op on a hydrated thread: rebuild the parser state
    // that could not be serialized, in the background, before this chunk.
    if (this.hydrationPending) this.beginResume();
    const pw = this.ensureAcquired();
    this.settleRebind();
    if (this.firstAppendMs === 0) this.firstAppendMs = performance.now();
    this.appendedAny = true;
    if (this.recovery) {
      // Accumulate the driven document so a transient worker death can re-feed it
      // (this also captures setContent, which drives via append(delta)).
      this.recoveryBuffer += chunk;
      // Growth re-arm: once the caller streams PAST the last recovered length, a
      // future death may heal again. Guarded by recoveredLen === Infinity while a
      // recovery is pending, so a stray chunk between fatal and recover() (or
      // recover()'s own re-feed) can't spuriously re-arm.
      if (this.recoveryAttempted && this.recoveryBuffer.length > this.recoveredLen) {
        this.recoveryAttempted = false;
      }
    }
    this.pool.send(pw, { type: "append", streamId: this.streamId, chunk, config: this.firstConfig(), epoch: this.epoch });
  }

  finalize() {
    if (this.hydrationPending) {
      // A thread hydrated as already-finalized IS finalized. Re-finalizing would
      // spin up a worker and a parser for a document that will never be parsed —
      // exactly the cost hydration exists to avoid — so this is a no-op.
      if (this.hydratedDone) return;
      // Otherwise resume first, so the finalize below lands on a parser that has
      // been given the history (queued ahead of it by postMessage's FIFO order).
      this.beginResume();
    }
    const pw = this.ensureAcquired();
    this.settleRebind();
    // The terminal patch this triggers must reach subscribers synchronously, not
    // a frame late — mark it so the next emit flushes now even under coalescing.
    this.finalizePending = true;
    // Record finalized state so append/pipeFrom-mode recovery re-finalizes the
    // re-fed document (setContent already tracked this itself; resetParser clears
    // it). Safe under the documented "drive with append() OR setContent, not
    // both" contract.
    this.contentDone = true;
    this.pool.send(pw, { type: "finalize", streamId: this.streamId, config: this.firstConfig(), epoch: this.epoch });
  }

  /**
   * Pipe a source straight in: read it to completion, `append()` each chunk,
   * then `finalize()`. The LLM-native path — e.g.
   * `await client.pipeFrom(await fetch("/api/chat"))`. Accepts:
   *   - a `Response` or its `ReadableStream<Uint8Array>` body (bytes; decoded
   *     with `TextDecoder({ stream: true })` so a multibyte sequence straddling
   *     a chunk boundary carries into the next read), or
   *   - an `AsyncIterable<string>` (e.g. an SSE delta generator) — string chunks
   *     appended verbatim.
   *
   * Pass `opts.signal` to supersede/cancel: the signal is checked on every
   * iteration, so once aborted no further chunk is appended and **finalize is
   * skipped** (a superseded stream must not finalize). For a byte source the
   * reader is also `cancel()`'d to tear down the upstream. Resolves once
   * finalized (or cleanly on abort); rejects if the source itself errors.
   * Browser-only for byte sources (uses `TextDecoder`).
   */
  async pipeFrom(
    source: ReadableStream<Uint8Array> | Response | AsyncIterable<string>,
    opts?: { signal?: AbortSignal },
  ): Promise<void> {
    const signal = opts?.signal;

    if (signal?.aborted) return; // already superseded before we started

    // AsyncIterable<string> (SSE deltas, generators). Detected by elimination:
    // a ReadableStream has `getReader`, a Response has `body` — neither here.
    if (!("getReader" in source) && !("body" in source)) {
      for await (const chunk of source as AsyncIterable<string>) {
        if (signal?.aborted) return; // superseded/unmounted: drop late chunks, no finalize
        this.append(chunk);
      }
      if (!signal?.aborted) this.finalize();
      return;
    }

    // Byte source: a Response (use its body) or a ReadableStream directly.
    const body = "body" in source ? source.body : source;
    if (!body) {
      // An empty Response body (e.g. 204) is a completed, empty stream.
      this.finalize();
      return;
    }
    const reader = body.getReader();
    // A pending read() can't observe `aborted` until the next chunk; cancel()
    // on abort tears down the upstream and resolves the pending read so the
    // loop's post-read check fires and bails without finalizing.
    const onAbort = () => {
      reader.cancel().catch(() => {});
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (signal?.aborted) return; // superseded: no finalize (cancel already fired)
        if (done) break;
        if (value) this.append(decoder.decode(value, { stream: true }));
      }
      this.append(decoder.decode()); // flush any trailing partial sequence
      this.finalize();
    } finally {
      signal?.removeEventListener("abort", onAbort);
      try {
        reader.releaseLock();
      } catch {
        /* already released (e.g. by cancel) */
      }
    }
  }

  /**
   * Drive the parser from a CONTROLLED full string instead of manual appends.
   * Pass the whole document-so-far each time; setContent diffs it against the
   * last value and does the minimal work:
   *   - **prefix-extension** (the streaming-growth case) → append only the new
   *     suffix, so committed blocks stay put and only the active tail re-parses;
   *   - **any other change** (e.g. a finished stream swapped for a re-processed
   *     final string) → reset + reparse the whole new string, keeping the
   *     current view on screen until the reparse lands: the document never
   *     blanks, scroll never moves, and blocks whose rendered content is
   *     unchanged keep their identity (and React keys) so only genuinely
   *     changed blocks re-render. An empty new string is an explicit clear and
   *     hard-resets immediately.
   *
   * This is the first-class bridge for UIs that hold a streaming message as a
   * single growing string prop (the common React shape) — no hand-rolled diff,
   * no readiness gate (appends before WASM is ready are buffered). Pass
   * `{ done: true }` once the content is final to `finalize()` (idempotent within
   * a generation; a content change *after* done reopens the stream via a fresh
   * reparse, since a finalized parser is terminal and can't be appended to).
   * Drive a given client with `setContent` *or* manual `append()`/`finalize()`,
   * not both — they share the internal diff baseline.
   *
   * v1 note: the non-prefix path is a full reparse, not a partial rewind —
   * committed blocks are frozen, so there is no truncate-to-offset. For the
   * common case (append-growth + one end-of-stream swap) that is optimal. A
   * transform that rewrites *earlier* bytes on every update is an anti-pattern
   * here (it forces a reparse each tick); do that enrichment at render time via
   * `components` instead, keeping the source append-only.
   */
  setContent(content: string, opts?: { done?: boolean }) {
    // DIVERGENCE re-arm (complements append()'s GROWTH re-arm): while a recovery
    // is outstanding (recoveryAttempted with a finite recoveredLen), a controlled
    // string that DIFFERS from the re-fed buffer is caller progress, not the
    // poison doc replaying, so a future death may heal again. This catches a
    // same-length-or-shorter replacement the growth check misses. recover()'s own
    // re-feed drives identical content, so it doesn't trip this.
    if (this.recoveryAttempted && this.recoveredLen !== Infinity && content !== this.recoveryBuffer) {
      this.recoveryAttempted = false;
    }
    if (content !== this.lastContent) {
      // Fast path appends the delta into the EXISTING parser — but a parser that
      // was already finalized ({ done: true }) is terminal: the core drops any
      // further append. So gate the fast path on !contentDone; reopening a
      // finalized stream (or any divergence) falls through to reset()+reparse,
      // which frees the dead parser and rebuilds a fresh one.
      if (!this.contentDone && content.startsWith(this.lastContent)) {
        if (this.lastContent === "" && content.length > 0 && this.getSnapshot().length > 0) {
          // Whole-document re-feed into a POPULATED store — only reachable when
          // reattach() cleared the baseline while blocks were on screen (e.g. a
          // StrictMode-style destroy()→reattach() on a client that had content).
          // The worker's parser was dropped, so a plain append would restart raw
          // ids at 0 — and those cannot be trusted to line up with the store's
          // committed keys (streamed ids carry chunk-dependent holes, and a
          // completed divergence swap re-keys the store by displayed ids), so
          // applyPatch would duplicate blocks instead of replacing them. This IS
          // a divergence swap in disguise: preserve the displayed view and let
          // the merge adopt identical blocks (an unchanged re-feed re-renders
          // nothing at all).
          this.softReset(this.getSnapshot());
          // `lastContent` was empty, so the append below carries the WHOLE
          // document. A hydrated client therefore needs no resume re-feed — this
          // append IS the re-parse, over the very view softReset just preserved.
          this.retireHydration();
        }
        this.append(content.slice(this.lastContent.length));
      } else {
        // Diverged, or reopening a finalized stream — rebuild. When both the new
        // content and the displayed view are non-empty this is the documented
        // once-at-the-end reprocess swap: keep the current view on screen while
        // the new string reparses (softReset), so the document never blanks and
        // unchanged blocks keep their identity. An explicit clear (empty new
        // content) stays a hard, immediate reset.
        const displayed = this.getSnapshot();
        if (content.length > 0 && displayed.length > 0) this.softReset(displayed);
        else this.reset();
        // Same as the whole-document prefix case above: the caller supplied the
        // entire document, so a hydrated client's resume re-feed is redundant
        // (and would prepend a stale source to it).
        this.retireHydration();
        this.append(content);
      }
      this.lastContent = content;
      this.contentDone = false;
    }
    if (opts?.done && !this.contentDone) {
      this.finalize();
      this.contentDone = true;
    }
  }

  /**
   * Capture everything this client currently renders as a plain-JSON
   * {@link PersistableSnapshot}: `JSON.stringify` it, store it beside the
   * thread, and {@link hydrate} it back later to repaint with **no parse at
   * all**. This is the persistence half of instant thread reopen.
   *
   * The committed wire is already a complete serialization — a committed block
   * is emitted exactly once and is final (WIRE.md §2) — so there is nothing to
   * re-derive: the snapshot IS the document. Cost here is one pass to
   * fingerprint the source; cost on the way back in is a `Map` fill.
   *
   * @param source the markdown driven into this stream, used ONLY to compute
   *   {@link PersistableSnapshot.sourceHash}. Optional, because a client with
   *   `recovery` on (the default) already retains it, as does a
   *   `setContent`-driven one; required in the single configuration that holds
   *   neither — `recovery: false` plus manual `append()` — where omitting it
   *   throws rather than persisting a snapshot no one can check for staleness.
   */
  getPersistable(source?: string): PersistableSnapshot {
    const blocks = this.getSnapshot();
    if (source === undefined && this.hydrationPending) {
      // Hydrated and untouched since: the source is unchanged BY DEFINITION, so
      // re-emit the restored envelope's own fingerprint rather than demand a
      // source this client never had (a `done` hydrate is given none).
      return {
        hydrateVersion: HYDRATE_VERSION,
        blocks,
        sourceLength: this.hydratedLength,
        sourceHash: this.hydratedHash,
        done: this.hydratedDone,
      };
    }
    const src = source ?? this.retainedSource();
    if (src === null) {
      throw new Error(
        "brookmd: getPersistable() needs the source markdown to fingerprint, and this client " +
          "retains none (constructed with `recovery: false` and driven with append()). Pass it " +
          "explicitly: client.getPersistable(source).",
      );
    }
    return {
      hydrateVersion: HYDRATE_VERSION,
      blocks,
      sourceLength: src.length,
      sourceHash: sourceFingerprint(src),
      done: this.contentDone,
    };
  }

  /** The full driven document when this client happens to hold it: the recovery
   *  buffer is exactly that whenever `recovery` is on (the default), and
   *  setContent's baseline covers the recovery-off controlled-string mode.
   *  `null` means genuinely unknown — reachable only with recovery off AND
   *  manual appends. */
  private retainedSource(): string | null {
    if (this.recovery) return this.recoveryBuffer;
    if (this.lastContent.length > 0) return this.lastContent;
    // Nothing has been appended in this generation, so the driven document IS
    // the empty one — a real, correctly fingerprinted source. (Deliberately not
    // inferred from an empty store: a client that has appended has nothing
    // rendered either until its first patch comes back.)
    if (!this.appendedAny) return "";
    return null;
  }

  /**
   * Restore a {@link PersistableSnapshot} into an untouched client. The blocks
   * land in the store as ordinary committed blocks and `getSnapshot()` returns
   * them immediately, so the first paint already has the whole document —
   * **no worker is created, no WASM loads, nothing is parsed**. Reopening a
   * thread costs O(blocks) of JSON handling instead of O(source) of parsing.
   *
   * Call it on a fresh client before anything is appended and, ideally, before
   * the renderer mounts (hydrating an already-mounted client works — it
   * notifies subscribers — but costs an extra render). Hydrating a client that
   * already holds content throws.
   *
   * **Resuming a live thread.** A snapshot with `done: false` was still
   * streaming. Pass `source` — the markdown behind the snapshot — and the first
   * {@link append} rebuilds parser state in the background: the parser's
   * internals are an `Rc` graph with no serialized form, so continuing a
   * document genuinely requires re-parsing what came before it, but that cost
   * moves OFF the critical path. The hydrated blocks stay on screen and the
   * reader scrolls them while the worker catches up; new chunks queue behind the
   * re-feed and land the moment it does. Without `source` the thread is
   * view-only and appending throws — continuing a document correctly is not
   * possible without the text that precedes it.
   *
   * **Hydration does not verify the blocks against the source.** The snapshot is
   * trusted as produced; `sourceHash` exists so the CALLER can notice its stored
   * source moved on and re-stream instead of painting stale HTML. The resume
   * path re-checks it, lets the fresh parse win, and warns in dev.
   *
   * @throws if the envelope version is unknown, the snapshot is malformed, or
   *   this client already holds content. Validation completes before anything is
   *   written, so a rejected snapshot leaves the client exactly as it was.
   */
  hydrate(snapshot: PersistableSnapshot, opts?: { source?: string }): void {
    if (this.hydrated || this.pw !== null || this.getSnapshot().length > 0) {
      throw new Error(
        "brookmd: hydrate() must be called on an untouched client, before any " +
          "append()/setContent()/finalize(). Construct a new BrookClient (or reset() this one).",
      );
    }
    if (typeof snapshot !== "object" || snapshot === null) {
      throw new Error("brookmd: hydrate() expects a PersistableSnapshot object.");
    }
    if (snapshot.hydrateVersion !== HYDRATE_VERSION) {
      throw new Error(
        `brookmd: cannot hydrate a version ${String(snapshot.hydrateVersion)} snapshot — this ` +
          `build reads version ${HYDRATE_VERSION}. Discard it and re-stream the source.`,
      );
    }
    if (
      !Array.isArray(snapshot.blocks) ||
      typeof snapshot.done !== "boolean" ||
      typeof snapshot.sourceHash !== "string" ||
      typeof snapshot.sourceLength !== "number" ||
      !Number.isFinite(snapshot.sourceLength) ||
      snapshot.sourceLength < 0
    ) {
      throw new Error(
        "brookmd: malformed PersistableSnapshot (bad blocks / done / sourceHash / sourceLength).",
      );
    }
    // Build the whole store into locals and commit only once every block has
    // passed — see isPersistedBlock on why a half-restored store is worse than
    // a thrown error the caller can fall back from.
    const committed = new Map<number, Block>();
    const committedOrder: number[] = new Array(snapshot.blocks.length);
    for (let i = 0; i < snapshot.blocks.length; i++) {
      const b = snapshot.blocks[i];
      if (!isPersistedBlock(b)) {
        throw new Error(
          `brookmd: malformed PersistableSnapshot — block at index ${i} is not a Block.`,
        );
      }
      // The id is the React key / DOM node key AND the store's map key, so a
      // duplicate would leave committedOrder and `committed` disagreeing and
      // publish the same block at two positions.
      if (committed.has(b.id)) {
        throw new Error(`brookmd: malformed PersistableSnapshot — duplicate block id ${b.id}.`);
      }
      committedOrder[i] = b.id;
      committed.set(b.id, b);
    }
    // Copy the array (not the blocks): `store.snapshot` is compared BY
    // REFERENCE by the merge cache, so it must be ours, not one the caller may
    // still mutate. The blocks themselves stay shared — they are immutable by
    // the store contract, and copying them would defeat the whole point.
    this.store = { committed, committedOrder, active: [], snapshot: snapshot.blocks.slice() };
    this.hydrated = true;
    this.hydratedDone = snapshot.done;
    this.hydratedLength = snapshot.sourceLength;
    this.hydratedHash = snapshot.sourceHash;
    this.hydratedSource = snapshot.done ? null : opts?.source ?? null;
    // Seed setContent's diff baseline so a controlled-string caller handing back
    // `source + newTokens` takes the cheap prefix path (→ append(delta) →
    // resume) instead of diverging into a full reparse.
    if (this.hydratedSource !== null) this.lastContent = this.hydratedSource;
    this.contentDone = snapshot.done;
    // Normally there is nobody to tell yet; notify anyway so hydrating an
    // already-mounted client repaints instead of showing an empty document.
    this.emit(true);
  }

  /**
   * The first content-bearing op on a hydrated thread: give the parser back the
   * state it could not be handed.
   *
   * There is no way around re-parsing — the core keeps `Rc` graphs with no
   * `Deserialize` — but every part of that cost sits off the critical path. The
   * hydrated blocks are already painted and STAY painted: `softReset` preserves
   * them exactly as the setContent divergence swap does, so the reader keeps
   * reading and scrolling while the worker chews through the history on its own
   * thread. The caller's new chunks need no buffer of ours — `postMessage` is
   * FIFO per worker, so they queue behind the re-feed and are parsed the instant
   * it catches up. When the re-parse's patch lands, `mergeStale` adopts every
   * unchanged block BY REFERENCE (same object, same id), so the swap re-renders
   * and remounts nothing, and the live tail streams on from there.
   */
  private beginResume(): void {
    // An empty hydrate has no history for the parser to rebuild — there is
    // simply nothing to resume, so carry on as a fresh stream.
    if (this.hydratedLength === 0 && this.store.snapshot.length === 0) {
      this.retireHydration();
      return;
    }
    if (this.hydratedDone) {
      throw new Error(
        "brookmd: this client was hydrated from a FINALIZED snapshot (done: true), and a " +
          "completed thread cannot be appended to. Call reset() to start a new stream, or " +
          "hydrate a `done: false` snapshot with its `source` to resume one.",
      );
    }
    const source = this.hydratedSource;
    if (source === null) {
      throw new Error(
        "brookmd: cannot append to a hydrated client without its source. Continuing a document " +
          "means re-parsing the text that came before it — pass it at hydrate time: " +
          "client.hydrate(snapshot, { source }).",
      );
    }
    // Latch BEFORE re-feeding: the append at the bottom re-enters append().
    this.retireHydration();
    if (
      typeof process !== "undefined" &&
      process.env.NODE_ENV !== "production" &&
      (source.length !== this.hydratedLength || sourceFingerprint(source) !== this.hydratedHash)
    ) {
      // The stored source is not the one these blocks came from. Not fatal: the
      // re-parse below is authoritative, and mergeStale swaps the changed blocks
      // in (trimming to the new length on the terminal patch), so the document
      // self-heals to the source. Say so anyway — the caller's persistence has
      // drifted, and next time it should re-stream instead of hydrating.
      warnOnce(
        "hydrate-stale",
        "brookmd: the source passed to hydrate() does not match the snapshot's fingerprint, so " +
          "the resume re-parse will replace the hydrated blocks. Compare `snapshot.sourceHash` " +
          "with `sourceFingerprint(source)` before hydrating and re-stream when they differ.",
      );
    }
    // Keep the hydrated view on screen across the rebuild, exactly as a
    // setContent divergence swap does — this IS that swap, with the "old"
    // document restored from JSON instead of parsed.
    this.softReset(this.getSnapshot());
    this.append(source);
  }

  /** The resume re-feed is no longer wanted: either it has just been issued, or
   *  the caller took over by driving the whole document itself. Releases the
   *  retained source so one document, not two, stays in memory. */
  private retireHydration(): void {
    this.resumed = true;
    this.hydratedSource = null;
  }

  /** Drop every trace of a hydrate. An explicit reset() is a brand-new
   *  document, so a restored view must not keep intercepting appends or re-feed
   *  a source that is no longer the one being streamed. */
  private clearHydration(): void {
    this.hydrated = false;
    this.resumed = false;
    this.hydratedDone = false;
    this.hydratedSource = null;
    this.hydratedLength = 0;
    this.hydratedHash = "";
  }

  reset() {
    // Only notify subscribers if there was content to clear: resetting an
    // already-empty store leaves the view empty either way, so skip the no-op
    // emit (which would otherwise drive every subscriber through a wasted,
    // output-identical render pass). "Content" is the DISPLAYED view — a
    // preserved divergence merge counts even when the raw store is empty.
    const hadContent = this.getSnapshot().length > 0;
    this.staleSnapshot = null;
    this.staleTrimmed = false;
    this.mergeCache = null;
    // An explicit caller reset() clears the terminal-failure state and re-arms
    // recovery: the caller is starting fresh (and resetParser → ensureAcquired
    // below binds a live worker again). softReset (the recovery re-feed's path)
    // deliberately does NOT touch these — only an explicit reset() does.
    this.failedError = null;
    this.recoveryAttempted = false;
    this.pendingRebind = false; // this reset IS the fresh generation
    this.clearHydration(); // ...and a fresh generation is no longer a restored one
    this.resetParser();
    if (hadContent) this.emit(true); // clear-the-view notify is synchronous
  }

  /**
   * setContent's divergence reset: rebuild the parser exactly like {@link reset},
   * but keep `preserve` (the currently displayed view) on screen while the new
   * content reparses. No notify fires here — subscribers keep reading the same
   * snapshot reference until the first new-generation patch merges over it, so
   * the swap is seamless: no empty frame, no container collapse, no scroll
   * clamp, and blocks whose content survives the reprocess never re-render.
   */
  private softReset(preserve: Block[]) {
    this.staleSnapshot = preserve;
    this.staleTrimmed = false;
    this.idNamespace += ID_NAMESPACE_STRIDE;
    this.resetParser();
    // Seed the merge cache with the captured view keyed to the fresh (empty)
    // store: getSnapshot() keeps returning the exact pre-reset reference, so a
    // render between now and the first patch is a pure no-op.
    this.mergeCache = { base: this.store.snapshot, trimmed: false, view: preserve };
  }

  /**
   * Finish a preserved-view divergence swap by making the merged view THE
   * store: adopted ids become the committed keys, the merged array becomes the
   * snapshot, and every scrap of merge state drops. From here getSnapshot() is
   * a plain field read again (zero steady-state overhead) and the superseded
   * generation's blocks are garbage — only one document stays in memory.
   * Runs on the terminal (final) patch, which commits everything — if anything
   * is somehow still open, the lazy merge simply stays live instead (the
   * incremental reuse keeps it linear).
   */
  private collapseStale() {
    if (this.store.active.length > 0) return;
    const view = this.getSnapshot(); // final merged view (staleTrimmed is set)
    const committed = new Map<number, Block>();
    const committedOrder: number[] = new Array(view.length);
    for (let i = 0; i < view.length; i++) {
      committedOrder[i] = view[i].id;
      committed.set(view[i].id, view[i]);
    }
    this.store = { committed, committedOrder, active: [], snapshot: view };
    this.staleSnapshot = null;
    this.staleTrimmed = false;
    this.mergeCache = null;
  }

  // Shared generation teardown: swap in an empty store, zero the metrics and
  // the setContent baseline, invalidate any coalesced frame, bump the epoch,
  // and tell the worker to drop the parser. View concerns (stale preservation,
  // subscriber notify) belong to the callers — reset() and softReset().
  private resetParser() {
    this.store = emptyBlockStore();
    this.appendedBytes = 0;
    this.patchCount = 0;
    this.totalParseMicros = 0;
    this.lastPatchMs = 0;
    this.firstAppendMs = 0;
    this.retainedBytes = 0;
    this.wasmMemoryBytes = 0;
    this.appendedAny = false;
    this.lastContent = ""; // setContent baseline: the worker drops the parser here
    this.contentDone = false;
    // Clear the recovery buffer: the worker's parser is being dropped, so the
    // buffer is re-accumulated by the append(s) that re-feed the fresh parser
    // (recover()'s refeed rebuilds it to the full doc; a plain reset leaves it
    // empty until the caller drives new content). recoveredLen resets to the
    // pending sentinel — recover() overwrites it AFTER its refeed.
    this.recoveryBuffer = "";
    this.recoveredLen = Infinity;
    // A frame coalesced from the just-cleared stream is now stale — cancel it so
    // it can't fire a notify referencing content reset() just dropped.
    this.cancelFrame();
    this.finalizePending = false;
    // Bump the generation: any patch the worker already emitted for the content
    // we just cleared is now a straggler and will be dropped on arrival (it would
    // otherwise re-add ghost blocks to the empty store).
    this.epoch += 1;
    // Same streamId + worker — the worker frees and lazily recreates the parser.
    const pw = this.ensureAcquired();
    this.pool.send(pw, { type: "reset", streamId: this.streamId, epoch: this.epoch });
  }

  destroy() {
    if (!this.attached) return; // idempotent
    // Free this stream's parser; the shared worker stays warm for siblings.
    // Only release a real slot — a never-acquired client (constructed during an
    // SSR render then unmounted) has no pool slot to free, so skip the call.
    // We deliberately do NOT null this.pw here: StrictMode's destroy()→reattach()
    // on the SAME instance needs the same pw/streamId to re-register.
    if (this.pw) this.pool.release(this.streamId, this.pw);
    // Drop any pending coalesced frame so it can't fire into cleared listeners.
    this.cancelFrame();
    this.finalizePending = false;
    this.listeners.clear();
    this.attached = false;
  }

  /**
   * Re-register with the pool after {@link destroy} so the client receives
   * patches again. Needed only for React StrictMode's dev double-mount, where
   * the renderer destroys on the simulated unmount then remounts the SAME
   * client instance; apps don't normally call this. No-op if still attached.
   */
  reattach() {
    if (this.attached) return;
    // The prior destroy()→dispose dropped this stream's parser, so setContent's
    // diff baseline is stale — clear it so the next setContent re-feeds the whole
    // document (StrictMode dev double-mount on the SAME instance).
    this.lastContent = "";
    this.contentDone = false;
    if (!this.pw) {
      // Never acquired (e.g. constructed during SSR, first real mount on client).
      // No prior pool slot to re-register; just mark attached. The next
      // worker-bound op acquires lazily. configSent is already false, so the
      // first append will carry config exactly as a brand-new client would.
      this.attached = true;
      return;
    }
    this.pool.reattach(this.streamId, this.pw, (msg) => this.onMessage(msg));
    this.attached = true;
    // The worker discarded this stream's config on `dispose` (unlike `reset`,
    // which keeps it), so re-send it on the next message — otherwise the parser
    // would be rebuilt with library defaults (gfmMath / componentTags / … lost).
    this.configSent = false;
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): Block[] => {
    const base = this.store.snapshot;
    if (!this.staleSnapshot) return base;
    const cache = this.mergeCache;
    if (cache && cache.base === base && cache.trimmed === this.staleTrimmed) return cache.view;
    // Reuse the previous merge's decisions only within the same trim phase —
    // a trim changes the rules, so it clears the cache and recomputes once.
    const view = this.mergeStale(base, cache && cache.trimmed === this.staleTrimmed ? cache : null);
    if (this.mergeDropped) {
      this.mergeDropped = false;
      this.mergeCache = null; // indices are compacted; not a valid decision table
    } else {
      this.mergeCache = { base, trimmed: this.staleTrimmed, view };
    }
    return view;
  };

  /**
   * Positional merge of the preserved pre-divergence view over the rebuilding
   * store (see {@link softReset}). Per position:
   *   - identical committed block (html + kind + open + speculative) → the OLD
   *     block object, so its id and reference survive the swap and the block
   *     never re-renders (blocksEqual / the DOM keyed reconcile hold);
   *   - changed committed block → the new block CARRYING THE OLD BLOCK'S id, so
   *     the same keyed component re-renders in place and its state (pagination,
   *     expansion…) survives the swap; only a NET-NEW position (past the old
   *     document's end) takes a namespace-offset id, where a raw parser id
   *     could genuinely collide with a retained old id;
   *   - still-open block over old content → the old block (never a shrinking
   *     partial where complete content was already on screen); past the old
   *     document's end the live tail streams in as-is;
   *   - position the reparse hasn't reached → the old block, until the terminal
   *     patch sets `staleTrimmed` and the view clamps to the new length.
   *
   * LINEARITY: committed blocks are reference-stable across patches (the store
   * contract), so a base entry pointer-equal to the previous merge's reproduces
   * its previous decision without re-running the O(html) equality compare. Each
   * block is string-compared exactly once — when it first commits — keeping a
   * long post-divergence stream linear instead of quadratic. Only the active
   * tail (fresh references each patch, small by design) re-compares per patch.
   */
  private mergeStale(base: Block[], prev: { base: Block[]; view: Block[] } | null): Block[] {
    const stale = this.staleSnapshot!;
    const len = this.staleTrimmed ? base.length : Math.max(base.length, stale.length);
    const view: Block[] = new Array(len);
    let dropped = false;
    for (let i = 0; i < len; i++) {
      const nb = i < base.length ? base[i] : undefined;
      if (nb !== undefined && prev !== null && i < prev.base.length && prev.base[i] === nb) {
        view[i] = prev.view[i]; // same inputs (nb ref, fixed stale, same phase) → same decision
        continue;
      }
      const ob = i < stale.length ? stale[i] : undefined;
      if (!nb) {
        // Unreachable given `len` above: !nb means i >= base.length, which when
        // untrimmed implies i < stale.length, and when trimmed cannot happen at
        // all (len === base.length). If the length rule ever changes, drop the
        // position instead of publishing a hole into the rendered view.
        if (ob === undefined) {
          dropped = true;
          continue;
        }
        view[i] = ob;
        continue;
      }
      if (ob) {
        if (nb.open && !this.staleTrimmed) {
          view[i] = ob;
          continue;
        }
        if (
          nb.html === ob.html &&
          nb.kind.type === ob.kind.type &&
          nb.open === ob.open &&
          nb.speculative === ob.speculative
        ) {
          view[i] = ob;
          continue;
        }
        // CHANGED block replacing an old one positionally: adopt the OLD id.
        // The id is the React key / DOM node key, so this re-renders the same
        // component instance in place — a stateful override (a paginated table,
        // an expanded <details>) keeps its state when a reprocess swap edits
        // its content. Uniqueness holds: each old id is reused at exactly its
        // own position. The namespace stride below is only for NET-NEW
        // positions, where a raw parser id could genuinely collide.
        view[i] = { ...nb, id: ob.id };
        continue;
      }
      view[i] = { ...nb, id: this.idNamespace + nb.id };
    }
    if (dropped) {
      if (typeof process !== "undefined" && process.env.NODE_ENV !== "production") {
        warnOnce("merge-hole", "brookmd: the stale-merge produced an empty position — compacting.");
      }
      // Compacted indices no longer line up with `base`, so the caller must not
      // cache this view as a per-index decision table for the next merge.
      this.mergeDropped = true;
      return view.filter((b): b is Block => b !== undefined);
    }
    return view;
  }

  /**
   * Internal: a renderer with an `onRenderMetrics` hook calls this once per
   * actual React block render so `getMetrics().renderCount` aggregates churn.
   * No-op cost when no hook is wired (it is simply never called). Not part of
   * the public API surface — the underscore marks it renderer-internal.
   */
  __noteRender(): void {
    this.renderCount++;
  }

  /**
   * Internal: the DOM renderer calls this once per actual node rebuild (the
   * changed-block branch) when an `onRenderMetrics` hook is wired, so
   * `getMetrics().rebuildCount` aggregates churn. Never called without a hook.
   */
  __noteRebuild(): void {
    this.rebuildCount++;
  }

  getMetrics() {
    const elapsed = this.firstAppendMs ? Math.max(1, performance.now() - this.firstAppendMs) : 1;
    return {
      bytes: this.appendedBytes,
      patches: this.patchCount,
      meanParseMicros: this.patchCount > 0 ? this.totalParseMicros / this.patchCount : 0,
      totalParseMs: this.totalParseMicros / 1000,
      throughputKBs: (this.appendedBytes / 1024) / (elapsed / 1000),
      committedBlocks: this.store.committed.size,
      activeBlocks: this.store.active.length,
      lastPatchAgoMs: this.lastPatchMs === 0 ? 0 : performance.now() - this.lastPatchMs,
      retainedBytes: this.retainedBytes,
      // NOTE: with the worker pool, this is the *shared* worker's WASM heap —
      // clients on the same worker report the same number. Use Math.max (not
      // sum) when aggregating across clients; summing double-counts.
      wasmMemoryBytes: this.wasmMemoryBytes,
      // Render-path churn (0 unless an onRenderMetrics hook is wired into a
      // renderer): renderCount = React block-body renders, rebuildCount = DOM
      // node rebuilds. Committed blocks memo-skip, so they contribute once.
      renderCount: this.renderCount,
      rebuildCount: this.rebuildCount,
    };
  }

  /**
   * A heading outline of the current snapshot (committed + active), in document
   * order — for a table of contents. Works mid-stream; entries appear as their
   * headings stream in. The `id` is stable, so a built ToC won't re-key.
   */
  outline(): OutlineEntry[] {
    const out: OutlineEntry[] = [];
    // Read the DISPLAYED view (getSnapshot), not the raw store: during/after a
    // divergence swap the merged view is what's rendered, and outline ids are
    // documented as scroll targets / React keys — they must match those blocks.
    for (const b of this.getSnapshot()) {
      if (b.kind.type === "Heading") {
        // `kind.data` is the bare level `number` when `blockData` is off, or the
        // `{ level, text, id }` object when on — accept both. `OutlineEntry.id`
        // stays the numeric block id (stable, non-breaking); the anchor slug is
        // reachable additively via `kind.data.id` for consumers who want it.
        const d = b.kind.data as number | { level?: number } | undefined;
        const level = typeof d === "number" ? d : d?.level ?? 1;
        out.push({ level, text: htmlToText(b.html), id: b.id });
      }
    }
    return out;
  }

  /**
   * The rendered document as plain text — tags stripped, entities decoded,
   * blocks separated by blank lines. Derived from the rendered HTML (the source
   * markdown is parsed away in WASM and not retained client-side), so it is a
   * readable approximation for search indexing / summaries, not a round-trip of
   * the original source.
   */
  toPlaintext(): string {
    const parts: string[] = [];
    for (const b of this.getSnapshot()) {
      const t = htmlToText(b.html);
      if (t) parts.push(t);
    }
    return parts.join("\n\n");
  }

  private onMessage(msg: FromWorker) {
    switch (msg.type) {
      case "patch": {
        // The worker forwards the WASM patch as a JSON string (cheap to clone);
        // parse it once here on the main thread. A malformed patch must surface
        // via onError, not throw inside the message handler (which would break the
        // pool's dispatch loop for every stream on the worker).
        // Drop a straggler patch produced before the latest reset(): applying it
        // would repopulate the just-cleared store with ghost blocks. (epoch is
        // absent only from a pre-epoch fake message in tests → never dropped.)
        if (msg.epoch !== undefined && msg.epoch < this.epoch) break;
        let patch: Patch;
        try {
          patch = JSON.parse(msg.patch) as Patch;
          // applyPatch is inside the try: a wire-delta reconstruction failure
          // (a splice without its base — dropped/reordered patches) is the
          // same protocol-corruption class as unparseable JSON and must
          // surface via onError, not break the pool's dispatch loop.
          applyPatch(this.store, patch);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          if (this.onError) this.onError({ message: `brookmd: malformed patch (${message})` });
          // eslint-disable-next-line no-console
          else console.error("brookmd: malformed patch:", message);
          break;
        }
        // NOTE: a successful patch deliberately does NOT re-arm recovery — see
        // `recoveryAttempted`. Re-arming is driven by caller content advancing in
        // setContent(), not by the recovered doc's own append patch (which would
        // loop a finalize()-that-traps document endlessly).
        // The reparse behind a preserved divergence view is complete: stop
        // padding with the old document's tail, so a shorter replacement trims
        // to the new length on this very notify. Keyed on msg.final ONLY —
        // finalizePending can be consumed by an earlier in-flight append patch
        // (see below), and trimming there would chop the old tail mid-reparse.
        if (msg.final === true && this.staleSnapshot) {
          this.staleTrimmed = true;
          this.mergeCache = null;
          this.collapseStale();
        }
        this.appendedBytes = msg.appendedBytes;
        this.totalParseMicros += msg.parseMicros;
        this.retainedBytes = msg.retainedBytes;
        this.wasmMemoryBytes = msg.wasmMemoryBytes;
        this.patchCount += 1;
        this.lastPatchMs = performance.now();
        // The post-finalize (done) patch must notify synchronously — never defer
        // stream completion to the next frame. `msg.final` tags the ACTUAL
        // terminal patch at its source, so the sync flush binds to it regardless
        // of how many append patches preceded it (the one-shot `finalizePending`
        // alone could be consumed by an earlier in-flight append patch).
        const sync = this.finalizePending || msg.final === true;
        this.finalizePending = false;
        this.emit(sync);
        // After subscribers see the new snapshot, fire the per-block hook for
        // anything that just committed (document order). A throw here is
        // isolated by the pool's dispatch boundary and won't skip emit().
        if (this.onBlock) {
          for (const b of patch.newly_committed) this.onBlock(b);
        }
        break;
      }
      case "error": {
        // A non-fatal (per-stream parse) error just surfaces — it doesn't kill
        // the worker, so there is nothing to recover and `failed` stays null.
        if (!msg.fatal) {
          this.reportError(msg.message, msg.fatal);
          break;
        }
        // A fatal worker death. With recovery on and a buffered document (any
        // mode — append/pipeFrom AND setContent both accumulate into
        // recoveryBuffer), a transient death heals invisibly: re-acquire a fresh
        // worker and re-feed the buffer exactly once. Clients with recovery off,
        // an empty buffer, or an already-spent one-shot skip to surfacing.
        if (this.recovery && this.recoveryBuffer.length > 0 && !this.recoveryAttempted) {
          this.recoveryAttempted = true;
          // Pending-gate: while the recovery microtask is queued, a stray append
          // must not trip append()'s growth re-arm — Infinity makes the
          // `buffer.length > recoveredLen` check impossible until recover() sets
          // the real length after its re-feed.
          this.recoveredLen = Infinity;
          // Defer out of the pool's fatal fan-out: re-acquiring here would mutate
          // pool state mid-iteration over the failed worker's stream set. The
          // microtask runs after fail() has fully unwound, reading the buffer at
          // execution time so a chunk that interleaves ahead of it is included.
          // `failed` stays null and onError does NOT fire — the heal is invisible.
          queueMicrotask(() => this.recover());
          break;
        }
        // No recoverable baseline, recovery disabled, or the re-feed's replacement
        // worker also died: this is terminal. Record it (surfaces via `failed`)
        // and fire onError just as before.
        this.failedError = new Error(msg.message);
        this.reportError(msg.message, msg.fatal);
        break;
      }
    }
  }

  // Surface a worker error to the caller's onError, falling back to console.
  private reportError(message: string, fatal?: boolean): void {
    if (this.onError) {
      this.onError({ message, fatal });
    } else {
      // eslint-disable-next-line no-console
      console.error("brookmd worker error:", message);
    }
  }

  /**
   * One-shot self-heal after a transient worker death, for BOTH drive modes.
   * The dead worker was already evicted, so redriving the buffered document
   * re-acquires a FRESH worker (ensureAcquired re-acquires because the old
   * `pw.failed` is set). Reads the buffer at EXECUTION time, so a chunk that
   * interleaved ahead of this microtask is included. Deliberately does NOT route
   * through setContent(): that would stamp `lastContent`, flipping an append-mode
   * client into setContent mode, and a second death would then re-feed a stale
   * `lastContent` missing post-recovery chunks. `recoveryAttempted` is NOT reset
   * here — if the replacement also dies before healing, the fatal path sees the
   * flag still set and surfaces the error instead of looping.
   */
  private recover(): void {
    // The client was torn down between the failure and this deferred re-feed —
    // don't re-acquire a worker for an unmounted stream.
    if (!this.attached) return;
    const doc = this.recoveryBuffer; // execution-time read: folds in any stray chunk
    const done = this.contentDone;
    this.refeed(doc, done);
    // AFTER the refeed (whose resetParser reset recoveredLen to Infinity): the
    // baseline length a future live append must exceed to re-arm. Until it does,
    // an identical setContent (content === recoveryBuffer) is treated as the
    // poison doc replaying (the divergence guard's `!== recoveryBuffer`).
    this.recoveredLen = doc.length;
    // refeed's resetParser cleared lastContent; restore it to the re-fed doc so
    // a setContent-mode client's diff baseline stays accurate (its next
    // setContent diffs against the doc actually on the worker instead of forcing
    // a full re-feed). Harmless in append mode — lastContent is read only by
    // setContent. NOT the same as routing recovery through setContent: the
    // re-feed above used recoveryBuffer, so no stale-lastContent re-feed bug.
    this.lastContent = doc;
  }

  /**
   * Rebuild the parser onto a fresh worker and re-feed `doc` as one atomic
   * append (re-accumulating recoveryBuffer). Keeps the displayed view on screen
   * across the swap by softReset-ing when something is rendered, so the document
   * never blanks; falls back to a bare resetParser when the store is empty.
   * Uses resetParser / softReset (NOT reset(), which would clear the one-shot
   * recovery guards mid-heal). Re-finalizes when the buffered doc was finalized.
   */
  private refeed(doc: string, done: boolean): void {
    const displayed = this.getSnapshot();
    if (displayed.length > 0) this.softReset(displayed);
    else this.resetParser();
    // The reset above IS the new generation (softReset even preserves the view
    // across it), so the pending-rebind restart must not fire again inside the
    // append below and blank what we just preserved.
    this.pendingRebind = false;
    this.append(doc);
    if (done) this.finalize();
  }

  /**
   * Notify subscribers of a new snapshot.
   *
   * With `coalesce` off (default) this is fully synchronous, exactly as before.
   * With it on and `requestAnimationFrame` available, a normal emit only
   * *schedules* a single per-frame flush — repeated intra-frame emits collapse
   * into one notify. `sync` forces an immediate flush (stream completion / reset)
   * and cancels any frame already pending so the snapshot is delivered once.
   */
  private emit(sync = false) {
    if (this.coalesce && !sync && typeof requestAnimationFrame === "function") {
      if (this.rafHandle !== null) return; // a flush is already scheduled this frame
      this.rafHandle = requestAnimationFrame(() => {
        this.rafHandle = null;
        this.flushNow();
      });
      return;
    }
    // Synchronous path: drop any pending frame so its notify can't double-fire
    // after this one, then flush immediately.
    this.cancelFrame();
    this.flushNow();
  }

  private flushNow() {
    for (const fn of this.listeners) fn();
  }

  private cancelFrame() {
    if (this.rafHandle !== null) {
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
  }
}
