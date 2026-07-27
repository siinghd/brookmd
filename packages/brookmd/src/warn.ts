// One-time dev warnings, shared by the renderers and the client.
//
// DEAD-CODE ELIMINATION CONTRACT (read before adding a call site). Every call
// MUST be wrapped at the CALL SITE in:
//
//   if (typeof process !== "undefined" && process.env.NODE_ENV !== "production")
//     warnOnce(id, `…message…`);
//
// and never gated only inside this module. Bundlers substitute the *free
// identifier* `process.env.NODE_ENV`; they do NOT rewrite `globalThis.process?.env`
// (verified: esbuild --define, a real Vite browser build, and Next's
// ProvidePlugin all leave that member path alone). A gate that lives in the
// callee therefore folds to nothing, the message argument survives minification,
// and the "dev-only" prose ships — and prints — in production.
//
// The `typeof process !== "undefined"` half is load-bearing too: a bare
// `process.env.NODE_ENV` throws ReferenceError in a realm with no `process`,
// which this package deliberately supports (the worker bootstrap resolves via
// `new URL(…, import.meta.url)` with no bundler in sight).
//
// TRADE, accepted deliberately: in a no-`process` realm the gate is false, so an
// unbundled CDN consumer loses these six warnings. They are development
// ergonomics; the failure paths they annotate still degrade safely, and a block
// that actually throws still reports through `onBlockError` / `console.error`,
// which is NOT gated.

const warned = new Set<string>();

/** Warn once per `id`. Callers own the production gate — see the contract above. */
export function warnOnce(id: string, message: string): boolean {
  if (warned.has(id)) return false;
  warned.add(id);
  // eslint-disable-next-line no-console
  console.warn(message);
  return true;
}

/** Test-only: clear the latch so a test can assert a warning fires. */
export function __resetWarnOnce(): void {
  warned.clear();
}
