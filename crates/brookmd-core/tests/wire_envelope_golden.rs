//! Wire-format golden stability tests — **wire contract v1.1.0** (see `../WIRE.md`).
//!
//! Each string below is the EXACT JSON the `WirePatch` envelope serializes to for
//! the fixed document + chunking in [`CHUNKS`], captured from live parser output
//! and eyeballed against `WIRE.md`. This is the versioned boundary every consumer
//! depends on — the JavaScript renderer today, and any native binding tomorrow.
//!
//! CHANGING ANY GOLDEN STRING HERE IS A BREAKING WIRE CHANGE. It requires a major
//! bump of the wire contract version in `WIRE.md` (and a coordinated release) —
//! never silently "re-bless" a diff. The `block_field_inventory` test is the
//! semver tripwire for the `Block` field set specifically: an added/removed/
//! renamed field trips it before any golden even needs updating.
//!
//! These tests exercise the pure `wire` module and run under
//! `--no-default-features` (no wasm-bindgen), so they pin the native path that
//! produces byte-identical bytes to the WASM/JS boundary.

use brook_md_core::wire::{blocks_to_json, patch_to_json, WirePatch};
use brook_md_core::{Block, StreamParser};
use std::collections::BTreeSet;

/// Fixed document, streamed in fixed chunks. Covers a heading, a paragraph split
/// across the chunk-0/chunk-1 boundary (`"Hello "` + `"world"`), a fenced code
/// block, and a GFM table.
const CHUNKS: [&str; 3] = [
    "# Title\n\nHello ",
    "world\n\n```rust\nlet x = 1;\n```\n\n",
    "| A | B |\n| - | - |\n| 1 | 2 |\n",
];

// ── block_data OFF (the default wire shape) ─────────────────────────────────

const OFF_APPEND_0: &str = r#"{"newly_committed":[{"id":0,"kind":{"type":"Heading","data":1},"start":0,"end":8,"html":"<h1>Title</h1>","open":false,"speculative":false}],"active":[{"id":1,"kind":{"type":"Paragraph"},"start":9,"end":15,"html":"<p>Hello</p>","open":true,"speculative":true}]}"#;

const OFF_APPEND_1: &str = r#"{"newly_committed":[{"id":1,"kind":{"type":"Paragraph"},"start":9,"end":21,"html":"<p>Hello world</p>","open":false,"speculative":false},{"id":2,"kind":{"type":"CodeBlock","data":{"lang":"rust"}},"start":22,"end":45,"html":"<pre><code class=\"language-rust\" data-lang=\"rust\">let x = 1;\n</code></pre>","open":false,"speculative":false}],"active":[]}"#;

const OFF_APPEND_2: &str = r#"{"newly_committed":[],"active":[{"id":3,"kind":{"type":"Table"},"start":46,"end":76,"html":"<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>","open":true,"speculative":true}]}"#;

const OFF_FINALIZE: &str = r#"{"newly_committed":[{"id":3,"kind":{"type":"Table"},"start":46,"end":76,"html":"<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>","open":false,"speculative":false}],"active":[]}"#;

const OFF_ALLBLOCKS: &str = r#"[{"id":0,"kind":{"type":"Heading","data":1},"start":0,"end":8,"html":"<h1>Title</h1>","open":false,"speculative":false},{"id":1,"kind":{"type":"Paragraph"},"start":9,"end":21,"html":"<p>Hello world</p>","open":false,"speculative":false},{"id":2,"kind":{"type":"CodeBlock","data":{"lang":"rust"}},"start":22,"end":45,"html":"<pre><code class=\"language-rust\" data-lang=\"rust\">let x = 1;\n</code></pre>","open":false,"speculative":false},{"id":3,"kind":{"type":"Table"},"start":46,"end":76,"html":"<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>","open":false,"speculative":false}]"#;

// ── block_data ON (Heading/CodeBlock/Table gain their `data` payloads) ───────

const ON_APPEND_0: &str = r#"{"newly_committed":[{"id":0,"kind":{"type":"Heading","data":{"level":1,"text":"Title","id":"title"}},"start":0,"end":8,"html":"<h1>Title</h1>","open":false,"speculative":false}],"active":[{"id":1,"kind":{"type":"Paragraph"},"start":9,"end":15,"html":"<p>Hello</p>","open":true,"speculative":true}]}"#;

const ON_APPEND_1: &str = r#"{"newly_committed":[{"id":1,"kind":{"type":"Paragraph"},"start":9,"end":21,"html":"<p>Hello world</p>","open":false,"speculative":false},{"id":2,"kind":{"type":"CodeBlock","data":{"lang":"rust","code":"let x = 1;\n"}},"start":22,"end":45,"html":"<pre><code class=\"language-rust\" data-lang=\"rust\">let x = 1;\n</code></pre>","open":false,"speculative":false}],"active":[]}"#;

const ON_APPEND_2: &str = r#"{"newly_committed":[],"active":[{"id":3,"kind":{"type":"Table","data":{"headers":[{"text":"A","html":"A"},{"text":"B","html":"B"}],"rows":[[{"text":"1","html":"1"},{"text":"2","html":"2"}]],"aligns":[null,null]}},"start":46,"end":76,"html":"<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>","open":true,"speculative":true}]}"#;

const ON_FINALIZE: &str = r#"{"newly_committed":[{"id":3,"kind":{"type":"Table","data":{"headers":[{"text":"A","html":"A"},{"text":"B","html":"B"}],"rows":[[{"text":"1","html":"1"},{"text":"2","html":"2"}]],"aligns":[null,null]}},"start":46,"end":76,"html":"<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>","open":false,"speculative":false}],"active":[]}"#;

/// Stream [`CHUNKS`] through a parser, returning the JSON wire string of each
/// append patch (in order) followed by the finalize patch.
fn stream(block_data: bool) -> Vec<String> {
    let mut p = StreamParser::new().with_block_data(block_data);
    let mut out: Vec<String> = CHUNKS
        .iter()
        .map(|c| patch_to_json(&WirePatch::from(p.append(c))))
        .collect();
    out.push(patch_to_json(&WirePatch::from(p.finalize())));
    out
}

#[test]
fn golden_wire_default() {
    let got = stream(false);
    assert_eq!(got[0], OFF_APPEND_0, "append[0] wire drifted (contract v1.1.0)");
    assert_eq!(got[1], OFF_APPEND_1, "append[1] wire drifted (contract v1.1.0)");
    assert_eq!(got[2], OFF_APPEND_2, "append[2] wire drifted (contract v1.1.0)");
    assert_eq!(got[3], OFF_FINALIZE, "finalize wire drifted (contract v1.1.0)");
}

#[test]
fn golden_wire_block_data() {
    let got = stream(true);
    assert_eq!(got[0], ON_APPEND_0, "append[0] blockData wire drifted (contract v1.1.0)");
    assert_eq!(got[1], ON_APPEND_1, "append[1] blockData wire drifted (contract v1.1.0)");
    assert_eq!(got[2], ON_APPEND_2, "append[2] blockData wire drifted (contract v1.1.0)");
    assert_eq!(got[3], ON_FINALIZE, "finalize blockData wire drifted (contract v1.1.0)");
}

#[test]
fn golden_all_blocks_default() {
    // The whole-document array form (`blocks_to_json`, backing `allBlocks()`).
    let mut p = StreamParser::new();
    for c in CHUNKS {
        p.append(c);
    }
    p.finalize();
    let all: Vec<&Block> = p.all_blocks().collect();
    assert_eq!(blocks_to_json(&all), OFF_ALLBLOCKS, "allBlocks wire drifted (contract v1.1.0)");
}

/// Semver tripwire: every emitted `Block` object has EXACTLY these keys. Adding,
/// removing, or renaming a `Block` field is a breaking wire change and trips this
/// before the golden strings above even need touching.
#[test]
fn block_field_inventory() {
    let mut p = StreamParser::new();
    p.append("# Title\n");
    let committed = patch_to_json(&WirePatch::from(p.finalize()));

    let v: serde_json::Value = serde_json::from_str(&committed).expect("valid JSON");
    let block = &v["newly_committed"][0];
    let keys: BTreeSet<&str> = block
        .as_object()
        .expect("block is a JSON object")
        .keys()
        .map(String::as_str)
        .collect();

    let expected: BTreeSet<&str> =
        ["id", "kind", "start", "end", "html", "open", "speculative"].into_iter().collect();
    assert_eq!(keys, expected, "Block field set changed — breaking wire change (contract v1.1.0)");
}
