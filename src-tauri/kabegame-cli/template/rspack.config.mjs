import { defineConfig } from "@rspack/cli";
import { fileURLToPath } from "node:url";

export default defineConfig({
  entry: { main: "./src/index.ts" },
  target: "es2022",
  devtool: false,
  // 仅打包不压缩:保留可读符号名,插件报错栈有意义
  optimization: { minimize: false },
  output: {
    filename: "[name].js",
    // Windows 下 URL.pathname 形如 /D:/... 不是合法路径，必须经 fileURLToPath
    path: fileURLToPath(new URL("./dist", import.meta.url)),
    library: { type: "module" },
  },
  experiments: { outputModule: true },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: {
          loader: "builtin:swc-loader",
          options: {
            jsc: { parser: { syntax: "typescript" }, target: "es2022" },
          },
        },
        type: "javascript/auto",
      },
    ],
  },
  resolve: { extensions: [".ts", ".js", ".json"], fullySpecified: false },
});
