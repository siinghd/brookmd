# brookmd

[![npm](https://img.shields.io/npm/v/brookmd.svg)](https://www.npmjs.com/package/brookmd)
[![CI](https://github.com/siinghd/brookmd/actions/workflows/ci.yml/badge.svg)](https://github.com/siinghd/brookmd/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/brookmd.svg)](LICENSE)

**Streaming markdown for every platform.** One Rust core — incremental parse
with speculative closure for mid-stream constructs, stable block identities so
unchanged blocks never re-reconcile — compiled to WASM for the web and to
native libraries for mobile and desktop. Every boundary emits the same
versioned JSON wire, byte-for-byte. 100% CommonMark 0.31 + GFM.

In the browser, wire each LLM stream to a `BrookClient` and the markdown
renders incrementally **off the main thread**, block by block — so many
concurrent streams render without melting the UI thread.

**[Live demo](https://md.hsingh.app/)** · **[Full docs &amp; API →](packages/brookmd/README.md)** · **[Changelog](packages/brookmd/CHANGELOG.md)**

```bash
npm i brookmd
```

```tsx
import { BrookMarkdown } from "brookmd/react";

// `stream` is an AsyncIterable<string> (SSE deltas), a Response, or a ReadableStream
<BrookMarkdown stream={stream} />;
```

## Highlights

- **Off the main thread** — a pooled Web Worker per stream; the parser re-parses
  only the active tail on each token, and heavy renderers (highlighting, math,
  mermaid) defer until a block closes.
- **SSR-safe** — imports and `renderToString` cleanly on the server across React,
  Vue, Solid, and Svelte; the worker is created lazily on the client.
- **Structured `block.data` channel** *(opt-in, default off)* — tables, headings,
  code, math, and lists are exposed as **typed, streaming data** on
  `block.kind.data`, so you build toolbars (sort/filter/CSV), tables of contents,
  charts, and copy buttons from data — no HTML re-parsing, no AST tree to walk.
- **Renderers for every stack** — React, Vue 3, Svelte (4 & 5), Solid, a
  framework-agnostic `<brook-markdown>` Web Component, and a vanilla DOM mount
  on the web; a React Native renderer and Swift/Kotlin/Flutter bindings over
  the native core (experimental — see [Platforms](#platforms)).
- **Zero runtime dependencies.** The whole engine is one WASM binary plus a small
  TypeScript client.

See the **[package README](packages/brookmd/README.md)** for the full API,
per-stream config, framework bindings, security model, and scaling helpers
(`virtualize`, `stickToBottom`).

## Repository layout

| Path | What |
|------|------|
| [`packages/brookmd`](packages/brookmd) | The published npm package — TS client + renderers, and the full docs. |
| [`crates/brookmd-core`](crates/brookmd-core) | The Rust parser/renderer, published to [crates.io](https://crates.io/crates/brookmd-core); compiled to WASM for the npm package. Emits the versioned JSON [wire contract](crates/brookmd-core/WIRE.md). |
| [`crates/brookmd-ffi`](crates/brookmd-ffi) | uniffi wrapper over the core for native targets (React Native, Swift, Kotlin). |
| [`crates/brookmd-cabi`](crates/brookmd-cabi) | Plain C-ABI wrapper (Dart/Flutter and any C FFI consumer). |
| [`packages/brookmd-react-native`](packages/brookmd-react-native) | React Native renderer over the native core (experimental — not yet on npm). |
| [`packages/brookmd-flutter`](packages/brookmd-flutter) | Flutter/Dart scaffold over the C ABI (experimental). |
| [`bindings/kotlin`](bindings/kotlin) | Kotlin/Android bindings (experimental). |
| [`bindings/swift`](bindings/swift) | Swift package (iOS + macOS) bindings (experimental). |
| [`web`](web) | The live demo / playground ([md.hsingh.app](https://md.hsingh.app/)). |

## Platforms

The same Rust core streams the same versioned JSON wire
([WIRE.md](crates/brookmd-core/WIRE.md)) across every boundary; golden tests
pin every binding to byte-identical output.

| Platform | Use | Status |
|----------|-----|--------|
| Browser / Node / SSR | [`brookmd`](https://www.npmjs.com/package/brookmd) on npm (React, Vue, Svelte, Solid, Web Component, DOM, server) | **Stable** — published |
| Rust | [`brookmd-core`](https://crates.io/crates/brookmd-core) on crates.io | **Stable** — published |
| React Native (iOS + Android) | [`packages/brookmd-react-native`](packages/brookmd-react-native) — native parser via JSI, RN renderer | Experimental — CI-built, pending device validation; not yet on npm |
| iOS / macOS (Swift) | [`bindings/swift`](bindings/swift) — SPM package `BrookMd` over an XCFramework | Experimental — CI-built and host-tested |
| Android (Kotlin) | [`bindings/kotlin`](bindings/kotlin) — Android library + JVM-tested uniffi bindings | Experimental — CI-built and host-tested |
| Flutter / Dart | [`packages/brookmd-flutter`](packages/brookmd-flutter) over the C ABI | Experimental — scaffold |
| Anything with a C FFI | [`crates/brookmd-cabi`](crates/brookmd-cabi) + `include/brook_md.h` | Experimental — tested on host |

Native bindings ship prebuilt from CI (Android `.so` per ABI, Apple
XCFrameworks with iOS + macOS slices); nothing native is published to a
package registry yet.

## Development

```bash
bun install
bun run build:wasm        # compile the Rust core → WASM
cd packages/brookmd && bun test
```

CI enforces the CommonMark 652/652 + GFM conformance floors, the JS test suite, a
fresh-process SSR cold-import check, and that the published tarball ships the WASM.

## License

[MIT](LICENSE)
