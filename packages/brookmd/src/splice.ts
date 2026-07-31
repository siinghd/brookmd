/**
 * Incremental DOM application for a streaming block — the two shapes of
 * "apply this patch without rewriting everything before it".
 *
 * 1. {@link paintIncCode} mirrors hi-inc's frozen-prefix / speculative-tail split
 *    into an open code fence's live `<code>`.
 * 2. {@link spliceHtml} applies the wire's `html_delta` to a generic block's
 *    subtree, guided by {@link spliceKeep}.
 *
 * Both are shared by the DOM and React renderers so the invariants below have
 * exactly one implementation.
 *
 * ## The generic splice
 *
 * A streaming block's html grows at its END: the core appends bytes and then
 * SPECULATIVELY CLOSES whatever is open, so patch N's html is patch N+1's html
 * with a different run of closing tags stitched on. The wire already computes
 * and verifies that boundary (`html_delta.keep_units`, WIRE.md §11), and
 * `applyPatch` publishes it to renderers as {@link spliceKeep}. What is left is
 * to apply it to the DOM without re-parsing everything before it.
 *
 * ## Why "top-level children" is not enough
 *
 * A block's html is usually ONE top-level element — `<p>…</p>`, `<ul>…</ul>`,
 * `<blockquote>…</blockquote>` — so splicing at that level degenerates to a full
 * rebuild. The growth point is at the bottom of the chain of elements still OPEN
 * at the splice offset, and that is where this splices: it walks down that chain
 * in the live DOM, appends the new markup in the right context, and never
 * touches a node before the boundary. Everything earlier — including a user's
 * text selection and a `<pre>`'s scroll offset — survives untouched.
 *
 * ## The precondition, and why it is the honest one
 *
 * The old html's discarded suffix (`prevHtml.slice(keep)`) must be **pure
 * structure**: closing tags and inter-tag whitespace, nothing that contributed
 * real content. That is exactly the speculative-closure shape, and it is what
 * makes "the DOM built from `prevHtml[0, keep)`" recoverable from the live tree
 * by removing a bounded amount of trailing whitespace. Anything else — a link
 * losing its `data-brook-pending` attribute, a literal `**b` becoming
 * `<strong>b</strong>` — rewrites bytes the old DOM already committed to, and
 * this bails so the caller rebuilds. Correctness never depends on the fast path
 * firing; every check below returns `false` rather than guessing.
 *
 * The result is byte-identical to `host.innerHTML = nextHtml` when serialized.
 * The node COUNT can differ (a splice may leave two adjacent text nodes where a
 * one-shot parse makes one), which is what any streaming DOM append does and
 * what `innerHTML` parity is checked against.
 */

import type { IncState } from "./hi-inc";
import type { Block } from "./types-core";

// --------------------------------------------------------------------------
// The wire splice, published from applyPatch to the renderers
// --------------------------------------------------------------------------

/**
 * The splice each reconstructed active Block was built from, keyed by the Block
 * object itself. Lives here rather than in client.ts so a renderer can read it
 * without pulling the client (and with it the Worker construction in
 * asset-urls) into its module graph.
 */
const SPLICE = new WeakMap<Block, { prev: Block; keep: number }>();

/**
 * How many links of splice history stay reachable. A renderer that coalesces to
 * one frame can be several patches behind the store, so a single step is not
 * enough — but each link pins the previous Block (and its full `html`) alive, so
 * the chain is CUT at this depth on every apply. Without the cut, one active
 * block would retain every version of itself for the length of the stream.
 */
const SPLICE_DEPTH = 8;

/** @internal Called by `applyPatch` for every delta-reconstructed active block. */
export function noteSplice(next: Block, prev: Block, keep: number): void {
  let old: Block | undefined = prev;
  for (let d = 1; d < SPLICE_DEPTH && old !== undefined; d++) old = SPLICE.get(old)?.prev;
  if (old !== undefined) SPLICE.delete(old);
  SPLICE.set(next, { prev, keep });
}

/**
 * The longest common prefix, in UTF-16 units, that `from.html` and `to.html`
 * provably share — or `undefined` when the wire did not establish one (delta
 * mode off, a full re-emit, or `from` is further back than {@link SPLICE_DEPTH}).
 *
 * The value is the MINIMUM `keep_units` across the patches between them: each
 * one guarantees its own prefix, so their minimum is a prefix of all of them.
 * That is conservative — it can be shorter than the true common prefix — and
 * never wrong, which is the right side to err on when a caller splices at it.
 *
 * @internal Renderer-only; not part of the public API.
 */
export function spliceKeep(from: Block, to: Block): number | undefined {
  let keep = Infinity;
  let cur = to;
  for (let i = 0; i < SPLICE_DEPTH; i++) {
    const link = SPLICE.get(cur);
    if (link === undefined) return undefined;
    if (link.keep < keep) keep = link.keep;
    if (link.prev === from) return keep;
    cur = link.prev;
  }
  return undefined;
}

// --------------------------------------------------------------------------
// The open code block's frozen/tail DOM mirror
// --------------------------------------------------------------------------

/**
 * The live `<code>` of an OPEN code block, split the way hi-inc splits its
 * markup: a **frozen** run of children (proven immutable — appended once and
 * never touched again) followed by a **speculative tail** (rewritten per patch,
 * bounded by hi-inc's CAP).
 *
 * The two regions are NOT wrapped in elements — `frozenEnd` is simply the last
 * child that belongs to the frozen run — so the resulting `innerHTML` is
 * byte-identical to the `code.innerHTML = markup` this replaces. Only the node
 * *count* differs (a splice can leave two adjacent text nodes where a one-shot
 * parse would have made one), which serializes the same and is exactly what a
 * browser does for any streamed append.
 */
export interface IncCode {
  code: Element;
  /** The language the mirror was built for; a change invalidates it. */
  lang: string;
  /** Last child of the frozen run — everything after it is the tail. */
  frozenEnd: ChildNode | null;
  /** Chars of `IncState.frozenHtml` already mirrored into the DOM. */
  frozenLen: number;
  /** The `IncState.frozenRev` that `frozenLen` belongs to. */
  frozenRev: number;
  /** The boundary BEFORE `frozenEnd`, and the length that went with it — one
   *  step of history mirroring hi-inc's own `c0`/`frozenLen0`, which is exactly
   *  how far hi-inc's `adopt` can rewind. Without it a rewind would have to re-seed
   *  the whole run, and 18 of those over a 20 KB fence cost more than everything
   *  else on the streaming path combined. */
  frozenEnd0: ChildNode | null;
  frozenLen0: number;
  /** The tail markup currently in the DOM, so an unchanged tail is not rewritten. */
  tail: string;
}

/** A fresh, empty mirror for a `<code>` that has nothing painted into it yet. */
export function newIncCode(code: Element, lang: string, st: IncState): IncCode {
  return {
    code, lang, frozenEnd: null, frozenLen: 0, frozenRev: st.frozenRev,
    frozenEnd0: null, frozenLen0: 0, tail: "",
  };
}

/**
 * Mirror hi-inc's frozen/tail split into a live `<code>`: append whatever the
 * frozen prefix settled since the last patch, then replace the speculative
 * tail. Returns false when the mirror cannot be trusted (see the length
 * invariant below) so the caller falls back to a full node rebuild.
 *
 * Cost per patch is |newly frozen| + |tail|. The frozen term sums, across the
 * whole stream, to one pass over the final markup; the tail is bounded by
 * hi-inc's CAP. That is what makes an open fence linear at the DOM, not just
 * at the tokenizer.
 */
export function paintIncCode(ic: IncCode, st: IncState, markup: string): boolean {
  const frozen = st.frozenHtml;
  // INVARIANT (hi-inc): every markup it hands back is `frozenHtml + tail`.
  // A shorter string would mean the two have come apart — bail rather than
  // slice a negative tail out of it.
  if (markup.length < frozen.length) return false;
  // A rewind (adopt's one checkpoint of backtrack, or a restart) rewrote the
  // frozen prefix, so the mirror's append-only assumption no longer holds and
  // the whole run is re-seeded. Rare by construction; `frozenRev` is what makes
  // it detectable in O(1) — a length compare alone would miss a rewind that
  // re-froze past the old length within the same call.
  let rewound = ic.frozenRev !== st.frozenRev || frozen.length < ic.frozenLen;
  const tail = markup.slice(frozen.length);
  if (!rewound && frozen.length === ic.frozenLen && tail === ic.tail) return true;
  if (rewound && st.frozenRev === ic.frozenRev + 1 && st.frozenCut === ic.frozenLen0) {
    // hi-inc cut back to exactly the checkpoint we still hold a boundary node
    // for, so the mirror rewinds with it instead of re-seeding. This is the
    // common rewind — `adopt` backtracks one checkpoint and `rescan`
    // immediately re-freezes past it, which is why `frozenCut` (not the
    // observable length, which comes back unchanged) is what we test.
    ic.frozenEnd = ic.frozenEnd0;
    ic.frozenLen = ic.frozenLen0;
    ic.frozenRev = st.frozenRev;
    ic.frozenEnd0 = null;
    ic.frozenLen0 = 0;
    rewound = false;
  }
  // Drop the previous tail (and the frozen run too when re-seeding). The tail
  // is CAP-bounded, so this is O(1) in the block's size.
  const keep = rewound ? null : ic.frozenEnd;
  while (ic.code.lastChild !== keep) ic.code.removeChild(ic.code.lastChild!);
  if (rewound) {
    ic.frozenEnd = null;
    ic.frozenLen = 0;
    ic.frozenEnd0 = null;
    ic.frozenLen0 = 0;
    ic.frozenRev = st.frozenRev;
  }
  if (frozen.length > ic.frozenLen) {
    ic.frozenEnd0 = ic.frozenEnd;
    ic.frozenLen0 = ic.frozenLen;
    ic.code.insertAdjacentHTML("beforeend", frozen.slice(ic.frozenLen));
    ic.frozenEnd = ic.code.lastChild;
    ic.frozenLen = frozen.length;
  }
  if (tail) ic.code.insertAdjacentHTML("beforeend", tail);
  ic.tail = tail;
  return true;
}

// --------------------------------------------------------------------------
// The generic delta-driven child splice
// --------------------------------------------------------------------------

/** Tag names whose parsing context this splice must not reproduce by hand. */
const UNSAFE_CHAIN = new Set([
  // Content models the fragment parser treats specially (raw text, escapable
  // raw text, foreign content, or a separate document fragment).
  "template", "svg", "math", "script", "style", "textarea", "title",
  "noscript", "noframes", "iframe", "xmp", "plaintext", "listing",
  // Foster parenting relocates non-table content out of these, so a scaffold
  // parse would not place the appended nodes where a whole parse does.
  "table", "thead", "tbody", "tfoot", "tr", "select", "optgroup",
]);

/** …and the ones that may not be the INSERTION POINT: the HTML parser drops a
 *  newline that immediately follows their start tag, so a scaffold ending in one
 *  can silently eat the first byte of the appended markup. Harmless deeper in
 *  the chain, where a descendant's start tag always intervenes. */
const UNSAFE_TIP = new Set(["pre", "listing", "textarea"]);

const CLOSE_TAG_NAME = /^[a-zA-Z][a-zA-Z0-9-]*$/;

/** One step of the discarded suffix: a close tag, or a run of whitespace. */
type TailOp = { close: string } | { ws: string };

/**
 * Tokenize `prevHtml.slice(keep)`. Returns `null` unless it is made up purely of
 * closing tags and whitespace — the speculative-closure shape.
 */
function scanTail(t: string): TailOp[] | null {
  const ops: TailOp[] = [];
  let i = 0;
  let closes = 0;
  while (i < t.length) {
    if (t.charCodeAt(i) === 60 /* '<' */) {
      if (t.charCodeAt(i + 1) !== 47 /* '/' */) return null;
      const gt = t.indexOf(">", i + 2);
      if (gt === -1) return null;
      const name = t.slice(i + 2, gt);
      if (!CLOSE_TAG_NAME.test(name)) return null;
      ops.push({ close: name.toLowerCase() });
      closes++;
      i = gt + 1;
      continue;
    }
    let j = i;
    while (j < t.length && t.charCodeAt(j) !== 60) j++;
    const run = t.slice(i, j);
    if (/\S/.test(run)) return null; // real text — the old DOM committed to it
    ops.push({ ws: run });
    i = j;
  }
  return closes > 0 ? ops : null;
}

/**
 * A trailing text node the discarded suffix contributed, queued for removal.
 * Collected and fully validated BEFORE anything is mutated, so a refusal leaves
 * the live tree byte-for-byte as it was.
 */
interface Strip {
  text: Text;
  /** Chars to drop off the end; the whole node when it equals its length. */
  ws: string;
}

/**
 * Apply `prevHtml → nextHtml` to `host`, whose `innerHTML` is exactly
 * `prevHtml`, given the wire-verified common-prefix length `keep`. Returns
 * `false` (having changed NOTHING) when the shape is not one it can prove; the
 * caller then rebuilds as it always did.
 */
export function spliceHtml(host: Element, prevHtml: string, nextHtml: string, keep: number): boolean {
  attempts++;
  // `keep === prevHtml.length` is a plain suffix append with no structural tail
  // to reason about — the caller's own depth-0 append path owns that case, and
  // without a tail there is nothing here to verify the chain against.
  if (keep <= 0 || keep >= prevHtml.length || keep > nextHtml.length) return false;
  const ops = scanTail(prevHtml.slice(keep));
  if (ops === null) return false;

  // Walk the live chain of elements still open at `keep`, innermost last. The
  // close tags name them innermost-FIRST, so the chain is read off in reverse.
  const closes: string[] = [];
  for (const op of ops) if ("close" in op) closes.push(op.close);
  const n = closes.length;
  const chain: Element[] = new Array(n + 1);
  chain[0] = host;
  for (let d = 1; d <= n; d++) {
    const want = closes[n - d];
    if (UNSAFE_CHAIN.has(want)) return false;
    if (d === n && UNSAFE_TIP.has(want)) return false;
    const el = chain[d - 1].lastElementChild;
    if (el === null || el.tagName.toLowerCase() !== want) return false;
    chain[d] = el;
  }

  // Work out — WITHOUT touching anything — which trailing whitespace the
  // discarded suffix contributed, and confirm that removing it leaves every
  // chain element as its parent's last child (which is what makes the appends
  // below land in document order). Depth starts at the tip and unwinds per
  // close tag; whitespace belongs to whatever level is current when it appears.
  const strips: Strip[] = [];
  const ws: Array<string | undefined> = new Array(n + 1);
  let d = n;
  for (const op of ops) {
    if ("close" in op) {
      d--;
      continue;
    }
    // Two runs at one depth is impossible (a close tag has to separate them),
    // so a second one means the suffix is not the shape we think it is.
    if (ws[d] !== undefined) return false;
    ws[d] = op.ws;
  }
  if (d !== 0) return false;
  for (let i = 0; i <= n; i++) {
    const w = ws[i];
    const last = chain[i].lastChild;
    if (w === undefined || w === "") {
      // Nothing to remove here, so the next chain element must already be last.
      if (i < n && last !== chain[i + 1]) return false;
      continue;
    }
    if (last === null || last.nodeType !== 3 /* TEXT_NODE */) return false;
    const data = last.nodeValue ?? "";
    if (i < n) {
      // An intermediate level: the whole text node has to go, and the next chain
      // element has to be immediately before it. A PARTIAL trim would leave
      // stray text after `chain[i + 1]`, which no append could then follow.
      if (data !== w || last.previousSibling !== chain[i + 1]) return false;
    } else if (!data.endsWith(w)) {
      return false;
    }
    strips.push({ text: last as Text, ws: w });
  }

  // Re-parse the appended markup in the SAME open-element context by scaffolding
  // the chain around it, then move the parsed nodes onto the live chain. The
  // scaffold is what makes an append that CLOSES elements ("…done</em> more")
  // land correctly — `insertAdjacentHTML` on the tip would bury it all inside
  // the innermost element instead.
  let scaffold = "";
  for (let i = 1; i <= n; i++) scaffold += `<${chain[i].tagName.toLowerCase()}>`;
  const tmp = host.ownerDocument.createElement("div");
  tmp.innerHTML = scaffold + nextHtml.slice(keep);
  const sc: Element[] = new Array(n + 1);
  sc[0] = tmp;
  for (let i = 1; i <= n; i++) {
    const el = sc[i - 1].firstChild as (ChildNode & Partial<Element>) | null;
    // The parser must have kept our scaffold verbatim; an implied element
    // (a `<tbody>` it inserted, a tag it relocated) means the context we
    // reconstructed is not the one the live DOM is in.
    if (el === null || el.nodeType !== 1 /* ELEMENT_NODE */) return false;
    const e = el as unknown as Element;
    if (e.tagName !== chain[i].tagName) return false;
    sc[i] = e;
  }

  // Everything is proven; from here on we mutate.
  for (const strip of strips) {
    const data = strip.text.nodeValue ?? "";
    if (data.length === strip.ws.length) strip.text.parentNode?.removeChild(strip.text);
    else strip.text.nodeValue = data.slice(0, data.length - strip.ws.length);
  }
  for (let i = n; i >= 0; i--) {
    let node: ChildNode | null = i === n ? sc[i].firstChild : sc[i + 1].nextSibling;
    while (node !== null) {
      const next: ChildNode | null = node.nextSibling;
      chain[i].appendChild(node);
      node = next;
    }
  }
  hits++;
  return true;
}

// How often the splice was tried and how often it proved out. Same pattern (and
// same negligible cost) as hi-inc's `__getIncScanned`: the fuzz asserts the fast
// path actually FIRES, so a change that quietly turns every patch back into a
// rebuild fails loudly instead of just getting slower.
let attempts = 0;
let hits = 0;
/** @internal Test-only. */
export function __spliceStats(): { attempts: number; hits: number } {
  return { attempts, hits };
}
/** @internal Test-only. */
export function __resetSpliceStats(): void {
  attempts = 0;
  hits = 0;
}
