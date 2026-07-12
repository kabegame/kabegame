import { defineConfig } from "@rspack/cli";

export default defineConfig({
  entry: { main: "./src/index.ts" },
  target: "es2022",
  devtool: false,
  // 仅打包不压缩:保留可读符号名,插件报错栈有意义
  optimization: { minimize: false },
  output: {
    filename: "[name].js",
    path: new URL("./dist", import.meta.url).pathname,
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
  resolve: { extensions: [".ts", ".js"], fullySpecified: false },
});
