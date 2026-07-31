import { test, expect, beforeAll } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { GlobalWindow } from "happy-dom";
import { applyPatch, emptyBlockStore, type BlockStore } from "../src/client";
import { mountBrookMarkdown, type MountOptions } from "../src/dom";
import type { Patch } from "../src/types";

/**
 * WORK-BOUND GATE: browser-side linearity, enforced.
 *
 * The Rust side gates its own linearity in tests/scaling.rs. This is the same
 * idea for the DOM: stream a 20 KB block in 32-byte appends and count every
 * character written into the document, then assert the TOTAL is a small
 * constant multiple of the document's final markup.
 *
 * Why that unit and not "×wire bytes": the final markup has to be written at
 * least once no matter what, and highlighted code markup is ~7× its source, so
 * a wire-relative bound would be meaningless for a code fence. Chars-written
 * ÷ final-markup is scale-free — it stays flat as the block grows if the apply
 * path is O(new bytes), and grows without limit if it is O(block) per patch.
 *
 * The numbers this replaced, measured the same way on the same fixtures:
 *
 *   20 KB fenced code, highlighted        44,318,922 chars  (324× final markup)
 *   20 KB fenced code, plain body          6,681,029 chars  (315×)
 *   20 KB single paragraph                 5,658,953 chars  (297×)
 *   20 KB of paragraphs                      153,773 chars  (6.5×)
 *
 * Each case below also runs with `__fullRebuild` to re-measure that old cost in
 * situ, and asserts the ratio is still catastrophic — so the gate cannot pass by
 * accidentally measuring nothing.
 */

const wasmUrl = new URL("../src/wasm/brook_md_core_bg.wasm", import.meta.url);
const haveWasm = existsSync(wasmUrl);

let win: GlobalWindow;
let chars = 0;

interface WasmParser {
  append(chunk: string): string;
  finalize(): string;
  free(): void;
}
let makeParser: (blockData: boolean) => WasmParser;

beforeAll(async () => {
  win = new GlobalWindow();
  const g = globalThis as Record<string, unknown>;
  g.document = win.document;
  g.HTMLElement = win.HTMLElement;
  g.Element = win.Element;
  g.Node = win.Node;
  g.navigator = win.navigator;

  // TEST-ONLY instrumentation, at the DOM boundary rather than in the renderer:
  // it counts what actually reaches the document, so it cannot be fooled by a
  // renderer that merely moves its writes somewhere else.
  const E = win.Element.prototype as unknown as object;
  const N = win.Node.prototype as unknown as object;
  const ih = Object.getOwnPropertyDescriptor(E, "innerHTML")!;
  Object.defineProperty(E, "innerHTML", {
    ...ih,
    set(this: unknown, v: string) {
      chars += String(v).length;
      ih.set!.call(this, v);
    },
  });
  const tc = Object.getOwnPropertyDescriptor(N, "textContent")!;
  Object.defineProperty(N, "textContent", {
    ...tc,
    set(this: unknown, v: string) {
      chars += String(v ?? "").length;
      tc.set!.call(this, v);
    },
  });
  const nv = Object.getOwnPropertyDescriptor(N, "nodeValue")!;
  Object.defineProperty(N, "nodeValue", {
    ...nv,
    set(this: unknown, v: string) {
      chars += String(v ?? "").length;
      nv.set!.call(this, v);
    },
  });
  // A TEXT node's `nodeValue` resolves to `CharacterData`'s own accessor rather
  // than `Node`'s, so the line above never sees one. That is the channel the
  // open fence's speculative tail (and the splice's whitespace strips) write
  // through, and it has to be on the meter like every other write. Only
  // `nodeValue` is wrapped: happy-dom chains it through `textContent` and `data`
  // internally, so wrapping those as well would count each write three times.
  const C = win.CharacterData.prototype as unknown as object;
  const cnv = Object.getOwnPropertyDescriptor(C, "nodeValue")!;
  Object.defineProperty(C, "nodeValue", {
    ...cnv,
    set(this: unknown, v: string) {
      chars += String(v ?? "").length;
      cnv.set!.call(this, v);
    },
  });
  const iah = (E as { insertAdjacentHTML: (p: string, h: string) => void }).insertAdjacentHTML;
  (E as { insertAdjacentHTML: unknown }).insertAdjacentHTML = function (
    this: unknown,
    pos: string,
    html: string,
  ) {
    chars += String(html).length;
    return iah.call(this, pos, html);
  };

  if (!haveWasm) return;
  const glue = "../src/wasm/brook_md_core.js"; // runtime specifier: no collection-time failure
  const mod = await import(glue);
  mod.initSync({ module: readFileSync(wasmUrl) });
  makeParser = (blockData: boolean) => {
    const p = new mod.BrookParser();
    p.setWireDelta(true);
    // blockData decides which renderer a list / container / table gets: ON is the
    // keyed path (one node per item / nested sub-block / row), OFF routes the
    // whole block through the generic html path and its delta splice. The two
    // have very different work profiles, so the gate pins both.
    if (blockData) p.setBlockData(true);
    return p as WasmParser;
  };
});

const KB = 1024;
const WORDS =
  "streaming markdown parser incremental speculative closure renderer tokens frozen prefix tail splice".split(" ");

function words(n: number, off = 0): string {
  const a: string[] = [];
  for (let i = 0; i < n; i++) a.push(WORDS[(i + off) % WORDS.length]);
  return a.join(" ");
}

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

function proseDoc(bytes: number): string {
  const out: string[] = [];
  let n = 0;
  let i = 0;
  while (n < bytes) {
    const p = words(48, i) + ".";
    out.push(p);
    n += p.length + 2;
    i++;
  }
  return out.join("\n\n") + "\n";
}

/** One 20 KB block that stays OPEN for the whole stream — the hard case. */
function giantParagraph(bytes: number): string {
  return words(Math.ceil(bytes / 9)) + "\n";
}

/** A tight list that stays one OPEN block the whole way down. */
function listDoc(bytes: number): string {
  const out: string[] = [];
  let n = 0;
  let i = 0;
  while (n < bytes) {
    const l = `- item ${i} ${words(8, i)}`;
    out.push(l);
    n += l.length + 1;
    i++;
  }
  return out.join("\n") + "\n";
}

/** A blockquote whose `nested` channel grows one sub-block at a time. */
function quoteDoc(bytes: number): string {
  const out: string[] = [];
  let n = 0;
  let i = 0;
  while (n < bytes) {
    const l = `> ${words(10, i)} para ${i}`;
    out.push(l, ">");
    n += l.length + 3;
    i++;
  }
  return out.join("\n") + "\n";
}

/** A table that stays one OPEN block, growing a row at a time. */
function tableDoc(bytes: number): string {
  const out = ["| alpha | beta | gamma |", "|:--|:-:|--:|"];
  let n = 50;
  let i = 0;
  while (n < bytes) {
    const l = `| ${words(3, i)} | ${words(3, i + 1)} | row ${i} |`;
    out.push(l);
    n += l.length + 1;
    i++;
  }
  return out.join("\n") + "\n";
}

interface Sample {
  chars: number;
  finalMarkup: number;
  patches: number;
}

// Stream `doc` in 32-byte appends — an LLM's token cadence, and slower than
// 60 Hz, so every patch gets its own frame and rAF coalescing hides nothing.
function measure(doc: string, opts: MountOptions, blockData = true): Sample {
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
  const p = makeParser(blockData);
  let patches = 0;
  chars = 0;
  const step = (raw: string) => {
    applyPatch(store, JSON.parse(raw) as Patch);
    for (const fn of listeners) fn();
    patches++;
  };
  try {
    for (let i = 0; i < doc.length; i += 32) step(p.append(doc.slice(i, i + 32)));
    step(p.finalize());
  } finally {
    p.free();
  }
  const sample = { chars, finalMarkup: container.innerHTML.length, patches };
  handle.destroy();
  container.remove();
  return sample;
}

// [name, document, mount options, bound as a multiple of the final markup,
//  blockData (default true)]
const CASES: Array<[string, string, MountOptions, number, boolean?]> = [
  // 2.70× measured. Two unavoidable full passes (the frozen prefix as it
  // settles, then the byte-identical one-shot markup at close) plus ~0.7× of
  // CAP-bounded tail rewrites.
  ["20KB fenced code, highlighted", codeDoc(20 * KB), {}, 4],
  // 2.71× measured: one pass as it streams, one at close.
  ["20KB fenced code, plain body", codeDoc(20 * KB), { streamingHighlight: false }, 4],
  // 2.21× measured — the pure delta-splice case, one block open throughout.
  ["20KB single open paragraph", giantParagraph(20 * KB), {}, 4],
  // 2.04× measured; most blocks commit quickly, so this was never the bad case.
  ["20KB of paragraphs", proseDoc(20 * KB), {}, 4],
  // --- the keyed streaming-tail renderers (blockData on) ---
  // 2.9× measured, and FLAT at 5/10/20 KB (2.9 / 2.9 / 2.9) — the signature of
  // an O(new bytes) apply. Was 283.9× here (71.6× at 5 KB, 142.9× at 10 KB: a
  // textbook quadratic) while the keyed renderer re-stamped every `<li>` on
  // every patch.
  ["20KB streamed list", listDoc(20 * KB), {}, 4],
  // 3.4× measured, flat at 5/10/20 KB. Was 317.5× (80.0× / 159.5× / 317.5×).
  ["20KB streamed blockquote", quoteDoc(20 * KB), {}, 4],
  // 1.7× measured, flat — the keyed tbody was already incremental.
  ["20KB streamed table", tableDoc(20 * KB), {}, 4],
];

/**
 * The SAME shapes with `blockData` OFF, which is a different renderer: no keyed
 * path exists, so the whole block rides the generic html path and its delta
 * splice. These bounds are deliberately loose because they pin a WORSE, known,
 * correct fallback — they exist so its cost cannot silently get worse, not to
 * claim it is linear (it is not; see the ratios).
 *
 * The table is the one that matters. Its generic splice can never fire: the
 * chain of open elements at the growth point runs through `<table>`/`<tbody>`/
 * `<tr>`, and `spliceHtml` refuses those (foster parenting means a scaffold
 * parse would not place appended nodes where a whole parse does). Measured:
 * 0 splice hits in 640 attempts, 324× final markup, quadratic (83× / 163× /
 * 324× at 5 / 10 / 20 KB).
 *
 * Lifting that guard was tried and REJECTED on the measurement: allowing table
 * tags in the chain raised the hit rate to only 95/640 and moved the ratio to
 * 274× — a 15% dent in a 300× problem, bought with a real foster-parenting
 * correctness risk that no DOM available in this test environment can faithfully
 * validate. Deriving rows back out of the html was rejected outright (that is
 * re-parsing). So: **`blockData: true` is the fast path for a streamed table**,
 * and the fallback stays correct-but-slow. It is bounded in practice because a
 * table arriving mid-stream is usually short.
 */
const FALLBACK_CASES: Array<[string, string, number]> = [
  // 11.2× measured — 626/641 splice hits; the residue is the ~15 bails, each of
  // which costs one whole-block rebuild.
  ["20KB streamed list, blockData off", listDoc(20 * KB), 16],
  // 22.6× measured — 593/639 splice hits.
  ["20KB streamed blockquote, blockData off", quoteDoc(20 * KB), 32],
  // 324× measured — 0/640 splice hits. See the note above.
  ["20KB streamed table, blockData off", tableDoc(20 * KB), 400],
];

test.skipIf(!haveWasm)("DOM apply stays linear in the document, not quadratic", () => {
  for (const [name, doc, opts, bound, blockData] of CASES) {
    const fast = measure(doc, opts, blockData !== false);
    // A 20 KB document at 32 bytes a patch: if this ever collapsed to a handful
    // of patches the ratio would look great for the wrong reason.
    expect(`${name}: ${fast.patches > 500}`).toBe(`${name}: true`);
    const ratio = fast.chars / fast.finalMarkup;
    if (ratio > bound) {
      throw new Error(
        `${name}: wrote ${fast.chars} chars for a ${fast.finalMarkup}-char document ` +
          `over ${fast.patches} patches — ${ratio.toFixed(1)}× final markup, bound is ${bound}×. ` +
          `Something on the apply path went back to rewriting the whole block per patch.`,
      );
    }
  }
}, 120_000);

test.skipIf(!haveWasm)("the blockData-off fallback stays within its (looser) known cost", () => {
  for (const [name, doc, bound] of FALLBACK_CASES) {
    const s = measure(doc, {}, false);
    const ratio = s.chars / s.finalMarkup;
    if (ratio > bound) {
      throw new Error(
        `${name}: wrote ${s.chars} chars for a ${s.finalMarkup}-char document over ` +
          `${s.patches} patches — ${ratio.toFixed(1)}× final markup, bound is ${bound}×. ` +
          `The generic-path fallback got worse.`,
      );
    }
  }
}, 120_000);

test.skipIf(!haveWasm)(
  "the gate would catch a regression: full rebuild blows every bound",
  () => {
    // Re-measures the pre-change cost in situ, so the gate above cannot pass by
    // measuring nothing. Deliberately at 4 KB, not 20 KB: the cost is QUADRATIC,
    // so a quarter of the size is a fortieth of the work and the blowup is just
    // as unambiguous. The fast path is measured at the full 20 KB above.
    const small: Array<[string, string, MountOptions, number]> = [
      ["4KB fenced code, highlighted", codeDoc(4 * KB), {}, 20],
      // Softer floor: this case's FINAL markup is the highlighted body (~7× the
      // source) while its streaming writes were the plain one, so the same
      // quadratic cost lands on a much larger denominator.
      ["4KB fenced code, plain body", codeDoc(4 * KB), { streamingHighlight: false }, 8],
      ["4KB single open paragraph", giantParagraph(4 * KB), {}, 20],
      // The keyed renderers, measured against the whole-node rebuild they
      // replaced — this is the number the keyed sync had to beat, re-measured
      // in situ so the bounds above cannot pass by measuring nothing.
      ["4KB streamed list", listDoc(4 * KB), {}, 20],
      ["4KB streamed blockquote", quoteDoc(4 * KB), {}, 20],
    ];
    for (const [name, doc, opts, floor] of small) {
      const slow = measure(doc, { ...opts, __fullRebuild: true });
      const fast = measure(doc, opts);
      const slowRatio = slow.chars / slow.finalMarkup;
      const fastRatio = fast.chars / fast.finalMarkup;
      if (slowRatio < floor) {
        throw new Error(
          `${name}: full rebuild only wrote ${slowRatio.toFixed(1)}× final markup ` +
            `(expected ≥ ${floor}×) — the work-bound gate is not measuring what it thinks it is.`,
        );
      }
      expect(`${name}: ${fastRatio < slowRatio / 4}`).toBe(`${name}: true`);
    }
  },
  60_000,
);
