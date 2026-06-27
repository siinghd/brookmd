#!/usr/bin/env bash
# End-to-end consumer smoke test for flux-md's COMPILED dist.
#
# Proves the published artifact (not the raw source) works downstream:
#   1. build the real dist (scripts/build.mjs — self-asserts the dist contract)
#   2. pack it like a publish (npm pack honours files=["dist","README.md"])
#   3. extract the tarball into a throwaway consumer's node_modules + link
#      react/react-dom/scheduler from the workspace store
#   4. Node ESM, worker-free: resolve flux-md/server through the real exports map
#      and render (string + RSC) — no network
#   5. Browser: Vite-build the in-repo consumer (web/src/flux-entry.ts imports
#      flux-md/element + /client + /styles.css) against the BUILT dist and assert
#      a SEPARATE worker chunk + a non-inlined .wasm asset survive
#
# Offline: react + vite already live in the workspace. No npm install.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PKG="$(cd "$HERE/../.." && pwd)"                 # packages/flux-md
ROOT="$(cd "$PKG/../.." && pwd)"                 # repo root
WEB="$ROOT/web"
WORK="$HERE/.work"

echo "== 1. build real dist =="
( cd "$PKG" && node scripts/build.mjs )

echo "== 2. pack the publishable tarball =="
rm -rf "$WORK"; mkdir -p "$WORK/node_modules"
TGZ="$(cd "$PKG" && npm pack --silent --pack-destination "$WORK")"
tar -xzf "$WORK/$TGZ" -C "$WORK/node_modules"
mv "$WORK/node_modules/package" "$WORK/node_modules/flux-md"

echo "== 3. link react/react-dom/scheduler from the workspace store =="
link_dep() {
  local name="$1"
  local src
  src="$(ls -d "$ROOT"/node_modules/.bun/"$name"@*/node_modules/"$name" 2>/dev/null | head -1 || true)"
  [ -n "$src" ] || src="$(node -e "process.stdout.write(require('path').dirname(require.resolve('$name/package.json')))" 2>/dev/null || true)"
  [ -n "$src" ] || { echo "  WARN: could not locate $name; RSC half may be skipped"; return 0; }
  ln -sfn "$(realpath "$src")" "$WORK/node_modules/$name"
}
link_dep react
link_dep react-dom
link_dep scheduler

echo "== 4. Node ESM worker-free server + RSC render =="
( cd "$WORK" && node "$HERE/server-check.mjs" )

echo "== 5. Vite-build the in-repo consumer against the built dist =="
( cd "$WEB" && ./node_modules/.bin/vite build --config vite.flux.config.ts >/dev/null 2>&1 )

echo "== 6. assert separate worker chunk + non-inlined wasm =="
node "$HERE/assert-vite-output.mjs" "$WEB/dist-flux"

rm -rf "$WORK"
echo
echo "ALL CONSUMER SMOKE CHECKS PASSED"
