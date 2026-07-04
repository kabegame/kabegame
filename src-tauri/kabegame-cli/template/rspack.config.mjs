import { defineConfig } from "@rspack/cli";

export default defineConfig({
  entry: { main: "./src/index.ts" },
  target: "es2022",
  output: {
    filename: "[name].js",
    path: "dist",
    library: { type: "module" },
  },
  experiments: { outputModule: true },
  externalsType: "module",
  externals: [/^@kabegame\/plugin-sdk$/, /^@kabegame\/types$/],
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
  resolve: { extensions: [".ts", ".js"] },
});
