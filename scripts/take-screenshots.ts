/**
 * Takes screenshots of key Kabegame UI views for docs.
 * Run: bun scripts/take-screenshots.ts
 */
import { chromium } from "playwright";
import { join } from "path";

const BASE = "http://localhost:1420";
const OUT = join(import.meta.dir, "../apps/docs/src/assets/screenshots");

const VIEWS = [
  { url: "/gallery",        file: "gallery.png",       waitFor: ".image-grid, .empty-state, [class*='gallery']" },
  { url: "/albums",         file: "albums.png",         waitFor: null },
  { url: "/plugin-browser", file: "plugins.png",        waitFor: null },
  { url: "/settings",       file: "settings.png",       waitFor: null },
  { url: "/surf",           file: "surf.png",           waitFor: null },
];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  locale: "zh-CN",
});
const page = await ctx.newPage();

for (const view of VIEWS) {
  const url = BASE + view.url;
  console.log(`→ ${url}`);
  await page.goto(url);
  // wait for network to settle (SPA data load)
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  // extra wait for animations
  await page.waitForTimeout(800);
  const outPath = join(OUT, view.file);
  await page.screenshot({ path: outPath, fullPage: false });
  console.log(`  ✅ saved ${view.file}`);
}

await browser.close();
console.log("\nAll screenshots done.");
