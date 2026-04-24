---
title: kabegame-cli 命令行参考
description: kabegame-cli 子命令、参数、退出码与守护进程依赖关系的完整参考。
---

`kabegame-cli` 是 Kabegame 随主应用一起发布的 sidecar 可执行文件，用于在不打开 GUI 的前提下脚手架、打包、导入并运行爬虫插件，或在脚本中控制虚拟磁盘。本页列出当前代码实际存在的子命令与参数。

:::note
除 `plugin new` / `plugin pack` / `plugin import` 外，所有子命令都需要 `kabegame-daemon` 正在运行。通常启动 GUI 主应用即可同时启动 daemon；也可以手动启动 `kabegame-daemon`。详见下方[守护进程依赖](#守护进程依赖)。
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
kabegame-cli plugin new <name> [--backend rhai|webview]
```

| 参数        | 必填 | 说明                                                                                                                 |
| ----------- | ---- | -------------------------------------------------------------------------------------------------------------------- |
| `name`      | 是   | 插件名，必须是 kebab-case（正则 `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`）。`MyPlugin`、`my_plugin`、`1stplugin` 都会被拒绝。 |
| `--backend` | 否   | `rhai`（默认）或 `webview`，决定生成的脚本文件（`crawl.rhai` 或 `crawl.js` + `package.json`）。                      |

目标目录若已存在则直接报错退出。脚手架会从模板复制 `manifest.json`、`icon.png`、`doc_root/doc.md` 等通用文件，并根据 backend 生成对应脚本。

```bash
kabegame-cli plugin new my-site
kabegame-cli plugin new my-site --backend webview
```

### plugin run

通过 daemon 执行一个已安装的插件或本地 `.kgpg` 文件。**需要 daemon。**

```bash
kabegame-cli plugin run --plugin <id或路径> [选项] -- [插件参数...]
```

| 参数                 | 必填 | 说明                                                                                                                                                                  |
| -------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-p`, `--plugin`     | 是   | 已安装的插件 ID（即 `.kgpg` 文件去掉扩展名），或一个本地 `.kgpg` 文件路径。                                                                                           |
| `-o`, `--output-dir` | 否   | 输出目录。省略时由 daemon 使用默认目录（Pictures/Kabegame 或数据目录）。                                                                                              |
| `--task-id`          | 否   | 任务 ID，用于进度与日志归档；省略时自动生成。                                                                                                                         |
| `--output-album`     | 否   | 目标画册**名称**（不是 ID）。由 daemon 调用 `storage_get_albums` 做大小写不敏感匹配；未匹配到会输出 `未找到名称为 "<name>" 的画册` 并以 1 退出。                      |
| `-- [args]`          | 否   | 结尾 `--` 后的所有参数会被透传到插件，映射为插件 `config.json` 中的 `var` 条目。clap 启用了 `trailing_var_arg` 与 `allow_hyphen_values`，所以带连字符的值也能直接写。 |

:::caution
当前 zh 文档旧版本中写的 `--output-album-id`（接收 ID）已不存在，实际参数是 `--output-album`（接收名称）。
:::

```bash
# 单张图片导入
kabegame-cli plugin run --plugin local-import -- --file_path "C:/Pictures/image.jpg"

# 递归导入文件夹，并指定输出目录与画册名
kabegame-cli plugin run --plugin local-import \
  -o "D:/my-gallery" \
  --output-album "我的收藏" \
  -- --folder_path "C:/Pictures/anime" --recursive=true
```

### plugin pack

把一个插件目录打包为 KGPG v2 格式的 `.kgpg`。**离线可用，不需要 daemon。**

```bash
kabegame-cli plugin pack --plugin-dir <目录> --output <输出.kgpg>
```

| 参数           | 必填 | 说明                                                              |
| -------------- | ---- | ----------------------------------------------------------------- |
| `--plugin-dir` | 是   | 包含 `manifest.json` 以及 `crawl.js` 或 `crawl.rhai` 的插件目录。 |
| `--output`     | 是   | 输出的 `.kgpg` 文件路径。                                         |

打包时会自动检测 backend：优先 `crawl.js`（webview），否则回退 `crawl.rhai`；两者都不存在会报错。

:::caution
若目录内 `package.json` 存在且 `scripts.build` 非空，`plugin pack` 会在打包前**先执行一次构建**：检测到 bun lockfile 且 `bun` 在 PATH 时使用 bun，否则使用 npm，两者都找不到时报 `未找到可用的包管理器（npm/bun）…`。
:::

内部 ZIP 会收集 `manifest.json`、探测到的脚本、可选 `config.json`、`configs/**/*.json`、`doc_root/doc.md` 与本地化 `doc.<lang>.md` 及其配图（每张 ≤ 2 MB）、`templates/*.ejs`。`icon.png` 被单独编码进 KGPG 头部字段，失败时仅日志警告，不中断打包。

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
| `plugin run`                            | 是              | 通过 `IpcRequest::PluginRun` 委派 daemon。 |
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
