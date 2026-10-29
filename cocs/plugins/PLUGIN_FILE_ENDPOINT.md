# 插件文件按需读取：桌面命令与 Android / Web `/plugin_file`

列表、安装事件和商店详情只返回轻量 `Plugin`：身份、图标、原始 `packageJson`、解析后的配置、资源键 `assetKeys` 与 `fileOrigin`。
文档、更新日志、模板、推荐配置、图片字节、主脚本和迁移脚本不常驻插件 map。安装和扫描时仍校验声明的文本是否存在、UTF-8 与 JSON 是否合法；资源使用 ZIP 未压缩大小检查每文件 2MB、合计 10MB 上限，超限项不进入 `assetKeys`。

桌面由 Tauri 命令 `read_plugin_file` 返回 IPC 原始字节，前端按插件 id、版本、来源和路径缓存文本或 `blob:` URL；Android / Web 保留 HTTP 路由。两端共用核心层 `read_plugin_file` 的坐标、白名单与 ZIP 读取逻辑。

## 请求与来源

```text
GET /plugin_file/<plugin_id>/<逐段编码的包内路径>?v=<版本>
GET /plugin_file/<plugin_id>/<path>?v=<版本>&source=<sourceId>
GET /plugin_file/<plugin_id>/<path>?v=<版本>&preview=<token>
```

| 参数 | 语义 |
| --- | --- |
| `v` | 必填，必须与指定来源当前记录的插件版本完全一致 |
| `source` | 可选，选择该商店源的已下载 kgpg 缓存 |
| `preview` | 可选，选择导入预览登记的 kgpg；与 source 互斥 |

无来源参数读取已安装插件。`fileOrigin` 是带 `kind` 的对象：`{kind:"installed"}`、`{kind:"store",sourceId}` 或 `{kind:"preview",token}`。
导入文件登记在容量为 8 的 LRU 中；访问更新最近使用顺序，淘汰后 HTTP 返回 404、桌面命令返回错误。商店安装预览沿用 store 来源。
插件包在持有记录期间假定不被外部改写；安装与更新通过重新解析记录更新版本和白名单。

## 白名单与错误

核心层 `plugin/package_file.rs` 先用 `normalize_asset_path` 归一化请求，再只允许以下条目：

- `package.json`、`kbIcon`；
- `kbDoc`、`kbChangelog` 的全部 locale 路径；
- `kbDescriptionTemplate`、`kbRecommendedConfigs`；
- 通过大小上限的 `assetKeys`。

主脚本、迁移脚本和 provider DSL 不经此出口公开，除非同一条目另被声明为允许公开的文件。路径越过插件根、未声明资源、资源超限、来源或插件不存在、版本不符、缺少版本、ZIP 条目缺失、读取失败 在 HTTP 返回 404、桌面命令返回错误。读取函数只访问 ZIP 条目，不把请求路径当宿主文件路径。

## 响应与缓存

Android / Web HTTP 响应带 `ETag`（插件版本、kgpg 大小与 mtime）、`Cache-Control: no-cache`。匹配 `If-None-Match` 返回 304；图片使用标准 MIME，Markdown、JSON、其它文本分别使用 `text/markdown`、`application/json`、`text/plain`，文本带 UTF-8 charset。

推荐配置的动态行通过 `plugin://…/recommended` 读取，文件出口只返回原始字节，不查询运行配置。
来源、事件和观察方契约见 [任务与配置按需加载](../downloader-tasks/TASK_DRAWER_LOAD.md#推荐配置观察方)
与 [MCP 插件资源](../mcp/MCP_SERVER.md)。

## 平台挂载

桌面不启动本地文件服务，插件文件由 `read_plugin_file` 命令读取；Web debug 与 release 文件服务合并 `plugin_file_routes()`。Web dev 的 Vite 代理清单必须包含 `/plugin_file`，与 `/rpc`、`/events` 一起转发到 Rust Web 服务（7490）；否则同源文件请求会被 SPA 回退吞掉并返回 HTML。路由提供 CORS，允许 GET / HEAD / OPTIONS、`If-None-Match`，公开 ETag 和 Cache-Control 响应头。
Android 在 Rust 主进程按需启动仅含该路由的 `127.0.0.1:0` axum 服务；`get_http_server_base_url` 将端口交给 picker，Kotlin `LocalHttpServer` 转发 `/plugin_file/*` 的原始路径、查询串与条件请求头，并透传状态、正文和相关响应头。Android 前端仍使用 Kotlin 的同一个 HTTP host；`get_http_server_base_url` 仅在 Android 调用。

## 前端与脚本生命周期

Android / Web 的 `utils/fileUrl.ts::pluginFileUrl` 拼接版本与来源 URL。桌面通过 `services/pluginFiles.ts` 调用命令并将图片字节转成 `blob:` URL；文本与 blob 都按插件坐标缓存，请求失败删除缓存，失效时撤销 blob URL。插件安装或更新版本变化，以及删除插件时，按 pluginId 失效。
文档和更新日志的语言路径遵循 locale → default，打开相应 tab 才请求。Markdown 的本地图片必须命中 `assetKeys`，然后在桌面改写为 blob URL，Android / Web 仍为 HTTP URL；banner 按声明顺序异步获取地址。
图片详情等模板请求完成后再决定渲染 EJS 或原始 metadata，切换插件时忽略晚到的旧结果。
自动配置页、插件详情与收集对话框共用 `useRecommendedPresets`；已安装、商店缓存与本地预览各自观察
`plugin://` 来源版本路径，按清单顺序占位并落地推荐行。商店详情只做内存缓存；Dexie 只保留商店图标表。

任务冻结时 `load_script` 从 main 读取源码到 `TaskParams.plugin`，以 `Arc<str>` 保存快照；列表仍只持 backend。内建插件继续携带静态源码。
迁移调度只保留路径，执行时读取迁移脚本。MCP 的 doc / changelog / template / asset 复用按需 ZIP 读取，输出字段形状保持不变。
