//! The pure-Rust JSON wire format shared by every consumer of `brookmd-core`.
//!
//! This is the language-agnostic boundary specified in `WIRE.md`: a [`Patch`]
//! (or a slice of [`Block`]s) is serialized to a JSON string with `serde_json`.
//! The WASM/JS glue in `lib.rs` produces its strings through exactly this
//! serialization, so a native Rust embedding can emit byte-for-byte identical
//! wire without pulling in wasm-bindgen.
//!
//! The wire shape is versioned independently of the crate version — see
//! `WIRE.md`; it is currently **wire contract v1.2.0**. The serde field names
//! (`newly_committed` / `active` here, and the [`Block`] fields) ARE the
//! contract: renaming or reordering them is a breaking change to every consumer.

use crate::parser::HtmlDelta;
use crate::{Block, Patch};
use serde::ser::{SerializeStruct, Serializer};
use serde::Serialize;

/// The patch envelope as it crosses the wire: the blocks that just became
/// permanent (`newly_committed`) plus the still-open blocks (`active`),
/// serialized as `{"newly_committed":[…],"active":[…]}`.
///
/// This is the serialization mirror of [`Patch`]; [`Patch`] itself is the parser
/// working type and is intentionally not `Serialize`, so the wire shape lives in
/// exactly one place (here). Build one with `WirePatch::from(patch)`.
#[derive(Serialize)]
pub struct WirePatch {
    pub newly_committed: Vec<Block>,
    pub active: Vec<WireActive>,
}

/// One entry of the wire `active` array: a full [`Block`], or — in the opt-in
/// wire delta mode (`WIRE.md` §11) — the same block emitted as a splice
/// against its previous emit: every `Block` field except `html`, plus
/// `"html_delta":{"keep_bytes":…,"keep_units":…,"append":"…"}` in `html`'s
/// position, where `append` is `html[keep_bytes..]`. Consumers detect the
/// form by which of `html` / `html_delta` is present.
pub struct WireActive {
    pub block: Block,
    pub delta: Option<HtmlDelta>,
}

impl Serialize for WireActive {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let Some(d) = self.delta else {
            return self.block.serialize(serializer);
        };
        // Field order mirrors `Block` exactly, with `html_delta` where `html`
        // sits in the full form — part of the pinned wire shape.
        #[derive(Serialize)]
        struct DeltaBody<'a> {
            keep_bytes: usize,
            keep_units: usize,
            append: &'a str,
        }
        let b = &self.block;
        let mut s = serializer.serialize_struct("Block", 7)?;
        s.serialize_field("id", &b.id)?;
        s.serialize_field("kind", &b.kind)?;
        s.serialize_field("start", &b.start)?;
        s.serialize_field("end", &b.end)?;
        s.serialize_field(
            "html_delta",
            &DeltaBody {
                keep_bytes: d.keep_bytes,
                keep_units: d.keep_units,
                append: &b.html[d.keep_bytes..],
            },
        )?;
        s.serialize_field("open", &b.open)?;
        s.serialize_field("speculative", &b.speculative)?;
        s.end()
    }
}

impl From<Patch> for WirePatch {
    fn from(p: Patch) -> Self {
        // `active_deltas` is either empty (delta mode off) or aligned 1:1 with
        // `active` (see `Patch`); zip defensively so a length mismatch can only
        // ever degrade to full emission, never mis-splice.
        let deltas = if p.active_deltas.len() == p.active.len() {
            p.active_deltas
        } else {
            Vec::new()
        };
        let mut deltas = deltas.into_iter();
        let active = p
            .active
            .into_iter()
            .map(|block| WireActive { block, delta: deltas.next().flatten() })
            .collect();
        Self { newly_committed: p.newly_committed, active }
    }
}

/// Serialize a patch envelope to its JSON wire string (see `WIRE.md`). This is
/// the string a native consumer forwards in place of `BrookParser.append` /
/// `finalize` on the WASM boundary.
///
/// The serialization is infallible for this type (no field's `Serialize` impl
/// can fail), matching the WASM glue, whose `serde_json::to_string` call likewise
/// never takes its error path in practice.
///
/// `#[inline]` is load-bearing for the shipped WASM, not a perf hint: a plain
/// `pub fn` in this `cdylib` crate gets external linkage and survives dead-code
/// elimination even though the JS glue never calls it, growing the binary.
/// `#[inline]` gives it internal linkage so LTO drops it from the WASM build,
/// keeping that artifact byte-identical. Do not remove it.
#[inline]
pub fn patch_to_json(patch: &WirePatch) -> String {
    serde_json::to_string(patch).expect("WirePatch serialization is infallible")
}

/// Serialize a slice of blocks to a JSON array string — the whole-document wire
/// form read by `BrookParser.allBlocks` (see `WIRE.md`). `#[inline]` is required
/// to keep this dead-in-WASM helper out of the shipped binary — see
/// [`patch_to_json`].
#[inline]
pub fn blocks_to_json(blocks: &[&Block]) -> String {
    serde_json::to_string(blocks).expect("Block serialization is infallible")
}
