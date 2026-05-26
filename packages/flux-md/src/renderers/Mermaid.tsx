import { memo } from "react";

/**
 * Mermaid block — preformatted-text only. flux-md is zero-dep, so we don't
 * ship the Mermaid runtime. The diagram source is shown in a code block;
 * plug in your own renderer at this slot if you want SVG output.
 */

interface Props {
  html: string;
  open: boolean;
}

function MermaidImpl({ html, open }: Props) {
  return (
    <div className={"flux-mermaid-block" + (open ? " flux-streaming" : "")}>
      <div className="flux-mermaid-header">
        <span className="flux-mermaid-lang">mermaid</span>
        {open && <span className="flux-code-streaming-pill">streaming</span>}
      </div>
      <div className="flux-mermaid-body" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

export const Mermaid = memo(MermaidImpl);
