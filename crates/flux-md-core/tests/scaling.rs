//! Deterministic complexity gate — bounds the streaming parser's *work* (not
//! wall-clock time) across a size span, per document shape, per metric.
//!
//! Three counters (see `flux_md_core::perf`), because streaming cost goes
//! quadratic in three distinct ways:
//!
//! - `scanned`  — slow-path tail re-scan bytes. Every cliff we shipped and then
//!   fixed by hand (0.18.2 ref-def runs, 0.18.3 nested lists, 0.18.4 blockquote
//!   contents) was a tail that stopped committing, so `reparse_tail` re-scanned
//!   a growing suffix each append.
//! - `rendered` — bytes entering the inline renderer. Catches cache-INTERNAL
//!   quadratics the scan counter is blind to: a cache that stays armed but
//!   re-inline-renders a growing region every append (open list item bodies,
//!   table partial rows, pinned container paragraph cuts).
//! - `emitted`  — HTML bytes crossing the `append`/`finalize` patch boundary.
//!   Informational only (printed, never asserted): re-emitting the full open
//!   block per append is the current wire contract, so this is inherently
//!   O(n²/chunk) for any giant single open block.
//!
//! Each shape declares an expectation per gated metric:
//!
//! - `Linear`         — must stay ~O(n); ratio across the span ≤ 4x linear.
//! - `KnownQuadratic` — documented O(n²), the open fix-campaign target list
//!   (named by hunt group key). Guarded against regressing PAST quadratic
//!   (an accidental O(n³)). When a group is fixed, flip it to `Linear`.
//! - `Untracked`      — the metric cannot see this shape's work (wall-only
//!   cost, e.g. memcpy/allocator churn); printed, not asserted.
//!
//! Deterministic: counts work, so it gates in CI without flaking on noisy
//! shared runners. Run with:
//!
//!   cargo test --release --features perf_counters --test scaling -- --nocapture
//!
//! Without the feature the whole file compiles to nothing.

#![cfg(feature = "perf_counters")]

use flux_md_core::{perf, StreamParser};
use std::time::Instant;

// ---- harness ---------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Debug)]
enum Expect {
    Linear,
    KnownQuadratic,
    /// Declared vocabulary for future entries whose cliff no counter can see
    /// (wall-only): printed, never asserted. Currently every registered shape
    /// classifies as Linear or KnownQuadratic on both gated metrics.
    #[allow(dead_code)]
    Untracked,
}

/// Builder options a shape needs beyond the always-on base set
/// (autolinks + alerts + math, the richest common streaming configuration).
#[derive(Clone, Copy, Default)]
struct Opts {
    footnotes: bool,
    block_data: bool,
    component_tags: &'static [&'static str],
    unsafe_html: bool,
    /// Giant-word shapes are linear exactly when extended autolinks are off (a
    /// future `@` legitimately binds an alnum run right-to-left, so with
    /// autolinks on the commit cut is semantically pinned).
    no_autolinks: bool,
}

struct Shape {
    name: &'static str,
    gen: fn(usize) -> String,
    opts: Opts,
    chunk: usize,
    small: usize,
    large: usize,
    scanned: Expect,
    rendered: Expect,
}

struct Work {
    scanned: u64,
    rendered: u64,
    emitted: u64,
    wall_ms: f64,
}

/// Stream `md` in `chunk`-byte pieces (UTF-8 safe), finalize, and return all
/// work counters plus wall time. Small chunks = many appends = the most
/// demanding case for an incremental parser.
fn measure(md: &str, chunk: usize, o: Opts) -> Work {
    perf::reset();
    let bytes = md.as_bytes();
    let mut p = StreamParser::new()
        .with_gfm_autolinks(!o.no_autolinks)
        .with_gfm_alerts(true)
        .with_gfm_math(true)
        .with_gfm_footnotes(o.footnotes)
        .with_block_data(o.block_data)
        .with_unsafe_html(o.unsafe_html);
    if !o.component_tags.is_empty() {
        p = p.with_component_tags(o.component_tags.iter().map(|s| s.to_string()).collect());
    }
    let start = Instant::now();
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
    let wall_ms = start.elapsed().as_secs_f64() * 1e3;
    Work {
        scanned: perf::scanned_bytes().max(1),
        rendered: perf::rendered_bytes().max(1),
        emitted: perf::emitted_bytes().max(1),
        wall_ms,
    }
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

fn quote_many_paras(target: usize) -> String {
    // A prose blockquote whose body is MANY short inner paragraphs (each blank
    // `>` line closes one) — the ContainerCache shape whose committed-paras data
    // channel re-emits per append. Kept linear by the Rc-shared committed entries.
    let mut s = String::with_capacity(target + 32);
    let mut i = 0usize;
    while s.len() < target {
        s.push_str(&format!("> para {i} with some **bold** prose here\n>\n"));
        i += 1;
    }
    s
}

fn bq_lazy_continuation(target: usize) -> String {
    // One `>` line, then marker-less lazy paragraph-continuation lines forever
    // (CommonMark laziness). The container cache used to bail on every lazy
    // line, so the never-committing quote re-scanned its whole tail per append
    // (O(n²)); the cache now glues lazy lines exactly like `blockquote_inner`.
    let mut s = String::from("> the quoted paragraph starts here\n");
    let mut i = 0usize;
    while s.len() < target {
        s.push_str(&format!("lazy continuation line {i} with plain prose words\n"));
        i += 1;
    }
    s
}

fn quote_ref_defs(target: usize) -> String {
    // A blockquote hosting a growing run of link-reference definitions. The
    // recursive container-block cache used to refuse any container holding a
    // `]:` (document-global scoping), so the quote armed NO cache and the whole
    // growing tail re-scanned per append (O(n²), 44 s @ 512 KB). The nested
    // parser now consumes def lines natively (its own def-run commit), and the
    // outer full reparse re-derives the global ref table whenever the container
    // closes/commits.
    let mut s = String::with_capacity(target + 64);
    let mut i = 0usize;
    while s.len() < target {
        s.push_str(&format!("> [r{i}]: https://example.com/page/{i} \"Title {i}\"\n"));
        i += 1;
    }
    s
}

fn quote_footnote_defs(target: usize) -> String {
    // Same shape with `[^label]:` defs. With footnotes OFF (this harness),
    // `[^f0]:` is a plain link-ref def whose label happens to start with `^` —
    // it must stream linearly like `quote_ref_defs`. (With footnotes ON the
    // container cache still bails on `[^` — document-global numbering — and
    // that flavor remains a known-quadratic follow-up.)
    let mut s = String::with_capacity(target + 64);
    let mut i = 0usize;
    while s.len() < target {
        s.push_str(&format!("> [^f{i}]: https://example.com/note/{i} \"Note {i}\"\n"));
        i += 1;
    }
    s
}

fn quote_depth_growing(target: usize) -> String {
    // Ever-deepening nested blockquotes: line k carries k `>` markers. The
    // recursive container-block cache spends one nested parser per level and is
    // capped at MAX_CONTAINER_DEPTH; past the cap the innermost parser
    // full-reparses its growing tail every append with O(depth) marker
    // restripping per line — worse than quadratic. Fixing this needs an
    // iterative wrapper-stack representation (fold the settled shallower level
    // once when the stack deepens, single innermost parser).
    let mut s = String::with_capacity(target + 4096);
    let mut k = 1usize;
    while s.len() < target {
        for _ in 0..k {
            s.push_str("> ");
        }
        s.push_str(&format!("level {k} prose with **bold**\n"));
        k += 1;
    }
    s
}

fn big_alert(target: usize) -> String {
    // The 0.18.4 shape: a `> [!NOTE]` alert with structured inner blocks. The
    // recursive container-block cache renders the `>`-stripped inner through a
    // nested StreamParser, so it now streams linearly instead of re-parsing the
    // whole growing alert body every append.
    let mut s = String::from("> [!NOTE]\n");
    let mut i = 0usize;
    while s.len() < target {
        s.push_str(&format!("> - point {i} with **bold**\n> - point {} more\n", i + 1));
        i += 2;
    }
    s
}

fn blockquote_with_list(target: usize) -> String {
    // A plain `>` blockquote whose body is a list — the other structured-inner
    // container shape the recursive container-block cache makes linear.
    let mut s = String::with_capacity(target + 32);
    let mut i = 0usize;
    while s.len() < target {
        s.push_str(&format!("> - point {i} with **bold** and `code`\n"));
        i += 1;
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

// ---- fix-campaign generators (one per verified O(n²) hunt group) -----------

/// open-block-html-reemit: a giant never-closing fence. Cache-hit appends
/// re-materialize the whole open block's HTML (memcpy + Block clone) — a
/// wall-only cliff both work counters are blind to; `emitted` shows it.
fn unclosed_fence(target: usize) -> String {
    let mut s = String::from("```rust\n");
    while s.len() < target {
        s.push_str("let result = compute(alpha, beta, gamma); // never closes\n");
    }
    s
}

/// commit-cut-pinned-no-boundary: a single enormous word — zero inter-word
/// boundary candidates, so the paragraph cache never arms and every append
/// full-rescans + re-renders the whole tail.
fn one_giant_word(target: usize) -> String {
    "a".repeat(target)
}

/// uncached-open-block-kinds (FIXED): an open ComponentBlock had no
/// incremental cache arm in `reparse_tail`, so its growing body full-rescanned
/// every append; it now streams via ComponentBlockCache (recursive nested
/// parser, like the container shapes).
fn component_block_open(target: usize) -> String {
    let mut s = String::from("<Chart>\n");
    let mut i = 0usize;
    while s.len() < target {
        s.push_str(&format!("data point {i} with **bold** and `code` in the body line\n"));
        i += 1;
    }
    s // close tag never arrives
}

/// A single giant ATX heading line, still growing (no newline) — streams via
/// HeadingCache (the paragraph cache's settled-prefix scheme in `<hN>`).
fn heading_words(target: usize) -> String {
    let mut s = String::from("# ");
    let mut i = 0usize;
    while s.len() < target {
        s.push_str(&format!("word{i} "));
        i += 1;
    }
    s
}

/// Same shape with inline constructs: pre-cache this went ~cubic in wall time
/// (quadratic re-scan × superlinear whole-line inline re-render).
fn heading_emphasis(target: usize) -> String {
    let mut s = String::from("# ");
    let mut i = 0usize;
    while s.len() < target {
        s.push_str(&format!("*word{i}* and **bold{i}** "));
        i += 1;
    }
    s
}

/// A thematic-break line still growing — RuleCache (constant `<hr>`).
fn growing_rule(target: usize) -> String {
    "-".repeat(target)
}

/// A code fence whose OPENER line (info string) grows without a newline —
/// FenceInfoCache (output frozen once the first info word settles).
fn fence_giant_info(target: usize) -> String {
    let mut s = String::from("```rust ");
    while s.len() < target {
        s.push_str("attr ");
    }
    s
}

/// KNOWN O(n²): a blockquote whose FIRST line never completes — both container
/// caches require a complete first line (Blockquote-vs-Alert isn't settled),
/// so every append full-rescans the growing tail.
fn quote_giant_line(target: usize) -> String {
    let mut s = String::from("> ");
    while s.len() < target {
        s.push_str("prose without any newline at all ");
    }
    s
}

/// KNOWN O(n²): same first-line bail, single giant CJK line (no spaces).
fn bq_cjk_one_line(target: usize) -> String {
    let mut s = String::from("> ");
    while s.len() < target {
        s.push_str("漢字の行が続く");
    }
    s
}

/// html-empty-partial-blank-close (FIXED): open raw-HTML block with 64-byte
/// lines so every chunk=128 append ends precisely at a line boundary (empty
/// trailing partial). An empty partial used to vacuously pass the type-6/7
/// blank-line close test, dropping the HtmlBlockCache (and refusing to re-arm)
/// on every such append -> O(n²); now it stays armed and streams linearly.
fn html_block_aligned(opener: &str, target: usize) -> String {
    let mut s = String::with_capacity(target + 64);
    let mut open = String::from(opener);
    while open.len() < 63 {
        open.push(' ');
    }
    open.push('\n');
    s.push_str(&open);
    let line = "abcdefghij klmnopqrst uvwxyz0123 456789ABCD EFGHIJKLMN OPQRSTUV\n"; // 64 bytes
    while s.len() < target {
        s.push_str(line);
    }
    s
}

fn html_type6_aligned(target: usize) -> String {
    html_block_aligned("<div class=\"wrap\">", target)
}

fn html_type7_aligned(target: usize) -> String {
    html_block_aligned("<mytag class=\"wrap\">", target)
}

/// footnote-global-state (FIXED) — four member shapes, streamed with
/// `gfm_footnotes` ON. All used to cliff via document-global footnote state:
///   a1: a NO-blank run of single-line defs scans as ONE raw block, so the
///       pure-def-tail commit never advanced past it (ctr ratio 248 pre-fix);
///       fixed by committing the run up to its last def-opener line.
///   a2: blank-separated defs — the pre-existing >=2 def-block commit branch;
///       linear before, guarded here against regressing.
///   c:  ONE paragraph with thousands of distinct refs — the numbering
///       pre-pass re-collected the WHOLE cache region per append:
///       wall-quadratic (199x) but counter-BLIND pre-fix. The incremental
///       per-cache numbering (`RegionFnNums`) is itself counter-instrumented
///       now, so this entry really gates the class.
///   g:  flat list where every item carries a distinct ref — the list cache
///       used to line_bail on any `[^` (ctr ratio 160 pre-fix); now only
///       genuine def lines bail.
fn a1_def_run_noblank(target: usize) -> String {
    let mut s = String::from("Intro paragraph citing a note.[^f0]\n\n");
    let mut i = 0usize;
    while s.len() < target {
        s.push_str(&format!("[^f{i}]: footnote text number {i} with some words\n"));
        i += 1;
    }
    s
}

fn a2_def_run_blank(target: usize) -> String {
    let mut s = String::from("Intro paragraph citing a note.[^f0]\n\n");
    let mut i = 0usize;
    while s.len() < target {
        s.push_str(&format!("[^f{i}]: footnote text number {i} with some words\n\n"));
        i += 1;
    }
    s
}

fn c_many_refs_one_para(target: usize) -> String {
    let mut s = String::new();
    let mut i = 0usize;
    while s.len() < target {
        s.push_str(&format!("word{i} [^c{i}] and"));
        s.push(if i % 8 == 7 { '\n' } else { ' ' });
        i += 1;
    }
    s
}

fn g_big_list_refs(target: usize) -> String {
    let mut s = String::new();
    let mut i = 0usize;
    while s.len() < target {
        s.push_str(&format!("- item {i} cites a source[^g{i}] here\n"));
        i += 1;
    }
    s
}

/// open-list-item-body-rerender (FIXED): a quoted list item whose body is a
/// growing table — the open item never folds, and `fold_item_body` used to
/// re-render it whole every append (scan-counter-blind). The OpenItemStream
/// (nested parser) makes an armed item body stream in O(new bytes), and the
/// speculative fold is now counted, so both metrics pin this class:
/// ContainerBlockCache recursing into a nested ListCache recursing into an
/// OpenItemStream + TableCache.
fn quoted_list_table(target: usize) -> String {
    let mut s = String::from("> - intro\n>   | a | b |\n>   | --- | --- |\n");
    let mut i = 0usize;
    while s.len() < target {
        s.push_str(&format!(">   | cell {i} | value {i} |\n"));
        i += 1;
    }
    s
}

/// ONE list item with an ever-growing plain-prose multi-line body — the
/// wall-only half of the open-item cliff.
fn list_item_plain_body(target: usize) -> String {
    let mut s = String::from("- intro line for the single item\n");
    let mut i = 0usize;
    while s.len() < target {
        s.push_str(&format!(
            "  plain continuation prose line {i} with several ordinary words here\n"
        ));
        i += 1;
    }
    s
}

/// ONE list item whose body is an ever-growing table (the nested stream's own
/// TableCache makes the per-append work O(new bytes)).
fn list_growing_table(target: usize) -> String {
    let mut s = String::from("- intro\n  | a | b |\n  | --- | --- |\n");
    let mut i = 0usize;
    while s.len() < target {
        s.push_str(&format!("  | cell {i} | value {i} |\n"));
        i += 1;
    }
    s
}

/// ONE list item holding an ever-growing open fence. Pins the open-item
/// stream's kind-aware `open_tail` sensitivity: the fence opener's backticks
/// must NOT poison the settled-append fast path (code bodies never
/// inline-render, so they are exempt from the trigger-byte scan).
fn list_open_fence(target: usize) -> String {
    let mut s = String::from("- item with a growing fence\n  ```rust\n");
    while s.len() < target {
        s.push_str("  let x = compute(alpha, beta); // fence line\n");
    }
    s
}

/// ONE ever-growing directly-loose item (§5.3): blank-separated sub-paragraphs
/// inside a single item. The blank used to hard-bail the list cache.
fn loose_subs_one_item(target: usize) -> String {
    let mut s = String::from("- topic intro\n");
    let mut i = 0usize;
    while s.len() < target {
        s.push_str(&format!("\n  sub paragraph {i} with a few words of detail\n"));
        i += 1;
    }
    s
}

/// Every item directly loose (§5.3): an interior blank between the item's two
/// paragraphs used to hard-bail the list cache — and the re-armed cache
/// re-bailed every append (counter ~247x).
fn staircase_blank_flap(target: usize) -> String {
    let mut s = String::with_capacity(target + 64);
    let mut i = 0usize;
    while s.len() < target {
        s.push_str(&format!(
            "- step {i} heading text\n\n  step {i} detail paragraph with words\n"
        ));
        i += 1;
    }
    s
}

/// table-partial-row-rerender (FIXED): the trailing table row never gets its
/// newline; the speculative partial-row render used to re-split + re-render
/// the whole growing partial every append (scan-counter-blind; `rendered` saw
/// it). The PartialRowCache freezes settled cells at each unescaped `|` and
/// commits the open cell's settled inline prefix, so only new bytes are
/// examined per append.
fn growing_last_cell(target: usize) -> String {
    let mut s = String::from("| a | b |\n| --- | --- |\n| x | y |\n| last | ");
    while s.len() < target {
        s.push_str("word word word ");
    }
    s.push_str("|\n");
    s
}

/// One header/alignment/data row with thousands of columns — the other
/// partial-row flavor (growth across cells rather than inside one).
fn wide_one_row(target: usize) -> String {
    let cols = (target / 21).max(4);
    let mut s = String::with_capacity(target + 64);
    for i in 0..cols {
        s.push_str("| h");
        s.push_str(&i.to_string());
        s.push(' ');
    }
    s.push_str("|\n");
    for _ in 0..cols {
        s.push_str("| --- ");
    }
    s.push_str("|\n");
    for i in 0..cols {
        s.push_str("| c");
        s.push_str(&i.to_string());
        s.push(' ');
    }
    s.push_str("|\n");
    s
}

/// resolve-delimiters-replace-range (FIXED): emphasis-pair-dense paragraph —
/// each resolved pair used to splice via `replace_range`, O(pairs × slice)
/// inside one inline render; edits now apply in a single forward-pass rebuild.
/// Counter-linear guard: the render-side win itself is wall-only.
fn strikethrough_one_para(target: usize) -> String {
    let mut s = String::new();
    let mut i = 0usize;
    while s.len() < target {
        s.push_str(&format!("w{i} ~~struck {i}~~ mid "));
        if i % 8 == 7 {
            s.push('\n');
        }
        i += 1;
    }
    s
}

/// delimiter-stack-mod3-rescan (per-render FIXED via openers_bottom; streaming
/// pin remains): a lone `**` opener permanently blocked by the mod-3 rule used
/// to make every later `*` closer re-walk the whole delimiter stack (O(stack²)
/// per render, so streaming went ~cubic in wall). The bounded scan makes one
/// render linear; the paragraph cut stays semantically pinned (a future `**`
/// closer could pair back), so streaming is counter-bounded quadratic.
fn mod3_soup(target: usize) -> String {
    let mut s = String::from("a**b");
    while s.len() < target {
        s.push_str("c* ");
    }
    s
}

/// dollar-math-eof-rescan (per-render FIXED via precomputed closer tables;
/// streaming pin remains): every `$` is a valid opener whose candidate closers
/// are all invalid, so each opener used to scan to EOF (O(n²) inside one
/// render). Memoized next-valid-closer lookup makes one render linear; the
/// paragraph cut stays semantically pinned (a future closer could pair back),
/// so streaming is counter-bounded quadratic.
fn dollar_soup(target: usize) -> String {
    let mut s = String::with_capacity(target + 8);
    while s.len() < target {
        s.push_str("$x ");
    }
    s
}

/// compute-cut-pair-overlap-scan (FIXED): thousands of resolved emphasis pairs
/// made `compute_cut`'s per-candidate pair-overlap scan O(candidates × pairs);
/// now a single ascending sweep with a running max. Counter-linear guard.
fn em_pairs_one_para(target: usize) -> String {
    repeat_to("*em* ", target)
}

/// commit-cut-pinned-no-boundary (PARTIALLY FIXED): a single space-free
/// paragraph of completed entities had zero boundary candidates, pinning the
/// commit cut at 0 (counter-visible ~250x). Synthetic boundary candidates
/// inside inert runs let the cut advance every ~2 KB.
fn entity_soup(target: usize) -> String {
    repeat_to("&amp;", target)
}

/// One giant space-free "word" with periodic non-autolinkable bytes (`;`).
/// Synthetic candidates may only sit on bytes an extended autolink can neither
/// contain nor start (a future `@` binds alnum runs backwards), so this is the
/// autolinks-on-safe flavor of the giant-word shape.
fn punctuated_giant_word(target: usize) -> String {
    repeat_to("abcdefghij;", target)
}

/// crlf-cache-bail (FIXED): CRLF line endings used to bail every incremental
/// cache, so ordinary CRLF streams full-rescanned each append; ingest
/// normalization (`\r\n`/lone `\r` -> `\n` before the buffer) makes them take
/// the exact same fast paths as LF. One twin per confirmed member family.
fn crlf_big_list(target: usize) -> String {
    big_list(target).replace('\n', "\r\n")
}

fn crlf_mixed(target: usize) -> String {
    mixed(target).replace('\n', "\r\n")
}

fn crlf_big_code(target: usize) -> String {
    big_code(target).replace('\n', "\r\n")
}

fn crlf_big_table(target: usize) -> String {
    big_table(target).replace('\n', "\r\n")
}

fn crlf_nested_loose_list(target: usize) -> String {
    nested_loose_list(target).replace('\n', "\r\n")
}

fn crlf_blockquote_with_list(target: usize) -> String {
    blockquote_with_list(target).replace('\n', "\r\n")
}

fn crlf_alert_with_list(target: usize) -> String {
    big_alert(target).replace('\n', "\r\n")
}

/// list-interior-blank-loose-bail (FIXED): indented code with a legal interior
/// blank every 20 lines used to permanently disarm the IndentedCodeCache
/// (bail + re-arm walk died on the same blank), so the never-committing
/// region re-scanned every append (counter ~248x). Blanks now fold as body
/// lines, at arm time too.
fn indented_code_blanks(target: usize) -> String {
    let mut s = String::with_capacity(target + 64);
    let mut i = 0usize;
    while s.len() < target {
        s.push_str("    let value = compute(alpha, beta); // indented code line\n");
        i += 1;
        if i % 20 == 0 {
            s.push('\n');
        }
    }
    s
}

// ---- the per-shape table ----------------------------------------------------

/// Default span for shapes cheap enough to run big: 16x. Linear work grows
/// ~16x across it; quadratic ~256x. Chunk 128 keeps appends frequent enough to
/// expose any O(n²/chunk) curve while finishing fast in CI.
const SMALL: usize = 16 * 1024;
const LARGE: usize = 256 * 1024;
const CHUNK: usize = 128;

/// Span for the known-quadratic shapes: 8x (8 KB → 64 KB unless noted), the
/// small-span pattern that keeps documented-O(n²) shapes affordable in CI.
const Q_SMALL: usize = 8 * 1024;
const Q_LARGE: usize = 64 * 1024;

/// Per-metric gate limits, span-relative:
/// - Linear: ratio ≤ span × 4 — 4x headroom absorbs cache re-arm constants and
///   small-N noise while staying 4x below the quadratic floor (span²). The
///   shipped cliffs were 100x–2900x, far past it. (span 16 → limit 64,
///   identical to the historical gate.)
/// - KnownQuadratic: ratio < span² × 2.5 — trips only on worse-than-quadratic
///   (e.g. an accidental cubic); the quadratic itself is the documented limit,
///   not a failure. (span 8 → limit 160, identical to the historical guard.)
fn linear_limit(span: f64) -> f64 {
    span * 4.0
}
fn quad_limit(span: f64) -> f64 {
    span * span * 2.5
}

fn shapes() -> Vec<Shape> {
    let base = Opts::default();
    let lin = |name: &'static str, gen: fn(usize) -> String, rendered: Expect| Shape {
        name,
        gen,
        opts: base,
        chunk: CHUNK,
        small: SMALL,
        large: LARGE,
        scanned: Expect::Linear,
        rendered,
    };
    // A known-quadratic fix-campaign entry, named by hunt group key. `scanned`/
    // `rendered` reflect which metric actually sees the cliff (measured, not
    // assumed): a metric that stays linear on a wall-only cliff is declared
    // Linear so the gate at least pins the visible half.
    let quad = |name: &'static str,
                gen: fn(usize) -> String,
                opts: Opts,
                scanned: Expect,
                rendered: Expect| Shape {
        name,
        gen,
        opts,
        chunk: CHUNK,
        small: Q_SMALL,
        large: Q_LARGE,
        scanned,
        rendered,
    };
    use Expect::{KnownQuadratic, Linear};
    let footnotes = Opts { footnotes: true, ..base };
    let block_data = Opts { block_data: true, ..base };
    let chart_tag = Opts { component_tags: &["Chart"], ..base };
    // A `block_data = true` twin of a cached linear shape (same span/chunk).
    let bd = |name: &'static str, gen: fn(usize) -> String| Shape {
        name,
        gen,
        opts: block_data,
        chunk: CHUNK,
        small: SMALL,
        large: LARGE,
        scanned: Expect::Linear,
        rendered: Expect::Linear,
    };
    let mut v = vec![
        // -- shapes that MUST stay linear (commit regularly or have a cache) --
        lin("mixed", mixed, Linear),
        lin("many_paragraphs", many_paragraphs, Linear),
        lin("big_list", big_list, Linear), // flat list -> ListCache (incremental)
        lin("big_blockquote", big_blockquote, Linear), // prose quote -> ContainerCache
        lin("quote_many_paras", quote_many_paras, Linear), // multi-para quote -> ContainerCache
        // Structured-inner containers -> ContainerBlockCache (recursive nested
        // parser, incremental). Was O(n²) (the 0.18.4 flicker fix bailed to a
        // full reparse every append); now streams linearly.
        lin("alert_with_list", big_alert, Linear),
        lin("blockquote_with_list", blockquote_with_list, Linear),
        // Nested loose list -> ListCache (multi-line item bodies, incremental).
        // Was O(n²) (the 0.18.3 flicker fix bailed the list cache to a full
        // reparse on every nested sub-bullet); now streams linearly.
        lin("nested_loose_list", nested_loose_list, Linear),
        lin("big_table", big_table, Linear),
        lin("big_code", big_code, Linear),
        lin("big_math", big_math, Linear),
        // Open HTML block (types 6/7) with newline-aligned appends ->
        // HtmlBlockCache (incremental). Was O(n²) (hunt group
        // html-empty-partial-blank-close): a zero-byte trailing partial
        // vacuously passed the blank-line close test, so the cache dropped and
        // never re-armed whenever an append ended exactly at `\n`.
        lin("html_type6_aligned", html_type6_aligned, Linear),
        lin("html_type7_aligned", html_type7_aligned, Linear),
        // CRLF twins (hunt group crlf-cache-bail, FIXED via ingest
        // normalization) — must cost the same as their LF originals.
        lin("crlf_big_list", crlf_big_list, Linear),
        lin("crlf_mixed", crlf_mixed, Linear),
        lin("crlf_big_code", crlf_big_code, Linear),
        lin("crlf_big_table", crlf_big_table, Linear),
        lin("crlf_nested_loose_list", crlf_nested_loose_list, Linear),
        lin("crlf_blockquote_with_list", crlf_blockquote_with_list, Linear),
        lin("crlf_alert_with_list", crlf_alert_with_list, Linear),
        // Inline-engine wave (FIXED): emphasis-edit forward rebuild,
        // openers_bottom, compute_cut sweep, synthetic inert-run boundaries.
        lin("strikethrough_para", strikethrough_one_para, Linear),
        lin("em_pairs_para", em_pairs_one_para, Linear),
        lin("entity_soup", entity_soup, Linear),
        lin("punctuated_giant_word", punctuated_giant_word, Linear),
        // Giant word with autolinks OFF is linear post-fix; with autolinks ON
        // the pin is semantic — see the known-quadratic entry below.
        Shape {
            name: "giant_word_no_autolinks",
            gen: one_giant_word,
            opts: Opts { no_autolinks: true, ..base },
            chunk: CHUNK,
            small: SMALL,
            large: LARGE,
            scanned: Linear,
            rendered: Linear,
        },
        // Table partial-row shapes (hunt group table-partial-row-rerender,
        // FIXED via the PartialRowCache) — the partial-row path self-counts
        // into `scanned`, so both metrics now pin this class.
        lin("growing_last_cell", growing_last_cell, Linear),
        lin("wide_one_row", wide_one_row, Linear),
        // Open list ITEM with an ever-growing body -> ListCache + OpenItemStream
        // (nested parser, incremental; hunt group open-list-item-body-rerender,
        // FIXED). The speculative fold is now counted (perf::add_scan).
        lin("list_item_plain_body", list_item_plain_body, Linear),
        lin("list_growing_table", list_growing_table, Linear),
        lin("list_open_fence", list_open_fence, Linear),
        lin("quoted_list_table", quoted_list_table, Linear),
        // Legal interior blank lines no longer disarm the caches (hunt group
        // list-interior-blank-loose-bail, FIXED): a list item's interior blank
        // stays in-item (§5.3 looseness via item_directly_loose through the
        // one-time rebuild_loose), and indented-code blanks fold as body lines.
        lin("loose_subs_one_item", loose_subs_one_item, Linear),
        lin("staircase_blank_flap", staircase_blank_flap, Linear),
        lin("indented_code_with_interior_blanks", indented_code_blanks, Linear),
        // Container defs + laziness (hunt groups global-defs-inside-container,
        // FIXED, and the lazy half of container-stack-churn-lazy, FIXED): the
        // nested parser consumes quote-hosted def runs natively, and lazy
        // marker-less continuation lines glue exactly like blockquote_inner.
        lin("quote_ref_defs", quote_ref_defs, Linear),
        lin("quote_footnote_defs", quote_footnote_defs, Linear),
        lin("bq_lazy_continuation", bq_lazy_continuation, Linear),
        // `block_data` twins of the cached shapes (hunt groups
        // blockdata-disables-container-cache + blockdata-per-append-rebuild,
        // FIXED): the structured `kind.data` channel must never disarm an
        // incremental cache or change its scan profile. The container-block
        // cache used to bail outright under `block_data` (247x counter on an
        // alert/quote with a structured body — it now owns the nested
        // `ContainerData` channel); the armed caches used to rebuild their full
        // data payload per append (fence/indented whole-body entity decode,
        // deep-cloned list items / container paras / table headers) — counter-
        // linear but a 3–87x wall multiplier, fixed by raw-slice derivation +
        // `Rc`-shared committed entries. The wall half can't gate
        // deterministically; these twins pin the arm/disarm + scan profile.
        bd("blockdata_alert", big_alert),
        bd("blockdata_blockquote", blockquote_with_list),
        bd("blockdata_quote_paras", quote_many_paras),
        bd("blockdata_big_list", big_list),
        bd("blockdata_nested_list", nested_loose_list),
        bd("blockdata_big_table", big_table),
        bd("blockdata_big_code", big_code),
        bd("blockdata_big_math", big_math),
        // Footnote shapes (hunt group footnote-global-state, FIXED): def-run
        // tails commit up to the last def opener, the per-cache footnote
        // numbering extends over only NEW bytes (`RegionFnNums`, self-counted
        // into `scanned`), the committed footnote tables are Rc-shared (no
        // per-append map clones), and the list cache streams footnote REFS
        // (only genuine def lines bail).
        Shape {
            name: "fn_a1_def_run_noblank",
            gen: a1_def_run_noblank,
            opts: footnotes,
            chunk: CHUNK,
            small: SMALL,
            large: LARGE,
            scanned: Linear,
            rendered: Linear,
        },
        Shape {
            name: "fn_a2_def_run_blank",
            gen: a2_def_run_blank,
            opts: footnotes,
            chunk: CHUNK,
            small: SMALL,
            large: LARGE,
            scanned: Linear,
            rendered: Linear,
        },
        Shape {
            name: "fn_c_many_refs_one_para",
            gen: c_many_refs_one_para,
            opts: footnotes,
            chunk: CHUNK,
            small: SMALL,
            large: LARGE,
            scanned: Linear,
            rendered: Linear,
        },
        Shape {
            name: "fn_g_big_list_refs",
            gen: g_big_list_refs,
            opts: footnotes,
            chunk: CHUNK,
            small: SMALL,
            large: LARGE,
            scanned: Linear,
            rendered: Linear,
        },
        // -- the 17 verified O(n²) hunt groups (fix campaign; flip to Linear
        //    as each lands) ---------------------------------------------------
        quad("open-block-html-reemit", unclosed_fence, base, Linear, Linear), // wall-only (memcpy); emitted shows it
        // commit-cut-pinned-no-boundary, residual semantic pin: with extended
        // autolinks ON a future `@` legitimately reaches back through the alnum
        // run, so the cut cannot advance. Inert-run flavors (entity_soup,
        // punctuated_giant_word, autolinks-off) are FIXED and linear above.
        quad("giant-word-autolinks-pin", one_giant_word, base, KnownQuadratic, KnownQuadratic),
        // uncached-open-block-kinds: FIXED — the five member shapes are pinned
        // linear here; the two first-line-incomplete container flavors remain
        // known-quadratic below.
        Shape {
            name: "component_block_open",
            gen: component_block_open,
            opts: chart_tag,
            chunk: CHUNK,
            small: SMALL,
            large: LARGE,
            scanned: Linear,
            rendered: Linear,
        },
        lin("heading_words", heading_words, Linear),
        lin("heading_emphasis", heading_emphasis, Linear),
        lin("growing_rule", growing_rule, Linear),
        lin("fence_giant_info", fence_giant_info, Linear),
        // html-empty-partial-blank-close: FIXED — promoted to the linear
        // html_type6/7_aligned shapes above.
        // footnote-global-state: FIXED — promoted to the four fn_* linear
        // shapes below (def-run commit cut + incremental per-cache footnote
        // numbering + list-cache `[^` bail narrowed to genuine def lines).
        // rendered measured sub-linear (defs emit no HTML) — gate it Linear.
        // global-defs-inside-container: FIXED — quote_ref_defs,
        // quote_footnote_defs and bq_lazy_continuation promoted to linear
        // shapes below (footnotes-ON quote-hosted defs remain a follow-up).
        // open-list-item-body-rerender: FIXED — quoted_list_table and the
        // list_* shapes promoted to linear below.
        // table-partial-row-rerender: FIXED — growing_last_cell + wide_one_row
        // promoted to linear shapes below.
        // resolve-delimiters-replace-range: FIXED — strikethrough_para promoted
        // to a linear shape above (the render-side win is wall-only).
        // compute-cut-pair-overlap-scan: FIXED — em_pairs_para promoted above.
        // crlf-cache-bail: FIXED — promoted to the seven crlf_* linear twins above.
        // blockdata-per-append-rebuild: FIXED — the armed caches derive the data
        // channel from the raw source / Rc-shared committed entries; promoted to
        // the blockdata_* linear twins above.
        // Residual first-line-incomplete container pins (both container caches
        // need a complete first line before Blockquote-vs-Alert settles).
        quad("container-first-line-pin", quote_giant_line, base, KnownQuadratic, KnownQuadratic),
        quad("container-first-line-pin-cjk", bq_cjk_one_line, base, KnownQuadratic, KnownQuadratic),
        // list-interior-blank-loose-bail: FIXED — indented_code_with_interior_
        // blanks + loose_subs_one_item + staircase_blank_flap promoted above.
    ];
    // Shapes too expensive per byte for the 8 KB → 64 KB span (super-quadratic
    // wall); same 8x span at smaller sizes.
    v.push(Shape {
        name: "delimiter-stack-mod3-rescan",
        gen: mod3_soup,
        opts: base,
        chunk: CHUNK,
        small: 1024,
        large: 8 * 1024,
        scanned: KnownQuadratic,
        rendered: KnownQuadratic,
    });
    v.push(Shape {
        name: "dollar-math-eof-rescan",
        gen: dollar_soup,
        opts: base,
        chunk: CHUNK,
        small: 1024,
        large: 8 * 1024,
        scanned: KnownQuadratic,
        rendered: KnownQuadratic,
    });
    // blockdata-disables-container-cache: FIXED — the ContainerBlockCache owns
    // `block_data` now (nested `ContainerData` per committed inner block);
    // promoted to the blockdata_alert / blockdata_blockquote linear twins above.
    // The DEPTH half of container-stack-churn-lazy remains: per-line O(depth)
    // marker restripping past MAX_CONTAINER_DEPTH is slightly worse than pure
    // n² (~104x across this 8x span); the quad guard leaves headroom over the
    // measured curve. Fix = iterative wrapper-stack (fold settled shallower
    // levels once), a follow-up.
    v.push(Shape {
        name: "container-depth-growth-pin",
        gen: quote_depth_growing,
        opts: base,
        chunk: CHUNK,
        small: 2 * 1024,
        large: 16 * 1024,
        scanned: KnownQuadratic,
        rendered: KnownQuadratic,
    });
    v
}

// ---- the gate ---------------------------------------------------------------

fn check(
    shape: &str,
    metric: &str,
    ratio: f64,
    span: f64,
    expect: Expect,
    failures: &mut Vec<String>,
) {
    match expect {
        Expect::Linear => {
            if ratio > linear_limit(span) {
                failures.push(format!(
                    "{shape}: {metric} work grew {ratio:.1}x across a {span}x size span \
(limit {:.0}x) — superlinear regression",
                    linear_limit(span)
                ));
            }
        }
        Expect::KnownQuadratic => {
            if ratio > quad_limit(span) {
                failures.push(format!(
                    "{shape}: {metric} work grew {ratio:.1}x across a {span}x size span — \
WORSE than the documented quadratic limit ({:.0}x)",
                    quad_limit(span)
                ));
            }
        }
        Expect::Untracked => {}
    }
}

fn tag(e: Expect) -> &'static str {
    match e {
        Expect::Linear => "lin",
        Expect::KnownQuadratic => "n²",
        Expect::Untracked => "-",
    }
}

#[test]
fn streaming_complexity_gate() {
    let mut failures = Vec::new();
    println!(
        "{:36} {:>5}  {:>12} {:>12} {:>12}  {:>9} {:>9}",
        "shape (span)", "", "scanned", "rendered", "emitted", "wall-S ms", "wall-L ms"
    );
    for s in shapes() {
        let span = (s.large / s.small) as f64;
        let w_small = measure(&(s.gen)(s.small), s.chunk, s.opts);
        let w_large = measure(&(s.gen)(s.large), s.chunk, s.opts);
        let r_scan = w_large.scanned as f64 / w_small.scanned as f64;
        let r_rend = w_large.rendered as f64 / w_small.rendered as f64;
        let r_emit = w_large.emitted as f64 / w_small.emitted as f64;
        println!(
            "{:36} (x{:>2})  {:>7.1} [{}] {:>7.1} [{}] {:>9.1} [i]  {:>9.1} {:>9.1}",
            s.name,
            span,
            r_scan,
            tag(s.scanned),
            r_rend,
            tag(s.rendered),
            r_emit,
            w_small.wall_ms,
            w_large.wall_ms,
        );
        check(s.name, "scanned", r_scan, span, s.scanned, &mut failures);
        check(s.name, "rendered", r_rend, span, s.rendered, &mut failures);
        // `emitted` is informational only — full-active-block re-emission per
        // append is the current wire contract (see perf module docs).
    }
    assert!(failures.is_empty(), "complexity regression(s):\n  {}", failures.join("\n  "));
}

/// Pins the exact 0.18.2 regression: a paragraph immediately followed by a long
/// run of link-reference definitions used to stall `committed_offset`, so the
/// whole growing def run re-scanned every append (235 KB @ chunk 256 = 59 s).
/// The fix made it linear; this guards it deterministically.
#[test]
fn ref_def_run_is_linear() {
    let small = measure(&ref_heavy(250), CHUNK, Opts::default());
    let large = measure(&ref_heavy(4000), CHUNK, Opts::default()); // 16x more defs
    let ratio = large.scanned as f64 / small.scanned as f64;
    println!(
        "ref_heavy  small={} large={} ratio={ratio:.1} (x16 defs)",
        small.scanned, large.scanned
    );
    assert!(
        ratio < linear_limit(16.0),
        "ref-def run regressed to superlinear: {ratio:.1}x work for 16x defs (limit {:.0}x)",
        linear_limit(16.0)
    );
}
