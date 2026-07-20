//! In-crate uniffi Swift bindgen, gated behind the `cli` feature.
//!
//! Swift bindings use a separate entrypoint from the Kotlin/Python/Ruby one
//! (`uniffi-bindgen`); it takes the library path + out dir positionally plus
//! `--swift-sources` / `--headers` / `--modulemap` sub-flags. Run from this
//! crate's directory against the compiled library (library mode):
//!
//! ```sh
//! cargo run --features cli --bin uniffi-bindgen-swift -- \
//!   target/release/libflux_md_ffi.a build/swift \
//!   --swift-sources --headers --modulemap \
//!   --module-name flux_md_ffiFFI --modulemap-filename module.modulemap
//! ```
//!
//! Note: no `--xcframework` — that flag emits a `framework module` map, but the
//! static-lib `-create-xcframework -library … -headers …` flow needs a plain
//! `module flux_md_ffiFFI` (see bindings/swift/scripts/generate.sh). Read the
//! release `.a`, not the `.so`: `strip = true` removes the uniffi metadata
//! symbols from the cdylib.
//!
//! Same pin rationale as `uniffi-bindgen`: build it from this crate's pinned
//! `=0.31.0` uniffi so the generated Swift matches the linked runtime's ABI.

fn main() {
    uniffi::uniffi_bindgen_swift()
}
