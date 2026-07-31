import { test, expect, beforeAll } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { spliceHtml, __resetSpliceStats, __spliceStats } from "../src/splice";

/**
 * Unit coverage for `spliceHtml`'s PRECONDITIONS.
 *
 * The parity fuzz proves the splice agrees with a full rebuild on everything the
 * real parser actually emits — but by construction it can only reach shapes that
 * occur. These guards exist for shapes that must never be attempted, several of
 * which happy-dom cannot even model (it is not a spec HTML parser: no foster
 * parenting, no `<pre>` leading-newline drop). Those are guards against REAL
 * browsers, so they are pinned here directly rather than left to the fuzz.
 */

beforeAll(() => {
  const win = new GlobalWindow();
  const g = globalThis as Record<string, unknown>;
  g.document = win.document;
  g.HTMLElement = win.HTMLElement;
  g.Element = win.Element;
  g.Node = win.Node;
});

function host(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

/**
 * The splice offset the WIRE would hand over. Not simply the longest common
 * prefix: the core aligns `keep_units` to a structural boundary, so back the raw
 * LCP off to the tag start it lands in. (A mid-tag offset is refused outright —
 * see the malformed-suffix test — which is also what happens in production when
 * the delta lands inside a rewritten attribute.)
 */
function lcp(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  if (i >= a.length) return i;
  let k = i;
  while (k > 0 && a.charCodeAt(k) !== 60 /* '<' */) k--;
  // Only back off INTO a tag; a boundary already in text stays where it is.
  return a.indexOf(">", k) >= i ? k : i;
}

function splice(prev: string, next: string): { ok: boolean; html: string } {
  const el = host(prev);
  const ok = spliceHtml(el, prev, next, lcp(prev, next));
  return { ok, html: el.innerHTML };
}

// --------------------------------------------------------------------------
// Shapes it must handle
// --------------------------------------------------------------------------

test("splices a growing paragraph without touching the text before the boundary", () => {
  const el = host("<p>hello</p>");
  const before = el.firstElementChild!.firstChild; // the "hello" text node
  expect(spliceHtml(el, "<p>hello</p>", "<p>hello world</p>", 8)).toBe(true);
  expect(el.innerHTML).toBe("<p>hello world</p>");
  // The node that carried the kept bytes is the SAME object — that is what a
  // text selection (and a <pre>'s scroll offset) rides on.
  expect(el.firstElementChild!.firstChild).toBe(before);
});

test("splices through structural whitespace between close tags", () => {
  const r = splice("<ul>\n<li>one</li>\n</ul>", "<ul>\n<li>one</li>\n<li>two</li>\n</ul>");
  expect(r.ok).toBe(true);
  expect(r.html).toBe("<ul>\n<li>one</li>\n<li>two</li>\n</ul>");
});

test("an append that CLOSES an element and opens a sibling lands at the right depth", () => {
  // The case `insertAdjacentHTML` on the innermost node gets wrong: it would
  // bury the new `<p>` inside the old one. The scaffold parse is what fixes it.
  const r = splice(
    "<blockquote>\n<p>one</p>\n</blockquote>",
    "<blockquote>\n<p>one</p>\n<p>two</p>\n</blockquote>",
  );
  expect(r.ok).toBe(true);
  expect(r.html).toBe("<blockquote>\n<p>one</p>\n<p>two</p>\n</blockquote>");
});

test("splices inside a nested inline element and continues after it", () => {
  const r = splice("<p>a<em>bc</em></p>", "<p>a<em>bcd</em> e</p>");
  expect(r.ok).toBe(true);
  expect(r.html).toBe("<p>a<em>bcd</em> e</p>");
});

test("splices a plain code body (a <pre> in the chain but not at the tip)", () => {
  const prev = '<pre><code class="language-ts">let a\n</code></pre>';
  const next = '<pre><code class="language-ts">let a\nlet b\n</code></pre>';
  const r = splice(prev, next);
  expect(r.ok).toBe(true);
  expect(r.html).toBe(next);
});

test("the spliced result equals a one-shot parse for every accepted case", () => {
  const cases: Array<[string, string]> = [
    ["<p>hello</p>", "<p>hello world</p>"],
    ["<ul>\n<li>a</li>\n</ul>", "<ul>\n<li>ab</li>\n</ul>"],
    ["<ul>\n<li>a</li>\n</ul>", "<ul>\n<li>a</li>\n<li>b</li>\n</ul>"],
    ["<blockquote>\n<p>x</p>\n</blockquote>", "<blockquote>\n<p>xy</p>\n</blockquote>"],
    ["<p>a<em>b</em></p>", "<p>a<em>bc</em></p>"],
    ["<p>a<strong>b</strong></p>", "<p>a<strong>b</strong> tail</p>"],
    ["<div><section><p>a</p></section></div>", "<div><section><p>a</p><p>b</p></section></div>"],
  ];
  for (const [prev, next] of cases) {
    const r = splice(prev, next);
    expect(`${prev} -> ${next}: ok=${r.ok}`).toBe(`${prev} -> ${next}: ok=true`);
    expect(`${prev} -> ${next}: ${r.html}`).toBe(`${prev} -> ${next}: ${host(next).innerHTML}`);
  }
});

// --------------------------------------------------------------------------
// Preconditions it must REFUSE (and refuse without mutating anything)
// --------------------------------------------------------------------------

function refuses(prev: string, next: string, keep: number): void {
  const el = host(prev);
  const before = el.innerHTML;
  expect(spliceHtml(el, prev, next, keep)).toBe(false);
  expect(el.innerHTML).toBe(before); // a refusal must change NOTHING
}

test("refuses a pure suffix append (no structural tail to verify the chain against)", () => {
  // keep === prev.length. The caller's own depth-0 append path owns this; here
  // there is no closing tag to prove where in the tree the append belongs.
  refuses("<p>a</p>", "<p>a</p><p>b</p>", "<p>a</p>".length);
});

test("refuses when the discarded suffix carried real content", () => {
  // `**b` was rendered as literal text and becomes <strong> — bytes the old DOM
  // already committed to are being rewritten, so the prefix is not reusable.
  const prev = "<p>a **b</p>";
  const next = "<p>a <strong>b</strong></p>";
  refuses(prev, next, lcp(prev, next));
});

test("refuses when the live chain does not match the closing tags", () => {
  // The live DOM says <div>, the tail claims a <p> was open at the boundary.
  const el = host("<div>a</div>");
  expect(spliceHtml(el, "<p>a</p>", "<p>ab</p>", 4)).toBe(false);
  expect(el.innerHTML).toBe("<div>a</div>");
});

test("refuses a table-context chain (foster parenting would relocate the append)", () => {
  const prev = "<table><tbody><tr><td>a</td></tr></tbody></table>";
  const next = "<table><tbody><tr><td>ab</td></tr></tbody></table>";
  refuses(prev, next, lcp(prev, next));
});

test("refuses <pre> as the insertion tip (its leading newline would be dropped)", () => {
  const prev = "<pre>a</pre>";
  const next = "<pre>a\nb</pre>";
  refuses(prev, next, lcp(prev, next));
});

test("refuses raw-text and foreign-content chains", () => {
  for (const tag of ["script", "style", "textarea", "template", "svg", "select"]) {
    const prev = `<div><${tag}>a</${tag}></div>`;
    const next = `<div><${tag}>ab</${tag}></div>`;
    const el = host(prev);
    expect(`${tag}: ${spliceHtml(el, prev, next, lcp(prev, next))}`).toBe(`${tag}: false`);
  }
});

test("refuses when the live DOM has drifted from the html it is told it holds", () => {
  // The caller's bookkeeping says the node holds `…</li>\n</ul>`, but the node
  // has no trailing newline text. Every mutation is gated behind checks like
  // this, so a desynced caller degrades to a rebuild rather than corrupting.
  const prev = "<ul>\n<li>a</li>\n</ul>";
  const next = "<ul>\n<li>ab</li>\n</ul>";
  const el = host("<ul><li>a</li></ul>"); // no newline text nodes
  const before = el.innerHTML;
  expect(spliceHtml(el, prev, next, lcp(prev, next))).toBe(false);
  expect(el.innerHTML).toBe(before);
});

test("refuses every shape where the live tree has drifted from `prevHtml`", () => {
  // Defence in depth. Given the documented precondition (`host.innerHTML` IS
  // `prevHtml`) these are unreachable — everything at an intermediate level
  // after the splice point is part of the discarded suffix by construction. They
  // exist so a caller whose bookkeeping has drifted degrades to a rebuild
  // instead of silently corrupting the tree, and they are pinned here because
  // no realistic stream can produce them.
  const prev = "<ul>\n<li>a</li>\n</ul>";
  const next = "<ul>\n<li>ab</li>\n</ul>";
  const drifted: Array<[string, string, string, number]> = [
    // The trailing text is LONGER than the suffix says: trimming it would leave
    // stray text after the `<li>`, with nowhere for the append to go.
    ["longer trailing text", "<ul>\n<li>a</li>zz\n</ul>", prev, 10],
    // No whitespace in the suffix, but the live level has trailing content.
    ["unaccounted trailing text", "<ul><li>a</li>tail</ul>", "<ul><li>a</li></ul>", 9],
    // The tip's text does not end with the whitespace the suffix claims.
    ["tip text lacks the suffix", "<ul><li>a</li></ul>", "<ul><li>a\n</li></ul>", 9],
    // An element where the suffix says a text node should be.
    ["element instead of text", "<ul><li>a</li><b></b></ul>", prev, 10],
  ];
  for (const [name, live, told, keep] of drifted) {
    const el = host(live);
    const before = el.innerHTML;
    expect(`${name}: ${spliceHtml(el, told, next, keep)}`).toBe(`${name}: false`);
    expect(`${name}: ${el.innerHTML}`).toBe(`${name}: ${before}`);
  }
});

test("refuses a malformed / non-tag suffix", () => {
  refuses("<p>a</p", "<p>ab</p>", 4); // unterminated close tag
  refuses("<p>a<!-- c --></p>", "<p>ab<!-- c --></p>", 4); // a comment is not structure
});

test("the attempt/hit counters track the calls above", () => {
  __resetSpliceStats();
  expect(__spliceStats()).toEqual({ attempts: 0, hits: 0 });
  const el = host("<p>a</p>");
  expect(spliceHtml(el, "<p>a</p>", "<p>ab</p>", 4)).toBe(true);
  expect(spliceHtml(el, "<p>ab</p>", "<p>ab</p><p>c</p>", "<p>ab</p>".length)).toBe(false);
  expect(__spliceStats()).toEqual({ attempts: 2, hits: 1 });
});
