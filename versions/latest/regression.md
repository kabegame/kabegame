# v4.5.2 regression

## 文件夹画册切换同步模式后子画册状态实时刷新

把文件夹画册切到递归同步（或从递归切走）时，后端会在同一事务里把子树规整为「同步委托」/「不同步」，并逐个发 `album-changed { syncMode }`；但前端 `dataChangeHub` 只放行 `name` / `parentId` / `labelKey` / `albumType` 四个结构字段，`syncMode` 事件被整条丢弃，画册树里已展开的子画册图标停在旧状态（被操作的画册本身只是碰巧经同步的成员变更事件刷新）。现在 `syncMode` 作为行展示字段放行，只写入 `albumIds` 与 `albumPaths`，不进 `albumStructure`，避免画廊网格与过滤树跟着重查；后端 `normalize_local_folder_sync_modes` 同时返回各画册的 `ancestor_path`，`syncMode` 事件统一经 `emit_sync_mode_changes` 携带 `ancestorPath`，树只重拉变更画册所在目录，不再走通配整树刷新。`folderStatus` 事件同样未被放行，但它每次同步都会发且无路径，本次不纳入。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 递归 → 浅同步 | macOS 桌面 CEF / CDP | 展开 `comfy_output`（递归，5 个子画册委托），切为浅同步 | 根画册立即显示浅同步图标，5 个已展开子行同步图标消失（不同步） | 已实测；页面监听到 6 条 `album-changed`，均带 `ancestorPath` |
| [x] | 浅同步 → 递归 | macOS 桌面 CEF / CDP | 同上切回递归同步 | 根画册显示递归图标，5 个已展开子行无需刷新即显示委托（链接）图标 | 已实测并截图核对；dev 数据已恢复为原递归状态 |
| [ ] | 选中子画册时详情面板 | 桌面 CEF | 选中某个子画册，再在父画册上切换递归 / 浅同步 | 右栏同步状态随之在「同步委托」与「不同步」间切换，右键菜单禁用态同步更新 | `useAlbumQuery` 经 `albumIds` 命中 |
| [ ] | 不误刷画廊 | 桌面 CEF | 停留在画廊页，从另一入口切换文件夹画册同步模式 | 画廊网格与过滤侧栏不因 `syncMode` 事件重查 | `syncMode` 不进入 `albumStructure` |
| [ ] | 转为普通画册 / 重新串联 | 桌面 CEF | 对递归画册的祖先关系做调整（新建父级文件夹画册触发 rechain），或转换含委托子树的画册 | 规整产生的 `syncMode` 变更同样带路径并刷新所在目录 | 三处调用方共用 `emit_sync_mode_changes` |
| [x] | 后端单测 | cargo test | `kabegame-core --lib sync_mode` | 3 项通过；规整结果断言包含 `ancestor_path` | 已运行 |
| [x] | 静态检查 | 仓库 | `deno task check -c kabegame` | vue-tsc 与 cargo check 无错误 | 已运行 |

## 任务指南补齐收尾状态与逐任务并发

通过 `kabegame-chromium` 在桌面 dev 中实际启动 `Kabegame 服务器` 任务，核对创建弹窗、运行中任务卡片、下载队列、任务详情页和停止确认流程后更新任务指南。文档将并发关系从旧的两个全局设置改为「同时运行任务数 + 全局下载上限 + 本任务下载上限」，补充创建时关闭跟随全局、运行中即时调节及不突破全局上限的规则；任务状态新增「等待剩余下载」，明确它表示插件脚本已经结束、任务仍在等待排队或处理中的下载落盘。五张 2400×1536 dev 实机截图使用 `annotate-ui-screenshots` 标出创建步骤、任务级并发、任务状态、单张下载阶段、详情统计与停止确认，正文同步删去重复说明。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | Kabegame Server 实跑 | macOS 桌面 CEF / CDP | 在画廊选择 `Kabegame 服务器` 并启动真实任务 | 任务进入抽屉，下载结果持续入库并最终结束 | 已实测；额外截图任务已停止 |
| [x] | 逐任务下载并发 | 创建弹窗 / 任务抽屉 | 关闭「跟随全局」设为 1，运行中用 `− / +` 调整 | 卡片显示当前占用 / 本任务上限；本任务上限即时生效且不突破全局上限 | 已实测 `1/1`、自定义上限与恢复跟随全局 |
| [x] | 等待剩余下载 | Kabegame Server 任务 | 插件脚本结束后观察任务卡片 | 状态徽章显示「等待剩余下载」，队列排空后自动变为「完成」 | dev 中两次观察到 `99.90%` 收尾状态 |
| [x] | 详情与停止确认 | 任务详情页 | 从运行中任务进入详情页并点击「停止任务」 | 统计实时刷新；停止前出现确认弹窗，确认后任务变为「已取消」且已下载图片保留 | 已实测并停止截图任务 |
| [x] | 标注截图资源 | 文档资源 | 检查创建弹窗、任务抽屉、任务详情与停止确认的原图和 `-annotated` 输出 | 5 张标注图保持 2400×1536，箭头指向真实控件；输出路径留空，不暴露个人目录 | 已静态核对与逐张目视检查 |
| [x] | 关联文案 | 任务 / 设置 / 插件使用指南 | 搜索五种状态、全局并发与清理条件的旧描述 | 状态列表包含收尾阶段，设置页明确全局上限，清理与停止覆盖等待剩余下载 | 已静态核对 |
| [x] | Markdown 静态检查 | 仓库 | 检查图片引用、资源尺寸与 Git diff | 图片路径存在，原图保留，无空白错误 | 已静态核对 |
| [x] | 文档站构建 | Astro / Starlight | 运行 `deno task docs:build` | `/guide/tasks/` 正常生成，5 张标注图均完成优化 | 构建通过；现有重复文档 ID 与 `ejs` 高亮警告不由本次变更引入 |

## 项目内界面截图标注 skill

新增 `.claude/skills/annotate-ui-screenshots`，把本轮畅游文档采用的真实 UI 保留、紫色短标签、粉色箭头、`-annotated` 文件名、目视复核和正文去重流程固化为项目技能。技能附带基于 ImageMagick 的确定性脚本，以 JSON 指定标签框、文本基线和箭头目标，不把 Wallhaven 等单次截图内容写死；`AGENTS.md` 与 `.cursor/rules/screenshot-annotation.mdc` 同步登记使用约定。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 技能位置与发现 | `.claude/skills/annotate-ui-screenshots` / `AGENTS.md` / Cursor 规则 | 检查 `SKILL.md`、界面元数据和项目索引 | 技能随仓库版本管理，Codex 与 Cursor 都能定位真实 UI 截图标注约定 | 已静态核对 |
| [x] | 确定性标注脚本 | macOS / ImageMagick | 用现有 2400×1536 畅游截图和临时 JSON spec 运行 `scripts/annotate.py` | 自动探测中文字体，生成紫色标签与粉色箭头，输出尺寸与输入一致 | 已实测并目视检查 |
| [x] | 安全边界 | 技能说明 | 检查输出命名、覆盖保护和生成式编辑约束 | 默认输出 `-annotated` 文件，不覆盖原图，不重绘真实 UI | 已静态核对 |
| [x] | 脚本语法 | Python 3 | 运行 `py_compile` | 无语法错误 | 已实测 |

## 畅游文档按 dev 实机流程重写

通过 `kabegame-chromium` 连接正在运行的桌面 dev，在畅游中真实打开 Wallhaven 搜索页与图片详情页，执行一键下载并从记录卡片进入站点下载图片页。文档从旧的“逐张右键下载”说明更新为当前的一键下载主流程，补齐导航栏、取消、当前页扫描、列表页缩略图与详情页原图差异、冻结网页性能影响、Cookie 复用、显式关闭会话和新版查询工具栏。旧总览截图已替换，并新增 Wallhaven 详情窗口与 50 张实际下载结果截图；三张图片加入短标签和箭头，正文同步删去重复的按钮说明。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | dev 实机连接 | macOS 桌面 CEF / CDP | 用 `kabegame-chromium` 打开畅游主页、Wallhaven 窗口和畅游图片页 | 说明与截图来自当前运行界面 | 已实测 |
| [x] | Wallhaven 一键下载 | 畅游详情页 | 从 nature 搜索进入单张详情页，点击导航栏下载箭头并检查记录 | 下载结果关联到 `wallhaven.cc` 畅游记录，同时进入总画廊 | 记录最终显示 50 张；用户手动确认下载成功 |
| [x] | 冻结网页边界 | 下载设置 / 畅游 | 对比开启与临时关闭「冻结网页」后的运行状态，再恢复原设置 | 文档说明保存页面快照会增加复杂页面开始下载前的处理时间 | 原设置已恢复为开启 |
| [x] | 查看下载图片 | 畅游记录 | 点击 Wallhaven 记录卡片进入站点图片页 | 显示该记录的实际下载结果和当前查询工具栏 | 已实测并截图 |
| [x] | 截图资源 | 文档资源 | 检查记录列表、Wallhaven 窗口和下载结果三张截图 | 均为 2400×1536 PNG，使用 `-annotated` 后缀标识已标注版本，短标签与箭头指向准确，内容清晰且无 Cookie | 已静态核对与目视检查 |
| [x] | Markdown 静态检查 | 仓库 | 检查图片、站内锚点、旧交互描述和 Git diff | 资源路径存在，不再宣称没有关闭会话按钮或仅能右键下载 | 已静态核对 |
| [ ] | 文档站实际渲染 | Starlight 桌面与窄屏 | 打开 `/guide/surf/` 检查表格、提示块与截图布局 | 图片不溢出，表格和提示块在窄屏可读 | 待运行文档站后验证 |

## 顶层命令指南归档

开发、构建、检查、测试及辅助命令的参数与注意事项已统一迁移到 `scripts/AGENTS.md`；根
`AGENTS.md` 只列出可用命令、单行用途摘要并提供详情入口。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 根命令索引 | 仓库 | 检查根 `AGENTS.md` 的命令章节 | 只包含命令名、单行用途摘要和 `scripts/AGENTS.md` 链接，不再展开参数或平台说明 | 已静态核对 |
| [x] | 指南完整性 | 仓库 | 对照迁移前后的开发、构建、检查、测试、数据目录和验证章节 | 原有详细说明完整保留在目录级文件 | 已静态核对 |
| [x] | Markdown 静态检查 | 仓库 | 检查修改后的 Git diff 与相对链接 | 无空白错误，根入口可解析到命令指南 | 已静态核对 |

## packages 目录级规则归档

组件库、独立 git submodule、格式化排除项与 PathQL 生成型包的维护说明已统一迁移到
`packages/AGENTS.md`，根 `AGENTS.md` 只保留目录索引、规则入口和命令摘要。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 规则归属 | 仓库 | 对照根与 `packages/AGENTS.md` 的组件库和子仓库说明 | 详细规则只在目录级文件维护，根文件保留有效入口 | 已静态核对 |
| [x] | 包类型清单 | `.gitmodules` / `packages/*/package.json` | 核对 vendored fork、git submodule、普通包与生成型包 | 目录性质和修改边界与仓库现状一致 | 已静态核对 |
| [x] | Markdown 静态检查 | 仓库 | 检查修改后的 Git diff 与相对链接 | 无空白错误，目录级文档链接均可解析 | 已静态核对 |

## 第三方补丁工作流规则归档

第三方补丁序列说明与原 Cursor 路径规则已统一迁移到 `third-patches/AGENTS.md`，根 `AGENTS.md` 只保留入口引用，相关文档链接同步更新；CEF 明确由 `third-patches/cef/*.patch` 与 patch-manager 管理，构建期的 `kabegame-build` 提交只负责桥接 automate-git。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 规则单一来源 | 仓库 | 搜索旧 Cursor 规则与第三方补丁规则引用 | 不再引用已删除的路径规则，目录级 `AGENTS.md` 包含完整工作流 | 已静态核对 |
| [x] | CEF 补丁归属 | 仓库 | 对照 `third-patches/cef/`、patch-manager 与 Chromium 构建脚本 | 文档明确补丁序列是唯一来源，临时提交仅供构建消费 | 已静态核对 |
| [x] | Markdown 静态检查 | 仓库 | 检查修改后的 Git diff | 根规则仅保留入口，目录内链接均可解析 | 已静态核对 |

## 移除已下线的 Wallpaper Engine 导出文档

Wallpaper Engine 导出功能已经下线，壁纸、设置、Android 和画册盘指南同步删除导出教程、目录设置、平台能力矩阵及相关集成暗示，避免文档继续引导用户寻找不存在的入口。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 失效功能文案清理 | 中文文档 | 搜索 Wallpaper Engine 导出、设置项和平台矩阵 | 用户指南不再宣称支持导出或展示相关设置入口 | 已静态核对 |
| [x] | Markdown 静态检查 | 仓库 | 检查修改后的 Git diff | 无空白错误，删除后章节与表格连续 | 已静态核对 |

## 画册文档按 dev 实机界面重写

通过 `kabegame-chromium` 连接正在运行的桌面 dev，逐项核对画册树、新建窗口、标签菜单、本地文件夹同步、加入画册选择器、排序和图片菜单后重写旧文档。新文档以普通画册、标签自动归类和本地文件夹持续同步三种整理方式为主线，补齐当前三栏布局、四类画册、查询工具栏、拖入规则、独立的「从画册移除」与「删除文件」语义；壁纸轮播和画册盘收进桌面附加功能。总览及八个关键交互截图均重新取自本次 dev 实机，并用 `annotate-ui-screenshots` 添加短标签和箭头；正文同步删除与标注重复的入口、字段和菜单复述，保留行为边界、安全提示与平台差异。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | dev 实机连接 | 桌面 CEF / CDP | 用 `kabegame-chromium` 连接运行中的画册页并逐项打开交互 | 截图和说明来自当前实现，不沿用旧界面推断 | 已实测 |
| [x] | 画册类型与树操作 | 桌面 CEF | 检查普通画册、标签、标签目录、本地文件夹及其右键菜单 | 新建字段、层级限制、移动和删除语义与界面一致 | 已实测 |
| [x] | 浏览与图片操作 | 桌面 CEF | 检查查询工具栏、排序、信息栏、加入画册选择器与图片菜单 | 当前入口、筛选能力及「移除 / 删除文件」边界与界面一致 | 已实测 |
| [x] | 标注截图资源 | 文档资源 | 检查总览及八张交互截图的 `-annotated` 版本 | 9 张均保持 2400×1536；每张 2–3 个标注，箭头落在真实控件，原图保留 | 已静态核对与逐张目视检查 |
| [x] | 正文去重 | 画册指南 | 对照标注图检查入口、字段、菜单说明 | 图中可直接理解的操作不再由大段正文重复，限制、删除后果和平台差异仍完整保留 | 已静态核对 |
| [x] | Markdown 静态检查 | 仓库 | 检查图片与站内锚点、旧术语和 Git diff | 标注图片路径全部存在，不再引用四选一过滤、双击标题改名及删除复选框等旧交互 | 已静态核对 |
| [ ] | 文档站实际渲染 | Starlight 桌面与窄屏 | 打开 `/guide/albums/` 检查长表格、提示块与截图布局 | 图片不溢出，表格和提示块在窄屏可读 | 待运行文档站后验证 |

## 插件变量空值、必填与链式显隐语义

插件变量改为显式 `required`，可见空值统一传 `null`，boolean 始终传 bool，被 `when` 隐藏的字段不再出现在任务配置中。主应用和 CLI 只负责把各自输入转换成规范值；后端统一执行「本次提交 > 用户默认 > 插件 default > 隐式空值」合并、链式 `when` 过滤和严格校验。v041 会一次性规范化历史 RunConfig、任务快照和插件默认配置。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [ ] | 可选字段留空 | 主应用 / CLI / 自动任务 | 留空 string、date、number、list 与 checkbox 后启动 | 可见 key 存在且值为 `null`；插件不会收到 `"null"`、空数组或全 false 对象 | 主应用 UI 与 CLI 已用探针插件实测：插件收到 null、boolean 为 false；自动任务未测 |
| [x] | 清空带 default 的字段 | 主应用 / 再次执行 | 清空已有 default 的可选字段并提交，再次执行该任务 | 本次值保持 `null`，不回落到插件 default；再次执行能还原清空状态 | dev app 实测：清空 T2 后任务与插件日志均为 null，「再次执行」回填为空 |
| [x] | 隐藏字段缺键 | 主应用 / CLI dry-run | 切换模式使字段被 `when` 隐藏 | 最终配置中没有该 key，脚本读取为 `undefined` | CLI dry-run（danbooru）与主应用提交均不含被隐藏的 key，插件读取为 undefined |
| [ ] | 链式 when | 主应用 / CLI / 自动任务 | A 依赖 B，B 因 C 隐藏 | B 与 A 逐级隐藏且都不提交；切回 C 后恢复原值与可见性 | CLI 实测 only_b 改值后 chain 一并消失；主应用切回后恢复原值未测，自动任务未测 |
| [ ] | required 拦截 | 主应用 / CLI / 自动任务 | 清空当前可见的 `required: true` 字段 | 创建或调度任务前报配置错误，不产生可运行任务 | 主应用提示「请填写所有必填项」、CLI dry-run 与真实提交均报错且任务数不变；自动任务未测 |
| [x] | options 空字符串值 | 主应用 / CLI | 选择声明了 `variable: ""` 的 option | `""` 原样提交并通过校验，不转换为 `null` | CLI 与主应用均实测：KbSelect 不再过滤 variable ""，分段器（nullprobe「Any」）与下拉（danbooru「不限」）都能显示并选中 ""，提交为 ""；清除回到占位并提交 null。分段器「未选」与 AndroidPickerSelect「清除」改用私有哨兵，不再与 "" 混淆；Android 紧凑布局未实机验证 |
| [ ] | v041 旧数据迁移 | 旧 dev 数据目录 | 启动新版后检查 `run_configs.user_config`、`tasks.user_config`、`default-configs/*.json`，并触发一个旧自动任务 | 旧空串 / 空列表 / 全 false checkbox 按字段类型规范化，数字字符串转数字，旧自动任务可运行 | 文件迁移失败只记日志，不阻断数据库迁移；dev 库升到 v41，已安装插件的 tasks 与 default-configs 中旧空值已规范化，只剩 options 里合法的 ""；*-test 临时 id 取不到定义，"" 按设计保留；dev 无 RunConfig，自动任务未测 |
| [x] | when 环拒绝 | 插件安装 / 商店安装 | 安装字段级或选项级 `when` 形成依赖环的 KGPG | 复制到插件目录前报出成环 key 路径，不留下坏文件 | CLI import 与临时运行均报「when 依赖成环: a -> b -> a」，插件目录无残留；商店安装复用同一入口，未单独实测 |
| [x] | CLI 显式清空 | `kabegame-cli plugin run --dry-run` | 传 `--var tag=` | 输出中 `tag` 为 `null`，不回落默认值 | danbooru `mode_tag_value=` / `quality=` / `start_page=` 均为 null |
| [x] | CLI checkbox | `kabegame-cli plugin run --dry-run` | 传 `--var kinds=a,b`，再传未知 variable | 合法输入展开为包含所有 variable 的 bool 对象；未知值立即报错 | `checks=q` 展开为 {p:false,q:true}；`checks=p,zzz` 报未知选项 |
| [x] | CLI options 严格匹配 | `kabegame-cli plugin run --dry-run` | 传合法 variable / 显示名 / 非法字符串 | 前两者转换成功，非法值立即报错；仅声明空 variable 时 `key=` 可选中它 | 显示名 X → "x"，`opt_empty=` 选中声明的 ""，非法值与 `crawl_mode=bogus` 报错 |
| [x] | 迁移插件空值实跑 | danbooru / pixiv / 任一 WebView 插件 | 可选字段全部留空，各跑一次最小任务 | 日志与请求中没有字面量 `"null"`，插件不因 null / undefined 崩溃 | 32 个插件全部迁移：无 `""` 选项的 options 一律 required，模式相关输入按 when 设为 required；修了 Number(null)=0 类问题（xhs max_items、pixai/kabegame-server/kemono 页码与数量、pixiv num_artworks、booru 系 end_page 兜底）与 URL 拼出 null 的问题（wallpapers-craft、wallspic）。全量打包 32/32，默认配置 dry-run 全部通过（3 个默认模式需填输入的插件补必填后通过，WebView 经 app）；V8 插件逐个真跑，日志与 URL 无字面量 null。weibo、xhs 推荐流需登录，anime-pictures 403、twodwallpapers 站点下线，失败与本次改动无关 |
| [x] | 默认配置不写 null boolean | dev app 导入插件 / CLI | 导入含无 default boolean 的插件后用 CLI dry-run | 生成的默认配置只写有 default 的键；v041 删除旧文件里值为 null 的 boolean 键，CLI 不再报「boolean 不能为 null」 | 实测发现后修复；单测覆盖迁移，生成器修复需重启 app 生效 |
| [x] | 插件字段随时可清空 | 收集弹窗 / 自动任务 / 插件详情 | 对有 default 与 `required: true` 的 string、date、options、path 字段点击清除 | 所有字段都显示清除按钮，清空后提交为 `null`；必填项为空时仍在启动任务时被拦截 | `PluginVar` 不再接收 `allowUnset`，统一允许清空 |
| [x] | 默认配置忽略必填 | 设置 → 插件 → 默认配置 | 选择含 `required: true` 字段的插件，留空必填项后保存 | 不显示必填星号，保存不被校验拦截，必填项以 `null` 写入 `default-configs/<id>.json` | dev app 用 nullprobe 实测：`must` 无星号、保存成功并写入 null；`PluginVarsForm` 以 `ignore-required` 取代 `allow-unset-all` |
| [x] | checkbox 数组 default | CLI `--via local` | wallhaven / haowallpaper / ziworld 默认配置 dry-run | 清单里 `default: ["a","b"]` 在定义解析期规范成完整 {variable: bool} 对象，不再被判「必须是对象」；运行期合并仍不做值转换 | 迁移中发现的宿主回归，已修并补单测；运行中的 dev app 需重启生效 |
| [x] | 推荐配置导入规范化 | 主应用 | 导入含 `""` / `[]` / checkbox 数组的推荐配置 | 只规范出现的键：空值转 null、checkbox 数组展开、声明的 `""` 选项保留，不补默认值；定时运行不再因旧式空值被拒 | vitest 覆盖；pixiv、wallhaven 推荐配置源文件同步清理 |

## 画廊文档按 dev 实机界面更新

通过 `kabegame-chromium` 连接正在运行的桌面 dev，逐项操作画廊后重写旧文档。查询部分从已移除的「过滤折叠按钮 + 七个维度」更新为当前的单行查询工具栏，补齐多范围搜索、五类快捷过滤、高级条件和常用项自定义；同步修正当前 / 全部计数、网页收集、随机排序、桌面每页数量设置入口、复制标签、三栏预览和工具箱动作语义。画廊总览、各查询弹层、右键菜单、预览、导入、整理、失败列表与空状态等截图均重新取自本次 dev 实机，并逐张目视检查。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | dev 实机连接 | 桌面 CEF / CDP | 用 `kabegame-chromium` 连接运行中的画廊并逐项打开交互 | 截图和说明来自当前实现，不沿用旧界面推断 | 已实测 |
| [x] | 查询工具栏 | 桌面 CEF | 检查搜索范围、时间 / 插件 / 类型 / 比例 / 大小、高级查询与常用项设置 | 文档中的入口、组合关系、清除行为和字段名称与界面一致 | 已实测 |
| [x] | 画廊操作 | 桌面 CEF | 检查收集菜单、排序、单选 / 多选菜单、预览、工具箱与维护对话框 | 文档移除失效入口，并补齐网页收集、复制标签、插件详情等现有能力 | 已实测 |
| [x] | 截图资源 | 文档资源 | 检查 19 张替换截图与 2 张新增截图 | 均为 2400×1536 PNG；内容清晰，查询截图使用安全的风景结果 | 已静态核对与目视检查 |
| [x] | Markdown 静态检查 | 仓库 | 检查文档引用、旧术语和 Git diff | 图片路径全部存在，不再引用过滤折叠、名称维度、壁纸维度和桌面每页数量旧截图 | 已静态核对 |
| [ ] | 文档站实际渲染 | Starlight 桌面与窄屏 | 打开 `/guide/gallery/` 检查长表格与截图布局 | 图片不溢出，表格和提示块在窄屏可读 | 待运行文档站后验证 |

## 快速上手带用户完成首次网络收集

快速上手不再假设 Kabegame 完全不带插件，也不再把设置壁纸作为首次体验的终点。新流程先在「开始收集 → 网络」中查找通常已内置的
「Kabegame 服务器」；只有找不到时才进入 GitHub 官方插件目录安装，并用实际商店截图标出对应插件。选择插件后不要求用户理解或修改
参数，直接使用在线 Demo、全站随机、跳过隐藏内容、每页 20 项、只跑第一页的默认值创建真实任务。默认参数表单、任务抽屉与任务结果
均使用实际截图，继续说明任务状态、画廊结果、标签与来源详情，形成可验证的首次网络收集闭环；完成提示改用轻快的祝贺语气，
鼓励用户继续探索标签和插件详情。桌面端还补充来源选择框旁的畅游快捷按钮：可以先打开插件网站测试基本连通性，也可以为需要账号的
来源完成登录，再由支持该能力的插件自动复用畅游保存的 Cookie。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 默认参数来源 | `kabegame-server/package.json` | 核对插件配置默认值 | 全站、在线 Demo、随机、排除隐藏项、每页 20、起止页均为 1，与教程一致 | 已静态核对 |
| [x] | 操作截图 | 文档资源 | 检查商店、默认参数、畅游快捷按钮、任务进度和任务结果五张 Desktop 截图 | 五个关键阶段清晰可辨，资源路径全部存在 | 已静态核对 |
| [x] | 畅游快捷入口 | 桌面端收集表单 | 对照按钮实现与畅游 Cookie 文档检查说明 | 明确按钮只打开插件网站，不会启动任务；连通性检查、账号登录和 Cookie 复用边界表述准确 | 已静态核对 |
| [x] | 首次收集路径 | 快速上手 | 顺序检查插件确认、默认参数、任务进度和结果验收 | 用户选择插件后无需改参数即可完成第一批图片的网络收集 | 已静态核对 |
| [ ] | 文档站实际渲染 | Starlight 桌面与窄屏 | 打开 `/guide/quickstart/` 并检查提示块与五张截图 | 图片不溢出，提示块在窄屏可读 | 待运行文档站后验证 |

## 中文 README 产品入口重构

中文 `README.md` 从作者叙事型首页改为面向用户与插件贡献者的产品入口：定位调整为插件驱动的图片与视频收集、归档工具，
前置下载、在线体验、快速上手、插件目录与插件开发五个行动入口；截图收敛为直接证明差异化能力的六张功能界面。
首要亮点明确展示标签自动归类、本地文件夹持续同步、畅游 Cookie 自动保存与安全复用、真实 WebView 驱动收集、
JavaScript / TypeScript 脚本扩展与来源元数据保留；脚本扩展说明同时覆盖配置表单、标签分类、元数据、详情视图和 `.kgpg` 分享能力。
壁纸设置降为桌面端附加能力。功能说明按用户任务重组，并新增四步快速开始、插件生态、参与项目和合规提醒；
安装步骤、平台限制、技术亮点、许可证与名称由来继续保留。
功能截图覆盖标签归类、文件夹同步、Cookie 复用和来源元数据各一张，WebView 收集用图片结果与任务日志两张并排展示；
图片实际编码为 JPEG，因此资源统一使用 `.jpg` 扩展名。旧的画廊、预览、画册和插件列表截图组已移除，避免重复展示通用界面。
日文、韩文和英文 README 随后按同一结构同步翻译：三份译文与中文版逐行同构，标题行号、HTML 骨架、代码块与全部链接一致，
各语言标题按母语改写（`核心亮点` / `Highlights` / `主なハイライト` / `핵심 하이라이트` 等）。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 首屏转化路径 | GitHub Markdown | 从标题向下检查定位、行动链接与首组截图 | 无需越过长篇背景即可理解产品，并可直接下载、体验、上手或进入插件开发 | 已静态核对 |
| [x] | 本地资源链接 | 仓库 | 检查 README 中 6 张截图、3 个源码入口与 LICENSE | 所有相对路径均存在 | 已静态核对 |
| [x] | 亮点截图 | README 源码 | 检查核心亮点后的图片与说明 | 标签归类、文件夹同步、Cookie 复用、来源元数据各有一张实图；WebView 的收集结果与任务日志两张并排展示 | 已静态核对 |
| [x] | 脚本扩展入口 | README 源码 | 检查核心亮点与插件生态的衔接 | 首屏说明可用 JavaScript / TypeScript 添加来源，无需修改或重新编译主程序，并可将完整插件打包分享 | 已静态核对 |
| [x] | 内容范围 | Git diff | 核对本轮文件列表 | 中文 README、功能截图与强制回归记录发生变化；三份译文随后按同一结构同步 | 已核对 |
| [x] | 译文结构同构 | 仓库文档 | 比对四份 README 的行数与 `##` 标题行号 | 均为 181 行，10 个二级标题逐一对齐（35 / 80 / 90 / 99 / 111 / 123 / 154 / 165 / 175 / 179） | 已静态核对 |
| [x] | 译文链接与代码块 | 仓库文档 | 比对全部 `src` / `href`、Markdown 链接目标与三段 `bash` 代码块 | 与中文源文件完全一致；Markdown 链接目标仅语言切换行不同（新版 README 已无内部锚点链接） | 已静态核对 |
| [x] | 译文内容完整 | 仓库文档 | 逐节核对核心亮点、从收集到归档、快速开始、核心能力表、插件生态、下载与平台、参与项目、技术亮点、License 与名称由来 | 各节均完整翻译，无漏段；除语言切换器与名称由来的「壁亀 / 壁紙」外无残留 CJK | 已静态核对 |
| [ ] | GitHub 实际渲染 | GitHub 仓库首页 | 推送后分别用桌面与窄屏打开仓库首页 | 表格、徽章、截图和行动入口无溢出或错位 | 待推送后验证 |

## 画廊工具栏计数成对刷新

`GalleryToolbar` 现在接收当前 `filter`，在首次进入、过滤变化和 `images-change` 后并行读取过滤后数量与无过滤总数；
两条查询全部完成后才整体提交“数量 / 总数”显示快照。`ImageGrid.totalCount` 只作为首次加载或查询失败时的降级值，
分页器原有的独立 live count 不变。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 成对提交自动化 | 前端 Vitest | 让过滤 count 与总 count 以相反顺序先后返回 | 任一单条请求完成时仍显示上一份完整快照；两条都完成后一次切到新值 | 全量 30 个文件、255 个用例通过 |
| [x] | 前端类型检查 | 本机 | `.claude/skills/check-kabegame/driver.sh --skip cargo` | `vue-tsc` 0 error | 已实测 |
| [ ] | 下载时计数同步 | 桌面 CEF / Android / Web | 应用一个能排除部分图片的过滤，持续下载新图并观察画廊副标题 | “数量 / 总数”每次作为一对同时变化，不短暂出现新旧值混搭 | |
| [ ] | 隐藏上下文与过滤切换 | 桌面 CEF / Android / Web | 切换“隐藏已隐藏图片”、`no-album` 与普通 / 高级过滤 | 分子符合当前完整过滤；分母只保留 `hide` 上下文；过滤切换期间不显示上一过滤的分母组合 | |

## README 自包含安装步骤（已被重写取代）

本轮曾把中文 README 的“下载与安装”细化为逐平台包名与安装步骤，并把画廊真实组合过滤的 PathQL 示例写进“你可能感兴趣”，
三份译文也按该 196 行结构同步过一轮。随后中文 README 被整体重写为产品入口（见「中文 README 产品入口重构」），
安装章节改为“下载与平台”、PathQL 示例收进“技术亮点”一行，上述结构与译文同步均已作废，以重写后的 181 行版本为准。

## 新增 Safebooru 收集源插件

新增插件 `safebooru`（1.0.0，`src-crawler-plugins/plugins/safebooru/`）。帖子列表走站点匿名可用的 dapi JSON：
请求带 `fields=tag_info`，一页一个请求就拿到带分类的全量标签。同参数再取一次 XML，按 id 合并发布时间
（JSON 没有这个字段；XML 的 rating 是旧单字母，不采用）。有评论的帖子按 10 条一页翻详情页取评论
（dapi 评论接口的时间是假的）。id 范围模式用 `id:>=A id:<=B sort:id:asc`，每页 100 条，按 id 升序抓完闭区间，两端最多相差 5000
（站点不认 `id:A..B`，会当成普通标签）。标签名先解码 HTML 实体；label key 里字符集外的字符
编码成 `(u<码点>)`，保证 `:p` / `;p` 这类标签不会并进同一个画册。
站点（API 和网页都一样）只允许起始偏移 ≤ 200000：默认排序越过这一页时，改用 `id:<` 游标接续上一页末条，
或用 `limit=1` 每跳 200001 条跳转定位；其他排序越界时直接报错，并提示可用的排序。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | API 分页与网页一致 | 探针 | 对比 `limit=42&pid=页号-1` 与网页列表在全部 / 标签 / `sort:` 元标签下的 ID 序列 | 9 组页面逐条相同 | 已实测 |
| [x] | 标签模式 | dev CLI | `run-cli.sh safebooru` 标签 `hakurei_reimu,highres` 第 1 页、中质量 | 42/42 完成；入库 ID 集合与网页第 1 页相同；每张都有 metadata；1930 个标签挂上 1929 个 | 已实测 |
| [x] | 全部 + 高分排序 + 评论 | dev CLI | 全部模式 `sort:score:desc` 第 1、2 页 | 各 42/42；带评论帖的评论条数与 `comment_count` 一致（13 条跨两页取全） | 已实测 |
| [x] | 元标签 + 原图 | dev CLI | 标签 `scenery,width:>=1920,height:<=1200`、高质量 | 42/42；落盘为原始分辨率（如 1920x1080、2688x960） | 已实测 |
| [x] | 翻过 API 上限（接续） | dev CLI | 全部模式、默认排序、第 4762–4763 页 | 84/84；4762 页直接翻，4763 页接在 4762 页末条 `id:<7033073` 之后，入库集合与预期逐条相同 | 已实测 |
| [x] | 翻过 API 上限（跳转） | dev CLI | 全部模式、默认排序、第 20000–20001 页 | 84/84；5 次 `limit=1` 跳转定位，结果与独立实现的 Python 原型相同 | 已实测 |
| [x] | 其他排序越界报错 | dev CLI | 高分 / 随机排序翻第 4763 / 4800 页 | 任务 failed，错误提示上限、当前排序名，并建议改用「最新发布」或收窄标签 | 已实测 |
| [x] | 页码超出结果总数 | dev CLI | 标签 `hakurei_reimu`、默认排序、第 9000 页 | 第一次跳转就判定到底，任务 completed，0 下载 | 已实测 |
| [x] | id 范围与网页一致 | 探针 | 对比 `id:>=1 id:<=5000 sort:id:asc` 的 dapi 第 2 页与网页列表第 2 页 | 42 个 ID 逐条相同；已删除的帖子两边都不出现（1–5000 共 4543 张） | 已实测 |
| [x] | id 范围模式 | dev CLI | id 5000000–5000100、中质量 | 101/101，100 + 1 跨两页；入库 post_id 恰为该区间的 101 个，均有 metadata | 已实测 |
| [x] | id 范围含已删除帖 | dev CLI | id 1–150 | 121/121，与 `limit=0` 的 XML 总数一致，0 WARN | 已实测 |
| [x] | id 跨度超限 | dev CLI | id 1–5002 | 任务 failed，提示「id 范围最多相差 5000」，不发请求 | 已实测 |
| [x] | 详情模板 | render-desc | 用 post 1084336 的真实 metadata 渲染 `description.ejs` | 分组标签、Statistics、Options、评论区与源站详情页一致 | 已截图核对 |
| [ ] | 应用内预览 | 桌面 CEF | 在 dev app 跑一次后打开图片预览的「插件详情」面板 | 面板正常渲染，链接用外部浏览器打开 | |
| [ ] | 插件商店上架 | 插件仓库 | `generate-index` 后在商店里查看 | 出现 Safebooru，图标、推荐配置、README 正常 | |

## 新增 nekos.moe 收集源插件

新增插件 `nekos-moe`（0.1.0，`src-crawler-plugins/plugins/nekos-moe/`，V8）。数据走开源后端的
`POST /api/v1/images/search`：排序支持 newest / likes / oldest（`relevance` 不带 tags 时等同自然顺序，不提供），
NSFW 支持仅全年龄 / 仅 NSFW / 全部（全部时不传 `nsfw`），每页 1–50（超过 50 服务端会回落成 20）。
服务端 `skip` 上限 2500，越界的页码在发请求前截断或报 warn；站点现存 792 张（SFW 471 / NSFW 321），不会碰到上限。
搜索接口按 IP 限流，10 秒固定窗口 5 次：两次搜索至少间隔 2.1 秒，遇到 429 按 `retryAfter` 等待后最多重试 3 次。
搜索结果已带齐详情页信息，不请求详情接口；原图 `/image/<id>` 无需 Referer。画师挂 `nekos-moe/artist`，
其余标签挂 `nekos-moe/tag`；纯日文画师名编码成 `u-<码点>` 作 key，纯符号标签（如 `!`）跳过。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 全年龄 + 最新 + 小页 | dev CLI | `run-cli.sh nekos-moe` 最新、仅全年龄、每页 5、第 1–3 页 | 15/15；入库 ID 集合与接口 `limit=15` 相同；每张都有 metadata；718 个标签挂上 717 个（跳过 `!`） | 已实测，翻页未触发 429 |
| [x] | 仅 NSFW + 点赞 + 末页 | dev CLI | 最多点赞、仅 NSFW、每页 50、第 6–9 页 | 第 6 页 50 张、第 7 页 21 张后提前结束，共 71/71；集合与接口 skip 250/300 相同，全部 `nsfw=true` | 已实测 |
| [x] | skip 上限保护 | dev CLI | 每页 50、第 60–61 页 | 不发请求，WARN 提示最多 51 页，任务 completed | 已实测 |
| [x] | 原图 | dev CLI | 抽查落盘文件 | 与站点 `/image/<id>` 逐字节一致（缩略图为 322×420） | 已实测 |
| [x] | 详情模板 | render-desc | SFW `PnG9CS0Ea` 与 NSFW `TwfJgm7Xk` 渲染 `description.ejs` | Post Info / 点赞收藏 / Tags 与源站一致；NSFW 图标签为红色并带 NSFW 徽标 | 已截图核对 |
| [ ] | 应用内预览 | 桌面 CEF | 在 dev app 跑一次后打开图片预览的「插件详情」面板 | 面板正常渲染，链接用外部浏览器打开 | |
| [ ] | 插件商店上架 | 插件仓库 | `generate-index` 后在商店里查看 | 出现 nekos.moe，图标、README、更新日志正常 | |

## 新增 AIBooru 收集源插件

新增插件 `aibooru`（1.0.0，`src-crawler-plugins/plugins/aibooru/`）。AIBooru 是 Danbooru 的分支，专收 AI 生成图。
和 danbooru 插件解析 HTML 不同，这里全程走 JSON API：列表接口用 `only=` 把上传者、审核者、AI 生成参数、作者评论和评论
一次带回，每页一个请求拿齐详情页信息；标签帖数另查 `/tags.json`（`name_array` 按 URL 长度切块，任务内缓存）。
网页先分页再隐藏已删除作品，插件同样在分页后过滤，保证与网页同页一致。标签多一个 `model` 分类（分类号 6），
落到标签画册 `aibooru/model`。站点 R-18 占比高，分级过滤默认只抓全年龄；人气榜接口不收 tags，分级在插件里逐张筛。
日榜在美东零点刚过时为空，自动改抓前一天，时区偏移从站点最新作品的 `created_at` 读取。prompt / 负面词按逗号、
换行拆成短语写入元数据搜索（宿主拒收超过 1024 字符的条目）。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | API 分页与网页一致 | 探针 | 过滤已删除后，对比 JSON 与网页在周榜、日榜（指定日期）、标签（含 `rating:g`）、`limit=50` 下各两页的 ID 序列 | 8 组页面逐条相同 | 已实测 |
| [x] | 标签模式 | dev CLI | `1girl,scenery`、全年龄、每页 20、第 1 页 | 20/20 完成；入库 ID 与网页第 1 页逐条相同 | 已实测 |
| [x] | 人气榜 + 分级筛选 | dev CLI | 周榜第 1–2 页、全年龄 | 13/13；入库 ID 与接口同页全年龄作品逐条相同；434 个标签全部挂上，六个分类（含 model）都有 | 已实测 |
| [x] | 日榜零点兜底 | dev CLI | 美东 00:45 跑日榜、全年龄 | 当天为空时改抓 2026-10-14，符合条件 7 张，与网页该日同页全年龄数一致 | 首版按 UTC-5 粗算退到了前两天，已改为读站点时区偏移 |
| [x] | id 范围 | dev CLI | `64385..64400`、全年龄 | 2/2，与 `/counts/posts.json` 一致 | 已实测 |
| [x] | 全部 + 中画质 + 视频 | dev CLI | 全部模式、全年龄、每页 20、中质量 | 20/20；含 mp4 视频帖 | 其中一个 AV1 视频生成预览失败（`[av1] Get current frame error`），宿主按「无预览」入库，属 FFmpeg 解码能力问题，非插件问题 |
| [x] | 标签超限 | dev CLI | 填 5 个普通标签 | 任务 failed，提示最多 4 个（`rating:` / `status:` / `id:` 不计入） | 已实测 |
| [x] | 元数据搜索片段 | dev CLI + 查库 | 查 post 64393 的 `metadata_search_terms` | 153 条、最长 31 字符；含 prompt 短语、采样器、模型名；超长 WARN 消失 | 已实测 |
| [x] | 详情模板 | render-desc | 用 post 64393 的真实 metadata 渲染 `description.ejs`，切换两个页签 | 分组标签及帖数、Information、Original Commentary / AI Metadata（行序同源站）、评论区与用户等级配色与源站一致 | 已截图核对 |
| [ ] | 应用内预览 | 桌面 CEF | 在 dev app 跑一次后打开图片预览的「插件详情」面板，点击两个页签 | 面板正常渲染，页签可切换，链接用外部浏览器打开 | |
| [ ] | 画廊插件扩展筛选 | 桌面 CEF | 在画廊插件扩展里按分数 / 收藏 / 分级筛 aibooru 图片 | 分组计数与筛选结果一致 | |
| [ ] | 插件商店上架 | 插件仓库 | `generate-index` 后在商店里查看 | 出现 AIBooru，图标、推荐配置、README 正常 | |

## Pixiv 插件新增「第三方 API」模式（Lolicon）

`pixiv` 插件升到 1.5.0，源码按模式拆成 `src/modes/`：`ranking` / `bookmark` / `user` / `keyword` 原样搬出，
共用的请求头、登录态与进度放进 `src/common.ts`，单作品的详情、标签、metadata 与全部分页下载放进 `src/illust.ts`。
新增爬取类型 `third_party`：`src/modes/third-party/` 里每个适配器只产出 pixiv 作品 id，约定为
`fetchPage(vars, cursor) → { ids, next }`，`next` 为 `null` 即结束，执行器统一处理翻页、按作品去重与进度，
下载仍走 `downloadIllust`。首个适配器 `lolicon` 不分页，请求一次即结束；参数为 `lolicon_r18`、
`lolicon_tags`、`lolicon_uids`、`lolicon_count`（1～20）、`lolicon_orientation`（不限 / 横图 / 竖图）、
`lolicon_exclude_ai`、`lolicon_date_after` / `lolicon_date_before`（JST 整日，含当天），图片固定为 pixiv 原图。
lolicon 见到任何 `Referer` / `Origin` 都返回 403，所以请求期间由 `togglePixivHeaders(false)` 置空这两个头和
`Cookie`（也避免把 pixiv 登录态发给第三方），结束后恢复并按需重新注入 Cookie。lolicon 的全年龄分类会混入
pixiv 标为 R-18 的作品，全年龄模式在本地按 `R-18` / `R-18G` 标签再排除。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 横图 + 排除 AI | debug CLI | `run-cli.sh pixiv` 设 `source=third_party`、`lolicon_orientation=landscape`、`lolicon_count=3` | 请求带 `aspectRatio=gt1&excludeAI=true`；下载 `i.pximg.net` 原图且为横图；metadata 完整、标签入库 | 3 个结果中 1 个带 R-18 标签被跳过，2 个作品下载成功（4500×4300、3456×2110），各挂 10～11 个标签 |
| [x] | 标签 OR + 日期区间 | debug CLI | `lolicon_tags=原神\|鸣潮`、`lolicon_date_after=2026-10-01`、`lolicon_date_before=2026-10-14` | `dateAfter` / `dateBefore` 为 JST 当日 0 点与次日 0 点前 1ms；多页作品下载全部页 | 已实测：1 个作品 3 页全部落盘 |
| [x] | R18 无登录态 | debug CLI | `lolicon_r18=r18`，畅游无 pixiv Cookie | 任务失败并提示先在畅游登录 pixiv | 已实测 |
| [x] | 旧模式回归 | debug CLI | 排行榜 `daily`、`num_artworks=1` | 与拆分前行为一致 | 已实测：1 个作品 8 页全部下载 |
| [ ] | 表单显隐 | 桌面 CEF | 收集弹窗选 pixiv →「第三方 API」→ Lolicon | 只显示 lolicon 参数；切回其它类型后 lolicon 参数隐藏且不提交；推荐配置「Lolicon 随机横图」能一键回填 | |
| [ ] | R18 登录态不外泄 | 桌面 CEF | 畅游登录 pixiv 后以 `lolicon_r18=all` 运行 | lolicon 请求成功（未被 403），R18 作品详情与原图能正常下载 | |

## 文档站新增「插件开发更新日志」

插件开发一节新增「更新日志」页（`/dev/changelog/`），从文档基线 4.3.0 起按版本列出插件作者可见的接口、
清单字段与行为变化，并给出各能力首次可用版本的速查表，用来确定 `engines.kabegame`。各版本的首次可用版本
均用 `git grep` 在 v4.3.0 / v4.4.0 / v4.5.0 / v4.5.1 tag 上对源码逐项核对过。`kabegame-plugin` skill 第 4 步
改为按这张速查表取最高版本来写 `engines.kabegame`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [ ] | 侧栏与链接 | 文档站 dev server | 打开「插件开发 → 更新日志」，逐个点击页内锚点链接，以及开发总览、打包与发布、插件清单字段三处新增的入口链接 | 侧栏出现该页；所有链接跳到正确标题，无 404 | |
| [x] | 版本核对 | 仓库源码 | 对照各版本 tag 的 `prelude.js`、`ops.rs`、`bootstrap.js` 与 `plugin/mod.rs` 核对速查表 | 每项首次可用版本与 tag 上首次出现一致 | 已静态核对 |

## 文档站「打包与发布」改为面向仓库外的插件作者

「打包与发布」与「插件开发总览」不再假设作者在 Kabegame 源码仓库里工作：先从 GitHub Releases 最新版下载
`kabegame-cli`，再用 `plugin new` → `npm run build` → `plugin pack` → `plugin run` → `plugin import` 走完整流程；
自建源改为直接给出 `index.json` 字段表（必填 `id` / `name` / `version` / `downloadUrl`）和 sha256 计算方法。
插件 ID 说明改为「`--id` → `package.json` 的 `name` → 文件名」，删除「目录名就是 ID」的旧说法。CLI 参考页的
Release 资产名改为实际的 `kabegame-cli-standard_<版本>_<os>_<arch>`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 仓库外完整流程 | release CLI 4.5.1，scratchpad 目录 | `plugin new` 后把 devDependencies 改成 `github:kabegame/kabegame-types`，构建、`plugin pack`、`plugin run --dry-run` | 构建成功，打包产出 `.kgpg`，试跑识别为 `demo-plugin-test v0.1.0` | 已实测；npm registry 当时网络不通，rspack 借用本地已装版本，类型包确认可从 GitHub 安装 |
| [x] | 文档链接 | 文档站构建产物 | 校验打包与发布、总览、plugin-sdk、CLI、WebView 页的站内锚点 | 全部指向存在的标题 | 已静态核对 |
| [x] | Release 资产名 | GitHub Releases | 对照最新 Release 的 Assets 列表 | 与文档表格的三个文件名一致 | 已核对 v4.5.1 |

## 新增微博收集源插件

新增插件 `weibo`（0.1.0，`src-crawler-plugins/plugins/weibo/`，V8）。全部模式依赖畅游里 `weibo.com` 的登录态
（`requireCookie("weibo.com")`；未登录时时间线 403、m 站 432、搜索跳登录页，所以不走访客 Cookie，也不用 m 站）。
五种模式各自产出微博，统一交给 `processPost`：用户相册走 `ajax/profile/getImageWall`（`since_id` 游标，按 mid 分组后逐条
`statuses/show`），用户微博走 `ajax/statuses/mymblog`（`feature` 0/1/2 = 全部/原创/图片，转发可选收原帖），超话走
`ajax_proxy/chaohua/page`（必须带 `X-Requested-With`，翻页参数在 `moreInfo.params`；超话 id = `100808` + md5(超话名)，
标签频道按标题从 `channelInfo.channels` 查 flowId），关键词搜索只从 `s.weibo.com` HTML 抽 mid 再逐条 `statuses/show`
（最多 50 页），单条模式接受 weibo.com / m.weibo.cn 各种链接与 mblogid / mid。超话 feed 是精简结构（无 `text_raw`
/ `topic_struct`），有图时补拉一次 `statuses/show`。图片取 `pic_infos` 的 `largest`，`wx1`～`wx4` 统一到 `wx1` 让 URL 去重命中；
下载带 `Referer: https://weibo.com/`。评论走 `buildComments`（`max_id` 游标），带楼中楼预览；评论配图在评论 `url_struct`
的「查看图片」卡片里，只认 `pic_num > 0` 的评论。详情模板的头像与评论缩略图经 `__bridge.fetch` 带 Referer 拉取
（sinaimg 对带 `Sec-Fetch` 头的跨站图片请求返回 403）。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 单条微博 + GIF | release CLI（经 IPC 交给 prod app） | `mode=single` 填 `https://weibo.com/6593199887/RmLmsDzd7` | 3 张 GIF + 1 张 JPG 原图落盘（750x2213 等），共用 1 条 metadata；挂上作者 / 超话 / 话题 3 类标签 | 已实测 |
| [x] | 单条 LivePhoto | release CLI | `mode=single` 填 `https://m.weibo.cn/status/RmNeGwSt1` | 6 张静图 + 6 段 `(live)` mp4 | 已实测 |
| [x] | 单条转发链接 | release CLI | `mode=single` 填一条转发 | 收原帖的图 | 已实测 |
| [x] | 用户相册 | release CLI | 用户分别填昵称 `原神`、主页链接 | 按图片墙顺序收带图微博，同帖多图一起入库 | 已实测 |
| [x] | 用户微博 + 转发 | release CLI | `timeline_filter=all`、`include_retweets=true` | 转发微博收原帖图片，同一原帖只处理一次 | 已实测 |
| [x] | 超话精华 / 最新 / 标签频道 | release CLI | 超话填 `原神超话`、超话链接；频道精华、最新发帖、标签频道「同人」 | 三种频道都能翻页入库；补拉详情后正文、话题、IP 属地齐全 | 已实测 |
| [x] | 超话频道名错误 | release CLI | 标签频道填「不存在」 | 任务 failed，错误列出该超话全部频道名 | 已实测 |
| [x] | 关键词搜索 | release CLI | `原神同人` + 热门 + 只看原创 + 2026-09-01～09-30；`#原神同人#` | 入库微博的发布时间都在区间内；话题搜索正常 | 已实测 |
| [x] | 用户不存在 | release CLI | 用户填随机昵称 | 任务 failed，提示找不到该用户 | 已实测 |
| [x] | 评论与评论配图 | release CLI | `mode=single` 填 `RkZDM6Dny`、`max_comments=40` | 4 条一级评论 + 4 条楼中楼，与帖子评论数 8 一致；3 楼配图以 `[comment_3]` 原图（1206x1155）下载 | 已实测 |
| [x] | 详情模板 | render-desc | 用 `RkZDM6Dny` 的真实 metadata 渲染 | 作者、时间 / 来源 / 属地、正文话题着色、超话与话题标签、互动数、评论与楼中楼排版正常 | 已截图核对；离线渲染没有 `__bridge`，头像与评论缩略图显示为占位 |
| [ ] | 应用内预览 | 桌面 CEF | 在 app 打开一张微博图片预览的「插件详情」面板 | 头像与评论配图缩略图经 `__bridge` 正常显示，链接用外部浏览器打开 | |
| [ ] | 登录过期 | 桌面 CEF | 在畅游退出微博登录后运行任意模式 | 任务 failed，提示去畅游重新登录 weibo.com | |
| [ ] | 插件商店上架 | 插件仓库 | `generate-index` 后在商店里查看 | 出现微博，图标、README、更新日志正常 | |

## 新增 X（Twitter）媒体收集源插件（画师媒体 / 搜索 / 单条推文 / 书签 / 点赞）

新增插件 `x-webview`（0.1.0，`src-crawler-plugins/plugins/x-webview/`，WebView）。不自己调 GraphQL（请求要带页面 JS 算的
`x-client-transaction-id`，queryId 也会轮换）：`crawl.js` 顶层在 document-start 同步 hook `XMLHttpRequest.prototype.open`，
截获页面滚动时自己发出的时间线响应，思路参考 prinsss/twitter-web-exporter。2026-10 实测旧 `UserMedia` 已退役，主页「媒体」标签
带「图片 / 视频」下拉：`/<user>/media?filter=photo` → `UserPhotoTimeline`（首屏 `profile-photo-grid-0` 模块，后续页
`TimelineAddToModule`），`?filter=video` → `UserVideoTimeline`（普通 `tweet-*` 条目），一页 20 条，返回 0 条推文即到底。
「全部」模式在同一页里用下拉从图片切到视频，不整页导航（导航会让在途的 CEF 原生下载丢失认领）。图片取
`pbs.twimg.com/media/<id>?format=<原扩展名>&name=orig`（无需 Cookie / Referer），视频取码率最高的 mp4。
`UserByScreenName` 的 `legacy` 在 2026-07 起被拿掉，媒体推文数改读 `tweet_counts.media_tweets`。增量水位线按
`<userId>:<photo|video>` 存在 `pluginData`，只有翻到旧水位 / 末尾 / 最旧时间才推进；推文 id 是 snowflake，时间由 id 推算。
同一推文的多张图共用一条 metadata（`createImageMetadata` + `searchTexts`）；画师按 rest_id、话题按 ASCII 小写或
`u-<码点>` 挂成 `x-webview/artist`、`x-webview/hashtag` 标签。展示名按字形截断：按 UTF-16 截断会切出孤立代理项，
带它的 `name` 经 IPC 传给宿主后 `downloadImage` 永不返回，任务挂在 `exit()`。

评论（参照小黑盒插件）：有回复的推文在同一页里用 `history.pushState` + `popstate` 做 SPA 跳转打开详情（文档不重载，
在途下载不受影响），截获 `TweetDetail`，按 `conversationthread-*` 模块取回复（含楼中楼、作者标记、被回复者、父回复 id），
还有 Bottom 游标就滚动加载直到 `max_comments`（默认 50，0 不开详情页）。回复快照写进同一条 metadata 的 `comments`，
回复者名字和正文进 `searchTexts`，模板在推文卡片下渲染回复区；`fetch_comment_images`（默认关）把回复配图共用 metadata_id
下载、不挂标签。X 折叠的「可能是垃圾信息」回复不取。实测直接推 `/<user>/status/<id>` 连续几条后 X 只用缓存渲染焦点推文、
不再发 `TweetDetail`，改推 `/i/web/status/<id>`（X 自己重定向到规范路径）后每次都会请求；没等到再退回规范路径一次。

搜索模式（`mode=search`）：打开 `x.com/search?q=…`，同样截获页面自己的 `SearchTimeline`。「最新」走 `f=live`
（product=Latest，普通 `tweet-*` 条目，一页 20 条，严格按时间倒序，水位线 key 为 `search:<媒体类型>:<搜索词哈希>`）；
「热门」走 `f=media`（product=Media，`search-grid-0` 网格，首屏约 40 条，按热度排、顺序不单调，所以不用水位线，
最旧时间只过滤不提前停）。搜索词没写 `filter:media|images|videos` 时按「媒体类型」补上；推广推文跳过；结果多挂一个
`x-webview/search` 标签（key 为搜索词哈希，名字为原文）。实测搜索页偶尔滚到底也不发下一页请求，空等时改为先上退
4000px 再把最后一个 `cellInnerDiv` 滚进视口，原先只上抖 800px 时会在 40/53 条处以「连续无响应」结束。

单条推文（`mode=tweet`）：配置填一条推文链接或 id，整页打开 `x.com/i/web/status/<id>`，加载即请求 `TweetDetail`，
焦点推文与回复一次取到（`fetchConversation` 改为按 id 调用，`navigate=false` 时从页面首个响应读起）。
书签（`mode=bookmarks`）打开 `/i/bookmarks` 截获 `Bookmarks`（`data.bookmark_timeline_v2`）；点赞（`mode=likes`）只能看自己的，
先进首页取当前账号用户名（侧栏个人资料链接 → `__INITIAL_STATE__` → SPA 跳 `/i/user/<twid 里的 id>` 等 X 换成 `/<用户名>`；
隐藏的爬虫窗口是窄屏布局、没有侧栏链接），再 SPA 跳到 `/<用户名>/likes` 截获 `Likes`。两者按收藏 / 点赞时间排而不是推文 id，
水位线改存上次最前面 5 条的 id（`<mode>:<twid>:<媒体类型>`），遇到其中任一条即停，最旧时间只过滤；会混入纯文字推文，
`collectTimeline` 统一跳过没有所选媒体类型的推文、不计入上限。结果多挂 `x-webview/collection` 标签（「X 书签」/「X 点赞」）。

同时修正文档：WebView 后端自 4.4.0 起就有 `createImageMetadata`，4.5.1 起支持 `searchTexts`（`dev/webview-api.mdx`
原说「没有」、`dev/changelog.mdx` 速查表原说「WebView 只有 downloadImage」）。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 时间线截获 | release CLI（经 IPC 交给 prod app） | 探针版打开 `karokaro6665/media`，切换下拉 | 截获到 `UserVideoTimeline` 与 `UserPhotoTimeline`，结构与上文一致 | 已实测 |
| [x] | 原图可直拉 | 探针 | `probe.ts media` 拉 `name=orig` | jpeg，尺寸等于 `original_info`（2176x1216）；`format=png` 对 jpg 原图 404 | 已实测 |
| [x] | 全量翻页 | release CLI | `media_type=all`、不限条数 | 图片 20+20+14 = 54 条、视频 1 条，合计等于 `media_tweets` 55；三页翻完判定到底 | 已实测 |
| [x] | 「全部」切换不丢下载 | release CLI | 上一轮整页导航时失败的 5 张恰在图片时间线末尾，改为下拉切换后重跑 | 5 张全部下载成功，0 失败，视频在同一页面里加载 | 已实测；整页导航时这 5 张以 `webview destroyed` 失败 |
| [x] | 增量 | release CLI | 全量写入水位线后，开增量再跑 | 两条时间线各读首屏即「遇到上次抓过的推文」停止，0 下载 | 已实测 |
| [x] | 推文数上限 | release CLI | `media_type=all`、`max_tweets=3` | 图片时间线处理 3 条后停止，不再切到视频 | 已实测 |
| [ ] | 上限不推进水位线 | release CLI | 新画师开增量、`max_tweets=3` 跑一次，再不限条数跑一次 | 第一次不写水位线；第二次从最新翻到底，不漏第 4 条以后的推文 | |
| [x] | 含 emoji 的展示名 | release CLI | 第 7 条推文正文第 40 个码元落在 emoji 中间 | 按字形截断后正常入库；旧写法该次 `downloadImage` 永不返回 | 已实测 |
| [x] | metadata 与标签 | release CLI | 查库 | 58 张图全有 metadata（55 条推文 55 条）；源数据 2 个话题全部挂上，画师标签 58 张 | 已实测 |
| [x] | 视频 | release CLI | 视频时间线 | 1080x1584 最高码率 mp4 入库 | 已实测 |
| [x] | 详情模板 | render-desc | 用带话题的单图推文与 4 图推文的真实 metadata 渲染 | 头像、名字、正文话题着色、时间 / 浏览数 / 图数、互动数、话题胶囊、画师简介正常 | 已截图核对 |
| [ ] | 未登录 | 桌面 CEF | 在畅游退出 x.com 后运行 | 弹出爬虫窗口并提示登录，登录后自动继续；3 分钟未登录则结束 | |
| [ ] | 敏感内容 | 桌面 CEF | 对开启 / 未开启「显示敏感媒体」的账号各跑一次 R-18 画师 | 开启时敏感推文正常收集，`possiblySensitive` 为 true 且模板显示「敏感内容」 | |
| [ ] | 限流 | 桌面 CEF | 连续翻大量推文直到 429 | 日志提示被限流并停止，不推进水位线 | |
| [ ] | 应用内预览 | 桌面 CEF | 打开图片预览的「插件详情」面板 | 面板正常渲染，链接用外部浏览器打开 | |
| [ ] | 插件商店上架 | 插件仓库 | `generate-index` 后在商店里查看 | 出现 X 画师媒体，图标、README 正常 | |
| [x] | 保存评论 | release CLI | `max_tweets=10`、`max_comments=50` | 10 条推文 8 条有回复，详情全部取到、无「回复没取到」警告；楼中楼父子关系、作者标记正确；约 59 秒跑完 | 已实测，查 metadata `comments` |
| [x] | 详情不再丢请求 | release CLI | 之前推规范路径时取不到回复的几条推文改走 `/i/web/status/<id>` | 每条都等到 `TweetDetail` | 已实测 |
| [x] | 评论模板 | render-desc | 用带 5 条回复（含作者楼中楼）的真实 metadata 渲染 | 回复区头部计数、作者徽章、「回复 @x」、缩进、点赞数正常 | 已截图核对 |
| [ ] | 垃圾回复折叠 | release CLI | 推文回复数 6、已保存 1 的那条 | 折叠在「显示可能是垃圾信息的回复」里的回复不保存，模板显示已保存数 | 已知现象，未单独核对页面 |
| [ ] | 评论区图片 | release CLI | 对评论带图的推文开 `fetch_comment_images` | 回复配图入库，与原推文共用 metadata，不挂画师 / 话题标签，展示名带「@用户 的回复」 | 本轮样本评论无配图，未覆盖 |
| [x] | 搜索最新全量 | release CLI | `query=from:karokaro6665`、最新、不限条数、增量 | 20+20+13 = 53 条，第 4 页 0 条判定到底并写水位线；媒体与画师模式完全重合（56 个文件全去重） | 已实测 |
| [x] | 搜索翻页不卡住 | release CLI | 同上，改滚动兜底前后对比 | 改前在 40 条处「连续 3 次滚动都没有新响应」；改后翻到第 3 页 | 已实测；偶发，多跑几次更稳 |
| [x] | 搜索增量 | release CLI | 写入水位线后再跑 | 首屏即「遇到上次抓过的推文」，0 下载 | 已实测 |
| [x] | 话题搜索热门 | release CLI | `#ブルアカ min_faves:1000`、热门、仅图片、上限 8、评论 20 | 首屏网格 40 条，取 8 条下载；提示热门不使用增量；7 条打开详情共 39 条回复 | 已实测 |
| [x] | 话题搜索最新 | release CLI | 同上改最新 | 8 张新图、49 条回复，0 警告 | 已实测 |
| [x] | 搜索词标签 | release CLI | 查库 | `x-webview/search/q-<哈希>` 名为搜索词原文，两次话题搜索 16 张、`from:` 搜索 56 张（去重的图也挂上） | 已实测 |
| [ ] | 搜索模式表单 | 桌面 CEF | 在收集弹窗里切换模式 | 画师模式只显示「画师」，搜索模式显示「搜索词」「排序」；搜索词留空运行时提示并结束 | |
| [x] | 视频搜索 | release CLI | `#ブルアカ min_faves:500`、`media_type=video`、上限 3 | 搜索词补 `filter:videos`，3 个最高码率 mp4 入库（1080x1920 / 1280x720 / 1920x1080） | 已实测 |
| [ ] | 搜索首屏无响应重载 | release CLI | 短时间内连续跑多次搜索 | 25 秒没等到 `SearchTimeline` 时重载页面重试一次；仍没有则警告里带页面请求与页面文字后结束 | 实测连跑后出现过两次空等、约 1 分钟后恢复；重载兜底尚未在空等现场验证 |
| [x] | 单条推文 | release CLI | `mode=tweet`，填带 `/photo/1` 尾巴的推文链接 | 识别出 id，图片入库（已有则去重），保存 5 条回复 | 已实测 |
| [x] | 书签 | release CLI | `mode=bookmarks`、增量、评论 0 | 账号全部 4 条书签推文 7 张图入库，到底后写入 4 个 id 的水位线 | 已实测 |
| [x] | 书签增量 | release CLI | 写入水位线后再跑 | 首屏即「遇到上次抓过的推文」，0 下载 | 已实测 |
| [x] | 点赞 | release CLI | `mode=likes`、上限 5、评论 0 | 侧栏链接缺失时兜底取到 `@cmtheit`，首屏 20 条取 5 条带图推文；因上限停止不写水位线 | 已实测；首版只找侧栏链接时报「找不到主页链接」 |
| [x] | 来源标签 | release CLI | 查库 | 「X 书签」7 张、「X 点赞」5 张（去重的图也挂上） | 已实测 |
| [ ] | 点赞增量 | release CLI | 不限条数开增量跑到底，再跑一次 | 第二次首屏遇到上次前 5 条之一即停；取消其中一条点赞后仍能停 | |
| [ ] | 推文无效 | release CLI | 填已删除推文或非推文链接 | 提示无法识别或「推文不存在、已删除或当前账号看不到」后结束 | |
| [ ] | 新模式表单 | 桌面 CEF | 收集弹窗切到单条推文 | 只显示「推文」「媒体类型」与评论两项，不显示上限 / 最旧时间 / 增量 | |
| [ ] | 关闭评论 | release CLI | `max_comments=0` | 不打开任何详情页，metadata `comments` 为空数组，模板不显示回复区 | |
| [ ] | 长评论区滚动 | release CLI | 回复数超过 50 的推文 | 滚动加载到 50 条即停，`commentsMax` 为 50 | |

## Kabegame 服务器插件适配 4.5.1 PathQL 续接语法

4.5.1 起画廊续接段改名为 `_kb_fc` / `_kb_desc` / `_kb_x<N>x`，旧写法不再识别，插件仍拼 `…/x20x/1`，连 4.5.1+ 服务器时每页都报 `path not found`。插件 0.2.1 运行前先各取一张图探测服务器方言，全站排序段与分页尾按探测结果拼；过滤模式两种分页尾都剥，原样路径解析失败时再把组合 / 倒序段改写成服务器方言重试。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 全站随机 | debug CLI → demo（4.5.1+） | 默认配置，`page_size=3` | 识别为 `_kb_*` 语法，路径 `gallery/hide/sort/random-<种子>/_kb_x3x/1`，3 张下载成功 | 已实测 |
| [x] | 全站时间倒序 | debug CLI → demo | `sort=time` | 路径为 `sort/by-time/_kb_desc`，最新的 2 张入库 | 已实测 |
| [x] | 过滤模式粘贴旧写法 | debug CLI → demo | `pathql=…/pixiv/filter_comb/sort/by-time/desc/x100x/3` | 剥掉分页尾，改写成 `_kb_fc` / `_kb_desc` 后解析成功，总数 788 | 已实测 |
| [ ] | 连旧版服务器 | debug CLI → 4.5.0 及以前的桌面 Web 服务器 | 全站 + 过滤（粘贴新写法路径）各跑一次 | 识别为旧版语法，分页用 `x<N>x/<页>`，过滤路径的 `_kb_*` 段改回裸段名 | 手边没有旧版服务器，未覆盖 |
| [ ] | 插件商店上架 | 插件仓库 | `generate-index` 后在商店里查看 | kabegame-server 显示 0.2.1 | |

## 插件选择下拉框按 ID 搜索（`apps/kabegame/src/components/PluginPickerField.vue`）

桌面端 `el-select` 改用 `filter-method`：输入词不区分大小写，命中显示名或插件 ID 的选项保留；「全部」等前置项只按显示名匹配。Android 选择弹窗不受影响。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 按 ID 搜索 | 桌面 CEF | 收集弹窗的插件下拉中输入 `bluedafeiyu`、`BLUEDAFEIYU`、`pixiv` | 分别只剩「蓝色大肥鱼 AI 娘档案」「Pixiv」，显示名不含 ID 的插件也能搜到；输入无关词 `xyzzy` 结果为空 | 已实测（CDP 写入输入框并派发 input 事件） |
| [x] | 按名称搜索 | 桌面 CEF | 输入「蓝色」 | 只剩「蓝色大肥鱼 AI 娘档案」，与改动前一致 | 已实测 |
| [x] | 重新展开重置 | 桌面 CEF | 按 ID 搜索后选中蓝色大肥鱼，再次展开下拉 | 32 个选项全部恢复，输入框与选中行显示「蓝色大肥鱼 AI 娘档案」 | 已实测 |
| [x] | 前置项 | 桌面 CEF | 自动任务页插件过滤下拉输入「全部」 | 「全部插件(0)」行保留，计数正常 | 已实测；当前没有自动任务配置，只有这一行 |

## 插件页商店 tab 导航参数与商店列表 store 化（`apps/kabegame/src/stores/pluginMarket.ts`）

插件页当前 tab 改为 settings query 键 `pluginBrowserTab`（`?tab=store:<sourceId>`，已安装 tab 不写参数），切 tab 用 `replace`，从插件详情 `router.back()` 回来即恢复。商店源列表、各源插件列表、远程图标下沉到 `usePluginMarketStore`：按需加载、跨路由保存、`plugin-sources-changed` 事件被动刷新；`installedVersion` 读取时按已安装列表现算，删掉导入后的重拉。后端 storage 层源增 / 改 / 删后广播 `plugin-sources-changed`。顺带修复源管理弹窗「删除」只移除本地数组、不调后端的问题。回归中发现并修复：store 加载结束时删除 loading key 而非置 false，骨架屏 300ms 定时器未被清掉，导致列表加载完后骨架屏常驻。

回归方式：dev 桌面 CEF + `kabegame-chromium` 驱动 UI，前端临时 `sendDebugEvent` 插桩（session `plugin-tab-regress`）记录每次 `get_plugin_sources` / `get_store_plugins`（区分强制刷新与后台检查）/ `get_remote_plugin_icon` 请求、`plugin-sources-changed` 事件、挂载与 tab 变化，验证后已删除插桩。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 切到商店 tab | 桌面 CEF | 重载 `/plugins` 后点官方源 tab | URL 为 `/plugins?tab=store:official_github_release`，30 张卡片，骨架屏不残留 | 已实测；首测发现骨架屏常驻，修复后复测通过 |
| [x] | 详情返回保留 tab | 桌面 CEF | 点 aibooru 卡片进详情，`history.back()` | 重挂载直接读回官方源 tab；无 `get_plugin_sources` / `get_store_plugins` / 图标请求、无骨架屏，只有一次后台 revalidate | 已实测（debug ingest 日志） |
| [x] | 已安装 tab URL | 桌面 CEF | 切回「已安装」 | URL 为 `/plugins`，不带 `tab` | 已实测 |
| [x] | 无效 tab 回落 | 桌面 CEF | 整页打开 `/plugins?tab=store:does_not_exist` | 源列表加载后回落「已安装」，`tab` 参数被清掉 | 已实测 |
| [x] | 详情无历史兜底 | 桌面 CEF | 整页打开远程详情 `/plugins/aibooru?mode=remote&source=official_github_release&version=1.0.1`，覆盖 `history.length = 1` 后点返回 | 回到 `/plugins?tab=store:official_github_release` | 已实测（`history.length` 为模拟） |
| [x] | 外部新增源 | 桌面 CEF | 页面外直接 invoke `add_plugin_source`（不经插件页代码） | 收到 `plugin-sources-changed {reason: added}`，store 重拉源列表，新 tab 出现；打开后首次网络加载显示骨架屏并正常消失 | 已实测；CLI 没有源命令，用直接 invoke 代替外部入口 |
| [x] | 修改源地址 | 桌面 CEF | 直接 invoke `update_plugin_source` 改 index 地址 | 收到 `{reason: updated}`，地址变化的已加载源以 `forceRefresh: true` 重拉 | 已实测 |
| [x] | 源管理弹窗删除 | 桌面 CEF | 「管理源」弹窗删除测试源并确认 | 后端 `get_plugin_sources` 已无该源；收到 `{reason: deleted}`；当前 tab 自动回「已安装」 | 已实测（当时宽屏无入口，经组件实例打开弹窗） |
| [x] | 桌面「管理源」入口 | 桌面 CEF 宽屏 | 看插件页标题栏右上角，点「管理源」按钮 | 标题栏依次为刷新（super）/ 导入源 / 管理源；点击打开「商店源」弹窗，可编辑源 | 已实测并截图；此前宽屏只有紧凑布局折叠菜单里有该入口，编辑源无路可达；light 模式不渲染弹窗，两处入口均按 `!IS_LIGHT_MODE` 隐藏 |
| [x] | 已安装状态同步 | 桌面 CEF | 内存中临时从 `pluginStore.plugins` 移除 aibooru 再恢复 | 商店条目 `installedVersion` 随之 `1.0.0 → null → 1.0.0`，无 `get_store_plugins` 请求 | 已实测（内存模拟，未真实卸载）；`plugin-*` 事件驱动 `pluginStore` 为既有逻辑 |
| [ ] | 真实安装 / 卸载 / 拖入导入 | 桌面 CEF | 从商店安装或卸载插件、拖入 `.kgpg` | 卡片更新角标与已安装状态即时正确，不重拉商店 | 官方源 30 个插件已全部安装，未做破坏性操作 |
| [x] | 语言切换 | 桌面 CEF | 设置语言 zh → en → zh | 收到 `{reason: official-source-name-i18n-sync}`，官方源 tab 名称随之切换 | 已实测，语言已恢复 zh |
| [ ] | Web 版 | Web | `?tab=` 恢复与只读源行为 | 与桌面一致，源增删改仍被只读拦截 | 未覆盖 |
| [x] | 静态检查 | 仓库 | `deno task check -c kabegame` | vue-tsc 与 cargo check 无错误 | 已运行 |

## Android 源管理页商店网格横向溢出（`apps/kabegame/src/views/PluginBrowser.vue`）

紧凑端插件网格与骨架屏网格由 `repeat(2, 1fr)` 改为 `repeat(2, minmax(0, 1fr))`：`1fr` 的下限是 min-content，`nowrap` 的长插件名会把列撑宽（实测 203px + 281px，容器仅 320px）。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 商店 tab 两列等宽 | Android dev（360 CSS px，ja） | 打开源管理页，切到官方 GitHub 源 tab | 两列各 155px，`.plugin-browser-content` 的 `scrollWidth` 等于容器宽 320；长名称显示省略号 | 已实测并截图 |
| [ ] | 骨架屏 | Android | 首次加载商店 tab | 骨架卡片同样两列等宽，不横向溢出 | 同一规则，未单独截图 |
| [ ] | 桌面不受影响 | 桌面 CEF 窄窗 | 缩窄窗口进入紧凑布局 | 两列等宽 | 未覆盖 |

## Android 查询 chip 改为对话框面板（`KbFilterDropdown` / `GalleryQueryBar.vue` / `GalleryToolbar.vue`）

`KbFilterDropdown` 新增经 `kbFilterDropdownContextKey` 注入的面板承载方式：`App.vue` 在紧凑模式下提供 `panelMode: "dialog"` 与 `bindVisible: useModalBack`，面板内容（自定义 `#panel` 或内置选项列表）原样放进 `ElDialog`。`GalleryQueryBar` 的查询行不再只在桌面渲染，紧凑模式不换行、中段从 0 伸缩横向滚动；删除旧的 van-picker 过滤 / 时间 / 插件 / 媒体类型 / 宽高比 / 排序 picker 与其懒加载，仅保留每页条数 picker；画廊折叠菜单去掉「过滤」「排序」两项。dialog 档下 tooltip 恒给 `visible=false`：disabled 的 tooltip 收到 `true` 会立刻经 `useModelToggle` 回发 `false`，把对话框关掉。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | chip 单行 | Android dev（360 CSS px，ja） | 打开画廊 | 排序两颗 + 搜索 / 过滤 chip 横向滚动 + 行末 ⋯，同一行不换行 | 已实测并截图 |
| [x] | 过滤 chip 弹窗 | Android dev | 点时间 chip | 居中对话框，标题「時間」，内容为过滤树 `2026 通年 (100)` | 已实测并截图 |
| [x] | 内置选项列表 | Android dev | 点排序维度 chip | 对话框列出全部排序维度，当前项高亮 | 已实测并截图 |
| [x] | 返回键 | Android dev | 对话框打开时按返回键 | 只关闭对话框，不弹退出确认 | 已实测 |
| [ ] | 选值后关闭 | Android | 在过滤树 / 排序列表中选择一项 | 查询生效，对话框关闭，chip 显示取值 | 未在真机点选（避免改动用户当前查询） |
| [ ] | 搜索 chip | Android | 点搜索 chip 输入关键字 | 对话框内输入框聚焦、防抖生效 | 未覆盖 |
| [ ] | 高级查询弹窗内的 chip | Android | 在高级查询条件行点 chip | 嵌套对话框在上层，返回键逐层关闭 | 未覆盖 |
| [ ] | 画册 / 任务 / 畅游详情 | Android | 打开各详情页 | 出现同样的 chip 行并可弹窗 | 未覆盖 |
| [ ] | 每页条数 | Android | 右上角 ⋯ → 每页条数 | van-picker 仍可用 | 未覆盖 |
| [ ] | 桌面不受影响 | 桌面 CEF | 点各 chip | 仍为下拉弹层 | 未覆盖 |
| [x] | 类型与单测 | 仓库 | `vue-tsc`；`vitest` GalleryQueryBar / GalleryToolbar | 无错误，12 个用例通过 | 已运行 |

## Android 预览关闭中途重开后不可见（`packages/photoswipe-vue/src/vue/composables/useOpener.ts`）

`CSSAnimation.destroy()` 会同步回调 `onComplete`。关闭动画进行中重新 `open()` 时，`_applyStartProps` 里的 `stopAll()` 让被打断的关闭动画按「打开完成」收尾（`isOpening` 被清成 false），随后设置打开起始样式的分支被跳过，根节点停在关闭留下的 `opacity: 0; transition: none`：opener 认为已打开、返回栈占位、吉祥物被隐藏，画面却看不见预览。修复：opener 增加动画轮次 `_generation`，每次 open / close 自增；动画 `onComplete`、图片解码回调与关闭的延迟 `_start` 只在本轮有效。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 根因复现 | Android dev | 未修复代码：打开预览后经 CDP 调 `opener.close()`，150ms 后 `opener.open()` | 根节点 `opacity: 0`、`transition: none`、背景 0.8、opener `isOpen=true`，与现场一致 | 已实测 |
| [x] | 修复后 | Android dev | 同上，关闭后 50 / 150 / 300ms 重新打开 | 关闭中途 opacity 为 0，重新打开后均恢复为 1，状态为已打开；返回键可关闭 | 重启 dev 后已实测 |
| [x] | 后台下载时预览 | Android dev | 下载任务运行中（总数 319 → 377）打开预览停留 20s，每 0.5s 采样；再左右滑动翻 6 次 | 全程 opacity 1、opener 无开合切换；翻页时 `pvwimgid` 跟随，预览可见；返回键可关闭 | 已实测并截图；本轮未自然触发「关闭中途重开」时序，该时序由上一行的直接复现覆盖 |
| [x] | 正常开合 / 打开中途关闭 | Android dev | 点图打开后立即返回；正常打开再返回 | 正常打开时 opacity 1、背景 0.8；两种情况都能关闭，吉祥物恢复，不误弹退出确认 | 已实测并截图 |

## Android 下载中返回键关闭预览被重新打开（`apps/kabegame/src/components/common/ImagePreviewDialog.vue`）

上一节「关闭中途重开后不可见」的触发源。返回键只关掉 `previewModal`，PhotoSwipe 的 `close` 要等关闭动画结束（约 0.4s）才发，期间 `ImageGrid` 的 `previewedId` 仍在；下载刷新经 `reconcilePreview` 给同一 id 换入新 `ImageInfo`，弹窗的 `props.image` watch 看到「非空且未打开」就重新 `previewModal.open()`。修 opener 之前重开落在关闭动画中途 → 不可见；之后 → 看起来按返回没反应。桌面 `el-dialog` 的 `@close` 在关闭开始时就发，没有这个窗口。修复：紧凑模式下 `previewVisible` 一变 false 就通知上层 `preview-close`（`notifyCompactPreviewClose`，每次打开只发一次，动画结束时那次去重）；同时冻结 `pswpWindow`（`imageById` 改为从同一窗口取），关闭动画期间幻灯片不被抽空。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 竞态复现（修复前） | Android dev | HEAD 版本：打开预览，经 `modalStack.closeTop()` 模拟返回，80ms 后给同 id 换新 `ImageInfo` 对象 | 预览被重新打开，`pvwimgid` 保留 | 已实测；下载中真实按返回也偶发复现（5 次左右出现 1 次） |
| [x] | 修复后竞态 | Android dev | 同上，跑 5 次 | 返回时 `previewedId` 立即清空，预览关闭、URL 清除，不再重开 | 已实测 |
| [x] | 关闭动画完整 | Android dev | 打开预览后返回，逐帧采样 | 关闭期间 PhotoSwipe 数据源保持 3 项、媒体元素在，约 0.4s 后移除 | 已实测 |
| [x] | 正常路径 | Android dev | 滑动翻图后返回；打开后立即返回；关闭后重开同一张 | 均正常关闭 / 打开，`pvwimgid` 跟随与清除正确 | 已实测 |
| [ ] | 下载中真实操作 | Android | 下载任务运行中反复打开预览、滑动、按返回 | 每次返回都关闭 | 测试时下载已结束，由上面的模拟覆盖 |
| [ ] | 桌面不受影响 | 桌面 CEF | 预览开合、切图、关闭 | 行为不变（改动只在紧凑模式分支） | 未覆盖 |
| [x] | 前端单测 | 仓库 | `vitest` `ImageGrid.previewFollowPage.test.ts` | 通过 | 测试补上 `@/stores/ui` 的 mock 后 32 例通过（`ImageGrid.vue` 新增了 `useUiStore()`） |

## Android 预览切图模型：手势回流 + 受控窗口（`ImagePreviewDialog.vue` / `photoswipe-vue` / `ImageGrid.vue`）

旧模型下「当前图」有三份状态（`previewedId`、URL `pvwimgid`、PhotoSwipe 内部下标），彼此用窗口下标与相对方向异步互写：给 PhotoSwipe 的 `index` 是一次性命令、关闭后残留，打开时 `runInit` 读到上一轮的下标；初始化、重定位发出的 `change` 又被当成用户滑动转成 `switch`，把上层的 `previewedId` 改走（现象：预览过 B 后再点 A 或 C，打开的都是 B）；URL 回写没有序号，旧写入落地会把 `previewedId` 拉回。

现模型：`previewedId` 唯一真源，URL 与 PhotoSwipe 只做投影。
- `ImageGrid` 只在挂载 / keep-alive 激活时读一次 `pvwimgid`，之后只写不读。
- 弹窗把三项窗口与当前下标（`pswpCurrentIndex`，派生值）随 `open` 同一轮下发；PhotoSwipe 的 `change` 不再回流。
- photoswipe-vue 区分手势与程序导航：手势翻页落定后发新的 `swipe` 事件，弹窗与边界滑动（`reach-boundary`）一样，和桌面箭头一样 `requestSwitch(方向)`；上层重算窗口与下标回设，PhotoSwipe 在同一个 watcher 里先按 id `relocate`、再 `goTo` 下标，通常是 no-op；手势翻页尚未结算时不收敛。
- slideView 改读父组件的实时数据源（`getItems`）：父组件 watcher 里重定位时子组件 `items` prop 还是上一帧，按旧长度夹取下标会落到错误的幻灯片（从下一页滑回上一页落到倒数第二张）。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 根因复现 | Android dev | 旧代码：依次点第 2、1、3 张（B → 返回 → A → 返回 → C） | 打开 C 显示的是 B | 已实测，debug ingest 记录到初始化 `change` 触发的 `prev` 切图与 URL 回写拉回 |
| [x] | 打开正确 | Android dev | 同上 | B、A、C 各自打开正确，`runInit` 读到的 `propsIndex` 即当前图，打开后无切图请求 | 已实测并截图 |
| [x] | 滑动翻页 | Android dev | 从 B 往后滑两张、往回滑一张 | `pvwimgid` 依次 574 → 573 → 574；每次 `swipe` 后新窗口 `relocate` 到原位，`goTo` 的 diff 为 0 | 已实测 |
| [x] | 首张往前滑 | Android dev | 第 1 页首张往前滑 | 停在首张，不发切图 | 已实测 |
| [x] | 快速连滑 | Android dev | 连续快速滑两下（next×2、prev×2） | 第二下撞窗口边缘走 `reach-boundary`，第一下落定再发 `swipe`，上层走两步，PhotoSwipe `goTo` 跟上；最终显示与 `pvwimgid` 一致 | 已实测并截图 |
| [x] | 跨页往后 | Android dev（每页 100） | 第 1 页末张往后滑 | 翻到第 2 页，显示 476 | 已实测 |
| [ ] | 跨页往回 | Android dev | 第 2 页首张往前滑 | 回到第 1 页末张 477 | 修复前落到倒数第二张 478；`getItems` 修复待重启 dev 后复测（Vite 未重载 `PhotoSwipe.vue`） |
| [x] | URL 只写不读 | 仓库 | `vitest`：挂载后改 `pvwimgid` | 预览目标不变 | 新增用例通过 |
| [ ] | 深链接 | Android / 桌面 | 带 `?pvwimgid=` 进入画廊或从其它页切回 | 打开该图 | 挂载 / 激活读取路径未改，未单独复测 |
| [ ] | 下载中滑动 | Android | 下载任务运行中滑动翻页、按返回 | 不跳图、不回弹 | 未覆盖 |
| [ ] | 桌面不受影响 | 桌面 CEF | 预览切图、关闭 | 行为不变（桌面不走 PhotoSwipe） | 未覆盖 |
| [x] | 类型与单测 | 仓库 | `vue-tsc`；`vitest src/components` | 无错误；16 个文件 80 例通过 | 已运行 |

## Android 画册页左侧贴边（`Albums.vue`）

`.albums-page` 的左内边距为 0，是给桌面三栏布局让树列贴窗口左缘；紧凑模式没有树列，`ImageGrid` 中栏又是 `display: contents` 加不上内边距，结果面包屑、查询 chip 行和图片都贴着屏幕左边，只有页头靠 `ml-5` 缩进。现在紧凑模式在页面根上补回 20px 左内边距，页头的 `ml-5` 只在非紧凑模式保留。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 左右对称 | Android dev | 打开任一子画册 | 页头、面包屑、chip 行左右边缘均为 20 / 340（360 宽视口），与画廊一致 | 已实测并截图 |
| [ ] | 未选画册 | Android | 进入画册页未选中任何画册 | 页头与内容左缘对齐，无面包屑 | 未覆盖 |
| [ ] | 桌面三栏不受影响 | 桌面 CEF | 宽屏打开画册页、开关信息面板 | 树列仍贴左缘，页头仍缩进 20px | `isCompact` 为 false 时样式未变，未单独复测 |
