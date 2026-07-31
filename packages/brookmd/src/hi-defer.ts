import { stepHighlight, type HighlightState } from "./hi";

/**
 * Non-blocking driver for the in-house highlighter.
 *
 * Highlighting runs once, when a fence CLOSES — but on a big block that one
 * tokenizer pass is tens of milliseconds of unbroken main-thread work landing
 * in a single task, right in the middle of a stream. This spreads it over
 * budgeted slices instead: the first slice runs synchronously in the caller's
 * own tick (so an ordinary block still highlights with no extra paint and no
 * flash of plain code), and only a block that outruns that budget continues on
 * later tasks, yielding to the browser between slices.
 *
 * The output is byte-identical either way — `stepHighlight` is a pure resumable
 * pass over immutable input, so where the slices fall cannot change a byte of
 * the markup. Only WHEN the markup appears changes.
 */

/** Main-thread milliseconds one slice may spend tokenizing before it yields. */
const SLICE_MS = 5;
/** Source characters per clock read — small enough that a slice overruns its
 *  budget by well under a frame, large enough that `now()` stays noise. */
const CHUNK = 1024;

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

// The live budget. Only the test-only setter below ever changes it.
let sliceMs = SLICE_MS;

/**
 * Test-only: shrink the per-slice budget so a suite can force the deferred path
 * deterministically instead of betting on how fast the machine is. Call with no
 * argument to restore the default. Not part of the public API.
 */
export function __setSliceMs(ms?: number): void {
  sliceMs = ms === undefined ? SLICE_MS : ms;
}

export interface DeferredHighlight {
  /**
   * The finished markup when the whole block tokenized inside the first
   * (synchronous) slice — the common case. Apply it in this same tick: no
   * swap, no second paint, no flash.
   */
  html: string | null;
  /**
   * Resolves with the finished markup once the remaining slices have run, or
   * with `null` if the run was {@link DeferredHighlight.cancel}led. `null` (the
   * property, not the resolution) when `html` already holds the answer. Never
   * rejects.
   */
  rest: Promise<string | null> | null;
  /** Abandon the remaining slices — the block was superseded or unmounted. */
  cancel(): void;
}

const noop = (): void => {};

/**
 * A fresh cursor, or a COPY of the caller's seed.
 *
 * A seed is the frozen prefix a block accumulated while it streamed (see
 * hi-inc.ts): `pos` is a source offset the tokenizer is known to land on as a
 * token boundary, `out` the markup for everything before it. Because
 * `stepHighlight` carries no state between tokens, resuming there emits exactly
 * the bytes a run from 0 would have emitted from that point on — so a block that
 * streamed in only has to tokenize its unfrozen tail, and still settles to
 * markup byte-identical to a one-shot `highlight()`. Copying keeps the caller's
 * state immutable: the run advances its own cursor, not the block's.
 */
function seeded(seed?: HighlightState): HighlightState {
  return seed === undefined ? { pos: 0, out: "" } : { pos: seed.pos, out: seed.out };
}

/**
 * Tokenize `code` for at most one slice and return the finished markup, or
 * `null` when it did not fit. Pure and synchronous — it schedules nothing, so a
 * renderer can call it from a render pass and only reach for
 * {@link highlightDeferred} when this comes back empty.
 */
export function highlightWithin(code: string, lang: string, seed?: HighlightState): string | null {
  const state = seeded(seed);
  return runSlice(code, lang, state) ? state.out : null;
}

/**
 * Highlight `code` without blocking: the first slice runs here, synchronously,
 * and the rest (if any) continues on later tasks. See {@link DeferredHighlight}.
 */
export function highlightDeferred(
  code: string,
  lang: string,
  seed?: HighlightState,
): DeferredHighlight {
  const state = seeded(seed);
  if (runSlice(code, lang, state)) {
    return { html: state.out, rest: null, cancel: noop };
  }

  let cancelled = false;
  // One channel per RUN (a handful per document at most), closed when the run
  // ends — a module-level port would outlive every highlight and keep a
  // non-browser host's event loop referenced.
  let channel: MessageChannel | null = null;
  let pending: (() => void) | null = null;

  function closeChannel(): void {
    if (channel !== null) {
      channel.port1.close();
      channel.port2.close();
      channel = null;
    }
    pending = null;
  }

  function post(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (typeof MessageChannel !== "function") {
        // No MessageChannel (a non-DOM host): a 0 ms timer is the last resort.
        // It is what the clamp makes it, which is exactly why it is last.
        setTimeout(resolve, 0);
        return;
      }
      if (channel === null) {
        channel = new MessageChannel();
        channel.port1.onmessage = () => {
          const next = pending;
          pending = null;
          if (next) next();
        };
      }
      pending = resolve;
      channel.port2.postMessage(0);
    });
  }

  // Hand the main thread back between slices. `scheduler.yield()` (where it
  // exists) resumes at the FRONT of the task queue, so a half-highlighted block
  // is not stuck behind unrelated work; a MessageChannel post is the portable
  // equivalent — a real task with none of `setTimeout`'s nesting clamp, and
  // unlike `requestIdleCallback` it can neither be starved by a busy stream nor
  // be missing entirely (Safari).
  function nextTask(): Promise<void> {
    const scheduler = (globalThis as { scheduler?: { yield?: () => unknown } }).scheduler;
    if (scheduler && typeof scheduler.yield === "function") {
      try {
        const p = scheduler.yield() as Promise<void> | undefined;
        if (p && typeof p.then === "function") return p.then(undefined, post);
      } catch {
        /* fall through to the port hop */
      }
    }
    return post();
  }

  const rest = (async () => {
    try {
      for (;;) {
        await nextTask();
        // Cancelled while we were away: drop the partial work and settle so the
        // awaiting renderer's handler can bail out.
        if (cancelled) return null;
        if (runSlice(code, lang, state)) return state.out;
      }
    } finally {
      closeChannel();
    }
  })();

  return {
    html: null,
    rest,
    cancel() {
      // Deliberately does NOT close the channel: the in-flight port message is
      // what wakes the loop up to observe the flag and settle `rest`.
      cancelled = true;
    },
  };
}

/** Tokenize until the budget is spent. Returns true when `code` is finished. */
function runSlice(code: string, lang: string, state: HighlightState): boolean {
  const started = now();
  for (;;) {
    if (stepHighlight(code, lang, state, CHUNK)) return true;
    if (now() - started >= sliceMs) return false;
  }
}
