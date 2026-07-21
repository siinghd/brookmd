//! Wire delta mode (`WIRE.md` §11, opt-in via `set_wire_delta`): correctness
//! and golden pins.
//!
//! The load-bearing property is RECONSTRUCTION PARITY: a consumer that holds
//! the previous patch's `active` blocks and applies `html_delta` splices
//! (`html = prev[..keep] + append`) must recover byte-for-byte the same
//! `html` the parser holds internally — for every document shape, chunking,
//! and config. The parity harness below does exactly what a conforming
//! consumer does, driving reconstruction from the serialized JSON alone
//! (both by `keep_bytes` over UTF-8 and by `keep_units` over UTF-16, so both
//! published offsets are verified).
//!
//! Delta mode must also be a pure serialization overlay: parsing decisions,
//! block identity, and `allBlocks()` are identical with it on or off.

use brook_md_core::wire::{patch_to_json, WirePatch};
use brook_md_core::StreamParser;
use serde_json::Value;
use std::collections::HashMap;

/// A conforming consumer's active-region store: id → reconstructed html.
#[derive(Default)]
struct Consumer {
    active: HashMap<u64, String>,
}

impl Consumer {
    /// Apply one wire patch (as serialized JSON), reconstructing each active
    /// entry. Returns the active array as (id, html) in order.
    fn apply(&mut self, wire: &str) -> Vec<(u64, String)> {
        let v: Value = serde_json::from_str(wire).expect("wire JSON parses");
        let active = v["active"].as_array().expect("active array");
        let mut out = Vec::with_capacity(active.len());
        for entry in active {
            let id = entry["id"].as_u64().expect("id");
            let html = if let Some(full) = entry["html"].as_str() {
                assert!(entry.get("html_delta").is_none(), "html and html_delta are exclusive");
                full.to_string()
            } else {
                let d = &entry["html_delta"];
                let keep_bytes = d["keep_bytes"].as_u64().expect("keep_bytes") as usize;
                let keep_units = d["keep_units"].as_u64().expect("keep_units") as usize;
                let append = d["append"].as_str().expect("append");
                let prev = self
                    .active
                    .get(&id)
                    .unwrap_or_else(|| panic!("delta for id {id} without a previous emit"));
                // Reconstruct BOTH ways — byte-offset (native consumers) and
                // UTF-16-offset (JS/JVM consumers) — and require agreement.
                assert!(prev.is_char_boundary(keep_bytes), "keep_bytes on a char boundary");
                let by_bytes = format!("{}{}", &prev[..keep_bytes], append);
                let prev16: Vec<u16> = prev.encode_utf16().collect();
                assert!(keep_units <= prev16.len(), "keep_units within previous html");
                let mut units = prev16[..keep_units].to_vec();
                units.extend(append.encode_utf16());
                let by_units = String::from_utf16(&units).expect("utf16 splice is valid");
                assert_eq!(by_bytes, by_units, "keep_bytes and keep_units must agree");
                by_bytes
            };
            out.push((id, html));
        }
        self.active = out.iter().cloned().collect();
        out
    }
}

/// Stream `doc` in `chunk`-byte pieces (split on char boundaries) through a
/// delta-mode parser + a conforming consumer, asserting reconstruction parity
/// against the parser's own in-memory patch on every step. Also streams a
/// delta-OFF twin and asserts parsing is unaffected. Returns the number of
/// delta entries that actually fired (so callers can assert engagement).
fn assert_parity(doc: &str, chunk: usize, configure: impl Fn(&mut StreamParser)) -> usize {
    let mut on = StreamParser::new().with_wire_delta(true);
    let mut off = StreamParser::new();
    configure(&mut on);
    configure(&mut off);
    let mut consumer = Consumer::default();
    let mut fired = 0;

    let bytes = doc.as_bytes();
    let mut i = 0;
    let mut steps: Vec<(bool, usize, usize)> = Vec::new(); // (is_finalize, i, e)
    while i < bytes.len() {
        let mut e = (i + chunk).min(bytes.len());
        while e < bytes.len() && (bytes[e] & 0xC0) == 0x80 {
            e += 1;
        }
        steps.push((false, i, e));
        i = e;
    }
    steps.push((true, 0, 0));

    for (is_finalize, s, e) in steps {
        let (p_on, p_off) = if is_finalize {
            (on.finalize(), off.finalize())
        } else {
            (on.append(&doc[s..e]), off.append(&doc[s..e]))
        };
        // Delta mode is a serialization overlay: the working patches agree.
        assert_eq!(p_on.active.len(), p_off.active.len());
        for (a, b) in p_on.active.iter().zip(p_off.active.iter()) {
            assert_eq!(a.id, b.id);
            assert_eq!(a.html, b.html);
        }
        fired += p_on.active_deltas.iter().flatten().count();
        // Ground truth for the consumer: the parser's own active html.
        let truth: Vec<(u64, String)> =
            p_on.active.iter().map(|b| (b.id, b.html.clone())).collect();
        let wire = patch_to_json(&WirePatch::from(p_on));
        let rebuilt = consumer.apply(&wire);
        assert_eq!(rebuilt, truth, "reconstruction parity (chunk={chunk})");
    }
    // Parsing identity end-to-end.
    let all_on: Vec<_> = on.all_blocks().map(|b| (b.id, b.html.clone())).collect();
    let all_off: Vec<_> = off.all_blocks().map(|b| (b.id, b.html.clone())).collect();
    assert_eq!(all_on, all_off);
    fired
}

fn corpus() -> Vec<&'static str> {
    vec![
        // Growing flat list — the re-emit-floor headliner.
        "- item one with **bold** text\n- item two with `code` spans\n- item three plain\n- item four with a [link](https://example.com)\n- item five wraps it up\n",
        // One long open paragraph (no blank line) — grows every append.
        "this is one long explanatory paragraph that keeps growing and growing with more and more words until it is quite long indeed and still has no break anywhere in sight at all",
        // Late delimiter close: early bytes of the paragraph html CHANGE
        // mid-stream (the `*` pair resolves), forcing full re-emits.
        "*emphasis that stays open for a long while and only closes right at the very end of the stream*",
        // A fenced code block streamed line by line.
        "```rust\nfn main() {\n    let alpha = 1;\n    let beta = 2;\n    println!(\"{}\", alpha + beta);\n}\n```\n",
        // A GFM table growing row by row.
        "| Name | Value |\n| --- | --- |\n| alpha | 1 |\n| beta | 2 |\n| gamma | 3 |\n| delta | 4 |\n",
        // Blockquote with inner structure.
        "> quoted prose with **emphasis** inside\n> and a second line\n> and a third line that keeps going\n",
        // Multi-byte content: 2-, 3-, and 4-byte UTF-8 (é, →, 🎉) so keep
        // offsets land near non-ASCII and surrogate-pair boundaries.
        "- café résumé naïve 🎉 déjà-vu →\n- ünïcödé everywhere 🚀🚀🚀 here\n- ασδφ ελληνικά κείμενο 🎈 τέλος\n",
        // Paragraph that resolves into a setext heading (kind tag change → new
        // id → full re-emit of the new block).
        "becomes a heading\n=========\nthen a paragraph after it\n",
        // Speculative open link tail (pending `<a>` markup churns).
        "see [the docs](https://example.com/a/very/long/path/that/streams/in/slowly) for details\n",
    ]
}

#[test]
fn delta_reconstruction_parity() {
    let mut total_fired = 0;
    for doc in corpus() {
        for &chunk in &[1usize, 3, 7, 16, 64] {
            total_fired += assert_parity(doc, chunk, |_| {});
        }
    }
    // The mode must actually engage across the corpus, not vacuously pass.
    assert!(total_fired > 100, "deltas fired: {total_fired}");
}

#[test]
fn delta_reconstruction_parity_configured() {
    // The same corpus under the JS package's typical config surface.
    for doc in corpus() {
        for &chunk in &[3usize, 16] {
            assert_parity(doc, chunk, |p| {
                p.set_gfm_autolinks(true);
                p.set_gfm_alerts(true);
                p.set_gfm_math(true);
                p.set_gfm_footnotes(true);
                p.set_block_data(true);
            });
        }
    }
}

#[test]
fn default_wire_has_no_delta() {
    // Off by default: the serialized wire never contains html_delta, keeping
    // pre-delta consumers byte-compatible (the v1 goldens in
    // wire_envelope_golden.rs pin the exact bytes).
    let mut p = StreamParser::new();
    let mut wires: Vec<String> = Vec::new();
    for chunk in ["- one\n- two grows lo", "nger and longer here\n- three\n"] {
        wires.push(patch_to_json(&WirePatch::from(p.append(chunk))));
    }
    wires.push(patch_to_json(&WirePatch::from(p.finalize())));
    for w in wires {
        assert!(!w.contains("html_delta"), "delta leaked into default wire: {w}");
    }
}

// ── Golden pins (wire contract v1.2.0, delta mode ON) ───────────────────────
//
// A fixed two-chunk stream whose open paragraph exceeds the 64-byte minimum
// kept prefix, so append #2 MUST emit a delta and finalize MUST splice again.
// These strings are the exact wire bytes; changing them is a breaking change
// to the delta emission rule (MIN_KEEP_BYTES, envelope shape, field order).

const DELTA_CHUNK_0: &str = "A steady opening sentence that easily clears the minimum kept prefix";
const DELTA_CHUNK_1: &str = " and then keeps growing";

const DELTA_APPEND_0: &str = r#"{"newly_committed":[],"active":[{"id":0,"kind":{"type":"Paragraph"},"start":0,"end":68,"html":"<p>A steady opening sentence that easily clears the minimum kept prefix</p>","open":true,"speculative":true}]}"#;

const DELTA_APPEND_1: &str = r#"{"newly_committed":[],"active":[{"id":0,"kind":{"type":"Paragraph"},"start":0,"end":91,"html_delta":{"keep_bytes":71,"keep_units":71,"append":" and then keeps growing</p>"},"open":true,"speculative":true}]}"#;

// Finalize COMMITS the paragraph: committed blocks always carry full `html`
// (deltas are an active-array-only construct), so the one full emit at commit
// time is the block's O(n) floor — sent exactly once.
const DELTA_FINALIZE: &str = r#"{"newly_committed":[{"id":0,"kind":{"type":"Paragraph"},"start":0,"end":91,"html":"<p>A steady opening sentence that easily clears the minimum kept prefix and then keeps growing</p>","open":false,"speculative":false}],"active":[]}"#;

#[test]
fn delta_goldens() {
    let mut p = StreamParser::new().with_wire_delta(true);
    let w0 = patch_to_json(&WirePatch::from(p.append(DELTA_CHUNK_0)));
    let w1 = patch_to_json(&WirePatch::from(p.append(DELTA_CHUNK_1)));
    let wf = patch_to_json(&WirePatch::from(p.finalize()));
    assert_eq!(w0, DELTA_APPEND_0);
    assert_eq!(w1, DELTA_APPEND_1);
    assert_eq!(wf, DELTA_FINALIZE);
}

#[test]
fn delta_multibyte_offsets_differ() {
    // Non-ASCII before the splice point: keep_bytes (UTF-8) and keep_units
    // (UTF-16) must diverge and BOTH must reconstruct — the Consumer asserts
    // dual-route agreement internally.
    let mut p = StreamParser::new().with_wire_delta(true);
    let mut c = Consumer::default();
    let w0 = patch_to_json(&WirePatch::from(
        p.append("café 🎉 résumé and a long enough tail to clear the threshold"),
    ));
    c.apply(&w0);
    let patch = p.append(" plus growth");
    let d = patch.active_deltas[0].expect("delta fires");
    assert!(d.keep_bytes > d.keep_units, "🎉 is 4 UTF-8 bytes but 2 UTF-16 units");
    let truth = patch.active[0].html.clone();
    let w1 = patch_to_json(&WirePatch::from(patch));
    let rebuilt = c.apply(&w1);
    assert_eq!(rebuilt[0].1, truth);
}
