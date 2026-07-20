#!/usr/bin/env bash
#
# Build the brookmd-ffi Rust crate for the Android device ABIs and stage each
# resulting .so into android/src/main/jniLibs/<abi>/, where the CMake build
# (android/CMakeLists.txt) imports it as `my_rust_lib`.
#
# Requires: Rust, cargo-ndk, and the Android NDK. Use NDK r28+ so the linker
# defaults to 16 KB max-page-size (required for Android 15+ / 16 KB-page devices).
# On a host without the NDK this exits early with an actionable message — device
# builds are CI's job (see .github/workflows/rn-build.yml).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CRATE_DIR="$(cd "$PKG_DIR/../../crates/brookmd-ffi" && pwd)"
JNI_LIBS="$PKG_DIR/android/src/main/jniLibs"

# (rust target triple) -> (android ABI directory)
TARGETS=(aarch64-linux-android armv7-linux-androideabi x86_64-linux-android)
ABIS=(arm64-v8a armeabi-v7a x86_64)

fail() { echo "error: $*" >&2; exit 1; }

command -v cargo >/dev/null 2>&1 || fail "cargo (Rust toolchain) not found — install from https://rustup.rs"

# The NDK is the hard requirement; check it first so the message is unambiguous.
NDK_PATH="${ANDROID_NDK_HOME:-${ANDROID_NDK:-${NDK_HOME:-}}}"
if [ -z "$NDK_PATH" ] || [ ! -d "$NDK_PATH" ]; then
  fail "Android NDK not found. This build requires the Android NDK (r28+ for 16 KB page-size support).
       Install it via Android Studio's SDK Manager or 'sdkmanager \"ndk;28.0.12674087\"',
       then export ANDROID_NDK_HOME=\$ANDROID_HOME/ndk/<version> and re-run."
fi

command -v cargo-ndk >/dev/null 2>&1 || fail "cargo-ndk not found — install with 'cargo install cargo-ndk' (>= 3.5.4)."

echo "Using NDK: $NDK_PATH"
for t in "${TARGETS[@]}"; do
  rustup target add "$t" >/dev/null 2>&1 || true
done

mkdir -p "$JNI_LIBS"
for i in "${!TARGETS[@]}"; do
  target="${TARGETS[$i]}"
  abi="${ABIS[$i]}"
  echo "==> building $target -> jniLibs/$abi"
  ( cd "$CRATE_DIR" && cargo ndk --target "$target" --platform 24 -- build --release )
  mkdir -p "$JNI_LIBS/$abi"
  cp "$CRATE_DIR/target/$target/release/libbrook_md_ffi.so" "$JNI_LIBS/$abi/libbrook_md_ffi.so"
done

echo "done — staged .so for: ${ABIS[*]}"
