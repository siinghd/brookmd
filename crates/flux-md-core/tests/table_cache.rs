//! Correctness net for the incremental table cache (parser.rs). Streaming
//! char-by-char (and at every chunk 1..=9) exercises the O(new-bytes) cache
//! path; a single-shot parse uses the full renderer. They must produce
//! byte-identical HTML — if they do for every prefix shape below, the cache
//! is faithful. Written before the cache lands so it also pins the pre-cache
//! correctness (the regression we're fixing is perf, not output).

use flux_md_core::StreamParser;

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

fn render_streamed(md: &str) -> String {
    let mut p = StreamParser::new();
    let mut buf = [0u8; 4];
    for ch in md.chars() {
        p.append(ch.encode_utf8(&mut buf));
    }
    p.finalize();
    collect(&p)
}

fn render_chunked(md: &str, n: usize) -> String {
    let mut p = StreamParser::new();
    let b = md.as_bytes();
    let mut i = 0;
    while i < b.len() {
        let mut e = (i + n).min(b.len());
        while e < b.len() && (b[e] & 0xC0) == 0x80 {
            e += 1;
        }
        p.append(&md[i..e]);
        i = e;
    }
    p.finalize();
    collect(&p)
}

#[test]
fn cache_matches_full_render() {
    let mut big = String::from("| Name | Age | City | Score |\n| --- | --- | --- | --- |\n");
    for i in 0..400 {
        big.push_str(&format!("| Person {i} | {} | Town {i} | {} |\n", 20 + (i % 60), i * 7 % 1000));
    }

    let cases: &[&str] = &[
        // Basic 2-col
        "| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |\n",
        // No trailing newline — last row is "partial"
        "| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |",
        // Mixed alignments
        "| L | C | R | D |\n| :- | :-: | -: | - |\n| 1 | 2 | 3 | 4 |\n| a | b | c | d |\n",
        // Cells with inline markdown
        "| name | note |\n| --- | --- |\n| **bold** | `code` |\n| [a](https://x) | *em* |\n",
        // Escaped pipe in cell
        "| a | b |\n| --- | --- |\n| pipe \\| here | ok |\n",
        // Single column
        "| only |\n| --- |\n| x |\n| y |\n",
        // Ten columns
        "| a|b|c|d|e|f|g|h|i|j |\n| -|-|-|-|-|-|-|-|-|- |\n| 1|2|3|4|5|6|7|8|9|0 |\n",
        // Header+delimiter only (no rows yet)
        "| H1 | H2 |\n| --- | --- |\n",
        // Followed by paragraph
        "| A | B |\n| --- | --- |\n| 1 | 2 |\n\nAfter the table.\n",
        // Preceded by paragraph
        "Intro paragraph here.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n",
        // Two tables back to back
        "| A | B |\n| --- | --- |\n| 1 | 2 |\n\n| C | D |\n| --- | --- |\n| 3 | 4 |\n",
        // Link reference defined above table — cell should resolve it
        "[ref]: https://example.com\n\n| a | b |\n| --- | --- |\n| [link][ref] | ok |\n",
        // Ragged rows (more/fewer cells than header)
        "| A | B | C |\n| --- | --- | --- |\n| 1 | 2 |\n| 1 | 2 | 3 | 4 |\n",
        // The big stress case
        &big,
    ];
    for md in cases {
        let one = render(md);
        let preview: String = md.chars().take(60).collect();
        assert_eq!(render_streamed(md), one, "char-stream != one-shot for {:?}", preview);
        for n in 1..=9 {
            assert_eq!(render_chunked(md, n), one, "chunk={n} != one-shot for {:?}", preview);
        }
    }
}

#[test]
fn cache_matches_full_render_with_options() {
    // Same parity check but with dir_auto and unsafe_html on, since those affect
    // the rendered HTML and the cache must produce identical output.
    let md = "| name | note |\n| --- | --- |\n| **bold** | <i>raw</i> |\n| a | b |\n";

    let one_shot = {
        let mut p = StreamParser::new().with_dir_auto(true).with_unsafe_html(true);
        p.append(md);
        p.finalize();
        collect(&p)
    };
    let streamed = {
        let mut p = StreamParser::new().with_dir_auto(true).with_unsafe_html(true);
        let mut buf = [0u8; 4];
        for ch in md.chars() {
            p.append(ch.encode_utf8(&mut buf));
        }
        p.finalize();
        collect(&p)
    };
    assert_eq!(streamed, one_shot);
}

#[test]
fn crlf_table_falls_back_correctly() {
    // The cache may bail on \r; CRLF tables go through the full renderer in both
    // modes, so output still matches and nothing panics.
    let md = "| Name | Age |\r\n| --- | --- |\r\n| Alice | 30 |\r\n| Bob | 25 |\r\n";
    assert_eq!(render_streamed(md), render(md));
    for n in 1..=9 {
        assert_eq!(render_chunked(md, n), render(md), "chunk={n}");
    }
}

#[test]
fn open_table_renders_incrementally() {
    // The header must appear as soon as the delimiter arrives; rows then append.
    // (Mirrors `tests/table_streaming.rs::header_renders_as_soon_as_delimiter_arrives`
    // but additionally pins that the block id stays stable across appends —
    // a cache mistake would re-id the block.)
    let mut p = StreamParser::new();
    p.append("| Name | Age |\n");
    p.append("| --- | --- |\n");
    let h = collect(&p);
    assert!(h.contains("<table>") && h.contains("<th>Name</th>"), "header forms: {h}");
    let id0 = p.all_blocks().last().unwrap().id;

    p.append("| Alice | 30 |\n");
    let h = collect(&p);
    assert!(h.contains("<td>Alice</td>"));
    assert_eq!(p.all_blocks().last().unwrap().id, id0, "id stable");

    p.append("| Bob | 25 |\n");
    assert!(collect(&p).contains("<td>Bob</td>"));
    assert_eq!(p.all_blocks().last().unwrap().id, id0, "id still stable");
}

#[test]
fn cache_disarms_when_footnotes_on() {
    // Footnotes attach an occurrence counter to each `[^x]` ref. The cache renders
    // each row once; the full path re-renders the whole tail each append. Mixing
    // would produce diverging fnref ids — so the cache must NOT engage when
    // footnotes are on. The test is parity, not engagement.
    let md = "| a | b |\n| --- | --- |\n| see [^1] | ok |\n| again [^1] | done |\n\n[^1]: note\n";
    let one_shot = {
        let mut p = StreamParser::new().with_gfm_footnotes(true);
        p.append(md);
        p.finalize();
        collect(&p)
    };
    let streamed = {
        let mut p = StreamParser::new().with_gfm_footnotes(true);
        let mut buf = [0u8; 4];
        for ch in md.chars() {
            p.append(ch.encode_utf8(&mut buf));
        }
        p.finalize();
        collect(&p)
    };
    assert_eq!(streamed, one_shot, "footnotes + table must converge across the stream");
}

// ---- partial-row sub-cache (the trailing newline-less row) -----------------
//
// The open-state (no finalize) HTML of every streamed prefix must equal the
// one-shot open state of the same prefix — the partial-row sub-cache freezes
// cells at each unescaped `|` and commits the open cell's settled inline
// prefix, and none of that may show. Cases target the split automaton's edges:
// escaped pipes at cell/line boundaries, the trailing decoration pipe,
// Unicode whitespace, multi-byte chars, and inline constructs cut mid-way.

fn open_state(p: &StreamParser) -> String {
    collect(p)
}

fn one_shot_open(md: &str, footnotes: bool) -> String {
    let mut p = StreamParser::new().with_gfm_footnotes(footnotes);
    p.append(md);
    open_state(&p)
}

fn streamed_open(md: &str, chunk: usize, footnotes: bool) -> String {
    let mut p = StreamParser::new().with_gfm_footnotes(footnotes);
    let b = md.as_bytes();
    let mut i = 0;
    while i < b.len() {
        let mut e = (i + chunk).min(b.len());
        while e < b.len() && (b[e] & 0xC0) == 0x80 {
            e += 1;
        }
        p.append(&md[i..e]);
        i = e;
    }
    open_state(&p)
}

/// `doc` = `head` (everything through the delimiter row's newline, prefix cuts
/// inside it hit the documented paragraph→table boundary lag) + `tail`. Checks
/// open-state parity for every char prefix that includes the full `head`.
fn assert_partial_row_parity(head: &str, tail: &str, footnotes: bool) {
    let doc = format!("{head}{tail}");
    let cuts: Vec<usize> = doc
        .char_indices()
        .map(|(i, _)| i)
        .filter(|&i| i >= head.len())
        .chain(std::iter::once(doc.len()))
        .collect();
    for cut in cuts {
        let prefix = &doc[..cut];
        let one = one_shot_open(prefix, footnotes);
        for chunk in [1usize, 3] {
            let streamed = streamed_open(prefix, chunk, footnotes);
            assert_eq!(
                streamed, one,
                "open-state mismatch (chunk={chunk}, fn={footnotes}) for prefix {prefix:?}"
            );
        }
    }
}

#[test]
fn partial_row_prefix_parity() {
    const HDR: &str = "| a | b |\n| :- | -: |\n";
    let tails: &[&str] = &[
        "| x | y |  ",
        "| x \\| y",
        "| x \\|",
        "| x \\\\| y",
        "| x \\\\\\| tail",
        "| x | \\",
        "|||",
        "| |",
        "| x | y | z | w",
        "x | y",
        "| **x** | *y* z",
        "| `co | de` | x",
        "| [link](https://a.b) | tex",
        "| é中 | 🚀 word",
        "\u{3000}| x",
        "| x\u{3000} | y\u{3000}",
        "| x | y |\n| p | q |\n| r ",
        "| *em | ph* | tail",
        "| a\\|b\\|c | d",
        "| two  spaces  in  cell | x",
    ];
    for tail in tails {
        assert_partial_row_parity(HDR, tail, false);
    }
}

#[test]
fn partial_row_prefix_parity_footnotes() {
    // Footnote refs in frozen cells, the open cell's committed prefix, and the
    // speculative tail must all resolve to the same occurrence ids as the full
    // per-append re-render.
    let docs: &[(&str, &str)] = &[
        ("[^1]: note\n\n| a | b |\n| - | - |\n", "| [^1] x | [^1] y wor"),
        ("[^a]: A\n\n| [^a] h | b |\n| - | - |\n", "| [^a] | [^a] more te"),
        ("[^a]: A\n\n| a | b |\n| - | - |\n", "| [^a] \\| [^a] | z"),
    ];
    for (head, tail) in docs {
        assert_partial_row_parity(head, tail, true);
    }
}

#[test]
fn unicode_blank_table_line_matches_full_render() {
    // `is_blank_line` is ASCII-only but the full renderer's body filter is
    // Unicode-aware (`.trim()`): an all-U+3000 line inside or trailing a
    // streamed table must not fabricate an empty row.
    let inside = "| a | b |\n| :- | -: |\n\u{3000}\n| x | y |\n";
    let trailing = "| a | b |\n| :- | -: |\n\u{3000}";
    for md in [inside, trailing] {
        assert_eq!(streamed_open(md, 1, false), one_shot_open(md, false), "open state {md:?}");
        assert_eq!(render_streamed(md), render(md), "finalized {md:?}");
    }
}
