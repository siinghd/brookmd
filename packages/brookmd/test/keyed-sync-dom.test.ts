import { test, expect, beforeAll } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { emptyBlockStore, type BlockStore } from "../src/client";
import { mountBrookMarkdown, type MountOptions } from "../src/dom";
import type { Block, ContainerData, ListData } from "../src/types";

/**
 * KEYED LIST / CONTAINER SYNC — the shapes the parser fuzz cannot reach.
 *
 * test/incremental-parity.test.ts drives the keyed syncs through the REAL wasm,
 * which is the right way to test what actually happens. But a real parser only
 * ever emits a few of the transitions the sync has guards for: it never
 * withdraws a settled list item, never turns an `<ol>` back into a `<ul>`
 * mid-block, never renumbers a `start` under a live node. Mutation-testing the
 * sync showed exactly that — faults seeded into those guards SURVIVED the fuzz,
 * because nothing in a parser-generated stream distinguishes them.
 *
 * So this file feeds the renderer hand-built snapshots instead. Same contract as
 * the fuzz: two renderers over one store, one incremental and one
 * `__fullRebuild`, `innerHTML` compared after every sync. Hand-built blocks are
 * legitimate input here precisely because the guards exist to survive input the
 * renderer did not predict — if a snapshot the sync cannot prove arrives, it has
 * to bail to a rebuild, not corrupt the tree.
 */

beforeAll(() => {
  const win = new GlobalWindow();
  const g = globalThis as Record<string, unknown>;
  g.document = win.document;
  g.HTMLElement = win.HTMLElement;
  g.Element = win.Element;
  g.Node = win.Node;
  g.navigator = win.navigator;
});

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

/**
 * Push each snapshot in turn at BOTH an incremental renderer and a full-rebuild
 * one, and assert their markup matches after every step — plus a fresh one-shot
 * mount of the final snapshot, which is what "the tree is genuinely correct, not
 * just self-consistent" means.
 */
function parity(name: string, steps: Block[][], opts: MountOptions = {}): void {
  const store = emptyBlockStore();
  const listeners = new Set<() => void>();
  const a = mount(store, listeners, opts);
  const b = mount(store, listeners, { ...opts, __fullRebuild: true });
  steps.forEach((snapshot, i) => {
    store.snapshot = snapshot;
    for (const fn of listeners) fn();
    expect(`${name} step ${i}: ${a.container.innerHTML}`).toBe(
      `${name} step ${i}: ${b.container.innerHTML}`,
    );
  });
  // Settled: identical to a renderer that only ever saw the final snapshot.
  const one = mount(Object.assign(emptyBlockStore(), { snapshot: steps[steps.length - 1] }), new Set(), opts);
  expect(`${name} one-shot: ${a.container.innerHTML}`).toBe(`${name} one-shot: ${one.container.innerHTML}`);
  one.handle.destroy();
  one.container.remove();
  a.handle.destroy();
  a.container.remove();
  b.handle.destroy();
  b.container.remove();
}

// ---------------------------------------------------------------------------
// Builders. `html` is kept consistent with the keyed data because the renderer
// falls back to it whenever the keyed path bails — which is the whole point of
// several of these cases.
// ---------------------------------------------------------------------------

function listBlock(data: ListData, open = true, speculative = false): Block[] {
  const tag = data.ordered ? "ol" : "ul";
  const startAttr =
    data.ordered && data.start !== undefined && data.start !== 1 ? ` start="${data.start}"` : "";
  const html =
    `<${tag}${startAttr}>\n` +
    (data.items ?? []).map((it) => `<li>${it.html}</li>\n`).join("") +
    `</${tag}>`;
  return [{ id: 1, kind: { type: "List", data }, start: 0, end: html.length, html, open, speculative }];
}

function quoteBlock(data: ContainerData, dir = "", open = true): Block[] {
  const attr = dir ? ` dir="${dir}"` : "";
  const html = `<blockquote${attr}>\n` + data.nested.map((n) => n.html + "\n").join("") + `</blockquote>`;
  return [
    { id: 1, kind: { type: "Blockquote", data }, start: 0, end: html.length, html, open, speculative: false },
  ];
}

function alertBlock(nested: string[], kindName = "note", open = true): Block[] {
  const title = `<p class="markdown-alert-title">${kindName.toUpperCase()}</p>`;
  const html =
    `<div class="markdown-alert markdown-alert-${kindName}" data-alert="${kindName}">\n` +
    title +
    "\n" +
    nested.map((h) => h + "\n").join("") +
    `</div>`;
  const data: ContainerData & { kind: string } = { kind: kindName, nested: nested.map((h) => ({ html: h })) };
  return [{ id: 1, kind: { type: "Alert", data }, start: 0, end: html.length, html, open, speculative: false }];
}

const items = (...htmls: string[]): ListData => ({ ordered: false, items: htmls.map((html) => ({ html })) });

// ---------------------------------------------------------------------------

test("a list that grows item by item stays in parity", () => {
  parity("grow", [
    listBlock(items("a")),
    listBlock(items("a", "b")),
    listBlock(items("a", "b", "c")),
    listBlock(items("a", "b", "c", "d one")),
    listBlock(items("a", "b", "c", "d one two")),
  ]);
});

test("a list whose trailing items are WITHDRAWN drops their <li>s", () => {
  // A speculative revision can shorten the tail. Nothing in a parser-driven
  // stream does this today, which is exactly why it is pinned here: the removal
  // loop is otherwise untested code that a refactor could delete unnoticed.
  parity("shrink", [
    listBlock(items("a", "b", "c", "d")),
    listBlock(items("a", "b", "c")),
    listBlock(items("a")),
    listBlock(items("a", "b2")),
  ]);
});

test("a tight->loose flip rewrites every item, not just the last", () => {
  // The flip the design notes call out: one patch legitimately changes EVERY
  // item's html. A sync that only ever resyncs the tail leaves items 0..n-2
  // showing their old tight markup.
  parity("flip", [
    listBlock(items("a", "b", "c")),
    listBlock(items("<p>a</p>", "<p>b</p>", "<p>c</p>")),
    listBlock(items("<p>a</p>", "<p>b</p>", "<p>c</p>", "<p>d</p>")),
  ]);
});

test("an ordered list's start attribute tracks the data", () => {
  parity("start", [
    listBlock({ ordered: true, start: 5, items: [{ html: "five" }] }),
    listBlock({ ordered: true, start: 5, items: [{ html: "five" }, { html: "six" }] }),
    // A renumber under a live node: the `start="N"` attribute has to follow.
    listBlock({ ordered: true, start: 9, items: [{ html: "five" }, { html: "six" }] }),
    // …and back to the default, where the attribute must be REMOVED, not left.
    listBlock({ ordered: true, start: 1, items: [{ html: "five" }, { html: "six" }] }),
    listBlock({ ordered: true, items: [{ html: "five" }, { html: "six" }] }),
  ]);
});

test("an ordered<->unordered flip rebuilds instead of keeping the wrong element", () => {
  parity("ordered-flip", [
    listBlock({ ordered: true, start: 1, items: [{ html: "a" }, { html: "b" }] }),
    listBlock({ ordered: false, items: [{ html: "a" }, { html: "b" }] }),
    listBlock({ ordered: true, start: 3, items: [{ html: "a" }, { html: "b" }] }),
  ]);
});

test("an emptied items channel falls back to the whole-html path", () => {
  parity("emptied", [
    listBlock(items("a", "b")),
    listBlock({ ordered: false, items: [] }),
    listBlock(items("a", "b", "c")),
    listBlock({ ordered: false }),
  ]);
});

test("a list closing mid-stream rebuilds through the generic path", () => {
  parity("close", [
    listBlock(items("a", "b")),
    listBlock(items("a", "b", "c")),
    listBlock(items("a", "b", "c"), false),
  ]);
});

test("a blockquote's nested sub-blocks grow, change and withdraw in parity", () => {
  const q = (...h: string[]): ContainerData => ({ nested: h.map((html) => ({ html })) });
  parity("quote", [
    quoteBlock(q("<p>one</p>")),
    quoteBlock(q("<p>one two</p>")),
    quoteBlock(q("<p>one two</p>", "<p>second</p>")),
    quoteBlock(q("<p>one two</p>", "<ul>\n<li>a</li>\n</ul>")),
    quoteBlock(q("<p>one two</p>", "<ul>\n<li>a</li>\n<li>b</li>\n</ul>", "<h2>head</h2>")),
    quoteBlock(q("<p>one two</p>")),
  ]);
});

test("a blockquote whose OPENING TAG changes rebuilds its wrapper", () => {
  // The wrapper's attributes are stamped once at build time, so a changed
  // opening tag must not be applied to the old element — it has to rebuild.
  const q = (...h: string[]): ContainerData => ({ nested: h.map((html) => ({ html })) });
  parity("quote-attrs", [
    quoteBlock(q("<p>one</p>"), ""),
    quoteBlock(q("<p>one</p>", "<p>two</p>"), ""),
    quoteBlock(q("<p>one</p>", "<p>two</p>"), "auto"),
    quoteBlock(q("<p>one</p>", "<p>two</p>", "<p>three</p>"), "auto"),
    quoteBlock(q("<p>one</p>", "<p>two</p>", "<p>three</p>"), "rtl"),
  ]);
});

test("an alert keeps its title as child 0 while nested entries change under it", () => {
  // The alert title is the one wrapper child the (index, html) key does NOT
  // cover, so nested entry i lives at child offset+i. Dropping that offset
  // writes sub-block 0 over the TITLE — which only shows up when an alert's
  // nested entries are revised, not merely appended.
  parity("alert", [
    alertBlock(["<p>body</p>"]),
    alertBlock(["<p>body text</p>"]),
    alertBlock(["<p>body text more</p>"]),
    alertBlock(["<p>body text more</p>", "<p>second</p>"]),
    alertBlock(["<p>body text more</p>", "<p>second para</p>"]),
    alertBlock(["<p>changed entirely</p>", "<p>second para</p>"]),
    alertBlock(["<p>changed entirely</p>"]),
  ]);
});

test("an alert whose KIND changes rebuilds (title and wrapper attrs both move)", () => {
  parity("alert-kind", [
    alertBlock(["<p>body</p>"], "note"),
    alertBlock(["<p>body</p>", "<p>two</p>"], "note"),
    alertBlock(["<p>body</p>", "<p>two</p>"], "warning"),
    alertBlock(["<p>body</p>", "<p>two</p>", "<p>three</p>"], "warning"),
  ]);
});

test("the keyed syncs honour a sanitize hook the same way a rebuild does", () => {
  const opts: MountOptions = { sanitize: (h) => h.replace(/secret/g, "***") };
  parity(
    "sanitize",
    [
      listBlock(items("a secret", "b")),
      listBlock(items("a secret", "b secret too")),
      listBlock(items("a secret", "b secret too", "c")),
    ],
    opts,
  );
});
