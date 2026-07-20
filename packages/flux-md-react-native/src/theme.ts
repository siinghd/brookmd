// Theme tokens for the built-in React Native renderer. The renderer is fully
// dependency-injected (see `createComponents`), so this file has NO react-native
// import — a `Theme` is just data, resolved once per render and turned into
// styles by the primitives' `StyleSheet.create`.

/** The five GitHub alert kinds the core emits (`Alert.kind`, lowercase). */
export type AlertKind = "note" | "tip" | "important" | "warning" | "caution";

/** Per-alert tint: the left bar / border, the card background, and the title color. */
export interface AlertTheme {
  bar: string;
  bg: string;
  title: string;
}

/** Resolved color + typography tokens the renderer maps onto RN primitives. */
export interface Theme {
  /** Body text color. */
  text: string;
  /** De-emphasized text (footnote refs, pending links, table borders). */
  muted: string;
  /** Page background (unused by leaf styles; provided for host containers). */
  background: string;
  /** Inline-code / code-block background. */
  surface: string;
  /** Hairline color for rules, tables, blockquote bar. */
  border: string;
  /** Active link color. */
  link: string;
  /** Speculative (`data-flux-pending`) link color — subdued, non-pressable. */
  linkPending: string;
  /** Heading text color. */
  heading: string;
  /** Blockquote left bar. */
  quoteBar: string;
  /** Monospace family for code (platform default when undefined). */
  mono: string;
  /** Base body font size in points; headings scale from this. */
  fontSize: number;
  /** Line height multiple applied to body text. */
  lineHeightScale: number;
  /** Per-kind alert tints. */
  alerts: Record<AlertKind, AlertTheme>;
}

const LIGHT: Theme = {
  text: "#1f2328",
  muted: "#656d76",
  background: "#ffffff",
  surface: "#f6f8fa",
  border: "#d0d7de",
  link: "#0969da",
  linkPending: "#8c959f",
  heading: "#1f2328",
  quoteBar: "#d0d7de",
  mono: "Menlo",
  fontSize: 16,
  lineHeightScale: 1.5,
  alerts: {
    note: { bar: "#0969da", bg: "#ddf4ff", title: "#0969da" },
    tip: { bar: "#1a7f37", bg: "#dafbe1", title: "#1a7f37" },
    important: { bar: "#8250df", bg: "#fbefff", title: "#8250df" },
    warning: { bar: "#9a6700", bg: "#fff8c5", title: "#9a6700" },
    caution: { bar: "#cf222e", bg: "#ffebe9", title: "#cf222e" },
  },
};

const DARK: Theme = {
  text: "#e6edf3",
  muted: "#8b949e",
  background: "#0d1117",
  surface: "#161b22",
  border: "#30363d",
  link: "#2f81f7",
  linkPending: "#6e7681",
  heading: "#e6edf3",
  quoteBar: "#30363d",
  mono: "Menlo",
  fontSize: 16,
  lineHeightScale: 1.5,
  alerts: {
    note: { bar: "#1f6feb", bg: "#121d2f", title: "#4493f8" },
    tip: { bar: "#238636", bg: "#0f2417", title: "#3fb950" },
    important: { bar: "#8957e5", bg: "#211530", title: "#a371f7" },
    warning: { bar: "#9e6a03", bg: "#272115", title: "#d29922" },
    caution: { bar: "#da3633", bg: "#25171a", title: "#f85149" },
  },
};

/**
 * Resolve a `Theme` for the given color scheme, shallow-merging an optional
 * partial override on top (the `alerts` map is merged one level deeper so a
 * caller can retint a single kind). Pass the result to {@link createComponents}.
 */
export function resolveTheme(
  scheme: "light" | "dark" | null | undefined,
  override?: Partial<Theme>,
): Theme {
  const base = scheme === "dark" ? DARK : LIGHT;
  if (!override) return base;
  return {
    ...base,
    ...override,
    alerts: override.alerts ? { ...base.alerts, ...override.alerts } : base.alerts,
  };
}
