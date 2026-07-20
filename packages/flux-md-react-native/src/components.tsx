// The built-in React Native renderer, as a DEPENDENCY-INJECTED component map.
//
// `createComponents(primitives, theme)` returns a `Components` map (the same
// shape `flux-md`'s `htmlToReact` consumes) in which every HTML tag the core
// emits is mapped to a React Native primitive. Because the RN primitives are
// injected — not imported — this file has NO `react-native` dependency: the real
// entry (`src/index.tsx`) injects the genuine `{ Text, View, ... }`, while the
// host test-suite injects string/stub fakes and asserts the RN-safety invariant
// (no bare HTML-tag string ever survives into the element tree).
//
// RN nesting rules the mapping respects:
//   - text-bearing elements (`p`, `h1`–`h6`, `li` content, `td`/`th`, inline
//     `em`/`strong`/`del`/`code`/`a`/`span`/`sup`/`br`) render as <Text>, so raw
//     strings and nested inline runs are legal children;
//   - structural elements (`ul`/`ol`, `table`/`thead`/`tbody`/`tr`, alert/math
//     `div`, `section`, `pre`, `hr`) render as <View>/<ScrollView>, and their
//     children are filtered to real elements (inter-tag whitespace text nodes —
//     illegal directly inside a View — are dropped).
import { Children, cloneElement, isValidElement, type ComponentType, type ReactNode } from "react";
import type { Components } from "flux-md/types";
import { safeUrl } from "flux-md/html-to-react";
import type { AlertKind, Theme } from "./theme";

/**
 * The React Native primitives the renderer needs. Injected so the package's real
 * entry binds `react-native`'s exports while tests bind lightweight fakes. Values
 * are typed `ComponentType<any>` (matching flux-md's `Components`), so both a real
 * RN component and a test stub satisfy the contract.
 */
export interface RnPrimitives {
  Text: ComponentType<any>;
  View: ComponentType<any>;
  ScrollView: ComponentType<any>;
  Image: ComponentType<any>;
  /** Present for API completeness / custom overrides; the default link renderer
   *  uses `Text.onPress` (a Pressable cannot nest inside a <Text> run). */
  Pressable: ComponentType<any>;
  Linking: { openURL(url: string): unknown };
  StyleSheet: { create<T extends Record<string, object>>(styles: T): T; hairlineWidth: number };
}

// Props arrive from htmlToReact already sanitized: `class`→`className`, `style`
// as an object, url attrs run through safeUrl, hyphenated `data-*` kept verbatim.
// The wrappers read them off an untyped bag (hyphenated keys aren't valid TS
// identifiers) and forward only RN-meaningful values — never spreading DOM props
// like `className`/`href` onto a primitive (which would warn on device).
type P = Record<string, unknown> & { children?: ReactNode };

/** Real React elements only — drops inter-tag whitespace text nodes that are
 *  illegal directly inside a <View>. */
function elementChildren(children: ReactNode): ReactNode[] {
  return Children.toArray(children).filter((c) => isValidElement(c));
}

// Wire tags whose wrapper renders text-bearing content that is legal INSIDE a
// <Text> run (Text, or an inline Image). Everything else is block-level and must
// be a sibling <View>/<ScrollView>, never nested under a <Text>. The wrapper
// components carry an `__inline` marker (stamped on the returned map) so a
// container like <li> can partition mixed children without re-deriving the tag.
const INLINE_TAGS = ["a", "em", "strong", "del", "code", "span", "sup", "br", "img", "input", "label"];

/** True if a child node belongs in an inline <Text> run: a raw string/number, or
 *  an element whose wrapper was marked `__inline`. */
function isInlineChild(node: ReactNode): boolean {
  if (typeof node === "string" || typeof node === "number") return true;
  if (isValidElement(node)) {
    const t = node.type;
    return typeof t === "function" && (t as { __inline?: boolean }).__inline === true;
  }
  return false;
}

const HEADING_SCALE: Record<string, number> = { h1: 2, h2: 1.5, h3: 1.25, h4: 1, h5: 0.875, h6: 0.85 };

/**
 * Build the tag→primitive component map. Pass the result as `<FluxMarkdown
 * components={...}>` or straight to `htmlToReact(html, components)`.
 */
export function createComponents(primitives: RnPrimitives, theme: Theme): Components {
  const { Text, View, ScrollView, Image, Linking, StyleSheet } = primitives;
  const fs = theme.fontSize;
  const lh = Math.round(fs * theme.lineHeightScale);

  const s = StyleSheet.create({
    block: { marginBottom: fs * 0.6 },
    paragraph: { color: theme.text, fontSize: fs, lineHeight: lh },
    heading: { color: theme.heading, fontWeight: "700", marginBottom: fs * 0.4, marginTop: fs * 0.2 },
    strong: { fontWeight: "700" },
    em: { fontStyle: "italic" },
    del: { textDecorationLine: "line-through" },
    link: { color: theme.link, textDecorationLine: "underline" },
    linkPending: { color: theme.linkPending },
    codeInline: {
      color: theme.text,
      backgroundColor: theme.surface,
      fontFamily: theme.mono,
      fontSize: fs * 0.9,
    },
    pre: {
      backgroundColor: theme.surface,
      borderRadius: 6,
      borderWidth: StyleSheet.hairlineWidth as unknown as number,
      borderColor: theme.border,
      padding: fs * 0.75,
      marginBottom: fs * 0.6,
    },
    codeBlockText: { color: theme.text, fontFamily: theme.mono, fontSize: fs * 0.85, lineHeight: fs * 1.3 },
    blockquote: {
      borderLeftWidth: 4,
      borderLeftColor: theme.quoteBar,
      paddingLeft: fs * 0.75,
      marginBottom: fs * 0.6,
    },
    hr: { height: StyleSheet.hairlineWidth as unknown as number, backgroundColor: theme.border, marginVertical: fs },
    list: { marginBottom: fs * 0.6 },
    li: { flexDirection: "row", alignItems: "flex-start", marginBottom: fs * 0.15 },
    liMarker: { color: theme.text, fontSize: fs, lineHeight: lh, marginRight: fs * 0.4, minWidth: fs * 0.9 },
    liContent: { flex: 1 },
    liBody: { color: theme.text, fontSize: fs, lineHeight: lh },
    checkbox: { color: theme.text, fontSize: fs, lineHeight: lh },
    table: { borderWidth: StyleSheet.hairlineWidth as unknown as number, borderColor: theme.border, marginBottom: fs * 0.6 },
    tr: { flexDirection: "row" },
    cell: {
      flex: 1,
      color: theme.text,
      fontSize: fs * 0.95,
      padding: fs * 0.4,
      borderWidth: StyleSheet.hairlineWidth as unknown as number,
      borderColor: theme.border,
    },
    cellHeader: { fontWeight: "700" },
    footnotes: { marginTop: fs, borderTopWidth: StyleSheet.hairlineWidth as unknown as number, borderTopColor: theme.border, paddingTop: fs * 0.5 },
    sup: { color: theme.link, fontSize: fs * 0.7, lineHeight: lh },
    mathInline: { color: theme.text, fontFamily: theme.mono, fontSize: fs * 0.95 },
    mathDisplay: {
      color: theme.text,
      fontFamily: theme.mono,
      fontSize: fs,
      backgroundColor: theme.surface,
      padding: fs * 0.6,
      marginBottom: fs * 0.6,
      textAlign: "center",
    },
    alert: { borderLeftWidth: 4, borderRadius: 6, padding: fs * 0.6, marginBottom: fs * 0.6 },
    alertTitle: { fontWeight: "700", marginBottom: fs * 0.2 },
    image: { width: "100%", height: 200, resizeMode: "contain", marginBottom: fs * 0.4 },
  } as Record<string, object>);

  const cls = (p: P): string => (typeof p.className === "string" ? p.className : "");

  // --- inline (Text) ---------------------------------------------------------
  const Strong = (p: P) => <Text style={s.strong}>{p.children}</Text>;
  const Em = (p: P) => <Text style={s.em}>{p.children}</Text>;
  const Del = (p: P) => <Text style={s.del}>{p.children}</Text>;
  const Br = () => <Text>{"\n"}</Text>;

  const Code = (p: P) => {
    // A `code` with `data-lang` (block code, from `<pre><code data-lang=…>`) uses
    // the block text style; bare inline `code` uses the chip style.
    const block = p["data-lang"] !== undefined || cls(p).includes("language-");
    return <Text style={block ? s.codeBlockText : s.codeInline}>{p.children}</Text>;
  };

  const Span = (p: P) => {
    // The only inline <span> the core emits is `math math-inline`.
    if (cls(p).includes("math")) return <Text style={s.mathInline}>{p.children}</Text>;
    return <Text>{p.children}</Text>;
  };

  const A = (p: P) => {
    const pending = "data-flux-pending" in p;
    const href = typeof p.href === "string" ? p.href : "";
    if (pending || !href) return <Text style={s.linkPending}>{p.children}</Text>;
    const onPress = () => {
      const u = safeUrl(href);
      if (u && u !== "#") {
        try {
          Promise.resolve(Linking.openURL(u)).catch(() => {});
        } catch {
          /* openURL may throw synchronously on an unsupported scheme */
        }
      }
    };
    return (
      <Text style={s.link} onPress={onPress}>
        {p.children}
      </Text>
    );
  };

  const Sup = (p: P) => <Text style={s.sup}>{p.children}</Text>;

  // --- text blocks (Text) ----------------------------------------------------
  const Paragraph = (p: P) => {
    if (cls(p).includes("markdown-alert-title")) {
      return <Text style={[s.alertTitle, s.paragraph]}>{p.children}</Text>;
    }
    return <Text style={[s.paragraph, s.block]}>{p.children}</Text>;
  };

  const heading = (tag: string): ComponentType<P> => {
    const size = Math.round(fs * (HEADING_SCALE[tag] ?? 1));
    const H = (p: P) => <Text style={[s.heading, { fontSize: size, lineHeight: Math.round(size * 1.25) }]}>{p.children}</Text>;
    H.displayName = tag.toUpperCase();
    return H;
  };

  // --- structural (View) -----------------------------------------------------
  const Hr = () => <View style={s.hr} />;

  const Pre = (p: P) => {
    // Normally one <code> child (a Text). A hand-fed `<pre>text</pre>` yields a
    // bare string, which is illegal directly under a <View>/<ScrollView> — wrap
    // any stray string in the code text style rather than dropping or crashing.
    const kids = Children.toArray(p.children)
      .map((c, i) =>
        typeof c === "string" || typeof c === "number" ? (
          <Text key={`c${i}`} style={s.codeBlockText}>
            {c}
          </Text>
        ) : isValidElement(c) ? (
          c
        ) : null,
      )
      .filter((c) => c != null);
    return (
      <ScrollView horizontal style={s.pre} showsHorizontalScrollIndicator={false}>
        {kids}
      </ScrollView>
    );
  };

  const Blockquote = (p: P) => <View style={s.blockquote}>{elementChildren(p.children)}</View>;

  // Ordered/unordered lists thread the marker down to <li> via private props so
  // each item can render its own bullet / number column (RN has no list layout).
  const makeList = (ordered: boolean) => {
    const L = (p: P) => {
      const start = ordered && typeof p.start === "number" ? (p.start as number) : 1;
      let i = 0;
      const items = Children.toArray(p.children).map((child) => {
        if (!isValidElement(child)) return null; // inter-item whitespace
        const idx = i++;
        return cloneElement(child as any, { __ordered: ordered, __marker: ordered ? `${start + idx}.` : "•" });
      });
      return <View style={s.list}>{items}</View>;
    };
    L.displayName = ordered ? "OL" : "UL";
    return L;
  };

  const Li = (p: P) => {
    const marker = typeof p.__marker === "string" ? p.__marker : "•";
    // Partition the item's children so inline runs (text + inline tags, incl. a
    // leading task-list checkbox) become <Text>, while block-level children
    // (nested ul/ol, fenced code, blockquote/alert, table, loose <p>) render as
    // sibling <View>s — never nested under a <Text>, which RN forbids and which
    // breaks layout on device.
    const kids = Children.toArray(p.children);
    const parts: ReactNode[] = [];
    let run: ReactNode[] = [];
    const flush = () => {
      if (run.length > 0) {
        parts.push(
          <Text key={`r${parts.length}`} style={s.liBody}>
            {run}
          </Text>,
        );
        run = [];
      }
    };
    for (const c of kids) {
      if (isInlineChild(c)) {
        run.push(c);
      } else if (isValidElement(c)) {
        flush();
        parts.push(c);
      }
    }
    flush();
    return (
      <View style={s.li}>
        <Text style={s.liMarker}>{marker}</Text>
        <View style={s.liContent}>{parts}</View>
      </View>
    );
  };

  const Input = (p: P) => {
    if (p.type === "checkbox") {
      const checked = p.checked === true || p.defaultChecked === true;
      return <Text style={s.checkbox}>{checked ? "☑ " : "☐ "}</Text>;
    }
    return null;
  };

  const Label = (p: P) => <Text style={s.liBody}>{p.children}</Text>;

  const Table = (p: P) => (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View style={s.table}>{elementChildren(p.children)}</View>
    </ScrollView>
  );
  const Thead = (p: P) => <View>{elementChildren(p.children)}</View>;
  const Tbody = (p: P) => <View>{elementChildren(p.children)}</View>;
  const Tr = (p: P) => <View style={s.tr}>{elementChildren(p.children)}</View>;
  const Th = (p: P) => <Text style={[s.cell, s.cellHeader]}>{p.children}</Text>;
  const Td = (p: P) => <Text style={s.cell}>{p.children}</Text>;

  const Img = (p: P) => {
    const src = typeof p.src === "string" ? p.src : "";
    if (!src) return null;
    return <Image style={s.image} source={{ uri: src }} accessibilityLabel={typeof p.alt === "string" ? p.alt : undefined} />;
  };

  const Section = (p: P) => {
    const style = cls(p).includes("footnotes") ? s.footnotes : undefined;
    return <View style={style}>{elementChildren(p.children)}</View>;
  };

  const alertKindFromClass = (className: string): AlertKind | null => {
    const m = className.match(/markdown-alert-(note|tip|important|warning|caution)/);
    return m ? (m[1] as AlertKind) : null;
  };

  const Div = (p: P) => {
    const c = cls(p);
    if (c.includes("math-display")) return <Text style={s.mathDisplay}>{p.children}</Text>;
    const kind = c.includes("markdown-alert") ? alertKindFromClass(c) : null;
    if (kind) {
      const t = theme.alerts[kind];
      return (
        <View style={[s.alert, { borderLeftColor: t.bar, backgroundColor: t.bg }]}>{elementChildren(p.children)}</View>
      );
    }
    // Mermaid or any other div: a plain container.
    return <View style={s.block}>{elementChildren(p.children)}</View>;
  };

  const map: Components = {
    p: Paragraph,
    h1: heading("h1"),
    h2: heading("h2"),
    h3: heading("h3"),
    h4: heading("h4"),
    h5: heading("h5"),
    h6: heading("h6"),
    hr: Hr,
    pre: Pre,
    code: Code,
    blockquote: Blockquote,
    div: Div,
    span: Span,
    ul: makeList(false),
    ol: makeList(true),
    li: Li,
    input: Input,
    label: Label,
    table: Table,
    thead: Thead,
    tbody: Tbody,
    tr: Tr,
    th: Th,
    td: Td,
    section: Section,
    a: A,
    img: Img,
    em: Em,
    strong: Strong,
    del: Del,
    br: Br,
    sup: Sup,
  };
  // Mark the inline wrappers so container components (e.g. <li>) can partition
  // mixed inline/block children without re-deriving each tag.
  for (const t of INLINE_TAGS) {
    const w = map[t];
    if (typeof w === "function") (w as unknown as { __inline?: boolean }).__inline = true;
  }
  return map;
}
