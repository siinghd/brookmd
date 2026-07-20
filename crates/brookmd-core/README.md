# brookmd-core

An incremental, streaming-aware CommonMark + GFM parser core. It is the Rust
engine behind the [`brookmd`](https://www.npmjs.com/package/brookmd) npm package,
exposed here as a standalone crate for native Rust consumers.

Feed the document in chunks as they arrive. Each `append` returns a `Patch`
describing which blocks just became permanent ("committed") and which are still
being built ("active"). Committed blocks never change again; active blocks may
flicker as more input arrives. Every block carries a stable, monotonic ID so a UI
layer can reconcile in place. Block scanning, inline tokenizing, and safe HTML
rendering are all in-house — there are no other parser dependencies.

## Example

```rust
use brook_md_core::StreamParser;

fn main() {
    let mut parser = StreamParser::new();

    // Feed the document in arbitrary chunks, as they arrive off the wire.
    for chunk in ["# Hello\n\nStreaming ", "markdown ", "core."] {
        let patch = parser.append(chunk);
        // `newly_committed` blocks are final; `active` blocks may still change.
        for block in patch.newly_committed {
            println!("committed #{}: {}", block.id, block.html);
        }
    }

    // Flush any block still open at end of input.
    let patch = parser.finalize();
    for block in patch.newly_committed {
        println!("committed #{}: {}", block.id, block.html);
    }
}
```

Optional extensions (GFM autolinks, alerts, footnotes, math, and more) are
enabled per parser through builder methods, e.g.
`StreamParser::new().with_gfm_autolinks(true)`.

## Feature flags

- `wasm` (default) — compiles the wasm-bindgen `BrookParser` glue used by the
  `brookmd` JS package.
- `perf_counters` — deterministic work counters used by the complexity-scaling
  tests. Off by default.

Native Rust consumers who only need the `StreamParser` API can skip wasm-bindgen
entirely:

```toml
[dependencies]
brookmd-core = { version = "0.20", default-features = false }
```

## Wire format

Blocks and patches serialize to a stable, language-agnostic JSON wire format —
see [WIRE.md](WIRE.md) (wire contract v1.1.0). Native consumers can produce the
same bytes as the WASM/JS boundary via `wire::patch_to_json` / `wire::blocks_to_json`.

## Links

- npm package: <https://www.npmjs.com/package/brookmd>
- Repository: <https://github.com/siinghd/brookmd>

## License

MIT
