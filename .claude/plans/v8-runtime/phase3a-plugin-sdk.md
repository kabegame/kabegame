# Phase 3a — 填充 `@kabegame/plugin-sdk`（逐点实施方案）

> Phase 3 子阶段；总览与决策见 [phase3-overview.md](./phase3-overview.md)。
> 本子阶段 **TS-only、无 cargo 改动**，与 [3b](./phase3b-core-loader.md) 可并行。
> 目标：把 Phase 2 prelude 暴露的 15 个裸 op 封装成 npm 包，补齐 Rhai 时代 host 面
> 但 Phase 1 裁到 JS 侧的工具函数与配置类型。作者 `import` 后由自己的 bundler 内联进最终 bundle。

---

## 现状锚点

**a. SDK 落点为空**：`packages/` 下无 `plugin-sdk`；`.gitmodules` 无对应条目。
根 `package.json` workspaces 已含 `"packages/*"`（新 submodule 自动纳入，**无需改根 package.json**）。

```
packages/
├── core/  i18n/  image-type/  photoswipe-vue/   # 现状：无 plugin-sdk
```

**b. Phase 2 prelude 的 15 个 `__kabegame_*`**（`src/plugin/v8/prelude.js`，即本 SDK 封装目标 / ABI 基线）：
`to / back / fetch_json / current_url / current_html / current_headers /
plugin_data / set_plugin_data / set_header / del_header / warn / add_progress /
download_image / create_image_metadata`（14）+ `log`（console 走它，不单独导出）。

**c. Phase 1 裁到 JS 侧的能力**（`phase2-prelude-entry.md` 开头说明）：DOM 解析
（`query/query_by_text/find_by_text/get_attr`）、URL 工具（`url_encode/resolve_url/is_*_url`）、
正则（`re_*`）、工具（`md5/unix_time_ms/rand_f64`）、签名（`xhh_*`）——Rust op 层不再提供，
**由 SDK 用纯 JS 实现**（裸 deno_core 无 `DOMParser` / `URL`）。

**d. `crawl(common, custom)` 配置契约**（`phase2-prelude-entry.md` 点 2 / 衔接预告）：
`common` = `KbCommonCfg`（当前 `{ base_url: string | null }`）；`custom` 由作者用 SDK
类型函数声明，与 `kbConfig` var 字段一一对应。

---

## 点 1 — submodule 落地（`.gitmodules`；空仓已建）

- **新增**：`.gitmodules` 条目 + submodule `packages/plugin-sdk` →
  `https://github.com/kabegame/kabegame-plugin-sdk`：

```ini
[submodule "packages/plugin-sdk"]
	path = packages/plugin-sdk
	url = https://github.com/kabegame/kabegame-plugin-sdk.git
```

- **不改**：根 `package.json` workspaces（`packages/*` 已覆盖）。

---

## 点 2 — SDK `package.json`（SDK 仓库内，**新增**）

- **新增**：
  - `name: "@kabegame/plugin-sdk"`、`version: "0.1.0"`、`type: "module"`；
  - **`engines.kabegame: ">=4.3.0"`** —— 即 Phase 2 prelude 15-op ABI 对应的 App 版本
    （决策 D5 单一事实源；模板与内置插件的 `engines.kabegame` 与之对齐）；
  - `exports` / `types` 指向构建产物 `dist/index.js` + `dist/index.d.ts`；
  - `scripts.build`：tsup 或 tsc 出 dist（产物随 npm 发布，作者 bundler 内联）。

---

## 点 3 — SDK `src/`：三层内容（**新增**）

- **新增 3.1 op 薄封装**（与锚点 b 一一对应，命名 camelCase）：
  `to / back / fetchJson / currentUrl / currentHtml / currentHeaders / pluginData /
  setPluginData / setHeader / delHeader / warn / addProgress / downloadImage /
  createImageMetadata` + `sleep(ms)`（封 prelude `setTimeout` shim）。
  每个仅 `(...) => globalThis.__kabegame_*(...)` 的一行转发 + TS 签名。

- **新增 3.2 JS 侧工具**（锚点 c，纯 JS 依赖随 SDK 打包进作者 bundle）：
  - DOM 解析：`query / queryByText / findByText / getAttr`（基于 `htmlparser2` + `css-select`）；
  - URL 工具：`urlEncode / resolveUrl / isHttpUrl / ...`（WHATWG `URL` 纯 JS polyfill）；
  - `md5`（纯 JS）、`unixTimeMs / randF64`、`xhh_*` 签名工具；正则直接用原生 `RegExp`（仅补便捷封装）。
  > 说明：这些能力在 Rhai 时代是 host 函数，Phase 1 已从 op 面裁掉——迁到 SDK 保持作者 API 面不变。

- **新增 3.3 类型**（锚点 d）：
  - `KbCommonCfg`：`{ base_url: string | null }`（宿主公共配置，固定结构）；
  - `kbCrawlFn<CustomCfg>`：crawl 入口函数类型，供作者写
    `export const crawl = (async (...) => { ... }) satisfies kbCrawlFn<MyCfg>`；
  - 配置声明类型函数（泛型类型别名，**非运行时函数**）：
    `kbCustomCfg<Fields>`、`kbCfgField<K, T>`、字段类型集 `kbCfgInt / kbCfgStr / kbCfgBool / kbCfgOption<...>`，
    与 `kbConfig` 的 var `type` 取值一一对应，供作者写：

```ts
type MyConfig = kbCustomCfg<[
  kbCfgField<"startPage", kbCfgInt>,
  kbCfgField<"tag", kbCfgStr>,
]>;
export async function crawl(common: KbCommonCfg, custom: MyConfig) { /* ... */ }
export const crawl2 = (async (common: KbCommonCfg, custom: MyConfig) => {
  /* ... */
}) satisfies kbCrawlFn<MyConfig>;
```

---

## 退出标准

- SDK 仓库 `bun install && bun run build` 产出 `dist/index.{js,d.ts}`；
- 类型上 `export async function crawl(common: KbCommonCfg, custom: X)` 可编译；
- 类型上 `export const crawl = (...) satisfies kbCrawlFn<X>` 可编译；
- 15 个封装的运行期行为 = 直接调用对应 `__kabegame_*`（薄封装无额外逻辑）；
- `.gitmodules` 增条目后 `git submodule update --init packages/plugin-sdk` 可拉取。

---

## 交付物清单

| 类型 | 路径 | 内容 |
|------|------|------|
| 新增 | `.gitmodules` | `packages/plugin-sdk` submodule 条目 |
| 新增 | `packages/plugin-sdk/package.json` | `@kabegame/plugin-sdk`、`engines.kabegame: ">=4.3.0"`、exports/types |
| 新增 | `packages/plugin-sdk/src/*` | 15 op 薄封装 + JS 工具（DOM/URL/md5/签名）+ 类型（`KbCommonCfg`、`kbCrawlFn`、`kbCfgField/...`） |
