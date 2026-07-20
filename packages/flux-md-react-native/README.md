# flux-md-react-native

Streaming markdown for React Native. The parser is [flux-md](https://github.com/siinghd/flux-md)'s Rust core, compiled to a native library and reached over JSI (uniffi / [uniffi-bindgen-react-native](https://jhugman.github.io/uniffi-bindgen-react-native/)) — no bridge round-trips, no WebView. Markdown is parsed incrementally as tokens arrive and rendered with real React Native primitives (`Text`, `View`, `ScrollView`, …).

> **Status: pre-release (0.1.0).** The JavaScript layer — the streaming shim, the client, and the renderer — is covered by host tests that drive the real parser. The **native device builds (Android `.so`, iOS XCFramework) have not yet been validated on-device**; they are produced by CI (`.github/workflows/rn-build.yml`) and the scaffolding here (Gradle/CMake/podspec/Kotlin/ObjC++) is expected to need iteration on a real device/Xcode/NDK setup. Treat the native layer as a work in progress.

New architecture only: React Native **≥ 0.76** with the new architecture (TurboModules) enabled.

## Install

```sh
npm install flux-md-react-native
# iOS:
cd ios && pod install
```

The generated JSI bindings import the ubrn runtime as `@ubjs/core`. Add a Babel alias so Metro resolves it to the installed `uniffi-bindgen-react-native` package:

```js
// babel.config.js
module.exports = {
  presets: ["module:@react-native/babel-preset"],
  plugins: [
    ["module-resolver", { alias: { "@ubjs/core": "uniffi-bindgen-react-native" } }],
  ],
};
```

## Quick start

```tsx
import { FluxMarkdown } from "flux-md-react-native";

export function Message({ text }: { text: string }) {
  // `content` is a controlled string — it grows in place as tokens arrive.
  return <FluxMarkdown content={text} />;
}
```

`<FluxMarkdown>` is light/dark aware (via `useColorScheme`) and renders every block through the built-in component map. Nothing is ever injected as raw HTML.

## Streaming from an LLM

Drive a caller-owned client and feed it deltas as they land:

```tsx
import { useMemo } from "react";
import { FluxMarkdown, createFluxClient } from "flux-md-react-native";

function Chat({ stream }: { stream: AsyncIterable<string> }) {
  const client = useMemo(() => createFluxClient({ config: { blockData: true } }), []);

  useEffect(() => {
    (async () => {
      for await (const delta of stream) client.append(delta);
      client.finalize();
    })();
    return () => client.destroy();
  }, [client, stream]);

  return <FluxMarkdown client={client} />;
}
```

`createFluxClient()` returns a full flux-md `FluxClient`, so `append`, `finalize`, `setContent`, `pipeFrom`, `subscribe`, `getSnapshot`, `getMetrics`, and `reset` all work exactly as in the browser build. `pipeFrom` accepts a `Response`, a `ReadableStream<Uint8Array>`, or an `AsyncIterable<string>`.

## Configuration

Pass `config` (to `<FluxMarkdown>` when it owns the client, or to `createFluxClient`). Omitted fields use the library defaults.

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

`<FluxMarkdown>` defaults `blockData` to `true` — RN renderers commonly build UI from the structured channel.

## Theming & overrides

```tsx
<FluxMarkdown
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
- For a fully custom primitive set, build the map yourself with `createComponents(primitives, theme)` and pass it as `components`, or bind a fresh component with `makeFluxMarkdown({ primitives, useColorScheme })`.

## How it works

```
your markdown deltas
      │  client.append(delta)
      ▼
FluxClient ──▶ createNativePool ──▶ NativeWorker (in-process)
                                        │  WorkerCore (flux-md's worker state machine)
                                        ▼
                                   FluxSession  (uniffi / JSI)  ──▶ flux-md-core (Rust)
                                        │  JSON wire patch (WIRE.md)
                                        ▼
                                   block store ──▶ <FluxMarkdown> ──▶ htmlToReact ──▶ RN primitives
```

The browser build runs each stream's parser in a Web Worker; React Native has no Worker, so `NativeWorker` wraps flux-md's `WorkerCore` (its message/readiness state machine) as a synchronous in-process transport. The `append`/`finalize` calls return the exact JSON wire strings documented in [`crates/flux-md-core/WIRE.md`](../../crates/flux-md-core/WIRE.md) — byte-identical to the WASM boundary — so a native binding decodes the same bytes the JavaScript renderer does.

The renderer is dependency-injected: `createComponents(primitives, theme)` maps every HTML tag the core emits onto an RN primitive, respecting RN's nesting rules (text-bearing tags → `Text`, structural tags → `View`/`ScrollView`, inter-tag whitespace dropped). No tag ever falls through to a raw HTML string.

## Build from source (native layer)

The bindings under `src/generated` + `cpp/generated` are produced by ubrn from `crates/flux-md-ffi`:

```sh
# Regenerate the TS + C++ bindings (from the built host library):
cargo build --release -p flux-md-ffi
npm run ubrn:generate

# Cross-compile the Rust crate for devices:
npm run build:android   # → android/src/main/jniLibs/<abi>/libflux_md_ffi.so   (needs cargo-ndk + NDK r28+)
npm run build:ios       # → ios/FluxMdFfi.xcframework                          (needs macOS + Xcode)
```

`scripts/build-android.sh` builds `arm64-v8a`, `armeabi-v7a`, and `x86_64` with cargo-ndk (NDK r28+ for 16 KB page-size support). `scripts/build-ios.sh` builds the device slice plus both simulator arches, lipos the simulator slices, and assembles the XCFramework. Both fail early with an actionable message when the required toolchain is absent.

## Public API

- `FluxMarkdown` — the RN component (`content` / `client` / `config` / `components` / `theme` / `colorScheme` / `blockData`).
- `useFluxMarkdown(client)` — subscribe to a client, get its block list.
- `createFluxClient(options)` — a `FluxClient` backed by the native parser.
- `createNativePool({ makeParser? })` / `getDefaultNativePool()` — the native `FluxPool`.
- `createComponents(primitives, theme)` / `makeFluxMarkdown(deps)` — build a custom renderer.
- `resolveTheme(scheme, override?)` and the `Theme` type.
- Re-exports from flux-md: `FluxClient`, `FluxPool`, `htmlToReact`, `safeUrl`, and the `Block` / `Patch` / `ParserConfig` / `Components` types.

## License

MIT
