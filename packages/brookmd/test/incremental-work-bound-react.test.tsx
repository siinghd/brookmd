import { test, expect, beforeAll } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { GlobalWindow } from "happy-dom";
import { createElement, act } from "react";
import type { Root } from "react-dom/client";
import { applyPatch, emptyBlockStore, type BlockStore } from "../src/client";
import { getParseChars, resetParseCount } from "../src/html-to-react";
import { BrookMarkdown } from "../src/react";
import type { Block, Patch } from "../src/types";

/**
 * WORK-BOUND GATE for the REACT renderer's keyed streaming-tail paths — the twin
 * of test/incremental-work-bound.test.ts, and the reason it exists.
 *
 * The DOM renderer's `renderKeyedList` / `renderKeyedContainer` re-stamped every
 * `<li>` and every nested sub-block on every patch. React's `KeyedList` /
 * `KeyedContainer` are written to be incremental instead — `KeyedListItem` is
 * `memo`ized on its item html, and `KeyedContainer`'s children go through the
 * memoized `SafeHtml`, so an unchanged item is supposed to reconcile to nothing
 * and write nothing.
 *
 * "Supposed to" is exactly the kind of claim that had already been wrong once
 * about the DOM renderer, so this measures it the same scale-free way and
 * divides by the final markup: a memo that stops firing shows up as a ratio that
 * climbs with document size.
 *
 * ## The unit: characters of markup RE-PROCESSED
 *
 * Counting `innerHTML`-family writes alone (what the DOM gate does) is not
 * enough here, because React's keyed paths do not write markup at all — they
 * build an element tree, and the instrument reads a flat 0 no matter how much
 * reconciling happens. Zero is not evidence of anything.
 *
 * So the unit is the SUM of two terms that are the same thing measured on two
 * paths: characters set through `innerHTML` / `textContent` / `nodeValue` /
 * `insertAdjacentHTML`, PLUS characters handed to `parseTrustedHtml`
 * (`getParseChars`), the tokenizer every `htmlToReact` call runs. Both answer
 * "how much markup did this commit have to chew again". A path that re-parses
 * the whole block per patch is quadratic in this unit whether it re-parses via
 * the browser's HTML parser or via ours; a keyed path that only touches what
 * changed is flat in it. Counting happens at the DOM boundary and inside the
 * tokenizer, not inside React, so it cannot be fooled by a renderer that merely
 * moves its work somewhere else.
 */

const wasmUrl = new URL("../src/wasm/brook_md_core_bg.wasm", import.meta.url);
const haveWasm = existsSync(wasmUrl);

let win: GlobalWindow;
let createRoot: (c: Element) => Root;
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
  g.window = win;
  g.navigator = win.navigator;
  g.HTMLElement = win.HTMLElement;
  g.Element = win.Element;
  g.Node = win.Node;
  (g as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  // Same instrumentation set as the DOM work-bound gate, so the two renderers'
  // numbers are directly comparable. React writes markup through
  // `dangerouslySetInnerHTML` (innerHTML) and text through textContent/nodeValue.
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
  const iah = (E as { insertAdjacentHTML: (p: string, h: string) => void }).insertAdjacentHTML;
  (E as { insertAdjacentHTML: unknown }).insertAdjacentHTML = function (
    this: unknown,
    pos: string,
    html: string,
  ) {
    chars += String(html).length;
    return iah.call(this, pos, html);
  };

  ({ createRoot } = await import("react-dom/client"));
  if (!haveWasm) return;
  const glue = "../src/wasm/brook_md_core.js"; // runtime specifier: no collection-time failure
  const mod = await import(glue);
  mod.initSync({ module: readFileSync(wasmUrl) });
  makeParser = (blockData: boolean) => {
    const p = new mod.BrookParser();
    p.setWireDelta(true);
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
  /** Markup characters re-processed: innerHTML-family writes + tokenizer input. */
  chars: number;
  finalMarkup: number;
  patches: number;
  /** The settled markup, for the byte-identity cross-check against one-shot. */
  markup: string;
  snapshot: Block[];
}

// Stream `doc` in 32-byte appends — the same cadence the DOM gate uses.
async function measure(
  doc: string,
  blockData: boolean,
  props: Record<string, unknown> = {},
  // Called with the tree's markup after EVERY commit. The guard assertions need
  // this: a guard on `block.open` only does anything while a block IS open, and
  // by settle every tree looks the same no matter what the guards did.
  probe?: (markup: string) => void,
): Promise<Sample> {
  const store: BlockStore = emptyBlockStore();
  const listeners = new Set<() => void>();
  const client = {
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getSnapshot: () => store.snapshot,
    __noteRender: () => {},
    __noteRebuild: () => {},
  } as never;
  const host = win.document.createElement("div");
  win.document.body.appendChild(host);
  const root = createRoot(host as never);
  await act(async () => {
    root.render(createElement(BrookMarkdown, { client, ...props } as never));
  });
  const p = makeParser(blockData);
  let patches = 0;
  // Count only the streaming work: the initial empty mount is not the subject.
  chars = 0;
  resetParseCount();
  const step = async (raw: string) => {
    applyPatch(store, JSON.parse(raw) as Patch);
    await act(async () => {
      for (const fn of listeners) fn();
    });
    patches++;
    if (probe) probe((host as unknown as { innerHTML: string }).innerHTML);
  };
  try {
    for (let i = 0; i < doc.length; i += 32) await step(p.append(doc.slice(i, i + 32)));
    await step(p.finalize());
  } finally {
    p.free();
  }
  const markup = (host as unknown as { innerHTML: string }).innerHTML;
  const sample = {
    chars: chars + getParseChars(),
    finalMarkup: markup.length,
    patches,
    markup,
    snapshot: store.snapshot,
  };
  await act(async () => {
    root.unmount();
  });
  host.remove();
  return sample;
}

/** A fresh tree that only ever sees the final snapshot — the settle reference. */
async function oneShot(snapshot: Block[]): Promise<string> {
  const store = emptyBlockStore();
  store.snapshot = snapshot;
  const client = {
    subscribe: () => () => {},
    getSnapshot: () => store.snapshot,
    __noteRender: () => {},
    __noteRebuild: () => {},
  } as never;
  const host = win.document.createElement("div");
  win.document.body.appendChild(host);
  const root = createRoot(host as never);
  await act(async () => {
    root.render(createElement(BrookMarkdown, { client } as never));
  });
  const markup = (host as unknown as { innerHTML: string }).innerHTML;
  await act(async () => {
    root.unmount();
  });
  host.remove();
  return markup;
}

// [name, document, bound as a multiple of the final markup]
//
// Measured (blockData on, default props), and FLAT across 5 / 20 KB — which is
// the property that actually matters, since a quadratic path doubles its ratio
// when the document doubles:
//
//   list        2.9× / 2.9×      (16,361 → 65,036 chars)
//   blockquote  3.4× / 3.4×      (18,107 → 73,121 chars)
//   table       1.4× / 1.4×      (19,253 → 76,338 chars)
//
// Those first two numbers are worth staring at: they are the SAME char counts,
// to the character, that the DOM renderer's keyed list and container syncs write
// on these fixtures. That is not a coincidence — both renderers re-process each
// item / nested sub-block once and then only the open last one per patch, so
// they chew the identical set of strings. Two independent implementations
// landing on the same number is the strongest available evidence that neither is
// doing hidden extra work.
//
// For contrast, on these same fixtures before this line of work:
//   DOM   list 283.9×, blockquote 317.5×  (keyed renderers rebuilt everything)
//   React blockquote 9.2× → 14.5× → 22.6× at 5/10/20 KB (KeyedContainer was
//         unreachable without a `components` map, so it fell to the html path)
const CASES: Array<[string, string, number]> = [
  ["20KB streamed list", listDoc(20 * KB), 4],
  ["20KB streamed blockquote", quoteDoc(20 * KB), 4],
  ["20KB streamed table", tableDoc(20 * KB), 4],
];

test.skipIf(!haveWasm)(
  "React's keyed list / container / table paths are incremental, not quadratic",
  async () => {
    for (const [name, doc, bound] of CASES) {
      const s = await measure(doc, true);
      expect(`${name}: ${s.patches > 500}`).toBe(`${name}: true`);
      const ratio = s.chars / s.finalMarkup;
      if (ratio > bound) {
        throw new Error(
          `${name}: React wrote ${s.chars} chars for a ${s.finalMarkup}-char document over ` +
            `${s.patches} patches — ${ratio.toFixed(1)}× final markup, bound is ${bound}×. ` +
            `A memo on the keyed streaming-tail path stopped firing.`,
        );
      }
    }
  },
  180_000,
);

test.skipIf(!haveWasm)(
  "the ratio stays flat as the document grows (the linearity signature)",
  async () => {
    // A quadratic apply doubles this ratio when the document doubles; a linear
    // one holds it. Checking the SHAPE, not just a threshold, is what makes the
    // bound above hard to satisfy by accident.
    for (const [name, gen] of [
      ["list", listDoc],
      ["blockquote", quoteDoc],
      ["table", tableDoc],
    ] as Array<[string, (n: number) => string]>) {
      const small = await measure(gen(5 * KB), true);
      const big = await measure(gen(20 * KB), true);
      const smallRatio = small.chars / small.finalMarkup;
      const bigRatio = big.chars / big.finalMarkup;
      // 4× the document for at most 1.5× the ratio. A quadratic path would be 4×.
      if (bigRatio > smallRatio * 1.5) {
        throw new Error(
          `${name}: ratio climbed ${smallRatio.toFixed(1)}× → ${bigRatio.toFixed(1)}× when the ` +
            `document grew 4× — that is the quadratic signature, not a linear apply.`,
        );
      }
    }
  },
  180_000,
);

/**
 * Being fast is only half of it: a keyed path that reconciles cheaply into the
 * WRONG tree is worse than the slow one. `KeyedContainer` builds its children
 * from the `nested` data channel rather than from `block.html`, so the thing to
 * prove is that the two agree once the dust settles.
 *
 * At settle the block is closed, the keyed path switches itself off (it is
 * `block.open`-gated) and the tree re-renders from the whole html — so a
 * streamed document and a one-shot mount of the same final snapshot must be
 * byte-identical. That is the convergence guarantee the streaming path is
 * allowed to be loose about mid-flight (a keyed container omits the inter-block
 * `\n` text nodes the raw html carries between its children — long-standing
 * behaviour, shared with dom.ts's `renderKeyedContainer`, and invisible in
 * layout since whitespace between block-level elements does not render).
 */
test.skipIf(!haveWasm)(
  "a streamed container settles byte-identical to a one-shot mount",
  async () => {
    for (const [name, doc] of [
      ["blockquote", quoteDoc(8 * KB)],
      ["alert", "> [!NOTE]\n> First para.\n>\n> - a list item\n> - another\n>\n> Closing para.\n"],
      ["list", listDoc(8 * KB)],
    ] as Array<[string, string]>) {
      const s = await measure(doc, true);
      expect(`${name}: ${s.markup}`).toBe(`${name}: ${await oneShot(s.snapshot)}`);
    }
  },
  180_000,
);

/**
 * The guards on the keyed-container branch, pinned against ABSOLUTE references
 * rather than against another render of the same code.
 *
 * This distinction is the whole reason these exist. Comparing two trees — even
 * one built with `__fullRebuild` — cannot catch a fault in the BRANCH CONDITION,
 * because both trees evaluate the same faulty condition and agree perfectly.
 * Mutation-testing confirmed it: dropping `block.open`, `!sanitize` or
 * `!hasInlineTransforms` left every comparison-based test green. Each assertion
 * below therefore checks the tree against something the branch cannot influence
 * — the block's own html, the sanitizer's contract, the decorator's output.
 */
test.skipIf(!haveWasm)("the keyed-container branch stays inside its guards", async () => {
  const doc = "> quoted para one\n>\n> quoted para two with secret inside\n>\n> third para\n";

  // block.open: a SETTLED container must be the whole-html rendering, which
  // keeps the inter-block `\n` between children that the keyed path drops. The
  // block's own `html` is the reference — it is what the renderer is supposed to
  // reproduce byte-for-byte once nothing is open any more.
  const settled = await measure(doc, true);
  const quote = settled.snapshot.find((b) => b.kind.type === "Blockquote")!;
  expect(quote).toBeDefined();
  expect(settled.markup.includes(quote.html)).toBe(true);

  // !sanitize: a sanitizer must see every byte of a container ON EVERY COMMIT,
  // not just once it settles. The keyed path cannot run it (it would have to run
  // over the whole wrapper string), so the branch must not fire at all.
  let leaked = 0;
  let sawMasked = false;
  await measure(doc, true, { sanitize: (h: string) => h.replace(/secret/g, "***") }, (m) => {
    if (m.includes("secret")) leaked++;
    if (m.includes("***")) sawMasked = true;
  });
  expect(`sanitizer leaks: ${leaked}`).toBe("sanitizer leaks: 0");
  expect(sawMasked).toBe(true);

  // !hasInlineTransforms: decorators walk the parsed subtree, which the keyed
  // path bypasses — so a decorated container must fall through to the walk path
  // for as long as it is streaming, not only at the end.
  let undecorated = 0;
  let sawDecoration = false;
  await measure(
    doc,
    true,
    { decorators: [{ match: /quoted/g, replace: (t: string) => `[${t}]` }] },
    (m) => {
      // Any commit showing the raw word outside its decorated form means the
      // decorator walk was skipped for that render.
      if (m.replace(/\[quoted\]/g, "").includes("quoted")) undecorated++;
      if (m.includes("[quoted]")) sawDecoration = true;
    },
  );
  expect(`undecorated commits: ${undecorated}`).toBe("undecorated commits: 0");
  expect(sawDecoration).toBe(true);
}, 180_000);
