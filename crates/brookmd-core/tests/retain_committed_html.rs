//! `retain_committed_html` (default ON): the opt-out that lets a pure streaming
//! consumer stop retaining committed blocks' rendered HTML.
//!
//! The contract this file pins:
//!   1. the WIRE is untouched — every patch (append AND finalize) is byte-identical
//!      with the flag off, because a committed block crosses the boundary exactly
//!      once, in the patch that commits it, and never gets re-read out of the
//!      parser;
//!   2. `all_blocks()` then yields committed blocks with an EMPTY `html` and
//!      otherwise EXACT metadata — it must never panic;
//!   3. `retained_bytes()` reflects the release (plateau vs. growth);
//!   4. the drop happens AFTER every commit-time rewrite (footnote id/backref
//!      resolution, the finalize-time footnote section), so footnote output is
//!      identical too.

use brook_md_core::{Block, Patch, StreamParser};

const MIXED: &str = concat!(
    "# Heading\n\nA paragraph with *emphasis*, a [link](https://example.com) and `code`.\n\n",
    "- one\n- two\n- three\n\n",
    "```rust\nfn main() { println!(\"hi\"); }\n```\n\n",
    "> A quote.\n> Still quoting.\n\n",
    "| a | b |\n| - | - |\n| 1 | 2 |\n\n",
    "Another paragraph, closing things out.\n\n",
);

/// Serialize a patch to a comparable string — the same fields the wire carries.
fn patch_repr(p: &Patch) -> String {
    let mut s = String::new();
    let mut one = |tag: &str, b: &Block| {
        s.push_str(tag);
        s.push_str(&format!(
            "|{}|{:?}|{}|{}|{}|{}|{}\n",
            b.id, b.kind, b.start, b.end, b.open, b.speculative, b.html
        ));
    };
    for b in &p.newly_committed {
        one("C", b);
    }
    for b in &p.active {
        one("A", b);
    }
    s
}

/// Stream `md` in `chunk` byte-ish pieces (split on char boundaries), returning
/// the concatenated representation of every patch, including finalize's.
fn stream(md: &str, chunk: usize, retain: bool) -> String {
    let mut p = StreamParser::new()
        .with_gfm_footnotes(true)
        .with_retain_committed_html(retain);
    let mut buf = String::new();
    let mut out = String::new();
    for ch in md.chars() {
        buf.push(ch);
        if buf.len() >= chunk {
            out.push_str(&patch_repr(&p.append(&buf)));
            buf.clear();
        }
    }
    if !buf.is_empty() {
        out.push_str(&patch_repr(&p.append(&buf)));
    }
    out.push_str(&patch_repr(&p.finalize()));
    out
}

#[test]
fn default_is_on() {
    let mut p = StreamParser::new();
    p.append(MIXED);
    p.finalize();
    let committed: Vec<&Block> = p.all_blocks().filter(|b| !b.open).collect();
    assert!(committed.len() > 3, "expected several committed blocks");
    assert!(
        committed.iter().all(|b| !b.html.is_empty()),
        "default must retain committed html"
    );
}

#[test]
fn patches_are_byte_identical_with_the_flag_off() {
    for chunk in [1usize, 7, 64, 4096] {
        let on = stream(MIXED, chunk, true);
        let off = stream(MIXED, chunk, false);
        assert_eq!(on, off, "patch stream diverged at chunk={chunk}");
    }
}

#[test]
fn finalize_output_is_byte_identical_with_the_flag_off() {
    // Finalize emits the still-ACTIVE blocks as committed — the ones whose html
    // was never released — so its patch must be unaffected. Checked on its own
    // (the streaming test above folds it into one big string).
    let mut on = StreamParser::new();
    let mut off = StreamParser::new().with_retain_committed_html(false);
    on.append(MIXED);
    off.append(MIXED);
    assert_eq!(patch_repr(&on.append("A trailing open paragraph")), patch_repr(&off.append("A trailing open paragraph")));
    assert_eq!(patch_repr(&on.finalize()), patch_repr(&off.finalize()));
}

#[test]
fn all_blocks_reports_empty_html_and_exact_metadata_when_off() {
    let mut on = StreamParser::new();
    let mut off = StreamParser::new().with_retain_committed_html(false);
    on.append(MIXED);
    off.append(MIXED);
    on.finalize();
    off.finalize();

    let a: Vec<&Block> = on.all_blocks().collect();
    let b: Vec<&Block> = off.all_blocks().collect();
    assert_eq!(a.len(), b.len(), "block count must not change");
    assert!(a.len() > 3);
    for (x, y) in a.iter().zip(&b) {
        assert_eq!(x.id, y.id);
        assert_eq!(x.kind, y.kind);
        assert_eq!((x.start, x.end), (y.start, y.end));
        assert_eq!((x.open, x.speculative), (y.open, y.speculative));
        // Every block here is committed (post-finalize), so every html dropped.
        assert!(!x.html.is_empty(), "flag-on html should be present");
        assert!(y.html.is_empty(), "flag-off committed html should be released");
    }
}

#[test]
fn retained_bytes_plateaus_off_and_grows_on() {
    // One block per paragraph, all committed as the stream advances: with the
    // flag on, retention is buffer + all html; with it off, buffer + open tail.
    let mut on = StreamParser::new();
    let mut off = StreamParser::new().with_retain_committed_html(false);
    let mut source = 0usize;
    for i in 0..400 {
        let para = format!("Paragraph number {i} with a bit of *emphasis* to render.\n\n");
        source += para.len();
        on.append(&para);
        off.append(&para);
    }
    let on_bytes = on.retained_bytes();
    let off_bytes = off.retained_bytes();
    assert!(
        off_bytes < on_bytes,
        "flag-off must retain less: off={off_bytes} on={on_bytes}"
    );
    // Off ≈ the source buffer plus the single open tail block; on carries the
    // whole rendered document on top of that.
    assert!(
        off_bytes < source + 512,
        "flag-off retention should track the buffer: off={off_bytes} source={source}"
    );
    assert!(
        on_bytes > source * 3 / 2,
        "flag-on retention should carry the rendered document too: on={on_bytes} source={source}"
    );
}

#[test]
fn footnotes_are_identical_with_the_flag_off() {
    // The commit path RESOLVES footnote ids/backrefs into a block's html before
    // the block is committed, and finalize pushes the footnote section as a
    // committed block of its own. Both must land in the patch before the drop.
    const MD: &str =
        "First[^a] and again[^a].\n\nSecond[^b].\n\n[^a]: Note A.\n\n[^b]: Note B.\n\nTail[^a].\n";
    for chunk in [1usize, 5, 4096] {
        let on = stream(MD, chunk, true);
        let off = stream(MD, chunk, false);
        assert_eq!(on, off, "footnote patch stream diverged at chunk={chunk}");
        assert!(on.contains("<section class=\"footnotes\""), "section missing");
    }
}

#[test]
fn nested_container_output_survives_the_flag() {
    // The container / open-item assemblers read their NESTED parser's committed
    // html on every append. The flag must not reach a nested parser — this is
    // the tripwire if someone adds it to `make_nested_parser`.
    const MD: &str = concat!(
        "> # Quoted heading\n>\n> - item one\n> - item two\n>\n> ```\n> code\n> ```\n>\n> done.\n\n",
        "1. outer\n   - inner a\n   - inner b\n\n   a second paragraph\n\n2. next\n\n",
    );
    for chunk in [1usize, 3, 4096] {
        let on = stream(MD, chunk, true);
        let off = stream(MD, chunk, false);
        assert_eq!(on, off, "nested patch stream diverged at chunk={chunk}");
        assert!(on.contains("<blockquote"), "blockquote missing");
    }
}
