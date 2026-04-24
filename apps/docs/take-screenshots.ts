import { chromium } from "playwright";
import { join } from "path";

const BASE = "http://localhost:1420";
const OUT = join(import.meta.dir, "src/assets/screenshots");

const VIEWS = [
  { url: "/gallery",        file: "gallery.png" },
  { url: "/albums",         file: "albums.png" },
  { url: "/plugin-browser", file: "plugins.png" },
  { url: "/settings",       file: "settings.png" },
  { url: "/surf",           file: "surf.png" },
];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "zh-CN" });
const page = await ctx.newPage();

for (const view of VIEWS) {
  console.log(`→ ${BASE + view.url}`);
  await page.goto(BASE + view.url);
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(OUT, view.file) });
  console.log(`  ✅ ${view.file}`);
}

await browser.close();
console.log("\nDone.");
