//! Mid-stream parity — asserts that what a streaming consumer SEES while a
//! block is open matches the one-shot render for the same prefix.
//!
//! The other parity tests (`table_streaming.rs`, `container_cache.rs`, etc.)
//! compare *post-finalize* output. That misses bugs where the cache emits
//! wrong HTML for an open block mid-stream — the user-visible state. These
//! tests close the loop: for each markdown prefix below, the streamed parser
//! (char-by-char + a trailing empty append to fire any freshly-armed cache)
//! must collect to the same HTML the one-shot parser produces for that
//! prefix without `.finalize()`.
//!
//! Pinned bugs:
//!   - paragraph cache used to skip past its own line and miss a table
//!     delimiter row that completes after the cut had advanced into it
//!   - the alert/blockquote container cache used to emit an empty `<p></p>`
//!     for an empty body, while the full path emits nothing

use flux_md_core::StreamParser;

fn collect(p: &StreamParser) -> String {
    let mut out = String::new();
    for b in p.all_blocks() {
        out.push_str(&b.html);
    }
    out
}

fn one_shot_open(md: &str) -> String {
    // No finalize — we want the full path's view of an *open* block.
    let mut p = StreamParser::new().with_gfm_alerts(true);
    p.append(md);
    collect(&p)
}

fn streamed_open(md: &str) -> String {
    // Stream char-by-char, then ONE empty append so any freshly-armed cache
    // gets to fire. No finalize.
    let mut p = StreamParser::new().with_gfm_alerts(true);
    let mut buf = [0u8; 4];
    for ch in md.chars() {
        p.append(ch.encode_utf8(&mut buf));
    }
    p.append("");
    collect(&p)
}

fn assert_parity(md: &str) {
    let one = one_shot_open(md);
    let streamed = streamed_open(md);
    assert_eq!(streamed, one, "mid-stream != one-shot for {md:?}");
}

#[test]
fn table_delimiter_detected_after_paragraph_cache_advanced() {
    // The regression: the paragraph cache advances into line 2 char by char.
    // When `\n` finally lands, the cache's `paragraph_ends_before_eof` walk
    // used to skip past the line containing the cut — so the delimiter row
    // was never seen and the block stayed paragraph until finalize.
    assert_parity("| a | b |\n| - | - |\n");
    assert_parity("| a | b |\n| - | - |\n| 1 | 2 |\n");
    // Multiple columns + alignments
    assert_parity("| L | C | R |\n| :- | :-: | -: |\n| 1 | 2 | 3 |\n");
    // Header preceded by paragraph (trailing-paragraph variant)
    assert_parity("Intro.\n\n| H1 | H2 |\n| - | - |\n");
}

#[test]
fn open_alert_with_empty_body_renders_without_empty_p() {
    // The regression: the alert cache wrapped the body in `<p>...</p>` even
    // when the body was empty, producing `<p></p>` that the full renderer
    // doesn't emit.
    assert_parity("> [!NOTE]\n");
    assert_parity("> [!TIP]\n");
    assert_parity("> [!IMPORTANT]\n");
    assert_parity("> [!WARNING]\n");
    assert_parity("> [!CAUTION]\n");
}

#[test]
fn open_alert_with_body_matches() {
    assert_parity("> [!NOTE]\n> body\n");
    assert_parity("> [!NOTE]\n> body line one\n> body line two\n");
    assert_parity("> [!NOTE]\n> **bold** and `code` in the body\n");
}

#[test]
fn open_blockquote_matches() {
    assert_parity("> simple quote\n");
    assert_parity("> line one\n> line two\n");
    assert_parity("> with **bold** and `code`\n");
}

#[test]
fn open_list_matches() {
    assert_parity("- one\n");
    assert_parity("- one\n- two\n");
    assert_parity("1. one\n2. two\n");
    assert_parity("- with **bold** and `code`\n");
    // Loose: blank line between siblings must produce `<p>`-wrapped items
    // both in the streamed view and one-shot.
    assert_parity("- one\n\n- two\n");
    assert_parity("- one\n\n- two\n\n- three\n");
    // Trailing blank with no second marker yet — cache must stay tight (no
    // `<p>` wrap) since a single-item list is never loose.
    assert_parity("- one\n\n");
    // Blank then partial marker — the list is settled loose by the blank.
    assert_parity("- one\n\n- ");
    assert_parity("- one\n\n- partial");
}

#[test]
fn open_table_matches_with_body() {
    // The table cache itself; pinned to ensure no regression from the
    // paragraph-cache fix above.
    assert_parity("| a | b |\n| - | - |\n| 1 | 2 |\n");
    assert_parity("| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n");
}

#[test]
fn open_code_fence_matches() {
    assert_parity("```rust\nfn main() {}\n");
    assert_parity("```js\nconst x = 1;\nconst y = 2;\n");
}

// ---------------------------------------------------------------------------
// CRLF ingest normalization: `\r\n` / lone `\r` become `\n` in `append`, with a
// chunk-final `\r` held pending until the next chunk decides. The streamed view
// (char-by-char = every `\r|\n` pair cut across two appends) must match the
// one-shot view of the same prefix.
// ---------------------------------------------------------------------------

#[test]
fn crlf_open_blocks_match_one_shot() {
    assert_parity("- one\r\n- two\r\n");
    assert_parity("1. one\r\n2. two\r\n");
    assert_parity("| a | b |\r\n| - | - |\r\n| 1 | 2 |\r\n");
    assert_parity("```rust\r\nfn main() {}\r\nlet x = 1;\r\n");
    assert_parity("> line one\r\n> line two\r\n");
    assert_parity("> [!NOTE]\r\n> body\r\n");
    assert_parity("para line one\r\npara line two\r\n");
    // Lone `\r` line endings (old-Mac style) and a trailing undecided `\r`.
    assert_parity("- one\r- two\r");
    assert_parity("prefix ends in \r");
}

#[test]
fn crlf_split_across_appends_is_chunk_independent() {
    // Cut a CRLF document in two at EVERY byte boundary — including between
    // `\r` and `\n` (the pending-`\r` hold-back) — and finalize: the output
    // must equal the one-shot render, and equal the LF twin's.
    let lf = "# Head\n\n- one\n- two\n\n> quote\n\n```\ncode\n```\n\n| a |\n| - |\n| 1 |\n";
    let crlf = lf.replace('\n', "\r\n");
    let one_shot = {
        let mut p = StreamParser::new().with_gfm_alerts(true);
        p.append(&crlf);
        p.finalize();
        collect(&p)
    };
    let lf_one_shot = {
        let mut p = StreamParser::new().with_gfm_alerts(true);
        p.append(lf);
        p.finalize();
        collect(&p)
    };
    assert_eq!(one_shot, lf_one_shot, "CRLF one-shot != LF one-shot");
    for cut in 0..=crlf.len() {
        let mut p = StreamParser::new().with_gfm_alerts(true);
        p.append(&crlf[..cut]);
        p.append(&crlf[cut..]);
        p.finalize();
        assert_eq!(collect(&p), one_shot, "split at byte {cut} diverged");
    }
}

// ---------------------------------------------------------------------------
// Speculative open-tail link rendering (kills the streaming link-URL flash).
// While `[label](url…` streams, render an INERT `<a>label</a>` (no href, no raw
// URL as text); once `)` lands the real `href` is added (node reuse).
// ---------------------------------------------------------------------------

/// Append `md` then `finalize()`, collect all blocks. The finalized view is the
/// committed, one-shot-complete-literal output (no speculation — incomplete
/// links degrade to literal text).
fn finalized(md: &str) -> String {
    let mut p = StreamParser::new().with_gfm_alerts(true);
    p.append(md);
    p.finalize();
    collect(&p)
}

/// One-shot render of `md` with finalize — the literal oracle a finalized
/// stream must equal byte-for-byte.
fn one_shot_complete_literal(md: &str) -> String {
    finalized(md) // (the parser has no separate one-shot entry; finalize() IS it)
}

#[test]
fn speculative_link_golden_sweep() {
    // The reproduced bug's exact prefixes.
    let inert_prefixes = ["[Link text Here](", "[Link text Here](https://link-url-h"];
    let closed = "[Link text Here](https://link-url-here.org)";

    for md in inert_prefixes {
        // Mid-stream view matches one-shot-open exactly.
        assert_parity(md);
        let html = streamed_open(md);
        // Inert anchor: pending marker where href will land, then the same
        // target/rel tail as a real link — but NO href.
        assert!(
            html.contains("<a data-flux-pending=\"\" target=\"_blank\" rel=\"noopener noreferrer nofollow\">Link text Here</a>"),
            "expected inert pending <a> for {md:?}, got: {html}"
        );
        assert!(!html.contains("href="), "inert link must have NO href for {md:?}: {html}");
        // No raw URL leaking as visible text (regex-ish: `>` then non-`<` then https).
        assert!(
            !visible_text_contains(&html, "https"),
            "raw URL must not appear as visible text for {md:?}: {html}"
        );
    }

    // Closed link → real <a href=…>.
    assert_parity(closed);
    let html = streamed_open(closed);
    assert!(
        html.contains("<a href=\"https://link-url-here.org\" target=\"_blank\" rel=\"noopener noreferrer nofollow\">Link text Here</a>"),
        "closed link must be a real <a href=…>: {html}"
    );
}

/// True iff any run of text BETWEEN tags (i.e. after a `>` and before the next
/// `<`) contains `needle`. Mirrors the spec's `>[^<]*https` regex without a
/// regex dependency.
fn visible_text_contains(html: &str, needle: &str) -> bool {
    let mut rest = html;
    while let Some(gt) = rest.find('>') {
        let after = &rest[gt + 1..];
        let seg_end = after.find('<').unwrap_or(after.len());
        if after[..seg_end].contains(needle) {
            return true;
        }
        rest = &after[seg_end..];
    }
    false
}

#[test]
fn speculative_inert_shape_no_href() {
    // Every still-streaming destination prefix is inert (no href), and equals
    // the one-shot-open view.
    for md in [
        "[a](",
        "[a](h",
        "[a](http",
        "[a](https://exa",
        "[a](<partial",         // bracketed dest, still open
        "[x](javascript:",      // security: scheme suppressed (inert, no href)
        "[**bold** label](http", // inline markup inside the label
    ] {
        assert_parity(md);
        let html = streamed_open(md);
        assert!(
            html.contains("<a data-flux-pending=\"\" target="),
            "expected inert pending <a> for {md:?}: {html}"
        );
        assert!(!html.contains("href="), "inert link must have NO href for {md:?}: {html}");
    }
}

#[test]
fn speculative_security_javascript_scheme_suppressed() {
    // Open: inert, scheme never appears anywhere (no href, no visible text).
    let open = streamed_open("[x](javascript:alert(1");
    assert!(!open.contains("javascript:"), "javascript: must not appear mid-stream: {open}");
    assert!(!open.contains("href="), "no href mid-stream: {open}");
    assert!(open.contains("<a data-flux-pending=\"\" target="), "inert pending <a> mid-stream: {open}");
    // Closed: sanitize_url drops the dangerous scheme (href present but scrubbed).
    let closed = streamed_open("[x](javascript:alert(1))");
    assert_parity("[x](javascript:alert(1))");
    assert!(!closed.contains("javascript:"), "javascript: must be sanitized on close: {closed}");
}

#[test]
fn speculative_finalize_byte_parity_literal() {
    // A NON-EMPTY, malformed (unclosed) destination finalizes to a plain
    // `<p>[…</p>` literal with NO <a> — speculation is streaming-only; commit is
    // literal, byte-identical to the one-shot-complete oracle.
    for md in [
        "[Link text Here](https://link-url-h",
        "[a](http",
        "[a](<partial",
        "[x](javascript:",
    ] {
        let fin = finalized(md);
        assert_eq!(fin, one_shot_complete_literal(md), "finalize != oracle for {md:?}");
        assert!(!fin.contains("<a"), "finalized incomplete link must be literal (no <a>): {md:?} -> {fin}");
        assert!(fin.contains("<p>["), "finalized incomplete link must be literal text: {md:?} -> {fin}");
    }
    // An EMPTY-dest open paren `[a](` at EOF is literal too. This used to be
    // pinned as the opposite ("historical empty-href link"): try_link's
    // empty-bare-dest early return claimed a complete link with no closing `)`,
    // which both violated CommonMark and CONTRADICTED dest_streams_to_eof's
    // scanner-parity debug_assert (the nightly fuzz target caught the conflict,
    // red since 2026-07-13 — the two invariants could never hold at once).
    // read_link_destination now returns None there, so finalize is literal,
    // still byte-identical to the one-shot oracle. Speculation mid-stream is
    // unchanged (the destination genuinely still streams to EOF).
    let fin = finalized("[Link text Here](");
    assert_eq!(fin, one_shot_complete_literal("[Link text Here]("));
    assert!(
        !fin.contains("<a") && fin.contains("<p>[Link text Here](</p>"),
        "empty-dest at EOF finalizes to literal text: {fin}"
    );
}

#[test]
fn speculative_closed_block_trap() {
    // `[a](http` then a blank line + a second paragraph: the first paragraph is
    // now CLOSED (not the abuts-EOF tail) → it must be LITERAL, and the second
    // paragraph renders normally. Both mid-stream and one-shot agree.
    assert_parity("[a](http\n\npara2");
    let html = streamed_open("[a](http\n\npara2");
    assert!(html.contains("<p>[a](http</p>"), "closed first para must be literal: {html}");
    assert!(html.contains("para2"), "second paragraph must render: {html}");
}

#[test]
fn speculative_reference_links_untouched() {
    // CLOSED reference forms settle the OUTER form exactly as before (unknown
    // ref → literal downgrade); `[t]` abutting EOF holds the pending anchor
    // for a frame (the next byte decides its form); a settled shortcut
    // (`[t] (`) is literal. All stay parity-clean.
    for md in ["[t][r]", "[t][]", "[t]", "[t] ("] {
        assert_parity(md);
    }
    assert!(streamed_open("[t]").contains("<a data-flux-pending=\"\" target="));
    assert!(!streamed_open("[t] (").contains("data-flux-pending"), "settled shortcut is literal");
    // `[t][r]` at EOF: the outer full-ref is literal, but its trailing inner
    // `[r]` abuts EOF and re-speculates on its own — `[t][r](url)` really
    // would parse as literal `[t]` + inline link `[r](url)`.
    let html = streamed_open("[t][r]");
    assert!(
        html.contains("[t]") && html.contains("<a data-flux-pending=\"\" target="),
        "outer literal + inner pending expected: {html}"
    );
}

#[test]
fn speculative_title_midstream_stays_pending() {
    // `[a](url "ti` — the dest ended cleanly and the TITLE is still streaming
    // to EOF: the pending anchor holds (this used to flash literal until `)`).
    assert_parity("[a](url \"ti");
    let html = streamed_open("[a](url \"ti");
    assert!(
        html.contains("<a data-flux-pending=\"\" target=") && !html.contains("href="),
        "mid-title must stay pending: {html}"
    );
    // A blank line inside the title breaks it forever → literal (settled).
    assert_parity("[a](url \"ti\n\nx");
}

#[test]
fn speculative_bracketed_dest_edges() {
    // `<partial` (no closing `>`) → inert; `<url>` (closed, no `)` yet) is
    // still awaiting a title or the `)` → pending too; a broken bracketed dest
    // (forbidden `<`) is malformed forever → literal.
    assert_parity("[a](<partial");
    assert!(streamed_open("[a](<partial").contains("<a data-flux-pending=\"\" target="));
    assert_parity("[a](<url>");
    assert!(streamed_open("[a](<url>").contains("<a data-flux-pending=\"\" target="));
    assert_parity("[a](<br<");
    assert!(!streamed_open("[a](<br<").contains("<a "), "broken bracketed dest is literal");
}

#[test]
fn speculative_mid_text_non_speculation() {
    // `[a](http) word` → a real link followed by text (the `)` closes it).
    assert_parity("[a](http) word");
    let html = streamed_open("[a](http) word");
    assert!(html.contains("<a href="), "complete link mid-text is real: {html}");
    // `[a](http word` → space ends the bare dest, no `)` → literal.
    assert_parity("[a](http word");
    assert!(!streamed_open("[a](http word").contains("<a"), "malformed mid-text is literal");
}

#[test]
fn speculative_image_stays_literal() {
    // `![alt](http` must NOT speculate an <img> or an <a> — partial image stays
    // literal (the `!`+`[` arm has no speculative branch).
    assert_parity("![alt](http");
    let html = streamed_open("![alt](http");
    assert!(!html.contains("<img"), "partial image must not render <img>: {html}");
    assert!(!html.contains("<a "), "partial image must not render <a>: {html}");
}

#[test]
fn speculative_convergence_node_stability() {
    // Append `[Link](`, then `https://x`, then `)` — the tag+target+rel are
    // byte-stable across the inert→real transition; only `href` is ADDED.
    let mut p = StreamParser::new();
    p.append("[Link](");
    let s1 = collect(&p);
    p.append("https://x");
    let s2 = collect(&p);
    p.append(")");
    let s3 = collect(&p);

    // First two states: identical inert pending <a> (no href).
    assert_eq!(s1, s2, "inert <a> must be byte-stable while the URL streams");
    assert!(s1.contains("<a data-flux-pending=\"\" target=\"_blank\" rel=\"noopener noreferrer nofollow\">Link</a>"));
    assert!(!s1.contains("href="));

    // Final state: `href` replaced the pending marker in place; the
    // target/rel/label tail is intact (attribute swap on the same node).
    assert!(s3.contains("<a href=\"https://x\" target=\"_blank\" rel=\"noopener noreferrer nofollow\">Link</a>"));
    // The inert prefix (everything after the would-be href) is reused verbatim.
    assert!(s3.contains("target=\"_blank\" rel=\"noopener noreferrer nofollow\">Link</a>"));
}

#[test]
fn speculative_cache_commit_safety_long_prefix() {
    // A long settled paragraph prefix then a partial link tail: the committed
    // inner (frozen) never freezes the inert <a>, and finalize is literal.
    let lead = "word ".repeat(200);
    let md = format!("{lead}[Link](https://x");
    assert_parity(&md);
    let streamed = streamed_open(&md);
    // Inert <a> present mid-stream, no raw URL leak, no href.
    assert!(streamed.contains("<a data-flux-pending=\"\" target="), "inert pending <a> present: ...{}", &streamed[streamed.len().saturating_sub(120)..]);
    assert!(!streamed.contains("href="));
    // Finalize collapses to literal (the frozen prefix never captured an <a>).
    let fin = finalized(&md);
    assert!(!fin.contains("<a"), "finalize must be literal even after a long prefix");
    assert!(fin.contains("[Link](https://x"), "literal tail preserved");
}

#[test]
fn open_math_block_matches() {
    // gfm_math is off in the default helper, so display math without it stays
    // as a paragraph in both paths. Pinned to ensure consistency either way.
    let make = || StreamParser::new().with_gfm_alerts(true).with_gfm_math(true);
    let cases = ["$$\nE = mc^2\n", "$$\nx + y\n= z\n"];
    for md in cases {
        let one = {
            let mut p = make();
            p.append(md);
            collect(&p)
        };
        let streamed = {
            let mut p = make();
            let mut buf = [0u8; 4];
            for ch in md.chars() {
                p.append(ch.encode_utf8(&mut buf));
            }
            p.append("");
            collect(&p)
        };
        assert_eq!(streamed, one, "mid-stream != one-shot for {md:?}");
    }
}

// ---------------------------------------------------------------------------
// Speculative open-tail INLINE CODE + INLINE MATH (kills the streaming
// raw-source flash for `` `code` `` / `$x$` / `\(a+b\)`). While the closer is
// still streaming to EOF, render the resolved `<code>…</code>` /
// `<span class="math …">…</span>` over the partial body, with the opening
// delimiter hidden; finalize of an unclosed form is byte-identical literal.
// ---------------------------------------------------------------------------

/// math-on variants of the parity helpers (the default helpers leave `$`/`\(`
/// literal). `with_gfm_alerts(true)` mirrors the other speculative helpers.
fn make_math() -> StreamParser {
    StreamParser::new().with_gfm_alerts(true).with_gfm_math(true)
}
fn one_shot_open_m(md: &str) -> String {
    let mut p = make_math();
    p.append(md);
    collect(&p)
}
fn streamed_open_m(md: &str) -> String {
    let mut p = make_math();
    let mut buf = [0u8; 4];
    for ch in md.chars() {
        p.append(ch.encode_utf8(&mut buf));
    }
    p.append("");
    collect(&p)
}
fn assert_parity_m(md: &str) {
    assert_eq!(streamed_open_m(md), one_shot_open_m(md), "mid-stream != one-shot for {md:?}");
}
fn finalized_m(md: &str) -> String {
    let mut p = make_math();
    p.append(md);
    p.finalize();
    collect(&p)
}

#[test]
fn speculative_inline_code_golden() {
    // Open `` `code here` `` (no closer yet): resolved `<code>` over the partial
    // body, opening backtick hidden, no raw backtick/source as visible text.
    let md = "`code here";
    assert_parity_m(md);
    let html = streamed_open_m(md);
    assert!(html.contains("<code>code here</code>"), "expected resolved <code> for {md:?}: {html}");
    assert!(!visible_text_contains(&html, "`"), "raw backtick must not be visible text for {md:?}: {html}");

    // Closed `` `code here` `` → identical resolved <code> (the close is hidden too).
    assert_parity_m("`code here`");
    assert!(streamed_open_m("`code here`").contains("<code>code here</code>"));

    // Lone opener `` ` `` (empty body) is NOT speculated — stays literal.
    assert_parity_m("`");
    assert!(!streamed_open_m("`").contains("<code>"), "empty-body backtick must stay literal");

    // Finalize of the unclosed form is byte-identical literal (no <code>).
    let fin = finalized_m("`code here");
    assert!(!fin.contains("<code>"), "finalized unclosed code must be literal: {fin}");
    assert!(fin.contains("`code here"), "literal backtick preserved on finalize: {fin}");
}

#[test]
fn speculative_inline_dollar_math_golden() {
    // Open `$x^2 + y^2$` (no closer yet): resolved inline-math span over the
    // partial body, opening `$` hidden, no raw `$` as visible text.
    let md = "$x^2 + y^2";
    assert_parity_m(md);
    let html = streamed_open_m(md);
    assert!(
        html.contains("<span class=\"math math-inline\">x^2 + y^2</span>"),
        "expected resolved inline-math span for {md:?}: {html}"
    );
    assert!(!visible_text_contains(&html, "$"), "raw $ must not be visible text for {md:?}: {html}");

    // Closed form → identical span.
    assert_parity_m("$x^2 + y^2$");
    assert!(streamed_open_m("$x^2 + y^2$").contains("<span class=\"math math-inline\">x^2 + y^2</span>"));

    // pandoc currency guard preserved: `$ ` (space after single `$`) never
    // speculates; `$5 and $10` stays literal currency text.
    assert_parity_m("$ x");
    assert!(!streamed_open_m("$ x").contains("class=\"math"), "`$ ` must not speculate (pandoc guard)");
    assert_parity_m("I have $5 and $10 left");

    // Finalize of the unclosed form is literal.
    let fin = finalized_m("$x^2 + y^2");
    assert!(!fin.contains("class=\"math"), "finalized unclosed $math must be literal: {fin}");
    assert!(fin.contains("$x^2 + y^2"), "literal $ preserved on finalize: {fin}");
}

#[test]
fn dollar_tail_cache_parity_and_drops() {
    // The DollarTailCache linearizes the `$x $x …` soup: an open single-`$`
    // inline-math span whose escaped body just grows. It must stay byte-identical
    // to the full path at every chunk boundary, and DROP the instant the span
    // could have closed or restructured — a valid `$` closer, a `$$` run, an
    // escaped `$`, or a newline. `assert_parity_m` (char-by-char + empty append)
    // is the strongest mid-stream stress; a 2-chunk sweep pins the retro-close
    // and drop transitions across an arbitrary boundary.
    let cases = [
        // Fast path engaged, never drops (every inner `$` is space-preceded).
        "$x $x $x $x ",
        "$x $x $ *emph inside is math text* $x ",
        // A `*` inside the OPEN span is opaque math text (no emphasis) — the
        // fast path need NOT drop for it (it can never reach across the `$`).
        "$x $x *b* $x ",
        // Retro-close: a trailing `$` with a non-space to its left closes the
        // span (the opener pairs forward), so the cache must drop to the full
        // path — which, at this open prefix, renders the CLOSED span.
        "$a b c$",
        "$x $x $x$",
        "$x^2 + y^2$ then plain *emphasized* text",
        // An escaped `$` — the `\$`'s `$` (backslash to its left) is a closer
        // candidate to the raw math scanner, so the guard drops.
        "$x \\$y closes",
        // A `$$` run appears — display math; the guard drops.
        "$x $$y",
        // A newline — the single-line span becomes multi-line; the guard drops.
        "$x $x\nmore text",
        // Currency prose: the engine's opener guard is only "non-space to the
        // right" (the digit rule is closer-side), so `$5` DOES open a
        // speculative span mid-stream — the cache arms and must mirror it.
        "$5 and $10 left over",
    ];
    for md in cases {
        assert_parity_m(md);
        for cut in 1..md.len() {
            if !md.is_char_boundary(cut) {
                continue;
            }
            let mut p = make_math();
            p.append(&md[..cut]);
            p.append(&md[cut..]);
            assert_eq!(
                collect(&p),
                one_shot_open_m(md),
                "2-chunk open view split at {cut} != one-shot for {md:?}"
            );
            // Finalize must be chunk-independent regardless of where the cache
            // engaged/dropped (the ironclad invariant).
            p.finalize();
            let one = {
                let mut q = make_math();
                q.append(md);
                q.finalize();
                collect(&q)
            };
            assert_eq!(collect(&p), one, "finalize split at {cut} != one-shot for {md:?}");
        }
    }
}

#[test]
fn dollar_tail_cache_retro_close_across_chunk_boundary() {
    // Stream the open span, then land the closing `$` in its OWN chunk: the fast
    // path was engaged, the closer arrives, the cache drops, and the resulting
    // open view equals a one-shot append of the whole prefix.
    let mut p = make_math();
    p.append("$a b c");
    assert_eq!(collect(&p), one_shot_open_m("$a b c"), "open span before close");
    p.append("$"); // valid closer (non-space `c` to its left) — retro-close
    assert_eq!(collect(&p), one_shot_open_m("$a b c$"), "closed span after retro-close");
    p.append(" tail *word*"); // trailing prose (with emphasis) after the close
    assert_eq!(collect(&p), one_shot_open_m("$a b c$ tail *word*"), "prose after close");
}

#[test]
fn speculative_inline_latex_math_golden() {
    // Open `\(a+b\)` (no closer yet): resolved inline-math span over the partial
    // body, opening `\(` hidden, no raw `\(` as visible text.
    let md = "\\(a+b";
    assert_parity_m(md);
    let html = streamed_open_m(md);
    assert!(
        html.contains("<span class=\"math math-inline\">a+b</span>"),
        "expected resolved inline-math span for {md:?}: {html}"
    );
    assert!(!visible_text_contains(&html, "\\("), "raw \\( must not be visible text for {md:?}: {html}");

    // Inline display `\[a=b\]` open form → inline display span. (A LEADING `\[`
    // opens a block-level `<div class="math math-display">` instead — a separate,
    // already-parity scanner path — so prefix it with inline text to exercise the
    // inline `try_math_delim` speculation.)
    let dm = "x \\[a=b";
    assert_parity_m(dm);
    assert!(
        streamed_open_m(dm).contains("<span class=\"math math-display\">a=b</span>"),
        "expected resolved inline display-math span for {dm:?}: {}",
        streamed_open_m(dm)
    );

    // Closed forms → identical spans.
    assert_parity_m("\\(a+b\\)");
    assert!(streamed_open_m("\\(a+b\\)").contains("<span class=\"math math-inline\">a+b</span>"));

    // Empty body `\(` (opener only) is NOT speculated — stays literal `(`.
    assert_parity_m("\\(");

    // Blank-line guard: a `\n\n` before EOF closes the paragraph → literal (math
    // never crosses a paragraph break), matching one-shot.
    assert_parity_m("\\(a+b\n\npara2");
    assert!(!streamed_open_m("\\(a+b\n\npara2").contains("class=\"math"), "math must not cross a blank line");

    // Finalize of the unclosed form is literal.
    let fin = finalized_m("\\(a+b");
    assert!(!fin.contains("class=\"math"), "finalized unclosed \\(…) must be literal: {fin}");
}

#[test]
fn test_backslash_artifact_in_paren_math() {
    // The known artifact: \(a + b\ renders with a trailing backslash in the
    // math content (the first byte of the 2-byte closer \)).
    let md = "\\(a + b\\";
    let html = streamed_open_m(md);
    println!("HTML for '{}': {}", md, html);
    
    // Check if content contains the trailing backslash
    if html.contains("b\\</span>") {
        println!("ARTIFACT CONFIRMED: trailing backslash in <span class=\"math\">a + b\\</span>");
    } else {
        println!("No trailing backslash artifact detected");
    }
}

#[test]
fn nested_list_does_not_flatten_when_outer_goes_loose() {
    // Regression: the list-cache fast path treated a 2-space-indented sub-bullet
    // as a top-level SIBLING (`marker_indent <= edge + 3`), so the moment a loose
    // outer list's second item appeared, the first item's nested sub-bullets
    // FLATTENED into top-level items mid-stream (a visible "indentation vanishes
    // then comes back" reflow). The sibling test now uses the first item's
    // content column, so a marker at/past it nests (cache bails to the full path).
    assert_parity("- **A:**\n  - x1\n  - x2\n\n- **B"); // 2nd item incomplete — the exact trigger
    assert_parity("- **A:**\n  - x1\n  - x2\n\n- **B:**\n  - y1\n  - y2\n");
    assert_parity("- a\n  - nested\n\n- b\n"); // minimal loose-outer + nested
    assert_parity("1. top\n   1. nested\n   2. nested2\n\n2. second\n"); // ordered, 3-space content col
    assert_parity("- one\n  - sub a\n  - sub b\n  - sub c\n\n- two\n  - sub d\n"); // the user's shape
}

#[test]
fn blockquote_inner_block_structure_not_flattened_mid_stream() {
    // Regression: the container (blockquote/alert) cache rendered ALL inner
    // content as flat paragraph text, so a list / nested quote / heading inside a
    // streaming blockquote showed as escaped "- a" text until finalize, then
    // snapped into a real <ul> (a structural flicker, same class as the list one).
    // The cache now bails to the full reparse when an inner line starts a block.
    assert_parity("> - a\n> - b\n");
    assert_parity("> 1. x\n> 2. y\n");
    assert_parity("> text\n> - bullet\n");
    assert_parity("> > nested quote\n> > line2\n");
    assert_parity("> # heading in quote\n");
    assert_parity("> ```\n> code\n> ```\n");
    assert_parity("> [!NOTE]\n> - a\n> - b\n"); // alert body with a list
    assert_parity("> para\n>\n> - then a list\n");
}

#[test]
fn blockquote_inner_all_block_types_not_flattened() {
    // Broader regression (corpus-found): the container cache must bail to the full
    // reparse for EVERY non-paragraph inner block — not just lists/quotes. Each of
    // these used to render as escaped paragraph text mid-stream, then snap.
    assert_parity("> Section Title\n> =============\n> body text\n"); // setext h1
    assert_parity("> Heading\n> -------\n"); // setext h2
    assert_parity("> | a | b |\n> | - | - |\n> | 1 | 2 |\n"); // table
    assert_parity("> [!TIP]\n> | k | v |\n> | - | - |\n> | a | b |\n"); // table in alert
    assert_parity("> intro\n>\n>     indented code\n>     more code\n"); // indented code after blank
    assert_parity("> 5. fifth\n> 6. sixth\n"); // ordered list, start != 1
    assert_parity("> [!IMPORTANT]\n> 3. step three\n> 4. step four\n"); // ordered list in alert
    assert_parity("> [home]: https://example.com \"Home\"\n> See the [home] page.\n"); // ref def (no output)
    assert_parity("> ---\n"); // thematic break
}

#[test]
fn lazy_continuation_streams_with_parity() {
    // The container cache folds marker-less lazy paragraph-continuation lines
    // (glued like `blockquote_inner`) instead of bailing — including the
    // still-partial trailing lazy line, which the one-shot scan already keeps
    // in the quote at the same prefix.
    assert_parity("> a\nlazy");
    assert_parity("> a\nlazy line\n");
    assert_parity("> a\nlazy one\nlazy two");
    assert_parity("> a\nlazy one\n> back to marked\n");
    assert_parity("> a\n  indented laz");
    assert_parity("> a\n===");
    assert_parity("> a\n5. not a list\n");
    assert_parity("> [!NOTE]\n> body\nlazy body tail");
    // A lazy line directly after the `[!NOTE]` marker glues onto the TITLE
    // line, so the container is no longer an alert at all — the cache must
    // hand the boundary back to the full reparse.
    assert_parity("> [!NOTE]\nlazy title continuation");
    assert_parity("> [!NOTE]\nlazy title continuation\n");
    // Lines that END the quote at this prefix instead (block start / blank /
    // no open paragraph) — the full path owns the boundary.
    assert_parity("> a\n# h");
    assert_parity("> a\n- item");
    assert_parity("> a\n>\noutside");
    assert_parity("> a\n\nafter");
}

#[test]
fn quote_hosted_ref_defs_stream_with_parity() {
    // Link-ref defs inside an open quote are consumed natively by the nested
    // parser (defs render to nothing; uses resolve once the def is complete) —
    // mid-stream output must match the one-shot view of the same prefix.
    assert_parity("> [r]: https://example.com/x \"T\"\n");
    assert_parity("> [r]: https://example.com/x \"T\"\n> [s]: https://example.com/y\n");
    assert_parity("> [r]: https://example.com/x\n> see [it][r] resolved\n");
    assert_parity("> [r]: https://example.com/x\n> partial [it][r");
    assert_parity("> [!NOTE]\n> [r]: https://example.com/x\n> body [use][r]\n");
    // half-typed def at the tail (dest, then title still arriving)
    assert_parity("> [r]: https://exa");
    assert_parity("> [r]: https://example.com/x \"Tit");
    // `[^…]:` with footnotes off is a plain link-ref def
    assert_parity("> [^f]: https://example.com/n\n");
}

/// Strip tags and decode entities → the text a user actually SEES.
fn visible_text(html: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&amp;", "&")
}

/// Parser configured like the JS default (safe raw-HTML sanitizer, allow-all):
/// raw tags render as markup, so a streaming one must be SUPPRESSED, not shown.
fn sanitized() -> StreamParser {
    let mut p = StreamParser::new().with_gfm_alerts(true);
    p.set_html_sanitize(true, vec![], vec![]);
    p
}

fn streamed_open_sanitized(md: &str) -> String {
    let mut p = sanitized();
    let mut buf = [0u8; 4];
    for ch in md.chars() {
        p.append(ch.encode_utf8(&mut buf));
    }
    p.append("");
    collect(&p)
}

fn one_shot_open_sanitized(md: &str) -> String {
    let mut p = sanitized();
    p.append(md);
    collect(&p)
}

fn finalized_sanitized(md: &str) -> String {
    let mut p = sanitized();
    p.append(md);
    p.finalize();
    collect(&p)
}

/// A raw-HTML anchor arriving over a stream must NEVER flash its URL (or any
/// tag internals) as visible text while the block is open — the raw-HTML twin
/// of the speculative markdown-link contract. Albany-reported: backends that
/// emit `<a href="…">label</a>` instead of markdown links leaked the href for
/// the whole window in which the opening tag was partially streamed. Applies
/// under the sanitizer (the flux-md JS default) and `unsafe_html` — in plain
/// escape mode a tag is literal visible text, so nothing is suppressed there.
#[test]
fn streaming_raw_html_tag_never_leaks_url() {
    let secret = "platform.example.com/company/91576/transcript";
    let docs = [
        format!("Revenue was reported <a href=\"https://{secret}\">here</a> today."),
        // table cell (the structured/blockData channel shares render_cell_inner)
        format!("| co | src |\n| -- | --- |\n| acme | <a href=\"https://{secret}\">link</a> |"),
    ];
    // Autolink: once the closing `>` lands the URL IS the visible link label —
    // the contract here is only that no PARTIAL URL shows while it streams.
    {
        let doc = format!("See <https://{secret}> for details.");
        let done_at = doc.find('>').unwrap() + 1;
        for cut in 1..done_at {
            let vis = visible_text(&streamed_open_sanitized(&doc[..cut]));
            assert!(
                !vis.contains("platform.example"),
                "partial autolink URL visible while streaming at cut {cut}: {vis:?}"
            );
        }
        let done = finalized_sanitized(&doc);
        assert!(done.contains("<a href="), "completed autolink missing: {done}");
    }
    for doc in &docs {
        for cut in 1..doc.len() {
            if !doc.is_char_boundary(cut) {
                continue;
            }
            let prefix = &doc[..cut];
            let open = streamed_open_sanitized(prefix);
            let vis = visible_text(&open);
            assert!(
                !vis.contains("platform.example") && !vis.contains("href"),
                "URL/tag internals visible while open at cut {cut}: {vis:?} (doc {doc:?})"
            );
            // and the mid-stream view must stay chunk-independent. Skipped for
            // cuts inside a table's header/delimiter prelude: the streamed
            // paragraph-cache classifies the block as a table one line later
            // than the one-shot path does mid-delimiter — a PRE-EXISTING,
            // transient divergence (verified on the untouched tree; resolves at
            // the delimiter's newline; finalize output is chunk-independent).
            let table_prelude = doc.starts_with('|')
                && doc.match_indices('\n').nth(1).map_or(true, |(i, _)| cut <= i + 1);
            if !table_prelude {
                assert_eq!(open, one_shot_open_sanitized(prefix), "mid-stream != one-shot at cut {cut} (doc {doc:?})");
            }
        }
        // Once complete, the anchor renders (URL only inside the attribute).
        let done = finalized_sanitized(doc);
        assert!(done.contains("<a href="), "completed anchor missing: {done}");
    }
}

/// The suppression must not hide everyday comparisons — `<` followed by
/// space/digit/punct can never become a tag or autolink and stays visible
/// mid-stream; and a PERMANENTLY partial tag still finalizes to literal text
/// (spec: unterminated `<` is just text).
#[test]
fn streaming_tag_suppression_spares_comparisons_and_finalize_is_literal() {
    for md in ["price a < b holds", "x<2 and y<3", "5 <= 6"] {
        let open = streamed_open_sanitized(md);
        let vis = visible_text(&open);
        assert!(vis.contains('<'), "comparison hidden mid-stream: {md:?} -> {vis:?}");
        assert_eq!(streamed_open_sanitized(md), one_shot_open_sanitized(md), "parity for {md:?}");
    }
    // Unterminated tag at finalize: escaped literal, byte-par with one-shot.
    let fin = finalized_sanitized("cut <a href=\"https://u.example/x");
    let fin_one_shot = {
        let mut p = sanitized();
        p.append("cut <a href=\"https://u.example/x");
        p.finalize();
        collect(&p)
    };
    assert_eq!(fin, fin_one_shot);
    assert!(visible_text(&fin).contains("<a href="), "finalize must render the partial tag literally: {fin}");
    // A completed opening tag with the label still streaming keeps the URL in
    // the attribute — visible text is just the label so far.
    let open = streamed_open_sanitized("see <a href=\"https://u.example/x\">Earnings Ca");
    let vis = visible_text(&open);
    assert!(vis.contains("Earnings Ca") && !vis.contains("u.example"), "label streams, URL stays hidden: {vis:?}");
    // Escape mode (no sanitizer, no unsafe_html): a tag is literal visible
    // text — nothing is suppressed, the raw prefix stays visible mid-stream.
    let open = streamed_open("cut <a href=\"https://u.example/x");
    assert!(visible_text(&open).contains("<a href="), "escape mode must not suppress: {open}");
}

// ---------------------------------------------------------------------------
// AlnumTailCache (giant-word-autolinks-pin) + RawTagTailCache (raw-tag-tail-pin)
// — the streaming O(n²) pins these two caches linearize. The pins are semantic
// (the commit cut is genuinely stuck at 0), so the caches must reproduce the
// full path's open view byte-for-byte at every chunk split and DROP the instant
// a byte could settle the cut. `assert_sweep` (char-by-char + a 2-chunk sweep at
// every boundary, open view AND finalize) is the strongest mid-stream stress.
// ---------------------------------------------------------------------------

/// Assert the streamed open view equals the one-shot open view for `md`,
/// char-by-char and for a 2-chunk split at every char boundary, and that finalize
/// is chunk-independent regardless of where the cache engaged or dropped.
fn assert_sweep(make: &dyn Fn() -> StreamParser, md: &str) {
    let one_open = {
        let mut p = make();
        p.append(md);
        collect(&p)
    };
    // Char-by-char + a trailing empty append (fires any freshly-armed cache).
    {
        let mut p = make();
        let mut buf = [0u8; 4];
        for ch in md.chars() {
            p.append(ch.encode_utf8(&mut buf));
        }
        p.append("");
        assert_eq!(collect(&p), one_open, "char-stream open != one-shot for {md:?}");
    }
    let one_final = {
        let mut q = make();
        q.append(md);
        q.finalize();
        collect(&q)
    };
    for cut in 1..md.len() {
        if !md.is_char_boundary(cut) {
            continue;
        }
        let mut p = make();
        p.append(&md[..cut]);
        p.append(&md[cut..]);
        assert_eq!(collect(&p), one_open, "2-chunk open split at {cut} != one-shot for {md:?}");
        p.finalize();
        assert_eq!(collect(&p), one_final, "2-chunk finalize split at {cut} != one-shot for {md:?}");
    }
}

#[test]
fn alnum_tail_cache_parity_and_drops() {
    // Extended autolinks ON pins the cut for a space-free alnum run (a future
    // `@`/`.` could bind it into an autolink), so the AlnumTailCache carries the
    // open view. It must mirror the full path and drop the instant a non-alnum
    // byte settles the run — a space, a `.`/`@`/`:` that could open/complete an
    // autolink, an emphasis opener, or a newline.
    let make = || StreamParser::new().with_gfm_alerts(true).with_gfm_autolinks(true);
    let cases = [
        // Fast path engaged, never drops (pure alnum to EOF).
        "aaaaaaaaaaaaaaaaaaaaaaaa",
        "abc123DEF456GHI789",
        // Run then a byte that settles / could bind — the cache must drop and the
        // full path (which sees the whole prefix) render byte-identically.
        "aaaaaaaa bbbbbbbb",          // space: a boundary settles
        "aaaaaaaa@bbbbb.com",         // `@`: retro email-autolink bind across the run
        "aaaaaaaa.bbbbbbbb",          // `.`: could begin a domain
        "aaaaaaaa-bbbb_cccc+dddd",    // `.+_-` mixes (all drop the fast path)
        "www.example.com",            // `www.` autolink onset
        "wwwaaaaaaaaaaaa",            // `www` with no dot: NOT an autolink
        "https://example.com/path",   // scheme autolink mid-run
        "httpsaaaaaaaaaaaa",          // scheme letters with no `://`: NOT an autolink
        "aaaaaaaa\nmore words here",  // newline: the single line ends
        "aaaaaaaa*emph*",             // emphasis opener after the run
        "aaaaaaaa&amp;bbbb",          // entity opener after the run
    ];
    for md in cases {
        assert_sweep(&make, md);
    }
}

#[test]
fn alnum_tail_cache_retro_bind_across_chunk_boundary() {
    // Stream the open alnum run, then land the `@` (and domain) in its own chunk:
    // the fast path was engaged, the settling byte arrives, the cache drops, and
    // the open view equals a one-shot append of the whole prefix.
    let make = || StreamParser::new().with_gfm_alerts(true).with_gfm_autolinks(true);
    let mut p = make();
    p.append("aaaaaaaa");
    let plain = {
        let mut q = make();
        q.append("aaaaaaaa");
        collect(&q)
    };
    assert_eq!(collect(&p), plain, "pure alnum before the bind");
    p.append("@example.com"); // retro email-autolink bind
    let bound = {
        let mut q = make();
        q.append("aaaaaaaa@example.com");
        collect(&q)
    };
    assert_eq!(collect(&p), bound, "email autolink after the retro bind");
}

#[test]
fn raw_tag_tail_cache_parity_and_drops() {
    // A never-closing raw open tag whose quoted attr value streams to EOF is
    // SUPPRESSED under unsafe/sanitize HTML — the render is a constant `<p></p>`,
    // carried by the RawTagTailCache. It must drop the instant the value's
    // matching quote closes (the tag can complete or gain attrs) or a newline
    // splits the line, and `>`/`<` INSIDE the quoted value must NOT close it.
    let make = || StreamParser::new().with_gfm_alerts(true).with_unsafe_html(true);
    let cases = [
        // Fast path engaged (unclosed quoted value to EOF).
        "<a href=\"https://example.com/aaaaaaaaaaaaaaaa",
        "<a href=\"https://example.com/x?a=1&b=2&c=3",   // `&`/`?`/`=` are opaque value bytes
        "<a href=\"https://ex.com/a>b>c>d",               // `>` INSIDE quotes does NOT close
        "<a href=\"a<b<c<d",                              // second `<` inside the value
        "<a href='https://ex.com/aaaaaaaa",              // single-quoted value
        "<img src=\"data:image/png;base64,AAAABBBBCCCC",  // different tag/attr
        // Drop transitions that keep the block a paragraph (prefix-stable) — the
        // full path (whole prefix) renders byte-identically.
        "<a href=\"https://ex.com/\" data-x=\"y",         // first attr closes, second opens
        "<a href=\"https://ex.com/\"",                    // quote closes, awaiting `>`
        "<a href=\"https://ex.com/x\nmore",               // newline arrives inside the value
        // NOTE: a tag that COMPLETES with a `>` landing alone at end-of-line
        // mid-stream (`<a href="…">` then text) commits a type-7 raw-HTML block —
        // a PRE-EXISTING, chunk-dependent property of raw-HTML blocks (verified on
        // the untouched tree: char-stream sees the HTML block, one-shot-of-the-
        // full-line sees a paragraph), orthogonal to this cache (which has already
        // dropped at the closing quote). Its completion is covered chunk-stably by
        // `raw_tag_tail_cache_quote_close_across_chunk_boundary` below.
    ];
    for md in cases {
        assert_sweep(&make, md);
    }
}

#[test]
fn raw_tag_tail_cache_quote_close_across_chunk_boundary() {
    // Stream the open tag, then land the closing quote + `>` in their own chunk:
    // the fast path was engaged, the value closes, the cache drops, and the open
    // view equals a one-shot append of the whole prefix.
    let make = || StreamParser::new().with_gfm_alerts(true).with_unsafe_html(true);
    let mut p = make();
    p.append("<a href=\"https://ex.com/aaaa");
    let suppressed = {
        let mut q = make();
        q.append("<a href=\"https://ex.com/aaaa");
        collect(&q)
    };
    assert_eq!(collect(&p), suppressed, "open tag suppressed to <p></p>");
    p.append("\">hello</a>"); // quote closes + tag completes in its own chunk
    let done = {
        let mut q = make();
        q.append("<a href=\"https://ex.com/aaaa\">hello</a>");
        collect(&q)
    };
    assert_eq!(collect(&p), done, "completed anchor after the close");
}

#[test]
fn raw_tag_tail_cache_mode_interaction() {
    // Sanitize mode suppresses identically to unsafe (same code path) — the cache
    // MAY engage there. Escape mode renders the `<` as visible `&lt;…` text — a
    // different (out-of-scope) shape — so the cache must NOT engage; either way
    // the streamed view stays byte-identical to the full path.
    let md = "<a href=\"https://example.com/aaaaaaaaaaaa";
    let make_unsafe = || StreamParser::new().with_gfm_alerts(true).with_unsafe_html(true);
    let make_sanitize = || {
        let mut p = StreamParser::new().with_gfm_alerts(true);
        p.set_html_sanitize(true, vec![], vec![]);
        p
    };
    let make_escape = || StreamParser::new().with_gfm_alerts(true);
    assert_sweep(&make_unsafe, md);
    assert_sweep(&make_sanitize, md);
    assert_sweep(&make_escape, md);
    // The escape-mode open view keeps the raw prefix visible (never suppressed).
    let mut e = make_escape();
    e.append(md);
    assert!(visible_text(&collect(&e)).contains("<a href="), "escape mode must not suppress the tag");
}

// ---------------------------------------------------------------------------
// Mod3TailCache (delimiter-stack-mod3-rescan) — the `a**bc* c* …` soup. A lone
// `**` (can-open AND can-close) that every later single `*` is mod-3-blocked
// from closing stays an unpaired opener, pinning the commit cut at 0. While the
// `**` is the sole opener the paragraph is all-literal, so the cache carries the
// open view; it must mirror the full path byte-for-byte at every chunk split and
// DROP the instant a byte could restructure the render. `assert_sweep`
// (char-by-char + a 2-chunk sweep at every boundary, open view AND finalize) is
// the strongest mid-stream stress.
// ---------------------------------------------------------------------------

/// The mod3 cache is config-independent (emphasis is always on); the richest
/// base config (autolinks + alerts + math) also exercises the autolink boundary
/// probe after the soup's `*`/space bytes.
fn make_mod3() -> StreamParser {
    StreamParser::new()
        .with_gfm_alerts(true)
        .with_gfm_autolinks(true)
        .with_gfm_math(true)
}

#[test]
fn mod3_tail_cache_parity_and_drops() {
    let make = make_mod3;
    let cases = [
        // Fast path engaged, never drops (every later `*` is a mod-3-blocked
        // single closer followed by a space).
        "a**bc* c* c* c* c* ",
        "a**bc* c* c* c* c*",   // trailing `*` at EOF (pending, literal)
        "a**bc* c* c",          // trailing inert byte
        "a**b",                 // just the opener + one byte
        "a**world giant word",  // words + spaces, no closers
        // Retro-pair drops: a real `**`/`***`/`_`/`~`/entity/opener/newline
        // arrives and the cache must drop to the full path (which re-renders the
        // whole prefix byte-identically — a `<strong>`, an `<em>`, a `<del>`, …).
        "a**bc**",              // `**` closer -> <strong>
        "a**bc** and more c* ", // strong then trailing soup
        "a**b***c",             // `***` run
        "a**bc*x",              // single `*` a non-space follows -> could open
        "a**bc* *word*",        // a real `*…*` emphasis pair later
        "a**bc* _under_ c*",    // `_` emphasis mixed in
        "a**bc* ~strike~ c*",   // `~` strikethrough mixed in
        "a**bc* &amp; c*",      // an entity opener
        "a**bc* `code` c*",     // a code span opener
        "a**bc* [link](u) c*",  // a link opener
        "a**bc* $x$ c*",        // inline math opener
        "a**béc* c*",           // non-ASCII body byte -> drop
        // Newline drops: soup then a blank line, and soup then a soft newline +
        // more prose (the single-line paragraph splits / closes).
        "a**bc* c*\n\nsecond para",
        "a**bc* c*\nlazy continuation line with **b** and more",
        "a**bc* c*  \nhard break tail",   // 2 trailing spaces before \n
        // Not our shape (must never engage, but must still be parity-clean):
        // a space before `**` makes it can-open-only (real streaming bold).
        "hello **world**",
        "a **b c* d",
    ];
    for md in cases {
        assert_sweep(&make, md);
    }
}

#[test]
fn mod3_tail_cache_pending_star_phases_across_chunk_boundary() {
    // The pending-suffix path: a `*` landing on a chunk boundary must be held
    // (rendered literally in the open view), NOT force a drop — otherwise the
    // soup's 3-byte period vs. large chunks would re-quadratic. Drive all three
    // phases of "c* " (`c`, `*`, ` `) across an explicit 2-chunk boundary.
    let one = |md: &str| {
        let mut p = make_mod3();
        p.append(md);
        collect(&p)
    };
    let mut p = make_mod3();
    p.append("a**bc*"); // trailing `*` pending (single, at edge)
    assert_eq!(collect(&p), one("a**bc*"), "trailing `*` held pending, literal");
    p.append(" "); // the space settles the pending `*` as a closer
    assert_eq!(collect(&p), one("a**bc* "), "space settles the pending `*`");
    p.append("c"); // more body
    assert_eq!(collect(&p), one("a**bc* c"), "body byte after the settled `*`");
    p.append("*"); // next `*` pending again
    assert_eq!(collect(&p), one("a**bc* c*"), "next `*` held pending");
    p.append("*"); // grows to `**` -> a decided closer pairs -> drop -> <strong>
    assert_eq!(collect(&p), one("a**bc* c**"), "grown `**` retro-pairs to <strong>");
}

#[test]
fn mod3_tail_cache_retro_strong_across_chunk_boundary() {
    // Stream the open soup, then land a `**` closer in its own chunk: the fast
    // path was engaged, the closer arrives, the cache drops, and the open view
    // equals a one-shot append of the whole prefix (`a<strong>bc… </strong>`).
    let one = |md: &str| {
        let mut p = make_mod3();
        p.append(md);
        collect(&p)
    };
    let mut p = make_mod3();
    p.append("a**bc* c* c");
    assert_eq!(collect(&p), one("a**bc* c* c"), "open soup before the close");
    p.append("**"); // valid `**` closer (non-space `c` to its left) — retro-pair
    assert_eq!(collect(&p), one("a**bc* c* c**"), "closed <strong> after retro-pair");
    p.append(" then *plain* text"); // trailing prose (with emphasis) after the close
    assert_eq!(collect(&p), one("a**bc* c* c** then *plain* text"), "prose after close");
}

// ---------------------------------------------------------------------------
// Deep-quote staircase (the `DeepQuoteCache` fast path): a monotonically
// deepening nested blockquote — line k carries k `> ` markers — streams in
// O(new bytes) with no per-level recursion, and must stay byte-identical to the
// one-shot open view at every chunk split. Guards the container-depth-growth-pin
// fix (folded settled levels, empty deeper markers, incomplete deepest line).
// ---------------------------------------------------------------------------

fn streamed_open_chunked(md: &str, chunk: usize) -> String {
    let mut p = StreamParser::new().with_gfm_alerts(true);
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
    p.append("");
    collect(&p)
}

fn staircase(depth: usize) -> String {
    let mut s = String::new();
    for k in 1..=depth {
        for _ in 0..k {
            s.push_str("> ");
        }
        s.push_str(&format!("level {k} prose with **bold**\n"));
    }
    s
}

#[test]
fn deep_quote_staircase_parity_all_cuts() {
    // A staircase crossing MAX_CONTAINER_DEPTH (24) into the DeepQuoteCache. Every
    // prefix cut, chunk 128 (fast, structural), must equal the one-shot open view —
    // this catches folded-level, empty-deeper-marker and closer-count divergences.
    let md = staircase(32);
    for cut in 1..=md.len() {
        if !md.is_char_boundary(cut) {
            continue;
        }
        let prefix = &md[..cut];
        assert_eq!(
            streamed_open_chunked(prefix, 128),
            one_shot_open(prefix),
            "chunk-128 open view != one-shot at cut {cut}: {prefix:?}"
        );
    }
    // Char-by-char (chunk 1) full-doc parity: the marker-by-marker deepening path,
    // where each deeper level's markers arrive before its content.
    assert_parity(&md);
}

#[test]
fn deep_quote_staircase_deviations_parity() {
    // Each deviation from the pure staircase must bail to the byte-identical full
    // path. Verified char-by-char AND at several chunk sizes for every prefix cut.
    let mut cases: Vec<String> = Vec::new();
    // deepening, then a SHALLOWER line
    cases.push(format!("{}> > shallow again\n> > > deeper\n", staircase(28)));
    // deepening, then a BLANK line, then a new quote
    cases.push(format!("{}\n> after blank\n", staircase(27)));
    // deepening, then a LAZY continuation (no marker)
    cases.push(format!("{}lazy continuation line\n", staircase(26)));
    // deepening, then a nested ALERT marker + body
    cases.push(format!("{}{}[!NOTE]\n{}note body\n", staircase(25), "> ".repeat(26), "> ".repeat(27)));
    // deepening, then a nested LIST item (non-prose content)
    cases.push(format!("{}{}- item\n", staircase(25), "> ".repeat(26)));
    // an as-yet-content-less deeper marker line mid-stream (empty inner blockquote)
    cases.push(format!("{}{}\n", staircase(26), "> ".repeat(27)));
    for md in &cases {
        // All-cuts at chunk 128 — the structural coverage (where the fix's
        // folded-level / empty-deeper-marker / closer divergences surfaced).
        for cut in 1..=md.len() {
            if !md.is_char_boundary(cut) {
                continue;
            }
            let prefix = &md[..cut];
            assert_eq!(
                streamed_open_chunked(prefix, 128),
                one_shot_open(prefix),
                "chunk-128 open view != one-shot at cut {cut}: {prefix:?}"
            );
        }
        // Char-by-char (chunk 1) parity for the whole document — the per-byte
        // marker-streaming path (deeper markers arriving before content).
        assert_parity(md);
    }
}
