// Public type surface, split so framework-neutral consumers (`brookmd/client`,
// `brookmd/dom`) typecheck without resolving react: the neutral types live in
// ./types-core, the lone React-coupled `Components` type in ./types-react.
// Re-exported here so `brookmd/types`, index.ts, and every existing import see
// the identical surface as before.
export * from "./types-core";
export * from "./types-react";
