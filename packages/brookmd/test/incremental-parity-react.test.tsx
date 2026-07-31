import { test, expect, beforeAll } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { GlobalWindow } from "happy-dom";
import { createElement, act } from "react";
import type { Root } from "react-dom/client";
import { applyPatch, emptyBlockStore, type BlockStore } from "../src/client";
import { BrookMarkdown } from "../src/react";
import type { Block, Patch } from "../src/types";

/**
 * DOM-PARITY FUZZ for the React renderer's incremental apply paths — the twin of
 * test/incremental-parity.test.ts.
 *
 * React's open code fence hands its `<code>` to a layout effect that mirrors
 * hi-inc's frozen/tail split, and its open generic block hands its `<div>` to
 * one that applies the wire delta. Both mutate DOM React nominally owns, so the
 * invariant has to be checked against React itself:
 *
 *   after EVERY commit, the incrementally-applied tree's markup equals the tree
 *   `__fullRebuild` produces from the same patch stream,
 *
 * and at settle both equal a fresh one-shot mount. The two trees subscribe to
 * the SAME store, so the only variable is the flag.
 */

const wasmUrl = new URL("../src/wasm/brook_md_core_bg.wasm", import.meta.url);
const haveWasm = existsSync(wasmUrl);

let win: GlobalWindow;
let createRoot: (c: Element) => Root;

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
  ({ createRoot } = await import("react-dom/client"));
  if (!haveWasm) return;
  const glue = "../src/wasm/brook_md_core.js"; // runtime specifier: no collection-time failure
  const mod = await import(glue);
  mod.initSync({ module: readFileSync(wasmUrl) });
  makeParser = (blockData: boolean) => {
    const p = new mod.BrookParser();
    p.setWireDelta(true);
    // blockData OFF routes lists/blockquotes/tables through the GENERIC html
    // path instead of their keyed renderers — the only way to reach the
    // splice's chain-shape guards from here.
    if (blockData) p.setBlockData(true);
    p.setGfmMath(true);
    p.setComponentTags(["Thinking"]);
    return p as WasmParser;
  };
});

interface WasmParser {
  append(chunk: string): string;
  finalize(): string;
  free(): void;
}
let makeParser: (blockData: boolean) => WasmParser;

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x1_0000_0000;
  };
}

function fakeClient(store: BlockStore, listeners: Set<() => void>) {
  return {
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getSnapshot: () => store.snapshot,
    __noteRender: () => {},
  } as never;
}

const LOREM = "streaming markdown parser incremental speculative closure renderer";

const CORPUS: Array<[string, string]> = [
  ["paragraphs", `First ${LOREM}.\n\nSecond ${LOREM} paragraph.\n\nThird.\n`],
  [
    "inline-revisions",
    `A **bold run** and *em* and \`code\` and [a link](https://example.com/x) plus ` +
      `[b](https://example.com/y?a=1&b=2) and ~~struck~~ ${LOREM}.\n`,
  ],
  ["headings-rules", "# Title\n\n## Sub *title*\n\n---\n\n### Third\n\nBody.\n"],
  [
    "code-ts",
    "```ts\nexport function a(x: number): string {\n  const s = `v${x}`; // note\n  return s.repeat(2);\n}\n```\n",
  ],
  [
    "code-python-triple",
    '```python\ndef f(x):\n    """Doc\n    lines.\n    """\n    return x\n```\n',
  ],
  ["code-nolang", "```\nplain fence <not html> & stuff\nline two\n```\n"],
  ["list", `- one ${LOREM}\n- two **bold**\n- three\n  - nested\n\n1. first\n2. second\n`],
  ["table", "| a | b |\n|:--|--:|\n| 1 | 2 |\n| 3 | 4 |\n"],
  ["blockquote", `> quoted ${LOREM}\n>\n> second para\n`],
  ["alert", "> [!NOTE]\n> Alert body.\n"],
  ["math", "Inline $a^2$ math.\n\n$$\n\\frac{1}{2}\n$$\n"],
  ["html-block", "<section>\n<p>raw html</p>\n</section>\n\nAfter.\n"],
  ["component", "<Thinking>\nSome **thought**.\n</Thinking>\n\nAfter.\n"],
];

const MODES: Array<[string, Record<string, unknown>]> = [
  ["default", {}],
  ["streamingHighlight:false", { streamingHighlight: false }],
  ["childMemo", { childMemo: true }],
];

async function drive(
  doc: string,
  chunk: number,
  props: Record<string, unknown>,
  blockData: boolean,
  onCommit: (a: string, b: string) => void,
): Promise<{ markup: string; snapshot: Block[] }> {
  const store = emptyBlockStore();
  const listeners = new Set<() => void>();
  const client = fakeClient(store, listeners);
  const hostA = win.document.createElement("div");
  const hostB = win.document.createElement("div");
  win.document.body.appendChild(hostA);
  win.document.body.appendChild(hostB);
  const rootA = createRoot(hostA as never);
  const rootB = createRoot(hostB as never);
  await act(async () => {
    rootA.render(createElement(BrookMarkdown, { client, ...props } as never));
    rootB.render(createElement(BrookMarkdown, { client, ...props, __fullRebuild: true } as never));
  });
  const p = makeParser(blockData);
  const step = async (raw: string) => {
    applyPatch(store, JSON.parse(raw) as Patch);
    await act(async () => {
      for (const fn of listeners) fn();
    });
    onCommit((hostA as unknown as { innerHTML: string }).innerHTML, (hostB as unknown as { innerHTML: string }).innerHTML);
  };
  try {
    for (let i = 0; i < doc.length; i += chunk) await step(p.append(doc.slice(i, i + chunk)));
    await step(p.finalize());
  } finally {
    p.free();
  }
  const markup = (hostA as unknown as { innerHTML: string }).innerHTML;
  const snapshot = store.snapshot;
  await act(async () => {
    rootA.unmount();
    rootB.unmount();
  });
  hostA.remove();
  hostB.remove();
  return { markup, snapshot };
}

/** A fresh tree that only ever sees the final snapshot. */
async function oneShot(snapshot: Block[], props: Record<string, unknown>): Promise<string> {
  const store = emptyBlockStore();
  store.snapshot = snapshot;
  const client = fakeClient(store, new Set());
  const host = win.document.createElement("div");
  win.document.body.appendChild(host);
  const root = createRoot(host as never);
  await act(async () => {
    root.render(createElement(BrookMarkdown, { client, ...props } as never));
  });
  const html = (host as unknown as { innerHTML: string }).innerHTML;
  await act(async () => root.unmount());
  host.remove();
  return html;
}

test.skipIf(!haveWasm)(
  "React: incrementally-applied tree equals the full-rebuild tree after every commit",
  async () => {
    const rand = rng(20260731);
    let commits = 0;
    for (const [modeName, props] of MODES) {
     for (const blockData of [true, false]) {
      for (const [name, doc] of CORPUS) {
        // Biased small so the same budget buys many more commits, and many more
        // mid-token chunk boundaries, than a uniform 1..48 would.
        const chunk = 1 + Math.floor(rand() ** 2 * 48);
        const { markup, snapshot } = await drive(doc, chunk, props, blockData, (a, b) => {
          commits++;
          if (a !== b) {
            throw new Error(
              `[${modeName}/${name} bd=${blockData} chunk=${chunk}] spliced tree diverged from full rebuild:\n` +
                `  spliced: ${a.slice(0, 600)}\n  rebuilt: ${b.slice(0, 600)}`,
            );
          }
        });
        expect(`${modeName}/${name}/${blockData}/${chunk}: ${markup}`).toBe(
          `${modeName}/${name}/${blockData}/${chunk}: ${await oneShot(snapshot, props)}`,
        );
      }
     }
    }
    expect(commits).toBeGreaterThan(1000);
  },
  120_000,
);
