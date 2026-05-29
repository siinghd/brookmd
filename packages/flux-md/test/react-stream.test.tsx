import { test, expect, beforeAll, spyOn } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { createElement, act } from "react";
import type { FromWorker, ToWorker, WorkerLike } from "../src/types";
import { FluxClient, FluxPool } from "../src/client";
import { FluxMarkdown, useFluxStream } from "../src/react";

// Synchronous fake worker (same shape as the other suites).
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
  // The default pool builds `new Worker(...)`; give it a no-op fake so the
  // internal client useFluxStream creates can be constructed. We assert on the
  // client's own append/finalize (prototype spies), not on the worker, so this
  // is robust to the shared default pool reusing workers across test files.
  g.Worker = FakeWorker as unknown;
  (g as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const tick = () => new Promise((r) => setTimeout(r, 0));

async function mount(node: ReturnType<typeof createElement>) {
  const { createRoot } = await import("react-dom/client");
  const host = win.document.createElement("div");
  const root = createRoot(host as unknown as Element);
  await act(async () => {
    root.render(node);
  });
  return { host, root };
}

test("<FluxMarkdown stream> pipes an AsyncIterable: append per chunk, then finalize once", async () => {
  const appendSpy = spyOn(FluxClient.prototype, "append");
  const finalizeSpy = spyOn(FluxClient.prototype, "finalize");
  try {
    async function* gen() {
      yield "# Hi\n";
      yield "body";
    }
    await mount(createElement(FluxMarkdown, { stream: gen() }));
    await act(async () => {
      await tick(); // let pipeFrom drain the generator
    });
    const appended = appendSpy.mock.calls.map((c) => c[0]).join("");
    expect(appended).toContain("# Hi");
    expect(appended).toContain("body");
    expect(finalizeSpy.mock.calls.length).toBe(1);
  } finally {
    appendSpy.mockRestore();
    finalizeSpy.mockRestore();
  }
});

test("useFluxStream destroys its owned client on unmount, and only then", async () => {
  let captured: FluxClient | null = null;
  function Probe({ stream }: { stream: AsyncIterable<string> }) {
    captured = useFluxStream(stream);
    return createElement("div", null, "ok");
  }
  async function* gen() {
    yield "x";
  }
  const { root } = await mount(createElement(Probe, { stream: gen() }));
  await act(async () => {
    await tick();
  });
  expect(captured).not.toBeNull();
  const destroySpy = spyOn(captured!, "destroy");
  expect(destroySpy).not.toHaveBeenCalled(); // alive while mounted
  await act(async () => {
    root.unmount();
  });
  expect(destroySpy).toHaveBeenCalledTimes(1); // destroyed exactly once, on unmount
});

test("<FluxMarkdown client> NEVER destroys the caller-owned client on unmount", async () => {
  const created: FakeWorker[] = [];
  const pool = new FluxPool(() => {
    const w = new FakeWorker();
    created.push(w);
    return w;
  }, 1);
  const client = new FluxClient({ pool });
  client.append(""); // force worker creation
  const destroySpy = spyOn(client, "destroy");
  const { root } = await mount(createElement(FluxMarkdown, { client }));
  await act(async () => {
    root.unmount();
  });
  expect(destroySpy).not.toHaveBeenCalled(); // ownership invariant
});

test("toggling between `client` and `stream` props does not violate the Rules of Hooks", async () => {
  const created: FakeWorker[] = [];
  const pool = new FluxPool(() => {
    const w = new FakeWorker();
    created.push(w);
    return w;
  }, 1);
  const caller = new FluxClient({ pool });
  caller.append("");
  async function* gen() {
    yield "a";
  }
  const { createRoot } = await import("react-dom/client");
  const host = win.document.createElement("div");
  const root = createRoot(host as unknown as Element);
  // Switch the SAME root across modes — a conditional hook would make React throw
  // 'rendered more/fewer hooks than during the previous render'.
  await act(async () => {
    root.render(createElement(FluxMarkdown, { client: caller }));
  });
  await act(async () => {
    root.render(createElement(FluxMarkdown, { stream: gen() }));
  });
  await act(async () => {
    await tick();
  });
  await act(async () => {
    root.render(createElement(FluxMarkdown, { client: caller }));
  });
  await act(async () => {
    root.unmount();
  });
  expect(true).toBe(true); // reaching here without a hooks-order throw is the assertion
});

test("React StrictMode double-mount never double-finalizes and never throws", async () => {
  const { StrictMode } = await import("react");
  const finalizeSpy = spyOn(FluxClient.prototype, "finalize");
  try {
    async function* gen() {
      yield "a";
      yield "b";
    }
    await mount(createElement(StrictMode, null, createElement(FluxMarkdown, { stream: gen() })));
    await act(async () => {
      await tick();
    });
    // The safety guarantee: a superseded effect run aborts WITHOUT finalizing,
    // so the stream finalizes at most once even under the dev double-mount.
    expect(finalizeSpy.mock.calls.length).toBeLessThanOrEqual(1);
  } finally {
    finalizeSpy.mockRestore();
  }
});
