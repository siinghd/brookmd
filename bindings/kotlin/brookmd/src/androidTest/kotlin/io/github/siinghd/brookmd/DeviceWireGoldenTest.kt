package io.github.siinghd.brookmd

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/**
 * INSTRUMENTED (on-device / emulator) wire-contract goldens for the generated
 * uniffi Kotlin bindings.
 *
 * This is the device-class twin of `host-test`'s `WireGoldenTest` (JVM host):
 * it drives the SAME generated `BrookSession` through the SAME fixed document
 * and chunking, asserting byte-equality with the SAME golden strings — but the
 * native `libbrook_md_ffi.so` is now loaded by JNA inside an Android runtime
 * (x86_64 emulator in CI, see `.github/workflows/device-validate.yml`), packaged
 * from `src/main/jniLibs/<abi>/` into the self-instrumenting test APK.
 *
 * Runner: `androidx.test.runner.AndroidJUnitRunner` (JUnit4 via AndroidJUnit4).
 * Assertions use `kotlin.test.*` (message-last), byte-identical in intent to the
 * host `WireGoldenTest`.
 *
 * CHANGING ANY GOLDEN HERE IS A BREAKING WIRE CHANGE — see the Rust test header
 * (`crates/brookmd-ffi/tests/wire_golden.rs`).
 */
@RunWith(AndroidJUnit4::class)
class DeviceWireGoldenTest {

    // Fixed document, streamed in fixed chunks (verbatim from the core golden test).
    // Normal strings: the `\n` are real newlines, matching the Rust `CHUNKS`.
    private val chunks = listOf(
        "# Title\n\nHello ",
        "world\n\n```rust\nlet x = 1;\n```\n\n",
        "| A | B |\n| - | - |\n| 1 | 2 |\n",
    )

    // ── block_data OFF (verbatim; raw strings keep `\"`/`\n` literal, as in Rust r#""#) ──
    private val offAppend0 =
        """{"newly_committed":[{"id":0,"kind":{"type":"Heading","data":1},"start":0,"end":8,"html":"<h1>Title</h1>","open":false,"speculative":false}],"active":[{"id":1,"kind":{"type":"Paragraph"},"start":9,"end":15,"html":"<p>Hello</p>","open":true,"speculative":true}]}"""
    private val offAppend1 =
        """{"newly_committed":[{"id":1,"kind":{"type":"Paragraph"},"start":9,"end":21,"html":"<p>Hello world</p>","open":false,"speculative":false},{"id":2,"kind":{"type":"CodeBlock","data":{"lang":"rust"}},"start":22,"end":45,"html":"<pre><code class=\"language-rust\" data-lang=\"rust\">let x = 1;\n</code></pre>","open":false,"speculative":false}],"active":[]}"""
    private val offAppend2 =
        """{"newly_committed":[],"active":[{"id":3,"kind":{"type":"Table"},"start":46,"end":76,"html":"<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>","open":true,"speculative":true}]}"""
    private val offFinalize =
        """{"newly_committed":[{"id":3,"kind":{"type":"Table"},"start":46,"end":76,"html":"<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>","open":false,"speculative":false}],"active":[]}"""
    private val offAllBlocks =
        """[{"id":0,"kind":{"type":"Heading","data":1},"start":0,"end":8,"html":"<h1>Title</h1>","open":false,"speculative":false},{"id":1,"kind":{"type":"Paragraph"},"start":9,"end":21,"html":"<p>Hello world</p>","open":false,"speculative":false},{"id":2,"kind":{"type":"CodeBlock","data":{"lang":"rust"}},"start":22,"end":45,"html":"<pre><code class=\"language-rust\" data-lang=\"rust\">let x = 1;\n</code></pre>","open":false,"speculative":false},{"id":3,"kind":{"type":"Table"},"start":46,"end":76,"html":"<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>","open":false,"speculative":false}]"""

    // ── block_data ON (verbatim) ──
    private val onAppend0 =
        """{"newly_committed":[{"id":0,"kind":{"type":"Heading","data":{"level":1,"text":"Title","id":"title"}},"start":0,"end":8,"html":"<h1>Title</h1>","open":false,"speculative":false}],"active":[{"id":1,"kind":{"type":"Paragraph"},"start":9,"end":15,"html":"<p>Hello</p>","open":true,"speculative":true}]}"""
    private val onAppend1 =
        """{"newly_committed":[{"id":1,"kind":{"type":"Paragraph"},"start":9,"end":21,"html":"<p>Hello world</p>","open":false,"speculative":false},{"id":2,"kind":{"type":"CodeBlock","data":{"lang":"rust","code":"let x = 1;\n"}},"start":22,"end":45,"html":"<pre><code class=\"language-rust\" data-lang=\"rust\">let x = 1;\n</code></pre>","open":false,"speculative":false}],"active":[]}"""
    private val onAppend2 =
        """{"newly_committed":[],"active":[{"id":3,"kind":{"type":"Table","data":{"headers":[{"text":"A","html":"A"},{"text":"B","html":"B"}],"rows":[[{"text":"1","html":"1"},{"text":"2","html":"2"}]],"aligns":[null,null]}},"start":46,"end":76,"html":"<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>","open":true,"speculative":true}]}"""
    private val onFinalize =
        """{"newly_committed":[{"id":3,"kind":{"type":"Table","data":{"headers":[{"text":"A","html":"A"},{"text":"B","html":"B"}],"rows":[[{"text":"1","html":"1"},{"text":"2","html":"2"}]],"aligns":[null,null]}},"start":46,"end":76,"html":"<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>","open":false,"speculative":false}],"active":[]}"""

    /** A [BrookConfig] with every setter at `StreamParser`'s library default plus the block-data toggle. */
    private fun libDefaultConfig(blockData: Boolean) = BrookConfig(
        gfmAutolinks = false,
        gfmAlerts = false,
        gfmTagfilter = false,
        gfmFootnotes = false,
        gfmMath = false,
        dirAuto = false,
        a11y = false,
        unsafeHtml = false,
        componentTags = null,
        inlineComponentTags = null,
        htmlAllowlist = null,
        dropHtmlTags = null,
        blockData = blockData,
    )

    /** Stream [chunks] through a session, returning each append patch then the finalize patch. */
    private fun stream(session: BrookSession): List<String> =
        chunks.map { session.append(it) } + session.finalize()

    @Test
    fun goldenWireDefaultBare() {
        val got = stream(BrookSession())
        assertEquals(offAppend0, got[0], "append[0] wire drifted (contract v1.1.0)")
        assertEquals(offAppend1, got[1], "append[1] wire drifted (contract v1.1.0)")
        assertEquals(offAppend2, got[2], "append[2] wire drifted (contract v1.1.0)")
        assertEquals(offFinalize, got[3], "finalize wire drifted (contract v1.1.0)")
    }

    @Test
    fun goldenWireDefaultViaConfig() {
        val got = stream(BrookSession.newWithConfig(libDefaultConfig(false)))
        assertEquals(offAppend0, got[0], "append[0] wire drifted via config (contract v1.1.0)")
        assertEquals(offAppend1, got[1], "append[1] wire drifted via config (contract v1.1.0)")
        assertEquals(offAppend2, got[2], "append[2] wire drifted via config (contract v1.1.0)")
        assertEquals(offFinalize, got[3], "finalize wire drifted via config (contract v1.1.0)")
    }

    @Test
    fun goldenWireBlockData() {
        val got = stream(BrookSession.newWithConfig(libDefaultConfig(true)))
        assertEquals(onAppend0, got[0], "append[0] blockData wire drifted (contract v1.1.0)")
        assertEquals(onAppend1, got[1], "append[1] blockData wire drifted (contract v1.1.0)")
        assertEquals(onAppend2, got[2], "append[2] blockData wire drifted (contract v1.1.0)")
        assertEquals(onFinalize, got[3], "finalize blockData wire drifted (contract v1.1.0)")
    }

    @Test
    fun goldenAllBlocksDefault() {
        val session = BrookSession()
        chunks.forEach { session.append(it) }
        session.finalize()
        assertEquals(offAllBlocks, session.allBlocks(), "allBlocks wire drifted (contract v1.1.0)")
    }

    @Test
    fun resetRestartsFreshFromZero() {
        // Canonical first-chunk output of a fresh parser (heading committed as id 0).
        val fresh = BrookSession().append("# Two\n\n")
        assertTrue(fresh.contains("\"id\":0"), "fresh session's first block should be id 0")

        val session = BrookSession()
        session.append("# One\n\n") // id 0 committed
        val advanced = session.append("# Two\n\n") // same instance → id advances to 1
        assertNotEquals(fresh, advanced, "continuing the same session must not reproduce fresh output")

        session.reset()
        val afterReset = session.append("# Two\n\n")
        assertEquals(fresh, afterReset, "after reset(), a chunk must be byte-identical to a fresh session")
    }

    @Test
    fun resetPreservesConfig() {
        val session = BrookSession.newWithConfig(libDefaultConfig(true))
        val before = stream(session)
        session.reset()
        val after = stream(session)
        assertEquals(before, after, "reset() must keep the block-data config (byte-identical re-run)")
        assertEquals(onAppend0, after[0], "post-reset config still emits blockData wire")
    }

    @Test
    fun metricsTrackInput() {
        val session = BrookSession()
        assertEquals(0uL, session.bufferLen(), "empty session has an empty buffer")
        session.append("# Title\n\n")
        assertEquals(9uL, session.bufferLen(), "bufferLen counts retained source bytes")
        assertTrue(session.retainedBytes() > 0uL, "retainedBytes includes buffer + rendered html")
        session.reset()
        assertEquals(0uL, session.bufferLen(), "reset() clears the buffer")
    }
}
