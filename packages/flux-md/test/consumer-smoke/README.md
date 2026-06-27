# flux-md consumer smoke test

End-to-end proof that the **compiled `dist/`** (not the raw source) works
downstream. Run from anywhere:

```bash
bun run --cwd packages/flux-md test:consumer-smoke
# or: bash packages/flux-md/test/consumer-smoke/run.sh
```

It (1) builds the real dist via `scripts/build.mjs` (which self-asserts the dist
contract), (2) `npm pack`s it, (3) extracts the tarball into a throwaway
consumer + links `react`/`react-dom` from the workspace, (4) resolves
`flux-md/server` through the **real exports map** under Node native ESM and
renders (string + RSC, worker-free, wasm read off disk), then (5) Vite-builds the
in-repo consumer (`web/src/flux-entry.ts`) against the built dist and asserts a
**separate worker chunk** + a **non-inlined `.wasm`** asset survive. Offline.
