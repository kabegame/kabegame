# Kabegame 二次元爬虫客户端

> [English](README.md) | 中文 | [日本語](README.ja.md) | [한국어](README.ko.md)

一个基于 Tauri 的二次元爬虫客户端！爬取、管理、设置/轮播壁纸，让老婆们（或老公们）每天陪伴你~ 支持插件扩展，轻松爬取各种二次元站点资源~

> 🌐 **在线体验**：[https://kabegame.com/](https://kabegame.com/)

<div align="center">
  <img src="docs/images/icon.png" alt="Kabegame" width="256"/>
</div>

## 画廊截图

<!--一行两张桌面图片并排右边一张安卓图片，两行-->
<table>
  <tr>
    <td align="center" style="width: 300px;">
      <img src="docs/images/main-screenshot-windows-gallery.png" alt="Kabegame windows 截图 1" width="300"/><br/>
      <small>Windows</small>
    </td>
    <td align="center" style="width: 300px;">
      <img src="docs/images/main-screenshot-windows-preview.png" alt="Kabegame windows 截图 2" width="300"/><br/>
      <small>Windows</small>
    </td>
    <td align="center" rowspan="2" style="vertical-align: top; text-align: right; width: 200px;">
      <img src="docs/images/main-screenshot-android-gallery.jpg" alt="Kabegame android 截图" width="200"><br/>
      <small>Android</small>
    </td>
  </tr>
  <tr>
    <td align="center" style="width: 300px;">
      <img src="docs/images/main-screenshot3-macos.png" alt="Kabegame macos 截图" width="300"/><br/>
      <small>macOS</small>
    </td>
    <td align="center" style="width: 300px;">
      <img src="docs/images/main-screenshot-linux.png" alt="Kabegame linux 截图" width="300"/><br/>
      <small>Linux</small>
    </td>
  </tr>
</table>

## 各网站爬取截图

<!-- 各网站爬取插件截图，两列栅格，推荐宽高400px，移动端会自动流式换行 -->

|  |  |
| --- | --- |
| <div align="center"><img src="docs/images/crawler/pixiv.png" alt="Pixiv 爬取截图" width="380"/><br/><small><a href="https://pixiv.net">Pixiv</a>（画师：<a href="https://www.pixiv.net/users/16365055">somna</a>）</small></div> | <div align="center"><img src="docs/images/crawler/anihonet.png" alt="anihonet 爬取截图" width="380"/><br/><small><a href="https://anihonetwallpaper.com">anihonet</a>(年榜)</small></div> |
| <div align="center"><img src="docs/images/crawler/anime-pictures.png" alt="anime-picture 爬取截图" width="380"/><br/><small><a href="https://anime-pictures.net">anime-pictures</a>(关键字：崩壊:スターレイル)</small></div> | <div align="center"><img src="docs/images/crawler/konachan.png" alt="konachan 爬取截图" width="380"/><br/><small><a href="https://konachan.net">konachan</a>壁纸</small></div> |
| <div align="center"><img src="docs/images/crawler/2dwallpaper.png" alt="Artstation 爬取截图" width="380"/><br/><small><a href="https://2dwallpapers.com">2dwallpaper</a>壁纸(游戏壁纸-&gt;Genshin-&gt;最多查看)</small></div> | <div align="center"><img src="docs/images/crawler/ziworld.png" alt="花瓣网 爬取截图" width="380"/><br/><small><a href="https://t.ziworld.top">ziworld</a>壁纸</small></div> |

<p align="center"><sub>（支持众多站点，插件可自定义扩展，欢迎开发者贡献更多爬虫插件！）</sub></p>

[→爬虫插件仓库](https://github.com/kabegame/crawler-plugins/tree/main)

## 名称由来 🐢

**Kabegame** 是日语「壁亀」（かべがめ）的罗马音，与「壁纸」（かべがみ）发音相近~ 就像一只安静的龟龟趴在你的桌面上，默默守护着你的二次元壁纸收藏，不吵不闹，只负责治愈你~ これで毎日癒やされるね。やったぁ～ ✨

> 我的观念：拥抱开源，做二次元人自己的软件

## 功能特性

- 🔌 **爬虫客户端**：通过 `.kgpg` 插件从各站爬取壁纸；内置插件商店浏览/安装/管理；任务进度与停止/删除；CLI 可打包/导入插件并导入或查询本地数据
- 🎨 **壁纸设置器（图片/视频）**：收集、管理、轮播二次元壁纸，自动从指定画册更换桌面壁纸（随机/顺序），让桌面充满二次元气息
- 🖼️ **图片管理者（图片/视频）**：画廊浏览、画册整理、虚拟磁盘（Windows 挂载为盘符，macOS/Linux 为虚拟文件夹）、拖拽导入本地图片/视频/文件夹/压缩包或 kgpg 插件

（视频截至 v3.2.2 仅支持 mp4 与 mov 格式）

## 安装方法


**根据你的操作系统，选择合适的安装包。**

**[前往 GitHub Releases 下载（最新版）](https://github.com/kabegame/kabegame/releases/latest)**

| 操作系统 | 下载 |
|---------|------|
| Windows | [setup.exe](https://github.com/kabegame/kabegame/releases/download/v4.4.0/Kabegame-standard_4.4.0_x64-setup.exe) |
| macOS | [dmg 映像](https://github.com/kabegame/kabegame/releases/download/v4.4.0/Kabegame-standard_4.4.0_aarch64.dmg) |
| Linux | [deb 包](https://github.com/kabegame/kabegame/releases/download/v4.4.0/Kabegame-standard_4.4.0_amd64.deb) |

- **安卓预览版**：[apk](https://github.com/kabegame/kabegame/releases/download/v4.4.0/Kabegame_4.4.0_android-preview.apk)（同一发布页）。
- **CLI 工具**：不随应用打包，单独分发；在同一发布页下载对应平台的 `kabegame-cli`，放入 PATH 即可使用（`kabegame-cli --help`）。

## 安装方法

### Windows

1. **下载安装包**：下载 `setup.exe` 文件
2. **运行安装程序**：双击 `setup.exe` 文件，按照向导完成安装
3. 大功告成！

> **提示**：安装程序支持自动更新，再次运行安装程序即可更新到新版本。

### MacOS

> **最低系统版本要求**：macOS **11 (Big Sur)** 及以上。

1. **下载 DMG 文件**：下载 `.dmg` 文件
2. **安装应用**：
   - 打开下载的 `.dmg` 文件
   - 将 `Kabegame.app` 拖拽到「应用程序」文件夹
> [!IMPORTANT]
> ## 修复 “Kabegame.app” 已损坏，无法打开。建议你将该对象移到废纸篓。
> 将应用安装到 Applications 文件夹后，你需要绕过 Gatekeeper 才能运行（因为这是开源应用，而且我是穷学生（现在还没offer），所以没钱给Apple付费）。
>
> `xattr -d com.apple.quarantine /Applications/Kabegame.app`
3. **虚拟磁盘fuse依赖**：
   - MacOS的虚拟磁盘功能依赖macfuse，通过 `brew install macfuse`安装
   - 首次挂载会弹窗请求权限
### Linux（Debian 分发，如 Ubuntu）

> **最低系统版本要求**：**Ubuntu 22.04** / Debian 12 及以上（glibc ≥ 2.35）。

**安装应用**：
  ```bash
  sudo apt install ./Kabegame-standard_<version>_<arch>.deb
  ```
  - 或 `sudo dpkg -i Kabegame-standard_<version>_<arch>.deb`；遇依赖问题再运行 `sudo apt-get install -f` 自动修复

## 主要功能

### 🖼️ 画廊浏览与图片管理

画廊是 Kabegame 的核心，所有收集到的壁纸都会在这里展示。支持分页浏览、快速预览、多选操作、去重清理等功能。你可以直接拖入本地文件快速导入。双击图片即可在应用内预览大图，支持缩放、拖拽、切换等操作，也可以设置系统看图软件打开。

<div align="center">
  <img src="docs/images/main-screenshot-macos-gallery1.png" alt="MacOS画廊截图1" width="400"/>
  <img src="docs/images/main-screenshot-macos-gallery2.png" alt="MacOS画廊截图2" width="400"/>
</div>

### 📸 画册整理

画册功能让你可以自由整理和分类收集到的壁纸。创建自定义画册，将喜欢的图片加入其中，支持拖拽调整顺序。画册可以用于壁纸轮播，也可以作为虚拟磁盘的目录结构。每个画册都有独立的封面和描述，让你的收藏更有条理。

<div align="center">
  <img src="docs/images/album.png" alt="画册列表" width="400"/>
  <img src="docs/images/album-detail.png" alt="画册详情" width="400"/>
</div>


### 🔌 强大的插件系统

Kabegame 的核心竞争力在于其插件化的爬虫系统（本地导入文件功能本质上是一个爬虫插件）。通过 `.kgpg` 插件文件，你可以轻松从各种二次元壁纸网站收集资源。插件使用 Rhai 脚本语言编写，支持复杂的爬取逻辑。应用内置插件商店（[插件仓库](./src-crawler-plugins)），可以一键安装热门插件，也可以导入别人开发的插件，甚至可以编写你自己的插件。每个插件都可以配置参数，在运行脚本的时候由用户输入。你也可以在运行的时候配置http头，分かるな。

<div align="center">
  <img src="docs/images/plugins.png" alt="插件" width="400"/>
  <img src="docs/images/plugin-detail.png" alt="插件细节1" width="400"/>
</div>

### 🎨 壁纸设置与轮播

一键设置桌面壁纸（图片右键抱到桌面上），支持原生模式和窗口模式。原生模式性能优秀，窗口模式功能更丰富。开启壁纸轮播后，可以自动从指定画册中更换壁纸，支持随机和顺序两种模式，可自定义轮播间隔。让桌面每天都有新惊喜！

<div align="center"><small>设置图片壁纸</small></div>

![设置壁纸](./docs/images/set-wallpaper.gif)

<div align="center"><small>设置视频壁纸（Windows、MacOS）</small></div>

![设置视频壁纸](./docs/images/set-v-wallpaper.gif)
### 📋 爬虫任务管理

所有收集任务都在这里统一管理。实时查看任务进度、状态、已收集图片数量等信息。支持查看任务详情、停止运行中的任务、删除已完成的任务。任务详情页以网格形式展示已收集的图片，可以预览、选择、添加到画册或删除。

| ![开始任务](docs/images/start-crawl.png)<br/><sub>开始任务</sub> | ![任务进行中](docs/images/crawling.png)<br/><sub>任务进行中</sub> |
|:-----------------------------------------------------------:|:----------------------------------------------------------:|
| ![任务日志](docs/images/task-log.png)<br/><sub>任务日志</sub>    | ![任务图片](docs/images/task-images.png)<br/><sub>任务图片</sub>  |
|                                                             |                                                            |

### 💾 虚拟磁盘

在 Windows、MacOS和Linux系统上，Kabegame 可以将画册挂载为虚拟磁盘（虚拟目录），让你在资源管理器中像浏览普通文件夹一样浏览画册和图片。支持按插件、按时间、按任务、按画册等多种目录结构，带来更加灵活和原生的浏览体验。

<div align="center">
  <img src="docs/images/setting-VD.png" alt="设置虚拟磁盘" width="400"/>
  <img src="docs/images/VD-view.png" alt="VD 浏览视图" width="400" />
  <img src="docs/images/VD-view-mac.png" alt="VD macos 浏览视图" width="400" />
</div>

### ⌨️ 命令行工具

提供自包含的 CLI 工具（无界面，纯命令行），支持创建、打包和导入插件，导入单个本地图片/视频，以及查询 PathQL 数据；使用时不需要启动 Kabegame 主程序。CLI 不随应用打包，需从发布页单独下载。


### 更多用法
应用内置一个帮助页面，能够帮助你更好了解龟龟！
![help](./docs/images/help.png)

これからもっと機能や改良を行っていく予定です。ぜひご期待を。

## 注意事项

- 请遵守目标网站的 robots.txt 和使用条款，合理使用爬虫功能
- 壁纸默认存储在用户的图片（Pictures/Kabegame）文件夹下，否则位于应用数据目录的 images 中（具体位置应用中可以确认并且设置）
- 所有数据保存在应用数据目录中，缓存则保存在缓存目录中，卸载应用时勾选删除会删除应用数据，但不会删除图片
- 壁纸轮播功能需要应用在后台（托盘图标）运行，关闭应用后轮播会自动停止

## 卸载方法

### Windows
#### 方法一
打开设置 -> 应用 -> 已安装应用 -> 搜索 Kabegame -> 点击右边三个点 -> 卸载
#### 方法二
右键点击应用快捷方式 -> 打开文件所在位置 -> 找到 uninstall.exe -> 双击运行即可删除

### Linux（Debian分发）
运行以下命令：
```sh
sudo dpkg -r kabegame
```

---

## 技术栈

- **前端**: Vue 3 + TypeScript + Element Plus + UnoCSS
- **后端**: Rust (Tauri) + Kotlin（Jetpack）
- **状态管理**: Pinia
- **路由**: Vue Router
- **构建工具**: Vite5
- **插件脚本**: Rhai

## 开发

### 前置要求

- Deno 2.9.0（推荐树内自编：`bash scripts/build-deno.sh` 产出 `target/release/deno`，将 `target/release` 前置到 PATH；或用官方安装脚本装 2.9.0 过渡）
- Rust 1.70+ (Rust 2021 Edition)
- [Tauri CLI](https://tauri.app/v2/guides/getting-started/prerequisites)

### 安装依赖

```bash
deno install
```

FFmpeg 以 **Git 子模块**形式引用于 `third/FFmpeg`（用于桌面端视频预览压缩）。若需执行 `deno task build:ffmpeg`：

- **已有子模块提交时**（克隆后）：`git submodule update --init --recursive`，或克隆时使用 `git clone --recurse-submodules <repo-url>`。
- **首次将 FFmpeg 加入为子模块时**（仅需一次，克隆体积较大）：`git submodule add https://github.com/FFmpeg/FFmpeg.git third/FFmpeg`。若此前在 `third/FFmpeg-master` 放过完整拷贝，可在此后删除该目录。

### Git 钩子：push 前自动尝试打 tag（可选）

本仓库使用 Husky 提供 git hooks：在 `git push` 之前会读取 `src-crawler-plugins/package.json` 的 `version`，
并尝试创建 `v{version}` 的 tag（例如 `1.0.0` → `v1.0.0`）。如果 tag 已存在或创建失败会**跳过且不阻断 push**。

- 启用方式：`deno install` 不会自动执行 `prepare`，克隆后需手动执行 `deno task prepare`（根目录与 `src-crawler-plugins` 各一次）
- 手动重装 hooks：执行 `deno task prepare`

### 开发/构建命令（统一入口）

项目采用 **Cargo Workspace** 架构，包含三个独立应用：
- **kabegame**：主应用（Tauri GUI，前端端口 1420）
- **kabegame-cli**：命令行工具（无界面）

所有应用共享 `kabegame-core` 核心库。

```bash
# 开发模式（带 watch，热重载）
deno task dev -c kabegame              # 启动主应用（端口 1420）
deno task dev -c kabegame --mode local # 使用 local 模式（无商店版本，预打包全部插件）

# 启动模式（无 watch，直接运行）
deno task start -c kabegame-cli            # 启动 CLI 工具

# 构建生产版本
deno task b                    # 构建全部组件（kabegame + kabegame-cli）
deno task b -c kabegame            # 构建主应用
deno task b -c kabegame-cli             # 构建 CLI 工具

# 检查（不产出构建产物）
deno task check -c kabegame                # 依次检查 vue 与 cargo
deno task check -c kabegame --skip cargo   # 仅检查 vue

# 编译 FFmpeg 侧载可执行文件（仅桌面端视频预览压缩用，在目标系统上直接编译）
deno task build:ffmpeg             # 需 libx264（macOS: brew install x264，Ubuntu: libx264-dev）
```

说明：
- `-c, --component`：指定要开发/启动/构建的组件（`kabegame` | `kabegame-cli`）
- `deno task check` 必须用 `-c, --component` 指定组件
- `--mode`：构建模式
  - `standard`（默认）：标准版本，支持插件商店、虚拟磁盘和 CLI
  - `android`：Android 目标（替代原 `--android` 标志）
- `--data`：数据目录模式
  - `dev`（`deno task dev` 默认）：使用仓库本地 `data/` 和 `cache/` 目录
  - `prod`（其他命令默认）：使用系统用户数据目录
  - 示例：`deno task dev -c kabegame --data prod` 可在开发时访问已安装版本的数据
- `--skip <skip>`：跳过某个流程（只能一个值：`vue` | `cargo`）
  - 在 `check` 中始终生效：`--skip vue` 跳过 `vue-tsc`，`--skip cargo` 跳过 `cargo check`
  - 在 `build` 中：
    - `kabegame-cli`：`--skip vue` 跳过前端构建，`--skip cargo` 跳过后端构建
    - `kabegame`：仅支持 `--skip vue` 跳过前端构建（仍会执行 `cargo tauri build`）
- kabegame 应用 `deno task dev -c kabegame` 会将爬虫插件打包输出到仓库本地开发数据目录的 `plugins-directory` 供本地调试；正式安装包不再内置商店插件，用户从 GitHub 商店源下载安装
- `dev` 的前端由各自的 `tauri.conf.json` 的 `beforeDevCommand` 启动；`build` 时前端由构建脚本显式构建

### Android 开发

#### 前置要求

Android 开发需要额外的环境配置，详见 [Android 迁移指南](docs/TAURI_ANDROID_MIGRATION.md)。主要要求包括：

> **壁纸功能实现**：Android 平台壁纸设置（填充模式、过渡效果、视差滚动）的完整实现方案，详见 [Android 壁纸实现方案](docs/ANDROID_WALLPAPER_IMPLEMENTATION.md)。

- Android Studio（需安装）
- `JAVA_HOME` 环境变量（指向 Android Studio 的 JBR）
- `ANDROID_HOME` 环境变量（指向 Android SDK 目录）
- `NDK_HOME` 环境变量（**必须配置**，否则编译会失败）
- Rust Android 目标：`rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`

应用**最低支持 Android 8.0（API 26+）**，构建配置中 `minSdk = 26`。

#### 在真机/模拟器上运行

Android 开发需使用 **`deno task dev -c kabegame --mode android`**（不能省略 `--mode android`，否则会跑桌面版）。若连接了多台设备（真机 + 模拟器），Tauri 可能选错设备，可指定设备 ID：

```bash
# 查看已连接设备
adb devices

# 指定设备运行（将 <设备ID> 替换为 adb devices 第一列的值，如 10AECH09ZX001DJ）
deno task dev -c kabegame --mode android -- <设备ID>
```

#### 打开开发者工具

在 Android 平台上，Tauri 不支持像桌面端那样直接调用 `open_devtools()` API。需要使用 **Chrome DevTools** 进行远程调试：

**方法一：使用 Chrome DevTools（推荐）**

1. **确保设备已连接并开启 USB 调试**
   ```bash
   # 检查设备是否连接
   adb devices
   ```

2. **在 Chrome 浏览器中打开开发者工具**
   - 在桌面 Chrome 中访问：`chrome://inspect/#devices`
   - 确保 "Discover USB devices" 已勾选
   - 在设备列表中会显示你的 Android 设备
   - 找到你的应用（Kabegame），点击 "inspect" 打开开发者工具

**方法二：通过 ADB 命令**

```bash
# 1. 确保设备已连接
adb devices

# 2. 转发端口（如果需要）
adb forward tcp:9222 localabstract:chrome_devtools_remote

# 3. 在 Chrome 中访问
# chrome://inspect/#devices
```

**注意事项：**

- 确保应用以 **Debug 模式**运行（开发模式会自动启用）
- Android WebView 在 Debug 构建中默认启用调试，无需额外配置
- 如果看不到设备：
  - 检查 USB 调试是否开启
  - 检查 ADB 驱动是否安装
  - 尝试重新连接设备：`adb kill-server && adb start-server`

## 项目结构

```
.
├── apps/                  # 前端应用
│   └── kabegame/             # 主应用前端（Vue 3 + TypeScript，端口 1420）
├── packages/             # 共享包
│   └── core/             # 共享前端组件和工具
├── src-tauri/            # Rust 后端代码（Cargo Workspace）
│   ├── kabegame-core/             # 共享核心库（kabegame-core）
│   ├── kabegame/         # 主应用（Tauri GUI）
│   ├── kabegame-cli/          # CLI 工具（纯 Rust 命令行，无界面）
│   └── icons/            # 应用图标资源
├── src-crawler-plugins/  # 插件相关
├── scripts/              # 构建脚本
├── docs/                 # 文档
├── static/               # 静态资源
├── deno.json             # Deno 工作区配置
├── package.json          # Node.js 依赖（workspace 配置）
└── Cargo.toml            # Rust Cargo Workspace 配置
```

![visitor badge](https://visitor-badge.laobi.icu/badge?page_id=kabegame.readme.zh-CN)

## 插件开发

插件开发相关文档请参考：
- [插件开发指南](docs/README_PLUGIN_DEV.md)
- [插件文件格式](docs/PLUGIN_FORMAT.md)
- [Rhai API 文档](docs/RHAI_API.md)
- [爬虫 WebView 架构设计](docs/CRAWLER_WEBVIEW_DESIGN.md)（规划中）

## License

The source code is licensed under GPL v3. License is available [here](./LICENSE).

## 致谢

本项目基于以下优秀的开源项目构建，感谢这些项目的开发者和社区：

### 核心框架
- [**Tauri**](https://github.com/tauri-apps/tauri) - 构建跨平台桌面应用的框架（本项目的框架，以及部分代码参考）
- [**Vue**](https://github.com/vuejs/core) - 渐进式 JavaScript 框架（本项目的前端核心）
- [**Vite**](https://github.com/vitejs/vite) - 下一代前端构建工具
- [**TypeScript**](https://github.com/microsoft/TypeScript) - JavaScript 的超集，提供类型安全

### UI 与工具库
- [**Element Plus**](https://github.com/element-plus/element-plus) - 基于 Vue 3 的组件库
- [**Pinia**](https://github.com/vuejs/pinia) - Vue 的状态管理库
- [**Vue Router**](https://github.com/vuejs/router) - Vue.js 官方路由管理器
- [**Axios**](https://github.com/axios/axios) - 基于 Promise 的 HTTP 客户端
- [**UnoCSS**](https://github.com/unocss/unocss) - 原子动态CSS框架
- [**panzoom**](https://github.com/timmywil/panzoom) - 预览图拖拽放缩库
- [**PhotoSwipe**](https://github.com/dimsemenov/PhotoSwipe) - 移动端图片浏览库，本项目基于其重写了vue版本

### 后端与工具
- [**Rhai**](https://github.com/rhaiscript/rhai) - 嵌入式脚本语言引擎（本项目插件脚本Rhai后端的核心支持）
- [**Serde**](https://github.com/serde-rs/serde) - Rust 序列化框架
- [**Tokio**](https://github.com/tokio-rs/tokio) - Rust 异步运行时
- [**Reqwest**](https://github.com/seanmonstar/reqwest) - Rust HTTP 客户端
- [**Scraper**](https://github.com/causal-agent/scraper) - Rust HTML 解析和选择器库
- [**Rusqlite**](https://github.com/rusqlite/rusqlite) - SQLite 的 Rust 绑定
- [**Image**](https://github.com/image-rs/image) - Rust 图像处理库
- [**FFmpeg**](https://ffmpeg.org/) - 音视频处理工具（本项目桌面端用于视频壁纸预览压缩，以 sidecar 形式 bundled）
- [**Prisma**](https://github.com/prisma/prisma) - 下一代 ORM（用来文档数据库结构）

### 构建与开发工具
- [**Deno**](https://github.com/denoland/deno) - JavaScript/TypeScript 运行时和包管理器（本项目构建系统的运行时）
- [**Tapable**](https://github.com/webpack/tapable) - 用于创建钩子系统的库（本项目开发构建系统的核心）
- [**Handlebars**](https://github.com/handlebars-lang/handlebars.js) - 模板工具，本项目用来生成 tauri.config.json

### 参考项目
- [**Lively**](https://github.com/rocksdanister/lively) - 动态壁纸应用（本项目参考了其桌面挂载实现）
- [**Clash Verge**](https://github.com/clash-verge-rev/clash-verge-rev) - Clash 代理客户端（本项目参考了其托盘代码、tauri config写法以及linux workaround 写法）
- [**Pake**](https://github.com/tw93/pake) - 将任意网站打包为app的项目（本项目参考了其实现）
- [**LiveWallpaperMacOS**](https://github.com/thusvill/LiveWallpaperMacOS.git) - MacOS动态壁纸方案（本项目参考了其桌面壁纸挂载实现）
- [**PixivCrawler**](https://github.com/CWHer/PixivCrawler) - Pixiv 爬虫python3实现（本项目参考其实现了Rhai版本）

### 内嵌依赖（`third/`）

以下上游项目以 Git 子模块形式存放于 `third/` 目录，并通过 `third-patches/` 中的编号补丁序列维护。

- [**CEF（Chromium 嵌入式框架）**](https://github.com/chromiumembedded/cef) - 桌面端 WebView 后端所使用的 Chromium 浏览器引擎（branch 7827）
- [**cef-rs**](https://github.com/tauri-apps/cef-rs) - CEF 的 Rust 绑定（tauri-apps fork，补丁修复扁平子进程路径）
- [**deno**](https://github.com/denoland/deno) - 基于 V8 的 JS 运行时；`deno_core` crate 驱动爬虫插件 V8 后端及自编 Deno CLI
- [**rusty_v8**](https://github.com/denoland/rusty_v8) - V8 的 Rust 绑定；为 Android aarch64 自行编译
- [**FFmpeg**](https://github.com/FFmpeg/FFmpeg) - 多媒体框架，用于桌面端视频摄入（预览压缩、尺寸检测）
- [**x264**](https://code.videolan.org/videolan/x264) - H.264 编码器；由 FFmpeg 构建静态链接
- [**rsmpeg**](https://github.com/larksuite/rsmpeg) - FFmpeg libav\* 的安全 Rust 封装
- [**rusty_ffmpeg**](https://github.com/CCExtractor/rusty_ffmpeg) - rsmpeg 使用的 FFmpeg bindgen 助手
- [**tauri**](https://github.com/tauri-apps/tauri) - 跨平台桌面框架；fork 版本增加了 `TAURI_ANDROID_PACKAGE`、顶层 `bins` 配置等 Kabegame 专属补丁

如果这些项目对你有帮助，请考虑给它们一个 ⭐ Star，这是对开源社区最好的支持！
