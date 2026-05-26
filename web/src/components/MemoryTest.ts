/**
 * In-page memory A/B test driver. Runs the same deterministic replay
 * smoke-memory.mjs uses, but inside the live page so the user can see
 * the comparison without leaving the browser. Measures `performance.memory`
 * before/during/after a streamed corpus, for both modes back-to-back.
 *
 * Two callbacks:
 *   - onProgress(label): user-facing status
 *   - onResult(MemoryResult): final numbers
 */

export interface MemoryRunResult {
  bytesPushed: number;
  replayMs: number;
  baselineMB: number;
  peakMB: number;
  settledMB: number;
  peakDeltaMB: number;
  settledDeltaMB: number;
}

export interface MemoryResult {
  flux: MemoryRunResult;
  streamdown: MemoryRunResult;
  corpusBytes: number;
  ratioPeak: number;
  ratioSettled: number;
}

const NUM_STREAMS = 5;

interface MemoryApi {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

function readHeap(): number {
  const m = (performance as unknown as { memory?: MemoryApi }).memory;
  return m ? m.usedJSHeapSize : 0;
}

async function tryGc(): Promise<void> {
  const w = window as unknown as { gc?: () => void };
  if (typeof w.gc === "function") {
    w.gc();
  }
  // Two animation frames lets pending work settle into a measurable state.
  await new Promise((r) => requestAnimationFrame(() => r(undefined)));
  await new Promise((r) => requestAnimationFrame(() => r(undefined)));
}

async function settle(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
  await tryGc();
}

export function buildCorpus(targetKB: number): string {
  let s =
    "# flux-md memory test\n\nIdentical bytes both modes. Any heap-delta difference is parser cost.\n\n";
  let i = 0;
  while (s.length < targetKB * 1024) {
    i += 1;
    s += `\n## Section ${i}\n\nA paragraph with **bold**, *italic*, ~~strike~~, and \`inline code\`. Reference [link](https://example.com/${i}).\n\n- item one\n- item two with *emphasis*\n- item three with \`code()\`\n\n\`\`\`typescript\nexport function process${i}(input: string): number {\n  const re = /(\\w+)/g;\n  let count = 0;\n  for (const m of input.matchAll(re)) {\n    count += m[1].length;\n  }\n  return count;\n}\n\`\`\`\n\n> Section ${i}: a quote.\n\n| Col A | Col B | Col C |\n|:------|:-----:|------:|\n| a${i} | b${i} | c${i} |\n| d${i} | e${i} | f${i} |\n\n`;
  }
  return s;
}

async function measureOne(
  setMode: (m: "flux" | "streamdown") => void,
  mode: "flux" | "streamdown",
  corpus: string,
  chunkSize: number,
  intervalMs: number,
  onProgress: (msg: string) => void,
): Promise<MemoryRunResult> {
  onProgress(`Preparing ${mode}…`);
  setMode(mode);
  await settle(800);

  const baseline = readHeap();
  let peak = baseline;
  let stop = false;
  const sampler = (async () => {
    while (!stop) {
      const h = readHeap();
      if (h > peak) peak = h;
      await new Promise((r) => setTimeout(r, 50));
    }
  })();

  onProgress(`Streaming corpus into ${mode}…`);
  const replay = (window as any).__fluxReplay as
    | ((text: string, chunkSize: number, intervalMs: number) => Promise<void>)
    | undefined;
  if (!replay) throw new Error("__fluxReplay hook missing");
  const t0 = performance.now();
  await replay(corpus, chunkSize, intervalMs);
  const replayMs = performance.now() - t0;
  stop = true;
  await sampler;

  onProgress(`Letting ${mode} settle…`);
  await settle(1200);
  const settled = readHeap();

  return {
    bytesPushed: corpus.length * NUM_STREAMS,
    replayMs,
    baselineMB: baseline / 1024 / 1024,
    peakMB: peak / 1024 / 1024,
    settledMB: settled / 1024 / 1024,
    peakDeltaMB: Math.max(0, peak - baseline) / 1024 / 1024,
    settledDeltaMB: Math.max(0, settled - baseline) / 1024 / 1024,
  };
}

export async function runMemoryTest(opts: {
  corpusKB: number;
  chunkSize: number;
  intervalMs: number;
  setMode: (m: "flux" | "streamdown") => void;
  resetAll: () => void;
  onProgress: (msg: string) => void;
}): Promise<MemoryResult> {
  const { corpusKB, chunkSize, intervalMs, setMode, resetAll, onProgress } = opts;
  const corpus = buildCorpus(corpusKB);

  // Run flux first.
  opts.resetAll();
  await settle(400);
  const flux = await measureOne(setMode, "flux", corpus, chunkSize, intervalMs, onProgress);

  // Aggressively reset between runs so flux's retained heap doesn't bias
  // streamdown's baseline.
  resetAll();
  await settle(1500);

  const streamdown = await measureOne(
    setMode,
    "streamdown",
    corpus,
    chunkSize,
    intervalMs,
    onProgress,
  );

  onProgress("");

  return {
    flux,
    streamdown,
    corpusBytes: corpus.length * NUM_STREAMS,
    ratioPeak: streamdown.peakDeltaMB / Math.max(0.001, flux.peakDeltaMB),
    ratioSettled: streamdown.settledDeltaMB / Math.max(0.001, flux.settledDeltaMB),
  };
}
