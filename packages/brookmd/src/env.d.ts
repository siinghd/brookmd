// Ambient `process` declaration so the dev-gate idiom
// `typeof process !== "undefined" && process.env.NODE_ENV !== "production"`
// typechecks without pulling in @types/node (this package stays zero-dep and
// must typecheck in a DOM-only tsconfig). Types only — emits nothing.
declare const process: { env: Record<string, string | undefined> } | undefined;
