// Node ESM resolution + worker-FREE render against the BUILT, PACKED dist.
//
// Run with cwd = a throwaway consumer dir whose node_modules/ contains the
// extracted brookmd tarball plus react/react-dom/scheduler symlinks (run.sh sets
// this up). Proves: the published exports map resolves under Node native ESM,
// the `.js`-extensioned relative imports load, the wasm reads off disk via
// node:fs (no Worker, no fetch), and both the string + RSC render paths work.
import assert from "node:assert/strict";

const m = await import("brookmd/server");

for (const k of ["initBrook", "initBrookSync", "isBrookReady", "parseToBlocks", "renderToString"]) {
  assert.ok(typeof m[k] !== "undefined", `brookmd/server missing export: ${k}`);
}
// The React component moved to brookmd/server/react so the core entry stays
// React-free; assert it is NOT on the bare server entry.
assert.equal(typeof m.BrookMarkdownStatic, "undefined", "brookmd/server must not export the React BrookMarkdownStatic");
console.log("ok  - brookmd/server resolved via dist; exports:", Object.keys(m).join(", "));

await m.initBrook();                                  // reads ./wasm/*.wasm via node:fs — no Worker
assert.ok(m.isBrookReady(), "initBrook() did not mark the core ready");
console.log("ok  - initBrook() loaded wasm with no Worker");

const html = m.renderToString("# Hello **world**\n\n- a\n- b\n\n```js\nconst x = 1;\n```");
assert.match(html, /<h1[^>]*>/, "renderToString: no <h1>");
assert.match(html, /<strong[^>]*>world<\/strong>/, "renderToString: no inline emphasis");
assert.match(html, /<ul/, "renderToString: no list");
console.log("ok  - renderToString:", JSON.stringify(html.slice(0, 60)));

const mr = await import("brookmd/server/react");
assert.equal(typeof mr.BrookMarkdownStatic, "function", "brookmd/server/react missing BrookMarkdownStatic");
const { createElement } = await import("react");
const { renderToString } = await import("react-dom/server");
const rsc = renderToString(createElement(mr.BrookMarkdownStatic, { content: "## sub *em*" }));
assert.match(rsc, /<h2[^>]*>/, "BrookMarkdownStatic: no <h2>");
assert.match(rsc, /<em[^>]*>em<\/em>/, "BrookMarkdownStatic: no emphasis");
assert.match(rsc, /brook-md/, "BrookMarkdownStatic: no brook-md root class");
console.log("ok  - brookmd/server/react BrookMarkdownStatic (RSC):", JSON.stringify(rsc.slice(0, 60)));

console.log("\nNODE-ESM SERVER + RSC PATH OK (real exports map + built dist + wasm fs-read)");
