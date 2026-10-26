# v4.7.0 regression

## metadata 冻结描述模板（`plugin run --freeze-template`）

CLI `plugin run` 加 `--freeze-template` 后，任务冻结时读一次插件包内 `kbDescriptionTemplate`，`Task::insert_metadata` 写进每行 `metadata.template`。开关只在内存中经 `CrawlTaskRequest` 传递，不入任务记录。详情面板并行获取冻结模板与插件模板，前者非空即覆盖。去重覆盖改挂新行，data 与模板一起被替换，未冻结时清空；metadata 迁移原样拷贝模板，去重按模板分区。IPC 协议升到 v4。

2026-10-26：macOS 桌面 CEF dev 真机实测（`deno task b -c kabegame-cli --data dev` 新建 dev CLI，`deno task dev -c kabegame` 启动时执行 v047 迁移，`metadata` 表新增 `template` 列）。用 `miyoushe`（V8，模板经 `__bridge.getPluginData()` 读表情映射）以 `run-cli.sh` 跑「壁纸」搜索第 1 页；经 CDP 打开预览并读取 iframe DOM，截图在会话 scratchpad。测试 id 产生的图片与任务已清理。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 测试 id 冻结模板渲染 | dev app + dev CLI | 运行 `plugin run <kgpg> --id <id>-test --freeze-template` 后，打开一张测试 id 图片的详情 | 插件详情面板以 iframe 渲染模板，不再只显示原始键值 | `--id miyoushe-ft1` 入库 60 张、3 行 metadata，`template` 全部非空且与包内 `description.ejs` 逐字节一致；`pathql query images://id_<id>/metadata_full` 返回 `template`。测试 id 未安装，详情面板以 iframe 渲染帖子卡片，原始键值 0 项 |
| [x] | 未冻结回退 | dev app + dev CLI | 不加 `--freeze-template`，用新测试 id 跑一次并打开详情 | 未安装插件时显示原始 metadata 键值 | `--id miyoushe-nf1 --no-freeze-template`：metadata `template` 为 NULL，详情面板无 iframe，显示 25 项原始键值 |
| [x] | 冻结模板覆盖插件模板 | dev app + dev CLI | 对已安装插件改本地模板后打包，用已安装 id 加 `--freeze-template` 运行 | 新图片详情使用冻结的新模板；旧图片仍用已安装插件模板 | 已安装 `miyoushe`：先用已安装 id 不冻结跑出旧图，再把加了隐藏标记的模板打包，以路径模式 `--id miyoushe --freeze-template` 跑新图。新图 iframe 含标记，旧图不含。注意：同版本重新打包后，前端内存里的插件模板缓存（`pluginFiles` 按版本 URL 缓存）在 `refresh_plugins` 后仍是旧内容，需要重载页面 |
| [x] | 去重覆盖清空模板 | dev app + dev CLI | 开启「去重时更新元数据」，先带 `--freeze-template` 跑一次，再不带参数跑同一批 | 第二次去重命中后图片改挂新 metadata，详情退回插件模板或原始键值 | 开启「去重时更新元数据」与自动去重（dev 原为关闭，测完已恢复），同一测试 id 不冻结重跑同一批：60 张 URL 去重命中，图片改挂新 metadata（如 12422→12429），新行 `template` 为 NULL，旧冻结行被 GC；详情退回原始键值。命中的旧图若是其它来源，`plugin_id` 也会改为本次 id（符合「插件下载覆盖任意来源」设计）。自动去重关闭时重跑会重复入库，不会命中 |
| [x] | bridge 按测试 id 取数 | dev app | 打开使用 `__bridge.getPluginData()` 的插件模板的测试 id 图片 | 读到测试运行写入的插件数据，模板正常渲染 | iframe 内 `__bridge.getPluginData()` 返回 `miyoushe-ft1` 的数据（`miyoushe_emoticon_map` 3105 项），正文渲染出 13 个表情图片 |
| [ ] | IPC v4 门控 | dev CLI | 主程序运行时执行 `plugin run --freeze-template`，确认走 app IPC | 新 CLI 与新主程序协议一致并走 app；连旧主程序时打印协议过旧并回退本地 | 前半部分已验证：dev app 运行时 CLI 输出「经主程序执行（版本 4.6.1）」，没有协议过旧回退，任务进入 app 任务表。连旧主程序回退本地未测（缺少 v3 主程序） |
| [x] | 迁移保留模板与去重分区 | 单测 | `frozen_template_tests` | 写回新行拷贝模板；data 相同、模板不同的行不合并；改挂到无模板行后旧冻结行被 GC | `deno task test` kabegame-core 通过 |
| [x] | v047 迁移幂等 | 单测 | `v047_metadata_template::tests` | 执行两次只加一列，旧行 template 为 NULL | 通过 |
