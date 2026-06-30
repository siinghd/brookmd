//! Deterministic complexity gate — asserts the streaming parser stays
//! sub-quadratic on the document shapes that *should* commit/cache linearly.
//!
//! Every O(n²) streaming cliff we have shipped and then fixed by hand
//! (0.18.2 ref-def runs, 0.18.3 nested lists, 0.18.4 blockquote contents) was a
//! tail that stopped committing, so `reparse_tail` re-scanned a growing suffix
//! on every append. This test measures that exact quantity — the bytes the
//! slow path scans, summed over the whole stream (see `flux_md_core::perf`) —
//! and fails if it grows quadratically with document size.
//!
//! It is **deterministic**: it counts work, not wall-clock time, so it can gate
//! in CI without flaking on noisy shared runners. Run with:
//!
//!   cargo test --release --features perf_counters --test scaling
//!
//! Without the feature the whole file compiles to nothing.

#![cfg(feature = "perf_counters")]

use flux_md_core::{perf, StreamParser};

/// Stream `md` in `chunk`-byte pieces (UTF-8 safe), finalize, and return the
/// total slow-path tail bytes scanned. Small chunks = many appends = the most
/// demanding case for an incremental parser.
fn scan_work(md: &str, chunk: usize) -> u64 {
    perf::reset();
    let bytes = md.as_bytes();
    let mut p = StreamParser::new()
        .with_gfm_autolinks(true)
        .with_gfm_alerts(true)
        .with_gfm_math(true);
    let mut i = 0;
    while i < bytes.len() {
        let mut e = (i + chunk).min(bytes.len());
        while e < bytes.len() && (bytes[e] & 0xC0) == 0x80 {
            e += 1;
        }
        p.append(&md[i..e]);
        i = e;
    }
    p.finalize();
    perf::scanned_bytes()
}

// ---- document-shape generators (size-parametric) --------------------------

fn repeat_to(unit: &str, target: usize) -> String {
    let mut s = String::with_capacity(target + unit.len());
    while s.len() < target {
        s.push_str(unit);
    }
    s
}

fn mixed(target: usize) -> String {
    repeat_to(
        "## Section heading\n\nSome **bold** and *italic* prose with a \
[link](https://example.com/path) and `inline code`.\n\n\
- first item\n- second item with `code`\n- third item\n\n\
1. one\n2. two\n\n\
```rust\nfn main() { let x = 1 + 2; }\n```\n\n\
| name | value |\n|:-----|------:|\n| a | 1 |\n| b | 2 |\n\n\
> a block quote with some **emphasis** inside it\n\n",
        target,
    )
}

fn many_paragraphs(target: usize) -> String {
    repeat_to(
        "A short paragraph of explanation with one **bold** word and an `inline` snippet.\n\n\
And a second paragraph here for variety, ending with a [link](https://example.com).\n\n",
        target,
    )
}

fn ref_heavy(n: usize) -> String {
    let mut s = String::new();
    for i in 0..n {
        s.push_str(&format!("Paragraph {i} cites [topic {i}][r{i}] and more text here.\n\n"));
    }
    for i in 0..n {
        s.push_str(&format!("[r{i}]: https://example.com/page/{i} \"Title number {i}\"\n"));
    }
    s
}

fn big_list(target: usize) -> String {
    let mut s = String::with_capacity(target + 32);
    let mut i = 0usize;
    while s.len() < target {
        s.push_str(&format!("- item {i} with some **bold** and a `bit of code` for flavor\n"));
        i += 1;
    }
    s
}

fn nested_loose_list(target: usize) -> String {
    // The 0.18.3 flicker shape: loose outer bullets with 2-space nested subs.
    let mut s = String::with_capacity(target + 32);
    let mut i = 0usize;
    while s.len() < target {
        s.push_str(&format!("- item {i}\n  - sub a\n  - sub b\n  - sub c\n\n"));
        i += 1;
    }
    s
}

fn big_blockquote(target: usize) -> String {
    repeat_to(
        "> a continuation line with some **emphasis** and `code` here, plus more prose.\n",
        target,
    )
}

fn big_alert(target: usize) -> String {
    // The 0.18.4 shape: a `> [!NOTE]` alert with structured inner blocks.
    let mut s = String::from("> [!NOTE]\n");
    let mut i = 0usize;
    while s.len() < target {
        s.push_str(&format!("> - point {i} with **bold**\n> - point {} more\n", i + 1));
        i += 2;
    }
    s
}

fn big_table(target: usize) -> String {
    let mut s = String::from("| Name | Age | City | Score |\n| --- | --- | --- | --- |\n");
    let mut i = 0usize;
    while s.len() < target {
        s.push_str(&format!("| Person {i} | {} | Town {i} | {} |\n", 20 + (i % 60), i * 7 % 1000));
        i += 1;
    }
    s
}

fn big_code(target: usize) -> String {
    let mut s = String::from("```rust\n");
    let line = "    let result = compute(alpha, beta, gamma); // a line of code\n";
    while s.len() < target {
        s.push_str(line);
    }
    s.push_str("```\n");
    s
}

fn big_math(target: usize) -> String {
    let mut s = String::from("$$\n\\begin{aligned}\n");
    let line = "x_{n+1} &= \\frac{1}{2}\\left(x_n + \\frac{a}{x_n}\\right) \\\\\n";
    while s.len() < target {
        s.push_str(line);
    }
    s.push_str("\\end{aligned}\n$$\n");
    s
}

// ---- the gate -------------------------------------------------------------

/// Shapes that MUST stay sub-quadratic: they either commit blocks regularly or
/// are handled by an incremental cache. `(name, generator-by-byte-target)`.
fn linear_shapes() -> Vec<(&'static str, fn(usize) -> String)> {
    vec![
        ("mixed", mixed),
        ("many_paragraphs", many_paragraphs),
        ("big_list", big_list),         // flat list -> ListCache (incremental)
        ("big_blockquote", big_blockquote), // prose quote -> ContainerCache (incremental)
        ("big_table", big_table),
        ("big_code", big_code),
        ("big_math", big_math),
    ]
}

/// KNOWN O(n²) shapes — the next perf target. An open block that holds
/// *structured* inner content (a nested sub-list, or a blockquote/alert whose
/// body is a list / table / nested quote) is one atomic, never-committing block,
/// and its incremental cache currently *bails to a full reparse* every append
/// (the 0.18.3/0.18.4 fixes traded the flicker for this cost). Fixing it needs
/// incremental rendering of structured inner content (a recursive inner parser);
/// until then these are documented, not gated. This test still guards against
/// getting *worse* than quadratic (e.g. an accidental O(n³)).
fn known_quadratic_shapes() -> Vec<(&'static str, fn(usize) -> String)> {
    vec![
        ("nested_loose_list", nested_loose_list),
        ("alert_with_list", big_alert),
    ]
}

/// Sizes spanning 16x. A linear parser's work grows ~16x across this span; a
/// quadratic one grows ~256x. We assert the 16x-span ratio is well below the
/// quadratic regime, with generous headroom for per-shape constants. The linear
/// shapes are cheap even at 256 KB; chunk 128 keeps appends frequent enough to
/// expose any O(n²/chunk) curve while finishing fast in CI.
const SMALL: usize = 16 * 1024;
const LARGE: usize = 256 * 1024;
const SPAN: f64 = (LARGE / SMALL) as f64; // 16.0
const CHUNK: usize = 128;

/// Allowed work-growth ratio across the 16x span. Linear ≈ 16, quadratic ≈ 256.
/// 64 = 4x linear headroom (absorbs cache re-arm constants and small-N noise)
/// while still 4x below the quadratic floor — any real O(n²) cliff blows past it
/// (the shipped cliffs were 100x–2900x).
const MAX_RATIO: f64 = 64.0;

#[test]
fn streaming_stays_subquadratic() {
    let mut failures = Vec::new();
    for (name, gen) in linear_shapes() {
        let w_small = scan_work(&gen(SMALL), CHUNK).max(1);
        let w_large = scan_work(&gen(LARGE), CHUNK).max(1);
        let ratio = w_large as f64 / w_small as f64;
        let per_byte_growth = ratio / SPAN; // 1.0 = perfectly linear
        println!(
            "{name:18} small={w_small:>12} large={w_large:>12}  ratio={ratio:>7.1} (x{SPAN})  growth={per_byte_growth:>5.2}x"
        );
        if ratio > MAX_RATIO {
            failures.push(format!(
                "{name}: work grew {ratio:.1}x across a {SPAN}x size span (limit {MAX_RATIO}x) — superlinear regression"
            ));
        }
    }
    assert!(failures.is_empty(), "complexity regression(s):\n  {}", failures.join("\n  "));
}

/// Documents the two known O(n²) cliffs (nested lists, containers-with-blocks)
/// and guards against them regressing *past* quadratic. When the recursive
/// inner-parser fix lands, move the fixed shape into `linear_shapes()`.
#[test]
fn known_quadratic_open_containers_not_worse() {
    // These are O(n²), so use a smaller 8x span (8 KB -> 64 KB) to keep the test
    // fast. Quadratic ≈ 64x work across an 8x span; allow up to 160x (well over
    // quadratic) so this trips only on a worse-than-quadratic (e.g. cubic)
    // regression — the quadratic itself is the documented limit, not a failure.
    const SMALL_Q: usize = 8 * 1024;
    const LARGE_Q: usize = 64 * 1024;
    const SPAN_Q: f64 = (LARGE_Q / SMALL_Q) as f64; // 8.0
    const WORSE_THAN_QUADRATIC: f64 = 160.0;
    for (name, gen) in known_quadratic_shapes() {
        let w_small = scan_work(&gen(SMALL_Q), CHUNK).max(1);
        let w_large = scan_work(&gen(LARGE_Q), CHUNK).max(1);
        let ratio = w_large as f64 / w_small as f64;
        println!("[KNOWN O(n²) — fix target] {name:18} ratio={ratio:>7.1} (x{SPAN_Q})  small={w_small} large={w_large}");
        assert!(
            ratio < WORSE_THAN_QUADRATIC,
            "{name}: work grew {ratio:.1}x across {SPAN_Q}x — WORSE than the documented quadratic limit"
        );
    }
}

/// Pins the exact 0.18.2 regression: a paragraph immediately followed by a long
/// run of link-reference definitions used to stall `committed_offset`, so the
/// whole growing def run re-scanned every append (235 KB @ chunk 256 = 59 s).
/// The fix made it linear; this guards it deterministically.
#[test]
fn ref_def_run_is_linear() {
    let small = scan_work(&ref_heavy(250), CHUNK).max(1);
    let large = scan_work(&ref_heavy(4000), CHUNK).max(1); // 16x more defs
    let ratio = large as f64 / small as f64;
    println!("ref_heavy  small={small} large={large} ratio={ratio:.1} (x16 defs)");
    assert!(
        ratio < MAX_RATIO,
        "ref-def run regressed to superlinear: {ratio:.1}x work for 16x defs (limit {MAX_RATIO}x)"
    );
}
