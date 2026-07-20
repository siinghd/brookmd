// The JS backend that plugs the native (uniffi/JSI) parser into flux-md's
// existing streaming client. flux-md's browser build runs each stream's parser
// in a Web Worker; React Native has no Worker, so instead of a real thread we
// wrap flux-md's `WorkerCore` (the worker's message/readiness state machine,
// extracted precisely so it can run anywhere) in a synchronous, in-process
// `WorkerLike`. The pool + client on top are the SAME `FluxPool` / `FluxClient`
// the browser uses — only the transport differs.
//
// The native parser itself is dependency-injected: `createNativePool()` defaults
// to the ubrn-generated `FluxSession` (registered by the package entry via
// `registerNativeParser`), but a caller — notably the host test-suite — can pass
// its own `makeParser`, e.g. one backed by the WASM parser, to exercise the whole
// stack off-device.
import { FluxClient, FluxPool } from "flux-md/client";
import { WorkerCore, type ParserLike } from "flux-md/worker-core";
import type { FromWorker, ParserConfig, ToWorker, WorkerLike } from "flux-md/types";

/** A parser factory: create + configure one `ParserLike` for a stream. */
export type MakeParser = (config: ParserConfig | undefined) => ParserLike;

// The native parser factory, registered by the package entry (`src/index.tsx`)
// so the ubrn TurboModule is only loaded on-device. Left null in host tests,
// which always inject their own `makeParser`.
let nativeParserFactory: MakeParser | null = null;

/** Wire the on-device native parser factory. Called once by the package entry. */
export function registerNativeParser(factory: MakeParser): void {
  nativeParserFactory = factory;
}

function defaultMakeParser(config: ParserConfig | undefined): ParserLike {
  if (!nativeParserFactory) {
    throw new Error(
      "flux-md-react-native: native parser not registered. Import from the package " +
        "entry (`flux-md-react-native`) so the uniffi TurboModule is wired, or pass " +
        "`createNativePool({ makeParser })` with your own parser.",
    );
  }
  return nativeParserFactory(config);
}

/**
 * A synchronous, in-process `WorkerLike` backing one flux-md pool "worker".
 *
 * It hands every `ToWorker` message straight to a `WorkerCore` and forwards the
 * `WorkerCore`'s `FromWorker` output to the registered listeners — the exact
 * envelopes the browser worker posts over `postMessage`, so `FluxPool` /
 * `FluxClient` cannot tell the difference. One `NativeWorker` multiplexes many
 * streams by id, just like one browser worker does.
 */
class NativeWorker implements WorkerLike {
  private core: WorkerCore;
  private listeners = new Set<(ev: { data: FromWorker }) => void>();

  constructor(makeParser: MakeParser) {
    this.core = new WorkerCore({
      makeParser: (config) => makeParser(config),
      post: (msg) => this.deliver(msg),
      // No WASM heap to report — the native core owns its memory outside JS.
      // (Per-session cost is still surfaced via `retainedBytes` on each patch.)
      memBytes: () => 0,
      schedule: (fn) => queueMicrotask(fn),
    });
    // The browser worker opens its readiness gate only after async WASM init.
    // The native module is ready synchronously, but the pool attaches its
    // message listener AFTER this constructor returns — so defer `markReady` to a
    // microtask, guaranteeing the `{ type: "ready" }` envelope is delivered to a
    // listener rather than dropped. Appends that arrive first are buffered by
    // WorkerCore and drained on markReady, exactly as in the browser.
    queueMicrotask(() => this.core.markReady());
  }

  postMessage(msg: ToWorker): void {
    this.core.handle(msg);
  }

  addEventListener(_type: "message", listener: (ev: { data: FromWorker }) => void): void {
    this.listeners.add(listener);
  }

  terminate(): void {
    this.listeners.clear();
  }

  private deliver(msg: FromWorker): void {
    // The pool attaches exactly one listener per worker (the always case), so skip
    // the defensive array snapshot then. Snapshot only when there are 2+, where a
    // listener could (in principle) mutate the set mid-iteration.
    if (this.listeners.size === 1) {
      for (const l of this.listeners) l({ data: msg });
    } else {
      for (const l of [...this.listeners]) l({ data: msg });
    }
  }
}

/**
 * Build a `FluxPool` whose "workers" are in-process `NativeWorker`s. The cap is
 * 1: there is no thread to oversubscribe, so a single `WorkerCore` multiplexes
 * every stream (keyed by stream id) — identical to how one browser worker hosts
 * many parsers.
 *
 * @param opts.makeParser override the parser factory (default: the registered
 *   native `FluxSession`). Host tests pass a WASM-backed factory here.
 */
export function createNativePool(opts: { makeParser?: MakeParser } = {}): FluxPool {
  const makeParser = opts.makeParser ?? defaultMakeParser;
  return new FluxPool(() => new NativeWorker(makeParser), 1);
}

// The process-wide native pool every `createFluxClient()` shares unless given a
// pool or a custom `makeParser`.
let defaultNativePool: FluxPool | null = null;

/** The shared process-wide native pool (created lazily). */
export function getDefaultNativePool(): FluxPool {
  if (!defaultNativePool) defaultNativePool = createNativePool();
  return defaultNativePool;
}

/** TEST-ONLY: drop the shared native pool so the next call rebuilds it. */
export function __resetDefaultNativePool(): void {
  defaultNativePool = null;
}

/**
 * Convenience wrapper over `new FluxClient({ pool: createNativePool() })`. The
 * returned client behaves exactly like flux-md's browser client (`append`,
 * `finalize`, `setContent`, `subscribe`, `getSnapshot`, `pipeFrom`, …) but runs
 * the native parser in-process.
 *
 * @param options.pool       join an existing pool (else the shared native pool).
 * @param options.makeParser override the parser factory (creates a dedicated pool).
 * @param options.config     per-stream {@link ParserConfig} (immutable per stream).
 * @param options.onError    worker/parse error callback.
 * @param options.onBlock    per-commit callback.
 * @param options.coalesce   collapse intra-frame notifies (default false).
 */
export function createFluxClient(
  options: {
    pool?: FluxPool;
    makeParser?: MakeParser;
    config?: ParserConfig;
    onError?: (err: { message: string; fatal?: boolean }) => void;
    onBlock?: (block: import("flux-md/types").Block) => void;
    coalesce?: boolean;
  } = {},
): FluxClient {
  const pool =
    options.pool ?? (options.makeParser ? createNativePool({ makeParser: options.makeParser }) : getDefaultNativePool());
  return new FluxClient({
    pool,
    config: options.config,
    onError: options.onError,
    onBlock: options.onBlock,
    coalesce: options.coalesce,
  });
}
