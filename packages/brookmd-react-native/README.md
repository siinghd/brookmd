# brookmd-react-native

Streaming markdown for React Native. The parser is [brookmd](https://github.com/siinghd/brookmd)'s Rust core, compiled to a native library and reached over JSI (uniffi / [uniffi-bindgen-react-native](https://jhugman.github.io/uniffi-bindgen-react-native/)) — no bridge round-trips, no WebView. Markdown is parsed incrementally as tokens arrive and rendered with real React Native primitives (`Text`, `View`, `ScrollView`, …).

> **Status: pre-release (0.1.2).** The JavaScript layer — the streaming shim, the client, and the renderer — is covered by host tests that drive the real parser. The native layer is validated **app-level end-to-end in CI** ([`.github/workflows/rn-e2e.yml`](../../.github/workflows/rn-e2e.yml), green on both platforms): a real RN 0.86 app ([`examples/rn-e2e`](../../examples/rn-e2e)) consumes this package, runs codegen in a real Gradle/CocoaPods release build, links the CMake/JSI module against the Rust library, and streams the wire goldens through the native parser on an x86_64 Android emulator (KVM) and an iOS simulator — asserting byte-identical output. See [End-to-end validation](#end-to-end-validation). What CI cannot cover: behavior on physical devices. Pre-1.0, APIs may still move.

New architecture only: React Native **≥ 0.76** with the new architecture (TurboModules) enabled.

## Install

```sh
npm install brookmd-react-native
# iOS:
cd ios && pod install
```

Two [uniffi-bindgen-react-native](https://jhugman.github.io/uniffi-bindgen-react-native/) packages are involved: `@ubjs/core` (the JS runtime the generated bindings import) ships as a regular dependency of this package, and `uniffi-bindgen-react-native` itself (the C++ headers the native build compiles against) is a peer dependency your app must install, version-matched:

```sh
npm install uniffi-bindgen-react-native@0.31.0-3
```

No Babel or Metro configuration is required beyond React Native's defaults — this is exactly the setup the CI end-to-end app builds with.

## Quick start

```tsx
import { BrookMarkdown } from "brookmd-react-native";

export function Message({ text }: { text: string }) {
  // `content` is a controlled string — it grows in place as tokens arrive.
  return <BrookMarkdown content={text} />;
}
```

`<BrookMarkdown>` is light/dark aware (via `useColorScheme`) and renders every block through the built-in component map. Nothing is ever injected as raw HTML.

## Streaming from an LLM

Drive a caller-owned client and feed it deltas as they land:

```tsx
import { useMemo } from "react";
import { BrookMarkdown, createBrookClient } from "brookmd-react-native";

function Chat({ stream }: { stream: AsyncIterable<string> }) {
  const client = useMemo(() => createBrookClient({ config: { blockData: true } }), []);

  useEffect(() => {
    (async () => {
      for await (const delta of stream) client.append(delta);
      client.finalize();
    })();
    return () => client.destroy();
  }, [client, stream]);

  return <BrookMarkdown client={client} />;
}
```

`createBrookClient()` returns a full brookmd `BrookClient`, so `append`, `finalize`, `setContent`, `pipeFrom`, `subscribe`, `getSnapshot`, `getMetrics`, and `reset` all work exactly as in the browser build. `pipeFrom` accepts a `Response`, a `ReadableStream<Uint8Array>`, or an `AsyncIterable<string>`.

## Configuration

Pass `config` (to `<BrookMarkdown>` when it owns the client, or to `createBrookClient`). Omitted fields use the library defaults.

| Option | Default | Meaning |
| --- | --- | --- |
| `gfmAutolinks` | `true` | Bare `www.`/`http(s)`/`ftp`/email autolinks. |
| `gfmAlerts` | `true` | `> [!NOTE]` → tinted callout cards. |
| `gfmFootnotes` | `false` | `[^1]` references + footnote section. |
| `gfmMath` | `false` | `$…$` inline / `$$…$$` display math (rendered as LaTeX text). |
| `gfmTagfilter` | `false` | GFM disallowed-raw-HTML tag filter (only with `unsafeHtml`). |
| `dirAuto` | `false` | `dir="auto"` on block text (mixed LTR/RTL). |
| `a11y` | `false` | Accessibility markup (task-list labels, header scopes). |
| `unsafeHtml` | `false` | Pass raw HTML through. Never enable for untrusted input. |
| `componentTags` | — | Block custom-tag allowlist → `components[Tag]`. |
| `inlineComponentTags` | — | Inline custom-tag allowlist → `components[tag]`. |
| `htmlAllowlist` / `dropHtmlTags` | — | Engage the safe raw-HTML sanitizer. |
| `blockData` | `true` here | Structured `kind.data` (table/heading/code/…) for custom renderers. |

`<BrookMarkdown>` defaults `blockData` to `true` — RN renderers commonly build UI from the structured channel.

## Theming & overrides

```tsx
<BrookMarkdown
  content={text}
  colorScheme="dark"                       // force a scheme (default: useColorScheme)
  theme={{ link: "#7aa2f7", fontSize: 15 }} // partial theme override
  components={{                             // per-tag / per-kind overrides
    a: MyLink,
    Cite: MyCitationChip,                   // an inlineComponentTags tag
  }}
/>
```

- `theme` is a shallow merge over the resolved light/dark base (see `resolveTheme` / the `Theme` type).
- `components` keys are lowercase HTML tags (`a`, `code`, `table`, …) or capitalized block-kind / component-tag names; values are RN components. They merge over the built-ins.
- For a fully custom primitive set, build the map yourself with `createComponents(primitives, theme)` and pass it as `components`, or bind a fresh component with `makeBrookMarkdown({ primitives, useColorScheme })`.

## How it works

```
your markdown deltas
      │  client.append(delta)
      ▼
BrookClient ──▶ createNativePool ──▶ NativeWorker (in-process)
                                        │  WorkerCore (brookmd's worker state machine)
                                        ▼
                                   BrookSession  (uniffi / JSI)  ──▶ brookmd-core (Rust)
                                        │  JSON wire patch (WIRE.md)
                                        ▼
                                   block store ──▶ <BrookMarkdown> ──▶ htmlToReact ──▶ RN primitives
```

The browser build runs each stream's parser in a Web Worker; React Native has no Worker, so `NativeWorker` wraps brookmd's `WorkerCore` (its message/readiness state machine) as a synchronous in-process transport. The `append`/`finalize` calls return the exact JSON wire strings documented in [`crates/brookmd-core/WIRE.md`](../../crates/brookmd-core/WIRE.md) — byte-identical to the WASM boundary — so a native binding decodes the same bytes the JavaScript renderer does.

The session enables the contract-v1.2.0 **wire delta mode** (WIRE.md §11): a block that keeps growing crosses the JSI boundary as a verified `{keep, append}` splice instead of a full re-send, so total emitted bytes stay O(n) even for one giant streaming list or code fence. brookmd's shared client reconstructs full blocks before anything renders — invisible to your code. Raw `BrookSession` consumers keep byte-identical v1 wire unless they opt in via `BrookConfig`.

The renderer is dependency-injected: `createComponents(primitives, theme)` maps every HTML tag the core emits onto an RN primitive, respecting RN's nesting rules (text-bearing tags → `Text`, structural tags → `View`/`ScrollView`, inter-tag whitespace dropped). No tag ever falls through to a raw HTML string.

## Build from source (native layer)

The bindings under `src/generated` + `cpp/generated` are produced by ubrn from `crates/brookmd-ffi`:

```sh
# Regenerate the TS + C++ bindings (from the built host library):
cargo build --release -p brookmd-ffi
npm run ubrn:generate

# Cross-compile the Rust crate for devices:
npm run build:android   # → android/src/main/jniLibs/<abi>/libbrook_md_ffi.so   (needs cargo-ndk + NDK r28+)
npm run build:ios       # → ios/BrookMdFfi.xcframework                          (needs macOS + Xcode)
```

`scripts/build-android.sh` builds `arm64-v8a`, `armeabi-v7a`, and `x86_64` with cargo-ndk (NDK r28+ for 16 KB page-size support). `scripts/build-ios.sh` builds the device slice plus both simulator arches, lipos the simulator slices, and assembles the XCFramework. Both fail early with an actionable message when the required toolchain is absent.

## End-to-end validation

[`examples/rn-e2e`](../../examples/rn-e2e) is a minimal RN 0.86 app fixture that consumes this package (and its `brookmd` dependency) as `file:` deps — the realistic consumer path. On mount it streams the wire-golden chunks through the on-device `BrookSession` and asserts every patch is byte-identical to the Rust core's goldens (`examples/rn-e2e/golden.ts`, copied from `crates/brookmd-ffi/tests/wire_golden.rs`), then renders the same content through `<BrookMarkdown>`. On success (or failure) it reports the verdict over an HTTP beacon to the CI host — a deterministic gate that doesn't depend on log capture. `.github/workflows/rn-e2e.yml` runs it as a **must-pass release build on both platforms**: an x86_64 Android emulator (KVM) and an iOS simulator.

The fixture installs the ubrn runtime the generated bindings import directly (`@ubjs/core@0.31.0-3`, pinned to the `uniffi-bindgen-react-native` version) — the same resolution a registry consumer gets from this package's dependency on it. Its `metro.config.js` wires the monorepo `file:` deps (watchFolders, `nodeModulesPaths`, and a forced single copy of `react`/`react-native`); none of that is needed outside the monorepo.

Run it locally (JS resolution — the highest-value off-device check; no Android SDK / Xcode needed):

```sh
# from the repo root: build brookmd's dist (the RN package imports brookmd/*)
bun install && bun run build:wasm:stable && (cd packages/brookmd && node scripts/build.mjs)

cd examples/rn-e2e
npm install
npx tsc --noEmit
npx react-native bundle --platform android --dev false --entry-file index.js --bundle-output /tmp/brook-e2e.bundle
```

A full device run needs the platform toolchains (NDK/emulator or Xcode/simulator); `rn-e2e.yml` is the reference. Build the native library into the package first (`npm run build:android` / `npm run build:ios` in `packages/brookmd-react-native`), then `npm run android` / `npm run ios` from `examples/rn-e2e`.

## Public API

- `BrookMarkdown` — the RN component (`content` / `client` / `config` / `components` / `theme` / `colorScheme` / `blockData`).
- `useBrookMarkdown(client)` — subscribe to a client, get its block list.
- `createBrookClient(options)` — a `BrookClient` backed by the native parser.
- `createNativePool({ makeParser? })` / `getDefaultNativePool()` — the native `BrookPool`.
- `createComponents(primitives, theme)` / `makeBrookMarkdown(deps)` — build a custom renderer.
- `resolveTheme(scheme, override?)` and the `Theme` type.
- Re-exports from brookmd: `BrookClient`, `BrookPool`, `htmlToReact`, `safeUrl`, and the `Block` / `Patch` / `ParserConfig` / `Components` types.

## License

MIT
