# Shipping flux-md

The repo is git-initialized, CI is wired (`.github/workflows/ci.yml`), and the
npm package is publish-ready. The steps below are the ones that need **your**
credentials/accounts — they are intentionally not automated.

## Status (already done)

- ✅ `git init` + `.gitignore` (excludes `target/`, `node_modules/`, `web/dist/`)
- ✅ CI: Rust suite (enforces CommonMark **652/652** + GFM floors) and the
  WASM-build + JS package job (typecheck, component/pool/store tests, web build)
- ✅ `packages/flux-md/package.json`: `publishConfig.access=public`,
  `prepublishOnly` (rebuilds WASM), `repository`/`homepage`/`bugs`
- ✅ `npm pack --dry-run` verified: tarball includes `src/` **and the compiled
  `src/wasm/`** (an empty `src/wasm/.npmignore` overrides the build-artifact
  `.gitignore` so the WASM ships). 17 files, ~150 KB WASM.
- ✅ npm name `flux-md` is **available** (registry returns 404).

## 1–2. Repo + push — ✅ DONE

Public repo: **https://github.com/siinghd/flux-md** (branch `main`). First CI
run is **green** (both the Rust and WASM/JS jobs). `repository`/`bugs` URLs in
`packages/flux-md/package.json` point at it.

## 3. Publish to npm

```bash
cd packages/flux-md       # run from HERE — prepublishOnly does `cd ../.. && bun run build:wasm`
npm login                 # or set NPM_TOKEN in CI for automated release
npm publish               # prepublishOnly rebuilds the WASM first
```

## Known limitation (follow-up, not a blocker)

The package is distributed as **source** (`main`/`exports` point at `.ts`/`.tsx`)
and relies on Vite-style `?url` WASM imports, so consumers must use a compatible
bundler (see the README "Install" note). Emitting a pre-bundled `dist/` (e.g.
via `tsup`) that works across more bundlers is a sensible next iteration; it
does not block a Vite-targeted 0.2.0 release.
