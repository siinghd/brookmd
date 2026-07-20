// Keyed OPEN-block renderer tests. Two guarantees:
//   1. EQUIVALENCE — for a closed List/Table/Blockquote/Alert, the keyed path
//      (render from kind.data) produces a structurally identical tree to the
//      whole-html path (only work is saved, never output).
//   2. WORK BOUND — streaming a list through the keyed path re-tokenizes O(items)
//      (each item ~once, via React.memo), not O(patches × items) as a naive
//      re-tokenize-all path would. Proven with the real React reconciler.
import { beforeAll, describe, expect, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";
import { createElement, Fragment, type ReactNode } from "react";
import { getParseCount, htmlToReact, resetParseCount } from "brookmd/html-to-react";
import type { Block, Components } from "brookmd/types";
import type { BrookClient } from "brookmd/client";
import { createComponents, RENDER_OPEN_BLOCK, type OpenBlockRenderer } from "../src/components";
import { makeBrookMarkdown, __resetUnstableWarnings } from "../src/BrookMarkdown";
import { resolveTheme } from "../src/theme";
import { haveWasm, loadWasm, oneShot, parseStates, type WireBlock } from "./fixtures";

// Host-string primitives so react-test-renderer's toJSON exposes the primitive
// nesting (RNView > RNText …) for structural comparison.
const hostPrimitives = {
  Text: "RNText",
  View: "RNView",
  ScrollView: "RNScrollView",
  Image: "RNImage",
  Pressable: "RNPressable",
  Linking: { openURL: () => Promise.resolve() },
  StyleSheet: { create: <T extends Record<string, object>>(s: T) => s, hairlineWidth: 1 },
} as unknown as Parameters<typeof createComponents>[0];

const comps: Components = createComponents(hostPrimitives, resolveTheme("light"));
const keyedRenderer = (comps as unknown as Record<symbol, OpenBlockRenderer>)[RENDER_OPEN_BLOCK];

// react-test-renderer JSON → {type, children} structure, dropping props (styles /
// handlers differ in identity, not in structure) and whitespace-only strings.
type Norm = string | { type: unknown; children: Norm[] } | null;
function norm(n: unknown): Norm {
  if (n == null) return null;
  if (typeof n === "string") return n.trim() === "" ? null : n;
  if (Array.isArray(n)) return n.map(norm).filter((x) => x !== null) as unknown as Norm;
  const node = n as { type: unknown; children?: unknown };
  const kids = Array.isArray(node.children) ? (node.children.map(norm).filter((x) => x !== null) as Norm[]) : [];
  return { type: node.type, children: kids };
}

function renderJson(node: ReactNode): unknown {
  let root: TestRenderer.ReactTestRenderer;
  act(() => {
    root = TestRenderer.create(createElement(Fragment, null, node));
  });
  const json = root!.toJSON();
  act(() => root.unmount());
  return json;
}

// The RN device-crash tripwire, applied to a react-test-renderer JSON tree (host
// string types RNView/RNText/…): a block-level view primitive (RNView/RNScrollView)
// must NEVER sit beneath an RNText ancestor. Returns the path to the first
// violation, or null if clean. (RNImage under RNText is allowed — inline images.)
function viewUnderTextJson(n: unknown, underText = false, path: string[] = []): string[] | null {
  if (n == null || typeof n === "string") return null;
  if (Array.isArray(n)) {
    for (const c of n) {
      const hit = viewUnderTextJson(c, underText, path);
      if (hit) return hit;
    }
    return null;
  }
  const node = n as { type?: unknown; children?: unknown };
  const type = String(node.type);
  const here = [...path, type];
  if (underText && (type === "RNView" || type === "RNScrollView")) return here;
  return viewUnderTextJson(node.children, underText || type === "RNText", here);
}

// Force the keyed path on a block (it gates on `open`), render it, and return the
// react-test-renderer JSON tree.
function keyedRenderJson(block: WireBlock): unknown {
  const tree = keyedRenderer({ ...block, open: true } as unknown as Block, comps);
  expect(tree).not.toBeNull();
  return renderJson(tree);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let Ctor: any;
let closed: Record<string, WireBlock> = {};

const KEYED_DOC = [
  "- a **one** item",
  "- b `two` item",
  "- c [three](https://example.com/3)",
  "",
  "1. first ordered",
  "2. second ordered",
  "",
  "| Name | Value |",
  "| :--- | ----: |",
  "| alpha | 1 |",
  "| beta | 2 |",
  "",
  "> a quoted line",
  "> another quoted line",
  "",
  "> [!TIP]",
  "> a tip body with **bold**",
  "",
].join("\n");

const KEYED_CONFIG = { blockData: true, gfmAlerts: true, gfmAutolinks: true };

// A fixture that exercises the tricky RN-nesting cases through the KEYED path:
// a list with a NESTED sub-list (li → ul), a LOOSE list item (li → <p>), a table
// with INLINE FORMATTING in cells, a blockquote, and an alert containing BOTH a
// list AND a code fence.
const INVARIANT_DOC = [
  "- top item with **bold**",
  "- parent item",
  "    - nested child a",
  "    - nested child b",
  "",
  "1. loose item one",
  "",
  "   a loose paragraph inside the item",
  "",
  "| Name | Detail |",
  "| :--- | ----: |",
  "| **bold** name | a `code` cell |",
  "| [link](https://e.com) | plain |",
  "",
  "> quoted **text** here",
  "> second line",
  "",
  "> [!NOTE]",
  "> alert intro",
  ">",
  "> - alert list item",
  "> - another",
  ">",
  "> ```js",
  "> const x = 1;",
  "> ```",
  "",
].join("\n");

let invBlocks: WireBlock[] = [];

beforeAll(async () => {
  if (!haveWasm) {
    // eslint-disable-next-line no-console
    console.warn("[brookmd-react-native] brookmd WASM not built — skipping keyed-render tests.");
    return;
  }
  Ctor = await loadWasm();
  const blocks = oneShot(Ctor, KEYED_DOC, KEYED_CONFIG);
  closed = {};
  for (const b of blocks) if (!closed[b.kind.type]) closed[b.kind.type] = b;
  invBlocks = oneShot(Ctor, INVARIANT_DOC, KEYED_CONFIG);
});

describe("keyed vs whole-html equivalence (closed blocks)", () => {
  test("the keyed dispatcher survives the {...defaults, ...overrides} merge", () => {
    // BrookMarkdown builds `{ ...createComponents(...), ...props.components }`; the
    // symbol-keyed dispatcher must carry through so the keyed path still fires.
    const merged = { ...comps, code: () => null } as unknown as Record<symbol, unknown>;
    expect(typeof merged[RENDER_OPEN_BLOCK]).toBe("function");
  });

  for (const kind of ["List", "Table", "Blockquote", "Alert"]) {
    test.skipIf(!haveWasm)(`${kind}: keyed path is structurally identical to whole-html`, () => {
      const block = closed[kind];
      expect(block).toBeDefined();
      // Force the keyed path on the closed block (it gates on open); its output
      // must match the whole-html render of the same block.
      const openCopy = { ...block, open: true } as unknown as Block;
      const keyedTree = keyedRenderer(openCopy, comps);
      expect(keyedTree).not.toBeNull();
      const keyedJson = norm(renderJson(keyedTree));
      const wholeJson = norm(renderJson(htmlToReact(block.html, comps) as ReactNode));
      expect(keyedJson).toEqual(wholeJson);
    });
  }
});

// The no-View-under-Text invariant is our device-crash tripwire; assert it
// DIRECTLY over the KEYED render paths (not just the whole-html path in
// renderer.test.tsx), across the RN-nesting cases most likely to misnest.
describe("keyed render paths satisfy the no-View-under-Text invariant", () => {
  test.skipIf(!haveWasm)("a nested list (li containing ul) — keyed", () => {
    const nested = invBlocks.find(
      (b) =>
        b.kind.type === "List" &&
        ((b.kind.data as { items?: { html: string }[] }).items ?? []).some((it) => it.html.includes("<ul")),
    );
    expect(nested).toBeDefined();
    expect(viewUnderTextJson(keyedRenderJson(nested!))).toBeNull();
  });

  test.skipIf(!haveWasm)("a loose list item (li containing <p>) — keyed", () => {
    const loose = invBlocks.find(
      (b) =>
        b.kind.type === "List" &&
        ((b.kind.data as { items?: { html: string }[] }).items ?? []).some((it) => it.html.includes("<p>")),
    );
    expect(loose).toBeDefined();
    expect(viewUnderTextJson(keyedRenderJson(loose!))).toBeNull();
  });

  test.skipIf(!haveWasm)("a table with inline-formatted cells — keyed", () => {
    const table = invBlocks.find((b) => b.kind.type === "Table");
    expect(table).toBeDefined();
    // The cells really do carry inline markup (bold / code / link).
    const cellHtml = ((table!.kind.data as { rows?: { html: string }[][] }).rows ?? []).flat().map((c) => c.html);
    expect(cellHtml.some((h) => /<strong>|<code>|<a /.test(h))).toBe(true);
    expect(viewUnderTextJson(keyedRenderJson(table!))).toBeNull();
  });

  test.skipIf(!haveWasm)("an alert containing a list and a code fence — keyed", () => {
    const alert = invBlocks.find((b) => b.kind.type === "Alert");
    expect(alert).toBeDefined();
    const nested = ((alert!.kind.data as { nested?: { html: string }[] }).nested ?? []).map((n) => n.html);
    expect(nested.some((h) => h.startsWith("<ul"))).toBe(true); // a list
    expect(nested.some((h) => h.startsWith("<pre"))).toBe(true); // a code fence
    expect(viewUnderTextJson(keyedRenderJson(alert!))).toBeNull();
  });

  test.skipIf(!haveWasm)("a blockquote — keyed", () => {
    const quote = invBlocks.find((b) => b.kind.type === "Blockquote");
    expect(quote).toBeDefined();
    expect(viewUnderTextJson(keyedRenderJson(quote!))).toBeNull();
  });

  test.skipIf(!haveWasm)("every keyed OPEN List/Table/Blockquote/Alert in the fixture is clean", () => {
    const keyedKinds = new Set(["List", "Table", "Blockquote", "Alert"]);
    const covered = invBlocks.filter((b) => keyedKinds.has(b.kind.type));
    expect(covered.length).toBeGreaterThanOrEqual(4);
    for (const b of covered) {
      expect(viewUnderTextJson(keyedRenderJson(b))).toBeNull();
    }
  });
});

// --- WORK BOUND -------------------------------------------------------------
// The real BlockView dispatch, as a stable component: keyed path for an open
// block with data, else whole-html.
function KeyedBlock({ block }: { block: WireBlock }): ReactNode {
  const tree =
    block.open && typeof keyedRenderer === "function" ? keyedRenderer(block as unknown as Block, comps) : null;
  return tree ?? (htmlToReact(block.html, comps) as ReactNode);
}
// The regression foil: re-tokenize EVERY item on every patch (no per-item memo).
// This is what the keyed path degrades to if the memo/keying is broken.
function NaiveAllItems({ block }: { block: WireBlock }): ReactNode {
  const items = (block.kind.data as { items?: { html: string }[] } | undefined)?.items ?? [];
  return createElement(
    Fragment,
    null,
    ...items.map((it, i) => createElement(Fragment, { key: i }, htmlToReact(it.html, comps) as ReactNode)),
  );
}

function countParses(states: WireBlock[], Comp: (p: { block: WireBlock }) => ReactNode): number {
  resetParseCount();
  let root: TestRenderer.ReactTestRenderer;
  act(() => {
    root = TestRenderer.create(createElement(Comp, { block: states[0] }));
  });
  for (let i = 1; i < states.length; i++) {
    act(() => root.update(createElement(Comp, { block: states[i] })));
  }
  act(() => root.unmount());
  return getParseCount();
}

describe("keyed list re-tokenizes O(items), not O(patches × items)", () => {
  test.skipIf(!haveWasm)("memoized keyed path stays far under the naive re-parse-all path", () => {
    const listMd = Array.from({ length: 50 }, (_, i) => `- item ${i} with a \`token\` and **bold** text`).join("\n") + "\n";
    const states = parseStates(Ctor, listMd, 48, KEYED_CONFIG)
      .map((bs) => bs.find((b) => b.kind.type === "List"))
      .filter((b): b is WireBlock => !!b);
    const items = (states[states.length - 1].kind.data as { items?: unknown[] }).items?.length ?? 0;
    expect(items).toBe(50);
    expect(states.length).toBeGreaterThan(20); // enough patches for the O(n²) foil to bite

    const keyedParses = countParses(states, KeyedBlock);
    const naiveParses = countParses(states, NaiveAllItems);

    // Working memo: each item tokenizes ~once (measured ≈ 2×items). Comfortable
    // bounds — the naive path (O(patches × items)) blows past every one of them.
    expect(keyedParses).toBeLessThan(3 * items); // ≈92 < 150
    expect(naiveParses).toBeGreaterThan(6 * items); // ≈1236 > 300
    expect(keyedParses * 3).toBeLessThan(naiveParses); // wide separation, not brittle
  });
});

describe("dev unstable-prop warning", () => {
  test("warns once when the `theme` prop changes identity across renders", () => {
    const FM = makeBrookMarkdown({ primitives: hostPrimitives, useColorScheme: () => "light" });
    // Empty store; no client acquisition, no native module. getSnapshot MUST
    // return a STABLE reference (a fresh [] each call would loop useSyncExternalStore).
    const EMPTY: never[] = [];
    const fakeClient = { subscribe: () => () => {}, getSnapshot: () => EMPTY } as unknown as BrookClient;
    __resetUnstableWarnings();
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => warnings.push(a.map(String).join(" "));
    try {
      let root: TestRenderer.ReactTestRenderer;
      // A fresh `{}` theme object each render is the footgun the warning catches.
      act(() => {
        root = TestRenderer.create(createElement(FM, { client: fakeClient, theme: {} }));
      });
      act(() => root.update(createElement(FM, { client: fakeClient, theme: {} })));
      act(() => root.unmount());
    } finally {
      console.warn = orig;
    }
    expect(warnings.some((w) => w.includes("theme") && w.includes("changed identity"))).toBe(true);
  });
});
