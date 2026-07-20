#!/usr/bin/env bash
#
# Build brookmd-ffi for Apple targets and assemble the static-library
# XCFramework that Package.swift's `BrookMdRustFFI` binary target consumes
# (Frameworks/brook_md_ffi.xcframework). Slices:
#   * ios          — aarch64-apple-ios
#   * ios-simulator — lipo(aarch64-apple-ios-sim, x86_64-apple-ios)
#   * macos        — lipo(aarch64-apple-darwin, x86_64-apple-darwin)
# The macOS slice is what `swift test` links/runs against on a Mac host.
#
# Each slice ships the SAME generated Headers/ (brook_md_ffiFFI.h + a plain
# `module brook_md_ffiFFI` module.modulemap). It also refreshes
# Sources/BrookMd/brook_md_ffi.swift so the wrapper matches the framework.
#
# Requires: macOS with Xcode (xcodebuild, lipo) and a Rust toolchain. Exits early
# on a non-macOS host — Apple builds are CI's job (macos-14 in bindings-build.yml).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SWIFT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CRATE_DIR="$(cd "$SWIFT_DIR/../../crates/brookmd-ffi" && pwd)"
BUILD_DIR="$SWIFT_DIR/.build/xcframework"
STAGING="$BUILD_DIR/Headers"
XCFRAMEWORK="$SWIFT_DIR/Frameworks/brook_md_ffi.xcframework"
LIB="libbrook_md_ffi.a"

fail() { echo "error: $*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "XCFramework builds require macOS with Xcode (host is $(uname -s))."
command -v cargo >/dev/null 2>&1 || fail "cargo (Rust toolchain) not found — install from https://rustup.rs"
command -v xcodebuild >/dev/null 2>&1 || fail "xcodebuild not found — install Xcode and its command-line tools."
command -v lipo >/dev/null 2>&1 || fail "lipo not found — install the Xcode command-line tools."

IOS=aarch64-apple-ios
IOS_SIM_ARM=aarch64-apple-ios-sim
IOS_SIM_X86=x86_64-apple-ios
MAC_ARM=aarch64-apple-darwin
MAC_X86=x86_64-apple-darwin
for t in "$IOS" "$IOS_SIM_ARM" "$IOS_SIM_X86" "$MAC_ARM" "$MAC_X86"; do
  rustup target add "$t" >/dev/null 2>&1 || true
done

echo "==> building release staticlibs for all Apple targets"
( cd "$CRATE_DIR"
  cargo build --release --target "$IOS"
  cargo build --release --target "$IOS_SIM_ARM"
  cargo build --release --target "$IOS_SIM_X86"
  cargo build --release --target "$MAC_ARM"
  cargo build --release --target "$MAC_X86" )

echo "==> generating Swift + headers + modulemap (pinned uniffi =0.31.0)"
rm -rf "$BUILD_DIR"
mkdir -p "$STAGING"
# Any target's .a carries identical uniffi metadata; use the device slice.
( cd "$CRATE_DIR" && cargo run --quiet --features cli --bin uniffi-bindgen-swift -- \
    "$CRATE_DIR/target/$IOS/release/$LIB" "$STAGING" \
    --swift-sources --headers --modulemap \
    --module-name brook_md_ffiFFI --modulemap-filename module.modulemap )
# The .swift is the package source, not a framework header — move it into place.
mkdir -p "$SWIFT_DIR/Sources/BrookMd"
mv "$STAGING/brook_md_ffi.swift" "$SWIFT_DIR/Sources/BrookMd/brook_md_ffi.swift"

echo "==> lipo simulator + macOS fat libs"
SIM_FAT="$BUILD_DIR/ios-sim/$LIB"
MAC_FAT="$BUILD_DIR/macos/$LIB"
mkdir -p "$(dirname "$SIM_FAT")" "$(dirname "$MAC_FAT")"
lipo -create \
  "$CRATE_DIR/target/$IOS_SIM_ARM/release/$LIB" \
  "$CRATE_DIR/target/$IOS_SIM_X86/release/$LIB" \
  -output "$SIM_FAT"
lipo -create \
  "$CRATE_DIR/target/$MAC_ARM/release/$LIB" \
  "$CRATE_DIR/target/$MAC_X86/release/$LIB" \
  -output "$MAC_FAT"

echo "==> assembling XCFramework"
rm -rf "$XCFRAMEWORK"
mkdir -p "$SWIFT_DIR/Frameworks"
xcodebuild -create-xcframework \
  -library "$CRATE_DIR/target/$IOS/release/$LIB" -headers "$STAGING" \
  -library "$SIM_FAT" -headers "$STAGING" \
  -library "$MAC_FAT" -headers "$STAGING" \
  -output "$XCFRAMEWORK"

echo "done — $XCFRAMEWORK"
