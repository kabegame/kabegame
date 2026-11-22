import { defineConfig } from "vitest/config";
import { sceneWasmDeps } from "./wasmDeps.ts";

export default defineConfig({
  // 编译 / 渲染测试直接读 src/ 下的两个 wasm，开跑前同构建一样确保是最新的（见 wasmDeps.ts）
  plugins: [sceneWasmDeps()],
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
