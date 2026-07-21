const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const path = require('path');

/**
 * Metro configuration for the brookmd-react-native e2e fixture.
 *
 * This app lives at <repo>/examples/rn-e2e, OUTSIDE the bun workspace globs
 * (["packages/*", "web"]). It consumes the workspace packages as `file:` deps:
 *
 *   brookmd-react-native  ->  ../../packages/brookmd-react-native  (the package under test)
 *   brookmd               ->  ../../packages/brookmd              (its runtime dep)
 *
 * npm symlinks both into examples/rn-e2e/node_modules. Because their real source
 * lives outside the app's projectRoot, Metro needs three things wired up (the
 * classic RN monorepo pitfall — see https://reactnative.dev/docs/metro and
 * satya164/react-native-monorepo-config):
 *
 *   1. watchFolders — let Metro read the symlinked package sources.
 *   2. nodeModulesPaths — resolve the app's own deps (incl. @ubjs/core, the
 *      ubrn runtime the generated bindings import) from examples/rn-e2e.
 *   3. A forced single copy of react / react-native. The workspace packages carry
 *      their OWN react / react-native in node_modules (bun installed the dev/peer
 *      deps there); a naive walk-up from the symlinked sources would resolve a
 *      SECOND React, producing "Invalid hook call" at runtime. resolveRequest
 *      pins react + react-native (+ their subpaths, e.g. react/jsx-runtime) to
 *      this app's copy.
 */
const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');
const pkgBrookmd = path.resolve(monorepoRoot, 'packages/brookmd');
const pkgReactNative = path.resolve(monorepoRoot, 'packages/brookmd-react-native');

// Packages that MUST resolve to this app's single copy.
const SINGLETONS = ['react', 'react-native'];
const appNodeModules = path.resolve(projectRoot, 'node_modules');

const defaultConfig = getDefaultConfig(projectRoot);

const config = {
  projectRoot,
  // Real source dirs of the symlinked `file:` deps (outside projectRoot).
  watchFolders: [pkgBrookmd, pkgReactNative],
  resolver: {
    // Search the app's node_modules for anything not found via the hierarchical
    // walk-up (notably @ubjs/core, requested from the symlinked package source).
    nodeModulesPaths: [appNodeModules],
    // Package exports on (default in RN 0.79+/Metro 0.82+). brookmd resolves via
    // its `default` export condition, which Metro's DEFAULT conditionNames
    // (["react-native"] + the implicit "default") already match — so DO NOT
    // override unstable_conditionNames. Adding "import" globally is a trap: it
    // makes dual packages like @babel/runtime resolve to their ESM variant
    // (`helpers/esm/*`, whose module namespace is `{default: fn}`, not a bare
    // function), so `_interopRequireDefault(...)` throws "Object is not a function"
    // during InitializeCore (setUpPerformance.js) and the release bundle crashes.
    unstable_enablePackageExports: true,
    resolveRequest: (context, moduleName, platform) => {
      for (const name of SINGLETONS) {
        if (moduleName === name || moduleName.startsWith(name + '/')) {
          // Resolve as if requested from the app root, so the walk-up lands on
          // examples/rn-e2e/node_modules/<name> — one copy for the whole graph.
          return context.resolveRequest(
            { ...context, originModulePath: path.join(projectRoot, 'index.js') },
            moduleName,
            platform,
          );
        }
      }
      return context.resolveRequest(context, moduleName, platform);
    },
  },
};

module.exports = mergeConfig(defaultConfig, config);
