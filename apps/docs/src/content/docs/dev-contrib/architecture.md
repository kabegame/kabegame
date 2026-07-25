---
title: 架构与项目结构
description: 了解 Kabegame monorepo 的模块边界、技术栈与核心技术实现。
---

Kabegame 是一个由 Deno 构建系统编排的 monorepo。Vue 前端、Tauri 应用、Rust 核心库、Android Kotlin 代码和爬虫插件共同维护在一个仓库中。

## Monorepo 结构

```text
.
├── apps/
│   ├── kabegame/                 # Vue 3 主应用前端
│   └── docs/                     # Astro Starlight 文档站
├── packages/                     # 共享前端包、类型与插件 SDK
├── src-tauri/
│   ├── kabegame-core/            # 爬虫、插件、存储等共享 Rust 核心
│   ├── kabegame/                 # 桌面与 Android Tauri GUI
│   ├── kabegame-cli/             # 无界面命令行工具
│   ├── tauri-runtime-cef/        # 自研桌面 Tauri CEF runtime
│   └── pathql-rs/                # PathQL 查询引擎
├── src-tauri-plugins/            # picker、pathes、share、wallpaper 等自定义插件
├── src-crawler-plugins/          # JS/TS 爬虫插件及 .kgpg 打包流程
├── scripts/                      # Deno + Tapable 构建系统与依赖构建脚本
├── third/                        # Git 子模块形式的内嵌上游依赖
├── third-patches/                # 针对 third/ 的编号补丁序列
└── cocs/                         # 架构、构建、迁移与调试文档索引
```

- `apps/kabegame/` 只负责主应用前端；跨应用组件、composable、类型与 i18n 放在 `packages/`。
- `src-tauri/kabegame-core/` 是 GUI 与 CLI 共享的业务核心；`src-tauri/kabegame/` 负责 Tauri 壳和平台接线。
- `src-tauri-plugins/` 收纳平台能力。应用路径与数据目录计算统一归 `tauri-plugin-pathes` 管理。
- `src-crawler-plugins/` 中的插件以 JavaScript / TypeScript 编写，并打包成 `.kgpg`。
- `third/` 尽量保持接近上游；Kabegame 的定制通过 `third-patches/` 的有序补丁维护。

## 技术栈

| 层级 | 技术 |
|---|---|
| 前端 | Vue 3、TypeScript、Element Plus、UnoCSS、Pinia、Vue Router、Vite |
| 后端 | Rust、Tauri 2、Kotlin |
| 插件脚本 | JavaScript / TypeScript（V8 / `deno_core`）与 WebView |
| 构建系统 | Deno 2.9.0、Tapable |
| 文档站 | Astro、Starlight |

爬虫插件的两个后端有不同使用边界，选型和开发循环见[插件开发指南](/dev/overview/)；完整构建入口见[从源码构建](/dev-contrib/building/)。

其中 `tauri-runtime-cef`（桌面 CEF runtime）、`WebviewHandler`（WebView 爬虫）与 `pathql-rs`（PathQL 路径折叠查询引擎，配合 Provider DSL）是几处自研核心，深入设计见 [`cocs/`](https://github.com/kabegame/kabegame/tree/main/cocs)（如 [`cocs/provider-dsl/`](https://github.com/kabegame/kabegame/tree/main/cocs/provider-dsl)）。
