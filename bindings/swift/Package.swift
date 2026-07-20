// swift-tools-version: 5.9
//
// flux-md Swift bindings (EXPERIMENTAL).
//
// `FluxMd` wraps the uniffi-generated `flux_md_ffi.swift`, which imports the
// low-level C module `flux_md_ffiFFI` vended by the XCFramework binary target.
//
// The XCFramework is consumed by PATH (built locally by
// scripts/build-xcframework.sh into Frameworks/flux_md_ffi.xcframework). This
// works for in-repo development and for CI, which builds the framework before
// `swift test`. A future release will switch this to a url+checksum
// `binaryTarget` pointing at a published/mirrored artifact (see README).
import PackageDescription

let package = Package(
    name: "FluxMd",
    platforms: [
        .iOS(.v13),
        .macOS(.v11),
    ],
    products: [
        .library(name: "FluxMd", targets: ["FluxMd"]),
    ],
    targets: [
        // The Rust core, compiled for Apple targets and packaged as a static-library
        // XCFramework. Provides the `flux_md_ffiFFI` C module (via its modulemap).
        .binaryTarget(
            name: "FluxMdRustFFI",
            path: "Frameworks/flux_md_ffi.xcframework"
        ),
        // The generated uniffi Swift bindings.
        .target(
            name: "FluxMd",
            dependencies: ["FluxMdRustFFI"],
            path: "Sources/FluxMd"
        ),
        .testTarget(
            name: "FluxMdTests",
            dependencies: ["FluxMd"],
            path: "Tests/FluxMdTests"
        ),
    ]
)
