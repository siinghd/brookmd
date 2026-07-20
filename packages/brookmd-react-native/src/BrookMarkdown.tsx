// The React Native <BrookMarkdown> component and the useBrookMarkdown hook.
//
// Like the rest of the renderer, this is dependency-injected: `makeBrookMarkdown`
// binds the RN primitives (and an optional color-scheme hook) once, and the
// package entry re-exports the bound component as `BrookMarkdown`. The component
// subscribes to a `BrookClient` with `useSyncExternalStore` and renders each block
// through `htmlToReact` + the primitive component map — never raw HTML.
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from "react";
import { htmlToReact } from "brookmd/html-to-react";
import type { BrookClient } from "brookmd/client";
import type { Block, Components, ParserConfig } from "brookmd/types";
import { createComponents, RENDER_OPEN_BLOCK, type OpenBlockRenderer, type RnPrimitives } from "./components";
import { resolveTheme, type Theme } from "./theme";
import { createBrookClient } from "./native-pool";

export interface BrookMarkdownProps {
  /** A controlled full document string. Diffed via `client.setContent` — grows in
   *  place as it streams. Ignored when `client` is supplied (drive that yourself). */
  content?: string;
  /** A caller-owned client to subscribe to. Takes precedence over `content`. */
  client?: BrookClient;
  /** Per-stream parser flags for the internally-owned client (used only when
   *  `client` is absent). `blockData` defaults to `true` here — RN renderers
   *  prefer the structured channel. Applied once; immutable per stream. */
  config?: ParserConfig;
  /** Opt-in structured `kind.data`. Default `true`. */
  blockData?: boolean;
  /** Per-tag component overrides merged over the built-in map (e.g. custom
   *  `components.Cite` for an inline component tag, or a replacement `code`).
   *  CAUTION: keep this identity STABLE — hoist it to module scope or wrap it in
   *  `useMemo`. A fresh object each render rebuilds the whole renderer and
   *  re-tokenizes every block on every patch (dev warns once). */
  components?: Components;
  /** Partial theme override, merged over the resolved light/dark base.
   *  CAUTION: keep this identity STABLE (hoist / `useMemo`). A fresh object each
   *  render rebuilds the renderer and re-tokenizes every block per patch. */
  theme?: Partial<Theme>;
  /** Force a color scheme, bypassing the injected `useColorScheme`. */
  colorScheme?: "light" | "dark";
  /** Style forwarded to the root container View. */
  style?: unknown;
}

/** Dependencies bound once to produce a concrete `<BrookMarkdown>`. */
export interface BrookMarkdownDeps {
  primitives: RnPrimitives;
  /** The platform color-scheme hook (RN's `useColorScheme`). Called every render;
   *  omit to default to light. Anything other than `"dark"` resolves to light. */
  useColorScheme?: () => string | null | undefined;
}

/**
 * Subscribe to a `BrookClient` and return its ordered block list, re-rendering as
 * patches land. Committed blocks keep a stable reference, so a memoized per-block
 * view never re-renders once its block commits (only the streaming tail does).
 */
export function useBrookMarkdown(client: BrookClient): Block[] {
  return useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
}

const warnedUnstable = new Set<string>();

/** Test-only: reset the one-time unstable-prop warning latch. Not public API. */
export function __resetUnstableWarnings(): void {
  warnedUnstable.clear();
}

// Dev-only tripwire (mirrors brookmd's React renderer): warns once if `components`
// or `theme` changes identity across renders. A fresh identity each render rebuilds
// the whole component map, which busts every block's memo and re-tokenizes every
// block on every patch — the classic inline-object footgun. No-op in production and
// when the value is undefined/stable. Always calls the hook (Rules of Hooks).
function useUnstablePropWarning(name: string, value: unknown): void {
  const ref = useRef(value);
  if (ref.current !== value) {
    const prevDefined = ref.current !== undefined && ref.current !== null;
    const nextDefined = value !== undefined && value !== null;
    ref.current = value;
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    if (prevDefined && nextDefined && !warnedUnstable.has(name) && (!env || env.NODE_ENV !== "production")) {
      warnedUnstable.add(name);
      // eslint-disable-next-line no-console
      console.warn(
        `<BrookMarkdown>: the \`${name}\` prop changed identity between renders. ` +
          `Hoist it to module scope or wrap it in useMemo — a fresh identity each ` +
          `render rebuilds the renderer and re-tokenizes every block on every patch.`,
      );
    }
  }
}

// One block. Memoized on the block reference (the store keeps committed blocks
// reference-stable) and the components map identity, so committed blocks render
// exactly once and only the active tail re-renders.
//
// For an OPEN List/Table/Blockquote/Alert with structured data, the keyed
// dispatcher (attached to the components map under RENDER_OPEN_BLOCK) renders from
// block.kind.data so only the growing tail sub-part re-tokenizes each patch —
// instead of re-tokenizing the whole block's html every tick (O(n²)). Closed
// blocks (and the blockData-off / structural-override cases) take the single
// whole-html path, which runs once.
const BlockView = memo(
  function BlockView({ block, components }: { block: Block; components: Components }): ReactNode {
    if (block.open) {
      const keyed = (components as unknown as Record<symbol, OpenBlockRenderer | undefined>)[RENDER_OPEN_BLOCK];
      const tree = typeof keyed === "function" ? keyed(block, components) : null;
      if (tree != null) return tree;
    }
    return htmlToReact(block.html, components) as ReactNode;
  },
  (a, b) => a.block === b.block && a.components === b.components,
);

/**
 * Bind RN primitives to produce a `<BrookMarkdown>` component. The package entry
 * calls this with `react-native`'s exports; tests call it with fakes.
 */
export function makeBrookMarkdown(deps: BrookMarkdownDeps): ComponentType<BrookMarkdownProps> {
  const { primitives } = deps;
  const View = primitives.View;
  // Bound once → stable hook identity, so calling it every render is rules-safe.
  const useScheme: () => string | null | undefined = deps.useColorScheme ?? (() => null);

  function BrookMarkdown(props: BrookMarkdownProps): ReactNode {
    const deviceScheme = useScheme();
    const scheme = props.colorScheme ?? (deviceScheme === "dark" ? "dark" : "light");
    // Dev warning: an inline `components`/`theme` object rebuilds the renderer each
    // render and re-tokenizes every block on every patch. Hoist or useMemo them.
    useUnstablePropWarning("components", props.components);
    useUnstablePropWarning("theme", props.theme);

    // Internally-owned client, created once from the FIRST props (config is
    // immutable per stream). Constructing it is inert — no native module loads
    // until the first append. Only driven when the caller didn't pass a client.
    const [owned] = useState(() =>
      createBrookClient({
        config: { blockData: props.blockData ?? true, ...props.config },
        coalesce: true,
      }),
    );
    const client = props.client ?? owned;
    const ownsClient = !props.client;

    // Register/tear down the owned client (StrictMode-safe: reattach on mount,
    // destroy on unmount). Never touches a caller-owned client.
    useEffect(() => {
      if (!ownsClient) return;
      owned.reattach();
      return () => owned.destroy();
    }, [owned, ownsClient]);

    // Drive the owned client from the controlled `content` string.
    useEffect(() => {
      if (!ownsClient || props.content == null) return;
      owned.setContent(props.content);
    }, [owned, ownsClient, props.content]);

    const theme = useMemo(() => resolveTheme(scheme, props.theme), [scheme, props.theme]);
    const components = useMemo<Components>(
      () => ({ ...createComponents(primitives, theme), ...props.components }),
      [theme, props.components],
    );

    const blocks = useBrookMarkdown(client);

    return (
      <View style={props.style}>
        {blocks.map((b) => (
          <BlockView key={b.id} block={b} components={components} />
        ))}
      </View>
    );
  }

  BrookMarkdown.displayName = "BrookMarkdown";
  return BrookMarkdown;
}
