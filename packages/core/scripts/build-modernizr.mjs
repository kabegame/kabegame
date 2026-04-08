// Build a minimal Modernizr bundle (webp + avif) into src/vendor/modernizr.js
// Run: bun run packages/core/scripts/build-modernizr.mjs
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import modernizr from "modernizr";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outFile = resolve(__dirname, "../src/vendor/modernizr.js");

const config = {
  "minify": false,
  "options": ["setClasses"],
  "feature-detects": [
    "test/img/webp",
    "test/img/avif",
  ],
};

modernizr.build(config, async (result) => {
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, result, "utf8");
  console.log("[modernizr] wrote", outFile, `(${result.length} bytes)`);
});
