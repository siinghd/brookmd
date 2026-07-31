import { test, expect, beforeAll } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { GlobalWindow } from "happy-dom";
import { applyPatch, emptyBlockStore, type BlockStore } from "../src/client";
import { mountBrookMarkdown, type MountOptions } from "../src/dom";
import type { Patch } from "../src/types";

/**
 * SELECTION AND SCROLL SURVIVAL.
 *
 * The user-visible half of the incremental apply. A full rebuild swapped the
 * block's node on every patch (`existing.node.replaceWith(node)`), so a text
 * selection inside a streaming block — or a `<pre>`'s horizontal scroll offset —
 * was destroyed roughly 30 times a second: you could not select text out of a
 * code fence until it finished, and the fence scrolled itself back to 0 while
 * you were reading it.
 *
 * Both now ride on the same guarantee: the nodes carrying already-settled bytes
 * are never replaced. These tests hold a `Range` over text in the frozen region
 * and assert it still resolves to the same text after many more patches — and
 * that the same test FAILS against `__fullRebuild`, so it is pinning the fix and
 * not something that was always true.
 */

const wasmUrl = new URL("../src/wasm/brook_md_core_bg.wasm", import.meta.url);
const haveWasm = existsSync(wasmUrl);

interface WasmParser {
  append(chunk: string): string;
  finalize(): string;
  free(): void;
}
let makeParser: () => WasmParser;

beforeAll(async () => {
  const win = new GlobalWindow();
  const g = globalThis as Record<string, unknown>;
  g.document = win.document;
  g.HTMLElement = win.HTMLElement;
  g.Element = win.Element;
  g.Node = win.Node;
  g.Range = win.Range;
  g.navigator = win.navigator;
  if (!haveWasm) return;
  const glue = "../src/wasm/brook_md_core.js"; // runtime specifier: no collection-time failure
  const mod = await import(glue);
  mod.initSync({ module: readFileSync(wasmUrl) });
  makeParser = () => {
    const p = new mod.BrookParser();
    p.setWireDelta(true);
    p.setBlockData(true);
    return p as WasmParser;
  };
});

/** Drive `doc` in 32-byte appends, pausing at `pauseAt` to run `hold`. */
function stream(
  doc: string,
  opts: MountOptions,
  pauseAt: number,
  hold: (root: HTMLElement) => () => boolean,
): boolean {
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
  let check: (() => boolean) | null = null;
  let patches = 0;
  try {
    for (let i = 0; i < doc.length; i += 32) {
      applyPatch(store, JSON.parse(p.append(doc.slice(i, i + 32))) as Patch);
      for (const fn of listeners) fn();
      patches++;
      if (patches === pauseAt) check = hold(container);
    }
  } finally {
    p.free();
  }
  const survived = check !== null && check();
  handle.destroy();
  container.remove();
  return survived;
}

const CODE =
  "```ts\n" +
  Array.from(
    { length: 40 },
    (_, i) => `export function fn${i}(a: number): string {\n  return \`v\${a * ${i}}\`;\n}`,
  ).join("\n") +
  "\n```\n";

const PROSE =
  Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ") + "\n";

// A TIGHT list (no blank lines), so no item is ever legitimately rewritten by a
// tight→loose flip: every `<li>` before the last one is settled for good.
const LIST =
  Array.from({ length: 60 }, (_, i) => `- item ${i} with several words here`).join("\n") + "\n";

// A blockquote whose `nested` sub-blocks settle one at a time.
const QUOTE =
  Array.from({ length: 40 }, (_, i) => `> para ${i} with several words here`).join("\n>\n") + "\n";

/** Select the first text node under `sel` that has some text, and remember it. */
function holdSelection(root: HTMLElement, sel: string): () => boolean {
  const target = root.querySelector(sel)!;
  expect(target).not.toBeNull();
  const walk = (n: Node): Text | null => {
    if (n.nodeType === 3 && (n.nodeValue ?? "").trim().length > 4) return n as Text;
    for (let c = n.firstChild; c; c = c.nextSibling) {
      const hit = walk(c);
      if (hit) return hit;
    }
    return null;
  };
  const text = walk(target)!;
  expect(text).not.toBeNull();
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, 4);
  const selected = range.toString();
  expect(selected.length).toBe(4);
  return () => {
    // A live Range whose container was detached collapses / stops matching. If
    // the node survived untouched, it still resolves to the same four chars AND
    // is still attached to the document.
    if (!root.contains(range.startContainer)) return false;
    return range.toString() === selected;
  };
}

test.skipIf(!haveWasm)("a selection in an open code fence's frozen region survives later patches", () => {
  expect(stream(CODE, {}, 12, (root) => holdSelection(root, "code"))).toBe(true);
});

test.skipIf(!haveWasm)("…and is destroyed by the full-rebuild path (so the test pins the fix)", () => {
  expect(stream(CODE, { __fullRebuild: true }, 12, (root) => holdSelection(root, "code"))).toBe(false);
});

test.skipIf(!haveWasm)("a selection in an open paragraph survives later patches", () => {
  expect(stream(PROSE, {}, 12, (root) => holdSelection(root, ".brook-block-paragraph"))).toBe(true);
});

test.skipIf(!haveWasm)("…and is destroyed by the full-rebuild path", () => {
  expect(
    stream(PROSE, { __fullRebuild: true }, 12, (root) => holdSelection(root, ".brook-block-paragraph")),
  ).toBe(false);
});

// The keyed list / container renderers used to re-stamp EVERY `<li>` (and every
// nested sub-block) on every patch, so a selection in a settled list item was
// destroyed just as reliably as one in a rebuilt block — it just did not go
// through `replaceWith` to get there. These pin the keyed syncs' half of the
// guarantee: an item that is not the open last one is never written again.
test.skipIf(!haveWasm)("a selection in a settled <li> survives later item appends", () => {
  expect(stream(LIST, {}, 12, (root) => holdSelection(root, "li"))).toBe(true);
});

test.skipIf(!haveWasm)("…and is destroyed by the full-rebuild path (so the test pins the fix)", () => {
  expect(stream(LIST, { __fullRebuild: true }, 12, (root) => holdSelection(root, "li"))).toBe(false);
});

test.skipIf(!haveWasm)("a selection in a settled blockquote sub-block survives later appends", () => {
  expect(stream(QUOTE, {}, 12, (root) => holdSelection(root, "blockquote p"))).toBe(true);
});

test.skipIf(!haveWasm)("…and is destroyed by the full-rebuild path", () => {
  expect(
    stream(QUOTE, { __fullRebuild: true }, 12, (root) => holdSelection(root, "blockquote p")),
  ).toBe(false);
});

test.skipIf(!haveWasm)("an open code fence's <pre> keeps its scroll offset across patches", () => {
  const survived = stream(CODE, {}, 12, (root) => {
    const pre = root.querySelector("pre") as HTMLElement;
    expect(pre).not.toBeNull();
    // happy-dom has no layout, so scrollLeft is just a property — which is
    // exactly the point: it lives on the ELEMENT, so it survives iff the element
    // does. A rebuilt node comes back at 0.
    pre.scrollLeft = 128;
    return () => {
      const now = root.querySelector("pre") as HTMLElement | null;
      return now === pre && now.scrollLeft === 128;
    };
  });
  expect(survived).toBe(true);
});

test.skipIf(!haveWasm)("…and loses it under the full-rebuild path", () => {
  const survived = stream(CODE, { __fullRebuild: true }, 12, (root) => {
    const pre = root.querySelector("pre") as HTMLElement;
    pre.scrollLeft = 128;
    return () => {
      const now = root.querySelector("pre") as HTMLElement | null;
      return now === pre && now.scrollLeft === 128;
    };
  });
  expect(survived).toBe(false);
});
