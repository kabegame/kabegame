# cocs 文档索引

本目录用于沉淀 Kabegame 的关键流程、架构约束与迁移说明。  
当需要理解某个模块时，建议先从本索引定位文档，再按文档中的“涉及文件”阅读代码。

## 阅读顺序建议

1. 先看本索引，定位目标主题。
2. 进入对应文档了解流程与边界。
3. 再打开文档中引用的代码文件做实现核对。

## 文档列表

- `PROVIDER_IMAGEQUERY_COMPOSABLE.md`
  - 主题：Gallery/VD 共用的 Provider + ImageQuery 可组合查询系统。
  - 适用场景：新增过滤、排序、数据源；理解 `JOIN/WHERE/ORDER` 组合方式；排查 provider 查询路径问题。

- `GALLERY_PAGINATION_AND_IMAGE_LOAD.md`
  - 主题：画廊 SimplePage 分页与每页条数（100/500/1000）的前后端数据流、设置持久化、`browse_gallery_provider` 与 `invoke` 参数约定。
  - 适用场景：排查翻页/offset、每页条数切换不刷新、列表加载失败；区分 SimplePage 与 VD Greedy 的 `LEAF_SIZE` 行为。

- `CRAWLER_JS_FLOW.md`
  - 主题：Crawler JS 执行链路与相关模块关系。
  - 适用场景：调度、注入、抓取流程排查与扩展。

- `DOWNLOADER_FLOW.md`
  - 主题：下载器流程与关键调用路径；含 `task-image-counts` 任务图片计数事件说明。
  - 适用场景：下载任务生命周期、失败重试、状态流转问题；任务 success/deleted/failed/dedup 计数与前端同步。

- `TASK_DRAWER_LOAD.md`
  - 主题：任务抽屉分页加载、触底加载与相关数据流。
  - 适用场景：任务数量多时打开抽屉卡顿、loadTasksPage 与 get_tasks_page 行为。

- `PLUGIN_STORE_CACHE.md`
  - 主题：插件商店缓存机制与更新策略。
  - 适用场景：插件列表更新延迟、缓存失效与命中行为分析。

- `I18N_MIGRATION.md`
  - 主题：i18n 迁移约束、命名空间规范与落地状态。
  - 适用场景：新增国际化 key、迁移旧文案、核对多语言覆盖。

- `TAURI_ACL_PERMISSION_SYSTEM.md`
  - 主题：Tauri v2 ACL（capability/permission）在 app-main 的运行机制与故障复盘。
  - 适用场景：新增窗口 IPC 权限、调整 capability/permission、排查“命令不可用/全部被拒绝”问题。

- `PLUGIN_DESCRIPTION_TEMPLATE_BRIDGE.md`
  - 主题：插件详情 **EJS 全链路**（`metadata` 写入 → `get_plugin_template` 加载 → `ejs.render` → iframe `srcdoc` 注入 `__bridge` → `postMessage` + `proxy_fetch`）。
  - 适用场景：编写/调试 `description.ejs`、理解模板从 ZIP 到展示的流程、排查详情区空白或跨域请求失败。

## 维护规则

- 新增流程文档后，必须在本索引补充条目（主题 + 适用场景）。
- 发生流程级改动时，先更新对应文档，再更新本索引描述（若语义有变化）。
