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

// REGRESSION: the shim MUST route listeners by event type.
//
// brookmd 0.24.0 taught BrookPool to also listen on `error` / `messageerror`,
// the browser's out-of-band worker-failure channels. This shim used to add every
// listener to one set regardless of type, so the pool's fatal handler received
// the ordinary `ready` / `patch` envelopes and read the first one as "brookmd
// worker failed to load" — killing every stream before it started. It stayed
// hidden only because this package pinned `brookmd` to ^0.23.0, which predates
// those listeners; the moment the range moved, all native transport broke.
test("the native worker delivers messages ONLY to `message` listeners", async () => {
  const pool = createNativePool({ makeParser: fakeMakeParser() });
  const messages: unknown[] = [];
  const errors: unknown[] = [];
  const messageErrors: unknown[] = [];

  // Reach the underlying WorkerLike the way the pool does.
  const { pw } = pool.acquire(() => {});
  const worker = (pw as unknown as { worker: {
    addEventListener(t: "message" | "error" | "messageerror", l: (ev: unknown) => void): void;
  } }).worker;

  worker.addEventListener("message", (ev) => messages.push(ev));
  worker.addEventListener("error", (ev) => errors.push(ev));
  worker.addEventListener("messageerror", (ev) => messageErrors.push(ev));

  await settle();

  expect(messages.length).toBeGreaterThan(0); // the ready envelope at minimum
  expect(errors).toEqual([]); // never the out-of-band failure channel
  expect(messageErrors).toEqual([]);
});
