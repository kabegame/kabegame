---
title: 致谢与内嵌依赖
description: 感谢 Kabegame 使用和参考的开源项目，并说明 third/ 依赖的维护方式。
---

Kabegame 建立在众多开源项目之上。感谢这些项目的开发者与社区。

## 核心框架

- [**Tauri**](https://github.com/tauri-apps/tauri) — 构建跨平台应用的框架，也是本项目部分实现的参考。
- [**Vue**](https://github.com/vuejs/core) — 渐进式 JavaScript 框架，Kabegame 的前端核心。
- [**Vite**](https://github.com/vitejs/vite) — 前端开发与构建工具。
- [**TypeScript**](https://github.com/microsoft/TypeScript) — 为 JavaScript 提供静态类型。

## UI 与工具库

- [**Element Plus**](https://github.com/element-plus/element-plus) — 基于 Vue 3 的组件库。
- [**Pinia**](https://github.com/vuejs/pinia) — Vue 状态管理库。
- [**Vue Router**](https://github.com/vuejs/router) — Vue 官方路由管理器。
- [**Axios**](https://github.com/axios/axios) — 基于 Promise 的 HTTP 客户端。
- [**UnoCSS**](https://github.com/unocss/unocss) — 原子化 CSS 引擎。
- [**panzoom**](https://github.com/timmywil/panzoom) — 预览图拖拽与缩放工具。
- [**PhotoSwipe**](https://github.com/dimsemenov/PhotoSwipe) — 移动端图片浏览库；Kabegame 参考它重写了 Vue 版本。

## 后端与工具

- [**deno_core**](https://github.com/denoland/deno/tree/main/libs/core) — 在 Rust 中嵌入 V8，驱动 JavaScript / TypeScript 插件后端。
- [**rusty_v8**](https://github.com/denoland/rusty_v8) — V8 的 Rust 绑定。
- [**Serde**](https://github.com/serde-rs/serde) — Rust 序列化框架。
- [**Tokio**](https://github.com/tokio-rs/tokio) — Rust 异步运行时。
- [**Reqwest**](https://github.com/seanmonstar/reqwest) — Rust HTTP 客户端。
- [**Scraper**](https://github.com/causal-agent/scraper) — Rust HTML 解析和选择器库。
- [**Rusqlite**](https://github.com/rusqlite/rusqlite) — SQLite 的 Rust 绑定。
- [**Image**](https://github.com/image-rs/image) — Rust 图像处理库。
- [**FFmpeg**](https://ffmpeg.org/) — 音视频解码、预览压缩与兼容格式处理。
- [**Prisma**](https://github.com/prisma/prisma) — 用于维护数据库结构文档。

## 构建与开发工具

- [**Deno**](https://github.com/denoland/deno) — JavaScript / TypeScript 运行时与包管理器，也是本项目构建系统的运行时。
- [**Tapable**](https://github.com/webpack/tapable) — 构建系统钩子机制的基础。
- [**Handlebars**](https://github.com/handlebars-lang/handlebars.js) — 用于生成 `tauri.conf.json` 等配置。

## 参考项目

- [**Lively**](https://github.com/rocksdanister/lively) — 动态壁纸应用；Kabegame 参考了其桌面挂载实现。
- [**Clash Verge**](https://github.com/clash-verge-rev/clash-verge-rev) — Kabegame 参考了其托盘代码、Tauri 配置与 Linux workaround。
- [**Pake**](https://github.com/tw93/pake) — 将网站打包为应用的项目，为 Kabegame 提供了实现参考。
- [**LiveWallpaperMacOS**](https://github.com/thusvill/LiveWallpaperMacOS.git) — macOS 动态壁纸方案；Kabegame 参考了其桌面壁纸挂载实现。
- [**PixivCrawler**](https://github.com/CWHer/PixivCrawler) — Python 3 编写的 Pixiv 爬虫；Kabegame 参考了其 Pixiv 爬取实现。

## 内嵌依赖（`third/`）

以下上游项目以 Git 子模块形式存放在 `third/`。需要定制的上游改动通过 `third-patches/<name>/` 中的编号补丁序列维护，使子模块本身尽量接近上游：

- [**CEF（Chromium Embedded Framework）**](https://github.com/chromiumembedded/cef) — 桌面端 WebView 后端使用的 Chromium 浏览器引擎。
- [**cef-rs**](https://github.com/tauri-apps/cef-rs) — CEF 的 Rust 绑定。
- [**deno**](https://github.com/denoland/deno) — 提供驱动 V8 插件后端的 `deno_core` 源码；构建编排使用官方 Deno CLI 二进制。
- [**rusty_v8**](https://github.com/denoland/rusty_v8) — V8 的 Rust 绑定；Kabegame 为 Android aarch64 自行构建静态库与 binding。
- [**FFmpeg**](https://github.com/FFmpeg/FFmpeg) — 视频摄入、预览压缩和媒体处理框架。
- [**x264**](https://code.videolan.org/videolan/x264) — H.264 编码器，由 FFmpeg 构建静态链接。
- [**rsmpeg**](https://github.com/larksuite/rsmpeg) — FFmpeg `libav*` 的安全 Rust 封装。
- [**rusty_ffmpeg**](https://github.com/CCExtractor/rusty_ffmpeg) — rsmpeg 使用的 FFmpeg bindgen 助手。
- [**tauri**](https://github.com/tauri-apps/tauri) — Kabegame 使用的 Tauri fork，包含 `TAURI_ANDROID_PACKAGE`、顶层 `bins` 等专属补丁。

补丁入口、构建文档与各依赖的维护说明可从 [`cocs/README.md`](https://github.com/kabegame/kabegame/blob/main/cocs/README.md) 查找。准备开发环境和编译这些依赖的命令见[从源码构建](/dev-contrib/building/)与[Android 开发](/dev-contrib/android-build/)。
