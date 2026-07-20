// Shared test harness: load brookmd's REAL compiled WASM parser and adapt it to
// the `ParserLike` the native shim expects. Host tests can then drive the entire
// brookmd-react-native stack (native pool → WorkerCore → client) with the actual
// parser — no device, no TurboModule — proving the wire and message plumbing.
//
// This mirrors packages/brookmd/test/wasm-integration.test.ts's loader: the WASM
// is git-ignored and built by `bun run build:wasm`; if it is absent the suites
// skip rather than fail collection.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ParserLike } from "brookmd/worker-core";
import type { ParserConfig } from "brookmd/types";

// `import.meta.dir` (bun) sidesteps the DOM-vs-node URL type clash of new URL().
const wasmPath = join(import.meta.dir, "../../brookmd/src/wasm/brook_md_core_bg.wasm");
export const haveWasm = existsSync(wasmPath);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyParser = any;
let BrookParserCtor: AnyParser = null;

/** Compile + init the WASM module once and return its `BrookParser` constructor. */
export async function loadWasm(): Promise<AnyParser> {
  if (BrookParserCtor) return BrookParserCtor;
  const glue = "../../brookmd/src/wasm/brook_md_core.js"; // runtime specifier → not resolved at collection
  const mod = await import(glue);
  // Named initSync compiles raw bytes synchronously — no fetch shim needed.
  mod.initSync({ module: readFileSync(wasmPath) });
  BrookParserCtor = mod.BrookParser;
  return BrookParserCtor;
}

// Apply a ParserConfig to a WASM parser exactly as packages/brookmd/src/worker.ts
// does — same setters, same order, same defaults — so a WASM-backed makeParser is
// byte-for-byte the browser worker's makeParser.
function applyConfig(p: AnyParser, c: ParserConfig | undefined): void {
  p.setGfmAutolinks(c?.gfmAutolinks ?? true);
  p.setGfmAlerts(c?.gfmAlerts ?? true);
  p.setGfmTagfilter(c?.gfmTagfilter ?? false);
  p.setGfmFootnotes(c?.gfmFootnotes ?? false);
  p.setGfmMath(c?.gfmMath ?? false);
  p.setDirAuto(c?.dirAuto ?? false);
  p.setA11y(c?.a11y ?? false);
  p.setUnsafeHtml(c?.unsafeHtml ?? false);
  p.setComponentTags(c?.componentTags ?? []);
  p.setInlineComponentTags(c?.inlineComponentTags ?? []);
  p.setHtmlSanitize(
    c?.htmlAllowlist !== undefined || c?.dropHtmlTags !== undefined,
    c?.htmlAllowlist ?? [],
    c?.dropHtmlTags ?? [],
  );
  p.setBlockData(c?.blockData ?? false);
}

/**
 * A `WorkerCore` `makeParser` backed by the real WASM parser. `append`/`finalize`
 * return the JSON wire STRINGS verbatim (as the browser worker forwards them);
 * `retainedBytes` narrows the WASM `u64`→number.
 */
export function wasmMakeParser(Ctor: AnyParser): (c: ParserConfig | undefined) => ParserLike {
  return (c) => {
    const p = new Ctor();
    applyConfig(p, c);
    return {
      append: (chunk: string) => p.append(chunk) as string,
      finalize: () => p.finalize() as string,
      free: () => p.free(),
      retainedBytes: () => Number(p.retainedBytes()),
    };
  };
}

/** Decoded `Block` shape used in assertions. */
export interface WireBlock {
  id: number;
  kind: { type: string; data?: unknown };
  start: number;
  end: number;
  html: string;
  open: boolean;
  speculative: boolean;
}

/** One-shot parse of a whole document → the final `Block[]` (append + finalize +
 *  allBlocks), the ground truth a streamed parse must match. */
export function oneShot(Ctor: AnyParser, doc: string, c?: ParserConfig): WireBlock[] {
  const p = new Ctor();
  applyConfig(p, c);
  p.append(doc);
  p.finalize();
  const blocks = JSON.parse(p.allBlocks()) as WireBlock[];
  p.free();
  return blocks;
}

/** Split a string into fixed-size chunks (to feed a parser incrementally). */
export function chunk(s: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

/**
 * Feed `doc` to a fresh parser in `chunkSize` chunks and capture the FULL block
 * set (`allBlocks`) after each append plus the final finalize — the sequence of
 * snapshots a streaming renderer would see. Lets a test drive the keyed vs
 * whole-html render paths deterministically over a block as it grows.
 */
export function parseStates(Ctor: AnyParser, doc: string, chunkSize: number, config?: ParserConfig): WireBlock[][] {
  const p = new Ctor();
  applyConfig(p, config);
  const states: WireBlock[][] = [];
  for (const ch of chunk(doc, chunkSize)) {
    p.append(ch);
    states.push(JSON.parse(p.allBlocks()) as WireBlock[]);
  }
  p.finalize();
  states.push(JSON.parse(p.allBlocks()) as WireBlock[]);
  p.free();
  return states;
}

/** Drain queued microtasks/macrotasks so the in-process shim's patches land. */
export async function settle(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

/** A representative document exercising most wire kinds. */
export const RICH_DOC = [
  "# Streaming Markdown",
  "",
  "A paragraph with **bold**, *italic*, ~~strike~~ and a [link](https://example.com/report).",
  "",
  "> [!NOTE]",
  "> A note callout with `inline code`.",
  "",
  "- [x] done task",
  "- [ ] open task",
  "- plain item",
  "",
  "1. first",
  "2. second",
  "",
  "```ts",
  "const x: number = 1;",
  "console.log(x);",
  "```",
  "",
  "| Name | Value |",
  "| :--- | ----: |",
  "| a | 1 |",
  "| b | 2 |",
  "",
  "Inline math $E = mc^2$ and display:",
  "",
  "$$\\int_0^1 x\\,dx$$",
  "",
  "A footnote reference[^1].",
  "",
  "[^1]: The footnote body.",
  "",
  "---",
  "",
  "Final paragraph.",
  "",
].join("\n");

/** The config the RN renderer defaults to: everything the RICH_DOC needs. */
export const RICH_CONFIG: ParserConfig = {
  gfmAlerts: true,
  gfmAutolinks: true,
  gfmFootnotes: true,
  gfmMath: true,
  a11y: true,
  blockData: true,
};
