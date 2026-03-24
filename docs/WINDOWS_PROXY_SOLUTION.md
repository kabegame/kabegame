# Windows 系统代理支持方案

## 1. 问题描述

Windows 用户反馈：下载图片、插件等网络请求**无法走系统代理**。  
用户在系统设置或 Clash 等代理软件中启用了「系统代理」，但 Kabegame 的下载仍直连，无法通过代理访问外网。

---

## 2. 根因分析

### 2.1 当前代理逻辑

项目中的 HTTP 客户端（reqwest）仅通过**环境变量**配置代理：

- `HTTP_PROXY` / `http_proxy`：HTTP 连接
- `HTTPS_PROXY` / `https_proxy`：HTTPS 连接
- `NO_PROXY` / `no_proxy`：直连排除列表

当这些环境变量**未设置**时，不会配置任何代理。

### 2.2 reqwest 的行为

reqwest 0.11 文档中的 “System proxies” 指**环境变量**，不包含 Windows 注册表中的系统代理配置。  
因此，reqwest 默认不会读取 Windows「设置 → 网络 → 代理」中的配置。

### 2.3 Windows 系统代理的存储位置

Windows 系统代理（含 Clash、V2Ray 等开启「系统代理」时的配置）写入注册表：

- 路径：`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`
- `ProxyEnable`：1 表示启用
- `ProxyServer`：格式如 `http=127.0.0.1:7890;https=127.0.0.1:7890` 或 `127.0.0.1:7890`
- `ProxyOverride`：直连排除列表（可选）

环境变量与注册表互不影响，故仅配置系统代理时，Kabegame 不会使用该代理。

---

## 3. 涉及代码文件

| 层级 | 文件路径 | 作用 |
|------|----------|------|
| 图片下载 | `src-tauri/core/src/crawler/downloader/http.rs` | `create_client()`：构建 HTTP 客户端，当前仅读环境变量 |
| 插件商店 | `src-tauri/core/src/plugin/mod.rs` | 插件列表请求、插件源验证、插件下载，各有一处 `Client::builder()` + 环境变量代理 |
| 相关流程 | `cocs/DOWNLOADER_FLOW.md` | 下载器流程说明 |

---

## 4. 解决方案

### 4.1 推荐方案：在 Windows 上读取注册表系统代理

当环境变量未设置时，在 Windows 上增加注册表读取逻辑：

1. 读取 `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`
2. 若 `ProxyEnable == 1`，读取 `ProxyServer`
3. 解析 `ProxyServer` 格式：
   - `http=host:port;https=host:port` → 取 `https` 或 `http` 的地址
   - `host:port` → 共用同一代理
4. 构造代理 URL：HTTPS 请求应通过 **HTTP 协议**连接代理（`http://host:port`），由代理做 CONNECT 隧道，而非 `https://`
5. 可选：读取 `ProxyOverride`，转换为 `NO_PROXY` 语义

项目已有 `winreg` 依赖（`src-tauri/app-main/Cargo.toml`），可直接使用。

需修改的位置：

- `create_client()`：在环境变量分支之后、`build()` 之前增加 Windows 注册表分支
- `plugin/mod.rs`：三处 HTTP 客户端构建逻辑，同样增加 Windows 注册表分支；或抽取公共函数复用

### 4.2 临时缓解

- 启动前设置环境变量：`set HTTPS_PROXY=http://127.0.0.1:7890`（端口按实际代理软件）
- 或在代理软件中配置「设置系统代理时同时写入环境变量」（若支持）

### 4.3 升级 reqwest

后续版本可能对 Windows 系统代理有更好支持，升级后需验证默认行为是否满足需求。

---

## 5. 注意事项

- **HTTPS 代理协议**：注册表 `https=127.0.0.1:7890` 表示 HTTPS 请求走该代理，但连接代理时应使用 `http://127.0.0.1:7890`，避免误用 `https://` 导致连接失败
- **ProxyOverride**：部分用户会配置本地/内网直连，实现时可考虑支持以提升兼容性

---

## 6. 参考

- reqwest 文档：<https://docs.rs/reqwest/0.11/reqwest/>
- Windows 注册表代理：`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`
- reqwest issue：HTTPS System proxies 在 Windows 上的解析问题（#1080）、ProxyOverride 支持（#1444）
