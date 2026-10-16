---
title: 打包与发布
description: 下载 kabegame-cli，把插件打成 .kgpg、本地试跑、安装，再发布到官方商店或自建源。
---

插件写好之后，要经过四步才能到用户手里：打成 `.kgpg` 单文件 → 在本机试跑 → 装进 Kabegame → 发布。这四步都用 `kabegame-cli` 完成，不需要克隆 Kabegame 的源码仓库。

## 准备 `kabegame-cli`

`kabegame-cli` 不随 Kabegame 应用安装，要单独下载。打开 [GitHub Releases 最新版](https://github.com/kabegame/kabegame/releases/latest)，在 Assets 里下载对应平台的文件：

| 平台 | 文件名 |
|---|---|
| Windows x64 | `kabegame-cli-standard_<版本>_windows_x64.exe` |
| macOS（Apple 芯片） | `kabegame-cli-standard_<版本>_macos_aarch64` |
| Linux x64 | `kabegame-cli-standard_<版本>_linux_amd64` |

Android 没有 CLI。下载后把文件改名为 `kabegame-cli`（Windows 为 `kabegame-cli.exe`），放进 `PATH` 里的某个目录，或者之后用完整路径调用。macOS / Linux 还要加上可执行权限；macOS 上的文件没有签名，还要去掉隔离标记：

```bash
chmod +x kabegame-cli
xattr -d com.apple.quarantine kabegame-cli   # 仅 macOS
kabegame-cli --version
```

:::tip[CLI 与应用用同一个版本]
CLI 会优先把任务交给正在运行的 Kabegame 应用执行，双方的 IPC 协议版本不兼容时会退回在 CLI 自己的进程里运行。下载和已安装应用相同版本的 CLI，行为最一致。
:::

发布版 CLI 和 Kabegame 应用使用同一个系统用户数据目录：`plugin import` 装的插件，应用里能直接看到。

## 准备插件目录

一个能打包的插件目录至少有 `package.json` 和 `main` 指向的入口脚本。从零开始时，可以先用 CLI 生成模板：

```bash
kabegame-cli plugin new my-plugin                    # V8 后端
kabegame-cli plugin new my-plugin --backend webview  # WebView 后端
```

目录名只允许全小写的 kebab-case。V8 模板是 TypeScript 项目，内容如下：

```
my-plugin/
├── package.json        # 清单；main 指向 dist/main.js
├── src/index.ts        # crawl 入口
├── rspack.config.mjs   # 把 src/ 打成单个 ES module
├── tsconfig.json
├── icon.png
└── docs/doc.md         # 插件文档（kbDoc）
```

:::caution[先改模板的 devDependencies]
当前模板 `package.json` 的 `devDependencies` 用相对路径引用 `@kabegame/plugin-sdk` 和 `@kabegame/types`，只在 Kabegame 源码仓库里能装上。在仓库外开发时，把它改成下面这样，类型声明直接从 GitHub 安装：

```json
"devDependencies": {
  "@kabegame/types": "github:kabegame/kabegame-types",
  "@rspack/cli": "^1",
  "@rspack/core": "^1",
  "typescript": "^5.5.0"
}
```

模板源码没有用到 `@kabegame/plugin-sdk`，删掉它不影响构建。`@kabegame/plugin-sdk` 目前还没发布到 npm，见 [plugin-sdk 工具库](/dev/plugin-sdk/)。
:::

然后安装依赖并构建，产出 `dist/main.js`：

```bash
cd my-plugin
npm install
npm run build
```

`plugin pack` **不会**替你执行构建，每次改完源码都要先 `npm run build`。纯 JavaScript、没有构建步骤的插件（`main` 直接指向手写的 `crawl.js`）跳过这一步。

### 插件 ID

插件 ID 决定插件的数据目录、PathQL provider 的命名空间、图片记录上的 `plugin_id`，以及安装后的文件名。应用按下面的顺序取第一个非空值：

1. `plugin run` 的 `--id` 参数（只用于临时运行）；
2. `package.json` 的 `name`；
3. `.kgpg` 的文件名（去掉扩展名）。

所以 **`package.json` 的 `name` 就是插件 ID**，`.kgpg` 文件叫什么都不影响安装结果，安装后统一存成 `<ID>.kgpg`。ID 只能用 ASCII 字母、数字、`_` 和 `-`，不超过 64 字节，也不能和内建插件（如 `local-import`、`webpage`）重名。用户看到的插件名由 `name.zh`、`name.en` 等多语言键决定，`name` 只在没有对应语言时作为回退显示。

ID 发布后就不要再改：改了 `name`，应用会把它当成另一个插件，已经下载的图片和插件数据都不会跟过去。

## 打包：`plugin pack`

```bash
kabegame-cli plugin pack --plugin-dir ./my-plugin --output ./my-plugin.kgpg
```

产物是 KGPG v3 格式：固定头部（内嵌图标）加 ZIP，详见 [插件格式（.kgpg）](/dev/format/)。

打包只收集 `package.json` 里**明确引用**的文件：

- `package.json`（必需，v3 自描述清单）
- `main` 指向的脚本（必需，如 `dist/main.js` 或 `crawl.js`）
- `kbIcon` 指向的图标（编码进 KGPG 头部，不进 ZIP）
- `kbRecommendedConfigs` 引用的 `configs/*.json`
- `kbPathQLProviders` 引用的 `providers/*.json5`
- `kbMetadataMigration` 引用的迁移脚本
- `kbDescriptionTemplate` 引用的 `templates/description.ejs`
- `kbDoc` 引用的文档 Markdown
- `kbChangelog` 引用的更新日志 Markdown
- `kbAssets` 数组列出的文档与更新日志资源

缺少 v3 `package.json` 或 `main` 指向的脚本会直接报错。

:::note
清单没有引用的文件会被**静默丢弃**，不会提示。文档和更新日志里用到的图片要写进 `kbAssets` 数组，数组项和 Markdown 里的本地引用都用插件根相对路径（如 `images/home.png`）。Markdown 引用了却没声明会报错；声明了却没引用只警告。字段缺失或空数组都表示没有资源。
:::

`kbAssets` 的每一项都必须存在，且是 jpg / jpeg / png / gif / webp / bmp；单个文件超过 2 MB 会报错，总体积超过 10 MB 会警告。归一化路径以 `banner` 开头的项是**橱窗图**，会出现在插件卡片的快捷预览走马灯里，按数组顺序轮播；它们不必被 Markdown 引用，也不会触发「声明但未引用」警告。

同一个插件目录用同一版 CLI 打包，产物逐字节一致；换了 CLI 版本则不保证。

## 本地试跑：`plugin run`

打好的包不用安装就能直接跑：

```bash
kabegame-cli plugin run ./my-plugin.kgpg --id my-plugin-test --var page=1
```

- `--id` 换一个测试 ID，试跑产生的插件数据、默认配置和入库图片就不会和正式安装的插件混在一起。
- `--var key=value` 覆盖 `kbConfig` 里的配置项，可以重复；值按该配置项的类型转换。key 写错时 CLI 会列出可用的 key。
- `--dry-run` 只打印解析后的最终配置，不真的运行。
- `--output-dir <目录>` 指定图片保存位置；`--plain` 不画进度条，日志逐行输出。

Kabegame 应用正在运行时，CLI 会把任务交给应用执行，任务也会出现在应用的任务抽屉里，这时 V8 和 WebView 插件都能跑。应用没有运行时，任务在 CLI 进程内执行，**只支持 V8 后端**。用 `--via app` 或 `--via local` 可以强制选择其中一种。完整参数见 [命令行工具 · plugin run](/reference/cli/#plugin-run)。

## 安装到 Kabegame

验证通过后，用下面任意一种方式安装：

```bash
kabegame-cli plugin import ./my-plugin.kgpg
```

- 桌面端双击 `.kgpg` 文件，或把它拖进应用的「源」页面；
- 在「源管理」里点「导入源」（全平台）。

详见 [插件使用 · 导入本地 .kgpg](/guide/plugins-usage/#导入本地-kgpg)。安装同 ID 的新版本会覆盖旧版本，插件数据会保留。

## 发布

### 发布到官方商店

应用默认从官方源拉取插件列表：

```
https://github.com/kabegame/crawler-plugins/releases/latest/download/index.json
```

想让所有用户在商店里看到你的插件，把插件源码目录以 PR 提交到 [官方插件仓库](https://github.com/kabegame/crawler-plugins)。合并后由仓库维护者统一打包、生成索引并发布 Release，你不需要自己上传 `.kgpg`。

### 自建源

你也可以自己托管插件，让用户在「源管理」里添加你的源。一个源就是一个可公开访问的 `index.json`，加上它指向的 `.kgpg` 文件，放在 GitHub Release、对象存储或任何静态 HTTP 服务上都可以。

`index.json` 的结构：

```json
{
  "plugins": [
    {
      "id": "my-plugin",
      "name": "my-plugin",
      "name.zh": "我的插件",
      "name.en": "My Plugin",
      "version": "1.0.0",
      "description": "插件描述",
      "packageVersion": 3,
      "downloadUrl": "https://example.com/plugins/my-plugin.kgpg",
      "sizeBytes": 77961,
      "sha256": "87e817b2…",
      "minAppVersion": "4.5.1",
      "kbLabels": [{ "id": "auth.needProxy" }]
    }
  ]
}
```

| 字段 | 必需 | 说明 |
|---|:--:|---|
| `id` | ✅ | 插件 ID，必须等于 `package.json` 的 `name` |
| `name` / `name.<语言>` | ✅ | 商店里显示的名字，扁平的多语言键，照抄 `package.json` |
| `version` | ✅ | 照抄 `package.json` 的 `version`，用来判断用户是否需要更新 |
| `downloadUrl` | ✅ | `.kgpg` 的公开下载地址 |
| `description` / `description.<语言>` | | 描述，扁平的多语言键 |
| `packageVersion` | | 包格式版本，写 `3` |
| `sizeBytes` / `sha256` | | `.kgpg` 的字节数和 SHA-256，用于完整性校验和缓存失效，强烈建议填写 |
| `minAppVersion` | | `engines.kabegame` 去掉 `>=` 后的版本号；应用版本更低时商店显示「版本不兼容」 |
| `kbLabels` | | 照抄 `package.json` 的 `kbLabels`，商店列表里显示标签 |

`sha256` 和 `sizeBytes` 可以这样算：

```bash
shasum -a 256 my-plugin.kgpg      # macOS / Linux
wc -c < my-plugin.kgpg
Get-FileHash my-plugin.kgpg -Algorithm SHA256   # Windows PowerShell
(Get-Item my-plugin.kgpg).Length
```

每次发新版本，都要更新 `version`、`downloadUrl`、`sizeBytes`、`sha256` 这几个字段。

## 版本与兼容性

插件 `package.json` 里有两个字段决定发布能否生效：

| 字段 | 必需 | 作用 |
|---|---|---|
| `version` | ✅ | semver，每段 ≤255。同一 ID 升级**必须**提高这个值，否则用户端按版本号命中本地缓存的旧 `.kgpg`，新内容不会下发。 |
| `engines.kabegame` | 可选（强烈建议） | 最低应用版本，写法 `>=X.Y.Z`。应用版本更低时拒绝安装，并标上「版本不兼容」。用到某个版本才有的接口时，把它提高到那个版本，各能力的版本见 [更新日志](/dev/changelog/)。索引里的 `minAppVersion` 就从它得来。 |

## 用户何时看到更新

发布后，用户端不会立刻拉到新版本：

- **打开商店**：先显示本地缓存的列表。
- **后台刷新**：缓存超过 **24 小时**才会在后台重新拉取索引。
- **手动刷新**：在「源管理」点刷新，立即重新拉取。

所以新版本最多 24 小时内会出现在所有活跃用户的商店里，急着验证就让用户手动刷新。已下载的 `.kgpg` 还有一层磁盘缓存，按版本号失效——前提是你提高了 `version`。

## 排障

**现象** `plugin pack` 报 `main 脚本不存在`。
**原因** 还没构建，或 `main` 写的路径和构建产物不一致。
**操作** 先 `npm run build`，确认 `dist/main.js`（或 `main` 指向的文件）存在。

**现象** `npm install` 报找不到 `@kabegame/plugin-sdk` / `@kabegame/types` 所在的路径。
**原因** 模板的 `devDependencies` 用的是 Kabegame 源码仓库里的相对路径。
**操作** 按上文 [准备插件目录](#准备插件目录) 改成从 GitHub 安装。

**现象** 安装或打包时报插件 ID 不合规。
**原因** `package.json` 的 `name` 含有 `.`、空格、非 ASCII 字符，超过 64 字节，或与内建插件重名。
**操作** 改 `name`；报错信息里会写明这个 ID 来自哪里（`--id`、`name` 还是文件名）。

**现象** `plugin run` 跑 WebView 插件时报错。
**原因** 应用没有运行，CLI 在自己的进程里执行，而本地模式只支持 V8。
**操作** 先启动 Kabegame 应用再运行。

**现象** 文档里的图片没被打进 `.kgpg`。
**原因** 打包只收 `kbAssets` 里列出的插件根相对路径。
**操作** 在 `kbAssets` 里声明图片路径，并确认 `kbDoc` / `kbChangelog` 里的引用归一化后与它一致。

**现象** 发布后用户的商店里没看到新版本。
**原因** 还没到 24 小时的刷新周期，或者磁盘缓存命中了旧 `version`。
**操作** 让用户在「源管理」手动刷新；确认 `package.json` 和 `index.json` 里的 `version` 都已提高。

## 延伸阅读

- [插件开发总览](/dev/overview/)：发布前先把插件写好。
- [命令行工具](/reference/cli/)：`plugin new` / `pack` / `run` / `import` 的完整参数。
- [插件格式（.kgpg）](/dev/format/)：`kbPackageVersion: 3` 与固定头部的由来。
- [插件使用](/guide/plugins-usage/)：从用户侧看导入与刷新。
