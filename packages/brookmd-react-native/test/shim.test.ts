// Tests for the transport shim itself (NativeWorker → WorkerCore wiring),
// independent of the WASM parser: readiness handshake, buffered-before-ready
// appends, patch delivery, finalize, and the clear error when the on-device
// native parser has not been registered (the off-device default).
import { beforeEach, describe, expect, test } from "bun:test";
import { BrookClient } from "brookmd/client";
import type { ParserLike } from "brookmd/worker-core";
import type { ParserConfig } from "brookmd/types";
import { createBrookClient, createNativePool, __resetDefaultNativePool } from "../src/native-pool";
import { settle } from "./fixtures";

// A deterministic fake parser: it accumulates text and emits one Paragraph block
// (active while streaming, committed on finalize). No WASM, no native module.
function fakeMakeParser(): (c: ParserConfig | undefined) => ParserLike {
  return () => {
    let buf = "";
    const block = (open: boolean) => ({
      id: 0,
      kind: { type: "Paragraph" },
      start: 0,
      end: buf.length,
      html: `<p>${buf}</p>`,
      open,
      speculative: false,
    });
    return {
      append: (chunk: string) => {
        buf += chunk;
        return JSON.stringify({ newly_committed: [], active: [block(true)] });
      },
      finalize: () => JSON.stringify({ newly_committed: [block(false)], active: [] }),
      free: () => {},
      retainedBytes: () => buf.length,
    };
  };
}

beforeEach(() => {
  __resetDefaultNativePool();
});

describe("native transport shim", () => {
  test("whenReady() resolves once the in-process worker signals ready", async () => {
    const client = new BrookClient({ pool: createNativePool({ makeParser: fakeMakeParser() }) });
    await client.whenReady();
    expect(client.ready).toBe(true);
    client.destroy();
  });

  test("appends before ready are buffered, then drained and delivered", async () => {
    const client = new BrookClient({ pool: createNativePool({ makeParser: fakeMakeParser() }) });
    // Append immediately — before the deferred markReady() microtask runs.
    client.append("hello ");
    client.append("world");
    await client.whenReady();
    await settle();
    const snap = client.getSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].html).toBe("<p>hello world</p>");
    expect(snap[0].open).toBe(true);
    client.destroy();
  });

  test("finalize commits the streaming tail", async () => {
    const client = new BrookClient({ pool: createNativePool({ makeParser: fakeMakeParser() }) });
    client.append("done");
    client.finalize();
    await client.whenReady();
    await settle();
    const snap = client.getSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].open).toBe(false);
    expect(snap[0].html).toBe("<p>done</p>");
    // memBytes() is 0 in the shim; retainedBytes flows through from the parser.
    const m = client.getMetrics();
    expect(m.wasmMemoryBytes).toBe(0);
    expect(typeof m.retainedBytes).toBe("number");
    client.destroy();
  });

  test("createBrookClient wires the shared native pool", async () => {
    const client = createBrookClient({ makeParser: fakeMakeParser() });
    client.append("hi");
    client.finalize();
    await client.whenReady();
    await settle();
    expect(client.getSnapshot()[0].html).toBe("<p>hi</p>");
    client.destroy();
  });

  test("an unregistered native parser surfaces a clear, non-fatal error", async () => {
    const errors: Array<{ message: string; fatal?: boolean }> = [];
    // No makeParser + registerNativeParser never called ⇒ the default parser
    // factory throws with actionable guidance, surfaced via onError.
    const client = new BrookClient({ pool: createNativePool(), onError: (e) => errors.push(e) });
    client.append("boom");
    await client.whenReady();
    await settle();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain("native parser not registered");
    expect(errors[0].fatal ?? false).toBe(false);
    client.destroy();
  });
});
