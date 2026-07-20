//! FFI-layer wire-contract goldens — proves [`FluxSession`] emits **byte-identical**
//! wire (WIRE.md v1.0.0) to `flux-md-core`'s WASM/JS boundary.
//!
//! The document, chunking, and golden strings below are copied verbatim from
//! `crates/flux-md-core/tests/wire_envelope_golden.rs` (crate 0.20.3). Provenance
//! matters: those goldens are captured against `StreamParser::new().with_block_data(bd)`
//! — pure library defaults (GFM autolinks/alerts OFF) plus the block-data toggle.
//! We reproduce that exact parser config here two ways: the bare
//! [`FluxSession::new`] (equivalent to `StreamParser::new()`), and
//! [`FluxSession::new_with_config`] with [`lib_default_config`] (every setter at
//! its library default). Both must yield the same bytes as the core goldens, or
//! the FFI layer has drifted from the contract.
//!
//! CHANGING ANY GOLDEN HERE IS A BREAKING WIRE CHANGE — see the core test's header.

use flux_md_ffi::{FluxConfig, FluxSession};

/// Fixed document, streamed in fixed chunks (verbatim from the core golden test).
const CHUNKS: [&str; 3] = [
    "# Title\n\nHello ",
    "world\n\n```rust\nlet x = 1;\n```\n\n",
    "| A | B |\n| - | - |\n| 1 | 2 |\n",
];

// ── block_data OFF (verbatim from crates/flux-md-core/tests/wire_envelope_golden.rs) ──
const OFF_APPEND_0: &str = r#"{"newly_committed":[{"id":0,"kind":{"type":"Heading","data":1},"start":0,"end":8,"html":"<h1>Title</h1>","open":false,"speculative":false}],"active":[{"id":1,"kind":{"type":"Paragraph"},"start":9,"end":15,"html":"<p>Hello</p>","open":true,"speculative":true}]}"#;
const OFF_APPEND_1: &str = r#"{"newly_committed":[{"id":1,"kind":{"type":"Paragraph"},"start":9,"end":21,"html":"<p>Hello world</p>","open":false,"speculative":false},{"id":2,"kind":{"type":"CodeBlock","data":{"lang":"rust"}},"start":22,"end":45,"html":"<pre><code class=\"language-rust\" data-lang=\"rust\">let x = 1;\n</code></pre>","open":false,"speculative":false}],"active":[]}"#;
const OFF_APPEND_2: &str = r#"{"newly_committed":[],"active":[{"id":3,"kind":{"type":"Table"},"start":46,"end":76,"html":"<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>","open":true,"speculative":true}]}"#;
const OFF_FINALIZE: &str = r#"{"newly_committed":[{"id":3,"kind":{"type":"Table"},"start":46,"end":76,"html":"<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>","open":false,"speculative":false}],"active":[]}"#;
const OFF_ALLBLOCKS: &str = r#"[{"id":0,"kind":{"type":"Heading","data":1},"start":0,"end":8,"html":"<h1>Title</h1>","open":false,"speculative":false},{"id":1,"kind":{"type":"Paragraph"},"start":9,"end":21,"html":"<p>Hello world</p>","open":false,"speculative":false},{"id":2,"kind":{"type":"CodeBlock","data":{"lang":"rust"}},"start":22,"end":45,"html":"<pre><code class=\"language-rust\" data-lang=\"rust\">let x = 1;\n</code></pre>","open":false,"speculative":false},{"id":3,"kind":{"type":"Table"},"start":46,"end":76,"html":"<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>","open":false,"speculative":false}]"#;

// ── block_data ON (verbatim from crates/flux-md-core/tests/wire_envelope_golden.rs) ──
const ON_APPEND_0: &str = r#"{"newly_committed":[{"id":0,"kind":{"type":"Heading","data":{"level":1,"text":"Title","id":"title"}},"start":0,"end":8,"html":"<h1>Title</h1>","open":false,"speculative":false}],"active":[{"id":1,"kind":{"type":"Paragraph"},"start":9,"end":15,"html":"<p>Hello</p>","open":true,"speculative":true}]}"#;
const ON_APPEND_1: &str = r#"{"newly_committed":[{"id":1,"kind":{"type":"Paragraph"},"start":9,"end":21,"html":"<p>Hello world</p>","open":false,"speculative":false},{"id":2,"kind":{"type":"CodeBlock","data":{"lang":"rust","code":"let x = 1;\n"}},"start":22,"end":45,"html":"<pre><code class=\"language-rust\" data-lang=\"rust\">let x = 1;\n</code></pre>","open":false,"speculative":false}],"active":[]}"#;
const ON_APPEND_2: &str = r#"{"newly_committed":[],"active":[{"id":3,"kind":{"type":"Table","data":{"headers":[{"text":"A","html":"A"},{"text":"B","html":"B"}],"rows":[[{"text":"1","html":"1"},{"text":"2","html":"2"}]],"aligns":[null,null]}},"start":46,"end":76,"html":"<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>","open":true,"speculative":true}]}"#;
const ON_FINALIZE: &str = r#"{"newly_committed":[{"id":3,"kind":{"type":"Table","data":{"headers":[{"text":"A","html":"A"},{"text":"B","html":"B"}],"rows":[[{"text":"1","html":"1"},{"text":"2","html":"2"}]],"aligns":[null,null]}},"start":46,"end":76,"html":"<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>","open":false,"speculative":false}],"active":[]}"#;

/// A [`FluxConfig`] with every setter at `StreamParser`'s *library* default
/// (autolinks/alerts off, sanitizer off, everything empty) plus the block-data
/// toggle — reproducing the exact parser the core goldens were captured against.
fn lib_default_config(block_data: bool) -> FluxConfig {
    FluxConfig {
        gfm_autolinks: false,
        gfm_alerts: false,
        gfm_tagfilter: false,
        gfm_footnotes: false,
        gfm_math: false,
        dir_auto: false,
        a11y: false,
        unsafe_html: false,
        component_tags: None,
        inline_component_tags: None,
        html_allowlist: None,
        drop_html_tags: None,
        block_data,
    }
}

/// Stream [`CHUNKS`] through a session, returning each append patch (in order)
/// followed by the finalize patch — the FFI analogue of the core test's `stream`.
fn stream(session: &FluxSession) -> Vec<String> {
    let mut out: Vec<String> = CHUNKS.iter().map(|c| session.append((*c).to_string())).collect();
    out.push(session.finalize());
    out
}

#[test]
fn golden_wire_default_bare() {
    // Bare `new()` == `StreamParser::new()` == the wasm `new FluxParser()`.
    let got = stream(&FluxSession::new());
    assert_eq!(got[0], OFF_APPEND_0, "append[0] wire drifted (contract v1.0.0)");
    assert_eq!(got[1], OFF_APPEND_1, "append[1] wire drifted (contract v1.0.0)");
    assert_eq!(got[2], OFF_APPEND_2, "append[2] wire drifted (contract v1.0.0)");
    assert_eq!(got[3], OFF_FINALIZE, "finalize wire drifted (contract v1.0.0)");
}

#[test]
fn golden_wire_default_via_config() {
    // The config path must be byte-exact too, with block data off.
    let got = stream(&FluxSession::new_with_config(lib_default_config(false)));
    assert_eq!(got[0], OFF_APPEND_0, "append[0] wire drifted via config (contract v1.0.0)");
    assert_eq!(got[1], OFF_APPEND_1, "append[1] wire drifted via config (contract v1.0.0)");
    assert_eq!(got[2], OFF_APPEND_2, "append[2] wire drifted via config (contract v1.0.0)");
    assert_eq!(got[3], OFF_FINALIZE, "finalize wire drifted via config (contract v1.0.0)");
}

#[test]
fn golden_wire_block_data() {
    let got = stream(&FluxSession::new_with_config(lib_default_config(true)));
    assert_eq!(got[0], ON_APPEND_0, "append[0] blockData wire drifted (contract v1.0.0)");
    assert_eq!(got[1], ON_APPEND_1, "append[1] blockData wire drifted (contract v1.0.0)");
    assert_eq!(got[2], ON_APPEND_2, "append[2] blockData wire drifted (contract v1.0.0)");
    assert_eq!(got[3], ON_FINALIZE, "finalize blockData wire drifted (contract v1.0.0)");
}

#[test]
fn golden_all_blocks_default() {
    let session = FluxSession::new();
    for c in CHUNKS {
        session.append(c.to_string());
    }
    session.finalize();
    assert_eq!(session.all_blocks(), OFF_ALLBLOCKS, "allBlocks wire drifted (contract v1.0.0)");
}

/// reset() rebuilds the parser (mirroring the JS worker's free-and-recreate per
/// stream), so block ids restart from 0. Proven the strong way: after a reset,
/// streaming a chunk produces bytes IDENTICAL to a brand-new session — which is
/// only possible if every piece of state (ids, buffer, offsets) reset to 0.
#[test]
fn reset_restarts_fresh_from_zero() {
    // Canonical output of a fresh parser for this chunk (heading committed as id 0).
    let fresh = FluxSession::new().append("# Two\n\n".to_string());
    assert!(fresh.contains(r#""id":0"#), "fresh session's first block should be id 0");

    let session = FluxSession::new();
    let _first = session.append("# One\n\n".to_string()); // id 0 committed
    let advanced = session.append("# Two\n\n".to_string()); // same instance → id advances to 1
    assert_ne!(
        advanced, fresh,
        "sanity: continuing the same session must NOT reproduce fresh output (ids advanced)"
    );

    session.reset();
    let after_reset = session.append("# Two\n\n".to_string());
    assert_eq!(
        after_reset, fresh,
        "after reset(), streaming a chunk must be byte-identical to a fresh session (ids from 0)"
    );
}

/// reset() must preserve the session's configuration (same as the JS worker,
/// which keeps the stream's config across a reset).
#[test]
fn reset_preserves_config() {
    let session = FluxSession::new_with_config(lib_default_config(true));
    let before = stream(&session);
    session.reset();
    let after = stream(&session);
    assert_eq!(before, after, "reset() must keep the block-data config (byte-identical re-run)");
    assert_eq!(after[0], ON_APPEND_0, "post-reset config still emits blockData wire");
}

/// Smoke: the memory/buffer metrics delegate to the core parser and track input.
#[test]
fn metrics_track_input() {
    let session = FluxSession::new();
    assert_eq!(session.buffer_len(), 0, "empty session has an empty buffer");
    session.append("# Title\n\n".to_string());
    assert_eq!(session.buffer_len(), 9, "buffer_len counts retained source bytes");
    assert!(session.retained_bytes() > 0, "retained_bytes includes buffer + rendered html");
    session.reset();
    assert_eq!(session.buffer_len(), 0, "reset() clears the buffer");
}
