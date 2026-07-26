import { test, expect, beforeAll } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { createElement, act, type ReactNode } from "react";
import type { Block, FromWorker, ToWorker, WorkerLike } from "../src/types";
import { BrookClient, BrookPool } from "../src/client";
import { BrookMarkdown, __getBoundaryRenders, __resetBoundaryRenders } from "../src/react";

// COMPLEXITY GATE (React side, mirroring the Rust `scaling` gate's philosophy:
// count WORK, don't time it).
//
// Per-block error containment is only affordable if the boundary lives INSIDE
// the per-block memo. Outside it, a parent render rebuilds every child element
// and the class re-renders for every block on every patch — O(n) per patch,
// O(n²) over a stream, which is exactly the cliff class this project spent
// 0.18–0.21 eliminating. This test pins the boundary to the memo: as the tail
// streams, boundary renders must track the number of blocks that ACTUALLY
// re-render (the tail), not the document size.

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

function makeClient() {
  const created: FakeWorker[] = [];
  const pool = new BrookPool(() => {
    const w = new FakeWorker();
    created.push(w);
    return w;
  }, 1);
  const client = new BrookClient({ pool });
  client.append("");
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

function blk(id: number, html: string, open = false): Block {
  return {
    id,
    kind: { type: "Paragraph", data: undefined },
    start: 0,
    end: 0,
    html,
    open,
    speculative: open,
  } as unknown as Block;
}

async function mount(node: ReactNode) {
  const { createRoot } = await import("react-dom/client");
  const host = win.document.createElement("div");
  const root = createRoot(host as unknown as Element);
  await act(async () => {
    root.render(node);
  });
  return host as unknown as HTMLElement;
}

/** Boundary renders caused by `ticks` tail patches over `committed` settled
 *  blocks. Linear containment ⇒ ~1 per tick regardless of document size. */
async function boundaryRendersFor(committed: number, ticks: number): Promise<number> {
  const { client, worker } = makeClient();
  await mount(createElement(BrookMarkdown, { client }));

  // Settle `committed` blocks first.
  await act(async () => {
    worker().fire(
      patch(
        Array.from({ length: committed }, (_, i) => blk(i, `<p>block ${i}</p>`)),
        [],
      ),
    );
  });

  // Now stream a growing tail; the committed prefix must not re-render.
  __resetBoundaryRenders();
  for (let t = 0; t < ticks; t++) {
    await act(async () => {
      worker().fire(patch([], [blk(10_000, `<p>tail ${"x".repeat(t + 1)}</p>`, true)]));
    });
  }
  return __getBoundaryRenders();
}

test("boundary renders track the streaming tail, not the document size", async () => {
  const TICKS = 8;
  const small = await boundaryRendersFor(4, TICKS);
  const large = await boundaryRendersFor(64, TICKS); // 16x the committed blocks

  // Linear containment: the committed prefix memo-skips, so a 16x bigger
  // document costs the same tail work. Before the boundary moved inside the
  // memo this was ~ticks*(committed+1) — 40 vs 520 here.
  expect(small).toBeLessThanOrEqual(TICKS * 2);
  expect(large).toBeLessThanOrEqual(TICKS * 2);
  // The real assertion: growth is flat in document size, not proportional.
  expect(large).toBeLessThanOrEqual(small * 2);
});

test("a settled document re-renders no boundaries when an unrelated tail patch lands", async () => {
  const { client, worker } = makeClient();
  await mount(createElement(BrookMarkdown, { client }));
  await act(async () => {
    worker().fire(
      patch(Array.from({ length: 32 }, (_, i) => blk(i, `<p>b${i}</p>`)), []),
    );
  });

  __resetBoundaryRenders();
  await act(async () => {
    worker().fire(patch([], [blk(999, "<p>tail</p>", true)]));
  });
  // Exactly the one new tail block — never the 32 committed ones.
  expect(__getBoundaryRenders()).toBe(1);
});
