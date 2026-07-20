# brook_md (Flutter / Dart) — EXPERIMENTAL

Dart/Flutter bindings for **brookmd**, an incremental, streaming-aware markdown
parser. They wrap the plain C ABI in [`crates/brookmd-cabi`](../../crates/brookmd-cabi)
(over the `brookmd-core` Rust engine) with hand-written `dart:ffi` bindings.

> [!WARNING]
> **This package is EXPERIMENTAL and demand-driven.**
> The Rust C-ABI layer (`brookmd-cabi`) is unit-tested and CI-built for Android,
> iOS, and macOS (`.github/workflows/cabi-build.yml`). The **Dart side has not been
> validated on a device or emulator** — this host has no Flutter/Dart toolchain, so
> the Dart code here was written and self-reviewed against the C header but never
> compiled or run. Treat it as a starting scaffold: expect to `dart analyze`, build
> the native library, and smoke-test on a real target before relying on it.

## What you get

- `BrookSession` — one streaming-parse session. `append(String) -> String`,
  `finalize()`, `allBlocks()`, `reset()`, `retainedBytes()`, `bufferLen()`,
  `dispose()`.
- `BrookConfig` — per-stream options (GFM autolinks/alerts default on, everything
  else off), serialized to the JSON config the C ABI expects.
- `BrookSession.wireVersion()` — the wire-contract version string (currently
  `1.0.0`).

`append`/`finalize` return the **JSON wire strings** defined by
[`WIRE.md`](../../crates/brookmd-core/WIRE.md) — byte-identical to the WebAssembly/JS
and React Native boundaries. Decode with `dart:convert`'s `jsonDecode`; render the
`Block`s however you like (there is no Flutter widget layer here — that is the
demand-driven next step).

```dart
import 'package:brook_md/brook_md.dart';

final session = BrookSession(config: const BrookConfig(blockData: true));
try {
  final patch = session.append('# Hello\n\nstreaming ');
  // patch == '{"newly_committed":[...],"active":[...]}'  (parse with jsonDecode)
  session.append('world\n');
  session.finalize();
} finally {
  session.dispose(); // always release the native session
}
```

## Building the native library

The Dart code loads a prebuilt shared library per platform (see `_openLibrary` in
`lib/brook_md.dart`):

| Platform | Library file | Notes |
| --- | --- | --- |
| Android | `libbrook_md_cabi.so` | one per ABI in `jniLibs/<abi>/`; `cargo-ndk` cross-build |
| iOS | (statically linked) | link the `staticlib` slice / XCFramework into the app; symbols resolve from the process |
| macOS | `libbrook_md_cabi.dylib` | `aarch64`/`x86_64-apple-darwin` |
| Linux | `libbrook_md_cabi.so` | host `cargo build --release` |
| Windows | `brook_md_cabi.dll` | host `cargo build --release` |

Build the crate from `crates/brookmd-cabi`:

```bash
# Desktop (host):
cargo build --release          # -> target/release/libbrook_md_cabi.{so,dylib,dll}

# Android (all ABIs), needs cargo-ndk + NDK r28+:
cargo ndk -t arm64-v8a -t armeabi-v7a -t x86_64 -o out build --release

# Apple (device + simulator + macOS): build each target, then
# xcodebuild -create-xcframework ... (see .github/workflows/cabi-build.yml).
```

CI (`cabi-build.yml`) produces these artifacts on every change to the crate. The
shipping plan is to **vendor the CI-built binaries** into this package per
platform, exactly as sentry / realm / powersync do for their native code.

### Why prebuilt binaries (and no ffigen)

- **Prebuilt, not build-from-source.** Dart's native-asset build hooks
  (`hook/build.dart`) are stable as a Flutter feature, but the hook *package* API is
  still experimental and moving; `cargokit` (the old build-Rust-from-a-plugin tool)
  was archived in 2026-03. Prebuilt binaries are the reliable path today. See
  `hook/build.dart` for a commented sketch of the future hook wiring.
- **No `ffigen`.** The C surface is 11 functions. Hand-written bindings
  (`lib/src/bindings.dart`) are smaller than the generator's config + output, carry
  no build-time codegen dependency, and stay readable. The Rust `symbol_drift` test
  keeps the C header and the compiled library in lockstep; keep `bindings.dart`'s
  lookup names matching the header when the ABI changes.

## Layout

```
lib/brook_md.dart       public API (BrookSession, BrookConfig)
lib/src/bindings.dart  raw dart:ffi typedefs + DynamicLibrary lookups
hook/build.dart        native-asset build-hook placeholder (no-op today)
pubspec.yaml           name: brook_md, publish_to: none
```

## License

MIT, same as the rest of brookmd.
