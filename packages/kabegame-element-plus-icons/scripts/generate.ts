/**
 * 从 svg/*.svg 生成 src/components/*.vue 与入口 src/components/index.ts。
 *
 * 上游（element-plus-icons）用 tsx + camelcase + consola + prettier + tinyglobby 跑这件事，
 * 且把生成物 gitignore、发布时才构建。本仓是纯源码消费、无构建步骤，故改成零依赖的 Deno
 * 脚本，生成物**入库**。svg/ 才是真源，改图标后重跑本脚本：
 *
 *   deno run -A packages/kabegame-element-plus-icons/scripts/generate.ts
 */
import { walk } from "jsr:@std/fs@^1/walk";

const here = new URL(".", import.meta.url).pathname;
const svgDir = new URL("../svg/", import.meta.url).pathname;
const outDir = new URL("../src/components/", import.meta.url).pathname;

/** `d-arrow-left` -> `DArrowLeft`，与上游 camelcase({pascalCase:true}) 的结果一致 */
function toPascalCase(filename: string): string {
  return filename
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

const names: { filename: string; componentName: string }[] = [];
for await (const entry of walk(svgDir, { exts: [".svg"], maxDepth: 1 })) {
  if (!entry.isFile) continue;
  const filename = entry.name.replace(/\.svg$/, "");
  names.push({ filename, componentName: toPascalCase(filename) });
}
names.sort((a, b) => a.filename.localeCompare(b.filename));

await Deno.remove(outDir, { recursive: true }).catch(() => {});
await Deno.mkdir(outDir, { recursive: true });

for (const { filename, componentName } of names) {
  const svg = (await Deno.readTextFile(`${svgDir}${filename}.svg`)).trim();
  const sfc = `<template>
  ${svg}
</template>

<script lang="ts" setup>
defineOptions({
  name: ${JSON.stringify(componentName)},
})
</script>
`;
  await Deno.writeTextFile(`${outDir}${filename}.vue`, sfc);
}

const entry = `// 本文件由 scripts/generate.ts 从 svg/ 生成，请勿手改。
${
  names
    .map(
      ({ filename, componentName }) =>
        `export { default as ${componentName} } from './${filename}.vue'`,
    )
    .join("\n")
}
`;
await Deno.writeTextFile(`${outDir}index.ts`, entry);

console.log(`generated ${names.length} icon components -> ${outDir}`);
console.log(`(script dir: ${here})`);
