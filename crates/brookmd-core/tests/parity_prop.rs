//! Property-based parity tests (proptest) with automatic shrinking.
//!
//! The hand-written `*_parity.rs` suites pin specific shapes; this generates
//! thousands and shrinks any failure to a minimal reproducer. The core property
//! is **chunk-independence of finalize**: the finalized document must not depend
//! on how the byte stream was split. That is an unconditional invariant (unlike
//! mid-stream prefix-parity, which has documented boundary-lag exceptions), so
//! it fuzzes cleanly without false positives, and a violation is exactly the
//! streaming-commit bug class we have fixed by hand (0.18.0/0.18.2/0.18.3/0.18.4).
//!
//! Runs on stable in the normal `cargo test --release` job.

use brook_md_core::StreamParser;
use proptest::prelude::*;

fn make() -> StreamParser {
    StreamParser::new()
        .with_gfm_autolinks(true)
        .with_gfm_alerts(true)
        .with_gfm_math(true)
}

fn collect(p: &StreamParser) -> String {
    let mut out = String::new();
    for b in p.all_blocks() {
        out.push_str(&b.html);
    }
    out
}

fn one_shot_final(md: &str) -> String {
    let mut p = make();
    p.append(md);
    p.finalize();
    collect(&p)
}

/// Stream `md` split into char-chunks per `sizes` (cycled), then finalize.
fn streamed_final(md: &str, sizes: &[usize]) -> String {
    let chars: Vec<char> = md.chars().collect();
    let mut p = make();
    let mut idx = 0usize;
    let mut si = 0usize;
    let mut buf = String::new();
    while idx < chars.len() {
        let n = sizes.get(si % sizes.len().max(1)).copied().unwrap_or(1).max(1);
        si += 1;
        buf.clear();
        for _ in 0..n {
            if idx < chars.len() {
                buf.push(chars[idx]);
                idx += 1;
            }
        }
        p.append(&buf);
    }
    p.finalize();
    collect(&p)
}

// Building blocks that exercise distinct parser paths. Adjacent snippets are
// joined by a random separator (lazy "\n" vs hard "\n\n"), which is exactly the
// construct-interaction surface that surfaced the container/list flicker bugs.
const SNIPPETS: &[&str] = &[
    "# ATX heading",
    "Setext title\n===========",
    "Setext sub\n----------",
    "plain paragraph text with words",
    "**bold** and *italic* and `code` and ~~strike~~",
    "- bullet one\n- bullet two",
    "- outer\n  - nested a\n  - nested b",
    "1. ordered one\n2. ordered two",
    "5. ordered start five\n6. six",
    "> a blockquote line",
    "> > nested blockquote",
    "> [!NOTE]\n> alert body",
    "> [!TIP]\n> - list in alert",
    "```rust\nfn main() {}\n```",
    "    indented code block",
    "| a | b |\n| - | - |\n| 1 | 2 |",
    "---",
    // No reference/footnote DEFINITIONS in this strategy: reference resolution
    // is document-global, so any definition can resolve an earlier use (a
    // forward reference) — the documented streaming limitation, where
    // chunk-independence legitimately does not hold. Inline links/images/
    // autolinks below are self-contained and resolve immediately, so they keep
    // the property a true invariant.
    "a [inline](https://example.com) link",
    "an ![image](https://example.com/i.png)",
    "bare https://example.org/x autolink",
    "text with &amp; entity and \\* escape",
    "$x^2 + y^2$ inline math",
    "$$\nE = mc^2\n$$",
    "\\(a + b\\) latex inline",
    "<div>raw html block</div>",
    "<!-- a comment -->",
    "trailing spaces  \nhard break",
    "* \t \nweird whitespace",
];

prop_compose! {
    fn doc_strategy()(
        parts in prop::collection::vec(prop::sample::select(SNIPPETS), 1..7),
        seps in prop::collection::vec(prop::sample::select(&["\n", "\n\n"][..]), 1..7),
    ) -> String {
        let mut s = String::new();
        for (i, part) in parts.iter().enumerate() {
            if i > 0 {
                s.push_str(seps[(i - 1) % seps.len()]);
            }
            s.push_str(part);
        }
        s
    }
}

fn chunk_sizes() -> impl Strategy<Value = Vec<usize>> {
    prop::collection::vec(1usize..16, 1..8)
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 600, max_shrink_iters: 4000, ..ProptestConfig::default() })]

    /// Realistic construct-built docs: finalize is independent of chunk splits.
    #[test]
    fn finalize_chunk_independent_constructs(doc in doc_strategy(), sizes in chunk_sizes()) {
        let one = one_shot_final(&doc);
        let streamed = streamed_final(&doc, &sizes);
        prop_assert_eq!(&streamed, &one, "chunk-split finalize diverged for {:?} (sizes {:?})", doc, sizes);
    }

    /// Adversarial: arbitrary unicode text must never panic, under any chunking
    /// or one-shot. (Equality is NOT asserted here — random text can form a
    /// forward reference, whose streamed/one-shot divergence is the documented
    /// limitation; the equality invariant is covered by the construct tests
    /// above, which exclude forward refs by construction.)
    #[test]
    fn finalize_no_panic_arbitrary(doc in ".{0,400}", sizes in chunk_sizes()) {
        let _ = one_shot_final(&doc);
        let _ = streamed_final(&doc, &sizes);
        let _ = streamed_final(&doc, &[1]);
    }

    /// Char-by-char streaming (the worst case) also finalizes identically.
    #[test]
    fn finalize_char_by_char(doc in doc_strategy()) {
        let one = one_shot_final(&doc);
        let streamed = streamed_final(&doc, &[1]);
        prop_assert_eq!(&streamed, &one, "char-by-char finalize diverged for {:?}", doc);
    }

    /// CRLF twin of every construct doc: line endings are normalized at ingest,
    /// so the CRLF document must finalize byte-identical to its LF twin — one-
    /// shot, under random chunk splits, and char-by-char (which cuts every
    /// `\r|\n` pair across two appends, the pending-`\r` hold-back path).
    #[test]
    fn finalize_crlf_chunk_independent(doc in doc_strategy(), sizes in chunk_sizes()) {
        let crlf = doc.replace('\n', "\r\n");
        let one_lf = one_shot_final(&doc);
        let one_crlf = one_shot_final(&crlf);
        prop_assert_eq!(&one_crlf, &one_lf, "one-shot CRLF != LF for {:?}", doc);
        let streamed = streamed_final(&crlf, &sizes);
        prop_assert_eq!(&streamed, &one_lf, "chunk-split CRLF finalize diverged for {:?} (sizes {:?})", doc, sizes);
        let char_by_char = streamed_final(&crlf, &[1]);
        prop_assert_eq!(&char_by_char, &one_lf, "char-by-char CRLF finalize diverged for {:?}", doc);
    }
}
