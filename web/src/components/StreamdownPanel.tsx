import { memo } from "react";
import { Streamdown } from "streamdown";

interface Props {
  source: string;
}

// Streamdown rebuilds its full AST on every render. We memo on `source` only
// so the panel only re-renders when its text actually changed.
function StreamdownPanelImpl({ source }: Props) {
  return (
    <div className="streamdown-host">
      <Streamdown>{source}</Streamdown>
    </div>
  );
}

export const StreamdownPanel = memo(StreamdownPanelImpl);
