// One-time dev warnings, shared by the renderers and the client.
//
// Every guard added for the "override called with the wrong prop contract" class
// of bug routes through here, so hardening costs exactly one `Set.has` in
// production and prints nothing. Keyed so a warning that fires per block (or per
// tag) still says its piece once instead of flooding the console during a
// stream.

const warned = new Set<string>();

/** True unless the bundler/runtime says NODE_ENV === "production". Read off
 *  `globalThis` so there is no @types/node dependency; bundlers inline
 *  `process.env.NODE_ENV`, and absence is treated as dev (same rule as the
 *  unstable-prop tripwire in react.tsx). */
export function isDev(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return !env || env.NODE_ENV !== "production";
}

/** Warn once per `id` (dev only). Returns true if it actually warned. */
export function warnOnce(id: string, message: string): boolean {
  if (!isDev() || warned.has(id)) return false;
  warned.add(id);
  // eslint-disable-next-line no-console
  console.warn(message);
  return true;
}

/** Test-only: clear the latch so a test can assert a warning fires. */
export function __resetWarnOnce(): void {
  warned.clear();
}
