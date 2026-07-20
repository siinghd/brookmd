// PLACEHOLDER build hook — intentionally a no-op today. See the package README
// ("Building the native library") for the shipping plan.
//
// Dart's native-asset build hooks (Flutter 3.38 / Dart 3.10) are *stable as a
// feature* but the hook package API (`package:hooks` / `package:code_assets`,
// formerly `package:native_assets_cli`) is still evolving. Rather than pin this
// scaffold to an experimental, moving API, our plan mirrors what sentry, realm,
// and powersync ship today: **prebuilt** platform binaries produced by CI
// (crates/brookmd-cabi via .github/workflows/cabi-build.yml), vendored into the
// package. cargokit — the old "build Rust from a Flutter plugin" tool — was
// archived in 2026-03, so we do not depend on it.
//
// When the hook API settles, a real implementation would look roughly like:
//
//   import 'package:code_assets/code_assets.dart';
//   import 'package:hooks/hooks.dart';
//
//   void main(List<String> args) async {
//     await build(args, (input, output) async {
//       // 1. `cargo build --release` the brookmd-cabi crate for
//       //    input.config.code.targetOS / targetArchitecture (cargo-ndk for
//       //    Android; the apple targets for iOS/macOS; the host triple for
//       //    Linux/Windows desktop).
//       // 2. output.assets.code.add(CodeAsset(
//       //      package: input.packageName,
//       //      name: 'src/bindings.dart',
//       //      linkMode: DynamicLoadingBundled(),
//       //      file: <path to the built lib>,
//       //    ));
//       // Until then, ship the CI-built binaries and load them with
//       //    DynamicLibrary.open (see lib/brook_md.dart).
//     });
//   }
//
// Kept as valid Dart so tooling that discovers the hook does nothing surprising.
void main(List<String> args) {
  // No-op: prebuilt binaries are the current distribution mechanism.
}
