#!/usr/bin/env bash
#
# Regenerate the Kotlin uniffi bindings for brookmd-ffi and stage them into the
# `brookmd` library module. Idempotent: run it after any change to the FFI crate
# and commit the diff. CI regenerates and `git diff --exit-code`s the result, so
# the committed .kt must always match a fresh generation from the pinned uniffi.
#
# Requires: a Rust toolchain (cargo). Runs on any host (the generated Kotlin is
# arch-independent — it is derived from the crate's uniffi metadata, not code).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KOTLIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CRATE_DIR="$(cd "$KOTLIN_DIR/../../crates/brookmd-ffi" && pwd)"
PKG_PATH="io/github/siinghd/brookmd"
OUT_KT_DIR="$KOTLIN_DIR/brookmd/src/main/kotlin"

fail() { echo "error: $*" >&2; exit 1; }
command -v cargo >/dev/null 2>&1 || fail "cargo (Rust toolchain) not found — install from https://rustup.rs"

# uniffi library mode reads the interface metadata from the compiled library's
# symbol table. The release cdylib (.so/.dylib) is `strip = true` (see the
# crate's tuned [profile.release]), which drops the metadata symbols — so we
# read them from the release STATICLIB (.a), which retains them, and which
# `cargo build --release` produces alongside the cdylib.
echo "==> building release staticlib (metadata source)"
( cd "$CRATE_DIR" && cargo build --release )
LIB="$CRATE_DIR/target/release/libbrook_md_ffi.a"
[ -f "$LIB" ] || fail "expected staticlib not found: $LIB"

STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT

echo "==> generating Kotlin bindings (uniffi library mode, pinned =0.31.0)"
# --no-format keeps output deterministic whether or not ktlint is installed.
( cd "$CRATE_DIR" && cargo run --quiet --features cli --bin uniffi-bindgen -- \
    generate --library "$LIB" --language kotlin \
    --out-dir "$STAGING" --config "$CRATE_DIR/uniffi.toml" --no-format )

GEN_KT="$STAGING/$PKG_PATH/brook_md_ffi.kt"
[ -f "$GEN_KT" ] || fail "generation produced no $PKG_PATH/brook_md_ffi.kt"

mkdir -p "$OUT_KT_DIR/$PKG_PATH"
cp "$GEN_KT" "$OUT_KT_DIR/$PKG_PATH/brook_md_ffi.kt"
echo "done — wrote $OUT_KT_DIR/$PKG_PATH/brook_md_ffi.kt"
