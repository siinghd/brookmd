import { test, expect, beforeAll } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { GlobalWindow } from "happy-dom";
import { applyPatch, emptyBlockStore, type BlockStore } from "../src/client";
import { mountBrookMarkdown, type MountOptions } from "../src/dom";
import { __keyedStats, __resetKeyedStats } from "../src/dom";
import { __resetSpliceStats, __spliceStats } from "../src/splice";
import type { Block, Patch } from "../src/types";

/**
 * DOM-PARITY FUZZ for the incremental apply paths.
 *
 * The renderer no longer rebuilds an open block's node on every patch: an open
 * code fence mirrors hi-inc's frozen/tail split into its live `<code>`, and a
 * generic open block splices the wire delta's `append` into its existing
 * subtree. Both are pure optimizations, so the invariant is absolute:
 *
 *   after EVERY sync, the spliced DOM's `innerHTML` is identical to what the
 *   full-rebuild path would have produced from the same patch stream,
 *
 * and at close the settled document is identical to a fresh one-shot mount.
 * Zero tolerance — a fast path that is ever wrong is worse than no fast path.
 *
 * Both mounts read the SAME store, so their inputs are identical by
 * construction and the only variable is `__fullRebuild`. The corpus is driven
 * through the REAL WASM at randomized chunk sizes so the speculative-revision
 * streams (half-written links, growing emphasis, speculatively closed fences)
 * are the parser's own, not hand-written approximations of them.
 */

const wasmUrl = new URL("../src/wasm/brook_md_core_bg.wasm", import.meta.url);
const haveWasm = existsSync(wasmUrl);

beforeAll(async () => {
  const win = new GlobalWindow();
  const g = globalThis as Record<string, unknown>;
  g.document = win.document;
  g.HTMLElement = win.HTMLElement;
  g.Element = win.Element;
  g.Node = win.Node;
  g.navigator = win.navigator;
  if (!haveWasm) return;
  const glue = "../src/wasm/brook_md_core.js"; // runtime specifier: no collection-time failure
  const mod = await import(glue);
  mod.initSync({ module: readFileSync(wasmUrl) });
  makeParser = (blockData: boolean) => {
    const p = new mod.BrookParser();
    p.setWireDelta(true);
    // blockData OFF is not a curiosity: it routes lists, blockquotes and tables
    // through the GENERIC html path instead of their keyed renderers, which is
    // the only way the fuzz reaches the splice's chain-shape guards (a `<tr>`
    // insertion point, a `<ul>` with structural whitespace between its items).
    if (blockData) p.setBlockData(true);
    p.setGfmMath(true);
    p.setComponentTags(["Thinking", "Tool"]);
    return p as WasmParser;
  };
});

interface WasmParser {
  append(chunk: string): string;
  finalize(): string;
  free(): void;
}
let makeParser: (blockData: boolean) => WasmParser;

// A tiny deterministic PRNG so a failure is reproducible from its seed alone.
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x1_0000_0000;
  };
}

// The renderer only reads these three members off the client.
function fakeClient(store: BlockStore, listeners: Set<() => void>) {
  return {
    getSnapshot: () => store.snapshot,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    __noteRebuild: () => {},
  } as never;
}

function mount(store: BlockStore, listeners: Set<() => void>, opts: MountOptions) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const handle = mountBrookMarkdown(fakeClient(store, listeners), container as never, {
    batch: false,
    ...opts,
  });
  return { container, handle };
}

/** The reference render: a brand-new renderer fed only the final snapshot. */
function oneShot(snapshot: Block[], opts: MountOptions): string {
  const store = emptyBlockStore();
  store.snapshot = snapshot;
  const listeners = new Set<() => void>();
  const { container, handle } = mount(store, listeners, opts);
  const html = container.innerHTML;
  handle.destroy();
  container.remove();
  return html;
}

interface Run {
  syncs: number;
  spliced: string;
  rebuilt: string;
  snapshot: Block[];
}

// Drive one document through the real parser at `chunk`-sized appends, feeding
// every patch to BOTH renderers and comparing after each one.
function drive(
  doc: string,
  chunk: number,
  opts: MountOptions,
  blockData: boolean,
  onSync: (a: string, b: string) => void,
): Run {
  const store = emptyBlockStore();
  const listeners = new Set<() => void>();
  const a = mount(store, listeners, opts);
  const b = mount(store, listeners, { ...opts, __fullRebuild: true });
  const p = makeParser(blockData);
  let syncs = 0;
  const step = (raw: string) => {
    applyPatch(store, JSON.parse(raw) as Patch);
    for (const fn of listeners) fn();
    syncs++;
    onSync(a.container.innerHTML, b.container.innerHTML);
  };
  try {
    for (let i = 0; i < doc.length; i += chunk) step(p.append(doc.slice(i, i + chunk)));
    step(p.finalize());
  } finally {
    p.free();
  }
  const out = { syncs, spliced: a.container.innerHTML, rebuilt: b.container.innerHTML, snapshot: store.snapshot };
  a.handle.destroy(); a.container.remove();
  b.handle.destroy(); b.container.remove();
  return out;
}

// --------------------------------------------------------------------------
// Corpus — every block kind, plus the shapes whose streams are heaviest in
// speculative revisions (a link is a `<a data-brook-pending>` until its `)`
// lands; emphasis is literal `**` text until it closes; a fence is
// speculatively closed on every single patch).
// --------------------------------------------------------------------------

const LOREM = "streaming markdown parser incremental speculative closure renderer tokens";

const CORPUS: Array<[string, string]> = [
  ["paragraphs", `First paragraph ${LOREM}.\n\nSecond ${LOREM} paragraph here.\n\nThird one.\n`],
  [
    "inline-revisions",
    `A **bold run** and *emphasis* and \`code span\` and [a link](https://example.com/x) plus ` +
      `[another](https://example.com/y?a=1&b=2) and ~~struck~~ text ${LOREM}.\n`,
  ],
  ["headings-rules", "# Title\n\n## Sub *title*\n\n---\n\n### Third\n\nBody text.\n"],
  [
    "code-ts",
    "```ts\nexport function a(x: number): string {\n  const s = `v${x}`; // note\n  return s.repeat(2);\n}\n" +
      "export const b = [1, 2, 3].map((n) => n * 2);\n```\n",
  ],
  [
    "code-python-triple",
    '```python\ndef f(x):\n    """A docstring\n    spanning lines.\n    """\n    return x * 2\n\n\nclass C:\n    pass\n```\n',
  ],
  ["code-blockcomment", "```rust\n/* a block\n   comment */\nfn main() {\n    println!(\"hi\");\n}\n```\n"],
  ["code-nolang", "```\nplain fence <not html> & stuff\nsecond line\n```\n"],
  ["code-html", "```html\n<div class=\"a\">\n  <span>text</span>\n</div>\n```\n"],
  ["list", `- one ${LOREM}\n- two with **bold**\n- three\n  - nested a\n  - nested b\n\n1. first\n2. second\n`],
  ["tasklist", "- [ ] todo one\n- [x] done two\n- [ ] todo three\n"],
  ["table", "| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n| 7 | 8 | 9 |\n"],
  ["blockquote", `> quoted ${LOREM}\n>\n> second para of quote\n>\n> - a list\n> - inside\n`],
  ["alert", "> [!NOTE]\n> An alert body.\n>\n> With two paragraphs.\n"],
  ["math", "Inline $a^2 + b^2$ math.\n\n$$\n\\frac{1}{2} + \\sum_{i=0}^{n} i\n$$\n"],
  ["html-block", "<section>\n<p>raw html</p>\n</section>\n\nAfter the html.\n"],
  ["component", "<Thinking>\nSome **thought** text.\n\nMore of it.\n</Thinking>\n\nAfter.\n"],
  // --- shapes that stress the KEYED list / container syncs (blockData on) ---
  // A list long enough that the keyed sync runs for most of the stream, so a
  // mis-keyed or skipped item shows up as a divergence rather than being hidden
  // by the block committing after two patches.
  ["list-long", Array.from({ length: 24 }, (_, i) => `- item ${i} ${LOREM}`).join("\n") + "\n"],
  // THE flip: a blank line makes the whole list loose, so EVERY item's html is
  // rewritten (`a` → `<p>a</p>`) in one patch. A sync that only ever resynced
  // the tail item would leave every earlier `<li>` stale here.
  ["list-tight-to-loose", "- a one\n- b two\n- c three\n\n- d four\n- e five\n"],
  // The same flip reached the other way — an item that grows a second paragraph.
  ["list-item-two-paras", "- first item\n- second item\n\n  continued para\n- third item\n"],
  ["list-ordered-start", "5. five\n6. six\n7. seven\n8. eight\n"],
  ["list-ordered-loose", "1. one\n\n2. two\n\n3. three\n"],
  ["list-nested-grow", "- a\n  - a1\n  - a2\n- b\n  - b1\n    - b1a\n- c\n"],
  ["list-mixed-inline", "- **bold** item\n- [link](https://e.co/1) item\n- `code` item\n- ~~struck~~ item\n"],
  // Containers: many nested sub-blocks of several kinds, so the (index, html)
  // key is exercised over entries that are not all `<p>`.
  [
    "blockquote-long",
    Array.from({ length: 10 }, (_, i) => `> para ${i} ${LOREM}`).join("\n>\n") + "\n",
  ],
  ["blockquote-kinds", "> # head\n>\n> para text\n>\n> - li a\n> - li b\n>\n> ```js\n> const x = 1;\n> ```\n>\n> last para\n"],
  ["blockquote-nested-quote", "> outer para\n>\n> > inner quote\n> > more inner\n>\n> outer again\n"],
  ["alert-long", "> [!WARNING]\n> First para of the alert.\n>\n> - a list item\n> - another\n>\n> Closing para.\n"],
  ["alert-tip", "> [!TIP]\n> Tip body ${LOREM}.\n>\n> Second para.\n"],
  [
    "mixed",
    `# Doc\n\nIntro ${LOREM} with [link](https://e.co/1).\n\n\`\`\`js\nconst x = \`t${"$"}{1}\`;\n\`\`\`\n\n` +
      `> quote\n\n- a\n- b\n\n| h | i |\n|---|---|\n| 1 | 2 |\n\nDone.\n`,
  ],
];

const MODES: Array<[string, MountOptions]> = [
  ["default", {}],
  ["streamingHighlight:false", { streamingHighlight: false }],
];

test.skipIf(!haveWasm)("spliced DOM equals full-rebuild DOM after every sync, and one-shot at settle", () => {
  __resetSpliceStats();
  __resetKeyedStats();
  const rand = rng(20260731);
  let syncs = 0;
  let cases = 0;
  for (const [modeName, opts] of MODES) {
   for (const blockData of [true, false]) {
    for (const [name, doc] of CORPUS) {
      for (let k = 0; k < 4; k++) {
        // Squared → biased small, so the same budget buys many more syncs (and
        // many more mid-token boundaries) than a uniform 1..64 would.
        const chunk = 1 + Math.floor(rand() ** 2 * 64);
        cases++;
        const run = drive(doc, chunk, opts, blockData, (a, b) => {
          if (a !== b) {
            throw new Error(
              `[${modeName}/${name} bd=${blockData} chunk=${chunk}] spliced DOM diverged from full rebuild:\n` +
                `  spliced: ${a.slice(0, 600)}\n  rebuilt: ${b.slice(0, 600)}`,
            );
          }
        });
        syncs += run.syncs;
        // Settled: identical to a renderer that only ever saw the final snapshot.
        expect(`${modeName}/${name}/${blockData}/${chunk}: ${run.spliced}`).toBe(
          `${modeName}/${name}/${blockData}/${chunk}: ${oneShot(run.snapshot, opts)}`,
        );
      }
    }
   }
  }
  expect(cases).toBe(MODES.length * 2 * CORPUS.length * 4);
  expect(syncs).toBeGreaterThan(4000);
  // The whole point is that the fast path FIRES. A change that quietly turns
  // every patch back into a rebuild would otherwise pass every assertion above.
  const stats = __spliceStats();
  expect(stats.attempts).toBeGreaterThan(400);
  expect(stats.hits / stats.attempts).toBeGreaterThan(0.8);
  // Same for the keyed list / container syncs. These route AROUND the splice
  // (they never reach `spliceHtml`), so the counter above says nothing about
  // them — without this a sync that returned `false` on every patch would be
  // perfectly correct, perfectly quadratic, and perfectly silent.
  const keyed = __keyedStats();
  expect(keyed.attempts).toBeGreaterThan(400);
  expect(keyed.hits / keyed.attempts).toBeGreaterThan(0.9);
}, 120_000);

test.skipIf(!haveWasm)("parity holds with a sanitizer, decorators, virtualize and overrides in play", () => {
  const rand = rng(7);
  const variants: Array<[string, MountOptions]> = [
    ["sanitize", { sanitize: (h) => h }],
    ["virtualize", { virtualize: true }],
    ["stickToBottom", { stickToBottom: true }],
    ["urlTransform", { urlTransform: (u) => u }],
    ["decorators", { decorators: [{ match: /parser/g, replace: (t) => `[${t}]` }] }],
    ["morphOpenBlocks", { morphOpenBlocks: true }],
    ["highlightCode:false", { highlightCode: false }],
  ];
  for (const [vname, opts] of variants) {
    for (const blockData of [true, false]) {
      for (const [name, doc] of CORPUS) {
        const chunk = 1 + Math.floor(rand() * 40);
        drive(doc, chunk, opts, blockData, (a, b) => {
          if (a !== b) {
            throw new Error(
              `[${vname}/${name} bd=${blockData} chunk=${chunk}] diverged:\n` +
                `  spliced: ${a.slice(0, 600)}\n  rebuilt: ${b.slice(0, 600)}`,
            );
          }
        });
      }
    }
  }
}, 120_000);
