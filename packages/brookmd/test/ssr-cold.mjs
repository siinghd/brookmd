// SSR cold-import tripwire — run in a FRESH process (`bun test/ssr-cold.mjs`),
// NOT under `bun test`. The in-process SSR suite (ssr.test.ts) can pass trivially
// because a sibling happy-dom suite imports the modules first, so bun's warm
// module cache means a re-import never re-runs top-level code. This script is the
// load-bearing proof: it strips every browser global, then cold-imports each
// entrypoint (top-level code runs for real) and exercises construct + render.
// A future top-level browser-global deref fails CI here, not silently in prod.
//
// Exit non-zero on any failure so CI catches it.

for (const g of [
  "window", "document", "navigator", "self", "Worker", "HTMLElement",
  "customElements", "requestAnimationFrame", "cancelAnimationFrame", "MutationObserver",
]) {
  delete globalThis[g];
}

let failures = 0;
const ok = (m) => console.log("  ok  " + m);
const fail = (m, e) => { failures++; console.error("  FAIL " + m + ": " + (e?.message || e)); };

// 1) Every public entrypoint imports with no browser env (top-level runs cold).
const entrypoints = [
  "../src/index.ts", "../src/client.ts", "../src/react.tsx", "../src/dom.ts",
  "../src/element.ts", "../src/vue.ts", "../src/svelte.ts", "../src/solid.tsx",
  "../src/hi.ts", "../src/html-to-react.ts", "../src/types.ts",
  // Advanced engine-neutral entries reused by non-DOM consumers (e.g. React
  // Native): each must stay import-safe with zero browser globals.
  "../src/block-props.ts", "../src/worker-core.ts",
];
for (const ep of entrypoints) {
  try { await import(ep); ok("import " + ep); } catch (e) { fail("import " + ep, e); }
}

// 2) The original repro: new BrookClient() must not create a Worker on the server.
try {
  const { BrookClient } = await import("../src/index.ts");
  const c = new BrookClient();
  if (c.getSnapshot().length !== 0) throw new Error("expected empty snapshot");
  if (c.ready !== false) throw new Error("expected ready === false before first op");
  c.destroy(); // never-acquired client: no pool slot to free
  ok("new BrookClient() + getSnapshot() + destroy() (no Worker)");
} catch (e) { fail("new BrookClient()", e); }

// 3) React SSR of both modes renders the stable empty placeholder (hydrates clean).
const { BrookClient } = await import("../src/index.ts");
try {
  const { createElement } = await import("react");
  const { renderToString } = await import("react-dom/server");
  const { BrookMarkdown } = await import("../src/react.tsx");
  const fromClient = renderToString(createElement(BrookMarkdown, { client: new BrookClient() }));
  async function* gen() { yield "# hi"; }
  const fromStream = renderToString(createElement(BrookMarkdown, { stream: gen() }));
  if (!fromClient.includes("brook-md")) throw new Error("client mode markup unexpected: " + fromClient);
  if (!fromStream.includes("brook-md")) throw new Error("stream mode markup unexpected: " + fromStream);
  ok("renderToString <BrookMarkdown client> + <BrookMarkdown stream>");
} catch (e) { fail("React renderToString", e); }

// 4) Cross-framework SSR — safe here (dedicated process; no sibling suite to
//    poison via @vue/runtime-dom's module-level `doc` cache). This is the
//    load-bearing home for Vue/Solid/Svelte server rendering.
try {
  const { createSSRApp } = await import("vue");
  const { renderToString: renderVue } = await import("vue/server-renderer");
  const { BrookMarkdown: VueBrook } = await import("../src/vue.ts");
  const html = await renderVue(createSSRApp(VueBrook, { client: new BrookClient() }));
  if (typeof html !== "string" || !html.includes("<div")) throw new Error("vue SSR markup unexpected: " + html);
  ok("Vue renderToString <BrookMarkdown>");
} catch (e) { fail("Vue SSR", e); }

try {
  const { BrookMarkdown: SolidBrook } = await import("../src/solid.tsx");
  const r = SolidBrook({ client: new BrookClient() }); // body runs on server
  if (r !== undefined) throw new Error("solid server body should return placeholder undefined, got: " + r);
  ok("Solid BrookMarkdown body (server placeholder)");
} catch (e) { fail("Solid SSR", e); }

try {
  const sv = await import("../src/svelte.ts");
  if (typeof sv.brookMarkdown !== "function") throw new Error("svelte action export missing");
  ok("Svelte action module (server-safe, not auto-invoked)");
} catch (e) { fail("Svelte SSR", e); }

// 5) The controlled-string helpers (setContent bridges) must ALSO be SSR-safe:
//    they construct a client in the body (fine) but must NOT call setContent on
//    the server (setContent → append → spawns a Worker, which is deleted above,
//    so a stray server-side feed would throw here). A clean render/call proves it.
try {
  const { createSSRApp, defineComponent, h } = await import("vue");
  const { renderToString: renderVue } = await import("vue/server-renderer");
  const { useBrookMarkdownString, BrookMarkdown: VueBrook } = await import("../src/vue.ts");
  const StringComp = defineComponent({
    setup() {
      const client = useBrookMarkdownString(() => "# hi", () => ({ streaming: true }));
      return () => h(VueBrook, { client });
    },
  });
  const html = await renderVue(createSSRApp(StringComp));
  if (typeof html !== "string" || !html.includes("<div")) throw new Error("vue string SSR markup unexpected: " + html);
  ok("Vue useBrookMarkdownString (SSR render, no Worker)");
} catch (e) { fail("Vue useBrookMarkdownString SSR", e); }

try {
  const { createRoot } = await import("solid-js");
  const { createBrookMarkdownString } = await import("../src/solid.tsx");
  // Server build: createEffect is a no-op, so setContent never runs → no Worker.
  // createRoot gives the effect/cleanup an owner; dispose runs the cleanup.
  createRoot((dispose) => {
    const client = createBrookMarkdownString(() => "# hi", () => ({ streaming: true }));
    if (!client || typeof client.getSnapshot !== "function") throw new Error("expected a BrookClient");
    dispose();
  });
  ok("Solid createBrookMarkdownString (SSR, effect deferred, no Worker)");
} catch (e) { fail("Solid createBrookMarkdownString SSR", e); }

try {
  const sv = await import("../src/svelte.ts");
  // The action only runs in the browser (Svelte invokes it on mount), so as with
  // brookMarkdown the SSR proof is that the export exists and the module is cold-safe.
  if (typeof sv.brookMarkdownString !== "function") throw new Error("svelte string action export missing");
  ok("Svelte brookMarkdownString action (server-safe, not auto-invoked)");
} catch (e) { fail("Svelte brookMarkdownString SSR", e); }

if (failures > 0) {
  console.error(`\nSSR cold-import tripwire: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nSSR cold-import tripwire: PASS (entrypoints + new BrookClient + renderToString, zero browser globals)");
