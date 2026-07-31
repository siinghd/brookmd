import { test, expect, beforeAll, afterEach } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { createElement, act } from "react";
import { BrookClient, BrookPool } from "../src/client";
import { BrookMarkdown } from "../src/react";
import { mountBrookMarkdown } from "../src/dom";
import { highlight } from "../src/hi";
import { __setSliceMs } from "../src/hi-defer";
import type { Block, FromWorker, ToWorker, WorkerLike } from "../src/types";

/**
 * Incremental highlighting of an OPEN fence, end to end in both renderers.
 *
 * A streaming code block no longer waits for its closing fence to light up: it
 * shows token spans as it grows (hi-inc.ts), and the markup it settles to on
 * close is byte-identical to the one-shot `highlight()` it always produced. The
 * unit-level proof of that lives in hi-inc.test.ts; what these tests pin is the
 * RENDERER contract — that the markup actually reaches the DOM while the block
 * is open, that closing it does not change a byte, and that
 * `streamingHighlight={false}` / `{ streamingHighlight: false }` restores the
 * plain-until-close behaviour exactly.
 *
 * ## The tail mode
 *
 * By DEFAULT (`"wavefront"`) the speculative tail is painted as a single TEXT
 * NODE: colour follows one checkpoint — in practice one source line — behind the
 * stream head, and a patch costs the DOM a character-data write instead of a
 * freshly parsed span subtree. `"eager"` is the old per-patch-coloured tail.
 *
 * The two are the same DOCUMENT and differ only in paint, so the contract pinned
 * below is: the same TEXT at every sync, the same markup once settled, and
 * strictly fewer spans on screen while open.
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
  return { client: new BrookClient({ pool }), worker: () => created[0] };
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

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * A CodeBlock exactly as the core emits it — including the SPECULATIVE closing
 * `</code></pre>` an open fence carries, which is what lets the renderer decode
 * a growing block's source at all.
 */
function codeBlock(id: number, lang: string, source: string, open: boolean): Block {
  const html = `<pre><code class="language-${lang}" data-lang="${lang}">${esc(source)}</code></pre>`;
  return {
    id,
    kind: { type: "CodeBlock", data: { lang, code: source } },
    start: 0,
    end: html.length,
    html,
    open,
    speculative: open,
  };
}

/** `highlight()`'s markup as the DOM serializes it back out of `innerHTML`. */
function asDom(markup: string): string {
  const ref = win.document.createElement("code");
  ref.innerHTML = markup;
  return ref.innerHTML;
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

// A fence with several committed lines behind the streaming one, so there is a
// real frozen prefix by the time it is halfway in.
const SOURCE = `export function tally(rows: Row[]): Map<string, number> {
  const out = new Map<string, number>();
  // sum by key <&>
  for (const r of rows) {
    out.set(r.k, (out.get(r.k) ?? 0) + r.n);
  }
  return out;
}
`;

// ---------------------------------------------------------------------------
// React renderer
// ---------------------------------------------------------------------------

test("React: an open fence highlights as it streams and settles to the close-time markup", async () => {
  const { client, worker } = makeClient();
  client.append("");
  const { host } = await mount(createElement(BrookMarkdown, { client }));

  // Stream it in. `act` flushes the effect that advances the incremental state.
  for (let i = 20; i < SOURCE.length; i += 20) {
    await act(async () => {
      worker().fire(patch([], [codeBlock(1, "ts", SOURCE.slice(0, i), true)]));
    });
  }

  // Mid-stream, while the block is still OPEN: real token spans in a real
  // <pre><code>, and the streaming pill still up.
  const body = host.querySelector(".brook-code-body")!;
  expect(host.querySelector(".brook-code-streaming-pill")).not.toBeNull();
  expect(host.querySelector(".brook-code-copy")).toBeNull();
  const openCode = host.querySelector(".brook-code-body > pre > code");
  expect(openCode).not.toBeNull();
  expect(openCode!.querySelector(".t-kw")).not.toBeNull();
  // It renders the source received so far — no more, and nothing rewritten.
  // (hi-inc.test.ts is what proves the frozen bytes are never revised; this is
  // the renderer-level statement that what reaches the DOM is that same text.)
  expect(SOURCE.startsWith(openCode!.textContent!)).toBe(true);
  expect(openCode!.textContent!.length).toBeGreaterThan(SOURCE.length / 2);

  // Close it: the markup must be byte-identical to a one-shot highlight.
  await act(async () => {
    worker().fire(patch([codeBlock(1, "ts", SOURCE, false)], []));
  });
  const closedCode = host.querySelector(".brook-code-body > pre > code")!;
  expect(closedCode.innerHTML).toBe(asDom(highlight(SOURCE, "ts")));
  expect(host.querySelector(".brook-code-streaming-pill")).toBeNull();
  expect(host.querySelector(".brook-code-copy")).not.toBeNull();
});

test("React: streamingHighlight={false} renders the open fence plain, and closes as before", async () => {
  const { client, worker } = makeClient();
  client.append("");
  const { host } = await mount(
    createElement(BrookMarkdown, { client, streamingHighlight: false }),
  );

  for (let i = 20; i < SOURCE.length; i += 20) {
    await act(async () => {
      worker().fire(patch([], [codeBlock(1, "ts", SOURCE.slice(0, i), true)]));
    });
  }

  // Open: the raw `<div>` body holding the block's own escaped HTML (the
  // pre-0.27 shape), with no token spans anywhere in it.
  const body = host.querySelector(".brook-code-body")!;
  expect(body.firstElementChild!.tagName).toBe("DIV");
  expect(body.firstElementChild!.getAttribute("role")).toBe("region");
  expect(body.querySelector(".t-kw")).toBeNull();
  expect(body.querySelector("span[class^='t-']")).toBeNull();
  expect(body.textContent).toContain("export function tally");

  // Close: highlighted exactly as it always was.
  await act(async () => {
    worker().fire(patch([codeBlock(1, "ts", SOURCE, false)], []));
  });
  expect(host.querySelector(".brook-code-body > pre > code")!.innerHTML).toBe(
    asDom(highlight(SOURCE, "ts")),
  );
});

test("React: an unterminated construct mid-stream still settles byte-identically", async () => {
  // A block comment that stays open for most of the stream pins the checkpoint;
  // the tail renders plain until it closes. The settled bytes must not care.
  const src = `const a = 1;\n/* a long open comment\nthat spans lines\nand more lines\n*/\nconst b = \`tpl\nliteral\`;\nconst c = "x";\n`;
  const { client, worker } = makeClient();
  client.append("");
  const { host } = await mount(createElement(BrookMarkdown, { client }));

  for (let i = 7; i < src.length; i += 7) {
    await act(async () => {
      worker().fire(patch([], [codeBlock(1, "js", src.slice(0, i), true)]));
    });
  }
  await act(async () => {
    worker().fire(patch([codeBlock(1, "js", src, false)], []));
  });
  expect(host.querySelector(".brook-code-body > pre > code")!.innerHTML).toBe(
    asDom(highlight(src, "js")),
  );
});

test("React: wavefront and eager show the same text at every commit, and settle identically", async () => {
  const { client, worker } = makeClient();
  client.append("");
  const wave = await mount(createElement(BrookMarkdown, { client }));
  const eager = await mount(
    createElement(BrookMarkdown, { client, streamingHighlight: "eager" }),
  );
  const body = (h: { querySelector(s: string): { textContent: string | null } | null }) =>
    h.querySelector(".brook-code-body")!.textContent;
  const spans = (h: { querySelectorAll(s: string): { length: number } }) =>
    h.querySelectorAll("span[class^='t-']").length;

  let colouredMore = 0;
  let steps = 0;
  for (let i = 8; i < SOURCE.length; i += 8) {
    await act(async () => {
      worker().fire(patch([], [codeBlock(1, "ts", SOURCE.slice(0, i), true)]));
    });
    steps++;
    // Same document, differently painted: the TEXT on screen is identical.
    expect(`${i}: ${body(eager.host as never)}`).toBe(`${i}: ${body(wave.host as never)}`);
    // …and the eager arm is the one paying for spans in the tail.
    const w = spans(wave.host as never);
    const e = spans(eager.host as never);
    expect(`${i}: ${e >= w}`).toBe(`${i}: true`);
    if (e > w) colouredMore++;
  }
  // Not "at least once": the tail is non-empty for essentially the whole stream.
  expect(colouredMore).toBeGreaterThan(steps / 2);

  await act(async () => {
    worker().fire(patch([codeBlock(1, "ts", SOURCE, false)], []));
  });
  const settled = asDom(highlight(SOURCE, "ts"));
  expect(wave.host.querySelector(".brook-code-body > pre > code")!.innerHTML).toBe(settled);
  expect(eager.host.querySelector(".brook-code-body > pre > code")!.innerHTML).toBe(settled);
});

test("React: the open fence's tail is one text node the mirror keeps across commits", async () => {
  const { client, worker } = makeClient();
  client.append("");
  const { host } = await mount(createElement(BrookMarkdown, { client }));
  const feed = async (i: number) => {
    await act(async () => {
      worker().fire(patch([], [codeBlock(1, "ts", SOURCE.slice(0, i), true)]));
    });
  };
  for (let i = 20; i <= 80; i += 20) await feed(i);

  const codeEl = host.querySelector(".brook-code-body > pre > code")!;
  const tail = codeEl.lastChild!;
  expect(tail.nodeType).toBe(3); // TEXT_NODE — no elements built for the tail
  const frozenHead = codeEl.firstChild!; // <span class="t-kw">export</span>
  expect((frozenHead as unknown as { nodeType: number }).nodeType).toBe(1);

  for (let i = 100; i < SOURCE.length; i += 20) {
    await feed(i);
    const now = host.querySelector(".brook-code-body > pre > code")!;
    expect(now).toBe(codeEl); // the element is never rebuilt…
    expect(now.lastChild).toBe(tail); // …and neither is the tail node
    expect(now.firstChild).toBe(frozenHead); // the frozen prefix is immutable
  }
});

test("React: a components.CodeBlock override bypasses the streaming path entirely", async () => {
  const { client, worker } = makeClient();
  client.append("");
  let sawOpen = false;
  const components = {
    CodeBlock: (p: { open: boolean; text?: string }) => {
      if (p.open) sawOpen = true;
      return createElement("div", { className: "mine" }, p.text ?? "");
    },
  };
  const { host } = await mount(createElement(BrookMarkdown, { client, components }));
  await act(async () => {
    worker().fire(patch([], [codeBlock(1, "ts", SOURCE.slice(0, 60), true)]));
  });
  expect(sawOpen).toBe(true);
  expect(host.querySelector(".mine")).not.toBeNull();
  expect(host.querySelector(".brook-code-body")).toBeNull();
  expect(host.querySelector(".t-kw")).toBeNull();
});

// ---------------------------------------------------------------------------
// DOM renderer
// ---------------------------------------------------------------------------

function driveDom(source: string, lang: string, options: Record<string, unknown> = {}) {
  const { client, worker } = makeClient();
  client.append("");
  const container = win.document.createElement("div");
  const handle = mountBrookMarkdown(client, container as unknown as HTMLElement, {
    batch: false,
    ...options,
  });
  const step = (i: number) =>
    worker().fire(patch([], [codeBlock(1, lang, source.slice(0, i), true)]));
  const close = () => worker().fire(patch([codeBlock(1, lang, source, false)], []));
  return { container, handle, step, close };
}

/** The same, with several renderers on ONE client so every arm sees every patch. */
function driveDomModes(source: string, lang: string, modes: Array<Record<string, unknown>>) {
  const { client, worker } = makeClient();
  client.append("");
  const arms = modes.map((options) => {
    const container = win.document.createElement("div");
    const handle = mountBrookMarkdown(client, container as unknown as HTMLElement, {
      batch: false,
      ...options,
    });
    return { container, handle };
  });
  return {
    arms,
    step: (i: number) => worker().fire(patch([], [codeBlock(1, lang, source.slice(0, i), true)])),
    close: () => worker().fire(patch([codeBlock(1, lang, source, false)], [])),
    destroy: () => arms.forEach((a) => a.handle.destroy()),
  };
}

test("DOM: an open fence highlights as it streams and settles to the close-time markup", () => {
  const { container, handle, step, close } = driveDom(SOURCE, "ts");
  for (let i = 20; i < SOURCE.length; i += 20) step(i);

  const node = container.querySelector(".brook-md")!.children[0];
  expect(node.querySelector(".brook-code-streaming-pill")).not.toBeNull();
  expect(node.querySelector(".brook-code-copy")).toBeNull();
  const openCode = node.querySelector(".brook-code-body > pre > code")!;
  expect(openCode).not.toBeNull();
  expect(openCode.querySelector(".t-kw")).not.toBeNull();

  close();
  const closed = container.querySelector(".brook-md")!.children[0];
  expect(closed.querySelector(".brook-code-body > pre > code")!.innerHTML).toBe(
    asDom(highlight(SOURCE, "ts")),
  );
  expect(closed.querySelector(".brook-code-copy")).not.toBeNull();
  handle.destroy();
});

test("DOM: streamingHighlight:false renders the open fence plain, and closes as before", () => {
  const { container, handle, step, close } = driveDom(SOURCE, "ts", {
    streamingHighlight: false,
  });
  for (let i = 20; i < SOURCE.length; i += 20) step(i);

  const node = container.querySelector(".brook-md")!.children[0];
  expect(node.querySelector(".brook-code-body > div")).not.toBeNull();
  expect(node.querySelector(".brook-code-body > pre")).toBeNull();
  expect(node.querySelector(".t-kw")).toBeNull();

  close();
  expect(
    container.querySelector(".brook-md")!.children[0].querySelector(".brook-code-body > pre code")!
      .innerHTML,
  ).toBe(asDom(highlight(SOURCE, "ts")));
  handle.destroy();
});

test("DOM: every tail mode shows the same text at every sync, and settles identically", () => {
  // off / wavefront / eager — three different sets of nodes under the fence, one
  // document. Every single prefix length, so the tail is caught mid-token,
  // mid-string and mid-line.
  const { arms, step, close, destroy } = driveDomModes(SOURCE, "ts", [
    {},
    { streamingHighlight: "eager" },
    { streamingHighlight: false },
  ]);
  const text = (c: { querySelector(s: string): { textContent: string | null } | null }) =>
    c.querySelector(".brook-code-body")!.textContent;
  const spans = (c: { querySelectorAll(s: string): { length: number } }) =>
    c.querySelectorAll("span[class^='t-']").length;

  let colouredMore = 0;
  for (let i = 1; i <= SOURCE.length; i++) {
    step(i);
    const [wave, eager, off] = arms.map((a) => text(a.container as never));
    expect(`${i}: ${eager}`).toBe(`${i}: ${wave}`);
    expect(`${i}: ${off}`).toBe(`${i}: ${wave}`);
    // Colour is the only difference, and it only ever runs AHEAD in the eager arm.
    const w = spans(arms[0].container as never);
    const e = spans(arms[1].container as never);
    expect(`${i}: ${e >= w}`).toBe(`${i}: true`);
    if (e > w) colouredMore++;
    expect(`${i}: ${spans(arms[2].container as never)}`).toBe(`${i}: 0`);
  }
  expect(colouredMore).toBeGreaterThan(SOURCE.length / 2);

  close();
  const settled = arms[0].container.innerHTML;
  expect(arms[1].container.innerHTML).toBe(settled);
  expect(arms[2].container.innerHTML).toBe(settled);
  expect(
    arms[0].container.querySelector(".brook-code-body > pre > code")!.innerHTML,
  ).toBe(asDom(highlight(SOURCE, "ts")));
  destroy();
});

test("DOM: the wavefront tail is one uncoloured text node, kept across patches", () => {
  const { container, handle, step } = driveDom(SOURCE, "ts");
  for (let i = 20; i <= 80; i += 20) step(i);

  const codeEl = container.querySelector(".brook-code-body > pre > code")!;
  const tail = codeEl.lastChild!;
  expect(tail.nodeType).toBe(3); // TEXT_NODE
  const frozenHead = codeEl.firstChild!;
  expect(frozenHead.nodeType).toBe(1); // <span class="t-kw">export</span>

  for (let i = 100; i < SOURCE.length; i += 7) {
    step(i);
    const now = container.querySelector(".brook-code-body > pre > code")!;
    expect(`${i}: same code element`).toBe(now === codeEl ? `${i}: same code element` : `${i}: rebuilt`);
    expect(`${i}: same tail node`).toBe(now.lastChild === tail ? `${i}: same tail node` : `${i}: replaced`);
    expect(`${i}: frozen head untouched`).toBe(
      now.firstChild === frozenHead ? `${i}: frozen head untouched` : `${i}: rewritten`,
    );
    // The tail carries the un-frozen source verbatim…
    const data = tail.nodeValue ?? "";
    expect(`${i}: ${SOURCE.slice(0, i).endsWith(data)}`).toBe(`${i}: true`);
    expect(data.length).toBeGreaterThan(0);
    // …and contributes no markup at all: everything after the frozen prefix
    // serializes as escaped text, which is what "no elements per patch" means.
    expect(`${i}: ${codeEl.innerHTML.endsWith(esc(data))}`).toBe(`${i}: true`);
  }
  // The frozen prefix is still fully coloured.
  expect(codeEl.querySelector(".t-kw")).not.toBeNull();
  handle.destroy();
});

test("DOM: the close-time run resumes from the frozen prefix (deferred path, same bytes)", async () => {
  // Force the sliced driver so the close-time run is unambiguously the seeded
  // one, then let it settle and compare against the one-shot markup.
  __setSliceMs(0);
  const big = SOURCE.repeat(40); // ~9 KB: many slices at a 0 ms budget
  const { container, handle, step, close } = driveDom(big, "ts");
  for (let i = 256; i < big.length; i += 256) step(i);
  close();

  const codeEl = () =>
    container.querySelector(".brook-md")!.children[0].querySelector(".brook-code-body > pre > code");
  for (let i = 0; i < 500 && codeEl() === null; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
  expect(codeEl()).not.toBeNull();
  expect(codeEl()!.innerHTML).toBe(asDom(highlight(big, "ts")));
  handle.destroy();
});

test("DOM: a language with no table falls back to the plain open body", () => {
  const { container, handle, step } = driveDom(SOURCE, "cobol");
  for (let i = 20; i < SOURCE.length; i += 20) step(i);
  const node = container.querySelector(".brook-md")!.children[0];
  expect(node.querySelector(".brook-code-body > div")).not.toBeNull();
  expect(node.querySelector(".brook-code-body > pre")).toBeNull();
  handle.destroy();
});

test("DOM: a block dropped mid-stream releases its incremental state", () => {
  const { container, handle, step } = driveDom(SOURCE, "ts");
  for (let i = 20; i < SOURCE.length; i += 20) step(i);
  expect(container.querySelector(".brook-code-body > pre > code")).not.toBeNull();
  // reset() empties the snapshot: the block (and its state) must go with it.
  handle.destroy();
  expect(container.querySelector(".brook-md")).toBeNull();
});
