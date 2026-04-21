# --mode web：Web 端部署方案

## Overview

在 Tauri 打包之外增加 `--mode web` 构建模式，产出一个**纯 Rust 二进制**（无 Tauri / WebView 依赖），内嵌 Axum HTTP 服务器，在 `127.0.0.1:7490` 提供：
- `/mcp`（StreamableHTTP）
- `/file`、`/thumbnail` 等现有文件路由
- WebSocket JSON-RPC + 事件推送
- 编译后的 Vue 静态资产（嵌入二进制）

实现策略：**在 `app-main` 内通过 Cargo feature 分支**，`feature = "local"` 保留完整 Tauri 栈，`feature = "web"` 切除全部 tauri / tauri-plugin-* 依赖。不新建 crate，构建系统通过 `--mode web` 传入 `--no-default-features --features web`。

权限模型：
- 普通访问：只读（浏览画册、查看图片等）
- super 访问：`?super=1` query 参数；nginx 层通过客户端证书验证拒绝非授权请求

不支持的功能（web mode 报错或隐藏）：
- 虚拟盘（Dokan / FUSE）
- 壁纸设置（系统 API 不可用）
- 本地文件选择器（改为 Web 图片上传）
- `show_crawler_window`

---

## Phases

### Phase 1 — 基础设施（Tauri 依赖完全切除 + web 二进制骨架）[已完成]

**目标**：`bun b -c main --mode web --skip vue` 产出单二进制，运行后监听 7490，`/__ping` 返回 `ok`。

**变更列表：**
- `app-main/Cargo.toml`：tauri / tauri-plugin-* 全部 `optional = true`，新增 `local` / `web` feature
- `app-main/build.rs`：`tauri_build::build()` 改为 `#[cfg(feature = "local")]` 编译期门控
- 新建 `src/core_init.rs`：`init_globals()` + `spawn_bg()` feature-gated helper + `init_app_paths_for_web()`
- 新建 `src/web_entry.rs`：tokio runtime + AppPaths 初始化 + Axum `/__ping`
- `src/lib.rs`：所有 `mod` / `use` 声明加 `#[cfg(feature = "local")]`；双 `run()` 实现
- `src/main.rs`：singleton 转发门控；`windows_subsystem` 仅在 `feature = "local"` 生效
- `scripts/plugins/mode-plugin.ts`：新增 `Mode.WEB` / `isWeb`；`prepareCompileArgs` 注入 `--no-default-features --features web`；`copyBin` 跳过 web mode
- `scripts/build-system.ts`：web mode 走 `cargo build --release`，`check()` 修复 feature flag 传递

[计划链接](C:\Users\Lenovo\.claude\plans\claude-plans-web-mode-md-c-main-glimmering-turtle.md)

---

### Phase 2 — 路由整合（/mcp + /file + 静态资产）[已完成]

**目标**：web mode 二进制提供现有 MCP 端点 + 文件代理路由 + 编译后的 Vue 静态资产。

**变更列表：**
- `app-main/Cargo.toml`：`include_dir` 从 windows-only 移至 `not(android)` 共用依赖块
- `http_server.rs`：提取 `pub fn file_routes() -> Router`（`/file`、`/thumbnail`、`/proxy`，不含已废弃的 `/plugin-doc-image`）；`start_http_server` 改用 `tokio::spawn`；`get_http_server_base_url` 加 `feature = "local"` 门控
- `mcp_server.rs`：提取 `pub fn mcp_nest() -> Router`；`start_mcp_server` 复用之
- `lib.rs`：`http_server` / `mcp_server` 模块门控放宽至 `not(android)`；新增 `web_assets` 模块
- 新建 `src/web_assets.rs`：release 用 `include_dir!` 嵌入 `dist-main/`（SPA fallback），debug 返回 404
- `web_entry.rs`：三路 Router 合并（`file_routes()` + `mcp_nest()` + `static_assets_router()`）挂 7490
- `scripts/build-system.ts`：web release build 前校验 `dist-main/` 存在；添加 `existsSync` 检查
- `scripts/plugins/component-plugin.ts`：web mode 跳过 `tauri.conf.json` / `capabilities` handlebars 渲染；跳过 CLI sidecar staging
- `apps/main/vite.config.ts`：web mode 下不编译 `wallpaper.html`，启用 chunk 分割（`inlineDynamicImports: false` + `manualChunks`）
- `apps/main/src/router/index.ts`：所有路由改为懒加载（`() => import(...)`），按路由分 chunk

---

### Phase 3 — SSE 事件推送 + HTTP JSON-RPC + super 鉴权 [已完成]

**目标**：浏览器可通过 WebSocket 发送 JSON-RPC 2.0 调用、接收实时事件推送；super 用户写操作鉴权。

**协议：**
- `GET /events?super=<0|1>`：SSE `text/event-stream`，连接时推 `event: connected`，后续广播 DaemonEvent
- `POST /rpc?super=<0|1>`：JSON-RPC 2.0 单次调用，返回 `result` 或 `error`
- `?super=1` 控写操作权限，生产由 nginx mTLS 保护

**变更列表：**
- `app-main/Cargo.toml`：新增 `futures-util = "0.3"`、`tokio-stream = { version = "0.1", features = ["sync"] }`
- 新建 `src/commands_core/{mod,album,image,task,misc}.rs`：10 个 bootstrap 命令纯函数（`not(android)` 门控）
- 新建 `src/ws/{mod,server,dispatch}.rs`：SSE handler + POST RPC handler + `start_web_event_loop` + `init_registry`
- `src/lib.rs`：新增 `commands_core` / `ws` 模块声明（`not(android)` 门控）
- `src/web_entry.rs`：合并 `web_routes()`，初始化 registry + event loop

---

### Phase 4 — 前端 RPC 统一层 + Web 导入 + UI 门控 [已完成]

**目标**：前端所有 `invoke` / `listen` 走统一 `@/api/rpc` 抽象；web mode 本地导入改为 HTTP 上传；web mode 不可用 UI 入口隐藏。响应式布局改造延后到 Phase 4.5。

**变更列表：**
- 新建 `packages/core/src/env.ts` 的 `IS_WEB` + `vite.config.pub.ts` 的 `__WEB__` define
- 新建 `apps/main/.env.development` / `.env.production`（`VITE_API_ROOT`）
- 新建 `apps/main/src/api/{rpc,tauri-client,web-client,dialog}.ts`：façade 按 `IS_WEB` 选择实现，导出 `invoke` / `listen` / `emit`，签名与 Tauri 一致；`web-client.ts` 用 `fetch POST /rpc` + `EventSource /events`，单例 EventSource，订阅 `superMode` 变化时 tear down 重连
- 新建 `apps/main/src/components/SuperModeToggle.vue`（左下角浮动开关，仅 `IS_WEB` 挂载）
- `stores/app.ts`：新增 `superMode` 响应式状态，web 下 localStorage 持久化默认 false；桌面/Android 固定 true
- 一次性 codemod `scripts/codemod-rpc.ts`（已删除）：批量替换 40 个文件共 49 处 `@tauri-apps/api/core` / `@tauri-apps/api/event` import 到 `@/api/rpc`
- `LocalImportDialog.vue`：web mode 下 `<input type="file">` + FormData 到 `POST /api/import`；桌面路径不变
- 新建 `src-tauri/app-main/src/web_import.rs`：`POST /api/import`（multipart）→ 写入 `cache_dir/web-upload/<uuid>/` → 走 `TaskScheduler::submit_task` 的 local-import 路径；附启动时 `gc_stale_uploads()` 清理 >24h 残留
- `src-tauri/app-main/Cargo.toml`：`axum` 启用 `multipart` feature
- `src-tauri/app-main/src/web_entry.rs`：合并 `api_routes()`，启动时 spawn gc 任务
- `apps/main/vite.config.ts`：web mode 附加 `server.proxy`（`/rpc`、`/events`、`/api`、`/file`、`/thumbnail`、`/proxy`、`/mcp` → `http://localhost:7490`）
- UI 门控（`IS_WEB` 条件隐藏）：
  - `views/Settings.vue`：autoLaunch / albumDrive / clearUserData / autoOpenWebView / devWebView / 整个壁纸 tab
  - `settings/quickSettingsRegistry.ts`：defaultDownloadDir、autoLaunch、整个 wallpaper group
  - `views/Surf.vue`：`OpenCrawlerWebview` 在 web 下移除
  - `views/Albums.vue`：`albumDriveEnabled` 在 web 下固定 false
  - `composables/useWindowEvents.ts`、`utils/openLocalImage.ts`：入口处 `if (IS_WEB) return`

**懒扩展策略**：Phase 3 的 10 个 RPC 命令覆盖首屏；剩余命令（`batch_delete_images`、`copy_image_to_clipboard`、`surf_*`、`wallpaper_*` 等）在实际点到报错时再补到 `web/dispatch.rs`。

**后续补齐（2026-04-20）**：新增 Album/Image/Task/Plugin 写操作 14 个 method — `add_album`、`add_images_to_album`、`add_task_images_to_album`、`remove_images_from_album`、`update_album_images_order`、`remove_image`、`add_task`、`update_task`、`clear_finished_tasks`、`copy_run_config`、`get_run_config`、`get_missed_runs`、`add_plugin_source`、`preview_import_plugin`、`preview_store_install`。写操作全部 `requires_super: true`。范围不含 settings/surf/wallpaper/organize/`set_supported_image_formats`/`clear_user_data`（web 下隐藏或不支持）。

---

### Phase 4.5 — `IS_ANDROID` 布局响应式化 [已完成]

**目标**：梳理所有 `v-if="IS_ANDROID"` / `v-if="!IS_ANDROID"` 用法，拆分"样式分支"与"功能分支"：
- **样式分支**（侧边栏宽度、列数、紧凑布局）→ 改为 CSS 媒体查询 / UnoCSS viewport 响应式，使 web mode 在小屏浏览器或缩窄桌面窗口时也能自动切紧凑布局
- **功能分支**（分享、选择器、壁纸等 native 功能）→ 保留 platform flag，web mode 下继续用 `IS_WEB` 隐藏

此阶段不触碰 RPC 层，可独立推进。

---

### Phase 5 — Playwright Node sidecar（JS 爬虫插件 web 后端）

**目标**：web mode 下 JS 爬虫插件不依赖 Tauri WebView，改用 Playwright Node 进程作为无头浏览器后端。

**变更列表：**
- `src-tauri/core/src/crawler/`：抽象 `BrowserBackend` trait，`local` feature 下保持 Tauri WebView 实现，`web` feature 下使用 Node/Playwright sidecar 实现
- sidecar 通信协议：stdin/stdout JSON-RPC（与现有 Rhai plugin runner 一致）
- `beforeBuild` hook：web mode build 时打包 `playwright-sidecar` Node 脚本，输出到 `target/release/` 旁边
- `bun dev -c main --mode web`：同时启动 Vite dev server（端口 1420）+ `cargo run` web server（端口 7490），前端通过 `VITE_KABEGAME_MODE` 连接 ws://localhost:7490

---

### Phase 6 — 收尾 + dev 双通道 + nginx 文档

**目标**：开发体验与生产部署文档完善。

**变更列表：**
- `bun dev -c main --mode web`：并发启动 Vite（1420）+ cargo run web（7490），HMR 正常工作
- 生产 nginx 配置完整示例（含 `/ws` super 客户端证书鉴权、静态资产缓存、文件代理）
- `docs/WEB_MODE.md`：部署指南、功能对比表、迁移注意事项
- 回归测试：Phase 1–5 全路径 E2E（Playwright 对 web mode 界面）

---

## Todos

- [x] Phase 1：Cargo feature 门控 + web 二进制骨架 (`/__ping` on 7490)
- [x] Phase 2：`/file` + `/mcp` 路由挂入 web Router；Vue 静态资产集成；构建系统清理
- [x] Phase 3：SSE `/events` + HTTP `POST /rpc`；10 bootstrap 命令；EventBroadcaster 推送；super 鉴权
- [x] Phase 4：`rpc.ts` 统一出口 + codemod (40 文件 49 处 import) + LocalImportDialog Web 上传 + `POST /api/import` + super 切换 + UI 门控
- [x] Phase 4.5：`IS_ANDROID` 布局响应式化（样式分支改 CSS，功能分支保留 platform flag）
- [ ] Phase 5：Playwright Node sidecar 替代 WebView JS 爬虫后端
- [ ] Phase 6：dev 双通道 + nginx 文档 + E2E 回归
