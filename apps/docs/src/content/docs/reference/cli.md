---
title: kabegame-cli 命令行参考
description: kabegame-cli 子命令、参数、数据目录与退出码的完整参考。
---

`kabegame-cli` 是 Kabegame 的命令行可执行文件，用于脚手架、打包、导入并运行爬虫插件，导入本地媒体，以及生成或查询 PathQL。碰数据库或主程序运行时状态的命令会优先经 IPC 交给正在运行的同数据目录主程序；连不上时才在 CLI 进程内初始化必要运行时。它**不随主程序打包**，需要时从发布页单独下载。

## 启动与定位

二进制名：

- Windows：`kabegame-cli.exe`
- macOS / Linux：`kabegame-cli`

获取方式：

- **Windows / macOS / Linux**：从 [GitHub Releases](https://github.com/kabegame/kabegame/releases/latest) 单独下载对应平台的 `Kabegame-cli-standard_<版本>_<架构>` 资产（Windows 为 setup.exe，macOS / Linux 为可执行文件）。下载后放到 PATH 或直接用绝对路径调用。
- **Android**：不提供 CLI。

除 clap 自带的 `--help` / `-h` 与 `--version` / `-V` 外，还有全局参数 `--via`：

| 值 | 语义 |
| --- | --- |
| `auto` | 默认。主程序连得上、`ipcProtocol` 兼容且两端 `dataDir` 相同时用 app；否则回退 local。单纯“未运行”静默回退，协议或目录不匹配会在 stderr 提示。 |
| `app` | 强制经主程序执行；连接、协议或数据目录校验失败立即报错。 |
| `local` | 强制在 CLI 进程初始化 Storage / Provider / 任务运行时。 |

`plugin new`、`plugin pack` 和 `pathql generate` 是纯文件/生成操作，不经 `Backend`；`.kgpg` 的包解析也始终在 CLI 本地完成。

**数据目录**没有运行时参数，由构建时的 `kabegame_data` 决定：发布页下载的 CLI 与默认构建都使用系统用户数据目录；
仓库内用 `deno task b -c kabegame-cli --data dev` 构建的 CLI 使用 `.kabegame/debug/`（与 `deno task dev` 起的应用共用）。

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

目标目录若已存在则直接报错退出。生成结果：

```text
my-site/
├─ package.json       # v3 清单，name / kbBackend 已按参数填好
├─ icon.png
├─ docs/doc.md
├─ tsconfig.json
├─ .gitignore
├─ src/index.ts       # 仅 v8：ES module 入口，产物 dist/main.js
├─ rspack.config.mjs  # 仅 v8
└─ crawl.js           # 仅 webview
```

v8 模板要先 `npm i && npm run build` 产出 `dist/main.js`，否则 `plugin pack` 会报 `main 脚本不存在`。

```bash
kabegame-cli plugin new my-site
kabegame-cli plugin new my-site --backend webview
```

### plugin run

运行一个插件并实时渲染日志与进度。目标既可以是已安装插件的 id，也可以直接给一个 `.kgpg` 文件路径。app 模式由主程序调度，任务抽屉与画廊会同步刷新；local 模式保持无 GUI 的自包含执行。

主要用途是插件开发期的快速验证：改完插件源码 → 打包 → 直接 `plugin run`，不用启动 GUI。给路径时插件**不会**被装进 `plugins-directory`，只是这一次任务临时加载它。

```bash
kabegame-cli plugin run <plugin> [选项]
```

| 参数             | 必填 | 说明                                                                                             |
| ---------------- | ---- | ------------------------------------------------------------------------------------------------ |
| `<plugin>`       | 是   | 两种形态：**已安装**插件的 id，未安装会列出当前可用的 id；或一个 **`.kgpg` 文件路径**（按扩展名识别），临时运行、不安装。若路径里的包 id 恰好也已安装，**以路径里的包为准**。 |
| `--id PLUGIN_ID` | 否   | 仅路径模式：指定本次运行用的插件 id（见下方「插件 id 怎么定」）。配已安装 id 使用会直接报错。 |
| `--var KEY=VALUE`| 否   | 覆盖单个 `kbConfig` 项，可重复。值按该 key 在 `kbConfig` 里声明的类型自动转换（int/float/boolean 等），所以 `--var page=3` 会变成数字 `3`。未知 key 会直接报错并列出可用项。 |
| `--output-dir`   | 否   | 图片输出目录。优先级高于插件默认配置里保存的 `outputDir`。                                          |
| `--album-id`     | 否   | 目标画册 id。                                                                                     |
| `--dry-run`      | 否   | 只解析并打印最终配置，不真正建任务。                                                              |
| `--plain`        | 否   | 不渲染进度条，日志逐行直出。非 TTY（管道、CI）会自动进入此模式。                                    |

**配置解析**与主应用一致，三层叠加后打印成 JSON：

1. `kbConfig` 各项的 `default`
2. 用户在应用里保存的插件默认配置（`plugins-directory/default-configs/<id>.json` 的 `userConfig`；同一文件里的 `httpHeaders` / `outputDir` 也会被采用）
3. 本次命令行的 `--var`

**插件 id 怎么定**：`--id` → 包内 `package.json` 的 `name` → `.kgpg` 文件名 stem，取第一个非空的。三者都要过 id 合法性校验（ASCII 字母/数字/`_`/`-`，≤ 64 字节），且不能撞内建插件 id；报错里会写明这个 id 是从哪儿来的。

- 包自己声明的 `name` 比文件名权威，所以把 `konachan.kgpg` 改名成 `konachan-mytest.kgpg` 照样按 `konachan` 跑（provider 的 namespace 是 `plugins.<id>`，以前这种改名会报 `provider namespace ... 不能逃逸`）。
- `--id` 用来让**同一个包跑成另一份互不干扰的数据**：插件数据目录、`default-configs/<id>.json` 的取用、入库的 `plugin_id`、provider namespace 全部跟着换（包内写死的 `plugins.<原 id>` 会自动改写到新 id 下）。
- 这条回落链对安装也生效：`plugin import` 落盘时文件名统一归一成 `<id>.kgpg`。

**后端能力**：app 模式支持 V8 与 WebView 插件；local 模式没有真实浏览器宿主，只支持 `kbBackend: "v8"`。路径模式只认打好的 `.kgpg` 包，不支持直接指向插件源码目录或裸 `.js`——先 `plugin pack`。

```bash
# 不安装，直接跑一个打好的包（配置仍按已存的 default-configs/<id>.json 叠加）
kabegame-cli plugin pack --plugin-dir ./plugins/kemono --output /tmp/kemono.kgpg
kabegame-cli plugin run /tmp/kemono.kgpg --var page=1

# 换个 id 跑同一个包：数据目录 / 默认配置 / 入库 plugin_id 都隔离开，方便对照测试
kabegame-cli plugin run /tmp/kemono.kgpg --id kemono-test

# 先安装，再按 id 运行
kabegame-cli plugin import ./packed/kemono.kgpg
kabegame-cli plugin run kemono \
  --var source=creator --var service=patreon --var creator_id=44096704 \
  --var creator_page_start=1 --var creator_page_end=1

# 只看最终配置，不跑
kabegame-cli plugin run kemono --dry-run --var source=tag --var tag=nsfw
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

**输出可复现**：同一份源码目录打多少次，`.kgpg` 都是同一串字节。两个前提由 pack 自己保证——条目按 ZIP 内路径**字母序**写入（不随 `package.json` 字段 / `kbDoc` 语言键的书写顺序漂移），每个条目的 mtime 显式钉成 1980-01-01（不取磁盘 mtime，也不取当前时间）。所以 `.kgpg` 的 sha256 只由内容决定，可以直接拿来做缓存键或校验。

:::note
跨 CLI 版本不保证字节一致：换了 zip / deflate 实现的版本，压缩结果就可能变。另外 v8 插件的 `dist/main.js` 本身是否可复现取决于打包器（rspack），不在 `plugin pack` 的职责内。
:::

### plugin import

把本地 `.kgpg` 安装到 `plugins_directory`。CLI 先在本地解析包；校验通过后再由选中的 app/local 后端安装，因此 app 模式下插件列表会立即收到更新。

```bash
kabegame-cli plugin import <path.kgpg>
```

| 参数     | 必填 | 说明                                                        |
| -------- | ---- | ----------------------------------------------------------- |
| 位置参数 | 是   | `.kgpg` 文件路径。文件不存在或扩展名非 `.kgpg` 会立即报错。 |

安装前会验证：v3 `package.json` 可解析、`main` 指向的脚本非空、`kbConfig` 若存在则可解析。落盘文件名统一归一成 `<插件 id>.kgpg`（id 见 [plugin run 的「插件 id 怎么定」](#plugin-run)），所以源文件叫什么名字都不影响安装结果。成功时输出：

```text
导入成功：id=…; name=…; version=…; 目标目录=…
```

:::note
CLI 层没有版本 / 冲突检查，重复导入同一 ID 可能覆盖已有插件。
:::

## data 子命令组

### data import-image

将单个本地图片或视频交给内建 `local-import` 任务，可选加入指定画册。命令会渲染任务进度和日志，完成后打印成功、去重、失败计数。

```bash
kabegame-cli data import-image <path> [--album /父画册/子画册]
```

| 参数      | 必填 | 说明                                      |
| --------- | ---- | ----------------------------------------- |
| `<path>`  | 是   | 本地图片或视频文件；不接受 URL 或文件夹。 |
| `--album` | 否   | 现有画册的树路径，开头的 `/` 可省略。    |

目标画册通过 `albums://by_sub_tree` 逐层解析；任一层不存在或同级重名时命令会报错，不会自动创建画册。

## pathql 子命令组

`pathql query` 经 app/local `Backend` 查询；`pathql generate` 仍在 CLI 进程内初始化 provider runtime。

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
| `1` | 子命令执行失败。包括 IPC 校验失败、插件名非法、文件缺失、画册路径无法解析、插件配置错误或 local 模式运行 WebView 插件等。 |
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
