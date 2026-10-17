# Kabegame — 插件驱动的动漫图片与视频收集、归档工具

> 中文 | [日本語](README.ja.md) | [한국어](README.ko.md) | [English](README.en-US.md)

把散落在插画站、社区、创作者平台和本地文件夹里的图片与视频，收进一个本地图库，同时保留来源、标签和作品元数据。

Kabegame 不只负责下载：插件可以把角色、作品、画师等标签自动归类；本地目录可以映射成持续同步的画册；需要登录时，在内置浏览器登录一次，插件即可复用保存的 Cookie。普通站点由轻量 V8 插件处理，强 JS 渲染或反爬站点则可由真实 WebView 驱动收集。

<p align="center">
  <a href="https://github.com/kabegame/kabegame/releases/latest"><b>下载最新版</b></a>
  · <a href="https://demo.kabegame.com">在线体验</a>
  · <a href="https://kabegame.com/guide/quickstart/">快速上手</a>
  · <a href="https://github.com/kabegame/crawler-plugins">浏览插件</a>
  · <a href="https://kabegame.com/dev/overview/">开发插件</a>
</p>

<p align="center">
  <a href="https://github.com/kabegame/kabegame/releases/latest">
    <img alt="最新版本" src="https://img.shields.io/github/v/release/kabegame/kabegame?style=flat-square&sort=semver&logo=github" height="20"/>
  </a>
  <a href="https://github.com/kabegame/kabegame/releases">
    <img alt="累计下载量" src="https://img.shields.io/github/downloads/kabegame/kabegame/total?style=flat-square&logo=github" height="20"/>
  </a>
  <a href="https://github.com/kabegame/kabegame/stargazers">
    <img alt="GitHub Stars" src="https://img.shields.io/github/stars/kabegame/kabegame?style=flat-square&logo=github" height="20"/>
  </a>
  <a href="https://github.com/kabegame/kabegame/blob/main/LICENSE">
    <img alt="GPL-3.0 许可证" src="https://img.shields.io/github/license/kabegame/kabegame?style=flat-square" height="20"/>
  </a>
  <a href="https://kabegame.com">
    <img alt="项目文档" src="https://img.shields.io/badge/docs-kabegame.com-2f80ed?style=flat-square" height="20"/>
  </a>
</p>

## 核心亮点

- **标签自动归类**：支持的插件在下载时同时写入角色、作品、画师、模型、来源等结构化标签，自动形成可浏览、可组合过滤的标签目录，不必收完以后再逐张整理。
- **本地文件夹持续同步**：把磁盘目录映射为同步画册，目录中的新增与删除会反映到图库，子目录还能按原有层级生成子画册；适合持续接收绘图软件、AI 生图工具或其他下载器的输出。
- **登录一次，后续自动复用**：在「畅游」的内置浏览器中正常登录网站，Kabegame 会保存所有站点 Cookie；插件可由宿主安全注入登录态，不必反复复制 Cookie，也不会读取到 Cookie 明文。
- **畅游视频直接存进图库**：在内置浏览器里看视频时右键「下载视频」，即使是 `blob:` / MSE 流式播放器也能按清晰度捕获音视频分片并合流入库，右下角实时显示每路流的捕获进度。
- **真实 WebView 驱动爬取**：除了轻量的 V8 HTTP / HTML 插件，还能让插件运行在真实浏览器页面中，处理 SPA、JS 渲染、浏览器指纹、Cloudflare 检查以及需要交互的登录流程。
- **用脚本扩展新的内容来源**：爬虫插件使用 JavaScript / TypeScript 编写，无需修改或重新编译 Kabegame；一个插件可以同时定义收集逻辑、配置表单、标签分类、来源元数据和详情视图，并打包成 `.kgpg` 文件分享给其他用户。
- **来源信息随图片一起留下**：插件可以保存作者、原帖链接、正文、评论、社区标签和 AI 生成参数，并提供自己的详情视图与搜索片段，让图片离开原站后仍然知道“来自哪里、为什么收藏”。

<table width="100%">
  <tr>
    <td align="center" width="50%">
      <img src="docs/images/features/auto-labels.jpg" alt="Kabegame 标签自动归类" width="100%"/><br/>
      <small>插件写入结构化标签，自动形成可筛选的标签目录</small>
    </td>
    <td align="center" width="50%">
      <img src="docs/images/features/folder-sync.jpg" alt="Kabegame 本地文件夹同步" width="100%"/><br/>
      <small>把本地目录映射为持续同步、保留层级的画册</small>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="docs/images/features/cookie-reuse.jpg" alt="Kabegame 自动保存并复用 Cookie" width="100%"/><br/>
      <small>在畅游中登录一次，后续收集自动复用登录态</small>
    </td>
    <td align="center" width="50%">
      <img src="docs/images/features/source-metadata.jpg" alt="Kabegame 来源元数据" width="100%"/><br/>
      <small>作者、原帖、标签与互动信息跟随图片一起保留</small>
    </td>
  </tr>
</table>

<table width="100%">
  <tr>
    <td align="center" width="50%">
      <img src="docs/images/features/webview-crawler-images.jpg" alt="Kabegame WebView 爬虫收集结果" width="100%"/><br/>
      <small>插件在真实浏览器页面中运行，并把媒体送入收集任务</small>
    </td>
    <td align="center" width="50%">
      <img src="docs/images/features/webview-crawler-log.jpg" alt="Kabegame WebView 爬虫任务日志" width="100%"/><br/>
      <small>页面交互、滚动与提取过程可在任务日志中追踪</small>
    </td>
  </tr>
  <tr>
    <td align="center" colspan="2">
      <img src="docs/images/features/surf-video-download.jpg" alt="Kabegame 畅游视频下载与捕获进度" width="100%"/><br/>
      <small>在畅游中右键下载流式视频，右下角实时显示每路流的捕获进度</small>
    </td>
  </tr>
</table>

## 从收集到归档

- **统一收集**：通过插件从 Pixiv、Bilibili、Danbooru、壁纸站和社区等来源批量获取内容，也能在内置浏览器里边逛边收。
- **统一检索**：不同来源进入同一个画廊，可按时间、插件、标签、媒体类型、尺寸、文件大小和元数据搜索组合过滤。
- **统一管理**：用普通画册手工整理主题，用标签目录自动分类，用同步画册跟随磁盘文件夹，再通过去重和隐藏处理长期积累的图库。
- **本地持有**：原始文件和图库数据由你掌握；可自定义下载目录，也能通过虚拟盘在其他应用中访问画册。
- **继续扩展**：爬虫插件使用 JavaScript / TypeScript 编写；MCP 可让 AI 代理在明确权限下检索和整理图库。

Kabegame 试图解决的不是“怎样下载一张图”，而是图片跨越不同来源、不断积累之后，怎样保留上下文并长期整理。解放你图片整理的双手，适合 AI 训练者、二次元爱好者、以及上班摸鱼。png等图片还能被解析元数据，可以发现 AI 生成图片的提示词也说不定！（我就有好几个工作流是用 Kabegame 捡来的）

## 快速开始

1. 从 [GitHub Releases](https://github.com/kabegame/kabegame/releases/latest) 下载并安装 Kabegame。
2. 打开「源」，从官方插件目录安装一个感兴趣的插件；只管理本地图片时可跳过这一步。
3. 回到「画廊」，点击「开始收集」，选择本地导入或网络插件。
4. 在画廊中按来源和标签筛选，查看原帖元数据，再把需要长期保留的内容整理进画册。

完整的五分钟流程见[快速上手](https://kabegame.com/guide/quickstart/)。不安装桌面程序也可以先打开[在线 Demo](https://demo.kabegame.com)体验图库界面。

## 核心能力

| 能力 | 说明 |
| --- | --- |
| 插件驱动收集 | 内置插件商店，可安装、升级和管理 `.kgpg` 插件；V8 与 WebView 后端分别覆盖轻量请求和真实浏览器场景。 |
| 登录态复用 | 畅游保存站点 Cookie，V8 插件可安全请求注入；WebView 插件直接使用浏览器会话。 |
| 标签与元数据 | 插件可自动归类标签，保存原帖、作者、评论和生成参数，并贡献详情视图与搜索字段。 |
| 画廊与检索 | 浏览图片和视频，按时间、来源、标签、媒体、尺寸、文件大小和元数据组合过滤。 |
| 画册与文件夹 | 手动画册支持多级组织；同步画册持续跟随本地目录及其子目录变化。 |
| 本地图库集成 | 自定义下载目录、拖拽导入、批量操作、去重、虚拟盘和原生元数据读取。 |
| 自动化与开放接口 | 支持定时收集、CLI 和 MCP；壁纸设置与画册轮播作为桌面端附加能力提供。 |

## 插件生态

官方插件仓库已经覆盖二十余个插画站、社区、创作者平台和壁纸站。不同插件可以提供自己的配置表单、登录方式、标签维度、详情展示和推荐任务。

- **使用插件**：[浏览官方插件目录](https://github.com/kabegame/crawler-plugins) · [安装与管理插件](https://kabegame.com/guide/plugins-usage/)
- **开发插件**：[开发总览](https://kabegame.com/dev/overview/) · [V8 / WebView 后端选择](https://kabegame.com/dev/crawler-backends/) · [API 参考](https://kabegame.com/reference/kabegame-api/)
- **贡献插件**：可以提交新的来源、修复失效站点，或者改善现有插件的文档与元数据。

V8 插件是自包含的 ES Module，适合使用 HTTP 请求、API 和 HTML 解析完成收集，也能在 Android 上运行。必须依赖真实浏览器渲染、浏览器会话或页面交互时，可使用桌面端 WebView 后端；它会让页面真正运行起来，再从 DOM、网络响应或页面下载中提取内容。

> 插件只应用于整理你有权访问的内容。请遵守来源网站的服务条款，尊重作者版权与隐私，并合理控制访问频率。

## 下载与平台

桌面版是当前主要发布版本；`kabegame-cli` 是独立的可选工具，不随主程序安装。

| 平台 | 下载文件 | 说明 |
| --- | --- | --- |
| Windows x64 | `Kabegame-standard_<版本>_x64-setup.exe` | 双击安装。画册虚拟盘需要 Dokan 2.x，首次启用时应用会提示安装。 |
| macOS Apple 芯片 | `Kabegame-standard_<版本>_aarch64.dmg` | 支持 macOS 11 及以上；安装包暂未签名。 |
| Linux amd64 | `Kabegame-standard_<版本>_amd64.deb` | 使用 `apt` 安装；画册虚拟盘依赖 `fuse3`。 |
| Android | `Kabegame_<版本>_android-preview.apk` | Android 8.0 及以上；目前请使用 v4.3.0，后续版本仍在适配。 |

macOS 首次启动若提示无法验证开发者或应用已损坏：

```bash
xattr -d com.apple.quarantine /Applications/Kabegame.app
```

macOS 如需使用画册虚拟盘，再安装 macFUSE：

```bash
brew install --cask macfuse
```

Linux 安装：

```bash
sudo apt install ./Kabegame-standard_*_amd64.deb
```

图片默认保存在用户图片目录的 `Pictures/Kabegame`，卸载应用不会删除这里的图片。更完整的平台要求、数据目录和排障方法见[安装文档](https://kabegame.com/guide/installation/)。

## 参与项目

不必先熟悉整个 Tauri / Rust 单体仓库，也可以参与 Kabegame：

- 遇到问题，请提交 [Bug report](https://github.com/kabegame/kabegame/issues/new?template=bug_report.md)。
- 希望支持新的来源，可以在[插件仓库](https://github.com/kabegame/crawler-plugins)提交插件或提出需求。
- 想改进应用本体，请先阅读[从源码构建](https://kabegame.com/dev-contrib/building/)与[架构说明](https://kabegame.com/dev-contrib/architecture/)。
- 文档、翻译、截图和插件说明同样是很有价值的贡献。

如果 Kabegame 对你有帮助，欢迎点一个 Star。它会让更多用户和潜在插件作者发现这个项目，对我来说也是一份鼓励。

## 技术亮点

Kabegame 使用 Vue 3、Tauri 2 与 Rust 构建，并针对图库查询、插件运行时和桌面浏览器能力做了多项扩展：

- [WebviewHandler](./src-tauri/kabegame-core/src/crawler/webview.rs)：基于真实页面环境运行需要登录态或页面交互的插件。
- [tauri-runtime-cef](./src-tauri/tauri-runtime-cef/)：为桌面端定制的 CEF Tauri runtime。
- [PathQL](./src-tauri/pathql-rs/)：用路径组合过滤、排序、分页和 Provider DSL 的数据库查询引擎。

项目结构、进程模型与关键模块见[架构与项目结构](https://kabegame.com/dev-contrib/architecture/)。

## License

Kabegame 基于 [GPL-3.0](./LICENSE) 开源。

## 名称由来 🐢

**Kabegame** 是日语「壁亀」（かべがめ）的罗马音，与「壁纸」（かべがみ）发音相近。就像一只安静的龟龟趴在桌面上，守护你的图片收藏。


<!-- others: 

为了优化docs文档，你要作为不懂项目的插件作者，想按照docs里的步骤写一个自定义插件，注意不用 kabegame-plugins skill。你安装了最新的 kabegame-cli 到path中，你决定在 ~/Code/ 下

-->
