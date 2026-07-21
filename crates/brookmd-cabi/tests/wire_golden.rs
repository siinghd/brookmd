//! C-ABI wire-contract goldens — proves the `extern "C"` surface emits
//! **byte-identical** wire (WIRE.md v1.2.0; default shape byte-identical to v1.1.0) to `brookmd-core`'s WASM/JS boundary
//! and to `brookmd-ffi`'s uniffi layer.
//!
//! The document, chunking, and golden strings are copied verbatim from
//! `crates/brookmd-ffi/tests/wire_golden.rs` (which copied them from
//! `crates/brookmd-core/tests/wire_envelope_golden.rs`, crate 0.20.3). Those
//! goldens are captured against `StreamParser::new().with_block_data(bd)` — pure
//! library defaults (GFM autolinks/alerts OFF) plus the block-data toggle. We
//! reproduce that exact config two ways: the bare `brook_session_new` (equivalent
//! to `StreamParser::new()`), and `brook_session_new_with_config` with a JSON
//! config that pins every setter at its library default. Both must yield the same
//! bytes as the core goldens, or the C-ABI layer has drifted from the contract.
//!
//! CHANGING ANY GOLDEN HERE IS A BREAKING WIRE CHANGE — see the core test's header.

use std::ffi::{c_char, CStr, CString};

use brook_md_cabi::{
    brook_session_all_blocks, brook_session_append, brook_session_buffer_len, brook_session_finalize,
    brook_session_free, brook_session_new, brook_session_new_with_config, brook_session_reset,
    brook_session_retained_bytes, brook_string_free, brook_wire_version, BrookSession,
};

/// Fixed document, streamed in fixed chunks (verbatim from the core golden test).
const CHUNKS: [&str; 3] = [
    "# Title\n\nHello ",
    "world\n\n```rust\nlet x = 1;\n```\n\n",
    "| A | B |\n| - | - |\n| 1 | 2 |\n",
];

// ── block_data OFF (verbatim from crates/brookmd-core/tests/wire_envelope_golden.rs) ──
const OFF_APPEND_0: &str = r#"{"newly_committed":[{"id":0,"kind":{"type":"Heading","data":1},"start":0,"end":8,"html":"<h1>Title</h1>","open":false,"speculative":false}],"active":[{"id":1,"kind":{"type":"Paragraph"},"start":9,"end":15,"html":"<p>Hello</p>","open":true,"speculative":true}]}"#;
const OFF_APPEND_1: &str = r#"{"newly_committed":[{"id":1,"kind":{"type":"Paragraph"},"start":9,"end":21,"html":"<p>Hello world</p>","open":false,"speculative":false},{"id":2,"kind":{"type":"CodeBlock","data":{"lang":"rust"}},"start":22,"end":45,"html":"<pre><code class=\"language-rust\" data-lang=\"rust\">let x = 1;\n</code></pre>","open":false,"speculative":false}],"active":[]}"#;
const OFF_APPEND_2: &str = r#"{"newly_committed":[],"active":[{"id":3,"kind":{"type":"Table"},"start":46,"end":76,"html":"<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>","open":true,"speculative":true}]}"#;
const OFF_FINALIZE: &str = r#"{"newly_committed":[{"id":3,"kind":{"type":"Table"},"start":46,"end":76,"html":"<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>","open":false,"speculative":false}],"active":[]}"#;
const OFF_ALLBLOCKS: &str = r#"[{"id":0,"kind":{"type":"Heading","data":1},"start":0,"end":8,"html":"<h1>Title</h1>","open":false,"speculative":false},{"id":1,"kind":{"type":"Paragraph"},"start":9,"end":21,"html":"<p>Hello world</p>","open":false,"speculative":false},{"id":2,"kind":{"type":"CodeBlock","data":{"lang":"rust"}},"start":22,"end":45,"html":"<pre><code class=\"language-rust\" data-lang=\"rust\">let x = 1;\n</code></pre>","open":false,"speculative":false},{"id":3,"kind":{"type":"Table"},"start":46,"end":76,"html":"<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>","open":false,"speculative":false}]"#;

// ── block_data ON (verbatim from crates/brookmd-core/tests/wire_envelope_golden.rs) ──
const ON_APPEND_0: &str = r#"{"newly_committed":[{"id":0,"kind":{"type":"Heading","data":{"level":1,"text":"Title","id":"title"}},"start":0,"end":8,"html":"<h1>Title</h1>","open":false,"speculative":false}],"active":[{"id":1,"kind":{"type":"Paragraph"},"start":9,"end":15,"html":"<p>Hello</p>","open":true,"speculative":true}]}"#;
const ON_APPEND_1: &str = r#"{"newly_committed":[{"id":1,"kind":{"type":"Paragraph"},"start":9,"end":21,"html":"<p>Hello world</p>","open":false,"speculative":false},{"id":2,"kind":{"type":"CodeBlock","data":{"lang":"rust","code":"let x = 1;\n"}},"start":22,"end":45,"html":"<pre><code class=\"language-rust\" data-lang=\"rust\">let x = 1;\n</code></pre>","open":false,"speculative":false}],"active":[]}"#;
const ON_APPEND_2: &str = r#"{"newly_committed":[],"active":[{"id":3,"kind":{"type":"Table","data":{"headers":[{"text":"A","html":"A"},{"text":"B","html":"B"}],"rows":[[{"text":"1","html":"1"},{"text":"2","html":"2"}]],"aligns":[null,null]}},"start":46,"end":76,"html":"<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>","open":true,"speculative":true}]}"#;
const ON_FINALIZE: &str = r#"{"newly_committed":[{"id":3,"kind":{"type":"Table","data":{"headers":[{"text":"A","html":"A"},{"text":"B","html":"B"}],"rows":[[{"text":"1","html":"1"},{"text":"2","html":"2"}]],"aligns":[null,null]}},"start":46,"end":76,"html":"<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>","open":false,"speculative":false}],"active":[]}"#;

/// JSON config pinning every setter at `StreamParser`'s *library* default
/// (autolinks/alerts off, sanitizer off, everything empty) plus the block-data
/// toggle — reproducing the exact parser the core goldens were captured against.
/// (The C-ABI default constructor uses these same values; the config path must be
/// byte-exact too.)
fn lib_default_config_json(block_data: bool) -> CString {
    CString::new(format!(
        r#"{{"gfm_autolinks":false,"gfm_alerts":false,"gfm_tagfilter":false,"gfm_footnotes":false,"gfm_math":false,"dir_auto":false,"a11y":false,"unsafe_html":false,"block_data":{block_data}}}"#
    ))
    .expect("config JSON has no interior NUL")
}

/// Take ownership of a C string returned by an export, copy it to an owned Rust
/// `String`, and free it with `brook_string_free` (the correct deallocator). Panics
/// if the pointer is NULL — every call site here expects success.
fn take_string(ptr: *mut c_char) -> String {
    assert!(!ptr.is_null(), "export returned NULL where a string was expected");
    // SAFETY: `ptr` is a live, NUL-terminated UTF-8 C string from this crate.
    let owned = unsafe { CStr::from_ptr(ptr) }.to_str().expect("wire is UTF-8").to_owned();
    brook_string_free(ptr);
    owned
}

/// Append a `&str` chunk through the length-based C export.
fn append(s: *mut BrookSession, chunk: &str) -> String {
    take_string(brook_session_append(s, chunk.as_ptr(), chunk.len()))
}

/// Stream [`CHUNKS`] through a session, returning each append patch (in order)
/// followed by the finalize patch.
fn stream(s: *mut BrookSession) -> Vec<String> {
    let mut out: Vec<String> = CHUNKS.iter().map(|c| append(s, c)).collect();
    out.push(take_string(brook_session_finalize(s)));
    out
}

#[test]
fn golden_wire_default_bare() {
    // Bare `brook_session_new` == `StreamParser::new()` == the wasm `new BrookParser()`.
    let s = brook_session_new();
    let got = stream(s);
    assert_eq!(got[0], OFF_APPEND_0, "append[0] wire drifted (contract v1.1.0)");
    assert_eq!(got[1], OFF_APPEND_1, "append[1] wire drifted (contract v1.1.0)");
    assert_eq!(got[2], OFF_APPEND_2, "append[2] wire drifted (contract v1.1.0)");
    assert_eq!(got[3], OFF_FINALIZE, "finalize wire drifted (contract v1.1.0)");
    brook_session_free(s);
}

#[test]
fn golden_wire_default_via_config() {
    // The JSON-config path must be byte-exact too, with block data off.
    let cfg = lib_default_config_json(false);
    let s = brook_session_new_with_config(cfg.as_ptr());
    assert!(!s.is_null(), "valid config JSON must construct a session");
    let got = stream(s);
    assert_eq!(got[0], OFF_APPEND_0, "append[0] wire drifted via config (contract v1.1.0)");
    assert_eq!(got[1], OFF_APPEND_1, "append[1] wire drifted via config (contract v1.1.0)");
    assert_eq!(got[2], OFF_APPEND_2, "append[2] wire drifted via config (contract v1.1.0)");
    assert_eq!(got[3], OFF_FINALIZE, "finalize wire drifted via config (contract v1.1.0)");
    brook_session_free(s);
}

// ── Wire delta mode ON (WIRE.md §11, contract v1.2.0) ───────────────────────
// Goldens copied verbatim from `crates/brookmd-core/tests/wire_delta.rs`
// (`delta_goldens`): the same bytes MUST come out of the C-ABI JSON-config path.

const DELTA_CHUNK_0: &str = "A steady opening sentence that easily clears the minimum kept prefix";
const DELTA_CHUNK_1: &str = " and then keeps growing";

const DELTA_APPEND_0: &str = r#"{"newly_committed":[],"active":[{"id":0,"kind":{"type":"Paragraph"},"start":0,"end":68,"html":"<p>A steady opening sentence that easily clears the minimum kept prefix</p>","open":true,"speculative":true}]}"#;
const DELTA_APPEND_1: &str = r#"{"newly_committed":[],"active":[{"id":0,"kind":{"type":"Paragraph"},"start":0,"end":91,"html_delta":{"keep_bytes":71,"keep_units":71,"append":" and then keeps growing</p>"},"open":true,"speculative":true}]}"#;
const DELTA_FINALIZE: &str = r#"{"newly_committed":[{"id":0,"kind":{"type":"Paragraph"},"start":0,"end":91,"html":"<p>A steady opening sentence that easily clears the minimum kept prefix and then keeps growing</p>","open":false,"speculative":false}],"active":[]}"#;

#[test]
fn golden_wire_delta_mode() {
    let cfg = CString::new(
        r#"{"gfm_autolinks":false,"gfm_alerts":false,"wire_delta":true}"#,
    )
    .expect("no interior NUL");
    let s = brook_session_new_with_config(cfg.as_ptr());
    assert!(!s.is_null(), "valid config JSON must construct a session");
    let a0 = append(s, DELTA_CHUNK_0);
    let a1 = append(s, DELTA_CHUNK_1);
    let f = take_string(brook_session_finalize(s));
    assert_eq!(a0, DELTA_APPEND_0, "delta append[0] wire drifted (contract v1.2.0)");
    assert_eq!(a1, DELTA_APPEND_1, "delta append[1] wire drifted (contract v1.2.0)");
    assert_eq!(f, DELTA_FINALIZE, "delta finalize wire drifted (contract v1.2.0)");
    brook_session_free(s);
}

#[test]
fn wire_delta_default_off() {
    // The config default keeps the v1 wire: no html_delta anywhere.
    let s = brook_session_new();
    for w in stream(s) {
        assert!(!w.contains("html_delta"), "delta leaked into default cabi wire: {w}");
    }
    brook_session_free(s);
}

#[test]
fn golden_wire_block_data() {
    let cfg = lib_default_config_json(true);
    let s = brook_session_new_with_config(cfg.as_ptr());
    assert!(!s.is_null(), "valid config JSON must construct a session");
    let got = stream(s);
    assert_eq!(got[0], ON_APPEND_0, "append[0] blockData wire drifted (contract v1.1.0)");
    assert_eq!(got[1], ON_APPEND_1, "append[1] blockData wire drifted (contract v1.1.0)");
    assert_eq!(got[2], ON_APPEND_2, "append[2] blockData wire drifted (contract v1.1.0)");
    assert_eq!(got[3], ON_FINALIZE, "finalize blockData wire drifted (contract v1.1.0)");
    brook_session_free(s);
}

#[test]
fn golden_all_blocks_default() {
    let s = brook_session_new();
    for c in CHUNKS {
        // Drop each patch; we only assert the whole-document read below.
        brook_string_free(brook_session_append(s, c.as_ptr(), c.len()));
    }
    brook_string_free(brook_session_finalize(s));
    assert_eq!(
        take_string(brook_session_all_blocks(s)),
        OFF_ALLBLOCKS,
        "allBlocks wire drifted (contract v1.1.0)"
    );
    brook_session_free(s);
}

/// A JSON config with `{}` (all keys omitted) must take the documented defaults —
/// GFM autolinks + alerts ON. Pinned via the wire: a bare autolink is linkified.
#[test]
fn empty_config_uses_documented_defaults() {
    let cfg = CString::new("{}").unwrap();
    let s = brook_session_new_with_config(cfg.as_ptr());
    assert!(!s.is_null());
    let patch = append(s, "see https://example.com\n\n");
    // The wire is JSON, so the anchor's quotes are backslash-escaped; match up to
    // the `=` (an autolinks-off parse would leave plain text with no `<a href`).
    assert!(
        patch.contains("<a href="),
        "default config must enable gfm autolinks (got {patch})"
    );
    brook_session_free(s);
}

/// Unknown JSON keys are ignored (forward-compat), not rejected.
#[test]
fn unknown_config_keys_are_ignored() {
    let cfg = CString::new(r#"{"block_data":true,"future_flag":123,"nope":"x"}"#).unwrap();
    let s = brook_session_new_with_config(cfg.as_ptr());
    assert!(!s.is_null(), "unknown keys must be ignored, not rejected");
    brook_session_free(s);
}

/// Invalid inputs to the config constructor return NULL (never crash): NULL
/// pointer, malformed JSON, and non-object JSON.
#[test]
fn new_with_config_rejects_bad_input() {
    assert!(brook_session_new_with_config(std::ptr::null()).is_null(), "NULL config → NULL");

    let bad = CString::new("{not valid json").unwrap();
    assert!(brook_session_new_with_config(bad.as_ptr()).is_null(), "invalid JSON → NULL");

    let non_object = CString::new("[1,2,3]").unwrap();
    assert!(brook_session_new_with_config(non_object.as_ptr()).is_null(), "non-object JSON → NULL");
}

/// Every export tolerates a NULL session (returns NULL/0, never crashes). Freeing
/// NULL is a no-op. (Double-free is UB and intentionally NOT tested — same as C
/// `free()`.)
#[test]
fn null_session_is_tolerated() {
    let null = std::ptr::null_mut::<BrookSession>();
    assert!(brook_session_append(null, b"x".as_ptr(), 1).is_null(), "append(NULL) → NULL");
    assert!(brook_session_finalize(null).is_null(), "finalize(NULL) → NULL");
    assert!(brook_session_all_blocks(null).is_null(), "all_blocks(NULL) → NULL");
    assert_eq!(brook_session_retained_bytes(null), 0, "retained_bytes(NULL) → 0");
    assert_eq!(brook_session_buffer_len(null), 0, "buffer_len(NULL) → 0");
    brook_session_reset(null); // no-op, must not crash
    brook_session_free(null); // no-op, must not crash
    brook_string_free(std::ptr::null_mut()); // no-op, must not crash
}

/// A NULL chunk pointer is allowed only with len == 0 (empty append); with len != 0
/// it returns NULL rather than dereferencing NULL.
#[test]
fn null_chunk_handling() {
    let s = brook_session_new();
    let empty = brook_session_append(s, std::ptr::null(), 0);
    assert!(!empty.is_null(), "NULL chunk with len 0 is a valid empty append");
    brook_string_free(empty);
    assert!(
        brook_session_append(s, std::ptr::null(), 5).is_null(),
        "NULL chunk with len != 0 must return NULL, not deref NULL"
    );
    brook_session_free(s);
}

/// reset() rebuilds the parser (mirroring the JS worker's free-and-recreate), so
/// block ids restart from 0. Proven the strong way: after a reset, streaming a
/// chunk produces bytes IDENTICAL to a brand-new session.
#[test]
fn reset_restarts_fresh_from_zero() {
    let fresh_s = brook_session_new();
    let fresh = append(fresh_s, "# Two\n\n");
    brook_session_free(fresh_s);
    assert!(fresh.contains(r#""id":0"#), "fresh session's first block should be id 0");

    let s = brook_session_new();
    let _first = append(s, "# One\n\n"); // id 0 committed
    let advanced = append(s, "# Two\n\n"); // same instance → id advances
    assert_ne!(advanced, fresh, "sanity: continuing the same session must NOT reproduce fresh output");

    brook_session_reset(s);
    let after_reset = append(s, "# Two\n\n");
    assert_eq!(after_reset, fresh, "after reset(), streaming a chunk must be byte-identical to a fresh session");
    brook_session_free(s);
}

/// reset() must preserve the session's configuration.
#[test]
fn reset_preserves_config() {
    let cfg = lib_default_config_json(true);
    let s = brook_session_new_with_config(cfg.as_ptr());
    let before = stream(s);
    brook_session_reset(s);
    let after = stream(s);
    assert_eq!(before, after, "reset() must keep the block-data config (byte-identical re-run)");
    assert_eq!(after[0], ON_APPEND_0, "post-reset config still emits blockData wire");
    brook_session_free(s);
}

/// The memory/buffer metrics delegate to the core parser and track input.
#[test]
fn metrics_track_input() {
    let s = brook_session_new();
    assert_eq!(brook_session_buffer_len(s), 0, "empty session has an empty buffer");
    brook_string_free(brook_session_append(s, b"# Title\n\n".as_ptr(), 9));
    assert_eq!(brook_session_buffer_len(s), 9, "buffer_len counts retained source bytes");
    assert!(brook_session_retained_bytes(s) > 0, "retained_bytes includes buffer + rendered html");
    brook_session_reset(s);
    assert_eq!(brook_session_buffer_len(s), 0, "reset() clears the buffer");
    brook_session_free(s);
}

/// The parser replaces NUL with U+FFFD per CommonMark, so the wire JSON never
/// contains an interior NUL — which is exactly why `CString::new` (in
/// `string_into_c`) always succeeds and `append` returns a non-NULL C string even
/// for input containing a NUL byte. Assert both facts rather than assuming them.
#[test]
fn no_interior_nul_in_output() {
    let s = brook_session_new();
    let with_nul = b"a\0b\n\n"; // NUL in the middle of the input
    let ptr = brook_session_append(s, with_nul.as_ptr(), with_nul.len());
    assert!(!ptr.is_null(), "NUL-containing input still yields a valid (NUL-free) C string");
    // SAFETY: live C string from this crate.
    let bytes = unsafe { CStr::from_ptr(ptr) }.to_bytes();
    assert!(!bytes.contains(&0), "wire output must contain no interior NUL byte");
    brook_string_free(ptr);
    brook_session_free(s);
}

/// The wire-version accessor returns the static contract string and must not be
/// freed (we only read it).
#[test]
fn wire_version_is_1_2_0() {
    let ptr = brook_wire_version();
    assert!(!ptr.is_null());
    // SAFETY: static NUL-terminated string; never freed.
    let v = unsafe { CStr::from_ptr(ptr) }.to_str().unwrap();
    assert_eq!(v, "1.2.0", "wire contract version must match WIRE.md");
}
