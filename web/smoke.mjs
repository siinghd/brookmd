import { chromium } from "playwright";

const URL = process.env.URL || "https://md.hsingh.app/";
const HEADFUL = false;

const browser = await chromium.launch({ headless: !HEADFUL });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();

const consoleErrors = [];
const pageErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});
page.on("pageerror", (e) => pageErrors.push(String(e)));

console.log("→ navigating to", URL);
await page.goto(URL, { waitUntil: "networkidle", timeout: 30000 });
console.log("✓ initial load");

// Confirm the brand rendered
await page.waitForSelector(".lab-brand h1", { timeout: 5000 });
const title = await page.textContent(".lab-brand h1");
console.log("✓ title:", title);

// Confirm 5 stream cells exist in BOTH panes (mode=both is default)
const cellCount = await page.locator(".lab-cell").count();
console.log("✓ cell count:", cellCount, "(expecting 10 = 5 flux + 5 streamdown)");
if (cellCount !== 10) throw new Error(`expected 10 cells, got ${cellCount}`);

// Click "Run"
console.log("→ clicking Run...");
await page.click(".lab-btn-primary");
console.log("✓ Run clicked");

// Wait up to 25s for actual streaming output
console.log("→ waiting for stream output...");
try {
  await page.waitForFunction(
    () => {
      const cells = document.querySelectorAll(".lab-pane-flux .lab-cell-body");
      let cellsWithContent = 0;
      cells.forEach((c) => {
        const md = c.querySelector(".flux-md");
        if (md && md.children.length > 0) cellsWithContent += 1;
      });
      return cellsWithContent >= 1;
    },
    { timeout: 25000 },
  );
  console.log("✓ flux pane received streaming output");
} catch {
  console.log("✗ flux pane never received output within 25s");
}

// Give it another 8s to accumulate
await page.waitForTimeout(8000);

// Snapshot all cells' state
const cellInfo = await page.evaluate(() => {
  const out = { flux: [], sd: [] };
  for (const c of document.querySelectorAll(".lab-pane-flux .lab-cell")) {
    const head = c.querySelector(".lab-cell-head");
    const md = c.querySelector(".flux-md");
    out.flux.push({
      head: head?.textContent?.trim() ?? "",
      blocks: md?.children?.length ?? 0,
      bytes: md?.textContent?.length ?? 0,
    });
  }
  for (const c of document.querySelectorAll(".lab-pane-sd .lab-cell")) {
    const head = c.querySelector(".lab-cell-head");
    const md = c.querySelector(".streamdown-host");
    out.sd.push({
      head: head?.textContent?.trim() ?? "",
      blocks: md?.children?.length ?? 0,
      bytes: md?.textContent?.length ?? 0,
    });
  }
  return out;
});
console.log("flux cells:");
for (const c of cellInfo.flux) console.log("  ", c);
console.log("streamdown cells:");
for (const c of cellInfo.sd) console.log("  ", c);

// Snapshot health
const health = await page.evaluate(() => {
  const fps = document.querySelectorAll(".flux-hud-value");
  return Array.from(fps).map((x) => x.textContent);
});
console.log("HUD values:", health);

await page.screenshot({ path: "/tmp/flux-smoke.png", fullPage: false });
console.log("✓ screenshot saved → /tmp/flux-smoke.png");

console.log("=== console errors:", consoleErrors.length);
for (const e of consoleErrors.slice(0, 5)) console.log("  ✗", e);
console.log("=== page errors:", pageErrors.length);
for (const e of pageErrors.slice(0, 5)) console.log("  ✗", e);

await browser.close();
process.exit(consoleErrors.length === 0 && pageErrors.length === 0 ? 0 : 2);
