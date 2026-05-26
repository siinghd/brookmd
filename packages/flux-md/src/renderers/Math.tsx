import { memo } from "react";

/**
 * Math block — preformatted-text only. flux-md is zero-dep, so we don't
 * ship KaTeX/MathJax. If you want rendered math, drop in a renderer via
 * the (future) plugin slot and override this component.
 */

interface Props {
  html: string;
  open: boolean;
}

function MathImpl({ html, open }: Props) {
  return (
    <div className={"flux-math-block" + (open ? " flux-streaming" : "")}>
      <div className="flux-math-header">
        <span className="flux-math-lang">math</span>
        {open && <span className="flux-code-streaming-pill">streaming</span>}
      </div>
      <div className="flux-math-body" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

export const MathBlock = memo(MathImpl);
