//! GFM tables nested inside a list item (and inside a blockquote), where the
//! container's own first line is an open paragraph the table has to interrupt.
//!
//! A list item's body is de-indented and re-scanned as a mini-document, so
//! `- item` + a table underneath scans as `paragraph("item")` followed by the
//! table lines. `scan_paragraph` used to swallow those lines whole — a GFM table
//! could only ever open at a COLD block start — so the item rendered as literal
//! text with raw pipes. The same gap hit `> item` + a table (and a plain
//! top-level paragraph + a table); only the shapes where the table was the
//! container's FIRST block worked, which is why the byte-exact spec suites
//! (every table fixture is top-level and standalone) never caught it.
//!
//! Pinned here, against GitHub's own rendering:
//!   - a delimiter row under a pipe-carrying line ends the paragraph one line
//!     early and opens the table — in a tight item, a loose item, an ordered
//!     item, a nested sub-item, and a blockquote inside an item
//!   - a lone pipe line with NO delimiter row underneath is still a paragraph
//!   - a lazy (under-indented) continuation line NEVER forms a table: it is
//!     re-emitted at `LAZY_INDENT` (4 columns), and neither table row may be
//!     indented 4+ (that is indented code)
//!   - streamed == one-shot == finalize at every prefix
//!   - a nested table carries NO structured `block_data` (the nested-parser
//!     precedent: `make_nested_parser` sets `block_data = false`)

use brook_md_core::blocks::BlockKind;
use brook_md_core::StreamParser;

fn collect(p: &StreamParser) -> String {
    let mut out = String::new();
    for b in p.all_blocks() {
        out.push_str(&b.html);
    }
    out
}

fn render(md: &str) -> String {
    let mut p = StreamParser::new();
    p.append(md);
    p.finalize();
    collect(&p)
}

/// Streamed == one-shot at EVERY prefix, open and finalized: char-by-char (plus
/// a trailing empty append so a freshly-armed cache gets to fire) and every
/// 2-chunk split. Same contract as `midstream_parity.rs`'s `assert_sweep`.
fn assert_sweep(md: &str) {
    let one_open = {
        let mut p = StreamParser::new();
        p.append(md);
        collect(&p)
    };
    {
        let mut p = StreamParser::new();
        let mut buf = [0u8; 4];
        for ch in md.chars() {
            p.append(ch.encode_utf8(&mut buf));
        }
        p.append("");
        assert_eq!(collect(&p), one_open, "char-stream open != one-shot for {md:?}");
    }
    let one_final = render(md);
    for cut in 1..md.len() {
        if !md.is_char_boundary(cut) {
            continue;
        }
        let mut p = StreamParser::new();
        p.append(&md[..cut]);
        p.append(&md[cut..]);
        assert_eq!(collect(&p), one_open, "2-chunk open split at {cut} != one-shot for {md:?}");
        p.finalize();
        assert_eq!(collect(&p), one_final, "2-chunk finalize split at {cut} != one-shot for {md:?}");
    }
}

const TABLE_2X1: &str = "<table>\n\
    <thead>\n<tr>\n<th>a</th>\n<th>b</th>\n</tr>\n</thead>\n\
    <tbody>\n<tr>\n<td>1</td>\n<td>2</td>\n</tr>\n</tbody>\n\
    </table>";

#[test]
fn table_in_tight_item() {
    // The flagship shape. Tight ⇒ the item's paragraph is inline text glued to
    // `<li>`, and the table is a block child bracketed by newlines.
    let md = "- item\n  | a | b |\n  |---|---|\n  | 1 | 2 |\n";
    assert_eq!(render(md), format!("<ul>\n<li>item\n{TABLE_2X1}\n</li>\n</ul>"));
    assert_sweep(md);
}

#[test]
fn table_in_loose_item() {
    // A blank line between the text and the table makes the item loose: the
    // paragraph gets its own `<p>`. This shape already worked (the table was a
    // cold block start after the blank) — pinned so the fix can't regress it.
    let md = "- item\n\n  | a | b |\n  |---|---|\n  | 1 | 2 |\n";
    assert_eq!(render(md), format!("<ul>\n<li>\n<p>item</p>\n{TABLE_2X1}\n</li>\n</ul>"));
    assert_sweep(md);
}

#[test]
fn table_in_ordered_item() {
    let md = "1. item\n   | a | b |\n   |---|---|\n   | 1 | 2 |\n";
    assert_eq!(render(md), format!("<ol>\n<li>item\n{TABLE_2X1}\n</li>\n</ol>"));
    assert_sweep(md);
}

#[test]
fn table_as_items_first_block_still_works() {
    // No preceding paragraph — the table is the item's cold block start. This
    // was never broken; it is the control that localizes the bug to the
    // paragraph-interrupt path.
    let md = "- | a | b |\n  |---|---|\n  | 1 | 2 |\n";
    assert_eq!(render(md), format!("<ul>\n<li>\n{TABLE_2X1}\n</li>\n</ul>"));
    assert_sweep(md);
}

#[test]
fn table_in_nested_sub_item() {
    // The item body is re-scanned recursively, so the fix reaches arbitrarily
    // deep nesting with no extra machinery.
    let md = "- outer\n  - inner\n    | a | b |\n    |---|---|\n";
    let out = render(md);
    assert!(
        out.contains("<li>inner\n<table>\n<thead>\n<tr>\n<th>a</th>"),
        "table opens inside the nested item: {out}"
    );
    assert!(!out.contains("|---|"), "no raw delimiter row survives: {out}");
    assert_sweep(md);
}

#[test]
fn table_in_blockquote_in_list() {
    // Blockquote inside an item, table inside the blockquote — three levels of
    // de-indent-and-re-scan. Both with and without a leading text line (the
    // no-text form already worked; the text form is the bug's blockquote twin).
    let md = "- item\n  > | a | b |\n  > |---|---|\n";
    let out = render(md);
    assert!(
        out.contains("<blockquote>\n<table>\n<thead>\n<tr>\n<th>a</th>"),
        "table opens inside the quoted item: {out}"
    );
    assert_sweep(md);

    let md = "- item\n  > note\n  > | a | b |\n  > |---|---|\n";
    let out = render(md);
    assert!(
        out.contains("<blockquote>\n<p>note</p>\n<table>"),
        "the quote's own paragraph yields to the table: {out}"
    );
    assert_sweep(md);
}

#[test]
fn table_in_plain_blockquote_and_at_top_level() {
    // The item path shares `scan_paragraph` with every other container, so the
    // same fix lands for a bare blockquote and for a plain top-level paragraph.
    let md = "> item\n> | a | b |\n> |---|---|\n> | 1 | 2 |\n";
    assert_eq!(render(md), format!("<blockquote>\n<p>item</p>\n{TABLE_2X1}\n</blockquote>"));
    assert_sweep(md);

    let md = "item\n| a | b |\n|---|---|\n| 1 | 2 |\n";
    assert_eq!(render(md), format!("<p>item</p>{TABLE_2X1}"));
    assert_sweep(md);
}

#[test]
fn table_then_paragraph_in_same_item() {
    // A blank line after the table reopens the item body for a second block —
    // and makes the item loose, so the leading text gets a `<p>` too.
    let md = "- item\n  | a | b |\n  |---|---|\n  | 1 | 2 |\n\n  after\n";
    assert_eq!(
        render(md),
        format!("<ul>\n<li>\n<p>item</p>\n{TABLE_2X1}\n<p>after</p>\n</li>\n</ul>")
    );
    assert_sweep(md);
}

#[test]
fn pipe_paragraph_without_delimiter_row_stays_a_paragraph() {
    // A table REQUIRES a delimiter row. Pipe-rich prose in an item must not be
    // promoted — and neither must a header whose cell count disagrees with the
    // delimiter (GFM example 203, here nested in an item).
    let md = "- item\n  | a | b |\n  | 1 | 2 |\n";
    assert_eq!(render(md), "<ul>\n<li>item\n| a | b |\n| 1 | 2 |</li>\n</ul>");
    assert_sweep(md);

    let md = "- item\n  | abc | def |\n  | --- |\n  | bar |\n";
    let out = render(md);
    assert!(!out.contains("<table>"), "column-count mismatch is not a table: {out}");
    assert_sweep(md);

    // A pipe line with nothing under it at all.
    let md = "- item\n  | a | b |\n";
    assert_eq!(render(md), "<ul>\n<li>item\n| a | b |</li>\n</ul>");
    assert_sweep(md);
}

#[test]
fn lazy_under_indented_rows_never_form_a_table() {
    // Lazy continuation lines are re-emitted at `LAZY_INDENT` (4 columns) so a
    // re-scan can open no block there — and 4+ columns is indented code, which
    // no table row may sit at. All three under-indented shapes stay paragraphs.
    for md in [
        // both rows lazy (column 0)
        "- item\n| a | b |\n|---|---|\n| 1 | 2 |\n",
        // both rows lazy (one space, still under the content column)
        "- item\n | a | b |\n |---|---|\n | 1 | 2 |\n",
        // properly-indented header, lazy delimiter
        "- item\n  | a | b |\n|---|---|\n",
        // lazy header, properly-indented delimiter
        "- item\n| a | b |\n  |---|---|\n",
    ] {
        let out = render(md);
        assert!(!out.contains("<table>"), "lazy row must not open a table for {md:?}: {out}");
        assert!(out.contains("|---|"), "the pipes stay literal for {md:?}: {out}");
        assert_sweep(md);
    }

    // The same rule at top level: a delimiter row indented 4+ is indented code
    // territory, so it cannot promote the line above it.
    let out = render("item\n| a | b |\n    |---|---|\n");
    assert!(!out.contains("<table>"), "4-column delimiter row is not a table: {out}");
    // …but 3 columns of indent is fine.
    let out = render("item\n| a | b |\n   |---|---|\n");
    assert!(out.contains("<table>"), "3-column delimiter row still opens a table: {out}");
}

#[test]
fn alignment_row_variants() {
    // Every delimiter spelling GFM allows, nested in a tight item: colons on
    // either side, bare dashes, and a pipe-less delimiter row (spec example 199).
    let md = "- item\n  | a | b | c |\n  | :-- | :-: | --: |\n  | 1 | 2 | 3 |\n";
    let out = render(md);
    assert!(out.contains("<th style=\"text-align:left\">a</th>"), "{out}");
    assert!(out.contains("<th style=\"text-align:center\">b</th>"), "{out}");
    assert!(out.contains("<th style=\"text-align:right\">c</th>"), "{out}");
    assert!(out.contains("<td style=\"text-align:center\">2</td>"), "{out}");
    assert_sweep(md);

    // Un-piped edges on both the header and the delimiter row.
    let md = "- item\n  a | b\n  --- | ---\n  1 | 2\n";
    assert_eq!(render(md), format!("<ul>\n<li>item\n{TABLE_2X1}\n</li>\n</ul>"));
    assert_sweep(md);

    // A header-only table (no body rows) inside an item.
    let md = "- item\n  | a | b |\n  |---|---|\n";
    assert_eq!(
        render(md),
        "<ul>\n<li>item\n<table>\n<thead>\n<tr>\n<th>a</th>\n<th>b</th>\n</tr>\n</thead>\n</table>\n</li>\n</ul>"
    );
    assert_sweep(md);
}

#[test]
fn a_pipe_carrying_block_start_still_wins() {
    // The delimiter probe runs AFTER the other block starts, so a line that
    // opens its own block is never stolen as a table header even when it has
    // matching pipes.
    let out = render("para\n# a | b |\n|---|---|\n");
    assert!(out.contains("<h1>"), "the ATX heading still wins: {out}");
    assert!(!out.contains("<table>"), "no table steals the heading line: {out}");

    // A setext underline is not a delimiter row (no pipe), so it still wins.
    assert_eq!(render("item\n| a |\n---\n"), "<h2>item\n| a |</h2>");
}

#[test]
fn nested_table_carries_no_structured_block_data() {
    // PINNED DECISION: a table nested inside a list item emits NO structured
    // table data — it lives only in the item's `html`. This is the nested-list
    // precedent, not an oversight: `make_nested_parser` sets `block_data =
    // false`, so nothing rendered through a container's inner document reports
    // structured children. A consumer that needs the cells parses the top-level
    // document, where a table DOES carry `TableData`.
    let mut p = StreamParser::new().with_block_data(true);
    p.append("- item\n  | a | b |\n  |---|---|\n  | 1 | 2 |\n");
    p.finalize();

    let mut saw_table_data = false;
    let mut item_html = Vec::new();
    for b in p.all_blocks() {
        match &b.kind {
            BlockKind::Table(Some(_)) => saw_table_data = true,
            BlockKind::List { items, .. } => {
                item_html.extend(items.iter().map(|it| it.html.clone()))
            }
            _ => {}
        }
    }
    assert!(!saw_table_data, "a nested table must not surface TableData");
    assert_eq!(item_html.len(), 1, "one item's inner html is reported");
    assert!(item_html[0].contains("<table>"), "the table lives in the item html: {item_html:?}");

    // The control: the SAME table at top level does carry structured data, so
    // the absence above is about nesting, not about the table renderer.
    let mut p = StreamParser::new().with_block_data(true);
    p.append("| a | b |\n|---|---|\n| 1 | 2 |\n");
    p.finalize();
    assert!(
        p.all_blocks().any(|b| matches!(&b.kind, BlockKind::Table(Some(_)))),
        "a top-level table still carries TableData"
    );
}

#[test]
fn lenient_lists_on_and_off_agree() {
    let cases: &[&str] = &[
        "- item\n  | a | b |\n  |---|---|\n  | 1 | 2 |\n",
        "1. item\n   | a | b |\n   |---|---|\n",
        "- item\n| a | b |\n|---|---|\n",
        "- item\n  | a | b |\n  | 1 | 2 |\n",
    ];
    for md in cases {
        let mut on = StreamParser::new().with_lenient_lists(true);
        on.append(md);
        on.finalize();
        let mut off = StreamParser::new().with_lenient_lists(false);
        off.append(md);
        off.finalize();
        assert_eq!(
            collect(&on),
            collect(&off),
            "lenient_lists must not change these shapes for {md:?}"
        );
    }

    // A marker with 6 columns of padding: strict CommonMark keeps one column
    // and makes the rest indented code, `lenient_lists` treats the whole run as
    // padding. Under lenient the body's content column is 7, so a table at
    // column 7 is nested content and must open — the fix rides the item's
    // content indent, whatever `lenient_lists` decided it is.
    let md = "-      item\n       | a | b |\n       |---|---|\n       | 1 | 2 |\n";
    let mut on = StreamParser::new().with_lenient_lists(true);
    on.append(md);
    on.finalize();
    assert_eq!(collect(&on), format!("<ul>\n<li>item\n{TABLE_2X1}\n</li>\n</ul>"));

    let mut off = StreamParser::new().with_lenient_lists(false);
    off.append(md);
    off.finalize();
    assert!(
        collect(&off).contains("<pre><code>"),
        "strict §5.2 still reads the padded run as indented code"
    );
}
