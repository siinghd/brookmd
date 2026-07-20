// The React Native <FluxMarkdown> component and the useFluxMarkdown hook.
//
// Like the rest of the renderer, this is dependency-injected: `makeFluxMarkdown`
// binds the RN primitives (and an optional color-scheme hook) once, and the
// package entry re-exports the bound component as `FluxMarkdown`. The component
// subscribes to a `FluxClient` with `useSyncExternalStore` and renders each block
// through `htmlToReact` + the primitive component map — never raw HTML.
import {
  memo,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from "react";
import { htmlToReact } from "flux-md/html-to-react";
import type { FluxClient } from "flux-md/client";
import type { Block, Components, ParserConfig } from "flux-md/types";
import { createComponents, type RnPrimitives } from "./components";
import { resolveTheme, type Theme } from "./theme";
import { createFluxClient } from "./native-pool";

export interface FluxMarkdownProps {
  /** A controlled full document string. Diffed via `client.setContent` — grows in
   *  place as it streams. Ignored when `client` is supplied (drive that yourself). */
  content?: string;
  /** A caller-owned client to subscribe to. Takes precedence over `content`. */
  client?: FluxClient;
  /** Per-stream parser flags for the internally-owned client (used only when
   *  `client` is absent). `blockData` defaults to `true` here — RN renderers
   *  prefer the structured channel. Applied once; immutable per stream. */
  config?: ParserConfig;
  /** Opt-in structured `kind.data`. Default `true`. */
  blockData?: boolean;
  /** Per-tag component overrides merged over the built-in map (e.g. custom
   *  `components.Cite` for an inline component tag, or a replacement `code`). */
  components?: Components;
  /** Partial theme override, merged over the resolved light/dark base. */
  theme?: Partial<Theme>;
  /** Force a color scheme, bypassing the injected `useColorScheme`. */
  colorScheme?: "light" | "dark";
  /** Style forwarded to the root container View. */
  style?: unknown;
}

/** Dependencies bound once to produce a concrete `<FluxMarkdown>`. */
export interface FluxMarkdownDeps {
  primitives: RnPrimitives;
  /** The platform color-scheme hook (RN's `useColorScheme`). Called every render;
   *  omit to default to light. Anything other than `"dark"` resolves to light. */
  useColorScheme?: () => string | null | undefined;
}

/**
 * Subscribe to a `FluxClient` and return its ordered block list, re-rendering as
 * patches land. Committed blocks keep a stable reference, so a memoized per-block
 * view never re-renders once its block commits (only the streaming tail does).
 */
export function useFluxMarkdown(client: FluxClient): Block[] {
  return useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
}

// One block, rendered through htmlToReact. Memoized on the block reference (the
// store keeps committed blocks reference-stable) and the components map identity,
// so committed blocks render exactly once and only the active tail re-renders.
const BlockView = memo(
  function BlockView({ block, components }: { block: Block; components: Components }): ReactNode {
    return htmlToReact(block.html, components) as ReactNode;
  },
  (a, b) => a.block === b.block && a.components === b.components,
);

/**
 * Bind RN primitives to produce a `<FluxMarkdown>` component. The package entry
 * calls this with `react-native`'s exports; tests call it with fakes.
 */
export function makeFluxMarkdown(deps: FluxMarkdownDeps): ComponentType<FluxMarkdownProps> {
  const { primitives } = deps;
  const View = primitives.View;
  // Bound once → stable hook identity, so calling it every render is rules-safe.
  const useScheme: () => string | null | undefined = deps.useColorScheme ?? (() => null);

  function FluxMarkdown(props: FluxMarkdownProps): ReactNode {
    const deviceScheme = useScheme();
    const scheme = props.colorScheme ?? (deviceScheme === "dark" ? "dark" : "light");

    // Internally-owned client, created once from the FIRST props (config is
    // immutable per stream). Constructing it is inert — no native module loads
    // until the first append. Only driven when the caller didn't pass a client.
    const [owned] = useState(() =>
      createFluxClient({
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

    const blocks = useFluxMarkdown(client);

    return (
      <View style={props.style}>
        {blocks.map((b) => (
          <BlockView key={b.id} block={b} components={components} />
        ))}
      </View>
    );
  }

  FluxMarkdown.displayName = "FluxMarkdown";
  return FluxMarkdown;
}
