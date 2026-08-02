# Kabegame 二次元爬虫客户端

> 中文  | [日本語](README.ja.md) | [한국어](README.ko.md) | [English](README.en-US.md)

一个基于 Tauri 的二次元爬虫客户端！爬取、管理、设置/轮播壁纸，让老婆们（或老公们）每天陪伴你~ 支持插件扩展，轻松爬取各种二次元站点资源~

📖 **完整文档**：[https://kabegame.com](https://kabegame.com/)

🌐 **在线体验（Demo）**：[https://demo.kabegame.com](https://demo.kabegame.com/)

几个能发论文的 [技术创新](#你可能感兴趣)。

> 我理解了，二次元需要讲故事，于是我添加了插件元数据，可以看爬取图片时的帖子评论。

> 我明白了，二次元需要新鲜感，于是我添加了随机排序，自动配置运行爬取，自动为了能每天有常换常新的美图。
> - 为什么是壁纸？你其实没有注意到，大部分人大部分时间都在看壁纸。在心理学上，壁纸直接影响一个人的心情，这和房间的乱整能影响人的心情一样。好看的壁纸能让你心情舒畅，延年益寿。
> - 为什么要轮播？因为审美疲劳，好的东西看久了就会变成环境，人会自动过滤环境里的噪音，从而主观上不觉得它是美的了。轮播能让你始终保持对新壁纸的期待和桌面的新鲜感，让你始终保持好心情。

> 我领悟了，二次元离不开擦边，离不开涩涩，于是我
>  - 积极引入了R18插件，以及MCP（能让AI帮你整理一组角色的涩图到同一个画册）。
>  - 我还做了图片元数据载入，和高级组合搜索功能，只为让你快速找到喜欢的角色，或者快速筛选出带有AI prompt的图片。
>  - 我还做了文件夹画册，以便自动将你生成的图片导入到kabegame中。

> AI生图是三次元通往二次元的大门之匙，有了它，即使不会画画，你也可以创造独属于自己的二次元，而不拘泥于别人的创造。你可能从没有想过，你喜欢的角色实际上都是别人给你创造的，可能是大厂白领，可能是秃头程序员。AI生图首次授予了每个人自己来创造二次元世界的能力，使得我们自己的二次元成为了可能，使得我们每个人都能够参与进来，而不只是做一个旁观者。

<div align="center" style="line-height: 3em">
  <b>努力，只为做专属于二次元的软件。</b>
</div>

<div align="center">
  <img src="docs/images/icon.png" alt="Kabegame" width="256"/>
</div>

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
    <img alt="许可证" src="https://img.shields.io/github/license/kabegame/kabegame?style=flat-square" height="20"/>
  </a>
  <a href="https://kabegame.com">
    <img alt="项目文档" src="https://img.shields.io/badge/docs-kabegame.com-2f80ed?style=flat-square" height="20"/>
  </a>
  <br/>
  <a href="https://kabegame.com/guide/installation/">
    <img alt="支持平台" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux%20%7C%20Android-5c6bc0?style=flat-square" height="20"/>
  </a>
  <a href="https://v2.tauri.app/">
    <img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-24C8DB?style=flat-square&logo=tauri&logoColor=white" height="20"/>
  </a>
  <a href="https://vuejs.org/">
    <img alt="Vue 3" src="https://img.shields.io/badge/Vue-3-42B883?style=flat-square&logo=vuedotjs&logoColor=white" height="20"/>
  </a>
</p>

<table width="100%">
  <tr>
    <td align="center" width="50%">
      <img src="docs/images/gallery/gallery-main.png" alt="Kabegame 画廊" width="100%"/><br/>
      <small>画廊</small>
    </td>
    <td align="center" width="50%">
      <img src="docs/images/gallery/gallery-preview.png" alt="Kabegame 图片预览" width="100%"/><br/>
      <small>预览</small>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="docs/images/gallery/gallery-detail.jpg" alt="Kabegame 详细元信息" width="100%"/><br/>
      <small>详细元信息</small>
    </td>
    <td align="center" width="50%">
      <img src="docs/images/gallery/gallery-filters.jpg" alt="Kabegame 画廊过滤" width="100%"/><br/>
      <small>随心过滤</small>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="docs/images/album/album-main.jpg" alt="Kabegame 画册整理" width="100%"/><br/>
      <small>画册整理</small>
    </td>
    <td align="center" width="50%">
      <img src="docs/images/album/album-folder.jpg" alt="Kabegame 文件夹同步" width="100%"/><br/>
      <small>文件夹同步</small>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="docs/images/source/source-main.jpg" alt="Kabegame 源插件列表" width="100%"/><br/>
      <small>源插件列表</small>
    </td>
    <td align="center" width="50%">
      <img src="docs/images/source/source-doc.jpg" alt="Kabegame 源插件文档" width="100%"/><br/>
      <small>源插件文档</small>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="docs/images/crawler/crawler-config.jpg" alt="Kabegame 任务参数配置" width="100%"/><br/>
      <small>配置任务参数</small>
    </td>
    <td align="center" width="50%">
      <img src="docs/images/crawler/crawler-start.jpg" alt="Kabegame 任务执行" width="100%"/><br/>
      <small>开始执行任务</small>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="docs/images/crawler/task-images.jpg" alt="Kabegame 任务图片" width="100%"/><br/>
      <small>任务图片</small>
    </td>
    <td align="center" width="50%">
      <img src="docs/images/crawler/task-log.jpg" alt="Kabegame 任务日志" width="100%"/><br/>
      <small>任务日志(快速定位问题)</small>
    </td>
  </tr>
</table>

## 主要功能

- 🔌 **爬虫客户端**：通过 `.kgpg` 插件从各站爬取壁纸，内置插件商店可浏览/安装/管理，4.3.0开始内置打包所有发布时的最新插件；插件用 JS/TS 编写，跑在 V8（deno_core）或 WebView 后端。
- 🎨 **壁纸设置器（图片/视频）**：收集、管理、轮播二次元壁纸，自动从指定画册更换桌面壁纸。
- 🖼️ **图片管理者**：画廊浏览、画册整理、虚拟磁盘、拖拽导入、文件夹同步画册。
- 🧩 **MCP 整理**：打开 MCP 服务器，让外部 AI 代理按精细权限帮你整理壁纸。

支持 Windows、macOS、Linux 与 Android（不支持 iOS）。

## 你可能感兴趣
也许你对二次元壁纸和爬虫不感兴趣，但本应用中的几个技术创新你也许感兴趣
- 基于 Tauri 的 Webview 爬虫 [WebviewHandler](./src-tauri/kabegame-core/src/crawler/webview.rs)
- 自研 Tauri runtime [tauri-runtime-cef](./src-tauri/tauri-runtime-cef/)
  高度为Kabegame定制，因此没有发crate，你可以用AI搬到你的项目中
- 自研路径折叠式查询引擎 [PathQL](./src-tauri/pathql-rs/)
  简单介绍来说就是，研发了一个被称为Provider DSL的解析器和基于URL路径的查询语法。应用中的大部分图片查询已经变成了 [Provider DSL JSON5格式](./src-tauri/kabegame-core/src/providers/dsl/) ，这些JSON决定PathQL引擎折叠查询的方式。假设查询 2026年6月的所有视频，查询写成:
    ```url
    images://hide/media-type/video/filter_comb/date/2026y/06m/filter_comb/sort/by-id/1
    ```
  如果你对该查询引擎感兴趣，可以提issue，我来完善文档。
  理论上可以发crate，但应该还存在某些边界情况的bug没有探出来，所以你也可以让AI抄到你的项目里（注意GPL-3.0）

## 下载与安装

前往 **[GitHub Releases](https://github.com/kabegame/kabegame/releases/latest)** 下载对应平台安装包。

各平台安装步骤、虚拟盘依赖与数据目录说明见文档：**[安装与首次启动](https://kabegame.com/guide/installation/)**。

## 文档

完整文档都在 **[kabegame.com](https://kabegame.com/)**：

- [用户指南](https://kabegame.com/guide/installation/) —— 安装、画廊、画册、壁纸、虚拟盘、MCP 等。
- [插件开发](https://kabegame.com/dev/overview/) —— 编写 V8 / WebView 爬虫插件、`.kgpg` 格式、打包发布。
- [参与开发](https://kabegame.com/dev-contrib/building/) —— 从源码构建、Android 开发、架构与技术栈、致谢与内嵌依赖。
- [命令行工具](https://kabegame.com/reference/cli/) 与 [API 参考](https://kabegame.com/reference/kabegame-api/)。

爬虫插件仓库：**[kabegame/crawler-plugins](https://github.com/kabegame/crawler-plugins)**（欢迎贡献插件！）

## License

源代码基于 [GPL v3](./LICENSE) 授权。

## 名称由来 🐢

**Kabegame** 是日语「壁亀」（かべがめ）的罗马音，与「壁纸」（かべがみ）发音相近~ 就像一只安静的龟龟趴在你的桌面上，默默守护着你的二次元壁纸收藏。拥抱开源，做二次元人自己的软件。
