import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
  build: {
    target: "es2022",
    sourcemap: true,
    assetsInlineLimit: 0,
  },
  worker: {
    format: "es",
  },
  optimizeDeps: {
    exclude: ["flux-md/src/wasm/flux_md_core.js"],
  },
});
