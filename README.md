# Kabegame 壁纸管理器

一个基于 Tauri 的二次元壁纸管理器！收集、管理、轮播，让老婆们（或老公们）每天陪伴你~ 支持插件扩展，轻松爬取各种二次元壁纸资源~

<div align="center">
  <img src="docs/images/image1.png" alt="Kabegame 形象图 1" width="100"/>
  <img src="docs/images/image2.png" alt="Kabegame 形象图 2" width="100"/>
</div>

## 名称由来 🐢

**Kabegame** 是日语「壁亀」（かべがめ）的罗马音，与「壁纸」（かべがみ）发音相近~ 就像一只安静的龟龟趴在你的桌面上，默默守护着你的二次元壁纸收藏，不吵不闹，只负责治愈你~ これで毎日癒やされるね。やったぁ～ ✨

## 功能特性

- 🖼️ **壁纸管理**: 收集、管理、轮播二次元壁纸，让桌面充满二次元气息
- 🔌 **插件系统**: 支持通过 `.kgpg` 插件文件从不同网站爬取壁纸资源
- 📸 **画册浏览**: 查看已爬取的壁纸，支持按插件和画册筛选
- 🎨 **壁纸轮播**: 自动从指定画册中轮播更换桌面壁纸，支持随机和顺序模式
- 📦 **本地存储**: 壁纸和元数据存储在本地应用数据目录
- 🌐 **源管理**: 浏览、安装、收藏和管理壁纸源插件

## 软件截图

<div align="center">
  <img src="docs/images/ScreenShot1.png" alt="Kabegame 截图 1" width="800"/>
  <br/>
  <img src="docs/images/ScreenShot2.png" alt="Kabegame 截图 2" width="800"/>
</div>

## 使用说明

### 1. 导入插件源

插件以 `.kgpg` 文件格式提供（本质上是一个 ZIP 压缩包）。你可以通过以下方式导入插件：

1. 进入"源管理"页面
2. 点击"导入源"按钮
3. 选择 `.kgpg` 插件文件
4. 插件会自动安装并显示在"已安装源"列表中

**提示**: 你也可以直接将 `.kgpg` 文件放到应用的插件目录下，应用会自动识别。

### 2. 浏览和安装插件

1. 进入"源管理"页面
2. 在"源商店"标签页中浏览可用的插件
3. 点击插件卡片查看详细信息
4. 点击"安装"按钮安装插件
5. 已安装的插件会显示在"已安装源"标签页中
6. 可以点击"收藏"按钮收藏喜欢的插件

### 3. 使用爬虫功能

1. 进入"爬虫管理"页面
2. 从下拉菜单中选择已安装并启用的插件
3. 输入要爬取的目标 URL
4. （可选）选择自定义输出目录，留空则使用默认目录
5. 点击"开始爬取"按钮
6. 爬取进度会实时显示，完成后壁纸会自动保存到本地

**提示**: 爬取过程中可以随时点击"停止"按钮中断任务。

### 4. 查看和管理壁纸

#### 画廊视图
1. 进入"画廊"页面
2. 可以按插件和画册筛选壁纸
3. 点击壁纸可预览大图
4. 可以删除不需要的壁纸

#### 画册管理
1. 进入"画册"页面
2. 点击"新建画册"创建自定义画册
3. 点击画册卡片查看画册内容
4. 可以将壁纸添加到画册中
5. 支持拖拽调整画册中壁纸的顺序

### 5. 设置壁纸轮播

1. 进入"设置"页面
2. 切换到"壁纸轮播"标签页
3. 启用"壁纸轮播"开关
4. 点击"选择画册"按钮，前往画册页面选择要轮播的画册
5. 设置轮播间隔时间（分钟）
6. 选择轮播模式：
   - **随机模式**: 每次随机选择画册中的壁纸
   - **顺序模式**: 按顺序依次更换壁纸

**提示**: 壁纸轮播功能需要应用在后台运行。如果关闭应用，轮播会自动停止。

### 6. 下载管理

1. 进入"下载"页面
2. 查看所有下载任务的进度和状态
3. 可以暂停、恢复或取消下载任务
4. 下载完成后，壁纸会自动添加到对应的画册中

## 注意事项

- 请遵守目标网站的 robots.txt 和使用条款，合理使用爬虫功能
- 壁纸默认存储在用户的图片（Pictures）文件夹下，否则位于应用数据目录的 images 中（具体位置应用中可以确认并且设置）
- 插件配置保存在应用数据目录中
- 壁纸轮播功能需要应用在后台运行，关闭应用后轮播会自动停止
- 插件文件格式为 `.kgpg`（ZIP 压缩包），包含 `manifest.json`、`crawl.rhai` 等文件

---

## 技术栈

- **前端**: Vue 3 + TypeScript + Element Plus
- **后端**: Rust (Tauri)
- **状态管理**: Pinia
- **路由**: Vue Router
- **构建工具**: Vite + Nx
- **插件脚本**: Rhai

## 开发

### 前置要求

- Node.js 16+ 
- pnpm (推荐使用 npm 安装: `npm install -g pnpm`)
- Rust 1.70+ (Rust 2021 Edition)
- [Tauri CLI](https://tauri.app/v2/guides/getting-started/prerequisites)

### 安装依赖

```bash
pnpm install
```

### Git 钩子：push 前自动尝试打 tag（可选）

本仓库使用 Husky 提供 git hooks：在 `git push` 之前会读取 `crawler-plugins/package.json` 的 `version`，
并尝试创建 `v{version}` 的 tag（例如 `1.0.0` → `v1.0.0`）。如果 tag 已存在或创建失败会**跳过且不阻断 push**。

- 启用方式：执行 `pnpm install`（会自动运行 `prepare` 安装 hooks）
- 手动重装 hooks：执行 `pnpm prepare`

### 开发/构建命令（统一入口）

项目采用 **Cargo Workspace** 架构，包含三个独立应用：
- **main**：主应用（Tauri GUI，前端端口 1420）
- **plugin-editor**：插件编辑器（Tauri GUI，前端端口 1421）
- **cli**：命令行工具（无界面）

所有应用共享 `kabegame-core` 核心库。

```bash
# 开发模式（带 watch，热重载）
pnpm dev -c main              # 启动主应用（端口 1420）
pnpm dev -c plugin-editor     # 启动插件编辑器（端口 1421）
pnpm dev -c main --watch      # 启用插件源码监听，自动重建并触发 Tauri 重启
pnpm dev -c main --mode local # 使用 local 模式（无商店版本，预打包全部插件）

# 启动模式（无 watch，直接运行）
pnpm start -c main            # 启动主应用（无 watch）
pnpm start -c plugin-editor   # 启动插件编辑器（无 watch）
pnpm start -c cli             # 运行 CLI 工具

# 构建生产版本
pnpm build                    # 构建全部组件（main + plugin-editor + cli）
pnpm build -c main            # 仅构建主应用
pnpm build -c plugin-editor   # 仅构建插件编辑器
pnpm build -c cli             # 仅构建 CLI 工具
pnpm build --mode local       # 构建 local 模式（无商店版本，预打包全部插件）
```

说明：
- `-c, --component`：指定要开发/启动/构建的组件（`main` | `plugin-editor` | `cli` | `all`）
- `--watch`：启用插件源码监听（仅 `dev` 命令），使用 nodemon 监听 `crawler-plugins/plugins/` 变更并自动重建
- `--mode`：构建模式
  - `normal`（默认）：一般版本，带商店源，仅打包本地插件到 resources
  - `local`：无商店版本，预打包全部插件到 resources
- `dev` 和 `start` 会自动先打包插件到 `src-tauri/resources/plugins`，确保资源存在
- 前端资源由各自的 `tauri.conf.json` 中的 `beforeDevCommand` / `beforeBuildCommand` 自动触发构建

## 项目结构

```
.
├── src/                    # 主应用前端代码（Vue 3 + TypeScript）
│   ├── components/        # Vue 组件
│   ├── stores/           # Pinia 状态管理
│   ├── views/            # 页面视图
│   ├── router/           # 路由配置
│   └── main.ts           # 入口文件
├── src-plugin-editor/     # 插件编辑器前端代码（Vue 3 + TypeScript）
│   └── ...               # 类似主应用结构
├── src-tauri/            # Rust 后端代码（Cargo Workspace）
│   ├── Cargo.toml        # Workspace 配置
│   ├── core/             # 共享核心库（kabegame-core）
│   │   ├── src/
│   │   │   ├── lib.rs    # 核心库入口
│   │   │   ├── plugin.rs # 插件管理
│   │   │   ├── crawler.rs# 爬虫逻辑
│   │   │   └── ...       # 其他共享模块
│   │   └── Cargo.toml
│   ├── app-main/         # 主应用（Tauri GUI）
│   │   ├── src/
│   │   │   └── main.rs   # 主应用入口，包装 core 的 Tauri commands
│   │   ├── tauri.conf.json
│   │   └── Cargo.toml
│   ├── app-plugin-editor/# 插件编辑器（Tauri GUI）
│   │   ├── src/
│   │   │   └── main.rs   # 插件编辑器入口
│   │   ├── tauri.conf.json
│   │   └── Cargo.toml
│   ├── app-cli/          # CLI 工具（命令行）
│   │   ├── src/
│   │   │   └── bin/
│   │   │       └── kabegame-cli.rs
│   │   ├── tauri.conf.json
│   │   └── Cargo.toml
│   └── resources/        # 资源文件
│       └── plugins/      # 打包后的插件文件（.kgpg）
├── crawler-plugins/      # 插件相关
│   ├── plugins/          # 本地插件源码
│   └── packed/           # 打包后的插件文件
├── scripts/              # 构建脚本
│   └── run.js            # 统一开发/构建入口
├── vite-main.config.ts   # 主应用 Vite 配置（端口 1420）
├── vite-plugin-editor.config.ts # 插件编辑器 Vite 配置（端口 1421）
└── package.json          # Node.js 依赖
```

## 插件开发

插件开发相关文档请参考：
- [插件开发指南](docs/README_PLUGIN_DEV.md)
- [插件文件格式](docs/PLUGIN_FORMAT.md)
- [Rhai API 文档](docs/RHAI_API.md)

## 许可证

MIT

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

### 后端与工具
- [**Rhai**](https://github.com/rhaiscript/rhai) - 嵌入式脚本语言引擎（本项目插件脚本的核心支持）
- [**Serde**](https://github.com/serde-rs/serde) - Rust 序列化框架
- [**Tokio**](https://github.com/tokio-rs/tokio) - Rust 异步运行时
- [**Reqwest**](https://github.com/seanmonstar/reqwest) - Rust HTTP 客户端
- [**Scraper**](https://github.com/causal-agent/scraper) - Rust HTML 解析和选择器库
- [**Rusqlite**](https://github.com/rusqlite/rusqlite) - SQLite 的 Rust 绑定
- [**Image**](https://github.com/image-rs/image) - Rust 图像处理库

### 构建与开发工具
- [**Nx**](https://github.com/nrwl/nx) - 智能、快速和可扩展的构建系统

### 参考项目
- [**Lively**](https://github.com/rocksdanister/lively) - 动态壁纸应用（本项目参考了其桌面挂载实现）
- [**Clash Verge**](https://github.com/clash-verge-rev/clash-verge-rev) - Clash 代理客户端（本项目参考了其托盘代码）

如果这些项目对你有帮助，请考虑给它们一个 ⭐ Star，这是对开源社区最好的支持！

