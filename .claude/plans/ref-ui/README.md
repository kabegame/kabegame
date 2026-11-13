# 界面重构：从 element-plus 换到 reka-ui + 设计 token

> 总纲（思路、决策、待定、各期范围）。某一期开工前再按 AGENTS.md 的格式（现状锚点 + 逐点）细化成 `phase-N.md`。
> 范围统计取自 2026-11-13 对 `apps/kabegame/src` 的扫描：191 个文件用到 EP / Vant。

## 总体设计思路

目标观感是「中性外框 + 一个强调色」的简约风，参照 ChatGPT / Claude 一类应用。Kabegame 的内容本身就是彩色的壁纸，外框越中性、层级越靠细线和留白而不是颜色，图越突出；品牌粉不消失，但只出现在需要被看见的地方：选中、焦点、计数。主操作用墨色实心按钮。技术框架不变（Vue 3 + UnoCSS presetWind3 + Tauri），换的是组件层。

组件层拆成三层。行为与无障碍交给 npm 上的 `reka-ui`（Radix 的 Vue 版）：焦点、键盘、点外部关闭、层栈、浮层定位都是它的，不 fork、跟上游升级。外观由我们自己写的薄封装负责，放在 `apps/kabegame/src/components/ui/`，思路同 shadcn-vue（源码在仓库里、只用 UnoCSS），从 `@/components/ui` 导入。颜色、圆角、阴影、层级只来自一份 token（`apps/kabegame/src/styles/tokens.css` 的 `--kb-*`，UnoCSS 里是 `kb` 色板与 `rounded-kb-*` / `shadow-kb-*`）。图标统一用 `@lucide/vue`，全局线宽 1.75。

vendored element-plus（`packages/kabegame-element-plus`）进入只出不进的状态，按期替换，最后整包删除。分期的单位是**界面**，不是组件类型：一期把一组界面里的 EP 全部换掉（按钮、图标、弹层、表单一起），需要的新组件在这一期里现建。按组件类型分期（先全部对话框、再全部表单）会让同一个界面里出现「新对话框套旧下拉」或「旧对话框套新下拉」，两边的焦点陷阱和 `body` 的 `pointer-events: none` 互相打架（P0 已遇到一例）；按界面迁，冲突只剩在界面之间的少数跳转处，由一层混用期垫片兜住（P2 建，P9 删）。

迁移期很长，为了不让没轮到的界面和新界面差太多，P1 先给 EP 做一次全局换皮：EP 的基础 token 改取 `--kb-*`，删掉业务侧那些全局 `.el-*` 覆盖。之后每期主要是换结构与行为，观感在 P1 已经基本统一。调用点很多的命令式 API（`ElMessage` 390 处、`ElMessageBox` 65 处）先换成同签名的门面，一次批量改导入，之后只换门面内部；共用的表单控件（`common/form/Kb*`）同理，调用方不动、内部换芯。

## 关键决策

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 行为层 | `reka-ui`（P0 装的是 2.11.0） | Vue 生态里 Radix 系最成熟的无头原语；覆盖本仓所需的全部类型（含 Drawer、NumberField、Calendar、颜色控件、Tree、Toast） |
| 组件放哪 | app 内 `src/components/ui/`，不建 package | 只有一个消费方；建 package 要同步 alias、两处 tsconfig、manualChunks 三处接线。出现第二个消费方再搬 |
| 写法 | 照 shadcn-vue 的结构手写，presetWind3 语法 | shadcn-vue 现版本是 Tailwind v4 语法，直接拷要么换预设、要么逐类改 |
| 不引入 | cva、tailwind-merge、Tailwind v4 | 变体用 `.vue` 里的类表；没有 merge 就约定「不在调用处叠同类工具类，要不同就加变体」 |
| 分期单位 | 按界面，一期把一组界面里的 EP 全部换掉 | 避免同一界面里新旧弹层互相嵌套；每期结束都是完整的界面，好验收 |
| 按钮与图标 | 随所在文件迁，不单独成期 | 两者遍布 85 个文件，单独一期等于把全部文件过两遍 |
| 混用期垫片 | P2 建、P9 删 | 新浮层的触发器在 EP 对话框里时挂进那个对话框；新模态层不因点到 EP 浮层而关闭，且 EP 浮层在新模态打开时仍可点 |
| EP 全局换皮 | P1 做 | 迁移跨多期，先让没轮到的界面观感对齐 |
| 命令式 API | 同签名门面（P2）；confirm 的实现 P9 才换成 Reka | toast 无焦点陷阱，可立即换；确认框是模态，等 EP 对话框都没了再换最稳 |
| 共用表单控件 | `common/form/Kb*` 门面不动、内部换芯（P5） | 插件变量、运行配置、设置页都用它们，一处换芯全部生效 |
| 主色 | 墨色实心（`--kb-primary`） | 这一路风格的标志；改回品牌粉只动 tokens.css 三行（待定 1） |
| 强调色 | `--kb-accent` 挂在 `--anime-primary` 上 | 插件详情运行时改写 `--anime-*` 换肤仍能波及新组件 |
| 中性色 | 新值，不来自 `--anime-*` | `--anime-*` 的文字、边框都是紫 / 粉色系，本身就是要换掉的东西 |
| 图标 | lucide；chip 上那套设计稿线性图标（`FilterPlugin` 等）保留 | 过滤维度图标是专门画的，和 lucide 观感接近 |
| 层级 | Reka 浮层 `--kb-z-popover` 3000 / `--kb-z-tooltip` 3100，与 EP 的 3000 起递增同档 | 混用期两边都能互相盖住 |
| 范围 | 浅色主题 | 现在就没有深色主题；token 结构允许以后加（待定 2） |

## 待定事项

1. **主操作颜色**：墨色还是品牌粉。P0 / P1 按墨色做了（EP 换皮的主色、开关、复选框、Vant 都跟 `--kb-primary`），想换回粉只改 tokens.css 三行。
2. **深色主题**是否纳入这次重构。
3. ~~**全局外框**~~（P1 按默认做了）：页面底 `#f6f6f7`、侧栏 `#efeff1`，中性的 `--anime-*` 全部指向 `--kb-*`；开应用背景时侧栏 / 底部导航毛玻璃（`--kb-glass*`）。看了不满意再调 token。
4. **品牌元素**留多少：吉祥物、后台任务卡片的粉→紫渐变、插件卡片的 `kb-grad`。
5. **Toast**：用 `vue-sonner`（shadcn 的选择）还是在 Reka Toast 上自己写。
6. **Android 的 Vant**：`van-popup` 换成 Sheet 基本确定；`van-picker`（滚轮选择，7 个文件）没有无头对应物，保留还是自己写。
7. **字号阶梯**：是否定一套字号 / 行高 token（标题 17、正文 13、说明 12.5 是 P0 的取值）。
8. **组件陈列页**：P2 在 dev 下加一个，方便对照与回归截图。
9. **P0 的焦点问题**（Reka 菜单打开 EP 对话框后焦点回到触发器）：收集菜单打开的四个对话框在 P5 迁完后消失，之前是否临时修。
10. **插件文档里的看图**（`el-image-viewer`）：复用预览的 photoswipe 还是自写灯箱（P7）。

## 分期总览

| 期 | 范围 | 文件数 | 主要内容（EP 用量） |
| --- | --- | --- | --- |
| **P0 ✅** | 画廊顶栏、chip 换皮 | — | 2026-11-13 完成，见 `versions/latest/regression.md`「界面重构第一步」 |
| **P1 ✅** | 外框与 EP 全局换皮 | 19 | 2026-11-13 完成，见 `versions/latest/regression.md`「界面重构 P1」与下方「P1 实施记录」 |
| P2 | 底座与反馈 | 门面 + 新组件 | `ElMessage` 390、`ElMessageBox` 65、`v-loading` 13；弹层 / 表单 / 展示组件、混用期垫片 |
| P3 | 画廊 | 38 | 查询行簇（chip 下拉重写、收藏视图、颜色、高级查询）、网格与右键菜单、画廊发起的对话框、Android 底部弹层 |
| P4 | 图片预览与详情 | 11 | `ImagePreviewDialog`（2363 行）与详情面板、壁纸属性 |
| P5 | 收集与任务 | 29 | 四种收集对话框、共用表单控件换芯、任务抽屉；form-item 31 |
| P6 | 画册与畅游 | 6 | `Albums.vue`、`Surf.vue`（各 1000+ 行）、画册树 |
| P7 | 插件 | 13 | 插件浏览 / 详情 / 文档 / 导入；骨架 16、空状态 9 |
| P8 | 自动任务、设置与其它 | 33 | 运行配置、设置页全部条目、更新、日志；descriptions 27、switch 11 |
| P9 | 收尾 | — | confirm 换实现、删垫片、删 EP 包与接线、清 `.el-*`、文档 |

顺序的理由：P1 先换观感，后面每期看得出是同一套；P2 把各期都要的组件与门面一次建好；P3 是主界面，接着 P0；P4 从每个网格都能打开，放在画廊之后、其它界面之前；P5 换共用表单控件，P7 / P8 的表单界面因此更轻；设置页（P8）最后，它的条目最多、但逻辑最简单。

## 各期范围

一个文件归入它所在界面最早的那一期。只调 `ElMessage` / `ElMessageBox` 的 composable、service、util（26 个）由 P2 的门面统一处理，不另列。

### P1 外框与 EP 全局换皮

- **迁移**
  - 布局：`App.vue` 的 `el-container` / `el-aside` / `el-menu` / `el-main` 换成自己的布局与侧栏导航（`el-config-provider` 留到 P9）。
  - 侧栏与工具箱：`busy/SidebarActivityBar`（popover）与 6 张后台任务卡片，`header/comps/GlobalToolsPopover`（popover + switch）。
  - 页面级选项卡：vendored `KbTab` 换成新 Tabs，四处调用（`PluginBrowser`、`AutoConfigs`、`PluginDetailContent`、`UpdateDialog`）。
  - 零碎：`ScrollButtons`、`EmptyState` / `DetailPanelEmptyState`、`SuperModeToggle`、`FileDropOverlay`、`InitScreen`（进度条）、吉祥物气泡 `KameBubble` / `KameToolboxBubble`（只换皮）。
- **EP 全局换皮**：EP 基础 token（主色、文字、边框、填充、圆角、字号、阴影）改取 `--kb-*`；删掉 `anime-theme.css` 里 45 条全局 `.el-*` 覆盖（按钮渐变、悬停上浮、卡片阴影等）；页面底与侧栏底色按待定 3。
- **新建组件**：Tabs、Popover、Switch、Progress、Empty。
- **验收**：各主页面「改前 / 改后」截图，应用背景开 / 关各一组；逐页看有没有被删掉的全局覆盖拉坏的地方。

#### P1 实施记录

- 比计划多做的：
  - 中性的 `--anime-*`（文字、边框、底色、阴影）直接改指向 `--kb-*`，不只换 EP——业务组件 scoped 样式里用了几百处，一处改完没迁的界面也跟着中性。
  - 工具箱里整理 / 清理隐藏 / 检查更新三个控件（原归 P3）只在工具箱用，随工具箱迁了；`UpdateButton`（原归 P8）在侧栏里，一起迁了。
  - 工具箱内容三处重复（侧栏、紧凑端、吉祥物气泡）抽成 `GlobalToolsList` + `ToolRow`；6 张后台任务卡片抽成 `BusyTaskCard`。
  - 修了 P0 的 Tooltip 套弹层触发器时浮层不定位的问题（`DropdownMenuContent` / `PopoverContent` 显式 `reference`）。
- 计划内留下的：`App.vue` 的 `el-config-provider`（P9）、`ElMessage` / `ElMessageBox`（P2 门面）；vendored `KbTab` 已无调用方，随包在 P9 删。
- 被删掉的全局 `.el-card` 模糊让插件页 / 畅游页开应用背景时卡片全透明，已在两处的卡片类上改成 `bg-kb-glass-strong backdrop-blur-md`（P7 / P6 迁移时再整体处理）。
- 换皮后最显眼的旧外观都在后续期的文件里：设置左导航与 `KbSegmentedControl`（P5 / P8）、画廊分页器（P3）、画册「设为桌面轮播」（P6）、运行配置卡片的粉色虚线（P8）、插件卡片 2px 边框（P7）。

### P2 底座与反馈

- **反馈门面**
  - `toast`：替换 `ElMessage` 390 处（批量改导入），实现立即换新（待定 5）。
  - `confirm` / `alert` / `prompt`：替换 `ElMessageBox` 65 处，签名不变，内部先仍用 `ElMessageBox`，P9 换。
  - `v-loading`：13 处（含 `useLoadingDelay`）换成自己的指令与 Spinner。
- **底座组件**
  - 弹层：Dialog、AlertDialog、Sheet（侧边 / 底部，Android 底部弹层也用它）、Popover、ContextMenu、DropdownMenu 扩展（子菜单、勾选项）。根组件统一接 `useModalBack`。
  - 表单：Field（标签 / 说明 / 错误，替代 `el-form-item` 的布局）、Input / Textarea、NumberField、Checkbox（+ Group）、RadioGroup、Select、Slider、Combobox。日期、时间、颜色控件在用到的期建（P3 / P5 / P8）。
  - 展示：Tag、Skeleton、Separator、ScrollArea、DescriptionList、Alert、Spinner。
- **混用期垫片**：新浮层的触发器在 EP 对话框 / 抽屉里时，浮层挂进那个对话框；新模态层把 `.el-popper` / `.el-overlay` / `.el-message` 当作层内，并让它们在 `body` 被设 `pointer-events: none` 时仍可点。
- **陈列页**（待定 8）。界面上可见的变化只有提示消息。
- **验收**：组件单测（键盘、Esc、Android 返回栈）；门面替换后 vitest 全过；混用场景各测一例（新浮层在旧对话框里、旧确认框从新对话框里弹出）。

### P3 画廊

- **查询行**
  - `KbFilterDropdown` 从 EP 包移出、在 Popover 上重写（`AutoConfigs` 与高级查询也用它）；`GallerySearchDropdown`、`PathqlPathBar`。
  - 收藏视图：`SavedViewsSection` / `SavedViewEditor` / `SavedViewCombination`（popconfirm、popover、dialog）。
  - 颜色：`ColorBucketPanel`（`el-color-picker-panel` 换成 Reka 颜色控件）。
  - 高级查询：`GalleryAdvancedQueryDialog` / `ConditionRow` / `Sequence`。
- **网格与右键**：`ImageItem`、`ImageContent`（骨架）、`ContextMenu`（自写，换成 ContextMenu 带子菜单）、`actions/*Actions.ts` 的图标、`EdgeArrows`、`LoadMoreButton`、`SearchInput`。
- **画廊发起的对话框**：`AddToAlbumDialog` + `AlbumPicker`、`RemoveImagesConfirmDialog`、`FailedImagesDialog`、`OrganizeDialog`、`SettingChoiceDialog`、`WallpaperTargetPickerHost`、`OptionPickerDrawer`。
- **分页、排序与头部工具**：`GalleryBigPaginator`、`GalleryPageSizeControl`、`GallerySortControl`、`CheckUpdateControl`、`HiddenCleanupControl`、`OrganizeHeaderControl`。
- **Android 底部弹层**：`ActionSheet`、`AndroidDrawer`、`AndroidPicker*`（`van-popup` 换成 Sheet；`van-picker` 按待定 6）。
- **树**：`KbTreePanel` / `KbTreeRow`（滚动条换 ScrollArea；画册树也用，外观在 P6 再对）。
- **验收**：画廊所有入口逐个过（过滤、排序、搜索、收藏视图、高级查询、右键各项、加入画册、删除、整理、失败图片）；Android 长按菜单与返回键。

### P4 图片预览与详情

- **迁移**：`ImagePreviewDialog`（photoswipe、键盘、壁纸 iframe 的右键转发改用 ContextMenu 虚拟锚点）、`ImageDetailDialog`、详情面板（`ImageBasicInfoPanel` / `ImageNativeMetadataPanel` / `ImagePluginDescriptionPanel`）、`ImageLabelsPanel`、`CodeBlock`、`HoverRevealPanel`（`el-drawer` 换成 Sheet）、`WpeWebPropertiesDialog` / `WpeWebPropertiesPanel`、`WallpaperScreenLayout`。
- **单独一期的原因**：风险最高。每个网格都会打开它，键盘与焦点要求高，又和壁纸 iframe、场景宿主有交互。
- **验收**：图片、视频、网页壁纸、场景壁纸各开一次预览；键盘翻页、Esc、右键菜单位置、属性面板、封面、深链接跳页、Android 返回键。

### P5 收集与任务

- **共用表单控件换芯**：`common/form` 下的 `KbBoolean`、`KbSelect`、`KbMultiSelect`、`KbNumber`、`KbText`、`KbDate`、`KbColor`、`KbPath`、`KbSegmentedControl` 内部换成新控件。插件变量表单、设置页、运行配置都用它们，这一步同时影响 P7 / P8 的界面（靠 P2 的垫片在旧对话框里也能用）。
- **收集**：`CrawlerDialog` + `CrawlerTaskForm`、`PluginVarsForm`、`HttpHeadersEditor`、`OutputDirSelect`、`MaxDownloadsField`、`RetryCountField`、`PluginPickerField`、`MediaPicker`、`LocalImportDialog`、`WallpaperImportDialog`、`WebpageCollectDialog`。
- **任务**：`TaskDrawer`、`TaskDrawerContent`、`TaskSummaryRow`、`TaskCountsInline`、`TaskLogDialog`、`TaskParamsDialog`、`TaskRunParamsContent`（descriptions 换成 DescriptionList）、`TaskRetryChainPopover`、`TaskContextMenu`、任务详情页副标题的统计。
- **新建组件**：DatePicker。
- **验收**：四种收集各走一遍（必填拦截、默认值、`when` 联动、路径变量、失败重试设置）；任务抽屉右键、重试记录、日志与参数；P0 的焦点问题应随之消失。

### P6 画册与畅游

- **迁移**：`Albums.vue`（2 个抽屉、2 个对话框、表单、面包屑）、`AlbumTreePanel` / `AlbumTreeView` / `AlbumDetailPanel`、`AlbumContextMenu`；`Surf.vue`（`el-autocomplete` 换成 Combobox，17 条 `.el-*` 覆盖）、`SurfImages`。
- **规模**：6 个文件，但 `Albums.vue` 与 `Surf.vue` 各 1000+ 行。
- **验收**：画册树拖拽、新建 / 移动 / 改名 / 删除、紧凑档抽屉、画册信息面板；畅游地址栏补全、站点记录、一键下载。

### P7 插件

- **迁移**：`PluginBrowser`（3 个对话框、表格、骨架、空状态）、`PluginDetail`（2 个对话框）、`plugin/` 下的卡片、详情、文档（`el-image-viewer` 按待定 10）、快捷预览、侧栏，`KbLabel`、`PluginImportDialog`。
- **验收**：商店与已安装列表、安装 / 更新 / 卸载、导入 `.kgpg`、文档与更新日志的图片、快捷预览走马灯。

### P8 自动任务、设置与其它

- **自动任务**：`AutoConfigs`、`scheduler/` 下的 `AutoConfigDialog`、`AutoConfigDetailContent`、`RunConfigGridCard`、`RecommendedPresetGridCard`、`ScheduleEditorPopover`、`ScheduleSpecEditor`（时间选择）、`ScheduleProgressBar`（进度、倒计时）、`MissedRunsDialog`。
- **设置**：`Settings`、`SettingsDialog`、`settings/` 下全部条目、控件与面板（MCP、Web 服务器、插件默认配置）。
- **其它**：`UpdateDialog`、`DownloadProgressDialog`、`UpdateButton`、`AppLogDialog`、`KamechanHistoryDialog`。
- **新建组件**：TimeField。
- **验收**：设置页每个分区改一次值并确认保存；运行配置新建 / 编辑 / 定时；检查更新流程；日志筛选。

### P9 收尾

- **删除与替换**
  - `confirm` 门面换成 AlertDialog，删掉混用期垫片。
  - 删 `packages/kabegame-element-plus*`、theme-chalk 引入、`app.use(ElementPlus)`、全局图标注册、`el-config-provider`、`vCornerBadge`。
  - 接线：vite alias、两处 tsconfig `paths`、web 的 `manualChunks`。
  - `anime-theme.css`、`dialogs.css` 里剩下的 EP 相关样式；Vant 按待定 6 处理。
- **文档**：`cocs/ui/COMPONENT_LIBRARY.md` 改写成新组件库的文档，`AGENTS.md`、`packages/AGENTS.md`、Cursor 规则同步。
- **验收**：grep 无 `@kabegame/element-plus`、无 `<el-`、无 `.el-`；`deno task check`、vitest、web 构建通过；包体积前后对比。

## 每期通用做法

- 开工先截本期界面的「改前」截图，结束时同角度再截一组。
- 文件里的 `el-button`、`el-icon` 与 EP 图标随文件一起换。
- 硬指标：本期文件里没有 `<el-*>`、`@kabegame/element-plus(-icons)` 导入、`.el-*` 选择器（grep 可查）。
- 写回归条目与 changelog；约定有变化时同步文档与规则。
