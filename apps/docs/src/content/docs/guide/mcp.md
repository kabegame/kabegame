---
title: MCP 集成
description: 开启 Kabegame 内置 MCP 服务，将画廊接入 Claude Desktop、Cursor 等 AI 助手。
---

Kabegame 桌面版内置了一个本地 **MCP（Model Context Protocol）** 服务器，允许支持 MCP 的 AI 助手直接读取你的画廊、画册、下载任务、畅游记录与已安装插件，并完成少量写操作（创建画册、添加图片、重排顺序、重命名图片）。本页介绍这项能力是什么、怎么连、能做什么；完整的 URI 与字段清单请看 [MCP 参考](/reference/mcp/)。

## 什么是 MCP

MCP 是一种开放协议，允许 AI 助手通过统一的接口访问外部工具和数据源。Kabegame 扮演 MCP 服务端的角色，AI 助手（Host）则通过协议连入，像查询文件一样查询你本地的图库。

## Kabegame 的 MCP 服务

桌面版启动时会自动在后台拉起 MCP 服务，无需手动开启。

| 项目 | 值 |
|---|---|
| 监听地址 | `127.0.0.1:7490`（仅本机回环） |
| 端点路径 | `/mcp` |
| 传输方式 | StreamableHTTP |
| 鉴权 | 无（依赖回环隔离） |
| 平台 | Windows / macOS / Linux（Android 不提供） |

完整的端点 URL 为 `http://127.0.0.1:7490/mcp`。

:::note
目前没有任何 UI 开关或配置项来开启/关闭 MCP 服务 —— 只要运行的是桌面版，它就在 7490 端口监听。
:::

## 连接 MCP Host

### 支持 HTTP transport 的 Host

在 Host（如 Cursor）的 MCP 配置里新增一个 HTTP 类型的服务，把端点填为：

```
http://127.0.0.1:7490/mcp
```

连通后，让助手调用 `list_resources`，或直接读 `provider://all/`、`album://` 等 URI，就能浏览你的画廊。

### 仅支持 stdio 的 Host

部分 Host（如 Claude Desktop）目前只接受 stdio 方式的 MCP 服务。为此 Kabegame 提供了打包好的 `.mcpb` 桥接安装包，可以一键装入。详见 [安装 MCP Bundle](/guide/mcp-bundle/)。

## 能让 AI 做什么

Kabegame 通过六种 URI scheme 暴露资源，供助手读取：

| URI | 用途 |
|---|---|
| `provider://<path>` | 按路径树浏览画廊（画册、日期、媒体类型、壁纸历史、全部） |
| `image://{id}` | 读取图片基础字段与爬取期元数据（tag、作者、原始 URL 等） |
| `album://` | 列出画册，或读取单个画册详情 |
| `task://` | 查看下载任务 |
| `surf://` | 查看畅游记录 |
| `plugin://` | 列出已安装插件、图标、描述模板、文档资源 |

此外还提供 4 个写操作工具：

- 创建画册
- 向画册添加图片
- 为画册手动排序（单次 ≤ 100 张）
- 重命名图片

:::caution
出于安全考虑，MCP **不暴露任何删除操作**——既不能删图片，也不能删画册，其他破坏性操作也一律不开放。如果需要让助手协助清理，可以让它把待删除的图片归入一个专门的画册（例如「待删除」），再由你在应用内确认处理。
:::

字段、查询参数、分页规则等细节请直接参考 [MCP 参考](/reference/mcp/)。

### 分页行为

`provider://` 的分页大小跟随画廊设置中的「每页图片数」（默认 `100`，可选 `100 / 500 / 1000`）。**页码从 1 开始**，传 0 视为非法。

### 手动排序的可见性

通过 MCP 工具调整画册内顺序后，需要在 Kabegame 内打开该画册，把排序模式切换到「画册顺序」才能看到手动排序的效果。

## 安全

MCP 服务绑定在 `127.0.0.1`，只接受本机进程的连接，因此不设鉴权。

:::caution
请不要把 7490 端口通过路由器、反向代理或隧道工具**暴露到公网或局域网**。当前协议不做鉴权，一旦可达即等同于把画廊完全开放。如果确实需要从另一台机器连入，请使用 SSH 隧道等点对点方式，并自行承担访问控制。
:::

## 排障

- **Host 连不上 `http://127.0.0.1:7490/mcp`** → 通常是 7490 端口被其他程序占用，导致 MCP 启动失败。查看应用控制台 / 日志，若出现 `Failed to start MCP server`，关闭占用该端口的程序后重启 Kabegame。
- **Android 上找不到 MCP** → Android 版本不内置 MCP 服务，请改用桌面版作为 MCP 主机。

## 延伸阅读

- [安装 MCP Bundle](/guide/mcp-bundle/) —— 用 `.mcpb` 一键接入 Claude Desktop
- [MCP 参考](/reference/mcp/) —— 六大 URI scheme 的完整字段与查询参数
- [画廊](/guide/gallery/) —— 理解 `provider://` 路径与应用内浏览的对应关系
- [插件使用](/guide/plugins-usage/) —— 了解 `plugin://` 背后的数据来源
