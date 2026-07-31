import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { highlight } from "../hi";
import { highlightDeferred, highlightWithin } from "../hi-defer";
import { createInc, incHighlight, incSeed, type IncState } from "../hi-inc";
import { incView, newIncCode, paintIncCode, type IncCode, type TailMode } from "../splice";
import { useHtmlSplice } from "../react-splice";
import type { Block } from "../types-core";
import { extractLang } from "../block-props";

/**
 * Highlighting code block, incremental while open and settled on close.
 *
 * While the fence STREAMS, hi-inc.ts keeps a frozen prefix plus a speculative
 * tail, so each patch only re-tokenizes about a line of source instead of the
 * whole block. The tail's colours are provisional by nature (`"hello` is a stray
 * quote and an identifier until the closing quote lands) and are never frozen —
 * see hi-inc.ts for why the frozen part cannot be revised.
 *
 * The moment the parser commits the block (open=false) the tokenizer resumes
 * from that frozen prefix, so a fence that streamed in only has its tail left to
 * do. The settled markup is byte-identical to a one-shot `highlight()` either
 * way, and is memoized on html identity so a closed block never re-tokenizes.
 *
 * The close-time pass runs in BUDGETED SLICES (see hi-defer.ts). The first slice
 * runs during this render, so an ordinary block is highlighted in its very first
 * paint exactly as before; a big block gets the plain escaped body immediately
 * and swaps in its markup a few tasks later, instead of freezing the main
 * thread for the whole pass.
 *
 * The tail is painted as ONE TEXT NODE by default (`"wavefront"`): its colours
 * arrive at the checkpoint, a source line behind the head, and a patch costs the
 * browser a character-data write instead of a fresh span subtree. See splice.ts
 * for why that is the shape worth defaulting to; `streamingHighlight="eager"`
 * restores the coloured-per-patch tail.
 *
 * `streamingHighlight={false}` opts out of the open-block path only: open blocks
 * then render plain and close exactly as they did before it existed.
 */

// The body is located by INDEX rather than by matching
// `/<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/` — the same three landmarks, in
// the same order, taking the same first match, so the same bytes — and the
// entity passes run only when there is an entity to decode. That matters
// because this is the open fence's per-patch source (`openText` below): it runs
// once for every patch, over a body that keeps growing. On a streamed 32 KB
// fence the regex form and its five unconditional passes cost 295 ms, three
// times the highlighting they feed; this form costs 16 ms.
function decodeText(html: string): string {
  const open = html.indexOf("<pre><code");
  if (open < 0) return "";
  const start = html.indexOf(">", open + 10);
  if (start < 0) return "";
  const end = html.indexOf("</code></pre>", start + 1);
  if (end < 0) return "";
  const body = html.slice(start + 1, end);
  // amp last, so `&amp;lt;` decodes to `&lt;` and not to `<`.
  return body.indexOf("&") < 0
    ? body
    : body
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&");
}


/**
 * `useLayoutEffect` on the client, `useEffect` on the server.
 *
 * The layout timing is load-bearing on the client — a passive effect would show
 * one frame of stale (or empty) content per patch — but React warns when
 * `useLayoutEffect` is called during SSR, where it cannot run at all. Chosen
 * ONCE at module scope so hook order is identical in both environments; the
 * server branch is inert either way, because the markup it renders is already
 * the block's full html.
 */
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

interface Props {
  html: string;
  open: boolean;
  /**
   * The block's DECODED source, carried by `kind.data.code` when `blockData` is
   * on. Identical to `decodeText(html)` — supplying it skips that whole-body
   * regex + five entity passes, which on a big fence is the same order of work
   * as the highlight itself. Absent (blockData off) the HTML is decoded here.
   */
  code?: string;
  /** Highlight the block while it is still open. Default true (`"wavefront"`);
   *  `"eager"` colours the speculative tail on every patch; `false` opts out. */
  streamingHighlight?: boolean | "wavefront" | "eager";
  /**
   * The block this markup came from, when the renderer is driven by the stream.
   * Only used to apply the wire's `html_delta` to the PLAIN escaped body of an
   * open fence (the `streamingHighlight: false` / no-language path) instead of
   * re-setting its whole innerHTML each patch. Absent → that body rebuilds, as
   * it always did.
   */
  block?: Block;
  /** @internal TEST-ONLY: force the pre-mirror path (a full `innerHTML` set of
   *  the whole markup on every patch) so the parity fuzz has a reference. */
  __fullRebuild?: boolean;
}

/** A deferred highlight result, tagged with the source it was produced from. */
interface Slow {
  text: string;
  lang: string;
  html: string;
}

function CodeBlockImpl({ html, open, code, streamingHighlight, block, __fullRebuild }: Props) {
  const lang = extractLang(html) || "text";
  // Decode once: highlighter and copy handler share the same source.
  const text = useMemo(() => (open ? "" : (code ?? decodeText(html))), [html, open, code]);
  // The open block's source. `code` (blockData on) is the decoded source
  // already; without it the body is decoded here, the same work the plain path
  // hands to `innerHTML` anyway.
  const streaming = open && streamingHighlight !== false;
  const tailMode: TailMode = streamingHighlight === "eager" ? "eager" : "wavefront";
  const openText = useMemo(
    () => (streaming ? (code ?? decodeText(html)) : ""),
    [streaming, code, html],
  );

  // The block's incremental state, owned by this instance for its whole life
  // (BlockView is keyed by block.id, and an open block is never virtualized
  // away, so the instance and the block are one to one). Written ONLY from the
  // effect below: a render pass can be double-invoked or thrown away, and this
  // state advances a cursor.
  const incRef = useRef<IncState | null>(null);
  const [inc, setInc] = useState<{ lang: string; html: string; view: string } | null>(null);
  // The live `<code>` while the streaming markup is on screen, plus the
  // frozen/tail mirror painted into it. React renders that element EMPTY (no
  // children, no dangerouslySetInnerHTML) so it never touches its contents; the
  // layout effect below owns them and appends only what hi-inc just settled
  // plus the CAP-bounded tail. Without this the component re-set the whole
  // highlighted body — on a 20 KB fence, ~7x its own size — every patch.
  const codeRef = useRef<HTMLElement | null>(null);
  const mirrorRef = useRef<IncCode | null>(null);
  // The PLAIN body's host, for the same reason one level up: while a fence
  // streams unhighlighted its `<div>`'s innerHTML is exactly `block.html`, so
  // the generic delta splice applies to it verbatim.
  const plainRef = useRef<HTMLDivElement | null>(null);

  // The first slice, in this render pass. It finishes the whole block for all
  // but the largest fences, so the usual case still paints highlighted on the
  // first commit — and a fence that streamed in resumes from its frozen prefix,
  // leaving only the tail to tokenize. A SERVER render has no later task to swap
  // into (and its bytes are the response), so there it runs the whole pass
  // synchronously, unseeded: SSR never takes the incremental path.
  const sync = useMemo(() => {
    if (!text) return null;
    if (typeof window === "undefined") return highlight(text, lang);
    const st = incRef.current;
    return highlightWithin(text, lang, st ? incSeed(st, text, lang) : undefined);
  }, [text, lang]);

  // Advance the incremental state for this patch and publish its markup. Runs
  // after the commit, so the very first paint of a patch may still show the
  // previous patch's markup — one frame behind, never wrong bytes.
  useEffect(() => {
    if (!streaming || typeof window === "undefined") {
      incRef.current = null;
      setInc((prev) => (prev === null ? prev : null));
      return;
    }
    let st = incRef.current;
    if (st === null || st.lang !== lang.toLowerCase()) {
      st = createInc(lang);
      incRef.current = st;
    }
    // No table for this language: the plain body is the only honest answer.
    const markup = st === null ? null : incHighlight(st, openText);
    setInc(
      markup === null
        ? null
        : {
            lang,
            html: markup,
            // `view` is only ever WRITTEN by the full-rebuild reference, which
            // has to show the same thing the mirror paints or the parity fuzz
            // would be comparing two different visual contracts. The mirrored
            // path derives the tail itself, so it does not pay for this.
            view: __fullRebuild ? incView(st!, markup, tailMode) : markup,
          },
    );
  }, [streaming, openText, lang, tailMode, __fullRebuild]);

  const [slow, setSlow] = useState<Slow | null>(null);

  // Only a block that outran the first slice reaches the driver; everything
  // else short-circuits and drops any result left over from superseded text.
  useEffect(() => {
    if (!text || sync !== null) {
      setSlow((prev) => (prev === null ? prev : null)); // same value = no re-render
      return;
    }
    const run = highlightDeferred(text, lang);
    if (run.html !== null) {
      setSlow({ text, lang, html: run.html });
      return;
    }
    let live = true;
    const rest = run.rest;
    if (rest) {
      rest.then((out) => {
        if (live && out !== null) setSlow({ text, lang, html: out });
      });
    }
    return () => {
      live = false;
      run.cancel();
    };
  }, [text, lang, sync]);

  // The swap is gated on the source the markup came from, so a block whose text
  // changes while a highlight is in flight falls back to the plain body rather
  // than flashing the previous block's tokens. (The run itself is cancelled by
  // the effect cleanup; this is the render-side half of the same guard.)
  const settled = sync ?? (slow !== null && slow.text === text && slow.lang === lang ? slow.html : null);
  // The streaming tail. Not gated on `openText` identity: the markup lags the
  // props by one commit, and showing last patch's spans beats flashing the
  // whole block back to plain every tick. A language change does invalidate it.
  const streamed = streaming && inc !== null && inc.lang === lang ? inc.html : null;
  const highlighted = settled ?? (streamed === null ? null : inc!.view);
  // Only the STREAMING markup is mirrored: it is the one that is re-derived on
  // every patch, and it is the only one hi-inc can split. A settled block writes
  // its final markup through React exactly as before (once — its node is then
  // memo-frozen), which is also what makes the handoff at close clean: the
  // element goes back to `dangerouslySetInnerHTML` and React overwrites whatever
  // the mirror left behind with the byte-identical one-shot result.
  const mirrored = settled === null && streamed !== null && !__fullRebuild;

  // Paint the mirror BEFORE the browser paints, in the same commit as the render
  // that produced this markup — a passive effect here would show an empty
  // `<code>` for one frame every time the element mounts. Server-side there is
  // no commit at all: `streaming` gates on `typeof window`, so `mirrored` is
  // never true during SSR and this is inert. Deliberately dependency-free: it
  // must re-check the node identity on every commit, and its own bookkeeping
  // makes a repeat run (React StrictMode's double-invoke) a no-op.
  useIsoLayoutEffect(() => {
    if (!mirrored) {
      mirrorRef.current = null;
      return;
    }
    const node = codeRef.current;
    const st = incRef.current;
    if (node === null || st === null || streamed === null) return;
    // Paint what the STATE holds, not the markup this render captured. The two
    // can be a patch apart — React may have advanced the state (a passive
    // effect) before this commit's layout effects — and the frozen prefix and
    // the tail have to come from the same instant or the mirror would splice a
    // settled prefix onto a tail that predates it. `streamed` is the signal that
    // a streaming markup belongs on screen at all; `st.html` is what it IS. Both
    // converge within the same `act`/frame, so nothing is ever a patch behind.
    const markup = st.html;
    if (markup === null) return;
    let m = mirrorRef.current;
    if (m === null || m.code !== node || m.lang !== lang || m.mode !== tailMode) {
      // A fresh (or replaced) element: nothing of ours is in it yet.
      node.innerHTML = "";
      m = newIncCode(node, lang, st, tailMode);
      mirrorRef.current = m;
    }
    if (!paintIncCode(m, st, markup)) {
      // The split invariant broke (see splice.ts). Fall back to the whole
      // markup — under the same tail mode, so one bailed patch does not flash a
      // differently-painted tail — and drop the mirror so the next commit
      // re-seeds it.
      node.innerHTML = incView(st, markup, tailMode);
      mirrorRef.current = null;
    }
  });

  // Hooks are unconditional; `enabled` decides whether it does anything. Only
  // an OPEN fence with no highlighted markup renders the plain body, and only
  // then is `block.html` what that node contains.
  const plainSeed = useHtmlSplice(plainRef, block, open && highlighted === null && !__fullRebuild);

  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset "Copied" if the block re-opens or its content changes underneath us.
  useEffect(() => {
    if (open) setCopied(false);
  }, [open, html]);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  const onCopy = useCallback(() => {
    const write = (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText)
      ? navigator.clipboard.writeText.bind(navigator.clipboard)
      : null;
    if (!write || !text) return;
    write(text).then(
      () => {
        setCopied(true);
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), 1500);
      },
      // Permission denied / blocked: stay silent, leave button usable.
      () => {},
    );
  }, [text]);

  return (
    <div className={"brook-code-block" + (open ? " brook-streaming" : "")}>
      <div className="brook-code-header">
        <span className="brook-code-lang">{lang}</span>
        {open ? (
          <span className="brook-code-streaming-pill">streaming</span>
        ) : (
          <button
            type="button"
            className="brook-code-copy"
            onClick={onCopy}
            aria-label={copied ? "Copied" : "Copy code"}
            aria-live="polite"
          >
            {copied ? (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
                <span>Copied</span>
              </>
            ) : (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="9" y="9" width="11" height="11" rx="2" />
                  <path d="M5 15V5a2 2 0 0 1 2-2h10" />
                </svg>
                <span>Copy</span>
              </>
            )}
          </button>
        )}
      </div>
      <div className="brook-code-body">
        {highlighted ? (
          // tabIndex=0 + role/label so keyboard users can scroll long code and
          // screen readers announce the region with its language.
          <pre tabIndex={0} role="region" aria-label={`${lang} code`}>
            {mirrored ? (
              // Rendered with NO children and NO dangerouslySetInnerHTML, so
              // React never writes into it; the layout effect above owns it.
              // Same element type and position as the settled form below, so
              // the close-time swap updates this node in place rather than
              // remounting it — and React's own innerHTML write at that point
              // is what discards the mirror's nodes.
              <code ref={codeRef} />
            ) : (
              <code dangerouslySetInnerHTML={{ __html: highlighted }} />
            )}
          </pre>
        ) : (
          <div
            tabIndex={0}
            role="region"
            aria-label={`${lang} code`}
            ref={plainRef}
            dangerouslySetInnerHTML={{ __html: plainSeed ?? html }}
          />
        )}
      </div>
    </div>
  );
}

export const CodeBlock = memo(CodeBlockImpl);
