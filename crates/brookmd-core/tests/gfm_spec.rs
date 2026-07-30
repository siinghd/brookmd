//! Run the GitHub Flavored Markdown *extension* examples (tables, task lists,
//! strikethrough, extended autolinks, disallowed raw HTML) against
//! brookmd-core. The CommonMark base is covered by `cmark_spec.rs`; this file
//! quantifies coverage of the GFM-specific features the demo advertises.
//!
//! Set `GFM_MIN_PASS=N` to enforce a regression floor.

use brook_md_core::{Block, StreamParser};
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

/// Document assembly (WIRE.md §12): a block's `html` never ends with a newline,
/// so joining blocks into one document string inserts the separator — `cr()`
/// style, i.e. a `\n` only when the previous block does not ALREADY end with
/// one (a raw HTML block serializes its own).
fn cr(out: &mut String) {
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
}

/// Join a parser's blocks into a whole-document HTML string — see [`cr`]. The
/// document is terminated by a final `cr()`, matching the reference renderer's
/// one `\n` after every top-level block.
fn join_document<'a>(blocks: impl Iterator<Item = &'a Block>) -> String {
    let mut out = String::new();
    for b in blocks {
        cr(&mut out);
        out.push_str(&b.html);
    }
    cr(&mut out);
    out
}

fn render_md(src: &str) -> String {
    let mut p = StreamParser::new()
        .with_unsafe_html(true)
        .with_gfm_autolinks(true)
        .with_gfm_tagfilter(true);
    p.append(src);
    p.finalize();
    join_document(p.all_blocks())
}

/// Fold the *deliberate*, documented differences between brookmd's output and
/// the GFM reference renderer: security-only link attrs we add, HTML5 void
/// elements instead of XHTML self-closing ones, and the modern
/// `style="text-align:x"` in place of GFM's deprecated `align="x"`. Each is a
/// brookmd output choice, not whitespace forgiveness, so folding them cannot
/// hide a structural divergence.
///
/// This is the *only* transform applied on the byte-exact path.
fn canonicalize(html: &str) -> String {
    html.replace(" target=\"_blank\"", "")
        .replace(" rel=\"noopener noreferrer nofollow\"", "")
        .replace(" />", ">")
        .replace("/>", ">")
        // GFM emits `align="x"`; we emit the modern `style="text-align:x"`.
        // Treat them as equivalent.
        .replace(" style=\"text-align:center\"", " align=\"center\"")
        .replace(" style=\"text-align:left\"", " align=\"left\"")
        .replace(" style=\"text-align:right\"", " align=\"right\"")
}

/// Whitespace laxity: collapse every run of whitespace outside a tag to a
/// single space, dropping it entirely after a `>`. Forgiveness, not a
/// documented difference — never used on the byte-exact path.
fn collapse_ws(html: &str) -> String {
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
    out
}

/// Normalize cosmetic HTML differences: fold the deliberate differences, then
/// collapse whitespace outside tags. Structural fidelity, not byte equality —
/// see the `exact` tally in `gfm_extension_spec` for the byte-equality number.
///
/// A `canonical_checkbox` step used to sit here, folding the task-list
/// `<input>` attribute order and `=""` spelling. It was removed once the
/// emitter started producing GFM's exact byte-form
/// (`<input checked="" disabled="" type="checkbox">`, examples 279/280): the
/// laxity existed only to forgive that difference, and forgiving it would now
/// hide a real regression.
fn normalize(html: &str) -> String {
    canonicalize(&collapse_ws(html)).trim().to_string()
}

#[derive(Default)]
struct Stats {
    pass: u32,
    fail: u32,
    exact: u32,
}

#[test]
fn gfm_extension_spec() {
    let cases: Vec<SpecCase> = serde_json::from_str(SPEC_JSON).expect("parse gfm-spec.json");
    let verbose = std::env::var("GFM_VERBOSE").is_ok();
    let verbose_exact = std::env::var("GFM_EXACT_VERBOSE").is_ok();
    let mut per: BTreeMap<String, Stats> = BTreeMap::new();
    let (mut pass, mut total, mut exact) = (0u32, 0u32, 0u32);
    let mut exact_failed_examples: Vec<u32> = Vec::new();
    for c in &cases {
        total += 1;
        let e = per.entry(c.section.clone()).or_default();
        let raw = render_md(&c.markdown);
        if normalize(&raw) == normalize(&c.html) {
            e.pass += 1;
            pass += 1;
        } else {
            e.fail += 1;
            if verbose {
                eprintln!("--- gfm example {} [{}] ---", c.example, c.section);
                eprintln!("md:       {:?}", c.markdown);
                eprintln!("expected: {}", normalize(&c.html));
                eprintln!("actual:   {}", normalize(&raw));
            }
        }

        // Independent, byte-exact tally: only the deliberate output
        // differences are folded away, no whitespace forgiveness at all.
        // Fixtures terminate the document with a newline that our block HTML
        // does not carry; that terminator is a serialization convention, so
        // `trim_end` both sides. Leading whitespace is never trimmed.
        let exact_actual = canonicalize(&raw);
        let exact_expected = canonicalize(&c.html);
        if exact_actual.trim_end() == exact_expected.trim_end() {
            e.exact += 1;
            exact += 1;
        } else {
            exact_failed_examples.push(c.example);
            if verbose_exact {
                eprintln!("--- EXACT gfm example {} [{}] ---", c.example, c.section);
                eprintln!("md:       {:?}", c.markdown);
                eprintln!("expected: {:?}", exact_expected.trim_end());
                eprintln!("actual:   {:?}", exact_actual.trim_end());
            }
        }
    }
    eprintln!("\n=== GFM extension coverage ===");
    for (sec, st) in &per {
        let n = st.pass + st.fail;
        let rate = st.pass as f64 / n as f64 * 100.0;
        let exact_rate = st.exact as f64 / n as f64 * 100.0;
        eprintln!(
            "{:<32} {:>3}/{:<3} {:>5.1}%   exact {:>3}/{:<3} {:>5.1}%",
            sec, st.pass, n, rate, st.exact, n, exact_rate
        );
    }
    eprintln!(
        "{:<32} {:>3}/{:<3} {:>5.1}%   exact {:>3}/{:<3} {:>5.1}%",
        "TOTAL",
        pass,
        total,
        pass as f64 / total as f64 * 100.0,
        exact,
        total,
        exact as f64 / total as f64 * 100.0
    );
    eprintln!(
        "\nnormalized (structural, whitespace-lax): {pass}/{total}\n\
         byte-exact  (deliberate diffs folded only): {exact}/{total}"
    );
    if !exact_failed_examples.is_empty() {
        eprintln!(
            "byte-exact failures ({}): {:?}",
            exact_failed_examples.len(),
            exact_failed_examples
        );
        eprintln!("(set GFM_EXACT_VERBOSE=1 for per-example diffs)");
    }

    if let Ok(min) = std::env::var("GFM_MIN_PASS") {
        let min: u32 = min.parse().unwrap();
        assert!(pass >= min, "regression: {pass}/{total} GFM pass, expected >= {min}");
    }

    // Byte-exact ratchet: the measured floor, so a byte regression fails CI
    // even though the normalized tally would still be green. Override with
    // GFM_MIN_EXACT; raise the default whenever the number goes up. 24 = every
    // GFM extension example, byte-for-byte.
    let min_exact: u32 = match std::env::var("GFM_MIN_EXACT") {
        Ok(v) => v.parse().unwrap(),
        Err(_) => 24,
    };
    assert!(
        exact >= min_exact,
        "regression: {exact}/{total} GFM byte-exact, expected >= {min_exact}"
    );
}
