import { test, expect, beforeAll, afterEach } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { createElement, act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BrookClient, BrookPool } from "../src/client";
import { BrookMarkdown } from "../src/react";
import { mountBrookMarkdown } from "../src/dom";
import { highlight } from "../src/hi";
import { __setSliceMs } from "../src/hi-defer";
import type { Block, FromWorker, ToWorker, WorkerLike } from "../src/types";

/**
 * Non-blocking close-time highlighting, end to end in both renderers.
 *
 * A closed fence no longer tokenizes in one main-thread task: the first slice
 * runs inline (so an ordinary block is highlighted in the same paint as
 * before — the existing dom.test.ts / html-to-react.test.ts assertions still
 * hold unchanged), and a block too big for that budget shows the plain escaped
 * body first and swaps the markup in a few tasks later.
 *
 * Every test here forces the sliced path with `__setSliceMs(0)` rather than
 * betting on the machine being slow enough, and asserts the SETTLED markup is
 * byte-identical to the synchronous `highlight()` it replaces.
 */

let win: GlobalWindow;
beforeAll(() => {
  win = new GlobalWindow();
  const g = globalThis as Record<string, unknown>;
  g.document = win.document;
  g.window = win;
  g.navigator = win.navigator;
  g.HTMLElement = win.HTMLElement;
  g.Node = win.Node;
  (g as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => __setSliceMs());

class FakeWorker implements WorkerLike {
  sent: ToWorker[] = [];
  private listener: ((ev: { data: FromWorker }) => void) | null = null;
  postMessage(msg: ToWorker) {
    this.sent.push(msg);
  }
  addEventListener(_t: "message", l: (ev: { data: FromWorker }) => void) {
    this.listener = l;
  }
  terminate() {}
  fire(msg: FromWorker) {
    this.listener?.({ data: msg });
  }
}

function makeClient() {
  const created: FakeWorker[] = [];
  const pool = new BrookPool(() => {
    const w = new FakeWorker();
    created.push(w);
    return w;
  }, 1);
  const client = new BrookClient({ pool });
  return { client, worker: () => created[0] };
}

function patch(committed: Block[], active: Block[], streamId = 1): FromWorker {
  return {
    type: "patch",
    streamId,
    patch: JSON.stringify({ newly_committed: committed, active }),
    appendedBytes: 0,
    parseMicros: 0,
    retainedBytes: 0,
    wasmMemoryBytes: 0,
  };
}

/** Escape a source string the way the core escapes a code block's body. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A closed CodeBlock as the core emits it. `code` is attached only when the
 *  caller wants the `blockData`-on shape. */
function codeBlock(id: number, lang: string, source: string, code?: string): Block {
  const html = `<pre><code class="language-${lang}" data-lang="${lang}">${esc(source)}</code></pre>`;
  return {
    id,
    kind: { type: "CodeBlock", data: code === undefined ? { lang } : { lang, code } },
    start: 0,
    end: html.length,
    html,
    open: false,
    speculative: false,
  };
}

// Big enough that the sliced path needs many tasks even at CHUNK granularity.
const BIG = `export function tally(rows: Row[]): Map<string, number> {\n  const out = new Map<string, number>();\n  for (const r of rows) out.set(r.k, (out.get(r.k) ?? 0) + r.n); // sum <&>\n  return out;\n}\n`.repeat(
  30,
);

const tick = () => new Promise((r) => setTimeout(r, 0));

/** `highlight()`'s markup as the DOM serializes it back out of `innerHTML`
 *  (a text node's `"` round-trips unescaped), so a live node can be compared
 *  against the synchronous output it must equal. */
function asDom(markup: string): string {
  const ref = win.document.createElement("code");
  ref.innerHTML = markup;
  return ref.innerHTML;
}

/** Let the sliced driver run to completion (bounded, so a stuck run fails
 *  loudly). `each` runs after every hop — the hook for asserting an invariant
 *  that must hold on EVERY intermediate paint, not just the settled one. */
async function settle(done: () => boolean, each?: () => void): Promise<void> {
  for (let i = 0; i < 500 && !done(); i++) {
    await tick();
    if (each) each();
  }
  expect(done()).toBe(true);
  if (each) each();
}

/** The React flavour: React only applies an update once the `act` scope EXITS,
 *  so the DOM is polled between scopes rather than inside one. */
async function settleReact(done: () => boolean, each?: () => void): Promise<void> {
  for (let i = 0; i < 100 && !done(); i++) {
    await act(async () => {
      await tick();
    });
    if (each) each();
  }
  expect(done()).toBe(true);
  if (each) each();
}

async function mount(node: ReturnType<typeof createElement>) {
  const { createRoot } = await import("react-dom/client");
  const host = win.document.createElement("div");
  const root = createRoot(host as unknown as Element);
  await act(async () => {
    root.render(node);
  });
  return { host, root };
}

// ---------------------------------------------------------------------------
// React renderer
// ---------------------------------------------------------------------------

test("React: a big closed block shows escaped text first, then swaps in the identical markup", async () => {
  __setSliceMs(0);
  const { client, worker } = makeClient();
  client.append("");
  const { host } = await mount(createElement(BrookMarkdown, { client }));

  // Sync `act`: flush React's commit WITHOUT letting the driver's tasks run, so
  // this is exactly the first paint the user sees.
  act(() => {
    worker().fire(patch([codeBlock(1, "ts", BIG)], []));
  });

  // First paint: the plain escaped body (the same `<div>` an open block gets),
  // no token spans, no half-highlighted markup.
  const body = host.querySelector(".brook-code-body")!;
  // The fallback is the block's own `<pre><code>` HTML inside a plain `<div>` —
  // so the tell is the body's DIRECT child, and the absence of token spans.
  expect(body.firstElementChild!.tagName).toBe("DIV");
  expect(body.querySelector(".t-kw")).toBeNull();
  expect(body.firstElementChild!.getAttribute("role")).toBe("region");
  expect(body.textContent).toContain("export function tally");

  // ...then the highlighted body swaps in, byte-identical to the synchronous
  // highlight it replaces.
  await settleReact(() => host.querySelector(".brook-code-body > pre > code") !== null);
  const codeEl = host.querySelector(".brook-code-body > pre > code")!;
  expect(codeEl.innerHTML).toBe(asDom(highlight(BIG, "ts")));
  expect(host.querySelector(".t-kw")).not.toBeNull();
  // The rest of the block is untouched: header, language, copy button.
  expect(host.querySelector(".brook-code-lang")!.textContent).toBe("ts");
  expect(host.querySelector(".brook-code-copy")).not.toBeNull();
});

test("React: a small block still highlights synchronously (no flash, one paint)", async () => {
  const { client, worker } = makeClient();
  client.append("");
  const { host } = await mount(createElement(BrookMarkdown, { client }));
  const source = "fn main() { let x = 1; }";

  // Sync `act` again: nothing but React's own commit has run at this point.
  act(() => {
    worker().fire(patch([codeBlock(1, "rust", source)], []));
  });

  // Highlighted in the very first committed render — no intermediate plain body.
  const codeEl = host.querySelector(".brook-code-body > pre > code")!;
  expect(codeEl).not.toBeNull();
  expect(codeEl.innerHTML).toBe(asDom(highlight(source, "rust")));
});

test("React: text replaced mid-flight never paints the superseded block's tokens", async () => {
  __setSliceMs(0);
  const { client, worker } = makeClient();
  client.append("");
  const { host } = await mount(createElement(BrookMarkdown, { client }));

  // The superseded text is deliberately MUCH longer than its replacement (8x
  // the slices), so the abandoned run would still be tokenizing long after the
  // new one has painted — precisely the window in which an unguarded swap
  // clobbers the visible block with the previous block's tokens.
  const first = BIG.repeat(8) + "const FIRST_ONLY = 1;\n"; // ~41 KB, under the size guard
  const second = BIG + "const SECOND_ONLY = 2;\n";
  const noStale = () =>
    expect(host.querySelector(".brook-code-body")!.textContent).not.toContain("FIRST_ONLY");

  // Block 1 closes and starts a sliced highlight...
  act(() => {
    worker().fire(patch([codeBlock(1, "ts", first)], []));
  });
  expect(host.querySelector(".brook-code-body > pre > code")).toBeNull(); // deferred
  // ...and is superseded before a single slice can run (a speculative revision
  // re-sends the same id with different html), so the first run is unambiguously
  // in flight when its block is replaced.
  act(() => {
    worker().fire(patch([codeBlock(1, "ts", second)], []));
  });

  // In flight: the plain body for the NEW text. Never the old text, and never
  // the old text's tokens.
  const body = host.querySelector(".brook-code-body")!;
  expect(body.textContent).toContain("SECOND_ONLY");
  noStale();

  // The new (shorter) run lands first...
  await settleReact(() => host.querySelector(".brook-code-body > pre > code") !== null, noStale);
  const codeEl = host.querySelector(".brook-code-body > pre > code")!;
  expect(codeEl.innerHTML).toBe(asDom(highlight(second, "ts")));

  // ...and draining far past where the abandoned run would have finished leaves
  // it untouched: no paint ever carries the superseded content.
  for (let i = 0; i < 60; i++) {
    await act(async () => {
      await tick();
    });
    noStale();
  }
  expect(host.querySelector(".brook-code-body > pre > code")!.innerHTML).toBe(
    asDom(highlight(second, "ts")),
  );
});

test("React: kind.data.code and the HTML decode produce the identical DOM", async () => {
  // Source with every entity the decoder handles, plus an already-escaped
  // sequence (`&amp;lt;`) that a naive decode order would mangle.
  const source = `const s = "a < b && c > d";\nconst t = 'x\\'y' + "&amp;lt;" + \`q"\`;\n`;

  const withData = makeClient();
  withData.client.append("");
  const a = await mount(createElement(BrookMarkdown, { client: withData.client }));
  await act(async () => {
    withData.worker().fire(patch([codeBlock(1, "js", source, source)], [])); // blockData ON
  });

  const withoutData = makeClient();
  withoutData.client.append("");
  const b = await mount(createElement(BrookMarkdown, { client: withoutData.client }));
  await act(async () => {
    withoutData.worker().fire(patch([codeBlock(1, "js", source)], [])); // blockData OFF
  });

  const one = a.host.querySelector(".brook-code-body > pre > code")!;
  const two = b.host.querySelector(".brook-code-body > pre > code")!;
  expect(one.innerHTML).toBe(asDom(highlight(source, "js")));
  expect(two.innerHTML).toBe(one.innerHTML); // decodeText(html) === kind.data.code
});

test("React: server rendering stays synchronous and byte-identical", async () => {
  __setSliceMs(0); // the client would defer this block; the server must not
  const { client, worker } = makeClient();
  client.append("");
  // Feed the store a closed code block, then render it with no browser globals.
  await act(async () => {
    worker().fire(patch([codeBlock(1, "ts", BIG)], []));
  });

  const g = globalThis as Record<string, unknown>;
  const savedWindow = g.window;
  const savedDoc = g.document;
  delete g.window; // what CodeBlock checks to take the synchronous path
  delete g.document;
  let out: string;
  try {
    out = renderToStaticMarkup(createElement(BrookMarkdown, { client }));
  } finally {
    g.window = savedWindow;
    g.document = savedDoc;
  }

  // Fully highlighted in the server's single pass — no plain-body fallback.
  expect(out).toContain(`<pre tabindex="0" role="region" aria-label="ts code"><code>`);
  expect(out).toContain(highlight(BIG, "ts"));
});

// ---------------------------------------------------------------------------
// DOM renderer
// ---------------------------------------------------------------------------

test("DOM: a big closed block swaps its highlighted body in later, identical markup", async () => {
  __setSliceMs(0);
  const { client, worker } = makeClient();
  client.append("");
  const container = win.document.createElement("div") as unknown as HTMLElement;
  const handle = mountBrookMarkdown(client, container, { batch: false });

  worker().fire(patch([codeBlock(1, "ts", BIG)], []));

  const node = container.querySelector(".brook-md")!.children[0];
  expect(node.querySelector(".brook-code-body > div")).not.toBeNull(); // plain body
  expect(node.querySelector(".t-kw")).toBeNull();

  await settle(() => node.querySelector(".brook-code-body > pre code") !== null);
  const codeEl = node.querySelector(".brook-code-body > pre code")!;
  expect(codeEl.innerHTML).toBe(asDom(highlight(BIG, "ts")));
  expect(node.querySelector(".brook-code-body > div")).toBeNull(); // fallback replaced
  const pre = node.querySelector(".brook-code-body > pre")!;
  expect(pre.getAttribute("aria-label")).toBe("ts code");
  expect(pre.getAttribute("role")).toBe("region");

  handle.destroy();
});

test("DOM: a block rebuilt mid-flight never receives the superseded markup", async () => {
  __setSliceMs(0);
  const { client, worker } = makeClient();
  client.append("");
  const container = win.document.createElement("div") as unknown as HTMLElement;
  const handle = mountBrookMarkdown(client, container, { batch: false });

  const first = BIG + "const FIRST_ONLY = 1;\n";
  const second = BIG + "const SECOND_ONLY = 2;\n";

  // The second patch lands before any slice of the first has run, so the first
  // run is in flight when its node is rebuilt.
  worker().fire(patch([codeBlock(1, "ts", first)], []));
  worker().fire(patch([codeBlock(1, "ts", second)], []));

  const root = container.querySelector(".brook-md")!;
  await settle(
    () => root.querySelector(".brook-code-body > pre code") !== null,
    () => expect(root.textContent).not.toContain("FIRST_ONLY"),
  );
  const codeEl = root.querySelector(".brook-code-body > pre code")!;
  expect(codeEl.innerHTML).toBe(asDom(highlight(second, "ts")));
  expect(codeEl.textContent).not.toContain("FIRST_ONLY");
  // Exactly one code block node — the stale run did not append a second body.
  expect(root.querySelectorAll(".brook-code-body").length).toBe(1);

  handle.destroy();
});

test("DOM: destroy() abandons an in-flight highlight without touching the DOM", async () => {
  __setSliceMs(0);
  const { client, worker } = makeClient();
  client.append("");
  const container = win.document.createElement("div") as unknown as HTMLElement;
  const handle = mountBrookMarkdown(client, container, { batch: false });

  worker().fire(patch([codeBlock(1, "ts", BIG)], []));
  const node = container.querySelector(".brook-md")!.children[0];
  handle.destroy();

  for (let i = 0; i < 20; i++) await tick();
  // The detached node keeps the plain body: the run was cancelled, not applied.
  expect(node.querySelector(".brook-code-body > pre")).toBeNull();
  expect(container.querySelector(".brook-md")).toBeNull();
});

test("DOM: kind.data.code and the HTML decode produce the identical node", async () => {
  const source = `let s = "a < b && c";\nlet t = '&amp;lt;';\n`;
  const withData = makeClient();
  withData.client.append("");
  const c1 = win.document.createElement("div") as unknown as HTMLElement;
  const h1 = mountBrookMarkdown(withData.client, c1, { batch: false });
  withData.worker().fire(patch([codeBlock(1, "js", source, source)], []));

  const withoutData = makeClient();
  withoutData.client.append("");
  const c2 = win.document.createElement("div") as unknown as HTMLElement;
  const h2 = mountBrookMarkdown(withoutData.client, c2, { batch: false });
  withoutData.worker().fire(patch([codeBlock(1, "js", source)], []));

  const one = c1.querySelector(".brook-code-body > pre code")!;
  const two = c2.querySelector(".brook-code-body > pre code")!;
  expect(one.innerHTML).toBe(asDom(highlight(source, "js")));
  expect(two.innerHTML).toBe(one.innerHTML);
  // The copy payload comes from the same source either way.
  expect(c1.querySelector(".brook-code-copy")).not.toBeNull();
  expect(c2.querySelector(".brook-code-copy")).not.toBeNull();

  h1.destroy();
  h2.destroy();
});
