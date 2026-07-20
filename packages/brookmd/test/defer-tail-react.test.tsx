import { test, expect, beforeAll } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { createElement, act } from "react";
import type { Block, FromWorker, ToWorker, WorkerLike } from "../src/types";
import { BrookClient, BrookPool } from "../src/client";
import { BrookMarkdown } from "../src/react";

// Synchronous fake worker (same shape as rerender-react.test.tsx).
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

let win: GlobalWindow;
beforeAll(() => {
  win = new GlobalWindow();
  const g = globalThis as Record<string, unknown>;
  g.document = win.document;
  g.window = win;
  g.navigator = win.navigator;
  g.HTMLElement = win.HTMLElement;
  g.Node = win.Node;
  g.Worker = class extends FakeWorker {} as unknown;
  (g as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

async function mount(node: ReturnType<typeof createElement>) {
  const { createRoot } = await import("react-dom/client");
  const host = win.document.createElement("div");
  const root = createRoot(host as unknown as Element);
  await act(async () => {
    root.render(node);
  });
  return { host, root };
}

function para(id: number, html: string, open: boolean): Block {
  return { id, kind: { type: "Paragraph" }, start: 0, end: 0, html, open, speculative: false };
}

const PATCH_META = { appendedBytes: 0, parseMicros: 0, retainedBytes: 0, wasmMemoryBytes: 0 } as const;

function newClient() {
  const w = new FakeWorker();
  const pool = new BrookPool(() => w, 1);
  const client = new BrookClient({ pool });
  client.append("");
  const sid = (w.sent[0] as { streamId: number }).streamId;
  return { w, client, sid };
}

// deferTail OFF (default): output is identical to the un-prop'd render and the
// root carries no `brook-deferred` class — the default path is unchanged.
test("deferTail off (default): output unchanged, no brook-deferred class", async () => {
  const { w, client, sid } = newClient();
  const { host } = await mount(createElement(BrookMarkdown, { client }));

  await act(async () => {
    w.fire({
      type: "patch",
      streamId: sid,
      patch: JSON.stringify({ newly_committed: [para(1, "<p>one</p>", false)], active: [para(2, "<p>tw</p>", true)] }),
      ...PATCH_META,
    });
  });

  const root = host.firstElementChild!;
  expect(root.className).toBe("brook-md");
  expect(root.className).not.toContain("brook-deferred");
  expect(host.innerHTML).toContain("one");
  expect(host.innerHTML).toContain("tw");
});

// deferTail ON: renders without error and, on a single applied patch, is a
// no-op — same content, and once settled no `brook-deferred` class lingers.
test("deferTail on: renders without error, no-op on a single patch", async () => {
  const { w, client, sid } = newClient();
  const { host } = await mount(createElement(BrookMarkdown, { client, deferTail: true }));

  await act(async () => {
    w.fire({
      type: "patch",
      streamId: sid,
      patch: JSON.stringify({ newly_committed: [para(1, "<p>one</p>", false)], active: [para(2, "<p>two</p>", true)] }),
      ...PATCH_META,
    });
  });

  const root = host.firstElementChild!;
  // Always carries the base class.
  expect(root.className).toContain("brook-md");
  // Content is rendered — deferTail never changes output, only commit timing.
  expect(host.innerHTML).toContain("one");
  expect(host.innerHTML).toContain("two");
  // After the act() flush the deferred value has caught up to the latest blocks,
  // so the transient `brook-deferred` marker is gone.
  expect(root.className).not.toContain("brook-deferred");
});

// deferTail ON preserves a caller className alongside brook-md.
test("deferTail on: caller className preserved", async () => {
  const { w, client, sid } = newClient();
  const { host } = await mount(createElement(BrookMarkdown, { client, deferTail: true, className: "mine" }));

  await act(async () => {
    w.fire({
      type: "patch",
      streamId: sid,
      patch: JSON.stringify({ newly_committed: [para(1, "<p>x</p>", false)], active: [] }),
      ...PATCH_META,
    });
  });

  const root = host.firstElementChild!;
  expect(root.className).toContain("brook-md");
  expect(root.className).toContain("mine");
});
