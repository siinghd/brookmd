//! Robustness fuzz/stress harness. The library exists because malformed
//! markdown streamed concurrently crashed the user's previous parser, so the
//! non-negotiable property is: **never panic, for any input, at any chunk
//! boundary**, and parse deterministically. We generate thousands of pseudo
//! random markdown-ish inputs (seeded, so failures reproduce) and feed each
//! through several chunkings.

use brook_md_core::StreamParser;

/// Tiny deterministic PRNG (xorshift64) — no external crates.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

/// Characters weighted toward markdown structure, with some Unicode and the
/// adversarial constructs (unbalanced brackets/emphasis, stray fences, tabs).
const ALPHABET: &[&str] = &[
    "a", "b", "x", " ", " ", "\n", "\n", "\t", "#", "##", "*", "**", "_", "~", "~~", "`", "```",
    "[", "]", "(", ")", "!", ">", "- ", "1. ", "|", "---", ":", "\\", "<", ">", "<a>", "</a>",
    "http://x.co/", "www.y.io", "foo@b.co", "&amp;", "&#123;", "é", "→", "🚀", "\r\n",
];

fn random_doc(rng: &mut Rng, max_tokens: usize) -> String {
    let n = 1 + rng.below(max_tokens);
    let mut s = String::new();
    for _ in 0..n {
        s.push_str(ALPHABET[rng.below(ALPHABET.len())]);
    }
    s
}

fn parse_oneshot(src: &str) -> String {
    let mut p = StreamParser::new().with_unsafe_html(true).with_gfm_autolinks(true);
    p.append(src);
    p.finalize();
    let mut out = String::new();
    for b in p.all_blocks() {
        out.push_str(&b.html);
    }
    out
}

/// Feed `src` in chunks of (roughly) `chunk` bytes, always on UTF-8 char
/// boundaries, and return the finalized document.
fn parse_chunked(src: &str, chunk: usize) -> String {
    let mut p = StreamParser::new().with_unsafe_html(true).with_gfm_autolinks(true);
    let bytes = src.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let mut end = (i + chunk.max(1)).min(bytes.len());
        while end < bytes.len() && (bytes[end] & 0b1100_0000) == 0b1000_0000 {
            end += 1;
        }
        p.append(&src[i..end]);
        i = end;
    }
    p.finalize();
    let mut out = String::new();
    for b in p.all_blocks() {
        out.push_str(&b.html);
    }
    out
}

#[test]
fn fuzz_never_panics_and_is_deterministic() {
    let mut rng = Rng(0x9E3779B97F4A7C15);
    let iterations = 5000;
    for it in 0..iterations {
        let src = random_doc(&mut rng, 60);
        // 1. One-shot parse must not panic, and must be deterministic.
        let a = parse_oneshot(&src);
        let b = parse_oneshot(&src);
        assert_eq!(a, b, "non-deterministic parse (iter {it}) for {src:?}");
        // 2. Several chunkings must not panic. (We don't require byte-equality
        //    with one-shot — forward references and commit boundaries can
        //    legitimately differ — only that nothing crashes and output is
        //    well-formed enough to be a String.)
        for &chunk in &[1usize, 3, 7, 64] {
            let _ = parse_chunked(&src, chunk);
        }
    }
}

/// Pathological fixed inputs that have historically broken markdown parsers.
#[test]
fn fuzz_pathological_fixtures_never_panic() {
    let cases = [
        "".to_string(),
        "\n".repeat(1000),
        "*".repeat(1000),
        "[".repeat(500),
        "> ".repeat(500),
        "#".repeat(500),
        "`".repeat(500),
        "- ".repeat(500),
        "|".repeat(500) + "\n" + &"|".repeat(500),
        "```".to_string() + &"\n".repeat(100),
        "[a](".to_string() + &"b".repeat(1000),
        "\t".repeat(200) + "code",
        "~~~".to_string() + &"x".repeat(1000),
        format!("{}{}", "<div>".repeat(100), "</div>".repeat(50)),
    ];
    for src in &cases {
        let _ = parse_oneshot(src);
        // Small chunks only on bounded inputs; a single giant unbroken block
        // re-parses its (uncommitted) tail per append, so feed the big one
        // one-shot — the property under test is "no panic", not throughput.
        for &chunk in &[1usize, 5, 100] {
            let _ = parse_chunked(src, chunk);
        }
    }
    // Large single block: one-shot + coarse chunking only (avoid O(n²) churn).
    let big = "a".repeat(200_000);
    let _ = parse_oneshot(&big);
    let _ = parse_chunked(&big, 4096);
}
