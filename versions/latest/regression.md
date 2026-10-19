# v4.6.1 regression

## 任务级 dry-run（`isDryRun`）

任务记录与自动配置新增冻结字段 `isDryRun`。空跑仍执行插件请求、翻页、解析、日志和进度，但下载队列、
metadata 写入与本地导入后处理在宿主单点短路；任务应以 0 成功、0 失败正常完成。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 数据库迁移 | v042 数据库 | 启动新版应用并查看 schema | 升到 v043；`tasks` / `run_configs.is_dry_run` 默认 0 | dev 库实测 user_version=43，既有 268 条任务均为 0 |
| [x] | V8 dry-run | dev CLI | `plugin run <kgpg> --dry-run --var end_page=1` | 有启动提示和逐图跳过日志；Completed，计数为 0，images / metadata 无新增 | wallhaven 经主程序与 `--via local` 各跑一次：print 级启动提示，24 条跳过下载 |
| [x] | 仅打印配置 | dev CLI | 同一插件改用 `--print-config` | 只打印最终配置，不创建任务、不联网 | 经主程序（协议 v3）执行，tasks 行数不变 |
| [x] | 三类前端入口 | 桌面 CEF | 插件收集、网页收集、本地导入分别打开 dry-run 并提交 | 卡片显示空跑徽标；运行参数显示空跑；三类任务均不入库 | 选源前打开的开关会带入；网页收集 V8 / WebView 后端分别跳过 35 / 29 个下载，快照不写 metadata；本地导入逐文件跳过 |
| [x] | 回填与自动任务 | 桌面 CEF | 再次执行 dry-run 任务；保存为自动任务并触发 | 开关保持；定时任务的 `tasks.is_dry_run = 1` | 自动任务详情与编辑页均显示开启；`run_missed_configs` 触发出 scheduled 任务 |
| [x] | 推荐配置 | 桌面 CEF | 导入带 `isDryRun: true` + `scheduleSpec` 的临时推荐配置 | RunConfig 保留字段，定时触发为空跑；导出仍含 `isDryRun` | 用原始预设 JSON 走 `parsePluginRecommendedPreset` → `importRecommendedPreset` → `runConfigToPresetJson`，未经插件打包；临时配置已删除 |
| [ ] | WebView common | WebView 插件 | 输出 `Kabegame.common.isDryRun` | 普通任务为 false，空跑为 true；`Kabegame.vars` 不混入该 key | 网页收集 WebView 后端带新占位符的 bootstrap 正常运行；`Kabegame.common` 为闭包局部，CDP 读不到，值待用 WebView 插件打印 |
| [ ] | common.baseUrl | V8 / WebView 插件 | 输出 `common.baseUrl` / `Kabegame.common.baseUrl` | 等于插件 `kbBaseUrl`（空串为 null）；不再有 `base_url` 键 | V8 由 `plugin::v8` 单测断言通过；WebView 同上待测 |

## 插件路径类变量（只读 `input` 挂载）

路径类变量（`path` / `file` / `folder` / `file_or_folder`）在任务冻结时解析成 `PluginVfs` 的只读 `input`
挂载，脚本拿到的是虚拟路径（文件 `/{handle}/input/<key>/<文件名>`、文件夹 `/{handle}/input/<key>`），
宿主绝对路径不再进入 JS；`data|cache|tmp` 三个可写挂载与 `downloadImage()` 行为不变。Android 只支持
单个文件（`content://`），文件夹变量在冻结时报错。收集弹窗的路径控件同时获得拖入能力。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 后端单测 | macOS | `test-kabegame/driver.sh kabegame-core --lib plugin::vfs`、`--lib input_mounts`、`--lib try_new_mounts_inputs`、`--lib downloads_from_read_only_input_mount` | 19 + 8 + 1 + 1 项全部通过 | 已运行 |
| [ ] | 文件变量读取 | 桌面 dev | 临时 V8 插件声明 `file` 变量；`plugin run <kgpg> --id kb-input-test --var src=/abs/a.png` | 脚本 `readFile(custom.src)` 读到的内容与源文件一致，`downloadImage(custom.src)` 成功入库，源文件内容/时间不变 | |
| [ ] | 文件夹变量读取 | 桌面 dev | 同一插件声明 `folder` 变量并 `readDir` / 逐文件 `downloadImage` | 整棵子树可读并入库；写入 `input`、rename、删除均报权限错误 | |
| [ ] | 虚拟路径不可写 | 桌面 dev | 脚本对 `custom.src` 调 `writeFile` / `remove` / `rename`，再复制到 `tmp` | 前三者被拒绝（PermissionDenied），复制到 `tmp` 成功 | |
| [ ] | 重复执行重新解析 | 桌面 dev | 任务「再次执行」，期间移动源文件 | 冻结时报「配置不合法」或使用新路径，不会沿用旧挂载 | |
| [ ] | 内建插件不回归 | 桌面 dev | 本地导入、网页收集各跑一次 | 行为不变，不出现 `input` 挂载报错 | |
| [ ] | Android 文件变量 | Android 真机 | 收集弹窗选择文件后启动任务 | 脚本可读到该文件并入图库；文件夹变量在启动前提示不支持 | |
| [ ] | 路径控件拖入 | 桌面 CEF | 收集弹窗中把单个图片 / 单个文件夹拖到路径控件 | 出现「设为「xxx」」浮层，松手后变量被写入；`file_or_folder` 的分段控件切到对应模式 | |
| [ ] | 路径控件拒绝 | 桌面 CEF | 拖入多个文件、拖入目录到 `file` 变量、拖入扩展名不匹配的文件 | 提示「此处不支持拖入这些文件」，变量不变 | |

## 拖入热区改为 `<DragFileZone>` + z 序命中

`v-drag-file` 指令重构为组件：注册表持有响应式 props，命中改为 `document.elementsFromPoint` 取最上层
元素后沿父链找最近热区。修复收集弹窗开着时拖到弹窗上仍导入画廊的问题。画廊 / 画册 / 插件页原有拖入
行为与 `v-pull-to-refresh` 保持不变。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 前端类型检查 | macOS | `deno task check -c kabegame --skip cargo` | 0 error | 已运行 |
| [x] | 前端全量单测 | macOS | `cd apps/kabegame && NODE_ENV=test deno task test` | 33 个文件 / 271 项全部通过 | `NODE_ENV=production` 下 `@vue/test-utils` 无法记录 emitted，须用 test 环境 |
| [x] | 旧指令清理 | 仓库文本检索 | `grep -rn "v-drag-file\|directives/dragFile" apps/kabegame/src` | 无结果 | |
| [ ] | 弹窗遮挡修复 | 桌面 CEF | 打开收集弹窗，把外部文件拖到弹窗任意区域 | 提示「此处不支持拖入这些文件」，画廊不新增任务 | 原先会导入画廊 |
| [ ] | 画廊拖入不回归 | 桌面 CEF | 把图片 / 视频 / 文件夹拖到画廊网格 | 浮层与 local-import 导入与之前一致 | |
| [ ] | 画册拖入不回归 | 桌面 CEF | 在普通画册、文件夹画册、收藏、隐藏、标签目录分别拖入 | 普通 / local_folder 导入选中画册；收藏 / 隐藏 / 标签目录提示不支持 | |
| [ ] | 插件页拖入 | 桌面 CEF | 把 `.kgpg` 拖到插件页 | 安装插件；同时拖入非 kgpg 不入列表 | |
| [ ] | 下拉刷新 | 桌面 CEF / Android | 插件页、画册页下拉 | `v-pull-to-refresh` 仍然生效 | 指令挂在组件根元素上 |
| [ ] | v-loading 命中 | 桌面 CEF | 页面 loading 遮罩显示时拖入 | 浮层仍按页面热区显示（父链命中） | |
