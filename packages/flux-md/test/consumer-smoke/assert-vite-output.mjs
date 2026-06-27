// Inspect a downstream Vite build's output and prove flux-md's worker + wasm
// graph survived as SEPARATE, non-inlined artifacts. Pass the output dir as argv[2]
// (run.sh points it at web/dist-flux, the real consumer build of flux-entry.ts
// against the BUILT flux-md dist).
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const dist = process.argv[2];
if (!dist) { console.error("usage: node assert-vite-output.mjs <vite-output-dir>"); process.exit(2); }

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

const files = await walk(dist);
const js = files.filter((f) => f.endsWith(".js"));
const wasm = files.filter((f) => f.endsWith(".wasm"));
const contents = new Map();
for (const f of js) contents.set(f, await readFile(f, "utf8"));

let failed = false;
const fail = (m) => { failed = true; console.error("FAIL:", m); };
const ok = (m) => console.log("ok  -", m);
const base = (f) => path.basename(f);

// 1) a real .wasm asset was emitted.
wasm.length >= 1 ? ok(`wasm asset emitted: ${wasm.map(base).join(", ")}`)
                 : fail("no .wasm file in output (it was inlined or dropped)");

// 2) wasm is NOT base64-inlined into any JS chunk.
let inlined = false;
for (const s of contents.values())
  if (s.includes("application/wasm;base64") || s.includes("data:application/wasm")) inlined = true;
inlined ? fail("wasm was base64-inlined into a JS chunk") : ok("wasm not base64-inlined");

// 3) >=2 JS chunks: the worker is its own module graph, split from the entry.
js.length >= 2 ? ok(`${js.length} JS chunks emitted`) : fail(`expected >=2 JS chunks, got ${js.length}`);

// 4) a dedicated worker/wasm-glue chunk exists (carries wasm-bindgen markers).
const glue = [...contents].filter(([, s]) => s.includes("__wbindgen") || s.includes("flux_md_core_bg"));
glue.length >= 1 ? ok(`wasm-bindgen glue chunk: ${glue.map(([f]) => base(f)).join(", ")}`)
                 : fail("no chunk references the wasm-bindgen glue — worker graph missing");

// 5) code spawns a real Worker from a URL, not an inlined Blob (a blob worker
//    cannot fetch the sibling .wasm, which is the whole reason to stay modular).
let spawns = false, blob = false;
for (const s of contents.values()) {
  if (/new\s+Worker\s*\(/.test(s)) spawns = true;
  if (s.includes("createObjectURL") && /new\s+Worker/.test(s)) blob = true;
}
spawns ? ok("code spawns new Worker(...)") : fail("no `new Worker(` in output");
blob ? fail("worker inlined as Blob/createObjectURL (breaks the wasm fetch)")
     : ok("worker spawned from a URL, not an inlined Blob");

if (failed) { console.error("\nconsumer dist assertions FAILED"); process.exit(1); }
console.log("\nALL consumer Vite-output assertions passed (separate worker chunk + non-inlined wasm)");
