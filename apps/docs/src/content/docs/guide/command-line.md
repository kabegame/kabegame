---
title: 命令行
description: 使用 Kabegame CLI 工具运行插件、打包和导入插件，适合自动化脚本场景。
---

:::note
命令行工具在 Light 模式下不支持。
:::

## 什么是命令行工具？

Kabegame 提供了一个命令行工具（CLI），可以通过终端/命令提示符来执行插件相关操作。

适合：自动化脚本、批量处理、不打开主窗口的情况下运行插件等场景。

---

## 如何启动命令行工具

命令行工具通常位于应用安装目录下，名为 `kabegame-cli`（Linux/macOS）或 `kabegame-cli.exe`（Windows）。

在终端/命令提示符中运行 `kabegame-cli --help` 会显示所有可用的命令和选项。

---

## 主要命令

### 1. 运行插件（plugin run）

通过命令行运行已安装的插件或本地插件文件：

```bash
kabegame-cli plugin run --plugin <插件ID或.kgpg路径> [选项] -- [插件参数]
```

**参数说明：**

| 参数 | 说明 |
|------|------|
| `--plugin` / `-p` | 插件 ID（已安装的插件）或 `.kgpg` 文件路径 |
| `--output-dir` / `-o` | 输出目录（可选，不指定则使用默认目录） |
| `--task-id` | 任务 ID（可选，不指定则自动生成） |
| `--output-album-id` | 输出画册 ID（可选） |
| `-- [参数]` | 传给插件的参数（会映射到插件的 var 变量） |

### 2. 打包插件（plugin pack）

将插件目录打包为 `.kgpg` 文件：

```bash
kabegame-cli plugin pack --plugin-dir <插件目录> --output <输出路径.kgpg>
```

| 参数 | 说明 |
|------|------|
| `--plugin-dir` | 包含 `manifest.json` 和 `crawl.rhai` 的插件目录 |
| `--output` | 输出的 `.kgpg` 文件路径 |

### 3. 导入插件（plugin import）

导入本地 `.kgpg` 插件文件到应用：

```bash
kabegame-cli plugin import <.kgpg路径> [--no-ui]
```

| 参数 | 说明 |
|------|------|
| 第一个参数 | `.kgpg` 文件路径 |
| `--no-ui` | 不启动 UI，直接执行导入（适合脚本/自动化） |

---

## 常用命令示例

### 1. 导入单张图片到画廊

使用 `local-import` 插件导入单张图片文件：

```bash
# Windows 路径
kabegame-cli plugin run --plugin local-import -- --file_path "C:/Users/你的用户名/Pictures/image.jpg"

# Linux/macOS 路径
kabegame-cli plugin run --plugin local-import -- --file_path "/home/user/Pictures/image.jpg"
```

### 2. 导入文件夹到画廊

使用 `local-import` 插件导入整个文件夹（递归扫描子目录）：

```bash
# Windows 路径（递归导入）
kabegame-cli plugin run --plugin local-import -- --folder_path "C:/Users/你的用户名/Pictures/anime" --recursive=true

# Linux/macOS 路径（只导入当前目录，不递归）
kabegame-cli plugin run --plugin local-import -- --folder_path "/home/user/Pictures/anime" --recursive=false
```

### 3. 指定输出目录

```bash
kabegame-cli plugin run --plugin local-import -o "D:/my-gallery" -- --folder_path "C:/Pictures"
```

---

## 使用场景

| 场景 | 说明 |
|------|------|
| 自动化脚本 | 编写批处理脚本，定期运行插件收集图片 |
| 批量处理 | 一次性运行多个插件或处理多个任务 |
| 无界面运行 | 在服务器或后台环境中运行，不需要打开主窗口 |
| 插件开发 | 快速打包和测试插件，无需通过 UI 操作 |

---

## 注意事项

- 命令行工具需要应用已正确安装，并且插件目录和配置文件路径正确
- 运行插件时，确保插件所需的参数都已通过 `--` 后的参数正确传递
- 如果遇到权限问题或路径错误，请检查应用安装路径和插件目录配置
