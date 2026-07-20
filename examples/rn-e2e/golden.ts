// Wire-contract goldens, copied VERBATIM from
// crates/brookmd-ffi/tests/wire_golden.rs (WIRE.md v1.1.0, block_data OFF).
//
// The FFI layer's `BrookSession` must emit these byte-identical JSON strings
// from the native library on a real device — the same bytes the Rust `#[test]`
// and the WASM boundary produce. The e2e app streams CHUNKS through the native
// parser and asserts each patch equals the corresponding golden below.
//
// CHANGING ANY STRING HERE IS A BREAKING WIRE CHANGE — keep in lockstep with the
// Rust goldens.

/** Fixed document, streamed in fixed chunks (verbatim from the core golden test). */
export const CHUNKS: readonly string[] = [
  '# Title\n\nHello ',
  'world\n\n```rust\nlet x = 1;\n```\n\n',
  '| A | B |\n| - | - |\n| 1 | 2 |\n',
];

// ── block_data OFF ──
export const OFF_APPEND_0 =
  '{"newly_committed":[{"id":0,"kind":{"type":"Heading","data":1},"start":0,"end":8,"html":"<h1>Title</h1>","open":false,"speculative":false}],"active":[{"id":1,"kind":{"type":"Paragraph"},"start":9,"end":15,"html":"<p>Hello</p>","open":true,"speculative":true}]}';

export const OFF_APPEND_1 =
  '{"newly_committed":[{"id":1,"kind":{"type":"Paragraph"},"start":9,"end":21,"html":"<p>Hello world</p>","open":false,"speculative":false},{"id":2,"kind":{"type":"CodeBlock","data":{"lang":"rust"}},"start":22,"end":45,"html":"<pre><code class=\\"language-rust\\" data-lang=\\"rust\\">let x = 1;\\n</code></pre>","open":false,"speculative":false}],"active":[]}';

export const OFF_APPEND_2 =
  '{"newly_committed":[],"active":[{"id":3,"kind":{"type":"Table"},"start":46,"end":76,"html":"<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>","open":true,"speculative":true}]}';

export const OFF_FINALIZE =
  '{"newly_committed":[{"id":3,"kind":{"type":"Table"},"start":46,"end":76,"html":"<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>","open":false,"speculative":false}],"active":[]}';

/** Expected patches, in stream order: append(chunk0..2) then finalize(). */
export const EXPECTED: readonly string[] = [OFF_APPEND_0, OFF_APPEND_1, OFF_APPEND_2, OFF_FINALIZE];
