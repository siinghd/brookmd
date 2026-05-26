//! GFM footnotes (gated on gfm_footnotes). References render speculatively
//! (committed blocks freeze), the section is emitted at finalize, numbering is
//! by first-reference order and stable across streaming.

use flux_md_core::StreamParser;

fn render(md: &str) -> String {
    let mut p = StreamParser::new().with_gfm_footnotes(true);
    p.append(md);
    p.finalize();
    collect(&p)
}

fn render_streamed(md: &str) -> String {
    let mut p = StreamParser::new().with_gfm_footnotes(true);
    for ch in md.chars() {
        let mut buf = [0u8; 4];
        p.append(ch.encode_utf8(&mut buf));
    }
    p.finalize();
    collect(&p)
}

fn collect(p: &StreamParser) -> String {
    let mut out = String::new();
    for b in p.all_blocks() {
        out.push_str(&b.html);
    }
    out
}

#[test]
fn basic_reference_and_definition() {
    let out = render("Text[^1].\n\n[^1]: A note.\n");
    assert!(
        out.contains("<sup class=\"footnote-ref\"><a href=\"#fn-1\" id=\"fnref-1\">1</a></sup>"),
        "ref: {out}"
    );
    assert!(out.contains("<section class=\"footnotes\""), "section: {out}");
    assert!(out.contains("<li id=\"fn-1\">A note."), "def: {out}");
    assert!(out.contains("href=\"#fnref-1\""), "backref: {out}");
    // The definition line must NOT render as a paragraph.
    assert!(!out.contains("<p>[^1]:"), "def leaked as paragraph: {out}");
    assert!(!out.contains("[^1]: A note."), "raw def text leaked: {out}");
}

#[test]
fn numbered_by_reference_order_not_definition_order() {
    // [^b] is referenced first → 1; [^a] second → 2, regardless of def order.
    let out = render("First [^b] then [^a].\n\n[^a]: Apple\n\n[^b]: Banana\n");
    assert!(out.contains("#fn-1\" id=\"fnref-1\">1</a></sup> then"), "b should be 1: {out}");
    assert!(out.contains("id=\"fnref-2\">2</a></sup>."), "a should be 2: {out}");
    // Section ordered by number: 1 = Banana (b), 2 = Apple (a).
    let one = out.find("<li id=\"fn-1\">Banana").unwrap();
    let two = out.find("<li id=\"fn-2\">Apple").unwrap();
    assert!(one < two, "section order: {out}");
}

#[test]
fn repeated_reference_same_label_reuses_number() {
    let out = render("[^1] and [^1] again.\n\n[^1]: once.\n");
    let refs = out.matches("href=\"#fn-1\"").count();
    assert!(refs >= 2, "both refs link to fn-1: {out}");
    // Only one definition item.
    assert_eq!(out.matches("<li id=\"fn-1\">").count(), 1, "one def item: {out}");
    assert!(!out.contains("fn-2"), "no second footnote: {out}");
}

#[test]
fn definition_before_reference() {
    let out = render("[^1]: Defined first.\n\nThen [^1].\n");
    assert!(out.contains("id=\"fnref-1\">1</a></sup>"), "ref renders: {out}");
    assert!(out.contains("<li id=\"fn-1\">Defined first."), "def: {out}");
}

#[test]
fn dangling_reference_without_definition_is_honest() {
    // Speculative render (streaming can't see the future); empty section item.
    let out = render("See [^x].\n");
    assert!(out.contains("id=\"fnref-1\">1</a></sup>"), "still renders a ref: {out}");
    assert!(out.contains("<li id=\"fn-1\">"), "empty section item exists: {out}");
}

#[test]
fn unreferenced_definition_is_omitted() {
    let out = render("Just text.\n\n[^unused]: nobody references me.\n");
    assert!(!out.contains("<section class=\"footnotes\""), "no section when no refs: {out}");
    assert!(!out.contains("nobody references me"), "unused def not rendered: {out}");
}

#[test]
fn off_by_default_renders_literal() {
    let mut p = StreamParser::new(); // footnotes OFF
    p.append("Text[^1].\n\n[^1]: A note.\n");
    p.finalize();
    let out = collect(&p);
    assert!(!out.contains("footnote-ref"), "no footnote markup when off: {out}");
    assert!(out.contains("[^1]"), "ref stays literal: {out}");
}

#[test]
fn streaming_converges_to_oneshot() {
    // The numbering-stability contract: committed <sup>N</sup> must match a
    // one-shot parse even when fed one character at a time.
    for md in [
        "Body [^1] and [^2].\n\n[^1]: first\n\n[^2]: second\n",
        "Para one [^a].\n\nPara two [^b] and [^a] again.\n\n[^a]: AA\n\n[^b]: BB\n",
        "No defs here [^x] [^y].\n",
    ] {
        assert_eq!(render_streamed(md), render(md), "diverged for {md:?}");
    }
}

#[test]
fn repeated_references_get_unique_ids() {
    let out = render("[^a] foo [^a] bar [^a].\n\n[^a]: note.\n");
    // Each of the three references to the same label gets a unique id.
    assert!(out.contains("id=\"fnref-1\""), "1st ref id: {out}");
    assert!(out.contains("id=\"fnref-1-2\""), "2nd ref id: {out}");
    assert!(out.contains("id=\"fnref-1-3\""), "3rd ref id: {out}");
    // No duplicate plain fnref-1 id (would be 1 occurrence: the first).
    assert_eq!(out.matches("id=\"fnref-1\"").count(), 1, "no duplicate fnref-1: {out}");
}

#[test]
fn section_has_one_backref_per_reference() {
    let out = render("[^a] and [^a] again.\n\n[^a]: note.\n");
    // Find the section, count backrefs in it.
    let sec = &out[out.find("<section").unwrap()..];
    assert!(sec.contains("href=\"#fnref-1\""), "backref 1: {sec}");
    assert!(sec.contains("href=\"#fnref-1-2\""), "backref 2: {sec}");
    assert_eq!(sec.matches("class=\"footnote-backref\"").count(), 2, "exactly 2 backrefs: {sec}");
}

#[test]
fn repeated_references_converge_under_streaming() {
    // Cross-boundary occurrence stability: a [^a] that commits, then more [^a]
    // in the tail, must keep continuing ids (1, 1-2, 1-3), not restart.
    for md in [
        "[^a] foo [^a] bar [^a].\n\n[^a]: x\n",
        "First [^a].\n\nThen [^a] and [^b] and [^a].\n\n[^a]: A\n\n[^b]: B\n",
    ] {
        assert_eq!(render_streamed(md), render(md), "diverged for {md:?}");
    }
}

#[test]
fn adjacent_definitions_without_blank_lines() {
    // GitHub allows footnote defs on consecutive lines; the scanner groups them
    // into one paragraph block, so the extractor must split them.
    let md = "See [^a] and [^b].\n\n[^a]: First note.\n[^b]: Second note.\n";
    let out = render(md);
    assert!(out.contains("<li id=\"fn-1\">First note."), "def a: {out}");
    assert!(out.contains("<li id=\"fn-2\">Second note."), "def b: {out}");
    // Exactly two reference sups in the body (no third from a swallowed def).
    assert_eq!(out.matches("class=\"footnote-ref\"").count(), 2, "exactly 2 refs: {out}");
    assert_eq!(render_streamed(md), out, "streaming diverged");
}
