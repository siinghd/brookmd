//! Run the GitHub Flavored Markdown *extension* examples (tables, task lists,
//! strikethrough, extended autolinks, disallowed raw HTML) against
//! brookmd-core. The CommonMark base is covered by `cmark_spec.rs`; this file
//! quantifies coverage of the GFM-specific features the demo advertises.
//!
//! Set `GFM_MIN_PASS=N` to enforce a regression floor.

use brook_md_core::StreamParser;
use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Deserialize)]
struct SpecCase {
    markdown: String,
    html: String,
    example: u32,
    section: String,
}

const SPEC_JSON: &str = include_str!("gfm-spec.json");

fn render_md(src: &str) -> String {
    let mut p = StreamParser::new()
        .with_unsafe_html(true)
        .with_gfm_autolinks(true)
        .with_gfm_tagfilter(true);
    p.append(src);
    p.finalize();
    let mut out = String::new();
    for b in p.all_blocks() {
        out.push_str(&b.html);
    }
    out
}

/// Normalize cosmetic HTML differences: collapse whitespace outside tags,
/// drop our security-only link attrs, treat void-element self-closing as
/// equivalent, and canonicalize the task-list `<input>` attribute soup
/// (order/`=""` differ between renderers but are semantically identical).
fn normalize(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => {
                in_tag = true;
                out.push('<');
            }
            '>' => {
                in_tag = false;
                out.push('>');
            }
            c if c.is_whitespace() && !in_tag => {
                if !out.ends_with(' ') && !out.ends_with('>') {
                    out.push(' ');
                }
            }
            c => out.push(c),
        }
    }
    let s = out
        .replace(" target=\"_blank\"", "")
        .replace(" rel=\"noopener noreferrer nofollow\"", "")
        .replace(" />", ">")
        .replace("/>", ">")
        // GFM emits `align="x"`; we emit the modern `style="text-align:x"`.
        // Treat them as equivalent.
        .replace(" style=\"text-align:center\"", " align=\"center\"")
        .replace(" style=\"text-align:left\"", " align=\"left\"")
        .replace(" style=\"text-align:right\"", " align=\"right\"");
    canonical_checkbox(&s).trim().to_string()
}

/// Reduce any `<input ...>` to a canonical `<input[ checked] type="checkbox">`
/// regardless of attribute order, `disabled`, or `=""` quoting noise.
fn canonical_checkbox(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(p) = rest.find("<input") {
        out.push_str(&rest[..p]);
        let after = &rest[p..];
        let end = after.find('>').map(|i| i + 1).unwrap_or(after.len());
        let tag = &after[..end];
        let checked = tag.contains("checked");
        out.push_str(if checked {
            "<input checked type=\"checkbox\">"
        } else {
            "<input type=\"checkbox\">"
        });
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}

#[derive(Default)]
struct Stats {
    pass: u32,
    fail: u32,
}

#[test]
fn gfm_extension_spec() {
    let cases: Vec<SpecCase> = serde_json::from_str(SPEC_JSON).expect("parse gfm-spec.json");
    let verbose = std::env::var("GFM_VERBOSE").is_ok();
    let mut per: BTreeMap<String, Stats> = BTreeMap::new();
    let (mut pass, mut total) = (0u32, 0u32);
    for c in &cases {
        total += 1;
        let e = per.entry(c.section.clone()).or_default();
        if normalize(&render_md(&c.markdown)) == normalize(&c.html) {
            e.pass += 1;
            pass += 1;
        } else {
            e.fail += 1;
            if verbose {
                eprintln!("--- gfm example {} [{}] ---", c.example, c.section);
                eprintln!("md:       {:?}", c.markdown);
                eprintln!("expected: {}", normalize(&c.html));
                eprintln!("actual:   {}", normalize(&render_md(&c.markdown)));
            }
        }
    }
    eprintln!("\n=== GFM extension coverage ===");
    for (sec, st) in &per {
        let rate = st.pass as f64 / (st.pass + st.fail) as f64 * 100.0;
        eprintln!("{:<32} {:>3}/{:<3} {:>5.1}%", sec, st.pass, st.pass + st.fail, rate);
    }
    eprintln!("{:<32} {:>3}/{:<3} {:>5.1}%", "TOTAL", pass, total, pass as f64 / total as f64 * 100.0);

    if let Ok(min) = std::env::var("GFM_MIN_PASS") {
        let min: u32 = min.parse().unwrap();
        assert!(pass >= min, "regression: {pass}/{total} GFM pass, expected >= {min}");
    }
}
