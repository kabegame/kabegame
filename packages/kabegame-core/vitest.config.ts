import { defineConfig } from "vitest/config";

/**
 * @kabegame/core 的单元测试配置。
 *
 * **环境取自 `vite.config.pub.ts`**，不在这里另起一套：测试要跑在和应用一致的环境
 * 里，这也正是把入口统一到 `deno task test` 的意义——平台 define（`__WEB__` /
 * `__LINUX__` 等）由 ModePlugin 注入的环境变量算出，`@kabegame/*` alias 指向各包
 * 源码。两套配置一旦漂移，「测试通过」与「应用能跑」就脱钩了。
 *
 * 只取 `define` / `resolve` / `css` 这三块「环境」，不取 plugins：
 * - UnoCSS 按 cwd 找 `uno.config.ts`，本包没有，每次跑都会刷一行 config-not-found；
 * - `kabegame-debug-server` 是 dev server 的调试中间件，测试进程里没有意义；
 * - `build` / `publicDir` / `optimizeDeps.entries` 都指向应用包（`index.html`、
 *   仓库 `static/`），本包没有对应文件。
 *
 * 将来写组件测试时，在这里补 `plugins: [vue(), vueJsx()]` 即可（两行 import），
 * 并给那些测试文件顶部加 `// @vitest-environment jsdom`（需先装 jsdom）——不要把
 * 整包切成 jsdom，那会让这批纯函数测试慢一个数量级。
 */
export default defineConfig(async () => {
  const { default: pubConfig } = await import("../../vite.config.pub");
  const { define, resolve, css } = pubConfig;

  return {
    define,
    resolve,
    css,
    test: {
      environment: "node",
      include: ["src/**/*.test.ts"],
    },
  };
});
