import { useEffect, useLayoutEffect, useRef, type MutableRefObject } from "react";
import { spliceHtml, spliceKeep } from "./splice";
import type { Block } from "./types-core";

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

/**
 * Let a layout effect own an element's children so an OPEN block's patch is
 * applied incrementally (see splice.ts) instead of re-setting the whole
 * `dangerouslySetInnerHTML` every time it grows.
 *
 * ## How React and the effect share the node
 *
 * The returned string is the html captured on the FIRST render and never
 * changes again. Render it as the node's `__html` and React writes the element
 * exactly once, at mount — its own `lastHtml !== nextHtml` check then keeps it
 * from touching the children on any later commit, and the effect owns them from
 * there.
 *
 * That is what makes this safe under concurrent rendering: a render that is
 * thrown away commits nothing and runs no effect, and the effect's own
 * bookkeeping makes a repeat run (StrictMode's double-invoke) a no-op. It also
 * leaves SSR and hydration byte-identical, because the first markup React
 * produces is still the block's full html.
 *
 * The caller hands the node BACK to React by rendering a different element
 * (a closed block's plain `<div dangerouslySetInnerHTML>`), which remounts the
 * subtree and re-renders the settled html in one pass.
 *
 * @param hostRef ref attached to the element whose children are managed
 * @param block   the block's CURRENT version (identity matters — `spliceKeep`
 *                is keyed on it)
 * @param enabled false to stay entirely out of the way
 * @returns the html to render as `__html`, or `null` when not managing
 */

export function useHtmlSplice(
  hostRef: MutableRefObject<HTMLElement | null>,
  block: Block | undefined,
  enabled: boolean,
): string | null {
  const seed = useRef(block);
  // What the live node's children currently reflect.
  const applied = useRef<{ node: HTMLElement; block: Block } | null>(null);
  // No dependency array on purpose: the node identity has to be re-checked on
  // every commit (React can hand back a different element, which then holds the
  // seed html again), and a repeat run is already a no-op.
  useIsoLayoutEffect(() => {
    const base = seed.current;
    if (!enabled || block === undefined || base === undefined) {
      applied.current = null;
      return;
    }
    const node = hostRef.current;
    if (node === null) return;
    let prev = applied.current;
    // A freshly mounted (or replaced) node holds exactly the seed html: that is
    // the only value React ever writes here.
    if (prev === null || prev.node !== node) prev = { node, block: base };
    if (prev.block === block) {
      applied.current = prev;
      return;
    }
    const keep = spliceKeep(prev.block, block);
    if (keep !== undefined && spliceHtml(node, prev.block.html, block.html, keep)) {
      applied.current = { node, block };
      return;
    }
    // Not a shape the splice can prove — rebuild, exactly as before it existed.
    node.innerHTML = block.html;
    applied.current = { node, block };
  });
  return enabled && seed.current !== undefined ? seed.current.html : null;
}
