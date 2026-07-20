# flux-md Swift bindings (EXPERIMENTAL)

First-party Swift bindings for the flux-md streaming Markdown parser, generated
by [uniffi](https://mozilla.github.io/uniffi-rs/) from the `crates/flux-md-ffi`
crate. `FluxSession` streams Markdown and returns the JSON **wire strings**
defined in `crates/flux-md-core/WIRE.md` (contract v1.0.0) — byte-identical to
the WASM/JS boundary.

> **Status: EXPERIMENTAL.** The bindings compile and pass the wire-golden
> XCTest suite in CI (`bindings-build.yml`, macOS runner) against a locally
> built XCFramework. Not yet published; not device-validated beyond the CI
> macOS host slice.

## What's here

| Path | What it is |
| --- | --- |
| `Package.swift` | SPM package `FluxMd`; iOS 13+, macOS 11+. |
| `Sources/FluxMd/flux_md_ffi.swift` | **Generated** uniffi Swift bindings (do not hand-edit — regenerate). |
| `Tests/FluxMdTests/WireGoldenTests.swift` | XCTest wire goldens (byte-equality, block-data off + on). |
| `Frameworks/flux_md_ffi.xcframework` | Built by `scripts/build-xcframework.sh` (not committed). |
| `scripts/generate.sh` | Regenerates the Swift source (idempotent). |
| `scripts/build-xcframework.sh` | macOS-only; builds the iOS + iOS-sim + macOS slices into the XCFramework. |

## API

```swift
import FluxMd

let session = FluxSession()                        // library defaults
// or: FluxSession.newWithConfig(config: FluxConfig(gfmAlerts: true, blockData: true))

let patch = session.append(chunk: "# Hello\n\n")     // JSON Patch string (WIRE.md §2)
let tail  = session.finalize()                       // final JSON Patch
let doc   = session.allBlocks()                      // whole document as JSON Block[]
session.reset()                                      // reuse; ids restart at 0
```

`append` / `finalize` / `allBlocks` return the exact wire bytes; decode with
`JSONDecoder`. `FluxConfig` field defaults mirror the crate (`gfmAutolinks` and
`gfmAlerts` **on**, everything else off).

## Consuming

**In-repo, by path (today):** build the XCFramework, then add this package as a
local SPM dependency.

```sh
bindings/swift/scripts/build-xcframework.sh   # macOS + Xcode required
swift test --package-path bindings/swift
```

The `FluxMdRustFFI` binary target references the XCFramework **by path**
(`Frameworks/flux_md_ffi.xcframework`), so it must exist before `swift build` /
`swift test` — CI builds it first. The generated Swift imports the low-level C
module `flux_md_ffiFFI`, which the XCFramework vends via a plain
`module flux_md_ffiFFI` modulemap in each slice's `Headers/`.

**Future release plan (url + checksum):** a published package will replace the
path-based `binaryTarget` with

```swift
.binaryTarget(
    name: "FluxMdRustFFI",
    url: "https://…/flux_md_ffi.xcframework.zip",
    checksum: "…"   // swift package compute-checksum
)
```

SPM `url`-based consumption needs a `Package.swift` at a repository root, so
publishing will use a GitHub release artifact (or a thin mirror repo) carrying
the zipped XCFramework and its checksum. In-repo path consumption works today.

## Regenerating

```sh
bindings/swift/scripts/generate.sh
```

Runs the **in-crate** `uniffi-bindgen-swift` (pinned to `uniffi = "=0.31.0"`) and
writes `Sources/FluxMd/flux_md_ffi.swift`. Commit the diff; CI regenerates and
`git diff --exit-code`s it as a drift check.

> Bindings are read from the release **staticlib** (`.a`), not the `.so`/`.dylib`:
> the release dynamic library is `strip = true`, which removes the uniffi
> metadata symbols the bindgen needs. The `.a` retains them.
