//! GFM "Disallowed Raw HTML" (tagfilter, GFM spec §6.11) — the opt-in
//! `with_gfm_tagfilter` extension. When raw HTML passes through verbatim
//! (`unsafe_html`, sanitizer off), the nine disallowed tags get their leading
//! `<` escaped — opening and closing forms, case-insensitively — while
//! everything else in the tag stays as-is. A near-miss name (`<styles>`) is
//! NOT filtered: the name must be followed by whitespace, `>`, or `/>`.
//!
//! Streaming parity is release-blocking: the incremental HTML-block cache
//! must apply the filter byte-identically to the full reparse path, both
//! mid-stream (per frame) and at finalize.

use brook_md_core::StreamParser;

const DISALLOWED: &[&str] = &[
    "title", "textarea", "style", "xmp", "iframe", "noembed", "noframes", "script", "plaintext",
];

fn collect(p: &StreamParser) -> String {
    let mut out = String::new();
    for b in p.all_blocks() {
        out.push_str(&b.html);
    }
    out
}

/// One-shot render with `unsafe_html` + the tagfilter, finalized.
fn render(md: &str) -> String {
    let mut p = StreamParser::new().with_unsafe_html(true).with_gfm_tagfilter(true);
    p.append(md);
    p.finalize();
    collect(&p)
}

/// One-shot render with `unsafe_html` only (tagfilter off), finalized.
fn render_no_filter(md: &str) -> String {
    let mut p = StreamParser::new().with_unsafe_html(true);
    p.append(md);
    p.finalize();
    collect(&p)
}

#[test]
fn all_nine_tags_filtered_open_and_close_both_cases() {
    for tag in DISALLOWED {
        let upper = tag.to_ascii_uppercase();
        // Inside a type-6 `<div>` block so every line is raw-HTML pass-through.
        let md = format!("<div>\n<{tag}>a</{tag}>\n<{upper}>b</{upper}>\n</div>\n");
        let expected =
            format!("<div>\n&lt;{tag}>a&lt;/{tag}>\n&lt;{upper}>b&lt;/{upper}>\n</div>\n");
        assert_eq!(render(&md), expected, "tag {tag}");
    }
}

#[test]
fn lookalike_names_are_not_filtered() {
    // The name must be followed by whitespace / `>` / `/>` — a longer name
    // (`<styles>`, `<xmpx>`) or a non-boundary char (`<title-x>`) is a
    // different tag and passes through untouched.
    let md = "<div>\n<styles>a</styles>\n<xmpx>b</xmpx>\n<title-x>c</title-x>\n</div>\n";
    assert_eq!(render(md), md);
}

#[test]
fn attribute_bearing_and_self_closing_forms() {
    let md = "<div>\n<script src=\"x\">alert(1)</script>\n<iframe/>\n<style\ttype=\"text/css\">\n</div>\n";
    let expected =
        "<div>\n&lt;script src=\"x\">alert(1)&lt;/script>\n&lt;iframe/>\n&lt;style\ttype=\"text/css\">\n</div>\n";
    assert_eq!(render(md), expected);
}

#[test]
fn inline_raw_html_is_filtered() {
    // GFM spec example 652, first paragraph: disallowed inline tags escape
    // their `<`; allowed inline tags (`<strong>`, `<em>`) stay verbatim.
    let html = render("<strong> <title> <style> <em>\n");
    assert!(html.contains("<strong> &lt;title> &lt;style> <em>"), "got: {html}");
}

#[test]
fn default_off_output_unchanged() {
    // Without the option, `unsafe_html` passes disallowed tags through
    // verbatim (strict CommonMark) — the filter must never be implied.
    let md = "<title>x</title>\n\ninline <script src=\"x\"></script> here\n";
    let html = render_no_filter(md);
    assert!(html.contains("<title>x</title>"), "got: {html}");
    assert!(html.contains("<script src=\"x\"></script>"), "got: {html}");
}

#[test]
fn escaped_mode_is_unaffected() {
    // With raw HTML escaped (default, no `unsafe_html`) the tag is already
    // inert — the filter must not double-process. Byte-identical either way.
    let md = "<title>x</title>\n\ninline <script>a</script> here\n";
    let mut with = StreamParser::new().with_gfm_tagfilter(true);
    with.append(md);
    with.finalize();
    let mut without = StreamParser::new();
    without.append(md);
    without.finalize();
    assert_eq!(collect(&with), collect(&without));
}

#[test]
fn nested_container_and_component_parsers_inherit_the_flag() {
    // Raw HTML inside a blockquote (container nested parser) and inside a
    // component block (component nested parser): the nested StreamParser must
    // inherit `gfm_tagfilter`, and streamed output must equal one-shot.
    for md in [
        "> <div>\n> <script src=\"x\">a</script>\n> more text here\n> and more\n",
        "<Think>\n\n<title>t</title>\n\ntext\n\n</Think>\n",
    ] {
        let mk = || {
            StreamParser::new()
                .with_unsafe_html(true)
                .with_gfm_tagfilter(true)
                .with_component_tags(vec!["Think".into()])
        };
        let mut one = mk();
        one.append(md);
        one.finalize();
        let mut st = mk();
        let mut buf = [0u8; 4];
        for ch in md.chars() {
            st.append(ch.encode_utf8(&mut buf));
        }
        st.finalize();
        assert_eq!(collect(&st), collect(&one), "streamed != one-shot for {md:?}");
        let out = collect(&one);
        assert!(!out.contains("<script"), "unfiltered script in {out}");
        assert!(!out.to_ascii_lowercase().contains("<title"), "unfiltered title in {out}");
    }
}

// ---------------------------------------------------------------------------
// Streaming parity
// ---------------------------------------------------------------------------

/// A type-6 HTML block long enough to arm the incremental HTML-block cache,
/// with disallowed tags (both cases, attributes, closers) spread across lines.
const STREAM_MD: &str = "<div class=\"wrap\">\n<title>doc title</title>\n<script src=\"x\">alert(1)</script>\n<XMP> raw </XMP>\nplain line with <iframe width=\"1\"></iframe> inline\n<noembed><noframes><plaintext>\n</div>\n\nafter <textarea rows=\"2\"> paragraph\n";

fn one_shot_open(md: &str) -> String {
    // No finalize — the full path's view of the open tail.
    let mut p = StreamParser::new().with_unsafe_html(true).with_gfm_tagfilter(true);
    p.append(md);
    collect(&p)
}

fn streamed_open(md: &str) -> String {
    // Char-by-char, then one empty append so a freshly-armed cache fires.
    let mut p = StreamParser::new().with_unsafe_html(true).with_gfm_tagfilter(true);
    let mut buf = [0u8; 4];
    for ch in md.chars() {
        p.append(ch.encode_utf8(&mut buf));
    }
    p.append("");
    collect(&p)
}

#[test]
fn midstream_every_prefix_matches_one_shot() {
    // For EVERY prefix of the stream, what the streaming consumer sees must
    // equal the one-shot render of that prefix — the cache and the full path
    // must make identical filtering decisions at all cut points.
    for (i, _) in STREAM_MD.char_indices() {
        let prefix = &STREAM_MD[..i];
        assert_eq!(
            streamed_open(prefix),
            one_shot_open(prefix),
            "mid-stream != one-shot at prefix {i}"
        );
    }
}

#[test]
fn streamed_chunks_finalize_byte_identical_and_never_leak_a_live_tag() {
    let one_shot = render(STREAM_MD);
    // The finalized one-shot must itself be fully filtered.
    for tag in DISALLOWED {
        let needle = format!("<{tag}");
        assert!(
            !one_shot.to_ascii_lowercase().contains(&needle),
            "one-shot leaks {needle}: {one_shot}"
        );
    }
    for chunk in [1usize, 3, 64] {
        let mut p = StreamParser::new().with_unsafe_html(true).with_gfm_tagfilter(true);
        let bytes = STREAM_MD.as_bytes();
        let mut pos = 0;
        while pos < bytes.len() {
            let mut end = (pos + chunk).min(bytes.len());
            while !STREAM_MD.is_char_boundary(end) {
                end += 1;
            }
            p.append(&STREAM_MD[pos..end]);
            // No mid-stream frame may ever show a disallowed tag unfiltered —
            // the moment its boundary byte lands, the `<` must be escaped
            // (a truncated `<scrip` prefix is not yet a tag and is inert).
            let frame = collect(&p).to_ascii_lowercase();
            for tag in DISALLOWED {
                let needle = format!("<{tag}");
                // Guard only completed occurrences: name + boundary (or frame
                // end, which the filter also treats as a boundary).
                for (at, _) in frame.match_indices(&needle) {
                    let after = frame.as_bytes().get(at + needle.len());
                    let boundary = match after {
                        None => true,
                        Some(&b'>') => true,
                        Some(&b) if b.is_ascii_whitespace() => true,
                        Some(&b'/') => frame.as_bytes().get(at + needle.len() + 1) == Some(&b'>'),
                        _ => false,
                    };
                    assert!(!boundary, "chunk={chunk}: frame leaks live {needle}: {frame}");
                }
            }
            pos = end;
        }
        p.finalize();
        assert_eq!(collect(&p), one_shot, "chunk={chunk}: finalize != one-shot");
    }
}
