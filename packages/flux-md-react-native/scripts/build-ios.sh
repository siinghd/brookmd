#!/usr/bin/env bash
#
# Build the flux-md-ffi Rust crate for iOS device + simulator, lipo the two
# simulator slices into one fat static lib, and assemble an XCFramework the
# podspec (flux-md-react-native.podspec) vendors.
#
# Requires: macOS with Xcode (xcodebuild, lipo) and the Rust iOS targets. On a
# non-macOS host this exits early — device builds are CI's job (macos runner in
# .github/workflows/rn-build.yml).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CRATE_DIR="$(cd "$PKG_DIR/../../crates/flux-md-ffi" && pwd)"
BUILD_DIR="$PKG_DIR/ios/build"
XCFRAMEWORK="$PKG_DIR/ios/FluxMdFfi.xcframework"
LIB="libflux_md_ffi.a"

fail() { echo "error: $*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "iOS builds require macOS with Xcode (host is $(uname -s))."
command -v cargo >/dev/null 2>&1 || fail "cargo (Rust toolchain) not found — install from https://rustup.rs"
command -v xcodebuild >/dev/null 2>&1 || fail "xcodebuild not found — install Xcode and its command-line tools."
command -v lipo >/dev/null 2>&1 || fail "lipo not found — install the Xcode command-line tools."

DEVICE=aarch64-apple-ios
SIM_ARM=aarch64-apple-ios-sim
SIM_X86=x86_64-apple-ios
for t in "$DEVICE" "$SIM_ARM" "$SIM_X86"; do
  rustup target add "$t" >/dev/null 2>&1 || true
done

echo "==> building device + simulator slices"
( cd "$CRATE_DIR" && cargo build --release --target "$DEVICE" \
    && cargo build --release --target "$SIM_ARM" \
    && cargo build --release --target "$SIM_X86" )

mkdir -p "$BUILD_DIR"
SIM_FAT="$BUILD_DIR/$LIB"
echo "==> lipo simulator arches (arm64 + x86_64)"
lipo -create \
  "$CRATE_DIR/target/$SIM_ARM/release/$LIB" \
  "$CRATE_DIR/target/$SIM_X86/release/$LIB" \
  -output "$SIM_FAT"

echo "==> assembling XCFramework"
rm -rf "$XCFRAMEWORK"
xcodebuild -create-xcframework \
  -library "$CRATE_DIR/target/$DEVICE/release/$LIB" \
  -library "$SIM_FAT" \
  -output "$XCFRAMEWORK"

echo "done — $XCFRAMEWORK"
