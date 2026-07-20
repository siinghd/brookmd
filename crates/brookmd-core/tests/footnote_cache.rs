//! Footnote-aware streaming-cache parity.
//!
//! The Paragraph / Table / Container (blockquote, alert) / List tail caches stay
//! ARMED when GFM footnotes are enabled: each `[^x]` ref renders as an
//! occurrence-INDEPENDENT placeholder token whose `id="fnref-…"` suffix is
//! resolved into the frozen prefix in document order from the committed
//! occurrence baseline. These tests assert the streamed output (committed
//! blocks plus the finalize footnote section) is BYTE-IDENTICAL to the one-shot
//! render, across many chunk splits and several footnote shapes, including the
//! constructs that historically broke the occurrence count: repeated labels,
//! code spans, escaped refs, def-body refs, and tight-to-loose list rebuilds.

use brook_md_core::StreamParser;

fn collect(p: &StreamParser) -> String {
    let mut out = String::new();
    for b in p.all_blocks() {
        out.push_str(&b.html);
    }
    out
}

fn one_shot(md: &str, block_data: bool) -> String {
    let mut p = StreamParser::new()
        .with_gfm_footnotes(true)
        .with_gfm_alerts(true)
        .with_block_data(block_data);
    p.append(md);
    p.finalize();
    collect(&p)
}

/// Feed `md` in chunks of `chunk` bytes (respecting UTF-8 char boundaries) and
/// return the final concatenated streamed HTML.
fn streamed_by(md: &str, chunk: usize, block_data: bool) -> String {
    let mut p = StreamParser::new()
        .with_gfm_footnotes(true)
        .with_gfm_alerts(true)
        .with_block_data(block_data);
    let bytes = md.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let mut end = (i + chunk.max(1)).min(bytes.len());
        // Don't split inside a UTF-8 char.
        while end < bytes.len() && (bytes[end] & 0xC0) == 0x80 {
            end += 1;
        }
        p.append(std::str::from_utf8(&bytes[i..end]).unwrap());
        i = end;
    }
    p.finalize();
    collect(&p)
}

/// Deterministic pseudo-random split (xorshift, fixed seed — no Math.random).
fn streamed_pseudo(md: &str, mut seed: u64, block_data: bool) -> String {
    let mut p = StreamParser::new()
        .with_gfm_footnotes(true)
        .with_gfm_alerts(true)
        .with_block_data(block_data);
    let bytes = md.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        let step = (seed as usize % 9) + 1; // 1..=9
        let mut end = (i + step).min(bytes.len());
        while end < bytes.len() && (bytes[end] & 0xC0) == 0x80 {
            end += 1;
        }
        p.append(std::str::from_utf8(&bytes[i..end]).unwrap());
        i = end;
    }
    p.finalize();
    collect(&p)
}

/// The full parity sweep: byte-by-byte, 1/7/13-byte, and two fixed-seed pseudo
/// splits, all == one-shot. Run with and without the structured data channel.
fn assert_parity(name: &str, md: &str) {
    for &bd in &[false, true] {
        let expect = one_shot(md, bd);
        for &c in &[1usize, 7, 13, 64] {
            let got = streamed_by(md, c, bd);
            assert_eq!(got, expect, "[{name}] block_data={bd} chunk={c}\n--- streamed ---\n{got}\n--- one-shot ---\n{expect}");
        }
        for &s in &[0x9E3779B97F4A7C15u64, 0xD1B54A32D192ED03u64] {
            let got = streamed_pseudo(md, s, bd);
            assert_eq!(got, expect, "[{name}] block_data={bd} seed={s:#x}\n--- streamed ---\n{got}\n--- one-shot ---\n{expect}");
        }
    }
}

// --------------------------------------------------------------------------
// 1. MASTER parity: table / blockquote / alert / list / paragraph, each with
//    repeated-same-label AND distinct-label footnote refs, at many splits.
// --------------------------------------------------------------------------

#[test]
fn master_table_repeated_label() {
    let md = "| a | b |\n| --- | --- |\n| see [^x] | ok [^x] |\n| more [^x] | [^x] |\n\n[^x]: note.\n";
    assert_parity("table-repeated", md);
}

#[test]
fn master_table_distinct_labels() {
    let md = "| a | b |\n| --- | --- |\n| [^a] | [^b] |\n| [^c] | [^d] |\n\n[^a]: A\n\n[^b]: B\n\n[^c]: C\n\n[^d]: D\n";
    assert_parity("table-distinct", md);
}

#[test]
fn master_blockquote_repeated_label() {
    let md = "> first [^x] line\n> second [^x] line\n>\n> new para [^x]\n\n[^x]: note.\n";
    assert_parity("blockquote-repeated", md);
}

#[test]
fn master_blockquote_distinct_labels() {
    let md = "> alpha [^a] and beta [^b]\n> gamma [^c]\n>\n> delta [^d] tail\n\n[^a]: A\n\n[^b]: B\n\n[^c]: C\n\n[^d]: D\n";
    assert_parity("blockquote-distinct", md);
}

#[test]
fn master_alert_repeated_label() {
    let md = "> [!NOTE]\n> heads up [^x]\n> and again [^x]\n>\n> second para [^x]\n\n[^x]: note.\n";
    assert_parity("alert-repeated", md);
}

#[test]
fn master_alert_distinct_labels() {
    let md = "> [!WARNING]\n> careful [^a]\n> very [^b]\n>\n> also [^c]\n\n[^a]: A\n\n[^b]: B\n\n[^c]: C\n";
    assert_parity("alert-distinct", md);
}

#[test]
fn master_list_repeated_label() {
    let md = "- item [^x]\n- item [^x]\n- item [^x]\n\n[^x]: note.\n";
    assert_parity("list-repeated", md);
}

#[test]
fn master_list_distinct_labels() {
    let md = "1. one [^a]\n2. two [^b]\n3. three [^c]\n\n[^a]: A\n\n[^b]: B\n\n[^c]: C\n";
    assert_parity("list-distinct", md);
}

#[test]
fn master_paragraph_repeated_and_distinct() {
    let md = "A long paragraph with [^x] and then [^y] and again [^x] and [^x] streaming on and on with more words after it.\n\n[^x]: X\n\n[^y]: Y\n";
    assert_parity("paragraph-mixed", md);
}

// --------------------------------------------------------------------------
// 2. Repeated-label ordering: ids fnref-1, fnref-1-2, …; section emits exactly
//    N backrefs (count-equality).
// --------------------------------------------------------------------------

#[test]
fn repeated_label_ordering_and_backref_count() {
    let md = "| h |\n| --- |\n| [^x] |\n| [^x] |\n| [^x] |\n| [^x] |\n\n[^x]: note.\n";
    let out = one_shot(md, false);
    // Sequential ids.
    assert!(out.contains("id=\"fnref-1\">"), "1st id: {out}");
    assert!(out.contains("id=\"fnref-1-2\">"), "2nd id: {out}");
    assert!(out.contains("id=\"fnref-1-3\">"), "3rd id: {out}");
    assert!(out.contains("id=\"fnref-1-4\">"), "4th id: {out}");
    // Exactly N=4 backref anchors in the section.
    let backrefs = out.matches("class=\"footnote-backref\"").count();
    assert_eq!(backrefs, 4, "one backref per resolved ref: {out}");
    // The streamed path agrees.
    assert_eq!(streamed_by(md, 1, false), out);
}

// --------------------------------------------------------------------------
// 3. CODE-SPAN risk test: a streamed cell/item with a REAL `[^x]`, a literal
//    code span `` `[^x]` `` (emits NO ref → must not bump occurrence), and a
//    later REAL `[^x]`. Pins the seed/token desync.
// --------------------------------------------------------------------------

#[test]
fn code_span_does_not_shift_occurrence_table() {
    // Cell 1 has a real ref then a code-span `[^x]`; cell/row 2 has a real ref.
    let md = "| h |\n| --- |\n| real [^x] and code `[^x]` |\n| later [^x] |\n\n[^x]: note.\n";
    let out = one_shot(md, false);
    // Two REAL refs → ids fnref-1 and fnref-1-2 (the code-span `[^x]` is literal).
    assert!(out.contains("id=\"fnref-1\">"), "1st real id: {out}");
    assert!(out.contains("id=\"fnref-1-2\">"), "2nd real id: {out}");
    assert!(!out.contains("id=\"fnref-1-3\">"), "code span must NOT count: {out}");
    // The literal code span survives.
    assert!(out.contains("<code>[^x]</code>"), "code span literal: {out}");
    // Backref count == resolved-ref count (2), not 3.
    assert_eq!(out.matches("class=\"footnote-backref\"").count(), 2, "backref==refs: {out}");
    assert_parity("code-span-table", md);
}

#[test]
fn escaped_ref_does_not_shift_occurrence_list() {
    // Escaped `\[^x]` renders literally (no ref token emitted), so it must not
    // bump the occurrence of the REAL `[^x]` refs that flank it: the two real
    // refs stay fnref-1 / fnref-1-2 and the literal `[^x]` survives in the text.
    let md = "- real [^x]\n- escaped \\[^x] here\n- real again [^x]\n\n[^x]: note.\n";
    let out = one_shot(md, false);
    assert!(out.contains("id=\"fnref-1\">"), "1st real id: {out}");
    assert!(out.contains("id=\"fnref-1-2\">"), "2nd real id: {out}");
    assert!(!out.contains("id=\"fnref-1-3\">"), "escaped must NOT count as a real ref: {out}");
    assert!(out.contains(">escaped [^x] here<") || out.contains("[^x]"), "literal survives: {out}");
    // Exactly the two real refs produce backrefs to label x.
    assert_eq!(out.matches("href=\"#fnref-1\"").count() + out.matches("href=\"#fnref-1-2\"").count(), 2, "two backrefs to x: {out}");
    assert_parity("escaped-list", md);
}

// --------------------------------------------------------------------------
// 4. Cache-bail mid-block (CRLF / interrupting line forces full reparse): the
//    already-streamed rows must reproduce identical ids.
// --------------------------------------------------------------------------

#[test]
fn crlf_table_bail_reproduces_ids() {
    // A CRLF row forces the cache to bail to the full path mid-table.
    let md = "| h |\n| --- |\n| [^x] |\r\n| [^x] |\n\n[^x]: note.\n";
    assert_parity("crlf-table-bail", md);
}

#[test]
fn interrupting_line_forces_reparse_blockquote() {
    // A non-`>` lazy line ends the blockquote cache; the full path takes over.
    let md = "> a [^x]\n> b [^x]\nlazy [^x] tail\n\n[^x]: note.\n";
    assert_parity("blockquote-bail", md);
}

// --------------------------------------------------------------------------
// 5. tight→loose list rebuild with footnotes in earlier items: ids stable.
// --------------------------------------------------------------------------

#[test]
fn tight_to_loose_rebuild_stable_ids() {
    // Items 1+2 stream tight; the blank line before item 3 flips the list loose
    // and rebuilds items 1+2 in `<p>` form — their footnote ids must not shift.
    let md = "- one [^x]\n- two [^x]\n\n- three [^x]\n\n[^x]: note.\n";
    let out = one_shot(md, false);
    assert!(out.contains("id=\"fnref-1\">"), "1st: {out}");
    assert!(out.contains("id=\"fnref-1-2\">"), "2nd: {out}");
    assert!(out.contains("id=\"fnref-1-3\">"), "3rd: {out}");
    assert_eq!(out.matches("class=\"footnote-backref\"").count(), 3, "3 backrefs: {out}");
    assert_parity("tight-loose", md);
}

// --------------------------------------------------------------------------
// 6. Footnote DEF body containing a nested ref + the same label inside a cached
//    block: def-body id + section backref count match inline ids.
// --------------------------------------------------------------------------

#[test]
fn def_body_nested_ref_in_cached_block() {
    // `[^x]` appears inside a streamed table AND inside the def body of `[^y]`.
    let md = "| h |\n| --- |\n| see [^x] |\n| again [^x] |\n\n[^x]: note one.\n\n[^y]: refers to [^x] inside.\n\nTail [^y].\n";
    assert_parity("def-body-nested", md);
}

#[test]
fn def_body_same_label_in_cached_block() {
    // A footnote def whose body references the SAME label used in the table.
    let md = "| h |\n| --- |\n| [^x] |\n| [^x] |\n\n[^x]: a note about [^x] itself.\n";
    assert_parity("def-body-same-label", md);
}

// --------------------------------------------------------------------------
// Footnotes OFF: placeholder flag is false → zero behavior change.
// --------------------------------------------------------------------------

#[test]
fn footnotes_off_is_literal_and_unchanged() {
    let md = "| h |\n| --- |\n| [^x] |\n| [^x] |\n";
    let mut p = StreamParser::new(); // OFF
    p.append(md);
    p.finalize();
    let out = collect(&p);
    assert!(out.contains("[^x]"), "ref stays literal when off: {out}");
    assert!(!out.contains("footnote-ref"), "no footnote markup: {out}");
    assert!(!out.contains('\u{0}') && !out.contains('\u{1}'), "no stray tokens: {out:?}");
}

// --------------------------------------------------------------------------
// PERF / NO-WHOLE-PREFIX-RESCAN.
//
// Two complementary checks. The footnote resolver the cache adds runs once over
// each newly-folded element + once over the short speculative tail per append —
// O(new bytes), never a whole-prefix rescan. (The cache already re-EMITS the
// whole open block's HTML on every patch — an inherent part of the streaming
// contract, identical with footnotes off — so absolute wall-time is dominated by
// that pre-existing O(emitted bytes) cost and is not what we test here.)
//
// 1. A FAST, deterministic structural check: streaming a footnote-bearing block
//    row-by-row keeps it ARMED in the cache (each append leaves the block
//    speculative — `newly_committed` empty — instead of committing/re-reparsing
//    it), proving the per-append fast path is taken. Robust + instant.
// 2. An `#[ignore]`d timing benchmark (run with `--ignored --test-threads=1`)
//    that reports the footnote-resolution overhead per row across sizes for
//    manual linearity confirmation — kept out of the default run because
//    wall-clock timing flakes under the parallel test runner.
// --------------------------------------------------------------------------

fn make_table(rows: usize, with_refs: bool) -> String {
    let mut md = String::from("| h |\n| --- |\n");
    for _ in 0..rows {
        md.push_str(if with_refs { "| cell [^x] more [^y] |\n" } else { "| cell zzzzz more wwwww |\n" });
    }
    if with_refs {
        md.push_str("\n[^x]: X\n\n[^y]: Y\n");
    }
    md
}

fn make_list(items: usize, with_refs: bool) -> String {
    let mut md = String::new();
    for _ in 0..items {
        md.push_str(if with_refs { "- item [^x] tail [^y]\n" } else { "- item zzzzz tail wwwww\n" });
    }
    if with_refs {
        md.push_str("\n[^x]: X\n\n[^y]: Y\n");
    }
    md
}

#[test]
fn cache_stays_armed_under_footnotes_table() {
    // Stream a big footnote table one row per append. The open table must stay in
    // the fast cache path: each row-append returns an empty `newly_committed`
    // (the table is still the open/speculative tail). If the cache had to disarm
    // and full-reparse, that would be O(n²) — this asserts the fast path engages
    // for every interior row, the structural condition that keeps it ~linear.
    let rows = 400;
    let mut md = String::from("| h |\n| --- |\n");
    let mut p = StreamParser::new().with_gfm_footnotes(true);
    p.append(&md); // header + delimiter
    let mut interior_committs = 0;
    for i in 0..rows {
        let line = "| cell [^x] more [^x] |\n";
        md.push_str(line);
        let patch = p.append(line);
        // While the table is open, no block should commit (it stays speculative).
        if !patch.newly_committed.is_empty() {
            interior_committs += 1;
        }
        // The active tail is always exactly the one open table block.
        assert_eq!(patch.active.len(), 1, "row {i}: open table is the sole tail block");
    }
    assert_eq!(interior_committs, 0, "no interior row may commit while the table streams (would imply repeated full reparse)");
    // Final parity sanity at finalize.
    p.finalize();
    let streamed = collect(&p);
    assert_eq!(streamed, one_shot(&md, false), "streamed footnote table == one-shot");
}

#[test]
fn cache_stays_armed_under_footnotes_list() {
    let items = 400;
    let mut md = String::new();
    let mut p = StreamParser::new().with_gfm_footnotes(true);
    let mut interior_committs = 0;
    for i in 0..items {
        let line = "- item [^x] tail [^x]\n";
        md.push_str(line);
        let patch = p.append(line);
        if !patch.newly_committed.is_empty() {
            interior_committs += 1;
        }
        assert_eq!(patch.active.len(), 1, "item {i}: open list is the sole tail block");
    }
    assert_eq!(interior_committs, 0, "no interior item may commit while the list streams");
    p.finalize();
    assert_eq!(collect(&p), one_shot(&md, false), "streamed footnote list == one-shot");
}

/// Manual whole-stream timing — run with:
///   cargo test --release --test footnote_cache perf_bench -- --ignored --nocapture --test-threads=1
/// Reports the per-row wall time of streaming a footnote table/list across a 4×
/// size step. The cache makes the FOLD work O(new bytes); the inherent
/// re-emission of the whole open block per patch is O(current size) and is the
/// same with footnotes off, so this number reflects that pre-existing emission
/// cost, not a resolution rescan (the `cache_stays_armed_*` tests pin the
/// structural no-rescan property deterministically). Ignored by default so the
/// timing never flakes the parallel suite.
#[test]
#[ignore]
fn perf_bench_footnote_stream_timing() {
    fn time(md: &str) -> f64 {
        let start = std::time::Instant::now();
        let mut p = StreamParser::new().with_gfm_footnotes(true);
        for line in md.split_inclusive('\n') {
            p.append(line);
        }
        p.finalize();
        let _ = collect(&p);
        start.elapsed().as_secs_f64()
    }
    for (label, table) in [("table", true), ("list", false)] {
        let mk = |n: usize| if table { make_table(n, true) } else { make_list(n, true) };
        let _ = time(&mk(1_000)); // warm
        let small = time(&mk(2_500));
        let large = time(&mk(10_000));
        eprintln!(
            "{label}: stream {:.3} us/row @2.5k → {:.3} us/row @10k",
            small * 1e6 / 2_500.0,
            large * 1e6 / 10_000.0
        );
    }
}
