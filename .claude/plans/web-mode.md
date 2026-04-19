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

### Phase 4 — 前端适配（ipc.ts + codemod + IS_WEB gate + 响应式重构）

**目标**：前端代码在 web mode 下通过 WebSocket 替代 Tauri IPC，本地导入改为 Web 上传，`IS_ANDROID` 布局分支改为 CSS 响应式。

**变更列表：**
- 新建 `apps/main/src/api/web-client.ts`：WebSocket 单例 + pending request map，导出 `invoke` / `listen`
- 新建 `apps/main/src/api/ipc.ts`：根据 `import.meta.env.VITE_KABEGAME_MODE` 选择 tauri 或 web 实现
- **codemod**：批量替换 `@tauri-apps/api/core` invoke → `@/api/ipc`（约 221 处），`@tauri-apps/api/event` listen → `@/api/ipc` listen
- **LocalImportDialog.vue**：web mode 下替换为 `<input type="file" multiple>` Web 上传界面，POST 到服务端接收存入图库（后端新增 `/api/import` endpoint）
- **IS_ANDROID 布局响应式化**：梳理所有 `v-if="IS_ANDROID"` / `v-if="!IS_ANDROID"` 用法：
  - **样式分支**（侧边栏宽度、列数、紧凑布局等）→ 改为 CSS 媒体查询 / UnoCSS viewport 响应式
  - **功能分支**（分享、选择器、壁纸等 native 功能）→ 保留 platform flag，web mode 下隐藏
- web mode 不支持的 UI 入口（虚拟盘、壁纸设置）通过 `VITE_KABEGAME_MODE === 'web'` 条件隐藏

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
- [ ] Phase 4：`ipc.ts` 统一出口 + codemod (221 invoke) + LocalImportDialog Web 上传 + IS_ANDROID 布局响应式化
- [ ] Phase 5：Playwright Node sidecar 替代 WebView JS 爬虫后端
- [ ] Phase 6：dev 双通道 + nginx 文档 + E2E 回归
