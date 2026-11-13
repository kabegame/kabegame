# 组件库：reka-ui + 设计 token（`components/ui/`）

**结论先行：前端只有一套组件库——`apps/kabegame/src/components/ui/`。** 行为与无障碍来自 npm 的 `reka-ui`
（无头原语，不 fork），外观是仓库里自己写的薄封装（UnoCSS），颜色、圆角、阴影只来自 `styles/tokens.css` 的 `--kb-*`，
图标是 `@lucide/vue`。从 `@/components/ui` 导入。

**element-plus 与 Vant 已删除**（界面重构 P9，2026-11-13）：vendored 的 `@kabegame/element-plus` /
`@kabegame/element-plus-icons`（`packages/kabegame-element-plus*`）、Vant、`@vitejs/plugin-vue-jsx`（只给 EP 的 `.tsx` 用）
都已移除，接线（vite alias、两处 tsconfig `paths`、web 的 `manualChunks`）一并删掉。不要再引入任何组件库；缺什么组件就在
`components/ui/` 里用 Reka 原语写一个。web 构建的 JS 从 3.90 MB 降到 2.81 MB（gzip 1.24 → 0.91 MB），CSS 从 592 KB 降到
151 KB（gzip 113 → 27 KB）。

<details>
<summary>历史：vendored element-plus（2026 年上半年 → P9）</summary>

本仓曾把 element-plus 2.13.0 与 element-plus-icons 2.3.2 vendor 进 `packages/`、作为自有组件库 fork 维护：根因是项目从没
覆盖过 EP 的全局 token，而是逐个重写具体类，vendor 前有 49 个文件、约 1733 行覆盖、147 处 `!important`。vendor 之后主题
下沉进包内的 token map，覆盖层逐步消失；界面重构（P0–P9）又把整个组件层换成 reka-ui，最终整包删除。旧约定（`--kb-el-*`
token map、`el-` 前缀、`KbTab` / `KbFilterDropdown` 放进 vendored 包等）都已失效，git 历史里仍可查。

</details>

## 组件与约定

目标观感是「中性外框 + 一个强调色」的简约风（参照 ChatGPT / Claude 一类应用）。壁纸本身是彩色的，
外框越中性，图越突出；强调色（`--anime-primary` 的粉）只留给选中、焦点、计数。

**三层分工**

| 层 | 位置 | 说明 |
| --- | --- | --- |
| 行为与无障碍 | npm `reka-ui`（Radix 的 Vue 版） | 焦点管理、键盘、点外部关闭、层栈、定位都由它负责，不 fork |
| 样式与组件 | `apps/kabegame/src/components/ui/` | 自己写的薄封装（思路同 shadcn-vue：源码在仓库里），只用 UnoCSS；从 `@/components/ui` 导入 |
| token | `apps/kabegame/src/styles/tokens.css` | `--kb-fg` / `--kb-surface` / `--kb-line` / `--kb-primary` / `--kb-accent` / 圆角 / 阴影 / 层级；UnoCSS 里是 `kb` 色板（`text-kb-fg`、`bg-kb-hover`、`border-kb-line`）与 `rounded-kb-*`、`shadow-kb-*`（`uno.config.pub.ts`） |

图标用 `@lucide/vue`，`bootstrap/app.ts` 经 `LUCIDE_CONTEXT` 把默认线宽设为 1.75。

**现有组件**（dev 下打开 `/dev/ui` 是陈列页 `views/dev/UiShowcase.vue`，含「嵌套」场景，改组件后在那里对照）：

| 类 | 组件 | 要点 |
| --- | --- | --- |
| 按钮与小件 | `Button`、`CountBadge`、`Spinner`、`Tag`、`Tooltip`、`HelpTip` | `HelpTip` 是「?」说明（桌面悬停提示、Android 点按气泡），取代 `el-tooltip` + `QuestionFilled`；`Button` 变体 `primary`（墨色实心）/ `danger`（危险色实心）/ `outline` / `ghost` / `ghost-danger`，尺寸 `sm` / `md` / `icon` / `icon-sm` / `icon-xs`，可做 Reka 触发器的 as-child 子元素；`Tag` 五种色调、可关闭；`Tooltip` 的 `content` 为空不弹，自带 Provider |
| 弹层 | `Dialog`、`AlertDialog`、`Lightbox`、`Sheet`、`Popover` + `PopoverContent`、`Popconfirm`、`PickerSheet` | 都用 `v-model:open`，根组件已接 `useModalBack`（调用方不要再套 `useModal`）；`Dialog` 有 `title` / `description` / `width` / `#footer`，`height`（固定高度，正文自己管滚动的工作台）与 `fullscreen`（紧凑档铺满）走内联样式，去正文内边距用 `body-class="!p-0"`；关闭按钮在 DOM 末尾（打开时焦点先落正文）；`AlertDialog` 点遮罩不关，`action` 返回 Promise 时按钮转圈、Esc 不关，完成才关、抛错留在框里；`Lightbox` 是桌面看图（v-model `open` / `index` + `images` URL 数组，方向键翻页、`loop` 关时到头停住，滚轮以光标为中心缩放、放大后拖动、双击切 2 倍，取代 `el-image-viewer`；触屏看图仍用 photoswipe，在对话框里打开时 `append-to` 那个对话框，否则 Reka 模态下 body 不可点）；`Sheet` 四个方向，底部即 Android 底部弹层（把手、安全区）；`Popover` 默认非模态，`PopoverContent` 的 `anchor` 可锚在任意元素上（没有触发器的浮层，如锚在列表某一行的编辑浮层）；`Popconfirm` 是就地的气泡确认（默认插槽是触发按钮，取代 `el-popconfirm`）；`PickerSheet` 是底部滚轮选择（P9 起自写，见下「滚轮选择」） |
| 菜单 | `DropdownMenu` + `DropdownMenuContent`、`ContextMenu`；共用的 `MenuItem`（= `DropdownMenuItem`，`danger` / `shortcut`）、`MenuSeparator`、`MenuSub`、`MenuCheckboxItem`、`MenuRadioGroup`、`MenuLabel` | Reka 的菜单项不依赖根组件类型，下拉与右键共用一套项；`ContextMenu` 默认插槽是触发区域、`#menu` 是菜单，要在某个坐标打开时对触发区域派发带 `clientX` / `clientY` 的 `contextmenu` 事件 |
| 表单 | `Field` + `useForm`、`Input`、`Autocomplete`、`Textarea`、`NumberField`、`Checkbox`、`CheckboxGroup`、`RadioGroup`、`Select`、`Slider`、`RangeSlider`、`Switch`、`SegmentedControl`、`Combobox`、`DatePicker`、`TimeField`、`ColorPickerPanel`、`KbFilterDropdown`；分节标题 `SectionTitle` | `KbFilterDropdown` 见下「过滤 chip 下拉」；`ColorPickerPanel` 是取色面板（v-model `#rrggbb`，饱和度 / 明度区 + 色相条 + 十六进制输入，内部持有 HSB，拖到灰色色相不丢），取代 `el-color-picker-panel`；`RangeSlider` 的 v-model 是 `[起, 止]`；`Field` 给标签 / 说明 / 错误（取代 `el-form-item`，`orientation="horizontal"` 标签在左，`#label-end` 放标签行右侧的附加操作），控件经 `field.ts` 自动拿 id 与出错状态，校验见下「表单校验」。`Select` / `Combobox` / `RadioGroup` / `CheckboxGroup` 用 `options` / `items` 数组；`Select` / `Combobox` 的 `clearable` 清空后 v-model 为 `undefined`，**选项值不能是空字符串**（Reka 的限制，空串表示未选，需要时由调用方编码，见 `KbSelect`）；`Combobox` 给了 `filter` 时只按用户键入的文字过滤（展开时清空，不拿输入框回显的已选文字去匹配）；`DatePicker` 的 v-model 是 `YYYY-MM-DD`，日历气泡 «/» 跳年、‹/› 跳月，`isDateDisabled` 收 `YYYY-MM-DD`；`TimeField` 的 v-model 是 `HH:mm`（Reka TimeField，固定 24 小时制，时 / 分两段可键入或方向键步进，清空某段不更新 v-model；原生 `type=time` 在 CEF 下会显示成 12 小时制）；`Autocomplete` 是自由输入的补全（地址栏）：v-model 是文字本身、`items` 由调用方按文字算好，打字不自动高亮，回车 emit `submit`（原文），只有方向键选中后回车或点击才 emit `select`，焦点始终在输入框、失焦收起；要整体换造型就给 `anchorClass` / `contentClass` / `itemClass` / `inputClass`（整体替换默认类，外框带 `data-open` 供 `data-[open]:` 写展开态）——要「从选项里选一个值」用 `Combobox`；`Input` 的 `inputClass` 加在内层 input 上；`Slider` 拖动中更新 v-model、松手发 `commit`；`NumberField` 清空时是 `undefined`；`SectionTitle` 是长表单的分节标题（取代 `el-divider content-position="left"`） |
| 展示 | `Alert`、`DescriptionList` + `DescriptionItem`、`Empty`、`Progress`、`ScrollArea`、`Separator`、`Skeleton`、`Tabs` | `DescriptionList` 取代 `el-descriptions`；`Tabs` 接口同原 `KbTab`（只管 tab 头）；`Progress` 的 `value` 为 null 是不定进度 |
| 反馈 | `Toaster` 与 `MessageBoxHost`（`App.vue` 各挂一份）、`toast`、`messageBox`、`vLoading` | 见下「反馈门面」 |

**反馈门面**（P2）：
- `toast`（`components/ui/toast.ts`）：签名同 `ElMessage`——`toast.success(msg)`、`toast({ type, message, duration })`、`toast.closeAll()`，`duration: 0` 不自动关。顶部居中，同类型同文字只留最新一条，最多同时 4 条。业务里多数提示走 `kameMessage`（吉祥物气泡），气泡被遮住时降级到 `toast`；直接调 `toast` 的是不需要吉祥物的地方。
- `messageBox`（`components/ui/messageBox.ts`，P9 起自己实现，渲染在 `MessageBoxHost.vue`）：调用方式沿用 `ElMessageBox`
  （`confirm` / `alert` / `prompt` / `close`），请求排队、同时只显示一个，外观同 `AlertDialog`（点遮罩不关，焦点落在主按钮，
  `prompt` 落在输入框并选中原文）。结果约定：
  - `confirm`：确定 resolve `"confirm"`；取消 reject `"cancel"`；Esc / 返回键 / `close()` reject `"close"`，没开
    `distinguishCancelAndClose` 时也报 `"cancel"`。
  - `prompt`：确定 resolve `{ value, action: "confirm" }`；`inputValidator(value)` 返回 `true` 才放行，返回字符串就显示成错误、
    留在框里（回车等同确定）。其余同 `confirm`。
  - `alert`：只有一个按钮，怎么关都 resolve，不会抛。
  - `dangerouslyUseHTMLString` 的正文经 DOMPurify 清洗，插进去的用户数据仍要调用方自己转义；`danger: true` 让确定按钮用危险色。
    `type` / `center` / `customClass` 照收但不改变外观（中性风格不按类型配图标）。
  - 有触发按钮、要转圈等异步操作完成的确认，用 `AlertDialog` 的 `action`，不用 `messageBox`。
- `vLoading`（`components/ui/loading.ts`）：在 `<script setup>` 里导入即可，模板写 `v-loading="busy"`（没有全局注册）。
- service / composable / util 里直接从 `@/components/ui/toast`、`@/components/ui/messageBox` 导入，不经 `@/components/ui`（免得把全部组件拉进来）；测试里 mock 这两个模块。

**迁移记录**（P0–P9，留作排查时对照「这块界面是哪一期换的」）：
- P0：`PageHeader` 与所有顶栏功能按钮（注册表 `header/headerFeatures.ts` 的图标已换成 lucide）、`CollectAction`、
  插件详情顶栏、画廊副标题与查询行行尾的清除过滤。
- P1：`App.vue` 布局与侧栏导航、底部导航、工具箱（`GlobalToolsPopover` /
  吉祥物气泡共用 `GlobalToolsList` + `ToolRow`；整理、清理隐藏、检查更新三个自带逻辑的条目也是 `ToolRow`，做完
  emit `done` 让工具箱关闭）、后台任务入口与卡片（共用 `busy/BusyTaskCard`）、`UpdateButton`、`KbTab` 的四处调用、
  `ScrollButtons`、`EmptyState` / `DetailPanelEmptyState`、`SuperModeToggle`、`FileDropOverlay`、启动页、吉祥物气泡。
  同时做了 EP 全局换皮（vendored 包里的 `kb-reskin.scss`，P9 随包删除），没迁的界面观感先行对齐。
- P2：上表的弹层 / 菜单 / 表单 / 展示组件与反馈门面；`ElMessage` 的直接调用（6 个文件）换成 `toast`，`kameMessage as ElMessage`
  的别名改成直呼 `kameMessage`；`ElMessageBox`（31 个文件）换成 `messageBox`；`v-loading`（10 个文件）换成 `vLoading`；
  混用期垫片 `compat.ts`（层级向 EP 计数器取号、暂停 EP 焦点陷阱、新浮层挂进 EP 对话框，P9 删除）。
- P3：画廊整簇——查询行（`KbFilterDropdown` 重写并移出 vendored 包、搜索、路径栏、收藏视图、色桶面板、高级查询、排序控件）、
  网格（`ImageItem` / `ImageContent` / `ImageGridCore`）、自写右键菜单 `ContextMenu.vue`（换成 Reka 下拉在点击处打开，
  调用方不变）、`actions/*` 的图标、树（`KbTreePanel` / `KbTreeRow`）、画廊发起的对话框（加入画册与 `AlbumPicker`、移除确认、
  失败图片、整理、设置选择、壁纸目标选择、`OptionPickerDrawer`）、分页器与每页条数、Android 底部弹层与三个 `AndroidPicker*`、
  `views/Gallery.vue` 的空状态与收集方式选择。
- P4：图片预览（桌面对话框直接用 Reka 原语写，见下）、Android 详情弹窗 `ImageDetailDialog`、两侧详情面板（折叠外壳
  `CollapsibleDrawerPanel`、基本信息、原生元数据、插件描述、标签、`CodeBlock`、壁纸属性面板与属性对话框）、插件快捷预览
  `HoverRevealPanel`（紧凑端换底部 `Sheet`）、显示器布局图；共用表单门面 `KbColor` 提前换成色块 + `Popover` + `ColorPickerPanel`。
  预览不用 `ui/Dialog` 的原因：层级沿用 `useModal` 的栈位（吉祥物按栈位浮在预览上，向层级计数器取号会盖住它，预览里再弹的
  新浮层照常取号在它之上）、点吉祥物不关预览、只做淡入淡出（缩放会让 Panzoom 量到的容器偏小，全屏的 `position: fixed`
  也不能有 transform 祖先）。插件描述给模板 iframe 注入的 `--anime-*` 变量名是插件约定，名字不改、取值来自 `--kb-*`。
- P5：共用表单门面 `common/form/Kb*` 换芯（接口不变，插件参数、壁纸属性、设置页跟着变；`KbColor` 已在 P4）；收集对话框、
  收集表单与其小件（`OutputDirSelect`、`HttpHeadersEditor`、并发 / 重试字段）、`PluginPickerField`（桌面 Combobox 自定义行）、
  三个导入对话框、`MediaPicker`；任务抽屉（`Sheet`）、卡片、计数、右键菜单、运行参数、日志、重试记录。这些文件不再用
  `useModal`：开关直接给 `Dialog` / `Sheet` / `Popover`，紧凑档的 `AndroidDrawer` 不传 `z-index`、自己占栈位，免得 Android
  返回栈登记两次。表单校验见下「表单校验」。

- P6：画册页（`views/Albums.vue` 的紧凑档左右 `Sheet`、新建 / 移动画册 `Dialog`、自写面包屑）、画册树面板与树（`AlbumTreePanel`
  的「+」新建菜单、`AlbumTreeView` 的图标与状态标记）、右栏 `AlbumDetailPanel`、`utils/albumSyncMode.ts` 的图标；畅游页
  （`views/Surf.vue` 的地址栏换 `Autocomplete`、站点卡片、记录详情与帮助对话框）。树里类型只靠图标形状区分、统一中性灰，
  强调色只给收藏的星与「轮播中」。画册的无调用方旧组件 `contextMenu/AlbumContextMenu.vue` 已删。
- P7：插件页（`views/PluginBrowser.vue` 的列表、搜索、与卡片同尺寸的骨架 `plugin/PluginGridSkeleton.vue`、空状态、源管理三列列表、
  新增 / 编辑源与导入源 `Dialog`）、插件详情（`views/PluginDetail.vue` 的安装 / 卸载确认换 `AlertDialog` 的 `action`；`plugin/` 下
  详情主体、配置面板、文档渲染器与目录、PathQL 面板、右侧信息栏、卡片、快捷预览与走马灯、`KbLabel`）、外部导入 `.kgpg` 的
  `import/PluginImportDialog.vue`（开关改 `v-model:open`）。插件文档看图换成新组件 `Lightbox`。

- P8：运行配置页（`views/AutoConfigs.vue` 与 `components/scheduler/` 全部：卡片与插件卡片同一套外框，定时编辑气泡 `Popover` +
  `ScheduleSpecEditor`（`SegmentedControl`、快捷取值胶囊、`NumberField` / `Select`、新组件 `TimeField`），详情的分节 `DescriptionList`
  与 `TaskRunParamsContent` 一致，进度条 `Progress` + 自算倒计时，编辑去掉 `el-form`、来源改用 `PluginPickerField`；漏跑提醒点遮罩不关、
  关闭即「稍后再说」）、设置页与设置对话框（`views/Settings.vue`、`components/settings/` 全部，左导航与 `KbMenuList` 的选中项改中性浅灰块、
  强调色只在图标上；开关不再有 `before-change`，受控的 `Switch` 在 `@update:model-value` 里写入、失败时显示值不变；滑块拖动只改本地值、
  `commit` 才保存；`LanguageSetting` 紧凑档用 `AndroidPickerSelect`）、检查更新与下载进度、应用日志（级别多选用 Reka `ToggleGroup`，
  模块前缀是 `Autocomplete` 的草稿值、回车 / 选中 / 失焦才生效）、吉祥物历史对话框；吉祥物、工具箱注册表、外链选择的图标换 lucide。
  这些文件都不再借 `useModal`。`CodeBlock` 的复制按钮改为单独一列（pre 的右内边距会随横向滚动一起滚走，长单行会钻到按钮底下）。
  至此业务界面不再有 EP 组件。
- P9：确认框门面换成自己的实现（`MessageBoxHost`）；`PickerSheet` 的 `van-picker` 换成自写的滚轮 `WheelColumn`；删掉混用期垫片
  （`compat.ts`、`kb-compat.css`）与全部 `TODO:[REF_UI]` 代码，层级改由 `layer.ts` 自己的计数器给；删掉 vendored element-plus /
  icons、Vant、`el-config-provider`、全局图标注册、`vCornerBadge`、`dialogs.css`、`vant-theme.css` 与接线；无调用方的
  `GalleryPageSizeControl` / `SearchInput` / `EdgeArrows` 删除；Uno 快捷方式 `kb-chip` / `kb-grad` 删除，`kb-card` 改取 token。

**表单校验**（P5，`components/ui/form.ts` + `Field`，取代 `el-form` 的 `validate` / `rules` 与 async-validator）：

- 表单根组件里 `const form = useForm()`（向子孙 provide 上下文），字段写 `<Field :validator="() => 错误文字或 undefined">`，
  提交时 `if (!form.validate()) return;`。`validate()` 让所有已挂载的 Field 显示错误、把第一个出错的滚进视野；`reset()` 回到不显示。
- 显示时机：某个 Field 的校验结果变过一次（用户改过值）之后实时显示；没改过也没提交过的空必填项不提前标红。
  调用方自己算好的 `error` 优先于 `validator`。
- 被 `v-if` 隐藏的 Field 卸载即注销，不参与校验（插件变量的 `when` 就靠这一条）。
- 插件变量的校验是纯函数 `utils/pluginVarForm.ts` 的 `varFieldError(varDef, value, 显示名, { ignoreRequired })`，
  `PluginVarsForm` 每个字段一个 `Field`，注册进最近的 `useForm()`（P8 起已没有 `el-form`：`AutoConfigDialog`、
  `PluginDefaultConfigsPanel`、`PluginConfigPanel` 都是一个表单一个 `useForm()`，名称、来源等字段与插件变量一起校验）。
- `KbIntegerInput` 不再调 `useFormItem`：整数文本的实时校验由 Field 的 validator 随值跟随。

**过滤 chip 下拉**（`KbFilterDropdown`，`components/ui/FilterDropdown.vue` + 类型与上下文 `filterDropdown.ts`）：

- 本质是「chip 触发器 + 浮层」的通用单选器，画廊查询行、高级查询条件行、自动任务页的筛选共用。两种面板：给 `options`
  （可带 `count`）由组件渲染内置列表（可搜索、键盘上下 / 回车），或用 `#panel` 插槽整体自定义（过滤树、搜索模式 + 输入框）。
- 选项可带 `expandable: true`：点它不选中、不关闭，在它下方就地展开 `#option-panel="{ option, close }"`，调用方在里面完成
  选择后调 `close()`（画廊排序「颜色」一行的色桶面板）。同一时间至多展开一个，重新打开时收起。
- `clearable`（默认 `true`）：过滤维度有「任意」行、选中后 chip 进淡强调色态并在右上角出清除徽章；排序这类恒有值的传
  `false`，三者都关掉。`chipAction="toggle"` 不开面板、点 chip 发 `toggle`（升序 / 降序）。
- `chipDisplay` 控制 chip 信息密度（`full` / `value` / `icon`），收掉的维度名与取值由 `title` 在悬停提示里补回。
- 承载方式由祖先 `provide(kbFilterDropdownContextKey, { panelMode })` 决定：`App.vue` 在紧凑布局下给 `dialog`（居中
  `Dialog`），否则是 chip 下方的 `Popover`。Android 返回栈由组件自己接（`useModalBack`），上下文里不再有 `bindVisible`。
- 弹层按 chip 元素定位（`reference`），chip 不是 Reka 的触发器，所以点 chip 本身由 `@pointer-down-outside` 判成「层内」、
  交给 chip 的 click 切换，关闭时自己把焦点还给 chip。
- 面板里再弹出的子层（`Popconfirm`、编辑浮层、`Select`）都是 Reka 层，Reka 按层在 DOM 里的先后把它们算作层内，点它们
  **不会**关掉外层面板，所以没有 EP 版的 `clickOutsideIgnore`（收藏视图、色桶面板里给子层挂豁免类的做法已删）。
- 面板给里面的过滤树设好 `--kb-tree-row-*` 变量（文字、计数、悬停、选中），内置列表与树同一套颜色。

**写法约定**

- 仓库没有 Tailwind 式 reset：`border` 要配 `border-solid`，`button` 要自己清边框、内边距与字体
  （`Button` 的基础类已处理）。
- 组件的变体类表写在 `.vue` 里：UnoCSS 默认不扫描 `.ts`，写在 `.ts` 里的类不会生成。
- 颜色是 CSS 变量，`/50` 这类透明度修饰不生效；需要半透明就在 `tokens.css` 加 token，或写
  `bg-[color-mix(in_srgb,var(--kb-danger)_10%,transparent)]`。
- 没有 tailwind-merge：调用方再加一个同类工具类（如 `text-*`）覆盖不了变体，CSS 顺序说了算。要不同的
  颜色就加变体（`ghost-danger` 即如此），不要在调用处叠类。
- 禁用的按钮 `pointer-events: none`，`Tooltip` 要包在外面一层 `span` 上才能在禁用时弹出。
- 弹层触发器外面可以直接套 `Tooltip`（`<Tooltip><PopoverTrigger as-child><button/>`）。Reka 的 Tooltip 自己也是
  一个 Popper，触发器默认的锚点登记会被就近的 Tooltip 收走、浮层停在 (0,0)；我们的 `DropdownMenuContent` /
  `PopoverContent` 因此显式把 `reference` 设成触发器元素。直接用 Reka 原语写新的弹层组件时也要这样做。
- 工具箱这类「整行可点 + 右侧开关」的行，开关只做状态显示（`as="span"`、`pointer-events-none`、`aria-hidden`），
  否则 `button` 套 `button`，且点在开关上会切两次。
- IDE 的 Tailwind v4 插件会提示把 `z-[var(--x)]` 写成 `z-(--x)`，那是 v4 语法，presetWind3 不认，忽略。
- 菜单面板、菜单项、输入类控件的外框是 Uno 快捷方式 `kb-menu-panel` / `kb-menu-item` / `kb-control`（`uno.config.pub.ts`），
  新写这几类组件时直接用，保持一致。
- 动作菜单项（`actions/*Actions.ts` 的 `ActionItem.icon`）放图标组件本身；要按上下文换图标（收藏 / 已收藏）就用
  `iconBy(ctx => …)` 包出解析器，渲染处一律经 `resolveActionIcon` 取图标。lucide 图标本身是函数，不能再用
  `typeof icon === "function"` 判断是不是解析器。lucide 没有的实心变体放 `components/ui/icons.ts`（`StarFilled`）。
- 查询 chip 的维度图标是设计稿画的那套（`components/icons/filterIcons.ts` 的 `Filter*`，P3 从 vendored 图标包搬进来），
  其余图标一律 lucide。
- 页面级的键盘 / 滚轮 / 点击处理要给浮层让路时，用 `layer.ts` 的 `isInAnyLayer(target)`（对话框、菜单、Reka 定位容器、
  提示消息都算层内），不要在业务里各写一份 `closest(...)`。
- 改 `uno.config.pub.ts` 后，跑着的 dev 不会自动重载（它是被 `apps/kabegame/uno.config.ts` 间接引入的），
  `touch apps/kabegame/uno.config.ts` 即可；改 `bootstrap/app.ts`（如新增全局 css）要整页刷新。

**token 方向**：
- **`tokens.css`** 是唯一来源：中性色（文字 `--kb-fg` / `-muted` / `-subtle` / `-regular`、底、线、填充）是新值；
  `--kb-accent` / `--kb-danger` / `--kb-success` / `--kb-warning` / `--kb-ring` 挂在 `--anime-*` 品牌色上，插件详情运行时
  局部改写 `--anime-*` 换肤仍能波及。主操作是墨色 `--kb-primary`。
- **旧主题变量**：`anime-theme.css` 里中性的 `--anime-*`（文字、边框、底色、阴影）指向 `--kb-*`，业务 scoped 样式里残留的
  `--anime-*` 因此也是中性外观；品牌色 `--anime-primary` / `--anime-secondary` 不变。新代码直接用 `--kb-*` / `kb` 色板。
- 插件描述给模板 iframe 注入的 `--anime-*` 五个变量是插件约定，名字不改、取值来自 `--kb-*`。

**层级**（`components/ui/layer.ts`）：

- 浮层不用固定 z-index。打开时 `useLayerZIndex(open)` 向全局计数器取号（3000 起、只增不减），后打开的总在上面；提示消息每推
  一条取一次（`nextLayerZIndex()`）。直接用 Reka 原语写新弹层时也要接它。
- 例外是桌面图片预览：沿用 `useModal` 的栈位（2000 起），吉祥物按栈位浮在预览之上；预览里再弹出的浮层照常取号（3000 起）在它之上。
- 层的 `@pointer-down-outside` / `@focus-outside` / `@interact-outside` 接 `keepOpenOnToast`：点提示消息（关闭按钮、滑动关闭）
  不关当前层——提示挂在 body 下、不属于任何层。层与层之间的「层内」由 Reka 按层栈自己判断，不需要额外处理。

**滚轮选择**（`PickerSheet` + `WheelColumn`，P9 起取代 `van-picker`）：

- `PickerSheet` 是底部 `Sheet` 里一到多列滚轮，`v-model:open` 开合、`v-model` 是各列的值（滚动停稳即更新），「确定」发
  `confirm({ selectedValues, selectedOptions, selectedIndexes })` 并关闭；取消就是关闭（遮罩、Esc、返回键）。
- `columns` 三种写法同原 van-picker：单列选项数组、多列的列数组、带 `children` 的级联（后一列取前一列选中项的 children，前一列
  变了后面的列落到仍存在的值或第一项）。值不在选项里时按第一项算。
- `WheelColumn` 是原生滚动 + `scroll-snap`，惯性与回弹交给浏览器；停稳（`scroll` 之后 120 ms 无新事件）才发值，点某一项滚到它，
  方向键 / Home / End 逐项移动；点「确定」时惯性还没停，按此刻位置取值（`settle()`）。
