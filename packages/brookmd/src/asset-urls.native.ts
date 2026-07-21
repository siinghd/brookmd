// React Native variant of ./asset-urls. The package's `react-native` field
// (package.json) redirects ./dist/asset-urls.js -> ./dist/asset-urls.native.js,
// which Metro honors (mainFields include `react-native`) while Node/Vite/webpack
// load the real ./asset-urls.
//
// RN has no Web Worker: the brookmd-react-native package injects a NATIVE parser
// pool and never spawns brookmd's default Web Worker, so this factory is never
// called. Crucially this file contains NO `import.meta` and no `new Worker` —
// Hermes (React Native's engine) rejects `import.meta` at bytecode-compile time
// even in dead code, which is the entire reason this shim exists.
import type { WorkerLike } from "./types-core";

/** Not available under React Native — there is no Web Worker to spawn. */
export function createWorker(): WorkerLike {
  throw new Error(
    "brookmd: the default Web Worker pool is unavailable in React Native. Use the " +
      "brookmd-react-native package, which injects a native parser pool instead of " +
      "spawning a Web Worker.",
  );
}
