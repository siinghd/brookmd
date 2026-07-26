import { test, expect, beforeAll, afterEach } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { createElement, act, type ReactNode } from "react";
import type { Block, BlockComponentProps, FromWorker, ToWorker, WorkerLike } from "../src/types";
import { BrookClient, BrookPool } from "../src/client";
import { BrookMarkdown } from "../src/react";
import { htmlToReact } from "../src/html-to-react";
import { __resetWarnOnce } from "../src/warn";

// REGRESSION: the `components` map is consulted by TWO dispatchers with
// different prop contracts — `blockKindProps` (which supplies `block`) for a
// block-kind / block-level component tag, and the HTML walker (attributes only,
// NO `block`) for the same name appearing as an element inside a block's HTML.
// An override written for the block contract therefore threw
// `can't access property "kind", block is undefined` the moment the same tag
// showed up nested or inline, and React's default response to an uncaught render
// error — unmounting the whole tree — turned that into a blank document.
//
// These tests pin the three defenses:
//   1. a raw element whose name collides with a BLOCK-KIND key is never
//      dispatched to that override (it renders as a plain element);
//   2. a throwing override costs exactly one block, not the document;
//   3. the failed block is retried when its HTML moves on.

class FakeWorker implements WorkerLike {
  sent: ToWorker[] = [];
  private listener: ((ev: { data: FromWorker }) => void) | null = null;
  postMessage(msg: ToWorker) {
    this.sent.push(msg);
  }
  addEventListener(t: string, l: (ev: { data: FromWorker }) => void) {
    if (t !== "error" && t !== "messageerror") this.listener = l;
  }
  terminate() {}
  fire(msg: FromWorker) {
    this.listener?.({ data: msg });
  }
}

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

afterEach(() => __resetWarnOnce());

function makeClient() {
  const created: FakeWorker[] = [];
  const pool = new BrookPool(() => {
    const w = new FakeWorker();
    created.push(w);
    return w;
  }, 1);
  const client = new BrookClient({ pool });
  client.append(""); // force worker acquisition
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
  } as unknown as FromWorker;
}

function block(id: number, kind: string, html: string, data?: unknown): Block {
  return {
    id,
    kind: { type: kind, data },
    start: 0,
    end: 0,
    html,
    open: false,
    speculative: false,
  } as unknown as Block;
}

async function mount(node: ReactNode) {
  const { createRoot } = await import("react-dom/client");
  const host = win.document.createElement("div");
  const root = createRoot(host as unknown as Element);
  await act(async () => {
    root.render(node);
  });
  return { host: host as unknown as HTMLElement, root };
}

// ---------------------------------------------------------------------------
// 1. Block-kind keys are never reachable from the element-name path.
// ---------------------------------------------------------------------------

// Collect every element `type` in a rendered tree, so we can assert WHICH
// component (or plain tag string) a name resolved to. `createElement` does not
// invoke the component, so counting calls would pass vacuously.
function elementTypes(node: unknown, out: unknown[] = []): unknown[] {
  if (node === null || node === undefined || typeof node === "string" || typeof node === "boolean") return out;
  if (Array.isArray(node)) {
    for (const n of node) elementTypes(n, out);
    return out;
  }
  const el = node as { type?: unknown; props?: { children?: unknown } };
  if (el.type !== undefined) out.push(el.type);
  if (el.props && el.props.children !== undefined) elementTypes(el.props.children, out);
  return out;
}

test("a raw element colliding with a block-kind key is NOT dispatched to that override", () => {
  const Alert = (_p: BlockComponentProps) => createElement("div", null, "override");
  // Raw-HTML passthrough (unsafeHtml / htmlAllowlist) preserves a tag's original
  // case, so model prose really can contain a literal <Alert>. Before the fix
  // this reached components.Alert with `{key, children}` and threw on
  // props.block.kind.
  const types = elementTypes(htmlToReact("<p>Use the <Alert>warning</Alert> component</p>", { Alert }));
  expect(types).toContain("Alert"); // rendered as a plain element
  expect(types).not.toContain(Alert); // never the block-kind override
});

test("a NON block-kind component tag still dispatches on the element path", () => {
  const Thinking = (_p: { children?: ReactNode }) => createElement("span", null, "thinking");
  const types = elementTypes(htmlToReact("<p>see <Thinking>x</Thinking></p>", { Thinking }));
  expect(types).toContain(Thinking); // inline component tags must keep working
  expect(types).not.toContain("Thinking");
});

// ---------------------------------------------------------------------------
// 2. A throwing override costs one block, not the document.
// ---------------------------------------------------------------------------

test("a throwing override skips its block and leaves the rest of the document rendered", async () => {
  const { client, worker } = makeClient();
  const seen: { blockId: number; kind: string }[] = [];

  // The exact shape that crashed in production: written for the block contract,
  // invoked through the element path where there is no `block`.
  const Thinking = ({ block: b }: { block?: Block }) =>
    createElement("div", null, (b as Block).kind.type);

  const { host } = await mount(
    createElement(BrookMarkdown, {
      client,
      components: { Thinking },
      onBlockError: (_e: Error, info: { blockId: number; kind: string }) => {
        seen.push({ blockId: info.blockId, kind: info.kind });
      },
    }),
  );

  await act(async () => {
    worker().fire(
      patch(
        [
          block(1, "Paragraph", "<p>before</p>"),
          // Thinking nested inside a list item — the element path, no `block`.
          block(2, "List", "<ul>\n<li>\n<Thinking>\n<p>r</p>\n</Thinking></li>\n</ul>"),
          block(3, "Paragraph", "<p>after</p>"),
        ],
        [],
      ),
    );
  });

  expect(seen.length).toBe(1);
  expect(seen[0].blockId).toBe(2);
  expect(seen[0].kind).toBe("List");
  // The document survived: neighbours still rendered.
  expect(host.innerHTML).toContain("before");
  expect(host.innerHTML).toContain("after");
  // and the failing block rendered nothing rather than taking the tree down.
  expect(host.innerHTML).not.toContain("<li>");
});

test("onBlockError carries the override keys and an html excerpt", async () => {
  const { client, worker } = makeClient();
  let info: { componentKeys: string[]; html: string } | null = null;
  const Thinking = ({ block: b }: { block?: Block }) =>
    createElement("div", null, (b as Block).kind.type);

  await mount(
    createElement(BrookMarkdown, {
      client,
      components: { Thinking },
      onBlockError: (_e: Error, i: { componentKeys: string[]; html: string }) => {
        info = i;
      },
    }),
  );
  await act(async () => {
    worker().fire(patch([block(7, "List", "<ul><li><Thinking>x</Thinking></li></ul>")], []));
  });

  expect(info).not.toBeNull();
  expect(info!.componentKeys).toContain("Thinking");
  expect(info!.html).toContain("Thinking");
});

// ---------------------------------------------------------------------------
// 3. The boundary retries once the block's HTML moves on.
// ---------------------------------------------------------------------------

test("a block that failed while streaming renders again once its html changes", async () => {
  const { client, worker } = makeClient();
  const errors: number[] = [];
  // Throws only while the transient raw tag is present; the settled html is
  // escaped, so the retry must succeed.
  const Thinking = ({ block: b }: { block?: Block }) =>
    createElement("div", null, (b as Block).kind.type);

  const { host } = await mount(
    createElement(BrookMarkdown, {
      client,
      components: { Thinking },
      onBlockError: (_e: Error, i: { blockId: number }) => errors.push(i.blockId),
    }),
  );

  // tick 1: the leaked raw tag reaches the element path → throws → skipped
  await act(async () => {
    worker().fire(patch([], [block(1, "Blockquote", "<blockquote>\n<Thinking></Thinking>\n</blockquote>")]));
  });
  expect(errors).toEqual([1]);
  expect(host.innerHTML).not.toContain("blockquote");

  // tick 2: settled html (escaped) — the same block must come back
  await act(async () => {
    worker().fire(patch([], [block(1, "Blockquote", "<blockquote>\n<p>&lt;Thinking&gt;x&lt;/Thinking&gt;</p>\n</blockquote>")]));
  });
  expect(errors).toEqual([1]); // no second failure
  expect(host.innerHTML).toContain("blockquote");
  expect(host.innerHTML).toContain("&lt;Thinking&gt;");
});
