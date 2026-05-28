//! Correctness net for the incremental list cache (parser.rs) — the fast
//! path for a long open *tight, flat* list at the tail (the LLM-emit shape:
//! every line is a sibling marker, no blank lines, no continuation). Loose
//! lists, nested lists, multi-line items, and lazy continuations route
//! through the full renderer; this test pins parity in both modes.

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
fn list_cache_matches_full_render() {
    let mut big_flat = String::new();
    for i in 0..400 {
        big_flat.push_str(&format!("- item {i} with some **bold** and a `bit of code` for flavor\n"));
    }

    let cases: &[&str] = &[
        // Plain flat bullet list (the LLM-emit shape — the cache's hot path)
        "- one\n- two\n- three\n",
        // Inline markup inside items
        "- **bold** item\n- `code` item\n- [link](https://x) item\n",
        // Star and plus bullets (different marker family — must still arm)
        "* alpha\n* beta\n* gamma\n",
        "+ red\n+ green\n+ blue\n",
        // Ordered list with default start
        "1. one\n2. two\n3. three\n",
        // Ordered with explicit start
        "5. five\n6. six\n7. seven\n",
        // Ordered with parens marker
        "1) one\n2) two\n3) three\n",
        // No trailing newline (last item partial)
        "- one\n- two\n- three",
        // Two-item minimum
        "- one\n- two\n",
        // Followed by paragraph
        "- one\n- two\n\nA paragraph after the list.\n",
        // Preceded by paragraph
        "Intro paragraph.\n\n- one\n- two\n- three\n",
        // Loose list (blank line between items) — cache must bail and the full
        // path's `<p>`-wrapping renders correctly
        "- one\n\n- two\n\n- three\n",
        // Multi-line item (continuation) — cache must bail
        "- one\n  continuation\n- two\n",
        // Nested list — cache must bail
        "- outer 1\n  - inner 1\n  - inner 2\n- outer 2\n",
        // Mixed markers (the second `*` doesn't match the `-` family — ends the list)
        "- one\n- two\n\n* alpha\n",
        // Big stress case
        &big_flat,
    ];
    for md in cases {
        let one = render(md);
        let preview: String = md.chars().take(50).collect();
        assert_eq!(render_streamed(md), one, "char-stream != one-shot for {:?}", preview);
        for n in 1..=9 {
            assert_eq!(render_chunked(md, n), one, "chunk={n} != one-shot for {:?}", preview);
        }
    }
}

#[test]
fn list_cache_with_dir_auto() {
    let make = || StreamParser::new().with_dir_auto(true);
    let md = "- one\n- two\n- three\n";
    let one_shot = {
        let mut p = make();
        p.append(md);
        p.finalize();
        collect(&p)
    };
    let streamed = {
        let mut p = make();
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
fn crlf_list_falls_back_correctly() {
    let md = "- one\r\n- two\r\n- three\r\n";
    assert_eq!(render_streamed(md), render(md));
    for n in 1..=9 {
        assert_eq!(render_chunked(md, n), render(md), "chunk={n}");
    }
}

#[test]
fn open_list_renders_incrementally() {
    let mut p = StreamParser::new();
    p.append("- one\n");
    let id0 = p.all_blocks().last().unwrap().id;
    p.append("- two\n");
    let h = collect(&p);
    assert!(h.contains("<li>one</li>") && h.contains("<li>two</li>"), "{h}");
    assert_eq!(p.all_blocks().last().unwrap().id, id0, "id stable");

    p.append("- three\n");
    assert!(collect(&p).contains("<li>three</li>"));
    assert_eq!(p.all_blocks().last().unwrap().id, id0, "id still stable");
}
