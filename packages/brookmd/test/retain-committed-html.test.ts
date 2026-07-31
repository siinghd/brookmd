import { test, expect, beforeAll } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

// `setRetainCommittedHtml` over the REAL compiled boundary — the memory knob the
// worker turns OFF by default (see src/worker.ts). Three things are asserted:
//   1. the WIRE is unchanged: patch JSON is byte-identical with the flag off,
//      because a committed block crosses the boundary exactly once,
//   2. retention DIVERGES: with the flag on, the parser carries the whole
//      rendered document on top of the source buffer; with it off, retention
//      tracks the buffer and the committed html's contribution plateaus,
//   3. allBlocks() with the flag off still returns every block, with exact
//      metadata and an empty `html` for the committed ones (never throws).
//
// src/wasm is git-ignored (built by `bun run build:wasm`); dynamic import + skip
// so a fresh checkout does not fail collection.

const wasmUrl = new URL("../src/wasm/brook_md_core_bg.wasm", import.meta.url);
const haveWasm = existsSync(wasmUrl);

if (!haveWasm) {
  // eslint-disable-next-line no-console
  console.warn(
    "[retain-committed-html] src/wasm not built — run `bun run build:wasm` to enable; skipping.",
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let BrookParser: any;

beforeAll(async () => {
  if (!haveWasm) return;
  const glue = "../src/wasm/brook_md_core.js"; // variable specifier → runtime resolution
  const mod = await import(glue);
  mod.initSync({ module: readFileSync(wasmUrl) });
  BrookParser = mod.BrookParser;
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeParser(retain: boolean): any {
  const p = new BrookParser();
  p.setGfmAutolinks(true);
  p.setGfmAlerts(true);
  p.setRetainCommittedHtml(retain);
  return p;
}

// A mixed document that commits many blocks as it streams — prose, lists, a
// fence, a quote and a table, so the committed html is a real fraction of the
// source rather than one giant open block.
function mixedDoc(sections: number): string {
  let md = "";
  for (let i = 0; i < sections; i++) {
    md += `## Section ${i}\n\n`;
    md += `A paragraph with *emphasis*, a [link](https://example.com/${i}) and \`code\`.\n\n`;
    md += `- alpha ${i}\n- beta ${i}\n- gamma ${i}\n\n`;
    md += "```js\nconst x = " + i + ";\n```\n\n";
    md += `> Quoted line ${i}.\n\n`;
    md += `| a | b |\n| - | - |\n| ${i} | ${i + 1} |\n\n`;
  }
  return md;
}

function chunk(s: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

test.skipIf(!haveWasm)("real WASM: patches are byte-identical with retainCommittedHtml off", () => {
  const md = mixedDoc(12);
  const on = makeParser(true);
  const off = makeParser(false);
  try {
    for (const c of chunk(md, 97)) {
      expect(off.append(c)).toBe(on.append(c));
    }
    expect(off.finalize()).toBe(on.finalize());
  } finally {
    on.free();
    off.free();
  }
});

test.skipIf(!haveWasm)("real WASM: retainedBytes plateaus with the flag off and grows with it on", () => {
  // ~1 MB of mixed markdown, sampled a quarter of the way through and at the
  // end. Ratios only — absolute byte counts are a renderer detail.
  const md = mixedDoc(5000);
  expect(md.length).toBeGreaterThan(1_000_000);
  const chunks = chunk(md, 8192);
  const quarter = Math.floor(chunks.length / 4);

  const on = makeParser(true);
  const off = makeParser(false);
  try {
    let onQuarter = 0;
    let offQuarter = 0;
    let bufQuarter = 0;
    for (let i = 0; i < chunks.length; i++) {
      on.append(chunks[i]);
      off.append(chunks[i]);
      if (i === quarter) {
        onQuarter = on.retainedBytes();
        offQuarter = off.retainedBytes();
        bufQuarter = off.bufferLen();
      }
    }
    on.finalize();
    off.finalize();

    const onEnd = on.retainedBytes();
    const offEnd = off.retainedBytes();
    const bufEnd = off.bufferLen();

    // The whole point: the flag-off parser retains materially less.
    expect(offEnd).toBeLessThan(onEnd);
    expect(onEnd / offEnd).toBeGreaterThan(1.5);

    // Flag ON: the retained html grows in step with the document, so the
    // committed-html overhead above the source buffer scales with it.
    const onOverheadQuarter = onQuarter - bufQuarter;
    const onOverheadEnd = onEnd - bufEnd;
    expect(onOverheadEnd / onOverheadQuarter).toBeGreaterThan(2);

    // Flag OFF: the overhead above the buffer is only the open tail, so it does
    // NOT scale with the document — the plateau.
    const offOverheadQuarter = offQuarter - bufQuarter;
    const offOverheadEnd = offEnd - bufEnd;
    expect(offOverheadEnd).toBeLessThan(Math.max(offOverheadQuarter, 1024) * 2);
    // ...and it is a rounding error next to the flag-on overhead.
    expect(offOverheadEnd * 20).toBeLessThan(onOverheadEnd);
  } finally {
    on.free();
    off.free();
  }
});

test.skipIf(!haveWasm)("real WASM: allBlocks() with the flag off keeps metadata and empties committed html", () => {
  const md = mixedDoc(3);
  const on = makeParser(true);
  const off = makeParser(false);
  try {
    on.append(md);
    off.append(md);
    on.finalize();
    off.finalize();
    // Must not throw, and must return the same block list shape.
    const a = JSON.parse(on.allBlocks()) as Array<Record<string, unknown>>;
    const b = JSON.parse(off.allBlocks()) as Array<Record<string, unknown>>;
    expect(b.length).toBe(a.length);
    expect(a.length).toBeGreaterThan(10);
    for (let i = 0; i < a.length; i++) {
      expect({ ...b[i], html: undefined }).toEqual({ ...a[i], html: undefined });
      expect(a[i].html).not.toBe("");
      // Post-finalize every block is committed, so every payload was released.
      expect(b[i].html).toBe("");
    }
  } finally {
    on.free();
    off.free();
  }
});
