import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { highlight } from "../hi";
import { highlightDeferred, highlightWithin } from "../hi-defer";
import { extractLang } from "../block-props";

/**
 * Deferred-highlighting code block. Open (streaming) blocks render plain;
 * the moment the parser commits the block (open=false), we run our in-house
 * tokenizer on the source and swap in highlighted HTML. Highlighting is
 * memoized on html identity so closed blocks never re-tokenize.
 *
 * The tokenizer runs in BUDGETED SLICES (see hi-defer.ts). The first slice runs
 * during this render, so an ordinary block is highlighted in its very first
 * paint exactly as before; a big block gets the plain escaped body immediately
 * and swaps in its markup a few tasks later, instead of freezing the main
 * thread for the whole pass. The markup is byte-identical either way.
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
}

/** A deferred highlight result, tagged with the source it was produced from. */
interface Slow {
  text: string;
  lang: string;
  html: string;
}

function CodeBlockImpl({ html, open, code }: Props) {
  const lang = extractLang(html) || "text";
  // Decode once: highlighter and copy handler share the same source.
  const text = useMemo(() => (open ? "" : (code ?? decodeText(html))), [html, open, code]);
  // The first slice, in this render pass. It finishes the whole block for all
  // but the largest fences, so the usual case still paints highlighted on the
  // first commit. A SERVER render has no later task to swap into (and its bytes
  // are the response), so there it runs the whole pass synchronously.
  const sync = useMemo(() => {
    if (!text) return null;
    return typeof window === "undefined" ? highlight(text, lang) : highlightWithin(text, lang);
  }, [text, lang]);

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
    sync ?? (slow !== null && slow.text === text && slow.lang === lang ? slow.html : null);

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
