---
title: Wallpaper Engine 壁纸
description: 把 Wallpaper Engine 壁纸导入 Kabegame，并自己准备场景壁纸需要的资源。
---

Kabegame 能导入 Wallpaper Engine（下称 WPE）的壁纸目录，支持视频、网页、场景三类。WPE 是 Steam 上的付费应用，Kabegame 不附带它的文件。

视频和网页壁纸导入即可，场景壁纸还要读 WPE 的内置资源。如果你用的是 macOS、Linux，或者不想在这台电脑上装 WPE，需要自己把这些资源放到本机，做法见[拿到 WPE 资源](#拿到-wpe-资源)。各平台能做什么见[平台差异](#平台差异)。

---

## 导入壁纸（仅桌面）

入口在画廊顶栏的「开始收集」：选「壁纸」，打开「导入 Wallpaper Engine 壁纸」对话框。

对话框自动列出本机 Steam 库里的来源：「创意工坊订阅」「官方默认壁纸」「我的项目」。也可以点「添加文件夹」选任意文件夹，然后点「开始导入」。已导入的壁纸会自动跳过。

:::caution
导入是**原地引用**：Kabegame 不复制文件，也不修改这些文件。导入后不要移动或删除原目录，否则对应壁纸会失效。
:::

### 其它导入方式

除了「壁纸」入口，下面几种方式遇到 WPE 壁纸目录时，也会把整个目录作为一张壁纸导入，不会把里面的预览图和视频拆成一张张图片：

- **本地导入**：在「开始收集」里选「本地导入」，或把文件夹拖进主窗口。选中的文件夹本身是壁纸目录，或者它下面某一层是壁纸目录，都能识别。
- **文件夹画册**：同步目录里的壁纸目录会出现在这个画册里，不会为它另建子画册。旧版本已经为它建了子画册的目录保持原样。已经同步过的文件夹里原有的壁纸目录，要等这个文件夹下次有变化时才会被识别。
- **从另一台电脑复制**：见下一节。

### 从另一台电脑复制壁纸

没法在这台电脑上装 WPE（比如 macOS）时，可以把另一台电脑上已经导入 Kabegame 的壁纸传过来：

1. 在源电脑（通常是 Windows）的 Kabegame 里，到「设置 → 高级」开启 Web 服务器。两台电脑的 Kabegame 都需要 4.7.0 或更高版本。
2. 在这台电脑上安装「Kabegame 服务器」插件，「服务器地址」填源电脑的地址（如 `http://192.168.1.10:7490`），然后开始收集。只想复制壁纸时，用「过滤」模式并在源电脑的「高级查询」里把类型选成 Wallpaper Engine。

壁纸会被完整下载到这台电脑的下载目录，一张壁纸一个文件夹，标签一并带过来。任务日志逐个文件显示进度；这台电脑上已有内容相同的壁纸时不会多存一份。

:::caution
桌面端 Web 服务器没有鉴权，请只在你信任的网络里开启。从图库删除这类壁纸只删记录，下载目录里的壁纸文件夹不会被删除，需要时请手动清理。
:::

### 手选文件夹时选哪一层

手选文件夹时，Kabegame 只看该文件夹自身和向下两层，找含 `project.json` 的目录。

| 选择的文件夹 | 能否识别 |
|---|---|
| `wallpaper_engine/projects/defaultprojects` | 可以 |
| `wallpaper_engine/projects` | 可以 |
| 创意工坊内容目录（路径以 `steamapps/workshop/content/431960` 结尾） | 可以直接选 |
| `wallpaper_engine` 根目录 | 不行，壁纸藏得太深 |
| Steam 库根目录 | 不行，壁纸藏得太深 |

选得太靠上时会提示「未识别到 Wallpaper Engine 壁纸目录」。

---

## 哪些情况需要 WPE 资源

只有**场景壁纸**需要，视频和网页壁纸不需要。

场景壁纸要读 WPE 安装目录里的内置资源，主要是 `assets` 目录（内置着色器、effect、材质等）。读不到时，场景壁纸显示预览图。

| 你的情况 | 要做什么 |
|---|---|
| 在 Windows 上通过 Steam 安装了 WPE | 什么都不用做，Kabegame 自动找到 |
| 在 macOS、Linux 上，或者不想在这台电脑上装 WPE | 自己把资源放到本机，见下文 |

:::note
场景壁纸目前只能渲染一小部分。用到尚未支持的特性时（例如文字、粒子、声音）显示作者的预览图，这是正常现象。
:::

---

## 拿到 WPE 资源

:::caution[付费与版权前提]
WPE 是 Steam 上的付费应用（app id 431960）。Kabegame 不附带它的文件，也不提供下载，你需要自己购买。

默认壁纸（比如 Razer Bedroom）是 WPE 自带的，不是创意工坊条目，没有单独的公开下载。

不要用第三方转存包：那是付费软件里的内容，来源也不可靠。
:::

### 方法一：从装了 WPE 的 Windows 电脑复制（推荐）

Steam 上的默认位置是 `<Steam 库>\steamapps\common\wallpaper_engine\`，例如 `D:\Applications\Steam\steamapps\common\wallpaper_engine\`。

复制这些内容，放在本机任意位置，保留相对结构：

```text
wallpaper_engine/
├── assets/                    # 必需：内置着色器、effect 等
├── projects/defaultprojects/  # 可选：官方默认壁纸；导入它之后 Kabegame 能自动定位这个目录
├── locale/                    # 可选：壁纸属性里内置文字的翻译
└── config.json                # 可选：「场景后处理」选「跟随 WPE」时读取
```

各项缺失的后果：

| 内容 | 是否必需 | 缺了会怎样 |
|---|---|---|
| `assets/` | 必需 | 场景壁纸显示预览图 |
| `projects/defaultprojects/` | 可选 | 没有官方默认壁纸；要在设置里手动指定目录 |
| `locale/` | 可选 | 壁纸属性里的部分文字显示成 `ui_` 开头的键名 |
| `config.json` | 可选 | 「跟随 WPE」时视为关闭后处理。这个文件运行过 WPE 才有，直接下载的版本没有它 |

创意工坊壁纸在 `<Steam 库>\steamapps\workshop\content\431960\`，要用的话也复制过来，放在别处也行，用「添加文件夹」导入。它们和默认壁纸共用同一份 `assets`。

### 方法二：没有 Windows 电脑时用 DepotDownloader

[DepotDownloader](https://github.com/SteamRE/DepotDownloader) 是开源命令行工具，可以用你自己已购买 WPE 的 Steam 账号，在其它系统上下载 Windows 版文件。

:::caution
运行时会要求输入 Steam 密码和令牌验证码。这是第三方工具，请自行判断是否使用。
:::

macOS 上用 Homebrew 安装，其它系统可以从它的 GitHub Releases 下载：

```bash
brew tap steamre/tools && brew install depotdownloader
```

下载到 `~/wpe/wallpaper_engine`（`<你的账号>` 换成自己的 Steam 账号名）：

```bash
depotdownloader -app 431960 -os windows -username <你的账号> -dir ~/wpe/wallpaper_engine
```

- `-os windows` 不能省，WPE 只有 Windows 版。
- 下载的是完整的 Windows 版文件，已经包含 `assets`、`projects/defaultprojects`、`locale`，**没有** `config.json`。

### 目录要求

无论用哪种方法，放好的目录都要满足：

- 目录里必须有 `assets/shaders/common.h`，否则选择时会报错。自动查找也用这条判断。
- 目录名不要求必须叫 `wallpaper_engine`，里面的结构要保留。
- 要用真实目录，不要用符号链接（软链接），否则 `assets` 读取会被拒绝。

---

## 放好之后

1. 在画廊的「开始收集」里选「壁纸」，点「添加文件夹」，选 `wallpaper_engine/projects/defaultprojects`，再点「开始导入」。
2. 导入后打开一张场景壁纸的预览。Kabegame 会自动找到目录并写入设置，不用重启。

如果没有导入任何该目录下的壁纸（比如只复制了 `assets`），到设置的壁纸分区手动选择「Wallpaper Engine 目录」。

壁纸属性里的内置文字是例外：词条每次运行只读取一次，如果放好目录之前已经打开过壁纸属性，要重启应用才生效。

---

## Kabegame 怎么找到这个目录

设置的壁纸分区有一项「Wallpaper Engine 目录」，三个桌面平台都有。

| 这项设置 | 效果 |
|---|---|
| 留空 | 自动查找：先看 Steam 库，再从库里已导入的壁纸所在路径逐级往上找。找到后写入这项设置，之后一直用它 |
| 「选择」 | 手动选 `wallpaper_engine` 目录，手动指定的值优先 |
| 「恢复默认」 | 清空这项设置，并立即重新自动查找 |

都找不到时，场景壁纸显示预览图，日志里有一条警告。

---

## 平台差异

| 平台 | 导入与预览 | 设为桌面壁纸 | 其它 |
|---|---|---|---|
| Windows | 支持 | 支持（窗口模式） | 网页壁纸有音频与媒体数据，可响应桌面鼠标 |
| macOS | 支持 | 支持（窗口模式） | 网页壁纸没有音频与媒体数据，桌面上不能交互 |
| Linux | 支持 | 不支持，只能预览和用作应用内背景 | 网页壁纸没有音频与媒体数据；系统不支持 WebGPU 时场景显示预览图 |
| Android / Web 版 | 不能导入 | 不支持 | 已有的 WPE 壁纸只显示预览图 |

---

## 排障

### 场景壁纸还是显示预览图

依次看：

1. 这张壁纸是否用了尚未支持的特性。场景目前只能渲染一小部分，这种情况不是配置问题。
2. 设置里的「Wallpaper Engine 目录」有没有值、目录是否还在。
3. Linux 上系统是否支持 WebGPU。
4. 查看日志，方法见[故障排查](/guide/troubleshooting/)的「查看日志」。日志里出现 `assets:missing` 表示没找到目录。

### 属性名显示成 `ui_` 开头的键名

缺 `locale` 目录，或者刚放好目录。放好 `locale` 后重启应用生效，词条每次运行只读取一次。

### 添加文件夹提示「未识别到 Wallpaper Engine 壁纸目录」

选的目录太靠上，改选 `projects/defaultprojects` 或 `projects`。

### 移动了 `wallpaper_engine` 目录后壁纸失效

导入是原地引用。到设置里重新选择目录，再重新导入壁纸。失效的旧记录可以从图库删除，这只删记录，不碰磁盘上的文件。

---

## 延伸阅读

- [壁纸](/guide/wallpaper/)——「抱到桌面上」与壁纸轮播。
- [故障排查](/guide/troubleshooting/)——「查看日志」。
