import { test, expect, beforeAll } from "bun:test";
import { existsSync } from "node:fs";
import type { Block, ListItemData, ParserConfig } from "../src/types-core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Worker-free, synchronous server / static rendering (brookmd/server). Requires
// the compiled WASM (built by `bun run build:wasm`); skips when absent.
const wasmUrl = new URL("../src/wasm/brook_md_core_bg.wasm", import.meta.url);
const haveWasm = existsSync(wasmUrl);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let server: any;
// BrookMarkdownStatic lives in the React subpath so the bare `brookmd/server`
// stays importable with no react installed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let serverReact: any;
beforeAll(async () => {
  if (!haveWasm) return;
  const mod = "../src/server"; // variable specifier: resolved at runtime, not collection
  server = await import(mod);
  serverReact = await import("../src/server-react");
  await server.initBrook(); // Node path: reads the co-located .wasm off disk
});

test.skipIf(!haveWasm)("brookmd/server is React-free: it does not re-export the React BrookMarkdownStatic", () => {
  // The React component moved to brookmd/server/react so the core entry imports
  // cleanly without react. (Structural react-free guard is in scripts/build.mjs.)
  expect(server.BrookMarkdownStatic).toBeUndefined();
  expect(typeof serverReact.BrookMarkdownStatic).toBe("function");
});

test.skipIf(!haveWasm)("renderToString: worker-free sync HTML string", () => {
  const html = server.renderToString("# Title\n\nHello **world**\n");
  expect(html).toContain("<h1");
  expect(html).toContain("<strong>world</strong>");
  expect(server.isBrookReady()).toBe(true);
});

test.skipIf(!haveWasm)("renderToString: inline component tags emit a real element in the HTML string", () => {
  const html = server.renderToString('Buy <tik symbol="AAPL">A</tik> now\n', {
    config: { inlineComponentTags: ["tik"] },
  });
  expect(html).toContain('<tik symbol="AAPL">A</tik>');
});

test.skipIf(!haveWasm)("renderToString: a block component tag used inline does not eat the following table (P1)", () => {
  const html = server.renderToString("<tik>AAPL</tik> is up.\n\n| a |\n| --- |\n| 1 |\n", {
    config: { componentTags: ["tik"] },
  });
  expect(html).toContain("<table>");
  expect(html).toContain("is up.");
});

test.skipIf(!haveWasm)("BrookMarkdownStatic: emits the brook-md root and dispatches inline components", () => {
  const out = renderToStaticMarkup(
    createElement(serverReact.BrookMarkdownStatic, {
      content: 'Buy <tik symbol="AAPL">**A**</tik> now\n',
      config: { inlineComponentTags: ["tik"] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      components: { tik: (p: any) => createElement("span", { className: "chip" }, p.children) },
    }),
  );
  expect(out).toContain('class="brook-md"');
  expect(out).toContain('<span class="chip"><strong>A</strong></span>');
});

test.skipIf(!haveWasm)("BrookMarkdownStatic: a block component override receives parsed children (P2)", () => {
  const out = renderToStaticMarkup(
    createElement(serverReact.BrookMarkdownStatic, {
      content: "<Note>\nhello **world**\n</Note>\n",
      config: { componentTags: ["Note"] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      components: { Note: (p: any) => createElement("aside", { className: "note" }, p.children) },
    }),
  );
  expect(out).toContain('<aside class="note">');
  expect(out).toContain("<strong>world</strong>");
});

test.skipIf(!haveWasm)("BrookMarkdownStatic: no components → byte-identical innerHTML wrapper", () => {
  const out = renderToStaticMarkup(createElement(serverReact.BrookMarkdownStatic, { content: "hi\n" }));
  expect(out).toBe('<div class="brook-md"><div class="brook-block brook-block-paragraph"><p>hi</p></div></div>');
});

// ----- safe raw-HTML sanitizer (end-to-end via real WASM) -----

test.skipIf(!haveWasm)("HTML comments are dropped, not escaped to visible text", () => {
  const html = server.renderToString("Cap <!--mk:marketcap--> here\n");
  expect(html).not.toContain("mk:marketcap");
  expect(html).not.toContain("&lt;!--");
  expect(html).not.toContain("<pre>");
});

test.skipIf(!haveWasm)("htmlAllowlist renders listed inline tags, escapes the rest", () => {
  const html = server.renderToString("H<sub>2</sub>O <div>x</div>\n", {
    config: { htmlAllowlist: ["sub", "sup", "br"] },
  });
  expect(html).toContain("<sub>2</sub>");
  expect(html).toContain("&lt;div&gt;");
});

test.skipIf(!haveWasm)("empty htmlAllowlist = allow all except dangerous", () => {
  const html = server.renderToString("text <b>x</b> <script>alert(1)</script>\n", {
    config: { htmlAllowlist: [] },
  });
  expect(html).toContain("<b>x</b>");
  expect(html.toLowerCase()).not.toContain("<script");
  expect(html).toContain("alert(1)"); // inert text, not executed
});

test.skipIf(!haveWasm)("dropHtmlTags removes a tag entirely (allow-all otherwise)", () => {
  const html = server.renderToString("a <mk>x</mk> <b>y</b>\n", { config: { dropHtmlTags: ["mk"] } });
  expect(html.toLowerCase()).not.toContain("<mk");
  expect(html).toContain("<b>y</b>");
  expect(html).toContain("x");
});

// ── ParserConfig round-trips over the REAL binary ────────────────────────────
// The four newest flags reach the parser only through `makeParser`'s
// `set*` calls, and this is the only harness that runs a TS `ParserConfig`
// against the actual WASM (worker-core drives a FakeParser; the pool tests
// drive a FakeWorker with synthetic patches). A missing/renamed binding would
// otherwise surface as `p.setX is not a function` at runtime, not in CI.

test.skipIf(!haveWasm)("config.softBreaks: a soft line break becomes <br> (off by default)", () => {
  const md = "a\nb\n";
  expect(server.renderToString(md)).toBe("<p>a\nb</p>\n");
  expect(server.renderToString(md, { config: { softBreaks: true } })).toBe("<p>a<br>\nb</p>\n");
});

test.skipIf(!haveWasm)("config.allowSchemes: ['file'] un-blocks file: links; javascript: stays non-overridable", () => {
  const md = "[doc](file:///etc/hosts)\n";
  // Default policy neutralizes the href to "#"…
  expect(server.renderToString(md)).toContain('href="#"');
  // …and the opt-in un-blocklist lets exactly that one scheme through.
  expect(server.renderToString(md, { config: { allowSchemes: ["file"] } })).toContain(
    'href="file:///etc/hosts"',
  );
  // The script-executing tier ignores the list (documented silent no-op).
  const js = server.renderToString("[x](javascript:alert(1))\n", {
    config: { allowSchemes: ["javascript"] },
  });
  expect(js).toContain('href="#"');
  expect(js).not.toContain("javascript:");
});

test.skipIf(!haveWasm)("config.lenientLists: 6+ columns of marker padding stay list text, not indented code", () => {
  const md = "-       const value = 1;\n";
  // Strict CommonMark (§5.2): the over-indent opens an indented code block.
  expect(server.renderToString(md)).toContain("<pre><code>");
  const on = server.renderToString(md, { config: { lenientLists: true } });
  expect(on).toBe("<ul>\n<li>const value = 1;</li>\n</ul>\n");
  expect(on).not.toContain("<pre>");
});

test.skipIf(!haveWasm)("config.blockHtml: block-level raw HTML renders only with the sanitizer engaged", () => {
  const md = "<details>\n<summary>More</summary>\n</details>\n";
  const escaped = "<pre><code>&lt;details&gt;\n&lt;summary&gt;More&lt;/summary&gt;\n&lt;/details&gt;\n</code></pre>\n";
  // Sanitizer engaged (htmlAllowlist: []) but blockHtml off → still escaped.
  expect(server.renderToString(md, { config: { htmlAllowlist: [] } })).toBe(escaped);
  // Sanitizer engaged + blockHtml on → real elements (CommonMark HTML block type 6).
  expect(server.renderToString(md, { config: { htmlAllowlist: [], blockHtml: true } })).toBe(
    "<details>\n<summary>More</summary>\n</details>\n",
  );
  // blockHtml alone does nothing — it only extends an engaged sanitizer.
  expect(server.renderToString(md, { config: { blockHtml: true } })).toBe(escaped);
});

test.skipIf(!haveWasm)("CodeBlockData.meta: the info-string remainder crosses the boundary (always on, no data-meta attr)", () => {
  const blocks = server.parseToBlocks('```ts title="src/main.ts"\nconst x = 1;\n```\n');
  const code = blocks.find((b: Block) => b.kind.type === "CodeBlock");
  expect(code).toBeDefined();
  // `lang` is the first word, `meta` the RAW remainder — both without blockData.
  expect(code.kind.data.lang).toBe("ts");
  expect(code.kind.data.meta).toBe('title="src/main.ts"');
  // Only `lang` reaches the HTML: there is deliberately no data-meta attribute.
  expect(code.html).toContain('data-lang="ts"');
  expect(code.html).not.toContain("data-meta");
});

test.skipIf(!haveWasm)("ListItemData.start: per-item source offsets appear only with blockData on", () => {
  const md = "- alpha\n- beta\n";
  const listOf = (opts?: { config?: ParserConfig }) =>
    server.parseToBlocks(md, opts).find((b: Block) => b.kind.type === "List");

  const on = listOf({ config: { blockData: true } });
  expect(on.kind.data.items.map((i: ListItemData) => i.html)).toEqual(["alpha", "beta"]);
  // Document-absolute byte offset of each item's marker: `- alpha\n` is 8 bytes.
  expect(on.kind.data.items.map((i: ListItemData) => i.start)).toEqual([0, 8]);
  expect(md.slice(on.kind.data.items[1].start)).toBe("- beta\n");

  // Default-off contract: kind.data is exactly { ordered } — no start, no items.
  expect(listOf().kind.data).toEqual({ ordered: false });
});
