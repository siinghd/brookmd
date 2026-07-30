//! `lenient_lists` — treat a list marker followed by 6+ columns of SPACE
//! padding as the item's text instead of an indented code block.
//!
//! Strict CommonMark §5.2 says: if a marker is followed by ≥ 5 columns of
//! whitespace, the item's content column is marker + width + 1 and everything
//! past it is an indented code block. Models routinely over-indent after a
//! bullet (`-       const value = 1;`), so that rule turns ordinary prose into
//! a code block. The flag raises the cutoff to 6 columns.
//!
//! Cases seeded from the `remarkNormalizeListItemIndentation` plugin t3code
//! ships to rescue the same pattern (`markdown-list-indentation.test.tsx`).
//! Four cases stay strictly conformant BY DESIGN and are pinned below:
//!   1. exactly 5 columns of padding                  (t3code does not fix it)
//!   2. a fence opened on the marker line itself      (t3code does not fix it)
//!   3. indented code starting on a LATER line        (t3code does not fix it)
//!   4. tab-padded markers (`-\t\tfoo`)               (brookmd-specific: keeps
//!      the divergence from CommonMark down to spec example 274 alone)

use brook_md_core::StreamParser;

fn collect(p: &StreamParser) -> String {
    let mut out = String::new();
    for b in p.all_blocks() {
        out.push_str(&b.html);
    }
    out
}

/// Strict (default) render — the flag off.
fn strict(md: &str) -> String {
    let mut p = StreamParser::new();
    p.append(md);
    p.finalize();
    collect(&p)
}

/// Lenient render — the flag on.
fn lenient(md: &str) -> String {
    let mut p = StreamParser::new().with_lenient_lists(true);
    p.append(md);
    p.finalize();
    collect(&p)
}

/// Lenient render, fed one char at a time (streaming path + caches).
fn lenient_streamed(md: &str) -> String {
    let mut p = StreamParser::new().with_lenient_lists(true);
    let mut buf = [0u8; 4];
    for ch in md.chars() {
        p.append(ch.encode_utf8(&mut buf));
    }
    p.finalize();
    collect(&p)
}

// ── 1. off by default: the over-indented item is still a code block ──────────

#[test]
fn off_by_default_over_indented_item_is_code() {
    let html = strict("-       const value = 1;");
    assert!(html.contains("<pre><code>"), "expected a code block, got: {html}");
}

#[test]
fn off_by_default_matches_commonmark_for_the_t3code_corpus() {
    // The exact block from t3code's first test. Strict mode must keep every
    // line a code block — this is the behavior the flag exists to change.
    let md = "why did you do this?\n\n\
              -       for (const step of rest.steps) {\n\
              -           if (step.request.body) {\n\
              -               step.request.body = \"<redacted>\";\n\
              -           }\n\
              -       }";
    let html = strict(md);
    assert!(html.contains("<pre><code>"), "expected code blocks, got: {html}");
    assert!(!html.contains("<li>for (const step of rest.steps) {</li>"));
}

// ── 2. on: the same input becomes item text ──────────────────────────────────

#[test]
fn on_over_indented_item_is_text() {
    let html = lenient("-       const value = 1;");
    assert!(!html.contains("<pre>"), "expected no code block, got: {html}");
    assert!(html.contains("<li>const value = 1;</li>"), "got: {html}");
}

#[test]
fn on_recovers_the_t3code_corpus_as_list_text() {
    let md = "why did you do this?\n\n\
              -       for (const step of rest.steps) {\n\
              -           if (step.request.body) {\n\
              -               step.request.body = \"<redacted>\";\n\
              -           }\n\
              -       }";
    let html = lenient(md);
    assert!(!html.contains("<pre>"), "expected no code block, got: {html}");
    assert!(html.contains("<li>for (const step of rest.steps) {</li>"), "got: {html}");
    assert!(html.contains("<li>if (step.request.body) {</li>"), "got: {html}");
    assert!(
        html.contains("<li>step.request.body = &quot;&lt;redacted&gt;&quot;;</li>"),
        "got: {html}"
    );
}

#[test]
fn on_parses_inline_markdown_in_recovered_text() {
    // t3code: recovered content is real markdown, not preformatted text.
    let html = lenient(
        "-       **important** [docs](https://example.com) use `inline code`, not text",
    );
    assert!(html.contains("<strong>important</strong>"), "got: {html}");
    assert!(html.contains("href=\"https://example.com\""), "got: {html}");
    assert!(html.contains(">docs</a>"), "got: {html}");
    assert!(html.contains("<code>inline code</code>"), "got: {html}");
    assert!(!html.contains("**important**"), "got: {html}");
}

// ── 3. on: exactly 5 columns is still a code block (deliberate non-fix) ──────

#[test]
fn on_exactly_five_spaces_is_still_code() {
    // t3code's "preserves same-line code blocks without excess indentation".
    // 5 columns is the strict §5.2 boundary and stays code in both modes.
    let md = "-     const value = 1;";
    let html = lenient(md);
    assert!(html.contains("<pre><code>"), "expected a code block, got: {html}");
    assert_eq!(html, strict(md), "5-column padding must not depend on the flag");
}

#[test]
fn on_four_columns_is_text_in_both_modes() {
    // Below the strict cutoff entirely — plain item text either way.
    let md = "-    const value = 1;";
    assert_eq!(lenient(md), strict(md));
    assert!(!lenient(md).contains("<pre>"));
}

// ── 4. on: a fence opened on the marker line stays a fence (non-fix) ────────

#[test]
fn on_fenced_code_on_marker_line_is_untouched() {
    let md = "- ```ts\n  const value = 1;\n  ```";
    let html = lenient(md);
    assert!(html.contains("class=\"language-ts\""), "got: {html}");
    assert!(html.contains("const value = 1;"), "got: {html}");
    assert_eq!(html, strict(md), "a fence on the marker line must not depend on the flag");
}

// ── 5. on: indented code starting on a LATER line stays code (non-fix) ──────

#[test]
fn on_indented_code_below_marker_is_still_code() {
    // t3code's "preserves indented code blocks that start below a list marker".
    // The marker line is empty, so `scan_marker` returns on the empty-item path
    // and never consults the flag at all.
    let md = "-\n      const value = 1;";
    let html = lenient(md);
    assert!(html.contains("<pre><code>"), "expected a code block, got: {html}");
    assert_eq!(html, strict(md), "later-line indented code must not depend on the flag");
}

// ── 6. on: multi-line continuation de-indents against the new content column ─

#[test]
fn on_blank_separated_blocks_stay_in_the_item() {
    // t3code's "preserves every recovered block separated by blank lines".
    // `-` + 7 spaces ⇒ content_indent = 8, so the 8-space continuation line is
    // nested content of the item and de-indents to column 0.
    let md = "-       **first block**\n\n        [second block](https://example.com)";
    let html = lenient(md);
    assert!(html.contains("<strong>first block</strong>"), "got: {html}");
    assert!(html.contains("href=\"https://example.com\""), "got: {html}");
    assert!(html.contains(">second block</a>"), "got: {html}");
    assert!(!html.contains("<pre>"), "expected no code block, got: {html}");
}

#[test]
fn on_recursively_normalizes_nested_recovered_lists() {
    // t3code's "recursively normalizes lists in recovered tail blocks" — the
    // nested item is reached through `item_body` + a recursive `scan`, so this
    // only passes if the flag rides along into the sub-scan.
    let md = "-       first block\n\n        -       nested block";
    let html = lenient(md);
    assert!(!html.contains("<pre>"), "expected no code block, got: {html}");
    assert!(html.contains("<li>nested block</li>"), "got: {html}");
}

// ── 7. on: ordered markers behave like bullets ───────────────────────────────

#[test]
fn on_ordered_markers_follow_the_same_rule() {
    for md in ["1.      const value = 1;", "1)      const value = 1;"] {
        let html = lenient(md);
        assert!(!html.contains("<pre>"), "expected no code block for {md:?}, got: {html}");
        assert!(html.contains("<li>const value = 1;</li>"), "for {md:?} got: {html}");
        assert!(html.contains("<ol"), "for {md:?} got: {html}");
    }
    // …and the 5-column boundary holds for ordered markers too. `1.` is 2
    // columns wide, so 5 spaces of padding is still the strict code case.
    for md in ["1.     x", "1)     x"] {
        assert!(lenient(md).contains("<pre><code>"), "expected code for {md:?}");
        assert_eq!(lenient(md), strict(md), "5-column padding changed for {md:?}");
    }
}

// ── 8. on: the flag reaches nested parsers (blockquote / nested item) ────────

#[test]
fn on_inside_a_blockquote() {
    let md = "> -       const value = 1;";
    let html = lenient(md);
    assert!(html.contains("<blockquote>"), "got: {html}");
    assert!(!html.contains("<pre>"), "expected no code block, got: {html}");
    assert!(html.contains("<li>const value = 1;</li>"), "got: {html}");
    // …and strict mode still produces the code block inside the quote.
    assert!(strict(md).contains("<pre><code>"), "strict changed: {}", strict(md));
}

#[test]
fn on_inside_a_nested_list_item() {
    let md = "- outer\n\n  -       const value = 1;";
    let html = lenient(md);
    assert!(!html.contains("<pre>"), "expected no code block, got: {html}");
    assert!(html.contains("<li>const value = 1;</li>"), "got: {html}");
    assert!(strict(md).contains("<pre><code>"), "strict changed: {}", strict(md));
}

#[test]
fn on_inside_a_blockquoted_nested_list() {
    // Two container levels — quote → outer item → recovered inner item.
    let md = "> - outer\n>\n>   -       const value = 1;";
    let html = lenient(md);
    assert!(html.contains("<blockquote>"), "got: {html}");
    assert!(!html.contains("<pre>"), "expected no code block, got: {html}");
    assert!(html.contains("<li>const value = 1;</li>"), "got: {html}");
}

// ── 9. streaming byte-by-byte == one-shot, with the flag on ─────────────────

#[test]
fn streaming_matches_one_shot() {
    let cases = [
        "-       const value = 1;",
        "-       const value = 1;\n",
        "-     const value = 1;\n",
        "-\t\tfoo\n",
        "- a\n-       b\n- c\n",
        "1.      indented code\n\n   paragraph\n\n       more code\n",
        "-       **first block**\n\n        [second block](https://example.com)\n",
        "-       first block\n\n        -       nested block\n",
        "> -       const value = 1;\n",
        "- outer\n\n  -       const value = 1;\n",
        "-       for (const step of rest.steps) {\n-           if (x) {\n-       }\n",
        "- ```ts\n  const value = 1;\n  ```\n",
        "-\n      const value = 1;\n",
        "-       a\n\n        b\n\n-       c\n",
    ];
    for md in cases {
        assert_eq!(lenient_streamed(md), lenient(md), "streaming != one-shot for {md:?}");
    }
}

// ── 10. the tab non-fix, and the one pinned CommonMark divergence ───────────

#[test]
fn on_tab_padded_marker_is_still_code() {
    // CommonMark example 7. Two tabs expand to 7 columns — over the 6-column
    // threshold — but tab padding never takes the lenient path, so this stays
    // byte-identical to strict mode (and to the spec).
    let md = "-\t\tfoo\n";
    let html = lenient(md);
    assert!(html.contains("<pre><code>"), "expected a code block, got: {html}");
    assert_eq!(html, strict(md), "tab-padded markers must not depend on the flag");
}

#[test]
fn on_mixed_tab_and_space_padding_is_still_code() {
    // Any tab anywhere in the padding keeps the strict path.
    for md in ["-  \t    foo\n", "-\t     foo\n", "-      \tfoo\n"] {
        assert_eq!(lenient(md), strict(md), "mixed padding changed for {md:?}");
    }
}

#[test]
fn commonmark_example_274_diverges_by_design() {
    // The ONE spec example this flag changes. Strict mode keeps the §5.2
    // reading (a code block, one leading space preserved); lenient mode reads
    // the 6 spaces as padding and the text as the item's own paragraph.
    // Pinned so the divergence stays a documented contract.
    let md = "1.      indented code\n\n   paragraph\n\n       more code\n";

    let strict_html = strict(md);
    assert!(strict_html.contains("<pre><code> indented code"), "strict: {strict_html}");

    let lenient_html = lenient(md);
    assert!(lenient_html.contains("<li>indented code</li>"), "lenient: {lenient_html}");
    assert!(!lenient_html.contains("<code> indented code"), "lenient: {lenient_html}");
    // The trailing blocks fall out of the list (indented less than the item's
    // content column, after a blank line) and become top-level blocks. Matched
    // loosely: their leading indent is preserved by brookmd's paragraph /
    // indented-code renderers independently of this flag.
    assert!(lenient_html.contains("paragraph</p>"), "lenient: {lenient_html}");
    assert!(lenient_html.contains("more code"), "lenient: {lenient_html}");
}

#[test]
fn commonmark_example_273_does_not_diverge() {
    // The neighbouring 5-space example — strictly below the threshold, so it
    // must render identically in both modes (and stay spec-correct).
    let md = "1.     indented code\n\n   paragraph\n\n       more code\n";
    assert_eq!(lenient(md), strict(md));
    assert!(lenient(md).contains("<pre><code>indented code"), "got: {}", lenient(md));
}
