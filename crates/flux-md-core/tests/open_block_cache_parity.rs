//! Per-prefix mid-stream parity for the open-block caches that arm on a block
//! kind with no committing boundary — component / heading / rule / fence-info.
//!
//! Stronger than `midstream_parity.rs` (which checks only each input's final
//! open state): for EVERY char prefix of each input, the streamed parser
//! (several chunkings) must produce the same blocks — kind, range, html, flags;
//! ids are parser-local counters and excluded — as a one-shot append of that
//! prefix, and finalize must match a one-shot parse+finalize. This pins the
//! exact contract the caches rely on: an armed fast path is byte-invisible
//! next to the full tail reparse, at every step of the stream.

use flux_md_core::{Block, StreamParser};

#[derive(Clone, Copy)]
struct Opts {
    footnotes: bool,
    block_data: bool,
    unsafe_html: bool,
}

const BASE: Opts = Opts { footnotes: false, block_data: false, unsafe_html: false };

fn parser(o: Opts) -> StreamParser {
    let mut p = StreamParser::new()
        .with_gfm_autolinks(true)
        .with_gfm_alerts(true)
        .with_gfm_math(true)
        .with_component_tags(vec!["Chart".into(), "Callout".into()])
        .with_block_data(o.block_data);
    p.set_gfm_footnotes(o.footnotes);
    p.set_unsafe_html(o.unsafe_html);
    p
}

fn dump(p: &StreamParser) -> String {
    // Everything except `id` (ids are parser-local monotonic counters and churn
    // as a speculative block dissolves — not part of the parity contract).
    let mut out = String::new();
    for b in p.all_blocks() {
        let b: &Block = b;
        out.push_str(&format!(
            "{}|{}..{}|{}|{}{}\n",
            serde_json::to_string(&b.kind).unwrap(),
            b.start,
            b.end,
            b.html,
            b.open,
            b.speculative
        ));
    }
    out
}

fn char_boundaries(md: &str) -> Vec<usize> {
    let mut v: Vec<usize> = md.char_indices().map(|(i, _)| i).collect();
    v.push(md.len());
    v
}

/// `line_complete_only`: assert mid-stream parity only at prefixes ending in
/// `\n`. The nested component parser inherits the top-level engine's
/// PRE-EXISTING mid-line transients (e.g. a table delimiter row without its
/// newline classifies as paragraph when streamed but table when one-shot —
/// reproduced on the base commit at top level, no component involved), so
/// component bodies get the same guarantee the engine itself provides.
fn assert_parity_at(md: &str, o: Opts, line_complete_only: bool) {
    let bounds = char_boundaries(md);
    for chunk in [1usize, 3, 7] {
        let mut streamed = parser(o);
        let mut fed = 0usize;
        for w in bounds.windows(2) {
            let (_, e) = (w[0], w[1]);
            // feed in `chunk`-char pieces: only cut at every `chunk`th boundary
            if (bounds.iter().position(|&b| b == e).unwrap()) % chunk != 0 && e != md.len() {
                continue;
            }
            streamed.append(&md[fed..e]);
            fed = e;
            if line_complete_only && !md[..e].ends_with('\n') {
                continue;
            }
            // one empty append so a freshly-armed cache fires
            streamed.append("");
            let mut one = parser(o);
            one.append(&md[..e]);
            assert_eq!(
                dump(&streamed),
                dump(&one),
                "mid-stream != one-shot at prefix {:?} (chunk {chunk}) of {md:?}",
                &md[..e]
            );
        }
        // finalize parity
        let sfin = {
            streamed.finalize();
            dump(&streamed)
        };
        let ofin = {
            let mut one = parser(o);
            one.append(md);
            one.finalize();
            dump(&one)
        };
        assert_eq!(sfin, ofin, "finalize parity failed (chunk {chunk}) for {md:?}");
    }
}

fn assert_parity(md: &str, o: Opts) {
    assert_parity_at(md, o, false)
}

#[test]
fn heading_parity() {
    for md in [
        "# hello world this is a growing heading with **bold** and `code` and *emph*",
        "# aaa bbb ####",
        "# aaa bbb #### more words after the hashes ###",
        "## x ##x",
        "# x #",
        "# ###",
        "#   ",
        "#",
        "####### seven hashes is not a heading",
        "# heading with [link](https://e.com) and [incomplete](https://e",
        "# heading `code span with # inside` tail",
        "# tab\tseparated\tcontent ##\t",
        "  ### indented heading with words and words ###  ",
        "# math $x+y$ and $incomplete",
        "# auto https://example.com/path link",
        "# heading\nparagraph after\n",
        "# heading ###\n\n# second heading",
        "# emoji \u{1F600} and CJK \u{6F22}\u{5B57} content here",
        "# words #### # ## ###",
        "# a &amp; b &am",
    ] {
        assert_parity(md, BASE);
    }
    // footnotes on: refs in a growing heading
    assert_parity("# note [^1] and again [^1] plus [^2] words words", Opts { footnotes: true, ..BASE });
    // block_data on: rich channel must stay correct (cache declines to arm)
    assert_parity(
        "# rich heading with **bold** words and more words",
        Opts { block_data: true, ..BASE },
    );
}

#[test]
fn rule_parity() {
    for md in [
        "---",
        "----------------------------------------",
        "- - - - - -",
        "***",
        "** * ** * **",
        "___",
        "_______   ",
        "---x",
        "--- x",
        "----\nafter\n",
        "***\n\n---\n",
        "-",
        "--",
        "-- -",
        "--\t--\t--",
    ] {
        assert_parity(md, BASE);
    }
}

#[test]
fn fence_info_parity() {
    for md in [
        "```rust attr1 attr2 attr3 attr4 attr5 attr6",
        "```rust    lots   of   info   words",
        "```rust attr `backtick kills the fence",
        "~~~rust attr `backtick fine in tilde info",
        "```math x y z",
        "```mermaid graph TD extra",
        "```latex a b",
        "``` leading-space-only-info word",
        "```rust attrs then\nlet x = 1;\n```\n",
        "```a&amp;b word",
        "```rust word\n",
    ] {
        assert_parity(md, BASE);
    }
    assert_parity("```rust attr1 attr2 attr3", Opts { block_data: true, ..BASE });
    assert_parity("```math x1 x2 x3", Opts { block_data: true, ..BASE });
}

#[test]
fn component_parity() {
    for md in [
        "<Chart>\ndata point 0 with **bold** and `code`\ndata point 1\n",
        "<Chart>\n# heading inside\n- a list\n- of items\n\n> quote\n",
        "<Chart>\npara one\n\npara two\n\npara three\n",
        "<Chart>\n</Chart>",
        "<Chart>\n</Chart>\nafter\n",
        "<Chart type=\"bar\" title=\"q&a\">\nbody\n</Chart>\n",
        "<Chart onclick=\"evil()\" href=\"javascript:alert(1)\" data-x=\"1\">\nbody\n",
        "<Chart>\nnested <Chart>\ninner\n</Chart>\nouter tail\n</Chart>\n",
        "<Chart>\n```\n</Chart>\n```\nstill inside\n</Chart>\n",
        "<Chart>\n~~~\ncode </Chart> line\n~~~\nout\n",
        // (the growing-table body is below, line-complete-only — the partial
        // delimiter row is a PRE-EXISTING top-level mid-line transient)
        "<Chart>\n[link def used][d]\n\n[d]: https://example.com\n",
        "<Chart>\nmath $x+y$ and $$\ndisplay\n$$\n",
        "<Chart>\n<Callout>\nmixed tags\n</Callout>\ndone\n</Chart>\n",
        "<Chart>\nincomplete [link](https://e\n",
        "<Chart>\n  </Chart>",
        "<Chart>\n    </Chart>  (4-space indent is not a close)\n",
        "<Chart>\nline with trailing partial close </Cha",
        "<Chart/>",
        "<Chart/>\nafter\n",
        "<Chart>text on same line</Chart>\n",
        "<Chart>\nCJK \u{6F22}\u{5B57}\u{306E}\u{884C} and emoji \u{1F680}\n",
    ] {
        assert_parity(md, BASE);
    }
    assert_parity_at("<Chart>\ntable:\n\n| a | b |\n| - | - |\n| 1 | 2 |\n", BASE, true);
    // footnotes on: `[^` in the body bails to the full path
    assert_parity(
        "<Chart>\nfootnote [^1] here\n\n[^1]: def\n",
        Opts { footnotes: true, ..BASE },
    );
    // block_data on (component kind carries no data channel — cache still arms)
    assert_parity(
        "<Chart>\n- item **bold**\n- item `code`\n",
        Opts { block_data: true, ..BASE },
    );
    // unsafe_html on: raw HTML inside a component body
    assert_parity(
        "<Chart>\n<div class=\"x\">raw</div>\n\ntext\n",
        Opts { unsafe_html: true, ..BASE },
    );
}
