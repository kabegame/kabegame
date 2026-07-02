# 嵌入式 V8 (deno_core) 插件运行时 —— 总 Plan

> 目标:用基于 `deno_core` (rusty_v8) 的嵌入式 JS 运行时**替代当前 Rhai 运行时**。
> 插件作者用 TypeScript + npm 工程开发,`import { ... } from "@kabegame/plugin-sdk"`,
> 导出 `async function crawl(...)`;作者自己 bundle 成自包含单文件,kabegame-cli
> 仅负责"打包关心的文件"(学 vsce,不绑定任何打包器)。
>
> 本文是**总 plan / 路线骨架**。各 Phase 的逐点实施方案(现状锚点 + 实施方案,带真实代码块)
> 后续单独成文,放 `cocs/crawler/V8_RUNTIME*.md` 并补 `cocs/README.md` 索引。

---

## 0. 背景与边界

### 当前存在三类"脚本",不要混淆
1. **Rhai 运行时**(本计划要替换的目标):同步、嵌在 Rust、host 函数靠 `block_on` 桥接异步。
   - 关键文件:`src-tauri/kabegame-core/src/plugin/rhai.rs`、`.../plugin/metadata_migration.rs`。
2. **WebView/CEF crawler JS**(已存在,入口 `crawl.js`):跑在真实 Chromium,每任务一个
   `crawler-<task_id>` 窗口,靠 Tauri IPC 通信。用于需要真实 DOM / 反爬的站点。
   - 关键文件:`cocs/crawler/CRAWLER_JS_FLOW.md`、`src-tauri/kabegame-core/src/crawler/webview.rs`、
     `src-tauri/kabegame/src/commands/crawler.rs`、`src-tauri/kabegame/resources/bootstrap.js`。
3. **嵌入式 V8 (deno_core) JS**(本计划新增,入口 `crawl.v8.js`):headless V8,无浏览器,
   把 Rhai 的 host API 重新实现为 deno_core ops。**替代 Rhai**;CEF 那条路保留,二者互补。

### 平台边界
- **桌面优先**(Windows / macOS / Linux):上 V8。
- **Android**:**保留 Rhai**,本期不在 Android 上 V8(rusty_v8 交叉编译/体积/内存代价大,推后)。
- **iOS**:不支持(项目既有约束)。

---

## 1. 已锁定的决策(Decision Log)

| # | 决策 | 取舍说明 |
|---|------|----------|
| D1 | 引擎底座用 **`deno_core`**(非裸 rusty_v8) | 现成 `op2` 宏 / async event-loop / module loader / snapshot,直接对照 `~/code/deno` 的 `core`。 |
| D2 | **桌面先行,Android 保留 Rhai** | 规避 V8 Android 交叉编译;两套运行时长期共存。 |
| D3 | API 形态:`import { downloadImage } from "@kabegame/plugin-sdk"` + `export async function crawl(...)` | 真异步,`await to()` 自然分页;贴合 JS 习惯。 |
| D4 | **SDK 是真实 npm 包,随 bundle 进最终 JS**;运行时只暴露裸 ops | 运行时面最小化:仅 `op_kabegame_*` + 一段把它们挂到 `globalThis.__kabegame_*` 的 prelude。SDK 是 `__kabegame_*` 的薄封装,被作者的 bundler 内联。 |
| D5 | 兼容性单一事实源:SDK `package.json` 的 **`engines.kabegame`** → manifest `minAppVersion` | `engines.kabegame` = SDK 调用的 `__kabegame_*` ABI 对应的 App 版本;pack 时校验/写入,运行时按既有 `minAppVersion` 逻辑拦截。 |
| D6 | **kabegame-cli 不绑定 rspack/任何打包器**,学 vsce:只"打包关心的文件 + `.kabegameignore`" | CLI 保持纯 Rust zip 打包器,零 Node/bundler 依赖。产出自包含 bundle 是**作者构建的职责**(模板里预置 rspack,但 CLI 不调用)。 |
| D7 | v8 后端入口文件名 `crawl.v8.js` | 与 CEF 的 `crawl.js` 不撞名;backend 检测据此区分。 |
| D8 | metadata migrations 转 JS(`v{N}.js`),契约仍 `migrate(data) -> data` | JSON/RegExp 是 JS 原生,迁移几乎不需要 host op,跑在极简 V8 即可。 |
| D9 | **插件清单 v3:package.json 自描述单清单**,灭掉 `manifest.json`/`config.json` | `name/version/author/description/main` 复用 npm 字段(i18n 顶层扁平键保留);kabegame 语义走 `kbPackageVersion: 3`、`kbBackend`、`kbBaseUrl`、`kbConfig`、`kbIcon`、`kbDoc.[locale]`、`kbRecommendedConfigs`、`kbPathQLProviders`、`kbMetadataMigrations`(下标+1=版本)、`kbDescriptionTemplate`——路径字段定位一切,**不强制结构和名称**。详见 [phase3-sdk-cli-packaging.md](./phase3-sdk-cli-packaging.md)。 |
| D10 | **v2 兼容双轨** | 运行时保留旧 .kgpg(zip 内 manifest.json/config.json)读取;CLI pack 按 `kbPackageVersion` 分流 v2/v3;KGPG 二进制头部版本仍为 2(槽内改派生清单)。 |
| D11 | **本重构随 App 4.3.0 发布** | v3 包 pack 时强制 `engines.kabegame >= 4.3.0`;内置插件迁移后 minAppVersion 一律 4.3.0。 |
| D12 | **v3 单后端单脚本**(`kbBackend ∈ rhai/v8/webview`) | 后端显式声明、不靠文件名/扩展名;rhai+v8 双跑 = 发两个包(修正早期"同包双跑"设想,发布形态 Phase 6 拍板)。 |

### 待拍板(不阻塞总 plan)
- **O1(已拍板:暂不做)**:vsce 式 `kabegame:prepublish` 钩子。CLI 保持纯打包器,不 shell 作者构建脚本;如需一条龙体验后续再议。
- **O2**:snapshot 从 Phase 2 交付降级为可选(理由与后续路径见
  [phase2-prelude-entry.md](./phase2-prelude-entry.md) 点 6:build.rs 烘焙 op 注册表需拆独立
  ops crate;prelude 极小,默认 static snapshot 已覆盖冷启大头)。若 Phase 6 实测冷启动不达标再做。

---

## 2. 目标架构(一图)

```
作者的 node 工程(自带构建,如 rspack)        kabegame-cli(纯 Rust,零 Node/打包器依赖)
─────────────────────────────────           ──────────────────────────────────────────
import { downloadImage, query, to }          plugin new --backend v8 → 吐 node+rspack 模板
  from "@kabegame/plugin-sdk";               plugin pack:
export async function crawl() {                 - schema 感知默认收集 + .kabegameignore
  await to(url);                                 - 不跑 rspack、不解析 node_modules
  const items = query(...);                      - engines.kabegame → minAppVersion 校验
  await downloadImage(...);                      - 收 dist/crawl.v8.js 等打进 .kgpg
}
        │ 作者自己 bundle(SDK 被内联)
        ▼
   dist/crawl.v8.js  ───────────────────▶    xxx.kgpg(自包含单文件入口)
                                                       │ 任务调度
                                                       ▼
运行时(deno_core,桌面):                       JsPluginRuntime
  prelude: globalThis.__kabegame_*  ───────────  #[op2(async)] op_kabegame_*
    = Deno.core.ops.op_kabegame_*;                  ↑ 唯一 Rust↔JS 边界(ABI)
  load self-contained crawl.v8.js
  取 export crawl → 调用 → run_event_loop 驱动 Promise
```

三后端共存:`script_type ∈ { rhai, webview(CEF), v8 }`,由调度层分发。

---

## 3. 分阶段路线

> 每个 Phase 标注:**目标 / 主要交付 / 退出标准**。验证遵循 CLAUDE.md:
> 用 lint 诊断(`vue-tsc` / `cargo check`)核对,不跑全量 build,除非显式要求。

### Phase 0 — Spike & 构建落地
- **目标**:验证 `deno_core` 在桌面三平台可接入、可构建。
- **主要交付**
  - 新增:`kabegame-core` 引入 `deno_core` 依赖(平台门控,非 Android)。
  - 新增:最小 `JsPluginRuntime`,跑通"一个 op + `export async function crawl` + event-loop 驱动 Promise"。
  - 新增:Win/macOS/Linux 构建验证(关注 rusty_v8 ~30–40MB 二进制增量,对照
    `cocs/build/PLATFORM_SHARED_LIBS.md` 打包流程)。
- **退出标准**:三桌面 `cargo check` 通过;最小骨架能 `await` 一个异步 op 并拿到 `crawl` 返回值。

### Phase 1 — Host op 层(对齐 Rhai API)
- **目标**:把 Rhai 全部 host 函数重写为 `op_kabegame_*`,异步 op 取代 `block_on`。
- **主要交付**
  - 新增 ops(命名统一 `op_kabegame_*`):
    - 网络/导航:`to / back / fetch_json / current_html / current_headers`
    - 解析:`query / get_attr / query_by_text`(Rust `scraper`)
    - 工具:`re_*`(regex)、`md5`、`url_encode / resolve_url`
    - 状态:`plugin_data / set_plugin_data`(对照 `cocs/crawler/PLUGIN_DATA.md`)
    - 头:`set_header / del_header`
    - 日志/控制:`warn / log`、`sleep`(async)、`add_progress`
    - 入库:`download_image`、`create_image_metadata`
  - 新增:`OpState` 装配(`DownloadQueue`、plugin_id/task_id、cancellation token、header map)。
- **退出标准**:ops 列表与 `docs/RHAI_API.md` 能力面一一对应;无 `block_on`;cancellation 可中断 async op。

### Phase 2 — JS 运行时 prelude + 入口契约
- **目标**:定死运行时与插件的契约,确保只加载**自包含单文件**(无需 ModuleLoader 解析 SDK/node_modules)。
- **主要交付**
  - 新增:运行时 prelude(极小),`globalThis.__kabegame_* = Deno.core.ops.op_kabegame_*`。
  - 新增:入口契约 = 加载 `crawl.v8.js` → 取 `export async function crawl` → 调用 → `run_event_loop`
    驱动 Promise 到完成;`print/debug` → task log;cancellation 接入 event loop(`terminate_execution`)。
  - 后置:snapshot 不纳入 Phase 2 交付;若 Phase 6 实测冷启动不达标,再按 O2 路径实现。
- **退出标准**:能加载一个自包含 bundle 并完整跑完 `crawl`,异步分页/下载/进度事件行为正确。

### Phase 3 — SDK + CLI 打包器 + 插件清单 v3
> 逐点实施方案见 [phase3-sdk-cli-packaging.md](./phase3-sdk-cli-packaging.md)(决策 D9–D12 的落地)。
- **3a 填充 `@kabegame/plugin-sdk`**(`packages/` 下 git submodule → 指向已建空仓库
  `https://github.com/kabegame/kabegame-plugin-sdk`)
  - 新增:`__kabegame_*` 的 TS 薄封装 + JS 侧工具(DOM 解析/URL/md5,纯 JS 依赖随 SDK 打包)
    + 全量类型(`KbCommonCfg`、`kbCustomCfg/kbCfgField/...`)。
  - 新增:`package.json` 的 `engines.kabegame: ">=4.3.0"`;`exports` / 类型入口。
  - 修改:`.gitmodules` 增条目(根 workspaces 已含 `packages/*`,无需改)。
- **3b 插件清单 v3(D9)+ core 双轨装载(D10)**
  - 修改:`kabegame-core` 新增 package.json → manifest/config 派生与 `load_plugin_v3_from_zip`
    (kb* 路径字段定位脚本/doc/推荐配置/providers/迁移脚本/EJS 模板;`Plugin.v8_script` 存储字段);
    v2 读取路径原样保留;store 包版本上限 2→3。
- **3c kabegame-cli = v3 打包器(纯 Rust,bundler-agnostic)**
  - 修改:pack 按 `kbPackageVersion` 双轨;v3 = **引用闭包收集**(package.json 引用的文件 +
    kbDoc md 引用图片)叠加 `.kabegameignore`(学 `.vscodeignore`);头部清单从 package.json 派生。
  - 修改:后端由 `kbBackend` 显式声明(D12),v3 不做文件名检测;不驱动构建(O1 已拍板不做)。
  - 新增:`plugin new --backend v8` 模板(node 工程:SDK 依赖、tsconfig、rspack.config、
    `src/index.ts` 带 `export async function crawl`;rhai/webview 模板同步 v3 化,删 manifest.json 模板)。
  - 新增:`engines.kabegame → minAppVersion` 校验(pack 时,强制 >= 4.3.0)。
- **3d 内置 12 插件迁移 v3 + `generate-index.ts` 跟进**(index `packageVersion: 3` + `minAppVersion`)。
- **退出标准**:`plugin new --backend v8` 产出可构建模板;作者 bundle 后 `plugin pack` 产出可安装的
  v3 `.kgpg`(manifest/config/doc/providers 全部来自 package.json 字段);v2 包行为不变;
  `.kabegameignore` 生效;`engines` 缺失/不兼容时 pack 报错;内置插件打包链全绿。

### Phase 4 — 调度集成与三后端共存
- **目标**:把 v8 接入任务调度,与 rhai / webview 并存。
- **主要交付**
  - 修改:`script_type` 分发(`src-tauri/kabegame-core/src/plugin/mod.rs` 及调度层)新增 `v8` 分支。
  - 修改:事件(`task-log` / `add_progress` / `images-change` / `album-images-change`)行为与既有后端一致
    (对照 `cocs/gallery/GALLERY_PAGINATION_AND_IMAGE_LOAD.md`、`cocs/downloader-tasks/DOWNLOADER_FLOW.md`)。
- **退出标准**:同一任务管线下三后端可分别跑通;计数/事件/刷新一致。

### Phase 5 — Metadata migrations 转 JS
- **目标**:迁移脚本从 `v{N}.rhai` 迁到 `v{N}.js`。
- **主要交付**
  - 新增:JS 迁移 runner(极简 V8;JSON/RegExp 原生,基本无需 host op)。
  - 修改:`metadata_migration.rs` 版本写入/复合去重/`metadata-migrate` 事件作用域沿用
    (对照 `cocs/crawler/METADATA_MIGRATION.md`)。
- **退出标准**:`migrate(data)->data` 契约在 JS 下等价;版本断档/去重合并行为不变。

### Phase 6 — 迁移内置插件 + 文档
- **目标**:把内置插件迁到 v8,补齐作者文档。
- **主要交付**
  - 修改:`src-crawler-plugins/` 内置插件逐个改造为 v8 工程(rhai 保留过渡期;v3 单后端单脚本,
    桌面 v8 包与 Android rhai 包的发布形态——同 id 分渠道 or 双 id——在本 Phase 拍板,见 D12)。
  - 新增/修改:`docs/RHAI_API.md` → `docs/JS_API.md`;更新 `docs/PLUGIN_FORMAT.md`、
    `docs/README_PLUGIN_DEV.md`;`cocs/README.md` 索引;第三方作者迁移指南。
- **退出标准**:至少 Pixiv 等主力插件 v8 版跑通;文档覆盖 SDK API / 打包 / `engines` / ignore。

### Phase 7 — 加固(桌面)
- **目标**:沙箱与资源治理。
- **主要交付**
  - 新增:per-task isolate、执行超时(`terminate_execution`)、heap limit callback、内存/时间预算。
  - 校核:除 ops 外无 fs/net 逃逸面;op 级 allowlist。
- **退出标准**:恶意/失控脚本可被超时与堆限拦截;无资源泄漏。

### (后置)Android
- Android 是否上 V8 单独评估;在此之前 Android 维持 Rhai 后端。

---

## 4. 风险与缓解
- **二进制体积**:rusty_v8 +30–40MB。缓解:平台门控、snapshot、release strip;对照 `PLATFORM_SHARED_LIBS.md`。
- **构建复杂度(三桌面)**:rusty_v8 预编译/链接。缓解:Phase 0 先打通 CI 三平台。
- **运行时只能加载自包含单文件**:依赖作者构建产物正确。缓解:`plugin new` 模板预置 rspack 配置;
  文档强调"产物必须自包含";pack 时可加产物自检(可选)。
- **三后端共存的语义一致性**:事件/计数/刷新。缓解:Phase 4 以既有 cocs 文档为基准逐项核对。
- **清单 v2/v3 双格式共存期一致性**:已装旧包与商店新包并存。缓解:D10 双轨读取 +
  头部派生清单与 v2 同形(头部读取方零改动);v3 校验闸(engines/name/路径)在 pack 期前置拦截。
- **ABI 漂移**:`__kabegame_*` 变更。缓解:`engines.kabegame` + `minAppVersion` 双闸;ABI 版本随 SDK 版本。

---

## 5. 关键文件锚点(开工索引)
- Rhai 运行时(替换源):`src-tauri/kabegame-core/src/plugin/rhai.rs`、`.../plugin/metadata_migration.rs`
- 插件加载/manifest/`minAppVersion`:`src-tauri/kabegame-core/src/plugin/mod.rs`(`min_app_version` ~L48)
- CLI 打包:`src-tauri/kabegame-cli/src/main.rs`(`pack_plugin` ~L556、`build_plugin_zip_bytes` ~L672、
  `maybe_run_webview_build` ~L599、`plugin new` ~L182);模板 `src-tauri/kabegame-cli/template/`
- kgpg 格式:`src-tauri/kabegame-core/src/kgpg.rs`
- 打包链:`src-crawler-plugins/package-plugin.ts` / `generate-index.ts` / `package.json`
- workspace:根 `Cargo.toml`、根 `package.json`(workspaces)、`.gitmodules`
- 参考文档:`docs/RHAI_API.md`、`docs/PLUGIN_FORMAT.md`、`cocs/crawler/*`、`cocs/build/PLATFORM_SHARED_LIBS.md`

---

## 6. 下一步
1. 本总 plan 评审定稿。
2. 拍板 O1(`kabegame:prepublish` 钩子)。
3. 写各 Phase 详细文档(`cocs/crawler/V8_RUNTIME*.md`,现状锚点 + 实施方案点 + 真实代码块),
   建议从 Phase 0–2(骨架:deno_core 接入 + op 层 + prelude/`crawl` 驱动)起。
4. 进入 Phase 0 编码。
