import { test, expect, beforeAll } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { htmlToReact } from "../src/html-to-react";
import { BrookClient, BrookPool } from "../src/client";
import { mountBrookMarkdown } from "../src/dom";
import { morph } from "../src/morph";
import type { Block, Components, FromWorker, ToWorker, WorkerLike } from "../src/types";

// The core marks a speculative streaming anchor (label rendered, URL still
// arriving) with `data-brook-pending=""` and NO href; when the `)` lands the
// href appears and the marker is dropped. These are hand-written fixtures of
// exactly that wire shape so the pass-through can be verified renderer-side
// without running the core.
const PENDING =
  '<p>Check the <a data-brook-pending="" target="_blank" rel="noopener noreferrer nofollow">Earnings Call</a></p>';
const FINAL =
  '<p>Check the <a href="https://example.com/q3-earnings" target="_blank" rel="noopener noreferrer nofollow">Earnings Call</a> today.</p>';

// Mirror dom.test.ts: register a DOM in this file only, no requestAnimationFrame
// (mounts pass `batch: false` explicitly).
beforeAll(() => {
  const win = new GlobalWindow();
  const g = globalThis as Record<string, unknown>;
  g.document = win.document;
  g.HTMLElement = win.HTMLElement;
  g.Node = win.Node;
  g.navigator = win.navigator;
});

const render = (node: unknown) => renderToStaticMarkup(node as ReactElement);

// Depth-first search for the first element of `tag` in a converted React tree.
function findTag(node: ReactNode, tag: string): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findTag(child, tag);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (node.type === tag) return node;
  const children = (node.props as { children?: ReactNode }).children;
  return children === undefined ? null : findTag(children, tag);
}

// ---------------------------------------------------------------------------
// React walk path (htmlToReact — the attr-allowlist / prop-hardening gate)
// ---------------------------------------------------------------------------

test("data-brook-pending survives the React attr allowlist into props and markup", () => {
  const tree = htmlToReact(PENDING, {});
  const a = findTag(tree, "a");
  expect(a).not.toBeNull();
  const props = a!.props as Record<string, unknown>;
  expect(props["data-brook-pending"]).toBe("");
  expect("href" in props).toBe(false); // inert: no href while pending

  const out = render(tree);
  expect(out).toContain('data-brook-pending=""');
  expect(out).not.toContain("href");
  expect(out).toContain("Earnings Call");
});

test("a valueless data-brook-pending (boolean attr form) also reaches the markup", () => {
  const tree = htmlToReact("<p><a data-brook-pending>label</a></p>", {});
  const a = findTag(tree, "a");
  expect((a!.props as Record<string, unknown>)["data-brook-pending"]).toBe(true);
  // React stringifies a boolean data-* value; the CSS presence selector
  // `a[data-brook-pending]` matches either serialization.
  expect(render(tree)).toContain("data-brook-pending");
});

test("a re-render from the completed html drops the marker and carries the href", () => {
  const out = render(htmlToReact(FINAL, {}));
  expect(out).toContain('href="https://example.com/q3-earnings"');
  expect(out).not.toContain("data-brook-pending");
});

test("a tag-level `a` override receives data-brook-pending so it can style pending links", () => {
  let got: unknown = "unset";
  const components = {
    a: (p: Record<string, unknown>) => {
      got = p["data-brook-pending"];
      return createElement("span", null, p.children as ReactNode);
    },
  } as unknown as Components;
  render(htmlToReact(PENDING, components));
  expect(got).toBe("");
});

test("urlTransform never sees a pending anchor (no href attr exists to rewrite)", () => {
  const seen: string[] = [];
  const out = render(
    htmlToReact(PENDING, {}, undefined, {
      urlTransform: (url) => {
        seen.push(url);
        return url + "?utm=x";
      },
    }),
  );
  expect(seen).toEqual([]); // fires only once the real href lands
  expect(out).toContain('data-brook-pending=""');
  expect(out).not.toContain("href");
});

// ---------------------------------------------------------------------------
// DOM renderer (dom.ts — innerHTML fast path, rebuild, and morph attr diffing)
// ---------------------------------------------------------------------------

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

const para = (id: number, html: string, open = false): Block => ({
  id, kind: { type: "Paragraph" }, start: 0, end: html.length, html, open, speculative: false,
});

function drive(client: BrookClient, worker: () => FakeWorker, msg: FromWorker) {
  worker().fire(msg);
}

test("DOM renderer: the marker lands on the live anchor and a URL-complete patch clears it", () => {
  const { client, worker } = makeClient();
  client.append("");
  const container = document.createElement("div");
  const handle = mountBrookMarkdown(client, container, { batch: false });
  const root = container.querySelector(".brook-md")!;

  drive(client, worker, patch([], [para(1, PENDING, true)]));
  let a = root.querySelector("a")!;
  expect(a.hasAttribute("data-brook-pending")).toBe(true);
  expect(a.hasAttribute("href")).toBe(false);

  // The completed html changes mid-string (not a prefix extension), so the
  // append fast path can't fire — the block fully rebuilds and no stale
  // attribute can survive.
  drive(client, worker, patch([], [para(1, FINAL, true)]));
  a = root.querySelector("a")!;
  expect(a.hasAttribute("data-brook-pending")).toBe(false);
  expect(a.getAttribute("href")).toBe("https://example.com/q3-earnings");

  handle.destroy();
});

test("morphOpenBlocks: the reused anchor node sheds the stale marker and gains the href", () => {
  const { client, worker } = makeClient();
  client.append("");
  const container = document.createElement("div");
  const handle = mountBrookMarkdown(client, container, { batch: false, morphOpenBlocks: true });
  const root = container.querySelector(".brook-md")!;

  drive(client, worker, patch([], [para(1, PENDING, true)]));
  const blockNode = root.children[0];
  const a0 = root.querySelector("a")!;
  expect(a0.hasAttribute("data-brook-pending")).toBe(true);

  drive(client, worker, patch([], [para(1, FINAL, true)]));
  // Morphed in place: same block node, same anchor element identity.
  expect(root.children[0]).toBe(blockNode);
  const a1 = root.querySelector("a")!;
  expect(a1).toBe(a0);
  // The attr diff must CLEAR the stale marker on the reused node.
  expect(a1.hasAttribute("data-brook-pending")).toBe(false);
  expect(a1.getAttribute("href")).toBe("https://example.com/q3-earnings");
  expect(a1.textContent).toBe("Earnings Call");

  handle.destroy();
});

test("morph clears attributes the new tree no longer carries (unit)", () => {
  const host = document.createElement("div");
  host.innerHTML = PENDING;
  morph(host, FINAL);
  // Attribute ORDER after an in-place sync is a serialization detail; assert
  // the semantic outcome: marker gone, href present, text/tail intact.
  const a = host.querySelector("a")!;
  expect(a.hasAttribute("data-brook-pending")).toBe(false);
  expect(a.getAttribute("href")).toBe("https://example.com/q3-earnings");
  expect(host.textContent).toBe("Check the Earnings Call today.");
});

test("DOM decorators walk keeps the marker and skips text inside the pending anchor", () => {
  const { client, worker } = makeClient();
  client.append("");
  const container = document.createElement("div");
  const handle = mountBrookMarkdown(client, container, {
    batch: false,
    decorators: [
      {
        match: /Earnings/g,
        replace: (t: string) => {
          const m = document.createElement("mark");
          m.textContent = t;
          return m;
        },
      },
    ],
  });
  const root = container.querySelector(".brook-md")!;

  drive(client, worker, patch([], [para(1, PENDING, true)]));
  const a = root.querySelector("a")!;
  expect(a.hasAttribute("data-brook-pending")).toBe(true);
  // Default skipInside includes `a`: the pending label is never decorated.
  expect(a.querySelector("mark")).toBeNull();

  handle.destroy();
});
