// Renderer tests: run the REAL wire HTML (produced by the WASM parser) through
// the dependency-injected component map with FAKE primitives, and assert the
// RN-safety invariant — no bare HTML-tag string ever survives into the element
// tree; every element resolves to an injected primitive. Also spot-checks the
// key mappings (links, code, lists, tables, alerts, task lists, math).
import { beforeAll, describe, expect, test } from "bun:test";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { htmlToReact } from "flux-md/html-to-react";
import { createComponents, type RnPrimitives } from "../src/components";
import { resolveTheme } from "../src/theme";
import { haveWasm, loadWasm, oneShot, RICH_CONFIG, RICH_DOC, type WireBlock } from "./fixtures";

// A fake RN primitive: a named, tagged function component. `rnName` lets the test
// renderer recognize it as a leaf and read which primitive it maps to.
const openedUrls: string[] = [];
function prim(name: string) {
  const C = (p: { children?: ReactNode }) => p.children ?? null;
  (C as unknown as { rnName: string }).rnName = name;
  return C;
}
const fakePrimitives: RnPrimitives = {
  Text: prim("Text"),
  View: prim("View"),
  ScrollView: prim("ScrollView"),
  Image: prim("Image"),
  Pressable: prim("Pressable"),
  Linking: { openURL: (u: string) => (openedUrls.push(u), Promise.resolve()) },
  StyleSheet: { create: <T extends Record<string, object>>(s: T) => s, hairlineWidth: 1 },
};

const comps = createComponents(fakePrimitives, resolveTheme("light"));

// A minimal, hook-free renderer: our wrappers are pure, so invoking them yields
// their primitive subtree. It THROWS if any element type is a raw HTML tag
// string — that is the RN-safety invariant, asserted structurally.
interface RnNode {
  rn: string;
  props: Record<string, unknown>;
  children: unknown[];
}
function toRN(node: ReactNode): unknown {
  if (node == null || typeof node === "boolean") return null;
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(toRN).filter((x) => x != null);
  if (isValidElement(node)) {
    const el = node as ReactElement;
    const t = el.type as unknown;
    const props = (el.props ?? {}) as Record<string, unknown>;
    if (typeof t === "function") {
      const rnName = (t as { rnName?: string }).rnName;
      if (rnName)
        return { rn: rnName, props, children: [toRN(props.children as ReactNode)].filter((x) => x != null) } as RnNode;
      // Our wrapper: invoke to descend into the primitive it renders.
      return toRN((t as (p: unknown) => ReactNode)(props));
    }
    if (typeof t === "string") {
      throw new Error(`RN-safety violation: bare HTML tag <${t}> leaked into the tree`);
    }
    // Fragment / symbol type: descend into children.
    return toRN(props.children as ReactNode);
  }
  return null;
}

function flatten(n: unknown, out: RnNode[] = []): RnNode[] {
  if (n == null) return out;
  if (Array.isArray(n)) {
    for (const c of n) flatten(c, out);
    return out;
  }
  if (typeof n === "object" && "rn" in (n as RnNode)) {
    const node = n as RnNode;
    out.push(node);
    flatten(node.children, out);
  }
  return out;
}

function allText(n: unknown): string {
  if (typeof n === "string") return n;
  if (Array.isArray(n)) return n.map(allText).join("");
  if (n && typeof n === "object" && "children" in (n as RnNode)) return allText((n as RnNode).children);
  return "";
}

// The core RN nesting invariant: a block-level view primitive (View/ScrollView)
// must NEVER sit beneath a <Text> ancestor. Returns the path to the first
// violation, or null if the tree is clean. (Image under Text is allowed — RN
// supports inline images — so it is not treated as a block view here.)
function viewUnderText(n: unknown, underText = false, path: string[] = []): string[] | null {
  if (Array.isArray(n)) {
    for (const c of n) {
      const hit = viewUnderText(c, underText, path);
      if (hit) return hit;
    }
    return null;
  }
  if (n && typeof n === "object" && "rn" in (n as RnNode)) {
    const node = n as RnNode;
    const here = [...path, node.rn];
    if (underText && (node.rn === "View" || node.rn === "ScrollView")) return here;
    return viewUnderText(node.children, underText || node.rn === "Text", here);
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let Ctor: any;
let blocks: WireBlock[] = [];

beforeAll(async () => {
  if (!haveWasm) {
    // eslint-disable-next-line no-console
    console.warn("[flux-md-react-native] flux-md WASM not built — skipping wire-driven renderer tests.");
    return;
  }
  Ctor = await loadWasm();
  blocks = oneShot(Ctor, RICH_DOC, RICH_CONFIG);
});

describe("RN component map (unit, no WASM)", () => {
  test("an active link renders a pressable Text that opens the URL", () => {
    openedUrls.length = 0;
    const el = (comps.a as (p: unknown) => ReactElement)({ href: "https://example.com/report", children: "Report" });
    const rn = toRN(el) as RnNode;
    expect(rn.rn).toBe("Text");
    expect(typeof rn.props.onPress).toBe("function");
    (rn.props.onPress as () => void)();
    expect(openedUrls).toContain("https://example.com/report");
  });

  test("a data-flux-pending link is subdued and NOT pressable", () => {
    const el = (comps.a as (p: unknown) => ReactElement)({ "data-flux-pending": "", children: "pending" });
    const rn = toRN(el) as RnNode;
    expect(rn.rn).toBe("Text");
    expect(rn.props.onPress).toBeUndefined();
  });

  test("a dangerous-scheme href never opens", () => {
    openedUrls.length = 0;
    // htmlToReact already neutralizes this to '#'; a hand-built href is re-guarded.
    const el = (comps.a as (p: unknown) => ReactElement)({ href: "javascript:alert(1)", children: "x" });
    const rn = toRN(el) as RnNode;
    (rn.props.onPress as (() => void) | undefined)?.();
    expect(openedUrls).toHaveLength(0);
  });

  test("a fenced code block renders a horizontal ScrollView of mono Text", () => {
    const html = '<pre><code class="language-ts" data-lang="ts">const x = 1;\n</code></pre>';
    const rn = toRN(htmlToReact(html, comps));
    const nodes = flatten(rn);
    expect(nodes.some((n) => n.rn === "ScrollView")).toBe(true);
    expect(nodes.some((n) => n.rn === "Text")).toBe(true);
    expect(allText(rn)).toContain("const x = 1;");
  });

  test("a task-list checkbox renders a glyph, not an <input>", () => {
    const html = '<ul>\n<li><input type="checkbox" checked disabled> done</li>\n</ul>';
    const rn = toRN(htmlToReact(html, comps));
    const text = allText(rn);
    expect(text).toContain("☑");
    expect(text).toContain("done");
  });

  test("a GitHub alert renders a tinted View card", () => {
    const html =
      '<div class="markdown-alert markdown-alert-note" data-alert="note"><p class="markdown-alert-title">Note</p>\n<p>Body.</p></div>';
    const rn = toRN(htmlToReact(html, comps)) as RnNode;
    expect(rn.rn).toBe("View");
    expect(allText(rn)).toContain("Body.");
  });

  test("display math renders as centered mono Text", () => {
    const html = '<div class="math math-display">E = mc^2</div>';
    const rn = toRN(htmlToReact(html, comps)) as RnNode;
    expect(rn.rn).toBe("Text");
    expect(allText(rn)).toContain("E = mc^2");
  });
});

describe("list item block/inline partitioning (RN nesting rules)", () => {
  test("a nested <ul> inside an <li> renders OUTSIDE any Text ancestor", () => {
    const html = "<ul>\n<li>parent text\n<ul>\n<li>child</li>\n</ul>\n</li>\n</ul>";
    const rn = toRN(htmlToReact(html, comps));
    // The whole subtree is clean: no View/ScrollView beneath a Text.
    expect(viewUnderText(rn)).toBeNull();
    // And the nested list really did render (as a View), plus both texts survive.
    const nodes = flatten(rn);
    expect(nodes.filter((n) => n.rn === "View").length).toBeGreaterThan(1);
    expect(allText(rn)).toContain("parent text");
    expect(allText(rn)).toContain("child");
  });

  test("an <li> of plain text still renders its text inside a Text", () => {
    const html = "<ul>\n<li>just words</li>\n</ul>";
    const rn = toRN(htmlToReact(html, comps));
    const nodes = flatten(rn);
    // Some Text node carries the words (the inline run), and nothing is misnested.
    expect(nodes.some((n) => n.rn === "Text" && allText(n).includes("just words"))).toBe(true);
    expect(viewUnderText(rn)).toBeNull();
  });

  test("a loose <li><p>x</p><ul>…</ul></li> produces no Text-wrapping-View", () => {
    const html = "<ul>\n<li>\n<p>lead</p>\n<ul>\n<li>sub</li>\n</ul>\n</li>\n</ul>";
    const rn = toRN(htmlToReact(html, comps));
    expect(viewUnderText(rn)).toBeNull();
    expect(allText(rn)).toContain("lead");
    expect(allText(rn)).toContain("sub");
  });

  test("a hand-fed <pre>text</pre> wraps its bare string in mono Text (no crash)", () => {
    const rn = toRN(htmlToReact("<pre>raw code</pre>", comps)) as RnNode;
    expect(rn.rn).toBe("ScrollView");
    // The bare string is wrapped, not dropped, and not left directly under the view.
    expect(allText(rn)).toContain("raw code");
    expect(viewUnderText(rn)).toBeNull();
    const nodes = flatten(rn);
    expect(nodes.some((n) => n.rn === "Text")).toBe(true);
  });
});

describe("RN-safety over real wire HTML", () => {
  test.skipIf(!haveWasm)("every emitted tag is mapped to a primitive component", () => {
    const tags = new Set<string>();
    for (const b of blocks) {
      for (const m of b.html.matchAll(/<([a-z][a-z0-9]*)/g)) tags.add(m[1].toLowerCase());
    }
    // Sanity: the rich doc really did emit a broad tag set.
    expect(tags.size).toBeGreaterThan(8);
    const missing = [...tags].filter((t) => !(t in comps));
    expect(missing).toEqual([]);
  });

  test.skipIf(!haveWasm)("no block's rendered tree contains a bare HTML-tag element type", () => {
    for (const b of blocks) {
      // toRN throws on a bare string element type — a clean run IS the assertion.
      expect(() => toRN(htmlToReact(b.html, comps))).not.toThrow();
    }
  });

  test.skipIf(!haveWasm)("no block ever nests a View primitive beneath a Text primitive", () => {
    for (const b of blocks) {
      const hit = viewUnderText(toRN(htmlToReact(b.html, comps)));
      // A non-null hit is the path to the offending View, e.g. ["Text","View"].
      expect(hit).toBeNull();
    }
  });

  test.skipIf(!haveWasm)("a heading block resolves to a Text root", () => {
    const h = blocks.find((b) => b.kind.type === "Heading");
    expect(h).toBeDefined();
    const rn = toRN(htmlToReact(h!.html, comps)) as RnNode;
    expect(rn.rn).toBe("Text");
    expect(allText(rn)).toContain("Streaming Markdown");
  });

  test.skipIf(!haveWasm)("a table block resolves to a scrollable View grid", () => {
    const t = blocks.find((b) => b.kind.type === "Table");
    expect(t).toBeDefined();
    const rn = toRN(htmlToReact(t!.html, comps));
    const nodes = flatten(rn);
    expect(nodes.some((n) => n.rn === "ScrollView")).toBe(true);
    expect(nodes.filter((n) => n.rn === "View").length).toBeGreaterThan(0);
    expect(allText(rn)).toContain("Name");
  });
});
