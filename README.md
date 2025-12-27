# Kabegami 爬虫平台

一个基于 Tauri 的图片爬虫平台，支持通过插件配置从不同网站爬取图片到本地，并提供图片浏览功能。

## 技术栈

- **前端**: Vue 3 + TypeScript + Element Plus
- **后端**: Rust (Tauri)
- **状态管理**: Pinia
- **路由**: Vue Router

## 功能特性

- 🔌 **插件系统**: 支持配置多个爬虫插件，每个插件可配置不同的选择器和爬取规则
- 🖼️ **图片爬取**: 从指定网址爬取图片并保存到本地
- 📸 **图片浏览**: 查看已爬取的图片，支持按插件筛选
- 📦 **本地存储**: 图片和元数据存储在本地应用数据目录

## 开发

### 前置要求

- Node.js 16+ 
- pnpm (推荐使用 npm 安装: `npm install -g pnpm`)
- Rust 1.70+ (Rust 2021 Edition)
- [Tauri CLI](https://tauri.app/v1/guides/getting-started/prerequisites)

### 安装依赖

```bash
pnpm install
```

### 开发模式

```bash
pnpm tauri:dev
```

### 构建

```bash
pnpm tauri:build
```

## 使用说明

### 1. 配置插件

1. 进入"插件配置"页面
2. 点击"添加插件"
3. 填写插件信息：
   - **名称**: 插件名称
   - **描述**: 插件描述
   - **基础URL**: 网站基础URL
   - **图片选择器**: CSS选择器，用于定位图片元素（如 `img`）
   - **下一页选择器**: CSS选择器，用于定位下一页链接（可选）
   - **标题选择器**: CSS选择器，用于提取页面标题（可选）

### 2. 开始爬取

1. 进入"爬虫管理"页面
2. 选择已配置的插件
3. 输入目标URL
4. 点击"开始爬取"

### 3. 查看图片

1. 进入"图片视图"页面
2. 可以按插件筛选图片
3. 点击图片可预览
4. 可以删除不需要的图片

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
└── package.json          # Node.js 依赖
```

## 注意事项

- 爬取功能目前限制最多爬取10个页面，避免无限循环
- 图片存储在应用数据目录的 `images` 文件夹下
- 插件配置保存在应用数据目录的 `plugins.json` 文件中
- 请遵守目标网站的 robots.txt 和使用条款

一个插件为一个.kgpg文件，本质上是一个zip文件。用户可以通过将kgpg文件放到插件目录下面实现导入。文件名不重要。在app中，用户可以收藏某个插件。

.kgpg文件展开后，第一个文件为toml

toml规则为：
```toml
[name]
// 名称
[description]
// 为markdown格式。图片只能
```

## 许可证

MIT

