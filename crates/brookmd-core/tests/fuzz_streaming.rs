//! Randomized robustness net. Feeds many pseudo-random markdown-stressing
//! inputs through the streaming parser at random chunk boundaries (and one-shot)
//! under every feature config, asserting the two invariants that must hold for
//! *any* input, no matter where the stream is cut:
//!
//!   1. It never panics (malformed / partial / adversarial input degrades
//!      gracefully — the core streaming guarantee).
//!   2. The block list is always well-formed: ordered, non-overlapping, unique
//!      stable ids, `start <= end` — so the streaming UI never sees an orphan or
//!      duplicate block mid-stream.
//!
//! Deterministic (fixed seeds, zero-dep xorshift PRNG) so a failure reproduces.

use std::collections::HashSet;
use brook_md_core::StreamParser;

/// Zero-dep xorshift64 PRNG — deterministic, good enough to shuffle token soup.
struct Rng(u64);
impl Rng {
    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next_u64() % n as u64) as usize
    }
}

/// Tokens chosen to exercise every block/inline construct, fence delimiters,
/// nesting starters, GFM features, UTF-8 boundaries, and hard-break whitespace.
const TOKENS: &[&str] = &[
    "*", "**", "_", "~", "~~", "`", "``", "```", "$", "$$", "\\", "\\(", "\\)", "\\[", "\\]",
    "[", "]", "(", ")", "<", ">", "#", "##", "-", "+", "=", "|", "!", "\"", "'", "&", "&amp;",
    ";", ":", "/", "://", " ", "  ", "\t", "\n", "\n\n", "\r\n", "\r", "a", "Word", "Z9", "1.", "2)",
    "é", "中", "🚀", "[!NOTE]", "[!warning]", "[^1]", "[^1]:", "](http://x.com)", "www.example.com",
    "http://a.b/c", "foo@bar.example", "> ", "- [ ] ", "- [x] ", "![alt]", "{aligned}",
    "\\begin", "\\end", "&#58;", "javascript:", "<div>", "</div>", "<br/>", "x_n", "E=mc^2",
    // Footnote-resolver stressors: real refs, repeated labels, code spans + escaped
    // refs (must emit NO token → must not shift the occurrence count).
    "[^x]", "[^x]:", "[^y]", "`[^x]`", "\\[^x\\]", "\\[^x]",
];

fn random_doc(rng: &mut Rng) -> String {
    let n = 1 + rng.below(140);
    let mut s = String::with_capacity(n * 3);
    for _ in 0..n {
        s.push_str(TOKENS[rng.below(TOKENS.len())]);
    }
    s
}

/// Ordered, non-overlapping, unique ids, start<=end. Panics with the offending
/// block set on violation. Called after every append and at finalize.
fn check_invariants(p: &StreamParser, ctx: &str) {
    let mut last_end = 0usize;
    let mut ids = HashSet::new();
    for b in p.all_blocks() {
        assert!(b.start <= b.end, "start>end ({}, {}) [{ctx}]", b.start, b.end);
        assert!(b.start >= last_end, "overlap/disorder: start {} < prev end {} [{ctx}]", b.start, last_end);
        assert!(ids.insert(b.id), "duplicate block id {} [{ctx}]", b.id);
        last_end = b.end;
    }
}

fn configured(seed_bit: usize) -> StreamParser {
    // Cycle through feature combinations so the fuzz exercises each scanner path.
    StreamParser::new()
        .with_gfm_autolinks(seed_bit & 1 != 0)
        .with_gfm_alerts(seed_bit & 2 != 0)
        .with_gfm_footnotes(seed_bit & 4 != 0)
        .with_gfm_math(seed_bit & 8 != 0)
        .with_dir_auto(seed_bit & 16 != 0)
        .with_unsafe_html(seed_bit & 32 != 0)
}

#[test]
fn random_streaming_never_panics_and_blocks_stay_well_formed() {
    for seed in 1u64..=4000 {
        let mut rng = Rng(seed.wrapping_mul(0x9E3779B97F4A7C15) | 1);
        let doc = random_doc(&mut rng);
        let cfg = (seed as usize) & 63;

        // (a) Streamed in random char-boundary chunks; invariants after each append.
        let mut p = configured(cfg);
        let chars: Vec<char> = doc.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            let take = 1 + rng.below(12);
            let chunk: String = chars[i..(i + take).min(chars.len())].iter().collect();
            p.append(&chunk);
            check_invariants(&p, "streaming");
            i += take;
        }
        p.finalize();
        check_invariants(&p, "after finalize (streamed)");

        // (b) One-shot, same input — must also be well-formed and not panic.
        let mut q = configured(cfg);
        q.append(&doc);
        q.finalize();
        check_invariants(&q, "one-shot");
    }
}

/// Tokens for the footnote-streaming PARITY net. They stress the placeholder
/// resolver — real refs, repeated/distinct labels, code spans + escaped refs
/// (which emit NO ref token, so must not shift the occurrence count) — embedded
/// in cacheable block shapes (tables, lists, blockquotes, alerts, paragraphs).
///
/// Deliberately EXCLUDES bare `[^x]:` def-openers spliced mid-paragraph: those
/// trigger the INHERENT footnote-NUMBERING-order boundary (which `[^label]` gets
/// which `fn-N` when blocks commit incrementally vs. one-shot), a pre-existing
/// streaming limitation independent of the occurrence-id placeholder cache this
/// suite guards. Definitions appear only on their own lines (the supported shape).
/// Inline fragments for a single block's content — real refs (repeated + distinct
/// labels), code spans containing `[^x]` (emit NO ref → must not shift the
/// occurrence count), and ordinary text. Definitions live on their own lines.
const FN_INLINE: &[&str] = &[
    "[^x]", "[^y]", "[^z]", "[^x]", "`[^x]`", " word ", "é中", "**b**", "`c`", " ",
];

/// Build a random run of inline fragments for one block's cell/item/line.
fn fn_inline(rng: &mut Rng) -> String {
    let n = 1 + rng.below(6);
    let mut s = String::new();
    for _ in 0..n {
        s.push_str(FN_INLINE[rng.below(FN_INLINE.len())]);
    }
    s
}

/// A random footnote-stressing document built as a sequence of SELF-CONTAINED,
/// blank-line-separated single-block sections (paragraph / table / list /
/// blockquote / alert), each filled with footnote refs, plus their definitions.
///
/// Keeping each block self-contained (one block type per blank-delimited section)
/// stresses the placeholder resolver across every cacheable block shape and every
/// chunk split, while avoiding the orthogonal, pre-existing streaming block-
/// BOUNDARY quirks (e.g. how an open list/table/alert/math run merges or splits
/// across a partial line) that are unrelated to footnote-id resolution. A warm-up
/// line numbers every label up front so no block ever commits a ref to a not-yet-
/// numbered label (the inherent forward-reference numbering boundary, also out of
/// scope and identical in every parser path).
fn random_fn_doc(rng: &mut Rng) -> String {
    let blocks = 1 + rng.below(14);
    let mut s = String::from("warm [^x] [^y] [^z]\n\n");
    for _ in 0..blocks {
        match rng.below(6) {
            0 => {
                // Paragraph.
                s.push_str(&fn_inline(rng));
                s.push('\n');
            }
            1 => {
                // Two-column table with a few rows.
                s.push_str("| a | b |\n| - | - |\n");
                for _ in 0..(1 + rng.below(4)) {
                    s.push_str("| ");
                    s.push_str(&fn_inline(rng));
                    s.push_str(" | ");
                    s.push_str(&fn_inline(rng));
                    s.push_str(" |\n");
                }
            }
            2 => {
                // List (bullet or ordered).
                let ordered = rng.below(2) == 0;
                for _ in 0..(1 + rng.below(4)) {
                    s.push_str(if ordered { "1. " } else { "- " });
                    s.push_str(&fn_inline(rng));
                    s.push('\n');
                }
            }
            3 => {
                // Blockquote (one or two paragraphs).
                s.push_str("> ");
                s.push_str(&fn_inline(rng));
                s.push('\n');
                if rng.below(2) == 0 {
                    s.push_str(">\n> ");
                    s.push_str(&fn_inline(rng));
                    s.push('\n');
                }
            }
            4 => {
                // Alert.
                s.push_str("> [!NOTE]\n> ");
                s.push_str(&fn_inline(rng));
                s.push('\n');
            }
            _ => {
                // A footnote definition block. Its body is plain text (no ref):
                // a def-body `[^x]` ref's OCCURRENCE index is assigned at the
                // def's render time, which is commit-time when streamed vs.
                // finalize-time when one-shot — a pre-existing, footnote-streaming
                // numbering boundary independent of the placeholder cache and out
                // of scope here (the controlled `footnote_cache::def_body_*` tests
                // cover def bodies with refs at safe baselines).
                let label = ["x", "y", "z"][rng.below(3)];
                s.push_str(&format!("[^{label}]: def {label} plain body\n"));
            }
        }
        s.push('\n'); // blank line separates blocks
    }
    s
}

/// Footnote-streaming PARITY net. With `gfm_footnotes` on (and a mix of the
/// other GFM features), the streamed output (committed blocks + finalize section)
/// must be BYTE-IDENTICAL to the one-shot render, for any input cut anywhere —
/// the property the placeholder-token cache must preserve. Also asserts the
/// resolver leaves NO control-char tokens (`\u{0}`/`\u{1}`) in the output, which
/// would mean a token escaped resolution / got corrupted across a split.
#[test]
fn random_footnote_streaming_matches_oneshot() {
    fn collect(p: &StreamParser) -> String {
        let mut out = String::new();
        for b in p.all_blocks() {
            out.push_str(&b.html);
        }
        out
    }
    fn fn_configured(seed_bit: usize) -> StreamParser {
        // Footnotes always ON; vary the rest so resolution interacts with alerts,
        // autolinks, raw HTML, bidi, and the structured data channel. `gfm_math`
        // is intentionally NOT toggled here: an unterminated `$$` display-math
        // block has its own pre-existing streaming/paragraph-split boundary that
        // is independent of footnote resolution, and would mask the property this
        // suite isolates (footnote id parity).
        StreamParser::new()
            .with_gfm_footnotes(true)
            .with_gfm_autolinks(seed_bit & 1 != 0)
            .with_gfm_alerts(seed_bit & 2 != 0)
            .with_dir_auto(seed_bit & 16 != 0)
            .with_unsafe_html(seed_bit & 32 != 0)
            .with_block_data(seed_bit & 64 != 0)
    }
    for seed in 1u64..=4000 {
        let mut rng = Rng(seed.wrapping_mul(0x9E3779B97F4A7C15) | 1);
        let doc = random_fn_doc(&mut rng);
        let cfg = seed as usize;

        // Streamed in random char-boundary chunks.
        let mut p = fn_configured(cfg);
        let chars: Vec<char> = doc.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            let take = 1 + rng.below(12);
            let chunk: String = chars[i..(i + take).min(chars.len())].iter().collect();
            p.append(&chunk);
            check_invariants(&p, "fn streaming");
            i += take;
        }
        p.finalize();
        let streamed = collect(&p);

        // One-shot, same input + same config.
        let mut q = fn_configured(cfg);
        q.append(&doc);
        q.finalize();
        let one_shot = collect(&q);

        assert_eq!(
            streamed, one_shot,
            "footnote streamed != one-shot (seed {seed}, cfg {cfg})\ndoc: {doc:?}\n--- streamed ---\n{streamed}\n--- one-shot ---\n{one_shot}"
        );
        // No placeholder tokens may survive into either output.
        assert!(
            !streamed.contains('\u{0}') && !streamed.contains('\u{1}'),
            "stray footnote token in streamed output (seed {seed}): {streamed:?}"
        );
        assert!(
            !one_shot.contains('\u{0}') && !one_shot.contains('\u{1}'),
            "stray footnote token in one-shot output (seed {seed}): {one_shot:?}"
        );
    }
}

#[test]
fn single_byte_chunks_never_panic() {
    // The most demanding cut: one byte at a time (UTF-8-safe by char), every
    // construct half-formed at some prefix. Smaller corpus, all features on.
    for seed in 1u64..=600 {
        let mut rng = Rng(seed.wrapping_mul(0xD1B54A32D192ED03) | 1);
        let doc = random_doc(&mut rng);
        let mut p = configured(63);
        let mut buf = [0u8; 4];
        for ch in doc.chars() {
            p.append(ch.encode_utf8(&mut buf));
            check_invariants(&p, "1-char streaming");
        }
        p.finalize();
        check_invariants(&p, "1-char finalize");
    }
}
