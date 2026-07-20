//! Correctness net for the incremental container cache (parser.rs) — the fast
//! path for a long open blockquote / GitHub alert at the tail. Char-by-char
//! and every chunk 1..=9 must produce byte-identical HTML to one-shot.
//!
//! Written before the cache lands so the test pins pre-cache correctness
//! (the regression we're fixing is perf, not output).

use brook_md_core::StreamParser;

fn collect(p: &StreamParser) -> String {
    let mut out = String::new();
    for b in p.all_blocks() {
        out.push_str(&b.html);
    }
    out
}

fn alerts(p: StreamParser) -> StreamParser {
    p.with_gfm_alerts(true)
}

fn render_with(make: impl Fn() -> StreamParser, md: &str) -> String {
    let mut p = make();
    p.append(md);
    p.finalize();
    collect(&p)
}

fn streamed_with(make: impl Fn() -> StreamParser, md: &str) -> String {
    let mut p = make();
    let mut buf = [0u8; 4];
    for ch in md.chars() {
        p.append(ch.encode_utf8(&mut buf));
    }
    p.finalize();
    collect(&p)
}

fn chunked_with(make: impl Fn() -> StreamParser, md: &str, n: usize) -> String {
    let mut p = make();
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
fn blockquote_cache_matches_full_render() {
    let make = || alerts(StreamParser::new());

    let mut big_para = String::new();
    for _ in 0..400 {
        big_para.push_str("> a continuation line with some **bold** and `code` here, plus more prose to bulk it up.\n");
    }

    let cases: &[&str] = &[
        // Plain blockquote, one-line paragraph
        "> Hello, world!\n",
        // Plain blockquote, multi-line paragraph (single inner paragraph)
        "> line one\n> line two\n> line three\n",
        // Inline markdown inside the blockquote
        "> a paragraph with **bold**, *italic*, `code`, and a [link](https://example.com)\n",
        // Lazy continuation (a non-`>` line that continues the paragraph)
        "> first line\nsecond line lazy\n> third line\n",
        // Multi-paragraph blockquote — must NOT cache as single-paragraph
        "> first paragraph\n> still first\n>\n> second paragraph\n> more of second\n",
        // Blockquote with a nested fenced code block
        "> Before\n>\n> ```rust\n> fn x() {}\n> ```\n>\n> After\n",
        // Blockquote followed by a paragraph (must commit cleanly)
        "> quoted\n> quoted more\n\nAnd a following paragraph.\n",
        // Blockquote with no trailing newline
        "> Hello, world!",
        // Empty blockquote-only line  → blank inner
        ">\n",
        // Big single-paragraph blockquote (stress)
        &big_para,
    ];
    for md in cases {
        let one = render_with(make, md);
        let preview: String = md.chars().take(60).collect();
        assert_eq!(streamed_with(make, md), one, "char-stream != one-shot for {:?}", preview);
        for n in 1..=9 {
            assert_eq!(chunked_with(make, md, n), one, "chunk={n} != one-shot for {:?}", preview);
        }
    }
}

#[test]
fn alert_cache_matches_full_render() {
    let make = || alerts(StreamParser::new());

    let mut big_alert = String::from("> [!NOTE]\n");
    for _ in 0..400 {
        big_alert.push_str("> a continuation line of the note body with **bold** and a [link](https://example.com) thrown in.\n");
    }

    let cases: &[&str] = &[
        // Each of the five alert kinds
        "> [!NOTE]\n> body of the note\n",
        "> [!TIP]\n> body of the tip\n",
        "> [!IMPORTANT]\n> body of the important\n",
        "> [!WARNING]\n> body of the warning\n",
        "> [!CAUTION]\n> body of the caution\n",
        // Alert with inline markup in body
        "> [!NOTE]\n> a body with **bold** and `code` and [link](https://x).\n",
        // Alert with empty body (marker only)
        "> [!NOTE]\n",
        // Alert with multi-line single paragraph body
        "> [!NOTE]\n> line one\n> line two\n> line three\n",
        // Alert followed by a paragraph
        "> [!NOTE]\n> quoted body\n\nA following paragraph.\n",
        // Alert with no trailing newline
        "> [!NOTE]\n> body without newline",
        // Multi-paragraph alert body
        "> [!NOTE]\n> first paragraph\n>\n> second paragraph\n",
        // Big single-paragraph alert (stress)
        &big_alert,
    ];
    for md in cases {
        let one = render_with(make, md);
        let preview: String = md.chars().take(60).collect();
        assert_eq!(streamed_with(make, md), one, "char-stream != one-shot for {:?}", preview);
        for n in 1..=9 {
            assert_eq!(chunked_with(make, md, n), one, "chunk={n} != one-shot for {:?}", preview);
        }
    }
}

#[test]
fn container_cache_with_dir_auto() {
    // dir_auto changes the wrapper HTML (`<blockquote dir="auto">`, `<p dir="auto">`,
    // and inside the alert div+title+body). The cache must produce identical bytes.
    let make = || StreamParser::new().with_gfm_alerts(true).with_dir_auto(true);
    let cases: &[&str] = &[
        "> Hello, world!\n",
        "> line one\n> line two\n",
        "> [!WARNING]\n> warning body\n> more of warning\n",
        // dir_auto × multi-paragraph: every `<p>` opener must carry dir="auto".
        "> p1\n>\n> p2\n",
        "> [!WARNING]\n> first\n>\n> second\n",
    ];
    for md in cases {
        let one = render_with(make, md);
        assert_eq!(streamed_with(make, md), one, "char-stream != one-shot for {md:?}");
        for n in 1..=9 {
            assert_eq!(chunked_with(make, md, n), one, "chunk={n} != one-shot for {md:?}");
        }
    }
}

#[test]
fn crlf_container_falls_back_correctly() {
    let make = || alerts(StreamParser::new());
    // The cache may bail on `\r`; CRLF blockquotes / alerts go through the full
    // renderer, so output still matches and nothing panics.
    let cases: &[&str] = &[
        "> Hello, world!\r\n> line two\r\n",
        "> [!NOTE]\r\n> body line\r\n",
    ];
    for md in cases {
        let one = render_with(make, md);
        assert_eq!(streamed_with(make, md), one, "char-stream != one-shot for {md:?}");
        for n in 1..=9 {
            assert_eq!(chunked_with(make, md, n), one, "chunk={n} != one-shot for {md:?}");
        }
    }
}

#[test]
fn open_alert_renders_incrementally() {
    // Pin block-id stability across the streaming-then-closing transition.
    let mut p = StreamParser::new().with_gfm_alerts(true);
    p.append("> [!NOTE]\n");
    p.append("> first body line\n");
    let id0 = p.all_blocks().last().unwrap().id;
    p.append("> second body line\n");
    let h = collect(&p);
    assert!(h.contains("markdown-alert-note") && h.contains("second body line"), "{h}");
    assert_eq!(p.all_blocks().last().unwrap().id, id0, "id stable while streaming");

    // Close it with a blank line + paragraph; the alert keeps its id.
    p.append("\nAfter the alert.\n");
    let blocks: Vec<_> = p.all_blocks().cloned().collect();
    assert!(blocks.iter().any(|b| b.id == id0), "alert block id survives close");
}

#[test]
fn multi_paragraph_container_matches_full_render() {
    // The blank-`>` line case the cache now handles instead of bailing — every
    // append-shape must agree with one-shot, including the byte-identical
    // `<blockquote>\n<p>P1</p>\n<p>P2</p>\n</blockquote>` shape.
    let make = || alerts(StreamParser::new());

    // Stress: 200 short paragraphs separated by blank `>` lines.
    let mut stress = String::new();
    for i in 0..200 {
        stress.push_str("> paragraph ");
        stress.push_str(&i.to_string());
        stress.push_str(" body with **bold** and `code`.\n>\n");
    }

    let cases: &[&str] = &[
        // Simple two-paragraph blockquote.
        "> p1\n>\n> p2\n",
        // Three-paragraph blockquote with multi-line paragraphs.
        "> first paragraph\n> still first\n>\n> second paragraph\n> still second\n>\n> third\n",
        // Consecutive blank `>` lines collapse to a single paragraph break.
        "> p1\n>\n>\n> p3\n",
        // Trailing blank `>` line, no follow-up content.
        "> p1\n>\n",
        // Trailing blank then partial next paragraph (no newline yet).
        "> p1\n>\n> p2",
        // Three-paragraph alert.
        "> [!NOTE]\n> first\n>\n> second\n>\n> third\n",
        // Alert whose first body line is blank (empty leading body para).
        "> [!NOTE]\n>\n> body\n",
        // Alert with blank, then content, then trailing blank.
        "> [!TIP]\n>\n> tip body\n>\n",
        // Inline markup spread across paragraphs.
        "> **bold** in p1\n>\n> *italic* in p2 with `code` and [link](https://x)\n",
        // Big multi-paragraph stress.
        &stress,
    ];
    for md in cases {
        let one = render_with(make, md);
        let preview: String = md.chars().take(60).collect();
        assert_eq!(streamed_with(make, md), one, "char-stream != one-shot for {:?}", preview);
        for n in 1..=9 {
            assert_eq!(chunked_with(make, md, n), one, "chunk={n} != one-shot for {:?}", preview);
        }
    }
}

#[test]
fn multi_paragraph_blockquote_exact_bytes() {
    // Pin the byte-exact shape so any future drift is loud — the cache must
    // emit the same `\n`-separated sub-block layout the full renderer does.
    let mut p = alerts(StreamParser::new());
    p.append("> p1\n>\n> p2\n");
    p.finalize();
    assert_eq!(collect(&p), "<blockquote>\n<p>p1</p>\n<p>p2</p>\n</blockquote>");
}

#[test]
fn multi_paragraph_id_stable_across_paragraph_breaks() {
    // The block id must survive each paragraph break — closing a paragraph is
    // an internal cache transition, not a block boundary.
    let mut p = StreamParser::new().with_gfm_alerts(true);
    p.append("> [!NOTE]\n");
    p.append("> first body\n");
    let id0 = p.all_blocks().last().unwrap().id;
    p.append(">\n"); // close first paragraph
    assert_eq!(p.all_blocks().last().unwrap().id, id0, "id stable across blank `>`");
    p.append("> second body\n");
    assert_eq!(p.all_blocks().last().unwrap().id, id0, "id stable into second paragraph");
    p.append(">\n");
    p.append("> third body\n");
    assert_eq!(p.all_blocks().last().unwrap().id, id0, "id stable into third paragraph");
    let h = collect(&p);
    assert!(h.contains("first body") && h.contains("second body") && h.contains("third body"), "{h}");
}

#[test]
fn lazy_continuation_matches_full_render() {
    // Marker-less lazy paragraph-continuation lines (CommonMark laziness) —
    // the cache glues them exactly like `blockquote_inner` instead of bailing,
    // so a quote extended lazily streams in O(new bytes). Every chunking must
    // stay byte-identical to one-shot.
    let make = || alerts(StreamParser::new());

    // A long lazy run (the O(n²) cliff shape) — the cache must stay armed.
    let mut lazy_run = String::from("> the quoted paragraph starts here\n");
    for i in 0..300 {
        lazy_run.push_str(&format!("lazy continuation line {i} with plain prose words\n"));
    }

    let cases: Vec<&str> = vec![
        // basic laziness + returning to marked lines
        "> a\nlazy line\n",
        "> a\nlazy one\nlazy two\n> back to marked\n",
        "> a\nlazy **bold** and `code`\nmore lazy\n",
        // left-trim: ≤3 spaces, ≥4 spaces (indented code can't interrupt), tabs
        "> a\n  two-space lazy\n",
        "> a\n    four-space lazy\n",
        "> a\n\ttab lazy\n",
        // a setext-looking lazy line stays paragraph text (glued, not underline)
        "> a\n===\n",
        // an ordered marker not starting at 1 cannot interrupt — lazy text
        "> a\n5. not a list\n",
        // lines that END the quote instead (block starters / blank)
        "> a\n# heading\n",
        "> a\n- item\n",
        "> a\n> b\nlazy\n\nafter paragraph\n",
        // laziness only continues an OPEN paragraph — after a blank `>` line
        // a marker-less line is outside the quote
        "> a\n>\noutside paragraph\n",
        // alert body extended lazily
        "> [!NOTE]\n> body line\nlazy body continuation\n",
        // a lazy line right after the marker glues onto the TITLE line — the
        // container dissolves into a plain blockquote
        "> [!NOTE]\nlazy title continuation\n",
        // multi-paragraph quote, second paragraph extended lazily
        "> p1\n>\n> p2\nlazy p2 tail\n",
        &lazy_run,
    ];
    for md in cases {
        let one = render_with(make, md);
        let preview: String = md.chars().take(60).collect();
        assert_eq!(streamed_with(make, md), one, "char-stream != one-shot for {:?}", preview);
        for n in 1..=9 {
            assert_eq!(chunked_with(make, md, n), one, "chunk={n} != one-shot for {:?}", preview);
        }
    }
}

#[test]
fn lazy_continuation_exact_bytes() {
    // Pin the glue shape: the lazy line joins the previous one with a single
    // space (soft break), left-trimmed — `blockquote_inner`'s exact transform.
    let mut p = alerts(StreamParser::new());
    p.append("> a\n");
    p.append("lazy tail\n");
    p.append("> c\n");
    p.finalize();
    assert_eq!(collect(&p), "<blockquote>\n<p>a lazy tail\nc</p>\n</blockquote>");
}

#[test]
fn quote_hosted_ref_defs_match_full_render() {
    // Link-reference definitions inside a container are document-global (§4.7).
    // The recursive container-block cache now feeds them to its nested parser
    // (no `]:` bail); the outer full reparse re-derives the global table when
    // the quote closes, so post-quote uses resolve exactly as one-shot.
    let make = || alerts(StreamParser::new());

    // The cliff shape: a def-run quote long enough to arm + stream the cache.
    let mut def_run = String::new();
    for i in 0..60 {
        def_run.push_str(&format!("> [r{i}]: https://example.com/page/{i} \"Title {i}\"\n"));
    }
    let def_run_then_use = format!("{def_run}\nsee [zero][r0] and [last][r59] after the quote\n");

    let cases: Vec<&str> = vec![
        // def inside the quote, used after the quote closes
        "> [r]: https://example.com/x \"T\"\n\nuse [link][r] here\n",
        // def inside the quote, used later inside the same quote
        "> [r]: https://example.com/x\n> see [link][r] inside\n",
        // def mixed with quote prose before and after
        "> intro paragraph\n> [r]: https://example.com/x\n> outro [use][r]\n",
        // def whose title arrives on the following line
        "> [r]: https://example.com/x\n> \"Title on next line\"\n\nuse [link][r]\n",
        // `[^label]:` with footnotes OFF is a plain link-ref def (label `^f`)
        "> [^f]: https://example.com/n\n\nuse [note][^f] after\n",
        // defs inside an alert body
        "> [!NOTE]\n> [r]: https://example.com/x\n> body [use][r]\n",
        // invalid def (unquoted trailing text) stays a paragraph — no def
        "> [r]: https://example.com/x trailing words\n",
        &def_run,
        &def_run_then_use,
    ];
    for md in cases {
        let one = render_with(make, md);
        let preview: String = md.chars().take(60).collect();
        assert_eq!(streamed_with(make, md), one, "char-stream != one-shot for {:?}", preview);
        for n in 1..=9 {
            assert_eq!(chunked_with(make, md, n), one, "chunk={n} != one-shot for {:?}", preview);
        }
    }
}

#[test]
fn quote_hosted_ref_def_resolves_after_close_exact_bytes() {
    let mut p = alerts(StreamParser::new());
    for ch in "> [r]: https://example.com/x \"T\"\n\nsee [it][r]\n".chars() {
        let mut buf = [0u8; 4];
        p.append(ch.encode_utf8(&mut buf));
    }
    p.finalize();
    assert_eq!(
        collect(&p),
        "<blockquote></blockquote><p>see <a href=\"https://example.com/x\" title=\"T\" \
         target=\"_blank\" rel=\"noopener noreferrer nofollow\">it</a></p>"
    );
}
