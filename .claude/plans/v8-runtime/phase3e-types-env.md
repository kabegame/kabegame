# Phase 3e — `@kabegame/types`：插件全局运行时环境声明（逐点实施方案）

> Phase 3 子阶段；总览与决策见 [phase3-overview.md](./phase3-overview.md)。
> **TS-only、无 cargo 改动**，与 [3b](./phase3b-core-loader.md) 可并行。
>
> 目标：把 headless v8 后端的**全局运行时环境**（Phase 2 prelude 注入的 `globalThis.__kabegame_*`
> ABI + `console` / 定时器等 shim）声明成独立的 ambient 类型包 `@kabegame/types`。
> [3a](./phase3a-plugin-sdk.md) 的 `@kabegame/plugin-sdk` 内部薄封装引用这些全局（`() => globalThis.__kabegame_*(...)`）
> ⇒ SDK 依赖本包；[3c](./phase3c-cli-packer.md) 的 v8 模板也依赖本包（v8 无浏览器，`console`/timer
> 的 ambient 声明由本包提供）。webview 模板则改依赖 **浏览器环境**（`lib: dom` / `@types/web`），不用本包。
>
> **本子阶段不回改已完成的 3a**；3a 的 SDK 消费本包属实现细节，仅在 3a 落地的 SDK 仓库内接线。

---

## 现状锚点

**a. `@kabegame/types` 落点为空**：`packages/` 下无该包；`.gitmodules` 无条目。
用户已建空仓 `https://github.com/kabegame/kabegame-types`。根 `package.json` workspaces 已含
`"packages/*"`（新 submodule 自动纳入，**无需改根 package.json**）。

**b. Phase 2 prelude 注入的全局面**（`src/plugin/v8/prelude.js`，即本包声明目标 / ABI 基线）：
- 15 个 `globalThis.__kabegame_*`：`to / back / fetch_json / current_url / current_html /
  current_headers / plugin_data / set_plugin_data / set_header / del_header / warn /
  add_progress / download_image / create_image_metadata / log`；
- `globalThis.console`（log/info/warn/error/debug → `op_kabegame_log`）；
- `globalThis.setTimeout / clearTimeout`（基于 `Deno.core.createSystemTimer` 的 shim）。
- **无** `DOMParser` / `URL` / `fetch` 等浏览器全局（裸 deno_core，故 SDK 用纯 JS 实现，见 3a 点 3.2）。

**c. 决策**：包名 `@kabegame/types`（`@types/*` scope 归 DefinitelyTyped 无法发布，故用自家 scope）；
ambient 全局靠**包内 `declare global` + 消费方 tsconfig `types: ["@kabegame/types"]` 注入**
（非 `@types/*` 自动 typeRoots）。独立 git submodule（同 SDK）。

---

## 点 1 — submodule 落地（`.gitmodules`；空仓已建）

- **新增**：`.gitmodules` 条目 + submodule `packages/kabegame-types` →
  `https://github.com/kabegame/kabegame-types`：

```ini
[submodule "packages/kabegame-types"]
	path = packages/kabegame-types
	url = https://github.com/kabegame/kabegame-types.git
```

- **不改**：根 `package.json` workspaces（`packages/*` 已覆盖）。
  > 目录名取 `packages/kabegame-types`，包名 `@kabegame/types`（与 SDK 的 `packages/plugin-sdk`
  > 目录 / `@kabegame/plugin-sdk` 包名同构）。

---

## 点 2 — `@kabegame/types` `package.json`（仓库内，**新增**）

- **新增**：
  - `name: "@kabegame/types"`、`version: "0.1.0"`、`type: "module"`；
  - **`engines.kabegame: ">=4.3.0"`** —— 与 SDK 同锚（ABI 基线，决策 D5）；
  - 纯声明包：`types: "./index.d.ts"`、`exports` 指向 `./index.d.ts`；
    无运行时产物（`main` 可省或指向空模块）；无 `build` 或仅类型检查。

---

## 点 3 — ambient 声明（`index.d.ts`，**新增**）

- **新增 3.1 ABI 全局**（`declare global`，与锚点 b 的 15 op 一一对应，带精确签名，
  这份签名 = `engines.kabegame` 对应的 ABI 事实源）：

```ts
declare global {
  // 网络 / 导航（async）
  function __kabegame_to(url: string): Promise<void>;
  function __kabegame_back(): Promise<void>;
  function __kabegame_fetch_json(url: string): Promise<unknown>;
  function __kabegame_current_url(): Promise<string>;
  function __kabegame_current_html(): Promise<string>;
  function __kabegame_current_headers(): Promise<Record<string, string>>;
  // 状态 / 头 / 日志 / 进度（sync）
  function __kabegame_plugin_data(): unknown;
  function __kabegame_set_plugin_data(map: unknown): void;
  function __kabegame_set_header(k: string, v: string): void;
  function __kabegame_del_header(k: string): void;
  function __kabegame_warn(msg: string): void;
  function __kabegame_add_progress(n: number): void;
  function __kabegame_log(level: string, msg: string): void;
  // 入库
  function __kabegame_download_image(url: string, opts?: unknown): Promise<unknown>;
  function __kabegame_create_image_metadata(map: unknown, opts?: unknown): void;
}
export {};
```

- **新增 3.2 v8 运行时 shim 全局**（浏览器 `lib` 缺席时补最小面，与锚点 b 一致）：
  `console`（`log/info/warn/error/debug`）、`setTimeout(cb, ms?, ...args): number`、`clearTimeout(id: number)`。
  > 只声明 prelude 真实提供的成员，不引入完整 `lib.dom`（避免误导作者用不存在的浏览器 API）。

- **约束**：本包**只含 ambient 全局**，不含可 `import` 的值/类型；
  配置声明类型（`KbCommonCfg` / `kbCfgField` / `kbCrawlFn` …）留在 3a 的 `@kabegame/plugin-sdk`
  （那些是 `import` 的 API，不是全局环境）。

---

## 点 4 — 消费方接线（**说明**，落在各自子阶段，本文不重复实现）

- **`@kabegame/plugin-sdk`（3a 仓库内，实现期接）**：`package.json` 加
  `dependencies: { "@kabegame/types": "^0.1.0" }`；SDK 的 tsconfig `types` 含 `"@kabegame/types"`，
  使其 `.d.ts` 编译时能解析 `globalThis.__kabegame_*`。**不回改 3a 计划文档。**
- **v8 模板（3c 点 5）**：`devDependencies` 含 `@kabegame/types` + `@kabegame/plugin-sdk`；
  `tsconfig.json` 的 `compilerOptions.types = ["@kabegame/types"]`、`lib = ["ES2022"]`（不含 DOM）。
- **webview 模板（3c 点 5）**：不依赖本包；`tsconfig` `lib = ["ES2022", "DOM", "DOM.Iterable"]`
  （+ 可选 `@types/web`），因 webview 跑在真实 Chromium。

---

## 退出标准

- `@kabegame/types` 仓库 `bun install` + `tsc --noEmit` 通过（纯 `.d.ts` 校验）；
- 在一个开 `types: ["@kabegame/types"]` 的样例 tsconfig 下，`__kabegame_to("x")` 类型为
  `Promise<void>`、`console.log` / `setTimeout` 可用、`document`/`URL` 不可用（验证不含 DOM）；
- `.gitmodules` 增条目后 `git submodule update --init packages/kabegame-types` 可拉取。

---

## 交付物清单

| 类型 | 路径 | 内容 |
|------|------|------|
| 新增 | `.gitmodules` | `packages/kabegame-types` submodule 条目 |
| 新增 | `packages/kabegame-types/package.json` | `@kabegame/types`、`engines.kabegame: ">=4.3.0"`、`types`/`exports` 指向 `index.d.ts` |
| 新增 | `packages/kabegame-types/index.d.ts` | 15 ABI 全局 `declare global` + `console`/`setTimeout`/`clearTimeout` shim 声明 |

> 消费方改动（SDK 依赖、v8/webview 模板 tsconfig 与 deps）分别落在 3a 仓库实现与 [3c 点 5](./phase3c-cli-packer.md)，本文不重复。
