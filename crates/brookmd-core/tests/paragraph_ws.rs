//! Paragraph whitespace — CommonMark §4.8: a paragraph's raw content is its
//! lines "with initial and final spaces or tabs removed", and the remaining
//! internal newlines are soft breaks.
//!
//! Three rules, pinned here byte-exactly because the spec fixtures leave the
//! tab cases open:
//!   1. every line's LEADING spaces/tabs are dropped — the first line at render
//!      entry (`render_inline_para`), continuation lines by the break arms;
//!   2. every line's FINAL spaces/tabs are dropped before a soft break;
//!   3. a hard break (2+ trailing spaces, or a trailing `\`) still wins over
//!      rule 2, and the line after it sheds its indent like any other.
//!
//! # The trim set: spaces AND tabs
//!
//! No spec fixture puts a tab in either position (222/223/224/113/49 are all
//! spaces; 636/637/649 likewise), so the choice is pinned here. Tabs are IN the
//! set, on two independent grounds: the spec's own wording is "spaces or tabs"
//! in both places, and the reference implementation agrees — cmark rtrims a
//! text run that ends at a newline with `cmark_chunk_rtrim` (space and tab
//! among its whitespace class) and skips the next line's indent with
//! `skip_spaces`, which advances over `' '` and `'\t'` alike. Note a tab can
//! only ever appear as a CONTINUATION line's indent or a line's trailing run:
//! one leading tab is 4 columns, which makes the first line indented code
//! rather than a paragraph.

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

fn render_soft(md: &str) -> String {
    let mut p = StreamParser::new().with_soft_breaks(true);
    p.append(md);
    p.finalize();
    collect(&p)
}

/// One-shot, char-by-char and every 2-chunk split must agree — the whitespace
/// rules run inside the inline renderer, whose settled-prefix cut is exactly
/// what these shapes stress.
fn assert_chunk_parity(md: &str) {
    let one = render(md);
    let mut p = StreamParser::new();
    let mut buf = [0u8; 4];
    for ch in md.chars() {
        p.append(ch.encode_utf8(&mut buf));
    }
    p.finalize();
    assert_eq!(collect(&p), one, "char-stream != one-shot for {md:?}");
    for cut in 1..md.len() {
        if !md.is_char_boundary(cut) {
            continue;
        }
        let mut q = StreamParser::new();
        q.append(&md[..cut]);
        q.append(&md[cut..]);
        q.finalize();
        assert_eq!(collect(&q), one, "2-chunk split at {cut} != one-shot for {md:?}");
    }
}

// ── 1. leading spaces/tabs ───────────────────────────────────────────────────

#[test]
fn leading_whitespace_is_stripped_from_every_line() {
    // Examples 222, 224.
    assert_eq!(render("  aaa\n bbb\n"), "<p>aaa\nbbb</p>");
    assert_eq!(render("   aaa\nbbb\n"), "<p>aaa\nbbb</p>");
    // Example 223 — a continuation line's indent is unbounded (indented code
    // cannot interrupt a paragraph).
    assert_eq!(
        render("aaa\n             bbb\n                                       ccc\n"),
        "<p>aaa\nbbb\nccc</p>"
    );
    // Examples 49, 87, 113 — the indent survives long enough to keep the line
    // out of block scanning, then disappears at render.
    assert_eq!(render("Foo\n    ***\n"), "<p>Foo\n***</p>");
    assert_eq!(render("Foo\n    ---\n"), "<p>Foo\n---</p>");
    assert_eq!(render("Foo\n    bar\n\n"), "<p>Foo\nbar</p>");
    // TABS in a continuation indent (trim-set decision — see the module docs).
    assert_eq!(render("aaa\n\tbbb\n"), "<p>aaa\nbbb</p>");
    assert_eq!(render("aaa\n \t bbb\n"), "<p>aaa\nbbb</p>");
    // A leading tab on the FIRST line is 4 columns — indented code, not a
    // paragraph. The rule never applies there.
    assert_eq!(render("\taaa\n"), "<pre><code>aaa\n</code></pre>");
}

#[test]
fn leading_whitespace_strip_does_not_reach_inside_content() {
    // Only the line's own indent goes; inter-word runs are content.
    assert_eq!(render("  a  b\n c  d\n"), "<p>a  b\nc  d</p>");
    // Nothing is stripped inside a code span.
    assert_eq!(render("  `a   b`\n"), "<p><code>a   b</code></p>");
    // KNOWN GAP (unchanged by these rules, no spec fixture covers it): a code
    // span that STRADDLES a line break keeps the continuation line's indent,
    // because the stripping happens at emission time and the code-span arm
    // consumes its own bytes verbatim. cmark, which de-indents the paragraph's
    // raw content before inline parsing, would render `<code>a b</code>`.
    // Closing it means teaching the code-span arm the same skip — a
    // code-content change, out of scope here.
    assert_eq!(render("x `a\n   b` y\n"), "<p>x <code>a    b</code> y</p>");
}

// ── 2. final spaces/tabs before a soft break ─────────────────────────────────

#[test]
fn trailing_whitespace_before_a_soft_break_is_dropped() {
    // Example 649 (both rules at once).
    assert_eq!(render("foo \n baz\n"), "<p>foo\nbaz</p>");
    // Examples 556 / 587 — the run follows a closed construct, not plain text.
    assert_eq!(
        render("[foo] \n[]\n\n[foo]: /url \"title\"\n"),
        "<p><a href=\"/url\" title=\"title\" target=\"_blank\" \
         rel=\"noopener noreferrer nofollow\">foo</a>\n[]</p>"
    );
    // TABS (trim-set decision), alone and mixed with spaces.
    assert_eq!(render("foo\t\nbaz\n"), "<p>foo\nbaz</p>");
    assert_eq!(render("foo \t \nbaz\n"), "<p>foo\nbaz</p>");
    // A single trailing space is never a hard break, in any mode.
    assert_eq!(render_soft("foo \nbaz\n"), "<p>foo<br>\nbaz</p>");
    // The final line's trailing whitespace was already stripped; keep it so.
    assert_eq!(render("foo \n"), "<p>foo</p>");
    assert_eq!(render("foo\t\n"), "<p>foo</p>");
}

// ── 3. hard breaks are unaffected ────────────────────────────────────────────

#[test]
fn hard_breaks_survive_and_shed_the_next_indent() {
    // Examples 636 / 637.
    assert_eq!(render("foo  \n     bar\n"), "<p>foo<br>\nbar</p>");
    assert_eq!(render("foo\\\n     bar\n"), "<p>foo<br>\nbar</p>");
    // More than two spaces is still one hard break.
    assert_eq!(render("foo     \nbar\n"), "<p>foo<br>\nbar</p>");
    // Whitespace to the LEFT of the break's own spaces is line-final too.
    assert_eq!(render("foo\t  \nbar\n"), "<p>foo<br>\nbar</p>");
    // A tab is not a hard break: `\t` before `\n` is trailing whitespace.
    assert_eq!(render("foo\t\t\nbar\n"), "<p>foo\nbar</p>");
    // Inside emphasis, and with the break at a construct edge.
    assert_eq!(render("*foo  \n  bar*\n"), "<p><em>foo<br>\nbar</em></p>");
    // `soft_breaks` on: both kinds are `<br>`, and the indent still goes.
    assert_eq!(render_soft("foo  \n     bar\n"), "<p>foo<br>\nbar</p>");
    assert_eq!(render_soft("foo\\\n     bar\n"), "<p>foo<br>\nbar</p>");
}

// ── containers: the lazy continuation keeps its own line ─────────────────────

#[test]
fn lazy_continuations_keep_the_newline() {
    // Examples 247, 233, 232 — a lazy line is a soft break, not a space.
    assert_eq!(render("> bar\nbaz\n"), "<blockquote>\n<p>bar\nbaz</p>\n</blockquote>");
    assert_eq!(
        render("> bar\nbaz\n> foo\n"),
        "<blockquote>\n<p>bar\nbaz\nfoo</p>\n</blockquote>"
    );
    // Example 93 / 238 — a lazy line that LOOKS like a block start is still
    // paragraph text (and its indent is invisible).
    assert_eq!(
        render("> foo\nbar\n===\n"),
        "<blockquote>\n<p>foo\nbar\n===</p>\n</blockquote>"
    );
    assert_eq!(render("> foo\n    - bar\n"), "<blockquote>\n<p>foo\n- bar</p>\n</blockquote>");
    // Examples 291 / 312 — the same rule one list level down.
    assert_eq!(
        render("  1.  A paragraph\n    with two lines.\n"),
        "<ol>\n<li>A paragraph\nwith two lines.</li>\n</ol>"
    );
    assert_eq!(
        render("- a\n - b\n  - c\n   - d\n    - e\n"),
        "<ul>\n<li>a</li>\n<li>b</li>\n<li>c</li>\n<li>d\n- e</li>\n</ul>"
    );
    // Example 250 — nested quotes each re-emit the lazy line.
    assert_eq!(
        render("> > > foo\nbar\n"),
        "<blockquote>\n<blockquote>\n<blockquote>\n<p>foo\nbar</p>\n\
         </blockquote>\n</blockquote>\n</blockquote>"
    );
}

// ── streaming parity ─────────────────────────────────────────────────────────

#[test]
fn whitespace_rules_hold_under_every_chunking() {
    for md in [
        "  aaa\n bbb\n",
        "aaa\n             bbb\n                                       ccc\n",
        "Foo\n    ***\n",
        "aaa\n \t bbb\n",
        "foo \n baz\n",
        "foo \t \nbaz\n",
        "foo  \n     bar\n",
        "foo\\\n     bar\n",
        "*foo  \n  bar*\n",
        "  one two three four\n   five six seven eight\n  nine ten\n",
        "> bar\nbaz\n> foo\n",
        "> foo\n    - bar\n",
        "- item one\n  cont\nlazy\n",
        "  1.  A paragraph\n    with two lines.\n",
    ] {
        assert_chunk_parity(md);
    }
}
