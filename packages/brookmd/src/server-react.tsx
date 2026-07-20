import { createElement, type ReactNode } from "react";
import { htmlToReact } from "./html-to-react";
import { blockKindProps } from "./react";
import { parseToBlocks } from "./server";
import type { Block, Components, ParserConfig } from "./types";

/**
 * React server / static rendering for brookmd — the **React-requiring** half of
 * `brookmd/server`, split into its own subpath (`brookmd/server/react`) so the
 * core `brookmd/server` entry (`initBrook` / `renderToString` / `parseToBlocks`)
 * stays importable with no `react` installed.
 *
 * Requires {@link initBrook} (or `initBrookSync`) from `brookmd/server` to have run
 * before rendering.
 *
 * ```tsx
 * import { initBrook } from "brookmd/server";
 * import { BrookMarkdownStatic } from "brookmd/server/react";
 * await initBrook();
 * // <BrookMarkdownStatic content={markdown} />  (RSC / SSR / static)
 * ```
 */

// Hookless block renderer (RSC-safe): mirrors the client renderer's dispatch
// (block-kind overrides, a Component block dispatched by tag, tag-level overrides
// via htmlToReact) but uses no hooks and skips the client-only interactive
// renderers (Mermaid; client-side code highlighting) — those activate on the
// client after hydration. Kept in step with react.tsx's renderBlockContent.
function renderStaticBlock(block: Block, components?: Components): ReactNode {
  const kind = block.kind.type;
  if (components) {
    if (kind === "Component") {
      const tag = (block.kind.data as { tag?: string } | undefined)?.tag;
      const override = (tag && components[tag]) || components.Component;
      if (override) return createElement(override, { key: block.id, ...blockKindProps(block, components) });
    }
    const blockOverride = components[kind];
    if (blockOverride) return createElement(blockOverride, { key: block.id, ...blockKindProps(block, components) });
  }
  const className =
    "brook-block brook-block-" +
    kind.toLowerCase() +
    (block.open ? " brook-open" : "") +
    (block.speculative ? " brook-speculative" : "");
  if (components) {
    return createElement("div", { key: block.id, className }, htmlToReact(block.html, components));
  }
  return createElement("div", { key: block.id, className, dangerouslySetInnerHTML: { __html: block.html } });
}

interface BrookMarkdownStaticProps {
  /** The complete markdown to render (server/static use is for finished content). */
  content: string;
  /** Parser config (same shape as the streaming client's). */
  config?: ParserConfig;
  /** Tag-level / block-kind / component-tag overrides (see {@link Components}). */
  components?: Components;
  /** Appended to the root's `className` (the `brook-md` class is always present). */
  className?: string;
  /** Set on the root element. */
  id?: string;
  /** Set on the root element (e.g. `"article"`). */
  role?: string;
  /** Make the root a live region (parity with `<BrookMarkdown>` if you hydrate). */
  "aria-live"?: "off" | "polite" | "assertive";
  /** Live-region atomicity; pair with `aria-live`. */
  "aria-atomic"?: boolean;
}

/**
 * Synchronous, worker-free React rendering of finished markdown — a React Server
 * Component, or any one-shot SSR / static render. Emits the `brook-md` root +
 * per-block structure with the same `components` overrides (inline/block
 * component tags dispatch here too). Requires `initBrook` (or `initBrookSync`)
 * from `brookmd/server` to have run. Uses no hooks (RSC-safe). A **render-once**
 * component: for live streaming, client-side code highlighting, or Mermaid use
 * the client `<BrookMarkdown>` instead (and if you SSR-then-hydrate, render the
 * *same* component on both sides).
 */
export function BrookMarkdownStatic({
  content,
  config,
  components,
  className,
  id,
  role,
  "aria-live": ariaLive,
  "aria-atomic": ariaAtomic,
}: BrookMarkdownStaticProps): ReactNode {
  const blocks = parseToBlocks(content, { config });
  const comps = components && Object.keys(components).length > 0 ? components : undefined;
  return createElement(
    "div",
    {
      className: className ? `brook-md ${className}` : "brook-md",
      id,
      role,
      "aria-live": ariaLive,
      "aria-atomic": ariaAtomic,
    },
    blocks.map((b) => renderStaticBlock(b, comps)),
  );
}
