import { memo, useMemo } from "react";
import { highlight } from "../hi";

/**
 * Deferred-highlighting code block. Open (streaming) blocks render plain;
 * the moment the parser commits the block (open=false), we run our in-house
 * tokenizer on the source and swap in highlighted HTML. Highlighting is
 * memoized on html identity so closed blocks never re-tokenize.
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

function extractLang(html: string): string {
  const m = html.match(/data-lang="([^"]+)"/);
  return m ? m[1] : "";
}

interface Props {
  html: string;
  open: boolean;
}

function CodeBlockImpl({ html, open }: Props) {
  const lang = extractLang(html) || "text";
  const highlighted = useMemo(() => {
    if (open) return null;
    const text = decodeText(html);
    if (!text) return null;
    return highlight(text, lang);
  }, [html, open, lang]);

  return (
    <div className={"flux-code-block" + (open ? " flux-streaming" : "")}>
      <div className="flux-code-header">
        <span className="flux-code-lang">{lang}</span>
        {open && <span className="flux-code-streaming-pill">streaming</span>}
      </div>
      <div className="flux-code-body">
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
