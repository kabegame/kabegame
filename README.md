# Kabegame 壁纸管理器

一个基于 Tauri 的二次元壁纸管理器！收集、管理、轮播，让老婆们（或老公们）每天陪伴你~ 支持插件扩展，轻松爬取各种二次元壁纸资源~

<div align="center">
  <img src="docs/images/image1.png" alt="Kabegame 形象图 1" width="100"/>
  <img src="docs/images/image2.png" alt="Kabegame 形象图 2" width="100"/>
</div>

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

```bash
# 开发
pnpm dev                  # 默认使用远程插件打包依赖，运行 tauri:dev
pnpm dev --watch          # 启用 Nx 依赖图 watch，变更自动重构依赖并触发 Tauri 重启
pnpm dev --local-plugins  # 使用本地插件打包依赖，运行 tauri:dev-local-plugins
pnpm dev --local-plugins --watch

# 构建
pnpm build                # 打包远程插件后 tauri build
pnpm build --local-plugins# 打包本地插件后 tauri build
```

说明：
- `--watch` 直接使用 **Tauri CLI 自带的 dev watcher**（`tauri dev --additional-watch-folders ..\\crawler-plugins`）监听插件源码变更并触发重启；并通过 `.taurignore` 忽略 `crawler-plugins/packed` 等输出，避免重启循环。
- `--local-plugins` 会优先执行 `crawler-plugins:package-local`；未加时执行 `crawler-plugins:package`。

## 项目结构

```
.
├── src/                    # 前端代码
│   ├── components/        # Vue 组件
│   ├── stores/           # Pinia 状态管理
│   ├── views/            # 页面视图
│   ├── router/           # 路由配置
│   └── main.ts           # 入口文件
├── src-tauri/            # Rust 后端代码
│   ├── src/
│   │   ├── main.rs       # 主入口
│   │   ├── plugin.rs     # 插件管理
│   │   ├── crawler.rs    # 爬虫逻辑
│   │   └── storage.rs    # 存储管理
│   └── Cargo.toml        # Rust 依赖
├── crawler-plugins/      # 插件相关
│   ├── plugins/          # 本地插件源码
│   └── packed/          # 打包后的插件文件
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

