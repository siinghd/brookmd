import { test, expect, beforeAll, spyOn } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { createElement, act } from "react";
import { BrookClient, BrookPool } from "../src/client";
import { BrookMarkdown } from "../src/react";
import { mountBrookMarkdown } from "../src/dom";
import type { FromWorker, ToWorker, WorkerLike } from "../src/types";

class FakeWorker implements WorkerLike {
  sent: ToWorker[] = [];
  private listener: ((ev: { data: FromWorker }) => void) | null = null;
  postMessage(msg: ToWorker) { this.sent.push(msg); }
  addEventListener(_t: "message", l: (ev: { data: FromWorker }) => void) { this.listener = l; }
  terminate() {}
  fire(msg: FromWorker) { this.listener?.({ data: msg }); }
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

async function mount(node: ReturnType<typeof createElement>) {
  const { createRoot } = await import("react-dom/client");
  const host = win.document.createElement("div");
  const root = createRoot(host as unknown as Element);
  await act(async () => { root.render(node); });
  return { host, root };
}

// --------------------------------------------------------------------------
// 1. React: opt-in className/id/role/aria-live land on the root, and the
//    `brook-md` class is always preserved.
// --------------------------------------------------------------------------
test("React <BrookMarkdown> applies className/id/role/aria-live to the root", async () => {
  const client = new BrookClient();
  const { host } = await mount(
    createElement(BrookMarkdown, {
      client,
      className: "custom",
      id: "md",
      role: "log",
      "aria-live": "polite",
      "aria-atomic": false,
    }),
  );
  const root = host.querySelector("div.brook-md") as unknown as HTMLElement;
  expect(root).not.toBeNull();
  expect(root.className).toBe("brook-md custom"); // brook-md always present + appended
  expect(root.id).toBe("md");
  expect(root.getAttribute("role")).toBe("log");
  expect(root.getAttribute("aria-live")).toBe("polite");
  expect(root.getAttribute("aria-atomic")).toBe("false");
  client.destroy();
});

test("React <BrookMarkdown> with no a11y props is unchanged (just brook-md)", async () => {
  const client = new BrookClient();
  const { host } = await mount(createElement(BrookMarkdown, { client }));
  const root = host.querySelector("div.brook-md") as unknown as HTMLElement;
  expect(root.className).toBe("brook-md");
  expect(root.getAttribute("aria-live")).toBeNull(); // off by default
  expect(root.hasAttribute("role")).toBe(false);
  client.destroy();
});

// --------------------------------------------------------------------------
// 2. DOM mount: the same options on the framework-agnostic root
//    (covers element / vue / svelte / solid, which mount via mountBrookMarkdown).
// --------------------------------------------------------------------------
test("mountBrookMarkdown applies className/role/aria-live to the root", () => {
  const client = new BrookClient();
  const container = win.document.createElement("div") as unknown as HTMLElement;
  const handle = mountBrookMarkdown(client, container, {
    className: "x",
    id: "y",
    role: "log",
    ariaLive: "polite",
    ariaAtomic: true,
  });
  const root = container.firstElementChild as HTMLElement;
  expect(root.className).toBe("brook-md x");
  expect(root.id).toBe("y");
  expect(root.getAttribute("role")).toBe("log");
  expect(root.getAttribute("aria-live")).toBe("polite");
  expect(root.getAttribute("aria-atomic")).toBe("true");
  handle.destroy();
});

// --------------------------------------------------------------------------
// 3. Real hydration: renderToString → hydrateRoot over the server markup must
//    not warn about a mismatch (the snapshot-parity proxy, now exercised for
//    real). A committed block is present at both render and hydrate.
// --------------------------------------------------------------------------
test("hydrateRoot over server markup produces no hydration mismatch", async () => {
  const { renderToString } = await import("react-dom/server");
  const { hydrateRoot } = await import("react-dom/client");

  const worker = new FakeWorker();
  const pool = new BrookPool(() => worker, 1);
  const client = new BrookClient({ pool });
  client.append(""); // lazy-acquire → streamId 1, registers the handler
  worker.fire({
    type: "patch",
    streamId: 1,
    patch: JSON.stringify({
      newly_committed: [
        { id: 1, kind: { type: "Paragraph" }, start: 0, end: 0, html: "<p>hello</p>", open: false, speculative: false },
      ],
      active: [],
    }),
    appendedBytes: 0, parseMicros: 0, retainedBytes: 0, wasmMemoryBytes: 0,
  });

  // Server markup for the SAME client snapshot.
  const serverHtml = renderToString(createElement(BrookMarkdown, { client }));
  expect(serverHtml).toContain("hello");

  const host = win.document.createElement("div");
  host.innerHTML = serverHtml;

  const errSpy = spyOn(console, "error");
  try {
    await act(async () => {
      hydrateRoot(host as unknown as Element, createElement(BrookMarkdown, { client }));
    });
    const mismatch = errSpy.mock.calls.some((c) =>
      String(c[0] ?? "").toLowerCase().match(/hydrat|did not match|mismatch/),
    );
    expect(mismatch).toBe(false);
    expect(host.textContent).toContain("hello"); // content survived hydration
  } finally {
    errSpy.mockRestore();
    client.destroy();
  }
});
