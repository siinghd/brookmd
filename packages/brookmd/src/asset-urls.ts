// The single home for brookmd's `import.meta.url`-based Web Worker construction,
// so non-web targets can swap it out (see asset-urls.native.ts).
//
// brookmd's design relies on the CONSUMER's bundler (Vite, webpack 5, Rollup,
// Parcel, Next) detecting the web-standard
// `new Worker(new URL("./worker.js", import.meta.url), { type: "module" })`
// pattern and re-emitting the standalone worker + its .wasm asset. That analysis
// fires per MODULE on the LITERAL, co-located `new Worker(new URL(...))`
// expression — so it stays intact and whole here (extracting just the URL breaks
// Vite's worker detection, which drops the worker's .wasm asset).
//
// React Native has no Web Worker and Hermes rejects the `import.meta` SYNTAX even
// in unreachable code, so the sibling `asset-urls.native.ts` exposes the same API
// without `import.meta`. The package's `react-native` field (package.json) maps
// `./dist/asset-urls.js` -> `./dist/asset-urls.native.js`, which Metro honors (its
// mainFields include `react-native`) while Node, Vite, webpack and Rollup ignore
// it and load this real module. The redirect works with the normal `.js`-
// extensioned import client.ts emits, so Node ESM keeps resolving too.
import type { WorkerLike } from "./types-core";

/** Spawn the streaming Web Worker (`dist/worker.js`) as an ES module. */
export function createWorker(): WorkerLike {
  // `./worker.ts` is rewritten to `./worker.js` in dist by build.mjs; dev/Vite
  // resolve the worker relative to this module (a sibling of worker.js in dist).
  return new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike;
}
