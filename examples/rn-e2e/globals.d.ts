// Consumer-side ambient shim.
//
// brookmd-react-native ships raw `.ts` sources (package `main`/`react-native`
// point at `src/index.tsx`), so a consumer's `tsc` type-checks the package source
// directly. `src/native-pool.ts` uses `queueMicrotask`, which Hermes/React Native
// provide at RUNTIME — but the TypeScript lib set selected by
// `@react-native/typescript-config` omits it (it lives only in the DOM / WebWorker
// libs). The package's own tsconfig picks it up from `@types/bun`; this fixture
// declares it here instead. Runtime-safe: Hermes implements queueMicrotask.
declare function queueMicrotask(callback: () => void): void;
