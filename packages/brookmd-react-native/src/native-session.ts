// The ON-DEVICE default parser: adapts the ubrn-generated `BrookSession`
// (JSI/uniffi over `brookmd-ffi`) to brookmd's `ParserLike`. This is the ONLY
// module that imports the native bindings, and it is loaded solely by the
// package entry (`src/index.tsx` → `registerNativeParser`). Host tests never
// import it — they inject a WASM-backed `makeParser` — so the TurboModule is
// never touched off-device.
import { BrookConfig, BrookSession } from "./generated/brook_md_ffi";
import NativeBrookMdReactNative from "./NativeBrookMdReactNative";
import type { ParserLike } from "brookmd/worker-core";
import type { ParserConfig } from "brookmd/types";

// The ubrn bindings reach the Rust crate through a JSI host object the installer
// TurboModule registers on `globalThis`. Trigger that registration once, lazily,
// before the first `BrookSession` is created.
let installed = false;
function ensureInstalled(): void {
  if (installed) return;
  installed = true;
  try {
    NativeBrookMdReactNative?.installRustCrate();
  } catch {
    // Left to fail loudly at `BrookSession.new()` with a clearer stack if the
    // JSI host object never registered (e.g. the native lib failed to load).
  }
}

// Map brookmd's `ParserConfig` onto the uniffi `BrookConfig` record. Only keys
// the caller actually set are forwarded: `uniffiCreateRecord` does a shallow
// `{ ...defaults, ...partial }`, so an explicit `undefined` would clobber a
// default — and the BrookConfig defaults already match brookmd's (autolinks +
// alerts on, everything else off), exactly like the browser worker's
// `c?.x ?? default`.
function toBrookConfig(c: ParserConfig | undefined): BrookConfig {
  const partial: Partial<BrookConfig> = {};
  if (c) {
    if (c.gfmAutolinks !== undefined) partial.gfmAutolinks = c.gfmAutolinks;
    if (c.gfmAlerts !== undefined) partial.gfmAlerts = c.gfmAlerts;
    if (c.gfmTagfilter !== undefined) partial.gfmTagfilter = c.gfmTagfilter;
    if (c.gfmFootnotes !== undefined) partial.gfmFootnotes = c.gfmFootnotes;
    if (c.gfmMath !== undefined) partial.gfmMath = c.gfmMath;
    if (c.dirAuto !== undefined) partial.dirAuto = c.dirAuto;
    if (c.a11y !== undefined) partial.a11y = c.a11y;
    if (c.unsafeHtml !== undefined) partial.unsafeHtml = c.unsafeHtml;
    if (c.componentTags !== undefined) partial.componentTags = c.componentTags;
    if (c.inlineComponentTags !== undefined) partial.inlineComponentTags = c.inlineComponentTags;
    if (c.htmlAllowlist !== undefined) partial.htmlAllowlist = c.htmlAllowlist;
    if (c.dropHtmlTags !== undefined) partial.dropHtmlTags = c.dropHtmlTags;
    if (c.blockData !== undefined) partial.blockData = c.blockData;
  }
  // Wire delta mode (WIRE.md §11) is always on for OUR session↔client pair,
  // mirroring the browser worker: active re-emits cross the JSI boundary as
  // splices instead of full html (O(n) total for a growing block), and the
  // shared `applyPatch` in brookmd's client reconstructs before anything else
  // sees the block. Raw `BrookSession` consumers are unaffected (default off).
  partial.wireDelta = true;
  return BrookConfig.create(partial);
}

/**
 * Create a native `BrookSession` for a stream and wrap it as a `ParserLike`.
 * `append`/`finalize` return the JSON wire strings (WIRE.md) verbatim — the same
 * bytes the WASM boundary produces — which `WorkerCore` forwards untouched.
 * `free()` releases the native object immediately (mirroring the browser
 * worker's `parser.free()`); `WorkerCore` then drops the reference and recreates
 * a fresh session on the next append.
 */
export function makeNativeParser(config: ParserConfig | undefined): ParserLike {
  ensureInstalled();
  const session = BrookSession.newWithConfig(toBrookConfig(config));
  return {
    append: (chunk: string) => session.append(chunk),
    finalize: () => session.finalize(),
    free: () => {
      // `uniffiDestroy` lives on the concrete class, not the `BrookSessionLike`
      // interface `newWithConfig` returns — reach it through a narrow cast.
      (session as unknown as { uniffiDestroy?: () => void }).uniffiDestroy?.();
    },
    retainedBytes: () => Number(session.retainedBytes()),
  };
}
