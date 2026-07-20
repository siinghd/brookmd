// The ON-DEVICE default parser: adapts the ubrn-generated `FluxSession`
// (JSI/uniffi over `flux-md-ffi`) to flux-md's `ParserLike`. This is the ONLY
// module that imports the native bindings, and it is loaded solely by the
// package entry (`src/index.tsx` → `registerNativeParser`). Host tests never
// import it — they inject a WASM-backed `makeParser` — so the TurboModule is
// never touched off-device.
import { FluxConfig, FluxSession } from "./generated/flux_md_ffi";
import NativeFluxMdReactNative from "./NativeFluxMdReactNative";
import type { ParserLike } from "flux-md/worker-core";
import type { ParserConfig } from "flux-md/types";

// The ubrn bindings reach the Rust crate through a JSI host object the installer
// TurboModule registers on `globalThis`. Trigger that registration once, lazily,
// before the first `FluxSession` is created.
let installed = false;
function ensureInstalled(): void {
  if (installed) return;
  installed = true;
  try {
    NativeFluxMdReactNative?.installRustCrate();
  } catch {
    // Left to fail loudly at `FluxSession.new()` with a clearer stack if the
    // JSI host object never registered (e.g. the native lib failed to load).
  }
}

// Map flux-md's `ParserConfig` onto the uniffi `FluxConfig` record. Only keys
// the caller actually set are forwarded: `uniffiCreateRecord` does a shallow
// `{ ...defaults, ...partial }`, so an explicit `undefined` would clobber a
// default — and the FluxConfig defaults already match flux-md's (autolinks +
// alerts on, everything else off), exactly like the browser worker's
// `c?.x ?? default`.
function toFluxConfig(c: ParserConfig | undefined): FluxConfig {
  const partial: Partial<FluxConfig> = {};
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
  return FluxConfig.create(partial);
}

/**
 * Create a native `FluxSession` for a stream and wrap it as a `ParserLike`.
 * `append`/`finalize` return the JSON wire strings (WIRE.md) verbatim — the same
 * bytes the WASM boundary produces — which `WorkerCore` forwards untouched.
 * `free()` releases the native object immediately (mirroring the browser
 * worker's `parser.free()`); `WorkerCore` then drops the reference and recreates
 * a fresh session on the next append.
 */
export function makeNativeParser(config: ParserConfig | undefined): ParserLike {
  ensureInstalled();
  const session = FluxSession.newWithConfig(toFluxConfig(config));
  return {
    append: (chunk: string) => session.append(chunk),
    finalize: () => session.finalize(),
    free: () => {
      // `uniffiDestroy` lives on the concrete class, not the `FluxSessionLike`
      // interface `newWithConfig` returns — reach it through a narrow cast.
      (session as unknown as { uniffiDestroy?: () => void }).uniffiDestroy?.();
    },
    retainedBytes: () => Number(session.retainedBytes()),
  };
}
