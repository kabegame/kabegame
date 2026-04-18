# Kabegame Gallery MCP Bundle (MCPB)

这是一个可直接打包的本地 MCP Bundle（`*.mcpb`），通过 `stdio` 暴露 MCP 工具，并桥接到本机 Kabegame 的 HTTP MCP 服务（默认 `http://127.0.0.1:7490/mcp`）。

## 功能

- `read_gallery_provider`：读取 provider 路径（分页数据）
- `read_image_metadata`：按 `image_id` 读取 metadata
- `set_album_images_order`：设置相册手动排序（单次最多 100 条）

## 目录结构

- `manifest.json`：MCPB 清单（`manifest_version: 0.3`）
- `server/index.js`：MCP stdio 服务端实现
- `scripts/check-manifest.js`：manifest 基础自检脚本
- `package.json`：Node 依赖与脚本

## 运行与调试

1. 安装依赖

```bash
npm install
```

2. 可选：校验 manifest

```bash
npm run check:manifest
```

3. 启动 MCP 服务（stdio）

```bash
node server/index.js
```

## 打包为 `.mcpb`

推荐使用官方 CLI：

```bash
npm install -g @anthropic-ai/mcpb
mcpb pack .
```

## 工具输入约束（防御性）

- `read_gallery_provider.path`
  - 必填，非空字符串
  - 禁止 `..`
  - 禁止以 `/` 开头
  - 长度 <= 512
- `read_image_metadata.image_id`
  - 必填，非空字符串，长度 <= 256
- `set_album_images_order`
  - `album_id` 必填
  - `image_orders` 必填数组，长度 1..100
  - 每项必须包含 `image_id`（字符串）和 `order`（整数）

## 安全与超时策略

- 仅允许本地 endpoint 主机：`127.0.0.1` / `localhost` / `::1`
- 上游请求全部使用 `AbortController` 超时中断
- 异常统一包装为结构化 JSON 响应（`ok: false, code, message, details`）
- 日志输出到 `stderr`，默认 `info/error`；开启 `KABEGAME_MCP_DEBUG=true` 可查看 `debug`

## 用户配置映射（manifest）

- `kabegame_mcp_endpoint` -> `KABEGAME_MCP_ENDPOINT`
- `request_timeout_ms` -> `KABEGAME_MCP_TIMEOUT_MS`
- `debug_logging` -> `KABEGAME_MCP_DEBUG`

## 测试建议

- 工具返回结构：确认所有工具返回 `content` + `structuredContent`
- 超时行为：将 endpoint 指向无响应地址，确认 `TIMEOUT` 错误
- 主机限制：将 endpoint 配置为非 localhost，确认启动即失败
- Host 集成：导入 `.mcpb` 后确认能列出工具并成功调用
