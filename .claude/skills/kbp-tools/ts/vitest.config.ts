import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// kbp-tools 的回放（kbp replay / regress 经 node 拉起）：root 由本文件位置推出（仓库根，.claude/skills/kbp-tools/ts 往上四级），
// 不写死路径；测试文件在本目录，产品代码与钩子按绝对路径导入（所以 fs.strict 关掉）。
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../..");
const test = path.relative(root, path.join(here, process.env.KBP_TEST ?? "replay.test.ts")).replace(/\\/g, "/");

export default defineConfig({
  root,
  test: {
    environment: "node",
    globals: true,
    include: [test],
    testTimeout: 3_600_000,
    hookTimeout: 3_600_000,
  },
  server: { fs: { strict: false } },
});
