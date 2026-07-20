//! In-crate uniffi bindgen (Kotlin/Python/Ruby), gated behind the `cli` feature.
//!
//! Run from this crate's directory against the compiled library (library mode):
//!
//! ```sh
//! cargo run --features cli --bin uniffi-bindgen -- \
//!   generate --library target/release/libflux_md_ffi.so \
//!   --language kotlin --out-dir <out>
//! ```
//!
//! It MUST be the in-crate bin (not an external `uniffi-bindgen`): uniffi is
//! pinned to `=0.31.0` (see Cargo.toml) because 0.31 changed method checksums —
//! a bindgen built from a different uniffi version emits incompatible bindings.
//! Building this bin from the pinned dependency guarantees the versions match.

fn main() {
    uniffi::uniffi_bindgen_main()
}
