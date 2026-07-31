import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { GlobalWindow } from "happy-dom";
import { applyPatch, emptyBlockStore, type BlockStore } from "../src/client";
import { mountBrookMarkdown, type MountOptions } from "../src/dom";
import { __getIncScanned, __resetIncScanned } from "../src/hi-inc";
import { blockProps } from "../src/block-props";
import type { Block } from "../src/types-core";
import type { Patch } from "../src/types";

/**
 * COST GATE: what `streamingHighlight` adds to the main thread.
 *
 * A fence is streamed at an LLM's cadence (~80 tok/s ⇒ one ~4-char patch per
 * frame, so rAF coalescing hides nothing) with the option ON and OFF, and the
 * ON arm's work is measured — not its wall time, which says as much about the
 * machine and about happy-dom's HTML parser as it does about this package.
 *
 * ## What is measured, and why these units
 *
 * Highlighted markup is ~6.5× its source, so "ON costs more than OFF" is not by
 * itself a finding: writing 6.5× the bytes is the feature. What is a finding is
 * work that grows FASTER than the block — a pass over the whole block on every
 * patch is O(n²) over the stream, and that is what this pins:
 *
 * - `charCodeAt` calls. hi-inc used to find the divergence point between the
 *   previous source and the new one with a char-by-char loop from index 0, on
 *   every patch. On a 32 KB fence that single loop cost 373 ms — more than the
 *   tokenizing, the DOM mirroring and everything else on the path combined. It
 *   now asks the only two questions it ever wanted (`startsWith`), so the count
 *   drops from 2,070× the source to 6.9× it.
 * - Characters passed through `String.prototype.replace`. Decoding the open
 *   fence's body out of its HTML ran five unconditional entity passes over the
 *   whole body per patch (295 ms on that same fence). They now run only when
 *   the body actually contains an `&`.
 * - `__getIncScanned()` — source bytes re-tokenized, the gate hi-inc has always
 *   carried, restated here against the same fixture.
 *
 * Every bound is a ratio against the source or the final markup, so it holds on
 * any machine and at any block size. The `OFF` arm is measured alongside purely
 * to keep the ON numbers honest about which costs are the option's at all.
 */

const wasmUrl = new URL("../src/wasm/brook_md_core_bg.wasm", import.meta.url);
const haveWasm = existsSync(wasmUrl);

let win: GlobalWindow;
let counting = false;
let domChars = 0;
let charCodeAtCalls = 0;
let replaceChars = 0;

interface WasmParser {
  append(chunk: string): string;
  finalize(): string;
  free(): void;
}
let makeParser: (blockData?: boolean) => WasmParser;

// Saved so the prototypes are handed back untouched: these are the REAL
// `String.prototype` methods, shared with every other file in the run.
const rawCharCodeAt = String.prototype.charCodeAt;
const rawReplace = String.prototype.replace;

beforeAll(async () => {
  win = new GlobalWindow();
  const g = globalThis as Record<string, unknown>;
  g.document = win.document;
  g.HTMLElement = win.HTMLElement;
  g.Element = win.Element;
  g.Node = win.Node;
  g.navigator = win.navigator;

  // Instrumentation at the boundary rather than inside the renderer, the same
  // move test/incremental-work-bound.test.ts makes for DOM writes: it counts
  // what the path actually does, so it cannot be fooled by work that merely
  // moves to a different function.
  const E = win.Element.prototype as unknown as object;
  const N = win.Node.prototype as unknown as object;
  for (const [proto, key] of [[E, "innerHTML"], [N, "textContent"], [N, "nodeValue"]] as const) {
    const d = Object.getOwnPropertyDescriptor(proto, key)!;
    Object.defineProperty(proto, key, {
      ...d,
      set(this: unknown, v: string) {
        if (counting) domChars += String(v ?? "").length;
        d.set!.call(this, v);
      },
    });
  }
  const iah = (E as { insertAdjacentHTML: (p: string, h: string) => void }).insertAdjacentHTML;
  (E as { insertAdjacentHTML: unknown }).insertAdjacentHTML = function (
    this: unknown,
    pos: string,
    html: string,
  ) {
    if (counting) domChars += String(html).length;
    return iah.call(this, pos, html);
  };

  String.prototype.charCodeAt = function (this: string, i: number) {
    if (counting) charCodeAtCalls++;
    return rawCharCodeAt.call(this, i);
  } as typeof String.prototype.charCodeAt;
  // A `replace` always walks its whole receiver, so the receiver's length is
  // what it costs whether or not it rewrites anything.
  String.prototype.replace = function (this: string, ...args: unknown[]) {
    if (counting) replaceChars += this.length;
    return (rawReplace as (...a: unknown[]) => string).apply(this, args);
  } as typeof String.prototype.replace;

  if (!haveWasm) return;
  const glue = "../src/wasm/brook_md_core.js"; // runtime specifier: no collection-time failure
  const mod = await import(glue);
  mod.initSync({ module: readFileSync(wasmUrl) });
  makeParser = (blockData = false) => {
    const p = new mod.BrookParser();
    // blockData OFF is the library default, and the case that has to decode the
    // open fence's source back out of its HTML on every patch. The decoder
    // parity test turns it ON purely to get the core's own source as ground
    // truth, and then hides it from `blockProps`.
    if (blockData) p.setBlockData(true);
    else p.setWireDelta(true);
    return p as WasmParser;
  };
});

afterAll(() => {
  String.prototype.charCodeAt = rawCharCodeAt;
  String.prototype.replace = rawReplace;
});

/** A TS fence of about `bytes`, the shape an assistant answers a code question with. */
function codeDoc(bytes: number): string {
  const lines = ["```ts"];
  let n = 6;
  let i = 0;
  while (n < bytes) {
    const l =
      `export function fn${i}(a: number, b: string): string {\n` +
      `  const out = \`\${b}-\${a * ${i}}\`; // note ${i}\n` +
      `  return out.repeat(${(i % 5) + 1});\n}`;
    lines.push(l);
    n += l.length + 1;
    i++;
  }
  lines.push("```");
  return lines.join("\n") + "\n";
}

interface Sample {
  domChars: number;
  charCodeAtCalls: number;
  replaceChars: number;
  tokChars: number;
  finalMarkup: number;
  patches: number;
  html: string;
}

/** Stream `doc` in 4-char patches — ~80 tok/s, one patch per frame. */
function measure(doc: string, opts: MountOptions): Sample {
  const store: BlockStore = emptyBlockStore();
  const listeners = new Set<() => void>();
  const client = {
    getSnapshot: () => store.snapshot,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    __noteRebuild: () => {},
  } as never;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const handle = mountBrookMarkdown(client, container as never, { batch: false, ...opts });
  const p = makeParser();
  let patches = 0;
  domChars = 0;
  charCodeAtCalls = 0;
  replaceChars = 0;
  __resetIncScanned();
  const step = (raw: string) => {
    applyPatch(store, JSON.parse(raw) as Patch);
    for (const fn of listeners) fn();
    patches++;
  };
  counting = true;
  try {
    for (let i = 0; i < doc.length; i += 4) step(p.append(doc.slice(i, i + 4)));
    step(p.finalize());
  } finally {
    counting = false;
    p.free();
  }
  const html = container.innerHTML;
  const sample: Sample = {
    domChars,
    charCodeAtCalls,
    replaceChars,
    tokChars: __getIncScanned(),
    finalMarkup: html.length,
    patches,
    html,
  };
  handle.destroy();
  container.remove();
  return sample;
}

const t = haveWasm ? test : test.skip;

t("streamingHighlight adds no per-patch pass over the whole block", () => {
  const doc = codeDoc(8 * 1024);
  const src = doc.length;
  const on = measure(doc, {});
  const off = measure(doc, { streamingHighlight: false });

  // Printed so a failure reads as a measurement, not just a broken threshold.
  const report = {
    source: src,
    patches: on.patches,
    on: {
      markup: on.finalMarkup,
      domChars: on.domChars,
      domPerMarkup: +(on.domChars / on.finalMarkup).toFixed(2),
      charCodeAtPerSource: +(on.charCodeAtCalls / src).toFixed(1),
      replacePerSource: +(on.replaceChars / src).toFixed(1),
      tokPerSource: +(on.tokChars / src).toFixed(2),
    },
    off: {
      markup: off.finalMarkup,
      domChars: off.domChars,
      charCodeAtPerSource: +(off.charCodeAtCalls / src).toFixed(1),
      replacePerSource: +(off.replaceChars / src).toFixed(1),
    },
  };
  console.log("streaming-highlight cost:", JSON.stringify(report));

  // (1) No char-by-char scan of the block per patch. hi-inc's divergence loop
  //     measured 2,070 × source on this fixture (one pass per patch); what is
  //     left is escapeHtml over the tokenized tail — 6.9 × source, linear.
  expect(on.charCodeAtCalls).toBeLessThan(60 * src);

  // (2) No entity chain over the whole body per patch. The five unconditional
  //     passes measured 5,169 × source; they now run only on a body that holds
  //     an `&` at all, which this fixture (like most code) does not.
  expect(on.replaceChars).toBeLessThan(120 * src);

  // (3) The tokenizer stays linear in the source (hi-inc's own long-standing
  //     bound, restated against this fixture). 7.3 × measured.
  expect(on.tokChars).toBeLessThan(10 * src);

  // (4) Application stays O(new bytes) at the DOM: chars written is a small
  //     multiple of the markup each arm actually produces — and the SAME
  //     multiple for both (7.49 × on, 7.68 × off), which is what says the
  //     highlighted arm is not paying extra for being highlighted, only for
  //     being bigger. That 6.3× size difference is the feature, not overhead.
  expect(on.domChars).toBeLessThan(12 * on.finalMarkup);
  expect(off.domChars).toBeLessThan(12 * off.finalMarkup);

  // (5) OFF is byte-for-byte the path it always was: it never reaches hi-inc,
  //     so it never tokenizes at all.
  expect(off.tokChars).toBe(0);
});

t("the HTML-fallback decode is byte-identical to the core's own source", () => {
  // The open fence's source is what hi-inc tokenizes, and with `blockData` off
  // (the default) it is recovered from the escaped HTML. Locating the body by
  // index instead of by regex, and skipping the entity chain when there is no
  // `&`, has to be indistinguishable from the chain it replaces — including the
  // ordering case `&amp;amp;`, where decoding `&amp;` first would eat too much.
  const doc =
    "```js\n" +
    'const cmp = a < b && c > d;\n' +
    'const s = "a & b";\n' +
    // The ordering trap: this source escapes to `&amp;lt;`, which decodes to
    // `&lt;` only if `&amp;` is substituted LAST. Take it first and it becomes
    // `&lt;` and then `<` — the source comes back a character short.
    "const ent = '&lt;a&gt; &amp; &quot;q&quot;';\n" +
    "// <div class=\"x\">&nbsp;</div>\n" +
    "```\n" +
    "\n```text\n&amp;lt; &lt; &&\n```\n";
  const p = makeParser(true);
  let seen = 0;
  const check = (raw: string) => {
    const patch = JSON.parse(raw) as {
      active?: Array<{ id: number; html: string; open: boolean; speculative: boolean; kind: { type: string; data?: { code?: string } } }>;
      newly_committed?: Array<{ id: number; html: string; open: boolean; speculative: boolean; kind: { type: string; data?: { code?: string } } }>;
    };
    for (const b of [...(patch.active ?? []), ...(patch.newly_committed ?? [])]) {
      const truth = b.kind.data?.code;
      if (b.kind.type !== "CodeBlock" || typeof truth !== "string") continue;
      // Same block with the structured channel removed: `blockProps` then has to
      // rebuild the source from `html`, through the decoder under test.
      const bare = { ...b, kind: { type: b.kind.type, data: undefined } } as unknown as Block;
      expect(`#${b.id}: ${blockProps(bare).text}`).toBe(`#${b.id}: ${truth}`);
      seen++;
    }
  };
  try {
    // Every prefix length, so the decoder is exercised against a body that is
    // truncated mid-entity, mid-tag and mid-line.
    for (let i = 0; i < doc.length; i += 1) check(p.append(doc[i]));
    check(p.finalize());
  } finally {
    p.free();
  }
  expect(seen).toBeGreaterThan(50);
});

t("the settled block is identical with the option on and off", () => {
  // The point of the frozen prefix is that it is a prefix of the markup the
  // block settles to, so the two arms have to converge exactly once the fence
  // closes — the cost work above is not allowed to have changed a byte.
  const doc = codeDoc(4 * 1024);
  const on = measure(doc, {});
  const off = measure(doc, { streamingHighlight: false });
  expect(on.html).toBe(off.html);
});
