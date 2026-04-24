# Kabegame Starlight 文档目录树 · 调研任务单

## Context

现状：`apps/docs/` 是 Starlight 单语言站点（`zh-CN`，`defaultLocale: 'root'`），当前 sidebar 分三组：`用户指南 (guide/, 8 篇)`、`快捷键参考 (shortcuts)`、`插件开发 (dev/, 3 篇)`。既有页面多为 stub 或 basic 级别，未系统覆盖：安装、设置全貌、Android 差异、畅游 (Surf)、故障排查，以及 reference 型查阅内容。仓库内另有两处已有稿件可被吸收 —— `docs/` 根（`PLUGIN_FORMAT.md` / `RHAI_API.md` / `CRAWLER_BACKENDS.md` 等）和 `cocs/`（架构/流程索引，大多是内部视角）。

目标：设计一棵面向 **最终用户 + 插件作者** 的完整 Starlight 目录树，分 `guide / dev / reference` 三大 sidebar 分组（**`i18n` 分组已按用户意见去除**），为每篇文档列出调研路径，但 **不写正文**。Reference 里的 `plugin-schema` 与 `rhai-dictionary` 本轮只占位，后续维护。

IMPORTANT: 截图留空后面人工补充，但不能没有截图空位

不做：
- 不写项目内部开发文档（不涉及 Tauri IPC 索引、AppSettings Rust schema、构建系统 `scripts/run.ts`、内部架构图）。
- 不做 Starlight 站点多语言镜像（`i18n` 仅作为曾考虑项，本轮去除）。

---

## 约定

每条目结构：

> **标题** — `docs slug`  
> 读者：...  
> 需调研代码路径：...  
> 依赖 `cocs/` / `docs/` 文档：...  
> 迁移来源 / 备注：...

下方 `apps/docs/src/content/docs/` 简写为 `docs/`，仓库根 `docs/` 写作 `/docs/`。

---

## 一、guide/ — 面向最终用户

### 1. 入门

- **首页** — `docs/index.mdx`（已有，建议复核）  
  读者：访客、新用户。  
  调研：`apps/docs/src/content/docs/index.mdx`、各 README（en/ja/ko/zh-CN）首屏。  
  cocs：无。  
  备注：确认是否添加「先装插件」导航提示。

- **安装与首次启动** — `docs/guide/installation.md`（新建）  
  读者：初次使用者（Win / macOS / Linux / Android）。  
  调研：仓库根 `README*.md` 的安装段、`src-tauri/app-main/tauri.conf.json`（bundle targets）、`src-tauri-plugins/tauri-plugin-pathes`（用户数据目录在各平台的路径）、Release workflow（`.github/workflows/*` 中的 artifact 种类）。  
  cocs：无。  
  备注：含各平台数据目录位置、虚拟盘所需依赖提示（Dokan / macFUSE / FUSE），不含编译步骤。

- **快速上手** — `docs/guide/quickstart.md`（新建）  
  读者：刚装好的用户。  
  调研：`apps/main/src/views/*`（首屏、空态 UI）、`packages/i18n` onboarding 文案 key。  
  cocs：无。  
  备注：串联 "装插件 → 跑任务 → 看画廊 → 设为壁纸" 的最短路径。

### 2. 浏览与组织

- **画廊** — `docs/guide/gallery.md`（已有，扩展）  
  读者：用户。  
  调研：`apps/main/src/views/Gallery.vue`、`apps/main/src/components/GalleryToolbar.vue`、`apps/main/src/stores/galleryRoute.ts`、`packages/core/src/components/image/ImageGrid.vue`、设置中画廊列数 / 每页条数。  
  cocs：仅做功能印证，不泄露内部实现 → `gallery/GALLERY_PAGINATION_AND_IMAGE_LOAD.md` 里的 "每页 100/500/1000"、无限滚动、列表不带 metadata 的提示可作为 UI 行为说明依据。  
  备注：排序 / 过滤 / 选择模式 / 预览 / 去重的用户侧说明。

- **畅游 Surf** — `docs/guide/surf.md`（新建）  
  读者：用户。  
  调研：`apps/main/src/views/SurfImages.vue`、`src-tauri/app-main/src/commands/surf.rs`、`packages/i18n/src/locales/*/surf.json`（文案决定特性面）。  
  cocs：无直接命中；若与 provider 查询共享路径，间接参考 `gallery/PROVIDER_IMAGEQUERY_COMPOSABLE.md`。  
  备注：畅游模式与画廊的区别、适用场景。

- **画册** — `docs/guide/albums.md`（已有，扩展）  
  读者：用户。  
  调研：`apps/main/src/views/AlbumDetail.vue`、`apps/main/src/components/AlbumDetailBrowseToolbar.vue`、`apps/main/src/stores/albumDetailRoute.ts`、`apps/main/src/utils/albumPath.ts`、添加 / 移除图片的 composable（`useImageOperations.ts`）。  
  cocs：`gallery/GALLERY_PAGINATION_AND_IMAGE_LOAD.md` 中 `album-images-change` 事件侧信息，仅作为 "改动后列表会刷新" 的行为兜底。  
  备注：创建画册、批量加入、封面、导出。

- **任务** — `docs/guide/tasks.md`（已有，扩展）  
  读者：下载任务管理者。  
  调研：`apps/main/src/views/TaskDetail.vue`、`apps/main/src/components/header/TaskDetailPageHeader.vue`、`apps/main/src/stores/taskDetailRoute.ts`、任务抽屉组件、设置里的并发 / 重试选项。  
  cocs：`downloader-tasks/DOWNLOADER_FLOW.md`（用户视角挑 "状态流转 / 重试 / 去重计数"）、`downloader-tasks/TASK_DRAWER_LOAD.md`（抽屉触底加载体验）。  
  备注：只讲用户面可见的状态 / 操作，不讲内部事件总线。

### 3. 壁纸与系统集成

- **壁纸** — `docs/guide/wallpaper.md`（已有，扩展）  
  读者：桌面壁纸用户。  
  调研：`apps/main/src/wallpaper.ts`、`src-tauri-plugins/tauri-plugin-wallpaper/`、`src-tauri/app-main/src/commands/wallpaper.rs`、`src-tauri/app-main/src/commands/wallpaper_engine.rs`。  
  cocs：无。  
  备注：单张 vs 轮播、Wallpaper Engine 集成、Android 锁屏等分别讲清适用平台。

- **虚拟盘** — `docs/guide/virtual-drive.md`（已有，扩展）  
  读者：Win / macOS / Linux 用户。  
  调研：虚拟盘挂载相关 Rust 模块（在 `src-tauri/core/` 或 `src-tauri/app-main/` 下，按 Dokan / macFUSE / FUSE 三端分别定位；通过 grep `dokan` / `fuser` / `macfuse` 找入口）、`tauri-plugin-pathes` 里数据目录。  
  cocs：无。  
  备注：前置依赖安装、驱动盘符、Android 不支持说明。

- **托盘** — `docs/guide/tray.md`（已有，扩展）  
  读者：桌面用户。  
  调研：`src-tauri/app-main/src/` 下 tray 相关入口（grep `TrayIcon` / `tray_handler`）、`tauri.conf.json` tray 配置。  
  cocs：无。  
  备注：菜单项、左右键差异、Linux 兼容性提示。

### 4. 插件与设置

- **插件（使用侧）** — `docs/guide/plugins-usage.md`（已有，扩展）  
  读者：用户。  
  调研：`apps/main/src/views/Settings.vue` 插件管理段、`apps/main/src/stores/plugins*`（插件商店 / 已装插件 store，按文件名 grep）、`src-tauri/app-main/src/commands/plugin.rs`、插件详情 iframe（`PLUGIN_DESCRIPTION_TEMPLATE_BRIDGE.md` 的用户可见部分：详情页、按钮、配置）。  
  cocs：`plugins/PLUGIN_STORE_CACHE.md`（只抽 "插件列表何时更新" 的用户侧说明）、`plugins/PLUGIN_DESCRIPTION_TEMPLATE_BRIDGE.md`（详情页能做什么）。  
  备注：安装 / 更新 / 卸载 / 配置 / 登录态（Cookie 注入）等操作视角；不讲 kgpg 打包。

- **设置概览** — `docs/guide/settings.md`（新建）  
  读者：用户。  
  调研：`apps/main/src/views/Settings.vue`、`apps/main/src/settings/quickSettingsRegistry.ts`、`apps/main/src/components/settings/items/*`、`packages/core/src/stores/settings.ts` 中可见字段名 → i18n key 映射、`packages/i18n/src/locales/*/settings.json`。  
  cocs：无。  
  备注：按设置面板分组讲；每个 toggle 的用户影响，不讲存储/迁移机制。

### 5. MCP 集成

- **MCP 总览** — `docs/guide/mcp.md`（新建）  
  读者：想让 AI 助手（Claude Desktop / Cursor 等 MCP Host）读自己画廊的用户。  
  调研：`src-tauri/app-main/src/mcp_server.rs` 开头的 `MCP_INSTRUCTIONS` 长说明（六大 URI scheme：`provider://` / `image://` / `album://` / `task://` / `surf://` / `plugin://`）、默认端口 `MCP_PORT = 7490`、`tauri.conf.json` 里 MCP 启停配置（grep `mcp`）、设置面板内 MCP 开关（若有，搜 `settings.json` 的 i18n key）。  
  cocs：`gallery/PROVIDER_IMAGEQUERY_COMPOSABLE.md`（Provider 路径语法是 MCP `provider://` 的基础，用户需理解路径结构）、`gallery/GALLERY_PAGINATION_AND_IMAGE_LOAD.md`（分页规则同步适用于 MCP）。  
  备注：什么是 MCP、开启 MCP 服务、端口 / 本地回环限制、如何连入 Host。

- **安装 `.mcpb` Bundle** — `docs/guide/mcp-bundle.md`（新建）  
  读者：Claude Desktop 及兼容 MCPB Host 用户。  
  调研：`mcpb/kabegame-gallery-node/README.md`（既有 thorough 指引，迁移整理）、`mcpb/kabegame-gallery-node/manifest.json`（三个 tool + user_config 字段）、`mcpb/kabegame-gallery-node/server/index.js`（工具实现、超时、host 限制）、`mcpb/kabegame-gallery-node/scripts/check-manifest.js`。  
  cocs：无。  
  备注：`mcpb pack` 打包流程、`user_config`（endpoint / timeout / debug）映射到环境变量、导入 Host 后的验证步骤、安全约束（仅 `127.0.0.1` / `localhost` / `::1`）。

### 6. 平台差异与排障

- **Android 专版说明** — `docs/guide/android.md`（新建）  
  读者：Android 用户。  
  调研：`apps/main/src` 中的 `v-if` / capacitor-like 平台判断、`src-tauri-plugins/tauri-plugin-picker`、`.../tauri-plugin-share`、`.../tauri-plugin-compress`、`.../tauri-plugin-task-notification`、`.../tauri-plugin-wallpaper`、`useModalBack` 的用户面含义（返回键行为）。  
  cocs：无。  
  备注：简化 UI、分享 / 压缩流程、系统返回键体验、无虚拟盘 / 无 CLI 等限制。

- **故障排查 / FAQ** — `docs/guide/troubleshooting.md`（新建）  
  读者：卡壳用户。  
  调研：日志目录（从 `tauri-plugin-pathes` 得到）、常见错误 toast 文案（grep `packages/i18n/src/locales/*/error.json` 或类似）、`src-tauri/app-main/src/commands/` 各模块错误分支、`tauri/TAURI_ACL_PERMISSION_SYSTEM.md` 中用户可能遇到的 "命令被拒" 表现。  
  cocs：`tauri/TAURI_ACL_PERMISSION_SYSTEM.md`（仅用户面症状）。  
  备注：日志怎么取、常见症状 → 自救步骤（代理、权限、磁盘、字体）。

---

## 二、dev/ — 面向插件作者（非项目开发者）

- **插件开发总览** — `docs/dev/overview.md`（已有，审阅结构）  
  读者：想写爬虫插件的第三方。  
  调研：`src-crawler-plugins/README.md`（9 个内置插件目录）、任一内置插件的目录骨架（`manifest.json` / `config.json` / `crawl.rhai` / `configs/` / `doc_root/`）、`src-crawler-plugins/` 下的 `bun package` / `bun generate-index` 脚本。  
  cocs：`crawler/CRAWLER_JS_FLOW.md`（仅挑选对插件作者可见的调度概念，如登录态、分页游标）。  
  备注：项目结构 / 开发循环 / 本地加载（dev `--mode local`）指路，不涉及项目 build 流水线。

- **插件格式（`.kgpg`）教程** — `docs/dev/format.md`（已有，审阅结构）  
  读者：插件作者。  
  调研：`/docs/PLUGIN_FORMAT.md`（仓库根，已有 thorough 版本作为基础）、Rust 侧 kgpg 解析入口（grep `kgpg`，位于 `src-tauri/core/src/plugin/` 下）、v1 / v2 header 代码路径。  
  cocs：`plugins/PLUGIN_DESCRIPTION_TEMPLATE_BRIDGE.md`（EJS 模板部分属于格式的延伸）。  
  备注：教程体；字段精确定义统一放到 reference/plugin-schema。

- **Rhai 脚本指南** — `docs/dev/rhai-api.md`（已有，审阅结构）  
  读者：插件作者。  
  调研：`/docs/RHAI_API.md`（仓库根既有 thorough 版本）、`src-tauri/core/src/plugin/rhai.rs`（函数注册位点）、示例插件（pixiv / konachan）中典型模式。  
  cocs：`crawler/PIXIV_METADATA.md`（metadata 白名单入库规则，作者需知晓）、`crawler/PIXIV_RANKING_RHAI.md`（分页 / `next` / `warn` 模式范例）。  
  备注：教程体；函数签名参考放到 reference/rhai-dictionary。

- **爬虫后端选择** — `docs/dev/crawler-backends.md`（新建）  
  读者：插件作者。  
  调研：`/docs/CRAWLER_BACKENDS.md`（已有现成稿件，迁移整理）、`src-tauri/core/src/crawler/` 下 Rhai vs WebView 入口。  
  cocs：无。  
  备注：什么时候必须在 WebView 里跑、什么时候纯 HTTP 够用、Android 限制。

- **打包与发布** — `docs/dev/packaging.md`（新建）  
  读者：插件作者。  
  调研：`src-crawler-plugins/package.json` 脚本、`bun package` / `bun generate-index` 实现（`src-crawler-plugins/scripts/*`）、插件 store index 格式（通过 `stores/plugins` 或 `plugin.rs` grep index json）。  
  cocs：`plugins/PLUGIN_STORE_CACHE.md`（作者侧关心的 "发布后多久生效"）。  
  备注：从本地 `--mode local` 测试 → 打包 → 放到 store index 的流程。

---

## 三、reference/ — 查阅型参考

> 新建顶层 sidebar 分组 `参考`，容纳现快捷键页并扩充。两个带 "版本要求" 列的页暂留占位，后续维护。

- **键盘快捷键一览** — `docs/reference/shortcuts.md`（从 `guide/shortcuts.md` 迁移）  
  读者：所有用户。  
  调研：快捷键注册处（grep `useKeyboardShortcut` / `keyboard` composable，疑在 `apps/main/src/composables/` 或 `packages/core/src/composables/`）、`apps/main/src/utils/` 快捷键工具、平台差异代码（Cmd vs Ctrl）。  
  cocs：无。  
  备注：按视图（画廊 / 预览 / 任务 / 全局）分组列表；注明 Android / 桌面差异。

- **kabegame-cli 用法** — `docs/reference/cli.md`（从 `guide/command-line.md` 迁移、扩展）  
  读者：脚本 / 自动化场景用户。  
  调研：`src-tauri/app-cli/src/main.rs`、`src-tauri/app-cli/src/commands/*`（clap 定义）、`src-tauri/app-cli/Cargo.toml`。**不** 覆盖 `scripts/run.ts` 的 dev build flags。  
  cocs：无。  
  备注：子命令 / 选项 / 退出码；含最小示例脚本。

- **插件清单与格式字段（占位）** — `docs/reference/plugin-schema.md`（新建，占位）  
  读者：插件作者 / 维护者。  
  调研待后续补齐：`src-tauri/core/src/plugin/` 下 `manifest` / `config` 的 Rust struct（serde 字段名），`/docs/PLUGIN_FORMAT.md` 已有字段清单作为起点。  
  cocs：无。  
  备注：本轮只建页面 + 目录占位，包含 "字段 / 类型 / 是否必填 / 最低 kabegame 版本" 列。content 留 TBD。

- **Rhai API 字典（占位）** — `docs/reference/rhai-dictionary.md`（新建，占位）  
  读者：插件作者。  
  调研待后续补齐：`src-tauri/core/src/plugin/rhai.rs` 注册列表（以此为 source of truth），交叉参照 `/docs/RHAI_API.md`。  
  cocs：无。  
  备注：本轮只建页面 + 表格骨架，包含 "函数 / 签名 / since 版本" 列。content 留 TBD。

- **MCP URI / 工具参考** — `docs/reference/mcp.md`（新建）  
  读者：写 MCP Host prompt / 自研客户端的用户。  
  调研：`src-tauri/app-main/src/mcp_server.rs`（`MCP_INSTRUCTIONS` 常量 + `ListToolsResult` / `ListResourcesResult` / `ListResourceTemplatesResult` 实现；写工具通过 grep `CallToolRequestParams` 分支定位）、`mcpb/kabegame-gallery-node/manifest.json` 的 `tools[]`、`mcpb/kabegame-gallery-node/server/index.js` 的入参 schema。  
  cocs：`gallery/PROVIDER_IMAGEQUERY_COMPOSABLE.md`（Provider 路径语法）、`gallery/GALLERY_PAGINATION_AND_IMAGE_LOAD.md`（分页边界值：page size、`page 0 invalid`）。  
  备注：含六个 URI scheme 表（path 形态 / Entry vs List / `?without=` 约束）、三个 MCPB 工具 schema、MCP HTTP endpoint 端口与版本兼容矩阵（"since 版本"列，本轮可填 TBD）。

---

## 四、sidebar 与配置改动

需要改的文件：`apps/docs/astro.config.mjs`。

- 现有 `用户指南` 分组：补齐 `installation / quickstart / surf / mcp / mcp-bundle / android / settings / troubleshooting`，并把现有项排序成 "入门 → 浏览 → 壁纸与系统 → 插件 → MCP → 平台与排障"。
- 现有 `快捷键参考` 分组：删除，挪到新 `参考` 分组。
- 新增 `参考` 分组：`shortcuts / cli / plugin-schema / rhai-dictionary / mcp`。
- 新增 `插件开发` 下增加 `crawler-backends / packaging`。

---

## 五、落地验证

1. `bun --cwd apps/docs dev` 起本地 Starlight，肉眼确认 sidebar 四组（用户指南 / 参考 / 插件开发 + 首页）正确显示，所有新路由返回 200。
2. 占位页 (`plugin-schema` / `rhai-dictionary`) 渲染成 "TBD" 卡片但不报 broken link。
3. 旧 `guide/shortcuts` 和 `guide/command-line` 路由保留 302 / 页面提示跳转到新 reference 位置（Starlight `redirects` 字段）。
4. `bun --cwd apps/docs build` 能通过，`dist/` 产物里每个新 slug 都有对应 HTML。

## 六、依赖的 cocs/ 文档映射汇总

仅以下 cocs 文档会被用户向文档引用（作为行为依据，不复制内部细节）：

| cocs 文档 | 被引用页 |
|---|---|
| `gallery/GALLERY_PAGINATION_AND_IMAGE_LOAD.md` | guide/gallery, guide/albums |
| `gallery/PROVIDER_IMAGEQUERY_COMPOSABLE.md` | guide/surf（可选） |
| `downloader-tasks/DOWNLOADER_FLOW.md` | guide/tasks |
| `downloader-tasks/TASK_DRAWER_LOAD.md` | guide/tasks |
| `plugins/PLUGIN_STORE_CACHE.md` | guide/plugins-usage, dev/packaging |
| `plugins/PLUGIN_DESCRIPTION_TEMPLATE_BRIDGE.md` | guide/plugins-usage, dev/format |
| `crawler/CRAWLER_JS_FLOW.md` | dev/overview |
| `crawler/PIXIV_METADATA.md` | dev/rhai-api |
| `crawler/PIXIV_RANKING_RHAI.md` | dev/rhai-api |
| `tauri/TAURI_ACL_PERMISSION_SYSTEM.md` | guide/troubleshooting |
| `gallery/PROVIDER_IMAGEQUERY_COMPOSABLE.md` | guide/mcp, reference/mcp |
| `gallery/GALLERY_PAGINATION_AND_IMAGE_LOAD.md` | reference/mcp（分页边界）|
| `i18n/I18N_MIGRATION.md` | **未使用**（i18n 板块已移除） |

`/docs/` 仓库根可直接迁移 / 继承的稿件：

| 稿件 | 目的页 | 策略 |
|---|---|---|
| `/docs/PLUGIN_FORMAT.md` | dev/format + reference/plugin-schema | 按 "教程 vs 字段表" 拆两半 |
| `/docs/RHAI_API.md` | dev/rhai-api + reference/rhai-dictionary | 同上 |
| `/docs/CRAWLER_BACKENDS.md` | dev/crawler-backends | 整体迁移并精简 |
| `/docs/README_PLUGIN_DEV.md` | dev/overview | 合并 |
| `mcpb/kabegame-gallery-node/README.md` | guide/mcp-bundle | 迁移并精简（去掉 dev 细节） |
| `src-tauri/app-main/src/mcp_server.rs` 内 `MCP_INSTRUCTIONS` 注释 | guide/mcp + reference/mcp | 抽出 URI scheme / 分页规则 / 示例 |
| `/docs/NETWORK_SYNC_DESIGN.md` | 本轮不纳入 | 若后续暴露为用户功能再纳入 guide |
| `/docs/TAURI_RELEASE_NOTES.md` | 本轮不纳入 | 发布说明，非用户文档 |
| `/docs/tauri-cef-adaptation-points.md` | 本轮不纳入 | 项目内部改造笔记 |
