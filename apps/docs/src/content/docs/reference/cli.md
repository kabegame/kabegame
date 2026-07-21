---
title: kabegame-cli 命令行参考
description: kabegame-cli 子命令、参数、退出码与守护进程依赖关系的完整参考。
---

`kabegame-cli` 是 Kabegame 随主应用一起发布的 sidecar 可执行文件，用于在不打开 GUI 的前提下脚手架、打包、导入并运行爬虫插件，或在脚本中控制虚拟磁盘。本页列出当前代码实际存在的子命令与参数。

:::note
除 `plugin new` / `plugin pack` / `plugin import` / `plugin run` 外，所有子命令都需要 `kabegame-daemon` 正在运行。通常启动 GUI 主应用即可同时启动 daemon；也可以手动启动 `kabegame-daemon`。详见下方[守护进程依赖](#守护进程依赖)。
:::

## 启动与定位

二进制名：

- Windows：`kabegame-cli.exe`
- macOS / Linux：`kabegame-cli`

安装位置因平台而异：

- **Windows / macOS 标准版**：CLI 会作为 sidecar 打包在主应用目录（Windows）或 `.app` 资源目录（macOS）中。
- **Linux**：目前 Linux 端未随主应用一同发布 `kabegame-cli`，若需使用请自行从源码构建。
- **Light 构建**：不包含 `vd *` 子命令。
- **Android**：不提供 CLI。

全局参数只有 clap 自带的 `--help` / `-h` 与 `--version` / `-V`。

```bash
kabegame-cli --help
kabegame-cli plugin run --help
```

## plugin 子命令组

### plugin new

在当前目录脚手架一个新的插件目录。**离线可用，不需要 daemon。**

```bash
kabegame-cli plugin new <name> [--backend rhai|v8|webview]
```

| 参数        | 必填 | 说明                                                                                                                 |
| ----------- | ---- | -------------------------------------------------------------------------------------------------------------------- |
| `name`      | 是   | 插件名，必须是 kebab-case（正则 `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`）。`MyPlugin`、`my_plugin`、`1stplugin` 都会被拒绝。 |
| `--backend` | 否   | `v8`（默认）、`rhai` 或 `webview`，决定生成的脚本文件与 `package.json.kbBackend`。                                      |

目标目录若已存在则直接报错退出。脚手架会从模板生成 `package.json`、`icon.png`、`doc_root/doc.md` 等通用文件，并根据 backend 生成对应脚本。

```bash
kabegame-cli plugin new my-site
kabegame-cli plugin new my-site --backend rhai
kabegame-cli plugin new my-site --backend webview
```

### plugin run

在 CLI **本进程内**跑一个已安装的 V8 插件，实时渲染日志与进度。**不需要 daemon。**

主要用途是插件开发期的快速验证：改完插件源码 → 重打包投放到 dev 数据目录 → 直接 `plugin run`，不用启动 GUI。

```bash
kabegame-cli plugin run <plugin> [选项]
```

| 参数             | 必填 | 说明                                                                                             |
| ---------------- | ---- | ------------------------------------------------------------------------------------------------ |
| `<plugin>`       | 是   | **已安装**插件的 id（等于 `.kgpg` 文件名 stem）。未安装会列出当前可用的 id。先用 `plugin import` 装。 |
| `--var KEY=VALUE`| 否   | 覆盖单个 `kbConfig` 项，可重复。值按该 key 在 `kbConfig` 里声明的类型自动转换（int/float/boolean 等），所以 `--var page=3` 会变成数字 `3`。未知 key 会直接报错并列出可用项。 |
| `--data dev\|prod\|auto` | 否 | 数据目录。`dev` = 仓库内 `.kabegame/debug`（`repack-crawler-plugins` skill 投放插件的地方），`prod` = 系统用户数据目录，`auto`（默认）跟随编译期的 `kabegame_data` cfg。**release 构建的 CLI 默认是 prod**，测试仓库内的插件时通常要显式加 `--data dev`。 |
| `--output-dir`   | 否   | 图片输出目录。优先级高于插件默认配置里保存的 `outputDir`。                                          |
| `--album-id`     | 否   | 目标画册 id。                                                                                     |
| `--dry-run`      | 否   | 只解析并打印最终配置，不真正建任务。                                                              |
| `--plain`        | 否   | 不渲染进度条，日志逐行直出。非 TTY（管道、CI）会自动进入此模式。                                    |

**配置解析**与主应用一致，三层叠加后打印成 JSON：

1. `kbConfig` 各项的 `default`
2. 用户在应用里保存的插件默认配置（`plugins-directory/default-configs/<id>.json` 的 `userConfig`；同一文件里的 `httpHeaders` / `outputDir` 也会被采用）
3. 本次命令行的 `--var`

**限制**：只支持 `kbBackend: "v8"` 的插件。WebView 后端要真实浏览器窗口，headless CLI 起不来，遇到会直接报错。

```bash
# 先安装，再运行
kabegame-cli plugin import ./packed/kemono.kgpg
kabegame-cli plugin run kemono --data dev \
  --var source=creator --var service=patreon --var creator_id=44096704 \
  --var creator_page_start=1 --var creator_page_end=1

# 只看最终配置，不跑
kabegame-cli plugin run kemono --data dev --dry-run --var source=tag --var tag=nsfw
```

输出形态：进度条常驻最后一行，日志从它上方滚出（同 cargo / apt）。

```text
   LOG  [kemono]   ┌ 第 1 页开始：50 个帖子，178 张图
   LOG  [kemono]   → 帖子开始 「Pudgy Paige Deadlock Mod」(patreon:44096704:151426947)：3 张图
  WARN  附件下载失败：https://…（HTTP 404）
⠐ [00:00:06] [==========================> ]  95% kemono · ↓12 · ⊘11
```

进度条尾部计数：`↓` 已下载、`✗` 失败、`⊘` 去重跳过。`Ctrl-C` 会取消任务而不是硬退出，避免数据库里留下永远 `running` 的任务。

### plugin pack

把一个插件目录打包为 KGPG v3 格式的 `.kgpg`。**离线可用，不需要 daemon。**

```bash
kabegame-cli plugin pack --plugin-dir <目录> --output <输出.kgpg>
```

| 参数           | 必填 | 说明                                                              |
| -------------- | ---- | ----------------------------------------------------------------- |
| `--plugin-dir` | 是   | 包含 v3 `package.json` 与 `main` 指向脚本的插件目录。 |
| `--output`     | 是   | 输出的 `.kgpg` 文件路径。                                         |

打包时读取 `package.json.main` 与 `package.json.kbBackend`；缺少 v3 清单或必需脚本会直接报错。

:::caution
`plugin pack` 只打包已经构建好的目录，不执行 `scripts.build`。仓库打包流程由 `src-crawler-plugins/package-plugin.ts` 在调用 CLI 前负责构建。
:::

内部 ZIP 会收集 `package.json` 明确引用的脚本、文档、推荐配置、providers、metadata 迁移脚本与模板。`icon.png` 被单独编码进 KGPG 头部字段，失败时仅日志警告，不中断打包。

### plugin import

把本地 `.kgpg` 安装到 `plugins_directory`。**离线可用，不需要 daemon**（直接初始化 `PluginManager`）。

```bash
kabegame-cli plugin import <path.kgpg>
```

| 参数     | 必填 | 说明                                                        |
| -------- | ---- | ----------------------------------------------------------- |
| 位置参数 | 是   | `.kgpg` 文件路径。文件不存在或扩展名非 `.kgpg` 会立即报错。 |

安装前会验证：manifest 可解析、包含非空 `crawl.rhai` 或 `crawl.js`、若存在 `config.json` 则可解析。成功时输出：

```text
导入成功：id=…; name=…; version=…; 目标目录=…
```

:::note
CLI 层没有版本 / 冲突检查，重复导入同一 ID 可能覆盖已有插件。
:::

## vd 子命令组（仅标准构建）

`vd *` 只在非 Light 构建中编译。虚拟磁盘当前实际可用平台以 Windows（Dokan）为主；macOS / Linux 相关实现处于实验状态。所有 `vd` 子命令都通过 IPC 走 daemon。

### vd mount

```bash
kabegame-cli vd mount
```

无参数。挂载点由 daemon 端配置。

### vd unmount

```bash
kabegame-cli vd unmount
```

无参数。

### vd status

```bash
kabegame-cli vd status --mount-point <K|K:|K:\>
```

| 参数            | 必填 | 说明                                                                             |
| --------------- | ---- | -------------------------------------------------------------------------------- |
| `--mount-point` | 是   | 挂载点字符串。Windows 可写 `K`、`K:` 或 `K:\`；Unix 默认为 `$HOME/kabegame-vd`。 |

## ipc-status

向 daemon 发送一次 IPC Status 请求，把响应以 JSON 输出。用于排查 daemon 是否可达。**需要 daemon。**

```bash
kabegame-cli ipc-status
```

无参数。daemon 不可达时输出：

```text
无法连接 kabegame-daemon
提示：请先启动 `<daemon-path>`
```

## 退出码

CLI 使用三种退出码：

| 码  | 含义                                                                                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `0` | 成功。子命令返回 `Ok(())`，并打印 `ok` 或 daemon 返回消息。                                                                         |
| `1` | 子命令执行失败。包括：插件名非法、文件缺失、daemon 不可达、daemon 返回 `ok=false`、IPC 解析错误、画册名未找到、webview 构建失败等。 |
| `2` | clap 参数解析错误，例如缺少必填参数或未知子命令。由 clap 在进入 `main()` 之前抛出。                                                 |

## 守护进程依赖

| 子命令                                  | 是否需要 daemon | 原因                                       |
| --------------------------------------- | --------------- | ------------------------------------------ |
| `plugin new`                            | 否              | 纯本地模板复制。                           |
| `plugin pack`                           | 否              | 读取目录，必要时在本地执行 npm/bun 构建。  |
| `plugin import`                         | 否              | 本地初始化 `PluginManager`。               |
| `plugin run`                            | 否              | 在本进程内初始化 TaskScheduler + V8 运行时执行，只订阅进程内的 `EventBroadcaster`。 |
| `vd mount` / `vd unmount` / `vd status` | 是              | 全部走 IPC。                               |
| `ipc-status`                            | 是              | 用来探测 daemon。                          |

## 平台差异

| 能力                             | Windows     | macOS | Linux                | Android |
| -------------------------------- | ----------- | ----- | -------------------- | ------- |
| 随主应用发布 CLI                 | 是          | 是    | 否（需自行构建）     | 不适用  |
| `plugin new` / `pack` / `import` | 是          | 是    | 是（需本地构建 CLI） | 不适用  |
| `plugin run`                     | 是          | 是    | 是（需 daemon）      | 不适用  |
| `vd *`                           | 是（Dokan） | 实验  | 实验                 | 不适用  |
| Light 构建含 `vd *`              | 否          | 否    | 否                   | 不适用  |

## 常见问题

- **无法连接 kabegame-daemon** → daemon 未启动 → 启动 GUI 主应用，或在终端手动运行 `kabegame-daemon`，再重试。
- **`--output-album` 未匹配到画册** → 名称拼写或大小写问题（匹配本身已做大小写不敏感与去空格）→ 在 GUI 中确认画册显示名，复制后再试。
- **`plugin pack` 报 `未找到可用的包管理器`** → 插件 `package.json` 声明了 build 脚本但系统上没有 bun / npm → 安装其一后再打包，或移除 `scripts.build`。
- **`plugin new` 拒绝名称** → 名称非 kebab-case → 使用 `my-plugin` 这类全小写、短横线分隔、首字符为字母的名称。

## 延伸阅读

- [插件管理](/guide/plugins/)
- [虚拟磁盘](/guide/virtual-drive/)
- [命令行（入门指南）](/guide/command-line/)
