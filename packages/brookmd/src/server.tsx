import initWasmAsync, { BrookParser, initSync } from "./wasm/brook_md_core.js";
import type { Block, ParserConfig } from "./types";

/**
 * Synchronous, worker-free server / static rendering for brookmd.
 *
 * This entry is **React-free** — it imports no framework, so a non-React build
 * step or a Vue/Svelte SSR app can `import { renderToString } from "brookmd/server"`
 * even when `react` is not installed. The browser path runs the Rust→WASM core
 * in a Web Worker, but the very same `BrookParser` is a plain synchronous class,
 * so on the server (Node, RSC, a build step) you can parse a finished markdown
 * string with no worker and no async ceremony:
 *
 * ```ts
 * import { initBrook, renderToString } from "brookmd/server";
 * await initBrook();                       // once, at startup
 * const html = renderToString(markdown);  // sync, no worker
 * ```
 *
 * For React server rendering (RSC, static generation, SSR) import
 * `BrookMarkdownStatic` from **`brookmd/server/react`** — a hookless, RSC-safe
 * component with the same `components` overrides (kept in a separate subpath so
 * this one stays React-free). It targets **render-once** contexts; the
 * streaming, interactive `<BrookMarkdown>` (client-side code highlighting,
 * Mermaid, live updates) is a separate component. If you SSR-then-hydrate, use
 * the *same* component on both sides.
 */

let ready = false;

/** Has the sync WASM core been initialized in this process? */
export function isBrookReady(): boolean {
  return ready;
}

/** Initialize the sync core from compiled WASM bytes (or a `WebAssembly.Module`).
 *  Idempotent. Use on runtimes without a filesystem (edge) or to control exactly
 *  when init happens; otherwise {@link initBrook} auto-loads the co-located WASM. */
export function initBrookSync(wasm: BufferSource | WebAssembly.Module): void {
  if (ready) return;
  initSync({ module: wasm });
  ready = true;
}

let initPromise: Promise<void> | null = null;

/** Initialize the sync core once. In Node it reads the package's co-located
 *  `.wasm` off disk (Node's `fetch` can't load `file://`); on the web it fetches
 *  the bundler-resolved asset URL. Pass `{ wasm }` to supply bytes yourself
 *  (edge runtimes). Safe to call repeatedly / concurrently. */
export function initBrook(opts?: { wasm?: BufferSource | WebAssembly.Module }): Promise<void> {
  if (ready) return Promise.resolve();
  if (opts?.wasm) {
    initBrookSync(opts.wasm);
    return Promise.resolve();
  }
  if (!initPromise) {
    initPromise = (async () => {
      const wasmUrl = new URL("./wasm/brook_md_core_bg.wasm", import.meta.url);
      if (wasmUrl.protocol === "file:") {
        // Node: read the bytes (Node's fetch can't load file://). The literal
        // `node:` specifier is externalized by bundlers, so node:fs never reaches
        // a web bundle (this branch is also file:-only, never true in browsers).
        // @ts-ignore — no @types/node in this package; node:fs/promises is a builtin.
        const { readFile } = await import("node:fs/promises");
        initBrookSync(await readFile(wasmUrl));
      } else {
        await initWasmAsync({ module_or_path: wasmUrl });
        ready = true;
      }
    })().catch((err) => {
      // Drop the cached rejected promise so a transient failure (e.g. a flaky
      // .wasm fetch on the web path) can be retried by the next initBrook()
      // instead of poisoning every subsequent call until a process restart.
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

// Configure a one-shot parser exactly as the worker does, so server output is
// byte-identical to the streamed/browser output (defaults: autolinks + alerts
// on, raw HTML escaped, footnotes/math off).
function makeParser(config?: ParserConfig): BrookParser {
  const p = new BrookParser();
  p.setGfmAutolinks(config?.gfmAutolinks ?? true);
  p.setGfmAlerts(config?.gfmAlerts ?? true);
  p.setGfmTagfilter(config?.gfmTagfilter ?? false);
  p.setGfmFootnotes(config?.gfmFootnotes ?? false);
  p.setGfmMath(config?.gfmMath ?? false);
  p.setDirAuto(config?.dirAuto ?? false);
  p.setA11y(config?.a11y ?? false);
  p.setUnsafeHtml(config?.unsafeHtml ?? false);
  p.setComponentTags(config?.componentTags ?? []);
  p.setInlineComponentTags(config?.inlineComponentTags ?? []);
  // Engage the safe raw-HTML sanitizer when either list is provided (even []).
  p.setHtmlSanitize(
    config?.htmlAllowlist !== undefined || config?.dropHtmlTags !== undefined,
    config?.htmlAllowlist ?? [],
    config?.dropHtmlTags ?? [],
  );
  p.setBlockData(config?.blockData ?? false);
  return p;
}

function requireReady(): void {
  if (!ready) {
    throw new Error(
      "brookmd/server: WASM not initialized. Call `await initBrook()` (or `initBrookSync(bytes)`) once before rendering.",
    );
  }
}

/**
 * Parse a complete markdown string to its block array synchronously (committed +
 * any trailing block, in document order). Requires {@link initBrook} to have run.
 */
export function parseToBlocks(markdown: string, opts?: { config?: ParserConfig }): Block[] {
  requireReady();
  const p = makeParser(opts?.config);
  try {
    p.append(markdown);
    p.finalize();
    // allBlocks() returns a JSON string (see the Rust core); parse it once.
    return JSON.parse(p.allBlocks() as unknown as string) as Block[];
  } finally {
    p.free();
  }
}

/**
 * Render a complete markdown string to an HTML string synchronously — no worker,
 * no React. The concatenated per-block HTML (XSS-safe with `unsafeHtml` off).
 * For component dispatch / a `<BrookMarkdown>`-matching React tree, use
 * `BrookMarkdownStatic` from `brookmd/server/react` with your framework's server
 * renderer instead.
 */
export function renderToString(markdown: string, opts?: { config?: ParserConfig }): string {
  return parseToBlocks(markdown, opts)
    .map((b) => b.html)
    .join("");
}
