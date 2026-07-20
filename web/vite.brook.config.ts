import { defineConfig } from "vite";

// Dedicated build for the self-hosted brookmd bundle that isobox serves under
// /assets/. App-style (rollupOptions.input, NOT lib mode) so Vite emits the
// worker as a SEPARATE chunk referenced by a bare-relative new URL(...,
// import.meta.url) — the runtime resolution that makes /assets/ co-location
// work and avoids an inlined blob: worker (which breaks the wasm fetch).
export default defineConfig({
  build: {
    target: "es2022",
    outDir: "dist-brook",
    emptyOutDir: true,
    sourcemap: false,
    assetsInlineLimit: 0, // never inline the .wasm
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: "src/brook-entry.ts",
      output: {
        // Stable, hashless names so the served URLs are predictable.
        entryFileNames: "brookmd.js",
        chunkFileNames: "[name].js",
        assetFileNames: "[name][extname]",
      },
    },
  },
  worker: {
    format: "es",
  },
  optimizeDeps: {
    // Dev-only (ignored by `vite build`); kept to match the reference setup.
    exclude: ["brookmd"],
  },
});
