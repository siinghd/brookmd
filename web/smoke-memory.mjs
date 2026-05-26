import { chromium } from "playwright";

const URL = process.env.URL || "https://md.hsingh.app/";
const CORPUS_SIZE_KB = 60;
const CHUNK_SIZE = 8;
const CHUNK_INTERVAL_MS = 2;

// Build a ~80KB markdown corpus exercising the constructs both parsers care
// about. Same input both runs.
function buildCorpus() {
  let s =
    "# flux-md memory test corpus\n\nThis document exercises headings, paragraphs, lists, fenced code, blockquotes, tables, emphasis, and inline code. The two parsers both receive **the exact same bytes** so any heap-delta difference is parser cost, not data volume.\n\n";
  let i = 0;
  while (s.length < CORPUS_SIZE_KB * 1024) {
    i += 1;
    s += `\n## Section ${i}\n\nA paragraph with **bold**, *italic*, ~~strike~~, and \`inline code\`. Reference [link](https://example.com/${i}) and a footnote-like aside.\n\n- bullet one\n- bullet two with *emphasis*\n- bullet three with \`code\`\n\n\`\`\`typescript\nexport function process${i}(input: string): number {\n  const re = /(\\w+)/g;\n  let count = 0;\n  for (const m of input.matchAll(re)) {\n    count += m[1].length;\n  }\n  return count;\n}\n\`\`\`\n\n> Section ${i} blockquote: \"This is the way.\"\n\n| Col A | Col B | Col C |\n|:------|:-----:|------:|\n| a${i} | b${i} | c${i} |\n| d${i} | e${i} | f${i} |\n\n`;
  }
  return s;
}

async function gc(page) {
  await page.evaluate(() => {
    if (typeof globalThis.gc === "function") globalThis.gc();
  });
}

async function sample(page) {
  await gc(page);
  await page.waitForTimeout(400);
  return await page.evaluate(() =>
    performance.memory ? performance.memory.usedJSHeapSize : 0,
  );
}

async function runMode(mode, corpus) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--js-flags=--expose-gc", "--enable-precise-memory-info"],
  });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));

  await page.goto(URL, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForSelector(".lab-brand h1", { timeout: 5000 });
  await page.selectOption(".lab-select", { value: mode });
  await page.waitForTimeout(500);
  // Wait until the replay hook is installed.
  await page.waitForFunction(() => typeof window.__fluxReplay === "function", { timeout: 5000 });
  await page.waitForTimeout(1500);

  const baseline = await sample(page);

  // Watcher: poll for peak heap during replay.
  let peak = baseline;
  const stopWatcher = { stop: false };
  const watcher = (async () => {
    while (!stopWatcher.stop) {
      const m = await page.evaluate(() =>
        performance.memory ? performance.memory.usedJSHeapSize : 0,
      );
      if (m > peak) peak = m;
      await new Promise((r) => setTimeout(r, 60));
    }
  })();

  const replayResult = await page.evaluate(
    async ({ text, chunkSize, intervalMs }) => {
      const t0 = performance.now();
      await window.__fluxReplay(text, chunkSize, intervalMs);
      return performance.now() - t0;
    },
    { text: corpus, chunkSize: CHUNK_SIZE, intervalMs: CHUNK_INTERVAL_MS },
  );

  stopWatcher.stop = true;
  await watcher;

  // Settle: wait for any deferred work + GC.
  await page.waitForTimeout(2000);
  const settled = await sample(page);

  await browser.close();
  return { mode, baseline, peak, settled, replayMs: replayResult, bytes: corpus.length * 5, errs: errs.length };
}

const corpus = buildCorpus();
console.log(`corpus: ${(corpus.length / 1024).toFixed(1)} KB per stream × 5 streams = ${((corpus.length * 5) / 1024).toFixed(1)} KB total`);

console.log("\n[1/2] flux-md only...");
const flux = await runMode("flux", corpus);
console.log("[2/2] streamdown only...");
const sd = await runMode("streamdown", corpus);

function mb(n) {
  return (n / 1024 / 1024).toFixed(2) + " MB";
}

function report(r) {
  const dPeak = r.peak - r.baseline;
  const dSet = r.settled - r.baseline;
  console.log(`\nmode: ${r.mode}`);
  console.log(`  bytes pushed   ${(r.bytes / 1024).toFixed(1)} KB (same corpus both modes)`);
  console.log(`  replay time    ${(r.replayMs / 1000).toFixed(2)}s`);
  console.log(`  baseline heap  ${mb(r.baseline)}`);
  console.log(`  peak heap      ${mb(r.peak)}   (Δ ${mb(dPeak)})`);
  console.log(`  settled heap   ${mb(r.settled)}   (Δ ${mb(dSet)})`);
  console.log(`  peak per byte  ${(dPeak / r.bytes).toFixed(1)} bytes-heap / byte-content`);
  console.log(`  errors         ${r.errs}`);
}
report(flux);
report(sd);

const fPeak = flux.peak - flux.baseline;
const sPeak = sd.peak - sd.baseline;
const fSet = flux.settled - flux.baseline;
const sSet = sd.settled - sd.baseline;
console.log("\n=== verdict (same bytes both modes) ===");
console.log(`flux peak Δ:        ${mb(fPeak)}    settled: ${mb(fSet)}`);
console.log(`streamdown peak Δ:  ${mb(sPeak)}    settled: ${mb(sSet)}`);
console.log(`streamdown uses ${(sPeak / Math.max(1, fPeak)).toFixed(2)}× more peak heap`);
console.log(`streamdown retains ${(sSet / Math.max(1, fSet)).toFixed(2)}× more after settle`);
