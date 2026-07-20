#!/usr/bin/env bash
#
# Regenerate the Swift uniffi bindings source (brook_md_ffi.swift) and stage it
# into Sources/BrookMd. Idempotent: run after any change to the FFI crate and
# commit the diff; CI regenerates and `git diff --exit-code`s the result.
#
# This produces only the committed Swift SOURCE. The C header + module.modulemap
# are build artifacts assembled into the XCFramework by build-xcframework.sh
# (which regenerates them alongside an identical copy of this .swift).
#
# Requires: a Rust toolchain (cargo). Runs on any host — the generated Swift is
# derived from the crate's uniffi metadata, not from arch-specific code.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SWIFT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CRATE_DIR="$(cd "$SWIFT_DIR/../../crates/brookmd-ffi" && pwd)"
OUT_SWIFT="$SWIFT_DIR/Sources/BrookMd/brook_md_ffi.swift"

fail() { echo "error: $*" >&2; exit 1; }
command -v cargo >/dev/null 2>&1 || fail "cargo (Rust toolchain) not found — install from https://rustup.rs"

# Read metadata from the release STATICLIB (.a): the release cdylib is
# `strip = true`, dropping the uniffi metadata symbols; the .a retains them.
echo "==> building release staticlib (metadata source)"
( cd "$CRATE_DIR" && cargo build --release )
LIB="$CRATE_DIR/target/release/libbrook_md_ffi.a"
[ -f "$LIB" ] || fail "expected staticlib not found: $LIB"

STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT

echo "==> generating Swift bindings (uniffi library mode, pinned =0.31.0)"
# --module-name brook_md_ffiFFI: the low-level C module the generated Swift imports.
# Plain `module` modulemap (NO --xcframework) is the correct form for a
# static-library XCFramework consumed via a binaryTarget + `-headers` dir.
( cd "$CRATE_DIR" && cargo run --quiet --features cli --bin uniffi-bindgen-swift -- \
    "$LIB" "$STAGING" --swift-sources --headers --modulemap \
    --module-name brook_md_ffiFFI --modulemap-filename module.modulemap )

[ -f "$STAGING/brook_md_ffi.swift" ] || fail "generation produced no brook_md_ffi.swift"
mkdir -p "$SWIFT_DIR/Sources/BrookMd"
cp "$STAGING/brook_md_ffi.swift" "$OUT_SWIFT"
echo "done — wrote $OUT_SWIFT"
