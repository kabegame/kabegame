import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 只给本目录的对拍脚本（noise_xcheck.test.ts）用：root 是 apps/wpe-scene（由本文件位置推出），产品测试（src/**）不在这里跑。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export default defineConfig({
  root,
  test: { environment: "node", include: ["scripts/fixtures/*.test.ts"], testTimeout: 600_000 },
});
