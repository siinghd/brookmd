import { chromium } from "playwright";

const URL = process.env.URL || "https://md.hsingh.app/";
const WAIT_MS = 15000;

async function runMode(mode) {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(URL, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForSelector(".lab-brand h1", { timeout: 5000 });
  await page.selectOption(".lab-select", { value: mode });
  await page.click(".lab-btn-primary");
  await page.waitForTimeout(WAIT_MS);

  const m = await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll(".flux-hud-row"));
    const out = {};
    for (const row of labels) {
      const k = row.children[0]?.textContent?.trim();
      const v = row.children[1]?.textContent?.trim();
      if (k && v) out[k] = v;
    }
    return out;
  });
  await page.screenshot({ path: `/tmp/flux-smoke-${mode}.png`, fullPage: false });
  await browser.close();
  return { mode, metrics: m, errors: errors.length };
}

console.log("Running flux-only...");
const flux = await runMode("flux");
console.log("Running streamdown-only...");
const sd = await runMode("streamdown");

const fmt = (m) => Object.entries(m.metrics).map(([k, v]) => `${k.padEnd(15)} ${v}`).join("\n");
console.log("\n=== flux-md only ===\nerrors:", flux.errors);
console.log(fmt(flux));
console.log("\n=== Streamdown only ===\nerrors:", sd.errors);
console.log(fmt(sd));

const fluxBlocked = parseFloat(flux.metrics["main blocked"] || "0");
const sdBlocked = parseFloat(sd.metrics["main blocked"] || "0");
const fluxFps = parseFloat(flux.metrics["FPS"] || "0");
const sdFps = parseFloat(sd.metrics["FPS"] || "0");
console.log(`\nverdict: flux blocked ${fluxBlocked}ms vs streamdown ${sdBlocked}ms`);
console.log(`         flux FPS ${fluxFps} vs streamdown ${sdFps}`);
