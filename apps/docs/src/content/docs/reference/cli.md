---
title: kabegame-cli 命令行参考
description: kabegame-cli 子命令、参数、数据目录与退出码的完整参考。
---

`kabegame-cli` 是 Kabegame 的自包含命令行可执行文件，用于在不打开 GUI 的前提下脚手架、打包、导入并运行爬虫插件，导入本地媒体，以及生成或查询 PathQL。各子命令在 CLI 进程内按需初始化数据、事件和插件运行时。它**不随主程序打包**，需要时从发布页单独下载。本页列出当前代码实际存在的子命令与参数。

## 启动与定位

二进制名：

- Windows：`kabegame-cli.exe`
- macOS / Linux：`kabegame-cli`

获取方式：

- **Windows / macOS / Linux**：从 [GitHub Releases](https://github.com/kabegame/kabegame/releases/latest) 单独下载对应平台的 `Kabegame-cli-standard_<版本>_<架构>` 资产（Windows 为 setup.exe，macOS / Linux 为可执行文件）。下载后放到 PATH 或直接用绝对路径调用。
- **Android**：不提供 CLI。

全局参数只有 clap 自带的 `--help` / `-h` 与 `--version` / `-V`。

```bash
kabegame-cli --help
kabegame-cli plugin run --help
```

## plugin 子命令组

### plugin new

在当前目录脚手架一个新的插件目录。此命令离线可用。

```bash
kabegame-cli plugin new <name> [--backend v8|webview]
```

| 参数        | 必填 | 说明                                                                                                                 |
| ----------- | ---- | -------------------------------------------------------------------------------------------------------------------- |
| `name`      | 是   | 插件名，必须是 kebab-case（正则 `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`）。`MyPlugin`、`my_plugin`、`1stplugin` 都会被拒绝。 |
| `--backend` | 否   | `v8`（默认）或 `webview`，决定生成的脚本文件与 `package.json.kbBackend`。（Rhai 后端已移除，不可选。）                |

目标目录若已存在则直接报错退出。脚手架会从模板生成 `package.json`、`icon.png`、`doc_root/doc.md` 等通用文件，并根据 backend 生成对应脚本。

```bash
kabegame-cli plugin new my-site
kabegame-cli plugin new my-site --backend webview
```

### plugin run

在 CLI **本进程内**跑一个已安装的 V8 插件，实时渲染日志与进度。

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

把一个插件目录打包为 KGPG v3 格式的 `.kgpg`。此命令离线可用。

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

把本地 `.kgpg` 安装到 `plugins_directory`。此命令直接初始化 `PluginManager`，离线可用。

```bash
kabegame-cli plugin import <path.kgpg>
```

| 参数     | 必填 | 说明                                                        |
| -------- | ---- | ----------------------------------------------------------- |
| 位置参数 | 是   | `.kgpg` 文件路径。文件不存在或扩展名非 `.kgpg` 会立即报错。 |

安装前会验证：v3 `package.json` 可解析、`main` 指向的脚本非空、`kbConfig` 若存在则可解析。成功时输出：

```text
导入成功：id=…; name=…; version=…; 目标目录=…
```

:::note
CLI 层没有版本 / 冲突检查，重复导入同一 ID 可能覆盖已有插件。
:::

## data 子命令组

### data import-image

将单个本地图片或视频直接导入数据库，可选加入指定画册并附带 metadata。

```bash
kabegame-cli data import-image <path> [--album /父画册/子画册] [--metadata <文本>]
```

| 参数         | 必填 | 说明                                                                 |
| ------------ | ---- | -------------------------------------------------------------------- |
| `<path>`     | 是   | 本地图片或视频文件；不接受 URL 或文件夹。                            |
| `--album`    | 否   | 现有画册的树路径，开头的 `/` 可省略。                               |
| `--metadata` | 否   | 原样存储的 metadata 字符串；CLI 不校验它是否为 JSON。                |

目标画册通过 `albums://by_sub_tree` 逐层解析；任一层不存在或同级重名时命令会报错，不会自动创建画册。

## pathql 子命令组

`pathql` 命令在 CLI 进程内初始化数据与 provider runtime。

### pathql generate

生成 TypeScript PathQL 客户端。输出目录不存在时会自动创建；传 `--out -` 可将生成物写到标准输出。

```bash
kabegame-cli pathql generate --target typescript --out packages/kabegame-pathql-client/client.ts
```

| 参数       | 必填 | 说明                                      |
| ---------- | ---- | ----------------------------------------- |
| `--target` | 否   | 生成目标，当前仅支持 `typescript`（默认）。 |
| `--out`    | 是   | 输出文件路径；`-` 表示标准输出。          |

生成物不入库；修改 provider DSL 后需手动重新生成。在 kabegame 仓库内推荐用 `deno task pathql:generate`——先增量构建 debug CLI 再生成，避免旧二进制（DSL 编译期内嵌）静默产出旧客户端。

### pathql query

直接查询 PathQL。默认拉取数据行，也可切换为列举子项或查询节点自身 entry。

```bash
kabegame-cli pathql query <path> [--list [--with-count] | --entry | --fetch]
```

| 参数           | 必填 | 说明                               |
| ---------------- | ---- | ---------------------------------- |
| `<path>`         | 是   | PathQL 查询路径。                  |
| `--list`         | 否   | 列举子项。                         |
| `--with-count`   | 否   | 为子项附带 total，仅与 `--list` 同用。 |
| `--entry`        | 否   | 查询节点自身 entry。              |
| `--fetch`        | 否   | 拉取数据行；未指定模式时也是此行为。 |

## 退出码

CLI 使用三种退出码：

| 码  | 含义                                                                                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `0` | 成功。子命令完成并输出结果或成功信息。                                                                                  |
| `1` | 子命令执行失败。包括插件名非法、文件缺失、画册路径无法唯一解析、插件配置错误或 WebView 插件不受支持等。                 |
| `2` | clap 参数解析错误，例如缺少必填参数或未知子命令。由 clap 在进入 `main()` 之前抛出。                                                 |

## 平台差异

| 能力                             | Windows     | macOS | Linux    | Android |
| -------------------------------- | ----------- | ----- | -------- | ------- |
| 发布页单独下载 CLI               | 是          | 是    | 是       | 不适用  |
| `plugin new` / `pack` / `import` | 是          | 是    | 是       | 不适用  |
| `plugin run`                     | 是          | 是    | 是       | 不适用  |
| `data import-image`              | 是          | 是    | 是       | 不适用  |
| `pathql generate` / `pathql query` | 是        | 是    | 是       | 不适用  |

## 常见问题

- **`--album` 无法解析画册** → 某层名称不存在或同级存在重名 → 在 GUI 中确认完整画册路径后重试。
- **`plugin new` 拒绝名称** → 名称非 kebab-case → 使用 `my-plugin` 这类全小写、短横线分隔、首字符为字母的名称。

## 延伸阅读

- [插件管理](/guide/plugins-usage/)
- [虚拟磁盘](/guide/virtual-drive/)
- [命令行（入门指南）](/guide/command-line/)
