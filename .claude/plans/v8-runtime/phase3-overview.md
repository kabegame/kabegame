# Phase 3 — SDK + CLI 打包器 + 插件清单 v3（总览 / 决策 / 契约）

> 对应总 plan [`v8-runtime-master-plan.md`](./v8-runtime-master-plan.md) 的 **Phase 3**；
> 前置：[`phase2-prelude-entry.md`](./phase2-prelude-entry.md)（prelude 15 op ABI +
> `crawl(common, custom)` 契约 + `execute_crawler_script_v8` 调度入口）。
>
> 本文是 Phase 3 的**总览**：拍板决策、v3 清单契约、子阶段划分与依赖顺序、跨子阶段退出标准。
> 各子阶段的现状锚点 + 逐点实施方案单独成文（见下方子阶段地图）。
> 验证遵循 CLAUDE.md：`cargo check`（core + cli）+ CLI 单测，不跑全量 build。

---

## 子阶段地图（依赖顺序）

```
3e types 环境 ──▶ 3a SDK ─┐（TS-only）
                          ├──▶ 3c CLI 打包器 ─────▶ 3d 内置迁移 + generate-index + 文档
3b core v3 装载 ──────────┘（导出共用纯函数，3c 依赖）
```

| 子阶段 | 文件 | 范围 | 依赖 | 独立退出闸 |
|--------|------|------|------|-----------|
| **3e** | [phase3e-types-env.md](./phase3e-types-env.md) | `@kabegame/types` submodule：headless v8 全局运行时环境 ambient 声明（15 ABI 全局 + console/timer shim） | 无（TS-only） | `tsc --noEmit` 通过；样例 tsconfig 下 `__kabegame_*` 有型、无 DOM |
| **3a** | [phase3a-plugin-sdk.md](./phase3a-plugin-sdk.md) | `@kabegame/plugin-sdk` submodule：op 封装 + JS 工具 + 类型（依赖 `@kabegame/types`） | 3e（ambient 全局） | SDK `bun run build` 出 dist；`crawl(common, custom)` / `satisfies kbCrawlFn` 类型可编译 |
| **3b** | [phase3b-core-loader.md](./phase3b-core-loader.md) | core：package.json v3 装载 + v2 兼容双轨 + 共用纯函数导出 | 无 | `cargo check -p kabegame-core`；v3 包可装、v2 包行为不变 |
| **3c** | [phase3c-cli-packer.md](./phase3c-cli-packer.md) | CLI：pack 双轨、v3 引用闭包收集、`.kabegameignore`、`plugin new` 模板 | 3b（纯函数）、3a+3e（模板依赖名） | `cargo check -p kabegame-cli`；v3/v2 pack 均通、单测绿 |
| **3d** | [phase3d-builtin-and-docs.md](./phase3d-builtin-and-docs.md) | 内置 12 插件迁 v3、`generate-index.ts`、文档、总 plan 收口 | 3b + 3c | `bun package` + `bun generate-index` 全绿 |

> 落地顺序建议：**（3e → 3a）∥ 3b → 3c → 3d**。3e/3a/3b 与 core 无相互依赖，TS 侧
> 3e（全局环境）先于 3a（SDK 消费全局）；3a 计划已完成，其 SDK 对 `@kabegame/types` 的依赖
> 属实现期接线（不回改 3a 文档，见 [3e](./phase3e-types-env.md) 点 4）。3c 依赖 3b 导出的
> 纯函数（`package_json_is_v3` / `normalize_engines_kabegame` / `validate_kb_rel_path` /
> doc 引用解析）；3d 需 3b（装载）+ 3c（打包）都就绪才能打包并回归内置插件。

---

## 本 Phase 已拍板的决策（在总 plan D1–D8 之上）

| # | 决策 | 说明 |
|---|------|------|
| P3-1 | **O1 拍板：不做 `kabegame:prepublish` 钩子**（暂缓） | CLI 仍是纯打包器，不 shell 作者构建脚本。 |
| P3-2 | **灭掉 `manifest.json` / `config.json`，package.json 单清单** | `name`/`version`/`author`/`description`/`main` 复用 npm 原生字段；kabegame 语义走 `kb*` 扩展字段。 |
| P3-3 | **包格式版本升到 3**（`kbPackageVersion: 3`） | 声明在插件 `package.json` 顶层；store index 的 `packageVersion` 同步取该值；core 侧最高支持版本 2→3。KGPG **二进制头部版本仍为 2**（meta + icon + manifest 槽布局不变，槽内 JSON 改为派生清单）。 |
| P3-4 | **minAppVersion → `engines.kabegame`** | 单一事实源（对齐 D5）。**仅支持 `>= X.Y.Z` 语法**（含可选空格），裸三段即 minAppVersion；其他写法（`^`/`~`/exact/`||` 等）一律报错。不引入 `node-semver` crate；用标准库 `str::strip_prefix` + `semver::Version::parse` 即可。 |
| P3-5 | **本次重构随 App 4.3.0 发布** | v3 格式包只有 4.3.0+ 能完整解析 ⇒ pack v3 时强制 `engines.kabegame` 归一化后 `>= 4.3.0`，缺失即报错。 |
| P3-6 | **i18n 保留：顶层扁平键** | `"name.zh"` / `"description.en"` 等直接放 package.json 顶层；`extract_manifest_text_from_flat` / `copyFlatI18nKeys` / 前端解析全部原样复用。 |
| P3-7 | **npm `name` 即默认显示名，同时必须 == 插件 id（目录名）** | 人类可读名靠 `name.zh` 等覆盖；pack 校验不一致即报错。 |
| P3-8 | **运行时保留 v2 兼容读取** | zip 内 `package.json`（`kbPackageVersion>=3`）优先，缺失回退 `manifest.json`/`config.json`。 |
| P3-9 | **CLI 双轨，按 `kbPackageVersion` 检测** | 目录 `package.json` 存在且 `kbPackageVersion>=3` → v3 打包路径；否则按 v2 旧路径打包。 |
| P3-10 | **内置 12 插件本 Phase 迁移到 v3** | manifest.json + config.json 合并进各自 package.json 后删除；脚本本体不动（迁 v8 属 Phase 6）。 |
| P3-11 | **v3 单后端单脚本，`kbBackend` 显式声明** | 入口用 npm 兼容的 `main` 字段（路径任意）；`kbBackend ∈ { "rhai", "v8", "webview" }` 必填，**不靠扩展名/文件名判定**。一个 v3 包只提供一个脚本；rhai+v8 双跑 = 发两个包（Phase 6 处理）。 |
| P3-12 | **自描述路径，不强制结构和名称** | zip **保留插件原始目录布局**；所有资源经 package.json 的 `kb*` 路径字段定位（无 `doc_root/`、`configs/`、`providers/`、`metadata_migrations/`、`templates/`、`icon.png` 目录/文件名约定）。路径一律插件根相对、禁 `..`/绝对 OS 路径。 |
| P3-13 | **doc 走 `kbDoc.[locale]`** | 值为 md 文件路径；md 内资源引用**相对 doc 文件所在目录解析**，`/` 开头**从插件根解析**。 |
| P3-14 | **迁移版本 = `kbMetadataMigrations` 数组下标 + 1** | 追加式、天然无断档，文件名完全自由；禁止中途删除/重排。 |
| P3-15 | **字段名规范化 camelCase + 正确拼写** | `kbRecommendedConfigs`（修正 Recommanded）、`kbIcon`、`kbPathQLProviders`、`kbDescriptionTemplate`、`kbMetadataMigrations`、`kbDoc`、`kbBackend`、`kbBaseUrl`、`kbConfig`、`kbPackageVersion`。 |

---

## 插件清单 v3 契约（package.json）

```jsonc
{
  // ── npm 原生字段（复用） ──
  "name": "anime-pictures",              // 必需：kebab-case，== 插件 id == 目录名 == kgpg 文件名 stem；默认显示名
  "version": "0.5.0",                    // 必需：插件版本
  "description": "anime-pictures动漫图库收集源插件", // 默认语言描述
  "author": "Kabegame",                  // 字符串或 npm 对象 { "name": ... }（取 .name）
  "main": "dist/main.js",                // 必需：入口脚本路径（任意路径/文件名）
  "engines": { "kabegame": ">=4.3.0" },  // 必需：最低 App 版本 → minAppVersion
  "private": true,

  // ── i18n：顶层扁平键（与旧 manifest.json 同形） ──
  "name.zh": "anime-pictures动漫图库",
  "name.en": "anime-pictures anime gallery",
  "description.en": "anime-pictures anime gallery crawler (tag search)",

  // ── kabegame 扩展字段 ──
  "kbPackageVersion": 3,                 // 必需：包内容格式版本（CLI/core 双轨检测依据）
  "kbBackend": "v8",                     // 必需："rhai" | "v8" | "webview"（不靠扩展名判定，P3-11）
  "kbBaseUrl": "https://anime-pictures.net",  // 可选：原 config.json 的 baseUrl
  "kbConfig": [                          // 可选：原 config.json 的 var 数组，逐字段原样
    { "key": "startPage", "type": "int", "name": "起始页面", "name.en": "Start page", "default": 0, "min": 0 }
  ],
  "kbIcon": "assets/icon.png",           // 可选：图标路径（pack 时烘进 KGPG 头部；无约定回退）
  "kbDoc": {                             // 可选：多语言文档路径；键 = "default" / "zh" / "en" / ...
    "default": "docs/doc.md",
    "zh": "docs/doc.zh.md"
  },
  "kbRecommendedConfigs": [ "presets/daily.json" ],        // 可选：推荐运行配置路径数组（原 configs/）
  "kbPathQLProviders": [ "providers/pixiv.provider.json5" ], // 可选：Provider DSL 路径数组（原 providers/）
  "kbMetadataMigrations": [              // 可选：迁移脚本路径数组；下标 i → 版本 i+1（P3-14）
    "migrations/add-tags.rhai",          // v1
    "migrations/fix-author.rhai"         // v2
  ],
  "kbDescriptionTemplate": "templates/description.ejs",    // 可选：EJS 详情模板路径（原 templates/description.ejs）

  // ── v8 工程字段（作者自用，打包器/运行时不读） ──
  "scripts": { "build": "rspack build" },
  "devDependencies": { "@kabegame/plugin-sdk": "^0.1.0", "@rspack/cli": "..." }
}
```

- **zip 内容**：`package.json`（zip 根，原样）+ `main` 脚本 + 全部 `kb*` 字段引用的文件 +
  kbDoc md 引用的本地图片（引用闭包收集，见 3c），**全部保留原始相对路径**（P3-12）。
  不再有 `manifest.json` / `config.json`，不再有任何目录名约定。
- **KGPG 头部 manifest 槽**（4096B 上限不变）：pack 时从 package.json **派生**精简清单——
  `{ name, name.*, version, description, description.*, author, minAppVersion }`。
  与旧头部 JSON 同形，`PluginManifest` 反序列化器与所有头部读取方零改动。
- **kbDoc 资源解析规则**（P3-13）：md 内 `![](img/a.png)` 相对该 md 所在目录解析；
  `![](/assets/a.png)` 从插件根解析。CLI 收集（3c）与 core 加载（3b）用同一套解析。

---

## 跨子阶段退出标准（对齐总 plan Phase 3）

1. `plugin new <name> --backend v8` 产出可构建模板：`bun install && bun run build`
   得到自包含 `dist/main.js`（SDK 内联）。（3a + 3c）
2. v3 目录 `plugin pack` 产出 `.kgpg`：头部派生清单被既有头部读取路径解析；
   `plugin import` 安装成功且 name/i18n/vars/base_url/doc/推荐配置/providers/迁移脚本
   全部来自 package.json 字段、与声明一致；doc 图片按相对/根相对规则可显示（前端零改动）。（3b + 3c）
3. v2 目录 `plugin pack`、v2 `.kgpg` 安装/加载行为不变（兼容回归）。（3b + 3c）
4. `.kabegameignore` 排除与 `!` 追加生效；引用缺失、排除掉 `main` 等自毁配置报错。（3c 单测）
5. v3 校验闸生效：`engines.kabegame` 缺失/非法/`< 4.3.0`、`name` ≠ 目录名、`kbBackend` 缺失或非法、
   kb* 路径越界（`..`）均在 pack 时报错。（3c）
6. 12 个内置插件迁移后 `bun package` + `bun generate-index` 全绿，index 条目
   `packageVersion: 3` 且带 `minAppVersion: "4.3.0"`。（3d）
7. `cargo check -p kabegame-core -p kabegame-cli` 通过（不跑全量 build）。（3b + 3c）

---

## 衔接 Phase 4 预告

- Phase 3 后 `Plugin.script` 是 `PluginScript` 枚举（v2 双脚本 / v3 `{ backend, source }`，3b），
  前端 `script_type` 由其派生（`rhai`/`js`/`v8`）；Phase 4 在调度层 match `PluginScript::V3 { backend: V8, .. }` 分支——
  `task_scheduler.rs:661` 的 `spawn_blocking` 处 drop-in 换 `execute_crawler_script_v8`，
  并逐项核对事件/计数语义（`task-log` / `add_progress` / `images-change` / `album-images-change`）。
- 运行前校验：`min_app_version`（已由 `engines.kabegame` 派生）沿用
  `task_scheduler.rs:590` 的既有拦截，无需新机制。
- Android 仍走 rhai：v3 单后端（P3-11）意味着 Phase 6 迁移内置插件时需决定各插件
  桌面 v8 包与 Android rhai 包的发布形态（同 id 分渠道 or 双 id），在 Phase 6 计划中拍板。
