import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { highlight } from "../hi";
import { highlightDeferred, highlightWithin } from "../hi-defer";
import { createInc, incHighlight, incSeed, type IncState } from "../hi-inc";
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
 * `streamingHighlight={false}` opts out of the open-block path only: open blocks
 * then render plain and close exactly as they did before it existed.
 */

function decodeText(html: string): string {
  const m = html.match(/<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/);
  if (!m) return "";
  return m[1]
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}


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
  /** Highlight the block while it is still open. Default true. */
  streamingHighlight?: boolean;
}

/** A deferred highlight result, tagged with the source it was produced from. */
interface Slow {
  text: string;
  lang: string;
  html: string;
}

function CodeBlockImpl({ html, open, code, streamingHighlight }: Props) {
  const lang = extractLang(html) || "text";
  // Decode once: highlighter and copy handler share the same source.
  const text = useMemo(() => (open ? "" : (code ?? decodeText(html))), [html, open, code]);
  // The open block's source. `code` (blockData on) is the decoded source
  // already; without it the body is decoded here, the same work the plain path
  // hands to `innerHTML` anyway.
  const streaming = open && streamingHighlight !== false;
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
  const [inc, setInc] = useState<{ lang: string; html: string } | null>(null);

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
    setInc(markup === null ? null : { lang, html: markup });
  }, [streaming, openText, lang]);

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
  const highlighted =
    sync ??
    (slow !== null && slow.text === text && slow.lang === lang ? slow.html : null) ??
    // The streaming tail. Not gated on `openText` identity: the markup lags the
    // props by one commit, and showing last patch's spans beats flashing the
    // whole block back to plain every tick. A language change does invalidate it.
    (streaming && inc !== null && inc.lang === lang ? inc.html : null);

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
            <code dangerouslySetInnerHTML={{ __html: highlighted }} />
          </pre>
        ) : (
          <div tabIndex={0} role="region" aria-label={`${lang} code`} dangerouslySetInnerHTML={{ __html: html }} />
        )}
      </div>
    </div>
  );
}

export const CodeBlock = memo(CodeBlockImpl);
