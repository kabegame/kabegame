---
title: 打包与发布
description: 把 Rhai 插件打成 .kgpg 并发布到商店或自建源的完整流程。
---

写好插件后，你需要把它装进真机验证、打成 `.kgpg` 单文件、生成索引，然后发布到官方仓库或自建源。本文覆盖作者侧的完整发布链路，以及用户什么时候能看到你的新版本。

## 前置要求

在运行任何打包命令之前，确保以下工具就位：

- **Bun**：仓库统一使用 `bun` 运行脚本，不支持 `pnpm` / `npm` 的旧命令。
- **已构建的 `kabegame-cli`**：`bun package` 实际调用 `target/release/kabegame-cli(.exe)` 来写 `.kgpg` 固定头部，**不是**纯 JS 打包。若缺失会报错「找不到 cli … 请在 kabegame 父仓库构建 cli 工具！」。

  第一次克隆仓库后，至少执行一次：

  ```bash
  cargo build --release -p kabegame-cli
  ```

:::caution
`src-crawler-plugins/` 是一个 submodule；如果你直接 clone 了插件仓库，需要回到 Kabegame 主仓构建 CLI，否则 `bun package` 无法运行。
:::

## 本地测试

打包之前先在真机跑一遍。推荐的迭代流程：

```bash
bun dev -c main --mode local
```

`--mode local` 会在 dev 启动时自动把 `src-crawler-plugins/plugins/*` 打到仓库根的 `data/plugins-directory/`，应用启动即加载。这条路径只在 dev 下生效，`build` / `start` 不会触发。

如果你只改了某个插件，用 `--only` 加速：

```bash
bun package-plugin.ts --only konachan danbooru --out-dir ../data/plugins-directory
```

也可以逗号分隔：`--only konachan,danbooru`。

:::caution
`--only` 会清理 `packed/` 中**未列出**的 `.kgpg` 文件以防旧版本残留。**不要**在正式发布流程里用 `--only`，否则 `bun generate-index` 产出的 `index.json` 只包含子集。
:::

## `bun package`

全量打包命令：

```bash
bun package                       # 打包所有插件
bun package <plugin-id>            # 只打单个
bun package --only <id1> <id2>     # 多选
```

### 输入文件

打包只收集插件目录下以下文件：

- `manifest.json`（必需）
- `crawl.rhai`（必需）
- `config.json`
- `icon.png`
- `doc_root/doc.md`
- `doc_root/` 下的 `jpg` / `jpeg` / `png` / `gif` / `webp` / `bmp` / `svg` / `ico`

缺少 `manifest.json` 或 `crawl.rhai` 会直接报错。

:::note
`doc_root/` 之外的自定义目录会被**静默丢弃**，不会提示。所有文档资源都要放进 `doc_root/`。
:::

### 输出

默认输出到 `src-crawler-plugins/packed/<plugin-id>.kgpg`，文件名等于插件目录名。可用 `--out-dir` / `--output-dir` 覆盖。

格式遵循 KGPG v2（固定头部 + ZIP）。头部里已内嵌 icon，`index.json` 不再需要 `iconUrl`，旧的 `<id>.icon.png` 会被打包流程主动清理。详见 [插件格式（.kgpg）](/dev/format/)。

## `bun generate-index`

```bash
bun generate-index
```

读取 `packed/*.kgpg` + 每个插件的 `manifest.json` + 仓库根 `package.json` 的 `version`，产出 `packed/index.json`。这个文件就是商店前端拉取的清单，每一项包含：

| 字段 | 说明 |
|---|---|
| `id` | 插件 ID（= 目录名） |
| `version` | 来自 `manifest.json` 的 semver |
| `packageVersion` | KGPG 格式版本，当前为 `2` |
| `downloadUrl` | `https://github.com/{owner}/{repo}/releases/download/v{ver}/<id>.kgpg` |
| `sizeBytes` / `sha256` | 用于完整性校验与缓存失效 |
| `name` / `name.zh` / `name.en` / `name.ja` / `name.ko` | 从 `manifest.json` 原样复制的扁平 i18n 键 |
| `description` / `description.*` | 同上 |

索引的 `version` 字段派生规则（优先级从高到低）：

1. `--tag v1.2.3` 命令行参数
2. 环境变量 `GITHUB_REF_NAME`（仅当匹配 `v\d+\.\d+\.\d+` 才采用）
3. `package.json.version` → `v{version}`
4. 回退 `latest`

这样 CI 在 push main（`GITHUB_REF_NAME=main`）时不会把 tag 错写成 `main`。

### 一键打包 + 索引

```bash
bun release
```

等价于 `bun package && bun generate-index`。

## 发布

### 发布到官方仓库（默认商店源）

用户端默认拉取的官方源 URL 是：

```
https://github.com/kabegame/crawler-plugins/releases/latest/download/index.json
```

所以最直接的发布方式是把插件 PR 进[官方插件仓库](https://github.com/kabegame/crawler-plugins)。该仓库的 `pre-push` husky 钩子会自动执行打包、生成 index、提交 `packed/` 差异、创建 `v{version}` tag 并推送；GitHub Actions 监听 tag 后创建 Release 并上传 `packed/` 产物。

由于 URL 用的是 `releases/latest/download/...`，GitHub 的 `latest` 重定向会指向最新 Release，**你不需要改任何客户端配置**。

### 切换默认源（fork 场景）

如果你要把整个应用指向自己的插件仓库（而非追加自建源），可以在编译期用环境变量覆盖：

| 环境变量 | 默认值 |
|---|---|
| `CRAWLER_PLUGINS_REPO_OWNER` | `kabegame` |
| `CRAWLER_PLUGINS_REPO_NAME` | `crawler-plugins` |

这两个由 Rust 侧 `option_env!` 读取，**只在编译时生效**，装好的应用改不了。官方源 ID 固定为 `official_github_release`，不可删除、`index_url` 不可修改。

### 自建第三方源（参考信息）

:::note
以下为参考信息。代码允许 `add_plugin_source` 添加自定义源，但仓库目前没有正式的「第三方源发布流程」文档，以下字段清单根据 `generate-index.ts` 的 `PluginInfo` 结构整理。
:::

应用允许用户在「源管理」手动添加自建源，只要该源提供一个可公开访问的 `index.json`，且 JSON 里每个插件条目至少包含：

- `id`、`version`、`packageVersion`（`2`）
- `downloadUrl`（可以是非 GitHub 的任意公开 URL）
- `sizeBytes`、`sha256`
- `name` / `description`（建议附带 `.zh` / `.en` 等 i18n 键）

你可以用任何静态托管承载 `index.json` 与 `.kgpg`（GitHub Release、对象存储、自建 HTTP 服务）。新源 ID 不能是 `official_github_release`。

## 用户何时看到更新

发布后，用户端并非立即拉到新版本。关键节点：

- **首次打开商店 tab**：读本地 SQLite `plugin_source_cache` 的已有缓存，不按时间判定。
- **后台静默 revalidate**：缓存超过 **24 小时** 才会后台重拉（常量 `STORE_INDEX_REVALIDATE_MAX_AGE_SECS = 86400`）。
- **手动刷新按钮**：立即 HTTP GET 并覆盖缓存，刷新后会看到「商店列表已刷新」提示。

所以作者预期：**最多 24 小时** 内所有活跃用户可以自动看到新版本；急需验证可让用户手动刷新。

已下载的 `.kgpg` 还有一层磁盘缓存，在 `<cache>/store-cache/<source_id>/<plugin>.kgpg`。版本号升级后下次安装会自动失效并重下——**前提是你 bump 了 `manifest.json` 的 `version`**。

## 版本与兼容性

`manifest.json` 有两个字段决定发布能否生效：

| 字段 | 必需 | 作用 |
|---|---|---|
| `version` | ✅ | semver。同一 `id` 升级**必须** bump 此字段，否则用户端磁盘包缓存按 `expected_version` 命中旧 `.kgpg`，新内容根本不下发 |
| `minAppVersion` | 可选 | `major.minor.patch`。当前应用版本低于要求则拒绝安装，弹出「此插件要求 Kabegame >= {required}，当前版本为 {current}」 |

:::caution
要 bump 的是**插件目录下的 `manifest.json`**，不是 `src-crawler-plugins/package.json`。后者只影响 Release tag 与 `index.json` 的顶层 `version`，与用户端缓存失效无关。
:::

## 排障

**现象** `bun package` 报「找不到 cli … 请在 kabegame 父仓库构建 cli 工具！」  
**原因** 缺少 `target/release/kabegame-cli(.exe)`。  
**操作** 在主仓执行 `cargo build --release -p kabegame-cli`。

**现象** 发布后用户商店里没看到新版本。  
**原因** 24h revalidate 周期未到；或 `.kgpg` 磁盘缓存命中旧 `version`。  
**操作** 让用户在「源管理」点刷新强制 revalidate；确认已 bump `manifest.json` 的 `version`。

**现象** `packed/index.json` 里 `version` 变成了 `main`。  
**原因** 旧版本在 CI push main 时会读 `GITHUB_REF_NAME`。  
**操作** 升级 `generate-index.ts`（已修复：只接受匹配 `v\d+\.\d+\.\d+` 的值），或显式传 `--tag v1.2.3`。

**现象** `doc_root/` 外某个自定义资源没被打进 `.kgpg`。  
**原因** 打包器只收白名单文件；`doc_root/` 以外的目录静默丢弃。  
**操作** 把资源移到 `doc_root/`。

## 延伸阅读

- [插件开发总览](/dev/overview/) — 进入发布前先把插件写好
- [插件格式（.kgpg）](/dev/format/) — 理解 `packageVersion: 2` 与 `sha256` 的来由
- [插件使用方法](/guide/plugins-usage/) — 从用户侧看导入与刷新
