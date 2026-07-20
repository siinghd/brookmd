//! Symbol-drift tripwire: keeps `include/flux_md.h`, the Rust `#[no_mangle]`
//! exports, and the compiled cdylib's dynamic symbols from drifting apart.
//!
//! Three checks, from cheapest/most-deterministic to most-thorough:
//!  1. **Compile-tie** — every name in [`EXPORTS`] is referenced as a function
//!     item, so renaming or removing an export fails to compile this test until
//!     [`EXPORTS`] (and the header) are updated in lockstep.
//!  2. **Header parse** — the C header is scanned naively for `flux_…(` function
//!     tokens; the set must equal [`EXPORTS`]. Adding/removing a header
//!     declaration without updating the exports (or vice-versa) fails here.
//!  3. **Dynamic symbols** — if a built cdylib is found, `nm -D --defined-only`
//!     on it must expose exactly the `flux_` symbols in [`EXPORTS`]. Skipped
//!     (with a note) when no artifact or no GNU `nm` is available, so checks 1–2
//!     remain the guaranteed tripwire under a bare `cargo test`.

use std::collections::BTreeSet;
use std::ffi::c_char;
use std::path::PathBuf;
use std::process::Command;

use flux_md_cabi::{
    flux_session_all_blocks, flux_session_append, flux_session_buffer_len, flux_session_finalize,
    flux_session_free, flux_session_new, flux_session_new_with_config, flux_session_reset,
    flux_session_retained_bytes, flux_string_free, flux_wire_version, FluxSession,
};

/// The exported C-ABI surface — the single source of truth this test enforces the
/// header and the compiled library against. Keep in sync with `include/flux_md.h`
/// and the `#[no_mangle]` functions in `src/lib.rs`.
const EXPORTS: &[&str] = &[
    "flux_session_new",
    "flux_session_new_with_config",
    "flux_session_append",
    "flux_session_finalize",
    "flux_session_all_blocks",
    "flux_session_reset",
    "flux_session_retained_bytes",
    "flux_session_buffer_len",
    "flux_session_free",
    "flux_string_free",
    "flux_wire_version",
];

/// Compile-time proof that every [`EXPORTS`] name is a real function item. If one
/// is renamed or removed, this array fails to compile until the list is fixed —
/// forcing the header and dynamic-symbol checks below back into agreement.
fn export_addresses() -> [*const (); 11] {
    // Signatures differ, so erase each to a bare code pointer.
    let new_: extern "C" fn() -> *mut FluxSession = flux_session_new;
    let new_cfg: extern "C" fn(*const c_char) -> *mut FluxSession = flux_session_new_with_config;
    let append: extern "C" fn(*mut FluxSession, *const u8, usize) -> *mut c_char = flux_session_append;
    let finalize: extern "C" fn(*mut FluxSession) -> *mut c_char = flux_session_finalize;
    let all_blocks: extern "C" fn(*mut FluxSession) -> *mut c_char = flux_session_all_blocks;
    let reset: extern "C" fn(*mut FluxSession) = flux_session_reset;
    let retained: extern "C" fn(*mut FluxSession) -> u64 = flux_session_retained_bytes;
    let buffer_len: extern "C" fn(*mut FluxSession) -> u64 = flux_session_buffer_len;
    let free: extern "C" fn(*mut FluxSession) = flux_session_free;
    let string_free: extern "C" fn(*mut c_char) = flux_string_free;
    let version: extern "C" fn() -> *const c_char = flux_wire_version;
    [
        new_ as *const (),
        new_cfg as *const (),
        append as *const (),
        finalize as *const (),
        all_blocks as *const (),
        reset as *const (),
        retained as *const (),
        buffer_len as *const (),
        free as *const (),
        string_free as *const (),
        version as *const (),
    ]
}

/// Naively scan C source for `flux_<ident>(` function tokens (identifier chars are
/// `[a-z_]`, matching every export's name), returning the set of names.
fn parse_header_fns(src: &str) -> BTreeSet<String> {
    let bytes = src.as_bytes();
    let needle = b"flux_";
    let mut out = BTreeSet::new();
    let mut i = 0usize;
    while i + needle.len() <= bytes.len() {
        if &bytes[i..i + needle.len()] == needle {
            let mut j = i;
            while j < bytes.len() && (bytes[j].is_ascii_lowercase() || bytes[j] == b'_') {
                j += 1;
            }
            // A function token only if the identifier is immediately followed by '('.
            if j < bytes.len() && bytes[j] == b'(' {
                out.insert(String::from_utf8_lossy(&bytes[i..j]).into_owned());
            }
            i = j.max(i + 1);
        } else {
            i += 1;
        }
    }
    out
}

fn exports_set() -> BTreeSet<String> {
    EXPORTS.iter().map(|s| s.to_string()).collect()
}

#[test]
fn exports_compile_tie() {
    // Distinct, non-null code pointers — asserts each export name resolves.
    let addrs = export_addresses();
    assert_eq!(addrs.len(), EXPORTS.len(), "EXPORTS length must match the compile-tie array");
    assert!(addrs.iter().all(|p| !p.is_null()), "every export must be a real function");
}

#[test]
fn header_declares_exactly_the_exports() {
    let header = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("include/flux_md.h");
    let src = std::fs::read_to_string(&header)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", header.display()));
    let declared = parse_header_fns(&src);
    assert_eq!(
        declared,
        exports_set(),
        "header (include/flux_md.h) drifted from EXPORTS: \
         only-in-header={:?}, only-in-exports={:?}",
        declared.difference(&exports_set()).collect::<Vec<_>>(),
        exports_set().difference(&declared).collect::<Vec<_>>(),
    );
}

/// Locate a built cdylib to nm, if one exists. Honors `CARGO_TARGET_DIR`, else
/// `<manifest>/target`, checking both `release/` and `debug/`.
fn find_cdylib() -> Option<PathBuf> {
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target"));
    let names = ["libflux_md_cabi.so", "libflux_md_cabi.dylib", "flux_md_cabi.dll"];
    for profile in ["release", "debug"] {
        for name in names {
            let p = target.join(profile).join(name);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// Parse `flux_` dynamic symbols out of `nm -D --defined-only` output (stripping a
/// possible leading `_`, and ignoring mangled Rust symbols, which don't match).
fn flux_symbols_via_nm(lib: &PathBuf) -> Option<BTreeSet<String>> {
    let out = Command::new("nm").args(["-D", "--defined-only"]).arg(lib).output().ok()?;
    if !out.status.success() {
        return None; // e.g. BSD nm (macOS) rejecting GNU flags — skip gracefully
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut syms = BTreeSet::new();
    for line in text.lines() {
        // Format: "<addr> <type> <name>"; the name is the last whitespace field.
        if let Some(name) = line.split_whitespace().last() {
            let name = name.strip_prefix('_').unwrap_or(name);
            if name.starts_with("flux_") && name.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
            {
                syms.insert(name.to_string());
            }
        }
    }
    Some(syms)
}

#[test]
fn dynamic_symbols_match_exports() {
    let Some(lib) = find_cdylib() else {
        eprintln!(
            "note: no cdylib artifact found (run `cargo build` to enable the nm check); \
             header + compile-tie checks still guard drift"
        );
        return;
    };
    let Some(syms) = flux_symbols_via_nm(&lib) else {
        eprintln!("note: GNU `nm -D --defined-only` unavailable; skipping dynamic-symbol check");
        return;
    };
    assert_eq!(
        syms,
        exports_set(),
        "cdylib {} exports drifted from EXPORTS: only-in-lib={:?}, only-in-exports={:?}",
        lib.display(),
        syms.difference(&exports_set()).collect::<Vec<_>>(),
        exports_set().difference(&syms).collect::<Vec<_>>(),
    );
}
