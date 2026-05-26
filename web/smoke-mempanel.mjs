import { chromium } from "playwright";

const URL = process.env.URL || "https://md.hsingh.app/";

const browser = await chromium.launch({
  headless: true,
  args: ["--js-flags=--expose-gc", "--enable-precise-memory-info"],
});
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(String(e)));

await page.goto(URL, { waitUntil: "networkidle", timeout: 30000 });
await page.waitForSelector(".lab-brand h1");
console.log("→ opening memory panel");
await page.click("button:has-text('Memory A/B')");
await page.waitForSelector(".mem-panel", { timeout: 5000 });
console.log("✓ memory panel visible");

console.log("→ selecting Quick preset");
await page.selectOption(".mem-panel select", { value: "0" });

console.log("→ clicking Run A/B (will take ~30s)");
await page.click(".mem-panel button.lab-btn-primary");

console.log("→ waiting for results...");
await page.waitForSelector(".mem-result table", { timeout: 90000 });
console.log("✓ results visible");

const rows = await page.evaluate(() => {
  const rs = document.querySelectorAll(".mem-result tbody tr");
  return Array.from(rs).map((r) => Array.from(r.children).map((c) => c.textContent?.trim() ?? ""));
});
console.log("results table:");
for (const r of rows) console.log("  ", r.join(" | "));

const verdict = await page.textContent(".mem-summary");
console.log("verdict:", verdict);

await page.screenshot({ path: "/tmp/flux-mempanel.png" });
console.log("✓ screenshot → /tmp/flux-mempanel.png");

console.log("page errors:", errs.length);
for (const e of errs.slice(0, 5)) console.log("  ✗", e);

await browser.close();
process.exit(errs.length === 0 ? 0 : 2);
