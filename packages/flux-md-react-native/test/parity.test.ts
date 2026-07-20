// Streaming parity: driving the WHOLE native stack (createNativePool →
// NativeWorker → WorkerCore → the injected WASM parser → FluxClient store) with a
// document fed chunk-by-chunk must land the exact same block set as a single
// one-shot parse. This is the end-to-end proof that the RN transport shim is
// wire-faithful.
import { beforeAll, describe, expect, test } from "bun:test";
import { FluxClient } from "flux-md/client";
import { createNativePool } from "../src/native-pool";
import {
  chunk,
  haveWasm,
  loadWasm,
  oneShot,
  RICH_CONFIG,
  RICH_DOC,
  settle,
  wasmMakeParser,
  type WireBlock,
} from "./fixtures";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let Ctor: any;

beforeAll(async () => {
  if (!haveWasm) {
    // eslint-disable-next-line no-console
    console.warn("[flux-md-react-native] flux-md WASM not built — run `bun run build:wasm`; skipping parity.");
    return;
  }
  Ctor = await loadWasm();
});

const shape = (b: WireBlock) => ({ type: b.kind.type, html: b.html });

describe("streaming parity through the native shim", () => {
  test.skipIf(!haveWasm)("a chunk-by-chunk stream equals a one-shot parse", async () => {
    const client = new FluxClient({ pool: createNativePool({ makeParser: wasmMakeParser(Ctor) }), config: RICH_CONFIG });
    try {
      for (const ch of chunk(RICH_DOC, 7)) client.append(ch);
      client.finalize();
      await client.whenReady();
      await settle();

      const streamed = client.getSnapshot() as unknown as WireBlock[];
      const reference = oneShot(Ctor, RICH_DOC, RICH_CONFIG);

      // Every block committed (nothing left open/active after finalize).
      expect(streamed.every((b) => b.open === false)).toBe(true);
      // Same block sequence — kind + rendered HTML — as the ground-truth parse.
      expect(streamed.map(shape)).toEqual(reference.map(shape));
      // And it actually produced the rich structure (not an empty/degenerate run).
      expect(streamed.length).toBeGreaterThan(8);
    } finally {
      client.destroy();
    }
  });

  test.skipIf(!haveWasm)("committed blocks keep a stable reference across the stream", async () => {
    const client = new FluxClient({ pool: createNativePool({ makeParser: wasmMakeParser(Ctor) }), config: RICH_CONFIG });
    try {
      // Feed the head, let the first blocks commit, capture their references.
      for (const ch of chunk(RICH_DOC.slice(0, 120), 9)) client.append(ch);
      await client.whenReady();
      await settle();
      const early = client.getSnapshot();
      const firstId = early[0]?.id;
      const firstRef = early[0];

      // Feed the tail + finalize; the first committed block must be the SAME object.
      for (const ch of chunk(RICH_DOC.slice(120), 9)) client.append(ch);
      client.finalize();
      await settle();
      const done = client.getSnapshot();
      expect(done[0]).toBe(firstRef);
      expect(done[0].id).toBe(firstId);
    } finally {
      client.destroy();
    }
  });

  test.skipIf(!haveWasm)("reset() clears the store and restarts block ids", async () => {
    const client = new FluxClient({ pool: createNativePool({ makeParser: wasmMakeParser(Ctor) }), config: RICH_CONFIG });
    try {
      client.append("# One");
      client.finalize();
      await client.whenReady();
      await settle();
      const first = client.getSnapshot() as unknown as WireBlock[];
      expect(first.length).toBe(1);
      expect(first[0].id).toBe(0);
      expect(first[0].html).toContain("One");

      client.reset();
      expect(client.getSnapshot().length).toBe(0);

      client.append("# Two");
      client.finalize();
      await settle();
      const second = client.getSnapshot() as unknown as WireBlock[];
      expect(second.length).toBe(1);
      // Fresh parser after reset → id counter restarts at 0.
      expect(second[0].id).toBe(0);
      expect(second[0].html).toContain("Two");
    } finally {
      client.destroy();
    }
  });

  test.skipIf(!haveWasm)("metrics report no WASM heap and a delivered final patch", async () => {
    const client = new FluxClient({ pool: createNativePool({ makeParser: wasmMakeParser(Ctor) }), config: RICH_CONFIG });
    try {
      client.append("# Title\n\nBody paragraph.\n");
      client.finalize();
      await client.whenReady();
      await settle();
      const m = client.getMetrics();
      // The native shim reports memBytes() === 0 (no JS-visible WASM heap).
      expect(m.wasmMemoryBytes).toBe(0);
      expect(m.patches).toBeGreaterThan(0);
      expect(m.committedBlocks).toBeGreaterThan(0);
      expect(m.retainedBytes).toBeGreaterThan(0);
    } finally {
      client.destroy();
    }
  });
});
