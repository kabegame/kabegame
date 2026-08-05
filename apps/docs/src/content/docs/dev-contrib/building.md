---
title: 从源码构建
description: 配置 Kabegame 开发环境，并使用仓库统一入口完成开发、检查与构建。
---

Kabegame 是一个 Deno 驱动的 monorepo：前端使用 Vue 3，桌面与 Android 应用由 Tauri 2 和 Rust 提供。本文给出贡献者首次拉起仓库所需的最短路径；插件开发流程另见[插件开发指南](/dev/overview/)，安装发行版则见[安装与首次启动](/guide/installation/)。

## 前置要求

- **Deno 2.9.0**：使用官方二进制，可通过 `denoland/setup-deno`、Homebrew 或官方安装脚本安装。`third-patches/deno/` 只补应用编译使用的 `libs/core`，不改变 CLI 行为。
- **Rust 工具链**：通过 rustup 安装当前稳定版 Rust。
- **Tauri 2 的平台依赖**：按 [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) 为目标系统安装编译工具和系统库。
- **Git 子模块**：克隆时使用 `--recurse-submodules`，或在已有 checkout 中运行 `git submodule update --init --recursive`。

本仓库不直接使用全局安装的 `cargo-tauri`。Tauri 源码位于 `third/tauri`，Kabegame 的改动保存在 `third-patches/tauri/`；先运行：

```bash
deno task patch tauri
```

随后 `TauriCliPlugin` 会把 fork 的 `cargo-tauri` 接入 `dev`、`build` 与 Android `check` 流程，并按需增量构建。实现细节见 [`cocs/tauri/TAURI_CLI_FORK.md`](https://github.com/kabegame/kabegame/blob/main/cocs/tauri/TAURI_CLI_FORK.md)。

## 安装依赖

在仓库根目录执行：

```bash
deno install
deno task prepare
deno task --cwd src-crawler-plugins prepare
```

两个 `prepare` 分别安装根仓库与 `src-crawler-plugins` 的 Husky Git hooks。`deno install` 不会自动执行它们，因此新 checkout 至少需要手动运行一次。

## 开发、检查与构建

所有顶层命令都由 `scripts/run.ts` 统一编排：

```bash
# 启动桌面开发环境（Vite + Tauri，前端端口 1420）
deno task dev -c kabegame

# 启动并在本地打包全部爬虫插件
deno task dev -c kabegame --mode local

# 构建全部组件（kabegame + kabegame-cli）
deno task b

# 只构建主应用
deno task b -c kabegame

# 检查前端类型与 Rust（check 必须用 -c 指定组件）
deno task check -c kabegame
```

仓库内的 `check-kabegame` skill 是 `deno task check` 的省心封装：它会保存完整日志，并从大量 warning 中提取真正的 error。日常验证优先使用检查命令，不要用完整构建代替检查。

## 构建模式

`--mode` 选择应用的目标形态：

| 模式 | 用途 |
|---|---|
| `standard` | 默认桌面版本，包含插件商店、虚拟磁盘和桌面视频摄入能力。 |
| `android` | Android 应用；开发时使用 `deno task dev -c kabegame --mode android`。 |
| `web` | Web 目标，不包含 Tauri 原生栈。 |

构建系统、平台库与发布打包的深入说明集中在 [`cocs/build/`](https://github.com/kabegame/kabegame/tree/main/cocs/build)。

## FFmpeg

`third/FFmpeg` 是 Git 子模块。桌面端视频摄入、预览压缩和尺寸处理依赖仓库构建的 FFmpeg / x264 静态库：

```bash
deno task build:ffmpeg
```

Android 使用 aarch64 交叉编译产物：

```bash
deno task build:ffmpeg --target android
```

构建前请确认相关子模块已初始化；Android 还需要正确配置 NDK。视频摄入链路见 [`cocs/downloader-tasks/VIDEO_INGEST.md`](https://github.com/kabegame/kabegame/blob/main/cocs/downloader-tasks/VIDEO_INGEST.md)。

## 数据目录模式

`--data` 决定开发或构建出来的程序读写哪组数据：

| 模式 | 默认场景 | 位置与用途 |
|---|---|---|
| `dev` | `deno task dev` | 使用仓库内 `.kabegame/debug/data`、`.kabegame/debug/cache` 与 `.kabegame/debug/tmp`，不会污染已安装版本。 |
| `prod` | 其他顶层命令 | 使用系统用户数据目录，与正式安装版共享数据。 |

需要用真实数据调试时，可以运行：

```bash
deno task dev -c kabegame --data prod
```

各平台正式数据目录见[安装与首次启动](/guide/installation/#首次启动后的数据目录)。
