---
title: 安装 .mcpb Bundle
description: 通过 .mcpb 安装包将 Kabegame 画廊工具一键接入 Claude Desktop 及兼容 MCP Host。
---

部分 MCP Host（典型如 Claude Desktop）只支持通过 stdio 启动 MCP 子进程，无法直接连 Kabegame 的 HTTP 端点。`.mcpb`（MCP Bundle）是一个打包好的 Node stdio 桥接服务，导入到 Host 后会把 stdio 调用转发到本机运行的 Kabegame HTTP MCP 服务上。

## 什么是 MCPB

MCPB 是 [Model Context Protocol](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md) 规定的安装包格式，`.mcpb` 文件内部含一个 `manifest.json` 与完整的 Node.js 桥接服务。

Kabegame 提供的 Bundle（`kabegame-gallery-node`）做两件事：

- 在 Host 侧以 stdio 运行，承担协议桥接。
- 把请求转发到本机 `http://127.0.0.1:7490/mcp`（即 [MCP 服务](/guide/mcp/) 暴露的 HTTP 端点）。

Bundle 只是桥接，**数据源仍然是桌面版**；使用前请先熟悉 [MCP 服务](/guide/mcp/)。

:::caution
Bundle 只对上游 MCP 暴露 3 个工具：`read_gallery_provider`、`read_image_metadata`、`set_album_images_order`。即使上游 HTTP MCP 支持创建画册、添加图片、重命名、删除等操作，Bundle 侧也**不会**透传——这是刻意的收窄。
:::

## 前置要求

| 条件 | 说明 |
|---|---|
| Kabegame 桌面版正在运行 | Bundle 启动后需要连到 `http://127.0.0.1:7490/mcp`，桌面版不在跑会直接报 `UPSTREAM_REQUEST_FAILED`。 |
| Node.js ≥ 18 | 由 Host 的 MCPB 运行环境提供；桥接服务本身基于 Node。 |
| 支持 MCPB 的 MCP Host | 如 Claude Desktop 等只支持 stdio 的 Host。已支持 HTTP 的 Host（Cursor 等）直接按 [MCP 服务](/guide/mcp/) 接入即可，无需 Bundle。 |
| 平台 | Windows / macOS / Linux。Android 不适用（Kabegame Android 不启动 MCP 服务）。 |

## 从源码构建

目前需自行从源码打包（见下文『从源码构建』），官方发布渠道待规划。

使用官方 CLI [`@anthropic-ai/mcpb`](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md) 打包仓内的 `mcpb/kabegame-gallery-node/`：

```bash
cd mcpb/kabegame-gallery-node
npm install
npx @anthropic-ai/mcpb pack .
```

执行成功后会在当前目录生成 `kabegame-gallery-node.mcpb` 文件。

## 导入到 Host

在你的 MCP Host 的扩展 / MCP 设置中找到「导入 `.mcpb`」或等价入口，选择上一步生成的 `.mcpb` 文件完成安装。具体按钮名称以所用 Host 的文档为准。

导入后 Host 通常会展示一个配置表单，字段来自 Bundle 的 manifest：

| 配置项 | 环境变量 | 默认值 | 说明 |
|---|---|---|---|
| Kabegame MCP endpoint | `KABEGAME_MCP_ENDPOINT` | `http://127.0.0.1:7490/mcp` | 本地 Kabegame MCP HTTP 端点 URL。 |
| Request timeout (ms) | `KABEGAME_MCP_TIMEOUT_MS` | `12000` | 单次上游 HTTP 请求超时，范围 `1000..60000`。 |
| Debug logging | `KABEGAME_MCP_DEBUG` | `false` | 开启后 `debug` 级日志输出到 stderr。 |

:::note
大多数情况下保持默认值即可。只有当你修改了 Kabegame 的监听端口，或长任务频繁超时时才需要调整。
:::

## 验证是否连通

导入并启用 Bundle 后，在 Host 中确认以下两步：

1. 工具列表里应出现 3 个工具：`read_gallery_provider`、`read_image_metadata`、`set_album_images_order`。
2. 让助手调用 `read_gallery_provider`，参数 `path` 传 `all/0`，应返回首页画廊数据的 JSON。若返回 `UPSTREAM_REQUEST_FAILED`，说明桌面版没在跑或端口不通。

每个工具的简要职责：

- **`read_gallery_provider`** — 读一页画廊 provider 路径（例如 `all/0`、`album/{id}/album-order/0`）。上游映射到 `provider://<path>`，`path` 语义见 [MCP 参考](/reference/mcp/)。
- **`read_image_metadata`** — 按 `image_id` 读单张图片的 metadata（标签、作者、来源 URL 等）。
- **`set_album_images_order`** — 为一个画册设置手动顺序，单次最多 100 条；超过的话需要分批调用。

### 工具输入约束

| 工具 | 约束 |
|---|---|
| `read_gallery_provider` | `path` 必填，禁止包含 `..`，不能以 `/` 开头，长度 ≤ 512。 |
| `read_image_metadata` | `image_id` 必填，长度 ≤ 256。 |
| `set_album_images_order` | `image_orders` 长度 `1..100`，每项为 `{image_id, order}`。 |

## 安全边界

Bundle 在启动时对 endpoint 做强校验：

- 协议必须为 `http:` 或 `https:`。
- 主机必须在白名单：`127.0.0.1` / `localhost` / `::1`。

不在白名单内的 endpoint 会让进程在启动时直接抛错退出，这是 Bundle 的硬约束，**不支持连远程机器**。如需跨机访问，应通过 SSH 端口转发或反向代理把远端端口映射到本机回环后再连。

## 常见问题

**现象**：工具调用返回 `UPSTREAM_REQUEST_FAILED`。  
**原因**：Kabegame 桌面版没在跑，或 `7490` 端口被占用。  
**操作**：先确认桌面版已启动，参考 [MCP 服务](/guide/mcp/) 的「排障」小节核对端口。

**现象**：Host 报 Bundle 子进程启动失败，日志里能看到抛错。  
**原因**：`KABEGAME_MCP_ENDPOINT` 被改成了白名单外的主机（例如局域网 IP）。  
**操作**：把 endpoint 改回 `http://127.0.0.1:7490/mcp` 或 `localhost` 变体。

**现象**：工具调用返回 `TIMEOUT`，消息里有 `Upstream request timed out after {ms}ms`。  
**原因**：请求处理时间超过了 `request_timeout_ms`。  
**操作**：在 Host 的 Bundle 配置里调大 `Request timeout (ms)`，上限 60000。

**现象**：想批量重排一个大画册，但工具只接受 100 条。  
**原因**：`set_album_images_order` 单次上限就是 100。  
**操作**：让助手分批调用，每批 ≤ 100 条。

**现象**：找不到 Bundle 的运行日志。  
**原因**：Bundle 把 JSON 结构化日志全部写到 stderr，不写文件。  
**操作**：查看 Host 收集的子进程日志；打开 Debug logging 会输出更多 `debug` 级条目。

## 延伸阅读

- [MCP 服务](/guide/mcp/) —— Bundle 背后的 HTTP MCP 服务与能力全集。
- [MCP 参考](/reference/mcp/) —— `provider://` URI 语义、分页与字段清单。
- [画廊](/guide/gallery/) —— 理解 `provider://all/...` 对应应用内的哪些视图。
