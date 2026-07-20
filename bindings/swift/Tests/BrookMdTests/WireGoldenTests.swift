import XCTest
@testable import BrookMd

/// Swift wire-contract goldens for the generated uniffi bindings.
///
/// These mirror `crates/brookmd-ffi/tests/wire_golden.rs` one-to-one: the same
/// fixed document, the same chunking, and the SAME golden strings (copied
/// verbatim). They prove the Swift binding drives the native parser to
/// byte-identical wire (WIRE.md v1.1.0) — the FFI boundary the JS/WASM renderer
/// also decodes.
///
/// Raw strings (`#"…"#`) keep `\"` / `\n` literal, exactly like the Rust `r#""#`.
///
/// CHANGING ANY GOLDEN HERE IS A BREAKING WIRE CHANGE — see the Rust test header.
final class WireGoldenTests: XCTestCase {

    // Fixed document, streamed in fixed chunks. Normal strings: `\n` are real
    // newlines, matching the Rust `CHUNKS`.
    let chunks = [
        "# Title\n\nHello ",
        "world\n\n```rust\nlet x = 1;\n```\n\n",
        "| A | B |\n| - | - |\n| 1 | 2 |\n",
    ]

    // ── block_data OFF (verbatim) ──
    let offAppend0 = #"{"newly_committed":[{"id":0,"kind":{"type":"Heading","data":1},"start":0,"end":8,"html":"<h1>Title</h1>","open":false,"speculative":false}],"active":[{"id":1,"kind":{"type":"Paragraph"},"start":9,"end":15,"html":"<p>Hello</p>","open":true,"speculative":true}]}"#
    let offAppend1 = #"{"newly_committed":[{"id":1,"kind":{"type":"Paragraph"},"start":9,"end":21,"html":"<p>Hello world</p>","open":false,"speculative":false},{"id":2,"kind":{"type":"CodeBlock","data":{"lang":"rust"}},"start":22,"end":45,"html":"<pre><code class=\"language-rust\" data-lang=\"rust\">let x = 1;\n</code></pre>","open":false,"speculative":false}],"active":[]}"#
    let offAppend2 = #"{"newly_committed":[],"active":[{"id":3,"kind":{"type":"Table"},"start":46,"end":76,"html":"<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>","open":true,"speculative":true}]}"#
    let offFinalize = #"{"newly_committed":[{"id":3,"kind":{"type":"Table"},"start":46,"end":76,"html":"<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>","open":false,"speculative":false}],"active":[]}"#
    let offAllBlocks = #"[{"id":0,"kind":{"type":"Heading","data":1},"start":0,"end":8,"html":"<h1>Title</h1>","open":false,"speculative":false},{"id":1,"kind":{"type":"Paragraph"},"start":9,"end":21,"html":"<p>Hello world</p>","open":false,"speculative":false},{"id":2,"kind":{"type":"CodeBlock","data":{"lang":"rust"}},"start":22,"end":45,"html":"<pre><code class=\"language-rust\" data-lang=\"rust\">let x = 1;\n</code></pre>","open":false,"speculative":false},{"id":3,"kind":{"type":"Table"},"start":46,"end":76,"html":"<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>","open":false,"speculative":false}]"#

    // ── block_data ON (verbatim) ──
    let onAppend0 = #"{"newly_committed":[{"id":0,"kind":{"type":"Heading","data":{"level":1,"text":"Title","id":"title"}},"start":0,"end":8,"html":"<h1>Title</h1>","open":false,"speculative":false}],"active":[{"id":1,"kind":{"type":"Paragraph"},"start":9,"end":15,"html":"<p>Hello</p>","open":true,"speculative":true}]}"#
    let onAppend1 = #"{"newly_committed":[{"id":1,"kind":{"type":"Paragraph"},"start":9,"end":21,"html":"<p>Hello world</p>","open":false,"speculative":false},{"id":2,"kind":{"type":"CodeBlock","data":{"lang":"rust","code":"let x = 1;\n"}},"start":22,"end":45,"html":"<pre><code class=\"language-rust\" data-lang=\"rust\">let x = 1;\n</code></pre>","open":false,"speculative":false}],"active":[]}"#
    let onAppend2 = #"{"newly_committed":[],"active":[{"id":3,"kind":{"type":"Table","data":{"headers":[{"text":"A","html":"A"},{"text":"B","html":"B"}],"rows":[[{"text":"1","html":"1"},{"text":"2","html":"2"}]],"aligns":[null,null]}},"start":46,"end":76,"html":"<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>","open":true,"speculative":true}]}"#
    let onFinalize = #"{"newly_committed":[{"id":3,"kind":{"type":"Table","data":{"headers":[{"text":"A","html":"A"},{"text":"B","html":"B"}],"rows":[[{"text":"1","html":"1"},{"text":"2","html":"2"}]],"aligns":[null,null]}},"start":46,"end":76,"html":"<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>","open":false,"speculative":false}],"active":[]}"#

    /// A `BrookConfig` at every setter's library default plus the block-data toggle.
    private func libDefaultConfig(blockData: Bool) -> BrookConfig {
        BrookConfig(
            gfmAutolinks: false,
            gfmAlerts: false,
            gfmTagfilter: false,
            gfmFootnotes: false,
            gfmMath: false,
            dirAuto: false,
            a11y: false,
            unsafeHtml: false,
            componentTags: nil,
            inlineComponentTags: nil,
            htmlAllowlist: nil,
            dropHtmlTags: nil,
            blockData: blockData
        )
    }

    /// Stream `chunks` through a session, returning each append patch then finalize.
    private func stream(_ session: BrookSession) -> [String] {
        chunks.map { session.append(chunk: $0) } + [session.finalize()]
    }

    func testGoldenWireDefaultBare() {
        let got = stream(BrookSession())
        XCTAssertEqual(got[0], offAppend0, "append[0] wire drifted (contract v1.1.0)")
        XCTAssertEqual(got[1], offAppend1, "append[1] wire drifted (contract v1.1.0)")
        XCTAssertEqual(got[2], offAppend2, "append[2] wire drifted (contract v1.1.0)")
        XCTAssertEqual(got[3], offFinalize, "finalize wire drifted (contract v1.1.0)")
    }

    func testGoldenWireDefaultViaConfig() {
        let got = stream(BrookSession.newWithConfig(config: libDefaultConfig(blockData: false)))
        XCTAssertEqual(got[0], offAppend0, "append[0] wire drifted via config (contract v1.1.0)")
        XCTAssertEqual(got[1], offAppend1, "append[1] wire drifted via config (contract v1.1.0)")
        XCTAssertEqual(got[2], offAppend2, "append[2] wire drifted via config (contract v1.1.0)")
        XCTAssertEqual(got[3], offFinalize, "finalize wire drifted via config (contract v1.1.0)")
    }

    func testGoldenWireBlockData() {
        let got = stream(BrookSession.newWithConfig(config: libDefaultConfig(blockData: true)))
        XCTAssertEqual(got[0], onAppend0, "append[0] blockData wire drifted (contract v1.1.0)")
        XCTAssertEqual(got[1], onAppend1, "append[1] blockData wire drifted (contract v1.1.0)")
        XCTAssertEqual(got[2], onAppend2, "append[2] blockData wire drifted (contract v1.1.0)")
        XCTAssertEqual(got[3], onFinalize, "finalize blockData wire drifted (contract v1.1.0)")
    }

    func testGoldenAllBlocksDefault() {
        let session = BrookSession()
        for c in chunks { _ = session.append(chunk: c) }
        _ = session.finalize()
        XCTAssertEqual(session.allBlocks(), offAllBlocks, "allBlocks wire drifted (contract v1.1.0)")
    }

    func testResetRestartsFreshFromZero() {
        let fresh = BrookSession().append(chunk: "# Two\n\n")
        XCTAssertTrue(fresh.contains(#""id":0"#), "fresh session's first block should be id 0")

        let session = BrookSession()
        _ = session.append(chunk: "# One\n\n") // id 0 committed
        let advanced = session.append(chunk: "# Two\n\n") // same instance → id advances
        XCTAssertNotEqual(fresh, advanced, "continuing the same session must not reproduce fresh output")

        session.reset()
        let afterReset = session.append(chunk: "# Two\n\n")
        XCTAssertEqual(fresh, afterReset, "after reset(), a chunk must be byte-identical to a fresh session")
    }

    func testResetPreservesConfig() {
        let session = BrookSession.newWithConfig(config: libDefaultConfig(blockData: true))
        let before = stream(session)
        session.reset()
        let after = stream(session)
        XCTAssertEqual(before, after, "reset() must keep the block-data config (byte-identical re-run)")
        XCTAssertEqual(after[0], onAppend0, "post-reset config still emits blockData wire")
    }

    func testMetricsTrackInput() {
        let session = BrookSession()
        XCTAssertEqual(session.bufferLen(), 0, "empty session has an empty buffer")
        _ = session.append(chunk: "# Title\n\n")
        XCTAssertEqual(session.bufferLen(), 9, "bufferLen counts retained source bytes")
        XCTAssertGreaterThan(session.retainedBytes(), 0, "retainedBytes includes buffer + rendered html")
        session.reset()
        XCTAssertEqual(session.bufferLen(), 0, "reset() clears the buffer")
    }
}
