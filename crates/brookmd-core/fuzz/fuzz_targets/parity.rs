//! Coverage-guided streaming-parity fuzzer.
//!
//! The invariant: the finalized document must not depend on how the byte stream
//! was chunked. For each input we render once whole and once per chunking and
//! assert they match — a mismatch is a streaming-commit bug (the class behind
//! the 0.18.x cliffs/flickers), and any panic is a crash. libFuzzer's coverage
//! feedback drives inputs into parser branches a combinatorial generator can't
//! reach; failures are auto-minimized.
//!
//!   cargo +nightly fuzz run parity
//!
//! Seed corpus lives in `fuzz/corpus/parity/` (plain markdown).

#![no_main]

use libfuzzer_sys::fuzz_target;

use brook_md_core::StreamParser;

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

fn streamed_final(md: &str, chunk: usize) -> String {
    let chars: Vec<char> = md.chars().collect();
    let mut p = make();
    let mut buf = String::new();
    let mut i = 0usize;
    while i < chars.len() {
        buf.clear();
        for _ in 0..chunk.max(1) {
            if i < chars.len() {
                buf.push(chars[i]);
                i += 1;
            }
        }
        p.append(&buf);
    }
    p.finalize();
    collect(&p)
}

/// Wire delta mode (`WIRE.md` §11) reconstruction parity: stream with
/// `wire_delta` on, apply each patch's `html_delta` splices the way a
/// conforming consumer does (over the previous emit of the same block id),
/// and assert the reconstruction matches the parser's own html on EVERY
/// patch. Any divergence, out-of-bounds keep, or non-char-boundary splice
/// asserts/panics — exactly the corruption class this mode must never have.
fn delta_reconstruction(md: &str, chunk: usize) {
    let chars: Vec<char> = md.chars().collect();
    let mut p = make().with_wire_delta(true);
    let mut prev: std::collections::HashMap<u64, String> = std::collections::HashMap::new();
    let mut buf = String::new();
    let mut i = 0usize;
    let mut step = |p: &mut StreamParser, buf: &str, finalize: bool| {
        let patch = if finalize { p.finalize() } else { p.append(buf) };
        let mut next: std::collections::HashMap<u64, String> = std::collections::HashMap::new();
        assert!(patch.active_deltas.len() == patch.active.len());
        for (b, d) in patch.active.iter().zip(patch.active_deltas.iter()) {
            let rebuilt = match d {
                None => b.html.clone(),
                Some(d) => {
                    let base = prev.get(&b.id).expect("delta base was emitted");
                    assert!(base.is_char_boundary(d.keep_bytes));
                    format!("{}{}", &base[..d.keep_bytes], &b.html[d.keep_bytes..])
                }
            };
            assert!(rebuilt == b.html, "delta reconstruction diverged (chunk={chunk})");
            next.insert(b.id, rebuilt);
        }
        prev = next;
    };
    while i < chars.len() {
        buf.clear();
        for _ in 0..chunk.max(1) {
            if i < chars.len() {
                buf.push(chars[i]);
                i += 1;
            }
        }
        step(&mut p, &buf, false);
    }
    step(&mut p, "", true);
}

/// True if the input could contain a link- or footnote-reference DEFINITION,
/// including a MULTI-LINE one (`[label` on one line, `]: dest` after later
/// lines). Reference resolution is document-global, so a definition can resolve
/// an earlier use (a forward reference), AND a label/definition that straddles
/// the commit boundary resolves differently depending on the chunk split — both
/// are chunk-dependent BY DESIGN (the documented streaming limitation). The
/// signature is a `[` followed somewhere by `]:`; we conservatively skip the
/// equality assertion for any such input (it still exercises no-panic). `]:` is
/// rare in ordinary prose, so equality is still checked on the vast majority.
fn has_ref_def(md: &str) -> bool {
    match md.find('[') {
        Some(open) => md[open..].contains("]:"),
        None => false,
    }
}

fuzz_target!(|data: &[u8]| {
    // Cap input size so a single case can't dominate the run; from_utf8_lossy
    // keeps arbitrary bytes valid (and exercises replacement-char handling).
    let md = String::from_utf8_lossy(&data[..data.len().min(16 * 1024)]);

    // No-panic invariant: holds for ALL inputs, including definitions.
    let oneshot = one_shot_final(&md);

    // Wire-delta reconstruction parity holds for ALL inputs too (it is a
    // per-patch property, chunk-dependence of the CONTENT is irrelevant).
    delta_reconstruction(&md, 1);
    delta_reconstruction(&md, 64);

    if has_ref_def(&md) {
        let _ = streamed_final(&md, 1);
        let _ = streamed_final(&md, 64);
        return;
    }

    // Chunk-independence: finalize must not depend on how bytes were split.
    for &chunk in &[1usize, 3, 7, 64] {
        let streamed = streamed_final(&md, chunk);
        assert!(
            streamed == oneshot,
            "chunk-split finalize diverged (chunk={chunk})\n--- one-shot ---\n{oneshot}\n--- streamed ---\n{streamed}\n--- input ---\n{md:?}"
        );
    }
});
