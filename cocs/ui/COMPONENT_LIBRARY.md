# 组件库：kabegame 自有 element-plus（vendored fork）

**结论先行：本仓不再依赖 npm 的 `element-plus` / `@element-plus/icons-vue`。**
两者都已 vendor 进仓，作为**自有组件库**维护，不跟上游。写代码时不要再从 `"element-plus"`
导入任何东西，也不要按「第三方库覆盖」的思路给它加 hack CSS。

| | 包名 | 路径 | vendor base |
| --- | --- | --- | --- |
| 组件 | `@kabegame/element-plus` | `packages/kabegame-element-plus/` | element-plus tag `2.13.0`（commit `21ff9b1`） |
| 图标 | `@kabegame/element-plus-icons` | `packages/kabegame-element-plus-icons/` | element-plus-icons tag `v2.3.2` |

各自的包内 README 记录了与上游的逐项结构差异，这里只写**跨包的约定与踩坑**。

> **界面重构进行中**：新界面不再往这个包里加组件，而是用 `reka-ui`（无头原语）+ UnoCSS 写在
> `apps/kabegame/src/components/ui/`，颜色取 `styles/tokens.css` 的 `--kb-*`。见文末
> [新界面组件](#新界面组件reka-ui--设计-token)。这个包会逐步被取代，迁移期间仍按下面的约定维护。

## 为什么 vendor

根因不是「EP 不好用」，而是**项目从没覆盖过 EP 的全局 token**：`--el-color-primary` 一个都没改，
却逐个重写具体类的 `background` / `border-radius`。于是每加一个组件就要重来一遍，特异性军备
竞赛越打越高——vendor 前是 49 个文件、约 1733 行覆盖、147 处 `!important`。

而且这些覆盖与 EP 内部 DOM 强绑定（例如日历皮肤依赖「EP 2.13 起复用日表的
`.el-date-table-cell` 结构」），升级 EP 就会碎。

vendor 之后主题写进组件自身，覆盖层逐步消失。**升级路径已明确放弃**：不再跟上游，拿不到
上游 bugfix 与未来 Vue 版本适配，换来可以放手改内部实现。

## 接线（三处，改动时要一起改）

1. **vite alias** —— `vite.config.pub.ts` `resolve.alias`，`@kabegame/element-plus{,-icons}` 指向各自
   `src/`。约定是纯源码消费，无构建产物。
2. **tsconfig `paths`** —— 根 `tsconfig.json` **和** `apps/kabegame/tsconfig.json` **两处都要写**。
   app 的 `paths` 是**整体覆盖**而非与父级合并，只改根的不生效。
3. **web 的 `manualChunks`** —— `apps/kabegame/vite.config.ts`。vendored 源码在 `packages/` 下
   **不在 node_modules**，两条路径判断必须放在 `if (!id.includes("node_modules")) return undefined`
   这道闸门**之前**，否则整包并进主 bundle。且 `-icons` 要判在 `element-plus` 之前，否则被前缀吞掉。

另外根 `package.json` 需要 `@vitejs/plugin-vue-jsx`，`vite.config.pub.ts` 的 plugins 里要有
`vueJsx()`：vendored 包有 31 个 `.tsx`（form-label-wrap / date-picker / table-v2 等），没有它
esbuild 会按 React 语义编译 JSX，运行时报 `React is not defined`。

## 前缀现状：**还是 `el-`**

类名与 CSS 变量全部由两个开关派生，目前都还是 `'el'`：

- `packages/kabegame-element-plus/src/theme-chalk/src/mixins/config.scss` → `$namespace: 'el' !default`
- `packages/kabegame-element-plus/src/hooks/use-namespace/index.ts` → `defaultNamespace = 'el'`

组件里一律 `useNamespace('button')` 再 `ns.b()/ns.e()/ns.m()/ns.is()`，没有硬编码类名；
CSS 变量走同一个 `$namespace`（`--#{$namespace}-color-primary`）。所以把这两个值改成 `kb-el`，
DOM 就变 `.kb-el-button`、变量就变 `--kb-el-color-primary`，源码其余部分一行不用动。

**翻开关前必须先清掉业务侧所有 `.el-*` 选择器**，否则那些覆盖会全部失效。目前业务侧还剩
44 个文件、208 行 `.el-*`（大头：`apps/kabegame/src/styles/anime-theme.css` 46 行、
`apps/kabegame/src/views/Surf.vue` 16 行、`apps/kabegame/src/styles/dialogs.css`）。

翻开关时另需逐项 grep 的漏网处：模板/JS 里字面量的 transition 名（`<transition name="el-zoom-in-top">`，
scss 侧会自动跟着 `$namespace` 变，字面量不会）、`popper-class` / `overlay-class` 之类 prop 默认值、
命令式 API（`ElMessage` / `ElMessageBox` / `ElLoading`）运行时拼 class 的地方。

## 加主题的正确姿势：下沉到 token，不要覆盖具体类

**坏**（vendor 前的做法，不要再写）：在业务 CSS 里写 `.el-button--primary { background: ... }`。

**好**：改 `theme-chalk/src/common/var.scss` 里对应的 token map，让 `--anime-*` 成为唯一色彩真源。
`--anime-*` 已被大量非 EP 的业务样式消费，且插件详情面板会在运行时用 JS 局部覆写它做动态换肤——
EP token 挂在它下面，换肤能自动波及 EP 组件。桥接方向恒为 `--kb-el-* ← --anime-*`，不要反过来。

已落地的范例是 **date-picker**：`$datepicker` token map 直接取 `--anime-*`，并按需追加了
`active-bg` / `hover-bg-color` / `today-ring-color` / `disabled-text-color` / `cell-radius(-large)`；
日/月/年表与 popper 的选择器改在组件自身的 scss 里。业务侧
`apps/kabegame/src/components/common/form/KbDate.vue` 由此从 194 行日历皮肤降到 **0 行 `.el-*`**。

> 踩坑：`.el-picker__popper` 的 border 必须写成 `&.el-popper.is-light`——`popper.scss` 里的
> `.el-popper.is-light` 特异性相同且排在后面，不加会被盖掉。

第二个范例是 **select**（含单选 / 多选 / 下拉面板 / 选项 / 分组标题）：`$select`、`$select-option`、
`$select-group`、`$select-dropdown` 四张 token map 全部取 `--anime-*`，追加了
`border-radius` / `focus-ring` / `hover-ring` / `error-ring` / `disabled-bg-color`（触发器）与
`selected-background` / `border-radius` / `font-size` / `padding`（选项）。多选 tag 的配色只写在
`.el-select__selection .el-tag` 下，不动全局 `el-tag`。

> 踩坑三则：
> 1. `.el-select__popper` 同样要写 `&.el-popper.is-light` 才拿得回 border（同上）。
> 2. EP 用 **inset box-shadow** 当边框，所以「描边 + 外扩光晕」必须写在同一条 `box-shadow` 里，
>    分两条写后者会整条覆盖前者。
> 3. 清除按钮 `.el-select__clear` 的元素上**同时挂着 `.el-select__caret`**，给 caret 写
>    focus 变色时要 `:not(.el-select__clear)` 排除，否则它的粉底徽章会被一起染色。
> 4. `--el-select-*` 由 `set-component-css-var` 挂在 `.el-select` 上，而下拉面板 teleport 到
>    body **不在其内**——面板侧一律用 `map.get($select-dropdown, ...)` 编译期取值，不能用 `getCssVar`。
> 5. **下拉宽度是 fork 改过的默认值**：`select/src/select.ts` 的 `fitInputWidth` 默认 `true`
>    （上游 `false`，与 `select-v2` 对齐），下拉恒等于输入框宽度，不再按选项文案自撑。
>    选项放不下时由 `.el-select-dropdown__item` 的 `ellipsis` 截断，所以**不要在窄触发器里塞长选项**
>    （畅游的插件快速选择就是这种场景，需要内容宽度时显式传 `:fit-input-width="false"`）。

## 自有组件放哪

**tag 的局部色板**：`$tag` 中的 `palette-*` token 将 `--anime-tag-{bg,border,text,hover}-color`
桥接到组件内部；未提供时回退到既有 type / effect 色彩。预览标签按目录注入这些主题变量，
正文与关闭按钮（含 hover）共用色板，业务侧不覆盖 `.el-*` 选择器。

既然是自有组件库，**新写的通用组件可以直接进 vendored 包**，不必挤在 `apps/kabegame/src/components` 里。
已有先例：`ElTabs` / `ElTabPane` 整个删掉，换成
`@kabegame/element-plus/components/kb-tab` 的 `KbTab`（只管 tab 头本身，内容由调用方按
`v-model` 自行切换）。

指令同理：右上角数字 / 圆点角标 `vCornerBadge`（`directives/corner-badge`，样式
`theme-chalk/src/kb-corner-badge.scss`，尺寸与定位照搬 `el-badge` 的 `is-fixed`）放在包里，
`KbTab` 的 `badge` 字段和业务侧（`main.ts` 全局注册为 `v-corner-badge`：导航「插件」图标、
失败图片按钮）共用一份实现。它用宿主 `::after` 绘制、不插入子节点，宿主不能再占用 `::after`；
宿主带 `:class` 绑定时 Vue patch 会重写 `className`，所以指令每次 `updated` 都补回宿主类。

另一个先例是 `KbFilterDropdown`（过滤 chip 下拉），**P3 起已移出本包**，在 app 里用 reka-ui 重写成
`apps/kabegame/src/components/ui/FilterDropdown.vue`（组件名仍是 `KbFilterDropdown`），见文末「新界面组件」。

仍是 el-dropdown 的地方分两类：**值选择器**（画册页排序/每页等）
随所在界面换成新的 `KbFilterDropdown` / `Select`；**动作菜单**（编辑/复制/删除、header 折叠动作）没有 `modelValue` 语义，
不要硬套，将来需要的话另抽一个复用同一套 popper + 选项样式的 `KbActionMenu`。

样式约定按组件性质分流：

- **改 EP 原有组件的主题** → 进 `theme-chalk/src/*.scss`（它是全局 CSS，参与 `index.scss` 汇总）
- **自己新写的组件** → SFC `<style scoped>`，**不要**进 theme-chalk

目前 `src/components/` 下 122 个组件。用不到的可以直接删（`tabs` 就是这么删的），删完记得
同步 `src/component.ts` 的注册清单。

## 图标

`packages/kabegame-element-plus-icons/svg/` 的 293 个 `.svg` 是**真源**；
`src/components/*.vue` 是**生成物但入库**（本仓无构建步骤）。增删图标后重跑：

```bash
deno run -A packages/kabegame-element-plus-icons/scripts/generate.ts
```

组件名由文件名 PascalCase 得到（`d-arrow-left.svg` → `DArrowLeft`），与 npm 包 `2.3.2` 的
293 个导出逐个核对一致。

`apps/kabegame/src/main.ts` 目前仍全量注册 293 个，实际只用到 57 个，待收敛。

## 其它踩坑

- **scss 树自包含**：`theme-chalk/src/index.scss` 内部 `@use` 全是相对路径，可被 sass 独立编译
  （`node_modules/.bin/sass` 直接跑得通，出约 16.8k 行 CSS）。所以不用担心 vite 的 sass importer
  能不能解析包名。
- **`process.env.NODE_ENV`**：vendored 源码里有 11 处。vite 客户端构建会 define 替换，但这是
  运行时行为，vue-tsc 验不出来。
- **`.tsx` 的 JSX 类型**：靠 `src/env.d.ts` 里的 `/// <reference types="vue/jsx" />` 提供全局
  `JSX.IntrinsicElements`（根 tsconfig 只设了 `"jsx": "preserve"`）。`src/index.ts` 另有
  `/// <reference path="./env.d.ts" />` 把 `App[INSTALLED_KEY]` 的模块增强带进编译程序。
- **模板里 `<el-xxx>` 的类型**：靠 `src/global.d.ts` 声明 `GlobalComponents`（由 `env.d.ts` reference 带入）。
  增删 `src/component.ts` 里的组件时同步它；缺了不会报「找不到」，而是整个组件静默退化成 any。
- **`src/version.ts`** 是手写常量，上游由构建脚本从 package.json 生成。
- **验证方式**：类型走 `.claude/skills/check-kabegame/driver.sh --skip cargo`；但 vite 的 alias 与
  SFC 解析 lint 验不出来，改接线后要跑一次 `deno task b -c kabegame --skip cargo` 确认真的能打包
  （检查产物里没有残留的 `@kabegame/element-plus` 裸 specifier，有就是被 externalize 了）。

## 剩余工作

按依赖顺序，**不能跳步**：

1. 继续把业务侧 208 行 `.el-*` 下沉进 vendored 组件。其中一项是
   `apps/kabegame/src/styles/dialogs.css` 的黑名单链——
   `html:not(.platform-android) .el-dialog:not(.a):not(.b):not(.c):not(.d)` 全 `!important`，
   每加一个特殊 dialog 就要回来补一个 `:not()`。改法是把 flex 列布局写成 `dialog.scss` 的默认值，
   给那 4 个例外加一个正向的 `is-freeform` modifier 反向退出。
2. 业务侧 `.el-*` 清零后，才能翻 namespace 两个开关到 `kb-el`（连带处理字面量 transition 名等漏网处）。
3. 组件改名 `KbEl*`、标签改 `<kb-el-*>`、导入改 `@kabegame/element-plus`（约 1500 处标签、118 个文件的导入）。
4. `main.ts` 的图标注册从全量 293 收敛到实际用到的 57 个。

顺带记两个 vendor 期间发现、**尚未修**的既有 bug：

- `apps/kabegame/src/App.vue` 里 `::deep(.file-drop-confirm-dialog)` 是非法语法（Vue 3 是 `:deep()`，
  且该 `<style>` 块本就非 scoped 不需要 deep），整条规则连同内部约 40 行被浏览器丢弃——那段
  「拖入过多文件时限制弹窗高度」的样式大概率从来没生效过。
- 6 个 `--anime-*` 被引用但从未定义：`--anime-bg-secondary`（8 处引用，多数无 fallback）、
  `--anime-primary-rgb`、`--anime-surface`、`--anime-text`、`--anime-text-color`、`--anime-text-regular`。

## 新界面组件（reka-ui + 设计 token）

目标观感是「中性外框 + 一个强调色」的简约风（参照 ChatGPT / Claude 一类应用）。壁纸本身是彩色的，
外框越中性，图越突出；强调色（`--anime-primary` 的粉）只留给选中、焦点、计数。

**三层分工**

| 层 | 位置 | 说明 |
| --- | --- | --- |
| 行为与无障碍 | npm `reka-ui`（Radix 的 Vue 版） | 焦点管理、键盘、点外部关闭、层栈、定位都由它负责，不 fork |
| 样式与组件 | `apps/kabegame/src/components/ui/` | 自己写的薄封装（思路同 shadcn-vue：源码在仓库里），只用 UnoCSS；从 `@/components/ui` 导入 |
| token | `apps/kabegame/src/styles/tokens.css` | `--kb-fg` / `--kb-surface` / `--kb-line` / `--kb-primary` / `--kb-accent` / 圆角 / 阴影 / 层级；UnoCSS 里是 `kb` 色板（`text-kb-fg`、`bg-kb-hover`、`border-kb-line`）与 `rounded-kb-*`、`shadow-kb-*`（`uno.config.pub.ts`） |

图标用 `@lucide/vue`，`bootstrap/app.ts` 经 `LUCIDE_CONTEXT` 把默认线宽设为 1.75。

**现有组件**（dev 下打开 `/dev/ui` 是陈列页 `views/dev/UiShowcase.vue`，含混用场景，改组件后在那里对照）：

| 类 | 组件 | 要点 |
| --- | --- | --- |
| 按钮与小件 | `Button`、`CountBadge`、`Spinner`、`Tag`、`Tooltip`、`HelpTip` | `HelpTip` 是「?」说明（桌面悬停提示、Android 点按气泡），取代 `el-tooltip` + `QuestionFilled`；`Button` 变体 `primary`（墨色实心）/ `danger`（危险色实心）/ `outline` / `ghost` / `ghost-danger`，尺寸 `sm` / `md` / `icon` / `icon-sm` / `icon-xs`，可做 Reka 触发器的 as-child 子元素；`Tag` 五种色调、可关闭；`Tooltip` 的 `content` 为空不弹，自带 Provider |
| 弹层 | `Dialog`、`AlertDialog`、`Lightbox`、`Sheet`、`Popover` + `PopoverContent`、`Popconfirm`、`PickerSheet` | 都用 `v-model:open`，根组件已接 `useModalBack`（调用方不要再套 `useModal`）；`Dialog` 有 `title` / `description` / `width` / `#footer`，`height`（固定高度，正文自己管滚动的工作台）与 `fullscreen`（紧凑档铺满）走内联样式，去正文内边距用 `body-class="!p-0"`；关闭按钮在 DOM 末尾（打开时焦点先落正文）；`AlertDialog` 点遮罩不关，`action` 返回 Promise 时按钮转圈、Esc 不关，完成才关、抛错留在框里；`Lightbox` 是桌面看图（v-model `open` / `index` + `images` URL 数组，方向键翻页、`loop` 关时到头停住，滚轮以光标为中心缩放、放大后拖动、双击切 2 倍，取代 `el-image-viewer`；触屏看图仍用 photoswipe，在对话框里打开时 `append-to` 那个对话框，否则 Reka 模态下 body 不可点）；`Sheet` 四个方向，底部即 Android 底部弹层（把手、安全区）；`Popover` 默认非模态，`PopoverContent` 的 `anchor` 可锚在任意元素上（没有触发器的浮层，如锚在列表某一行的编辑浮层）；`Popconfirm` 是就地的气泡确认（默认插槽是触发按钮，取代 `el-popconfirm`）；`PickerSheet` 是底部滚轮选择（Sheet 里放 `van-picker`，待定 6 定之前保留 Vant） |
| 菜单 | `DropdownMenu` + `DropdownMenuContent`、`ContextMenu`；共用的 `MenuItem`（= `DropdownMenuItem`，`danger` / `shortcut`）、`MenuSeparator`、`MenuSub`、`MenuCheckboxItem`、`MenuRadioGroup`、`MenuLabel` | Reka 的菜单项不依赖根组件类型，下拉与右键共用一套项；`ContextMenu` 默认插槽是触发区域、`#menu` 是菜单，要在某个坐标打开时对触发区域派发带 `clientX` / `clientY` 的 `contextmenu` 事件 |
| 表单 | `Field` + `useForm`、`Input`、`Autocomplete`、`Textarea`、`NumberField`、`Checkbox`、`CheckboxGroup`、`RadioGroup`、`Select`、`Slider`、`RangeSlider`、`Switch`、`SegmentedControl`、`Combobox`、`DatePicker`、`TimeField`、`ColorPickerPanel`、`KbFilterDropdown`；分节标题 `SectionTitle` | `KbFilterDropdown` 见下「过滤 chip 下拉」；`ColorPickerPanel` 是取色面板（v-model `#rrggbb`，饱和度 / 明度区 + 色相条 + 十六进制输入，内部持有 HSB，拖到灰色色相不丢），取代 `el-color-picker-panel`；`RangeSlider` 的 v-model 是 `[起, 止]`；`Field` 给标签 / 说明 / 错误（取代 `el-form-item`，`orientation="horizontal"` 标签在左，`#label-end` 放标签行右侧的附加操作），控件经 `field.ts` 自动拿 id 与出错状态，校验见下「表单校验」。`Select` / `Combobox` / `RadioGroup` / `CheckboxGroup` 用 `options` / `items` 数组；`Select` / `Combobox` 的 `clearable` 清空后 v-model 为 `undefined`，**选项值不能是空字符串**（Reka 的限制，空串表示未选，需要时由调用方编码，见 `KbSelect`）；`Combobox` 给了 `filter` 时只按用户键入的文字过滤（展开时清空，不拿输入框回显的已选文字去匹配）；`DatePicker` 的 v-model 是 `YYYY-MM-DD`，日历气泡 «/» 跳年、‹/› 跳月，`isDateDisabled` 收 `YYYY-MM-DD`；`TimeField` 的 v-model 是 `HH:mm`（Reka TimeField，固定 24 小时制，时 / 分两段可键入或方向键步进，清空某段不更新 v-model；原生 `type=time` 在 CEF 下会显示成 12 小时制）；`Autocomplete` 是自由输入的补全（地址栏）：v-model 是文字本身、`items` 由调用方按文字算好，打字不自动高亮，回车 emit `submit`（原文），只有方向键选中后回车或点击才 emit `select`，焦点始终在输入框、失焦收起；要整体换造型就给 `anchorClass` / `contentClass` / `itemClass` / `inputClass`（整体替换默认类，外框带 `data-open` 供 `data-[open]:` 写展开态）——要「从选项里选一个值」用 `Combobox`；`Input` 的 `inputClass` 加在内层 input 上；`Slider` 拖动中更新 v-model、松手发 `commit`；`NumberField` 清空时是 `undefined`；`SectionTitle` 是长表单的分节标题（取代 `el-divider content-position="left"`） |
| 展示 | `Alert`、`DescriptionList` + `DescriptionItem`、`Empty`、`Progress`、`ScrollArea`、`Separator`、`Skeleton`、`Tabs` | `DescriptionList` 取代 `el-descriptions`；`Tabs` 接口同原 `KbTab`（只管 tab 头）；`Progress` 的 `value` 为 null 是不定进度 |
| 反馈 | `Toaster`（`App.vue` 挂一份）、`toast`、`messageBox`、`vLoading` | 见下「反馈门面」 |

**反馈门面**（P2）：
- `toast`（`components/ui/toast.ts`）：签名同 `ElMessage`——`toast.success(msg)`、`toast({ type, message, duration })`、`toast.closeAll()`，`duration: 0` 不自动关。顶部居中，同类型同文字只留最新一条，最多同时 4 条。业务里多数提示走 `kameMessage`（吉祥物气泡），气泡被遮住时降级到 `toast`；直接调 `toast` 的是不需要吉祥物的地方。
- `messageBox`（`components/ui/messageBox.ts`）：签名同 `ElMessageBox`（`confirm` / `alert` / `prompt` / `close`），**内部仍是 `ElMessageBox`**，P9 换成 Reka AlertDialog，调用处不动。
- `vLoading`（`components/ui/loading.ts`）：在 `<script setup>` 里导入即可，模板照旧写 `v-loading="busy"`（script setup 里的 `vLoading` 优先于 EP 的全局同名指令）。
- service / composable / util 里直接从 `@/components/ui/toast`、`@/components/ui/messageBox` 导入，不经 `@/components/ui`（免得把全部组件拉进来）；测试里 mock 这两个模块，不要再 mock EP 的 `ElMessage` / `ElMessageBox`。

**已迁移**：
- P0：`PageHeader` 与所有顶栏功能按钮（注册表 `header/headerFeatures.ts` 的图标已换成 lucide）、`CollectAction`、
  插件详情顶栏、画廊副标题与查询行行尾的清除过滤。
- P1：`App.vue` 布局与侧栏导航（`el-config-provider` 留到 P9）、底部导航、工具箱（`GlobalToolsPopover` /
  吉祥物气泡共用 `GlobalToolsList` + `ToolRow`；整理、清理隐藏、检查更新三个自带逻辑的条目也是 `ToolRow`，做完
  emit `done` 让工具箱关闭）、后台任务入口与卡片（共用 `busy/BusyTaskCard`）、`UpdateButton`、`KbTab` 的四处调用、
  `ScrollButtons`、`EmptyState` / `DetailPanelEmptyState`、`SuperModeToggle`、`FileDropOverlay`、启动页、吉祥物气泡。
  同时做了 EP 全局换皮（下面「token 方向」），没迁的界面观感也已对齐。
- P2：上表的弹层 / 菜单 / 表单 / 展示组件与反馈门面；`ElMessage` 的直接调用（6 个文件）换成 `toast`，`kameMessage as ElMessage`
  的别名改成直呼 `kameMessage`；`ElMessageBox`（31 个文件）换成 `messageBox`；`v-loading`（10 个文件）换成 `vLoading`；
  混用期垫片（下面「层级与混用期垫片」）。
- P3：画廊整簇——查询行（`KbFilterDropdown` 重写并移出 vendored 包、搜索、路径栏、收藏视图、色桶面板、高级查询、排序控件）、
  网格（`ImageItem` / `ImageContent` / `ImageGridCore`）、自写右键菜单 `ContextMenu.vue`（换成 Reka 下拉在点击处打开，
  调用方不变）、`actions/*` 的图标、树（`KbTreePanel` / `KbTreeRow`）、画廊发起的对话框（加入画册与 `AlbumPicker`、移除确认、
  失败图片、整理、设置选择、壁纸目标选择、`OptionPickerDrawer`）、分页器与每页条数、Android 底部弹层与三个 `AndroidPicker*`、
  `views/Gallery.vue` 的空状态与收集方式选择。
- P4：图片预览（桌面对话框直接用 Reka 原语写，见下）、Android 详情弹窗 `ImageDetailDialog`、两侧详情面板（折叠外壳
  `CollapsibleDrawerPanel`、基本信息、原生元数据、插件描述、标签、`CodeBlock`、壁纸属性面板与属性对话框）、插件快捷预览
  `HoverRevealPanel`（紧凑端换底部 `Sheet`）、显示器布局图；共用表单门面 `KbColor` 提前换成色块 + `Popover` + `ColorPickerPanel`。
  预览不用 `ui/Dialog` 的原因：层级沿用 `useModal` 的栈位（吉祥物按栈位浮在预览上，取 EP 计数器的号会盖住它，预览里再弹的
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
  至此业务界面不再有 EP 组件，剩下的是 P9 的收尾项。

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
  **不会**关掉外层面板，所以新组件没有 EP 版的 `clickOutsideIgnore`（收藏视图、色桶面板里给子层挂豁免类的做法已删）。
  面板里不要再放 EP 的浮层。
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
- 混用期才需要、某一期要删或换实现的代码，注释里带 `TODO:[REF_UI]` 并写明哪一期（P9 以 grep 为收尾清单）。
- 动作菜单项（`actions/*Actions.ts` 的 `ActionItem.icon`）放图标组件本身；要按上下文换图标（收藏 / 已收藏）就用
  `iconBy(ctx => …)` 包出解析器，渲染处一律经 `resolveActionIcon` 取图标。lucide 图标本身是函数，不能再用
  `typeof icon === "function"` 判断是不是解析器。lucide 没有的实心变体放 `components/ui/icons.ts`（`StarFilled`）。
- 查询 chip 的维度图标是设计稿画的那套（`components/icons/filterIcons.ts` 的 `Filter*`，P3 从 vendored 图标包搬进来），
  其余图标一律 lucide。
- 页面级的键盘 / 滚轮 / 点击处理要给浮层让路时，用 `compat.ts` 的 `isInAnyLayer(target)`（新旧浮层都认），不要在业务里写
  `closest(".el-overlay")`。
- 改 `uno.config.pub.ts` 后，跑着的 dev 不会自动重载（它是被 `apps/kabegame/uno.config.ts` 间接引入的），
  `touch apps/kabegame/uno.config.ts` 即可；改 `bootstrap/app.ts`（如新增全局 css）要整页刷新。

**token 方向**：本文前面的规则是 `--kb-el-* ← --anime-*`。界面重构后分三处：
- **EP 全局换皮**（P1）：vendored 包的 `theme-chalk/src/kb-reskin.scss`（`index.scss` 最后引入）在 `:root` 把 `--el-*`
  基础 token 指向 `--kb-*`：主色 = `--kb-primary`（墨色），light-1…9 / dark-2 用 `color-mix` 运行时重算（EP 在编译期
  用 `color.mix` 算梯度，主色是 CSS 变量就算不了，所以不能改 `$colors`）；文字、边框、填充、底色、圆角、阴影、字体、
  遮罩同理。组件级的圆角 / 阴影（对话框、消息框、气泡卡片、卡片）仍在 `common/var.scss` 的组件 map 里改。
- **旧主题变量**：`anime-theme.css` 里中性的 `--anime-*`（文字、边框、底色、阴影）改指向 `--kb-*`，原来对 EP 的
  全局外观覆盖全部删除，只留功能性的（输入框可选中文字、隐藏原生滚动条）。品牌色 `--anime-primary` /
  `--anime-secondary` 不变。
- **单个组件迁到新外观**时，它的 token map 改取 `--kb-*`（`KbFilterDropdown` 是第一个，P3 已移出 vendored 包、map 一并删除）；`--kb-accent` /
  `--kb-danger` / `--kb-success` / `--kb-warning` / `--kb-ring` 挂在 `--anime-*` 上，插件详情运行时改写 `--anime-*`
  换肤仍能波及。中性色（文字、底、线、填充）是新值，不来自 `--anime-*`。

**层级与混用期垫片**（`components/ui/compat.ts` + `styles/kb-compat.css`，P2 建、P9 删，代码处都标了 `TODO:[REF_UI]`）：

- **层级**：新浮层不用固定 z-index。打开时 `useLayerZIndex(open)` 向 EP 的全局计数器取号（`el-config-provider` 的 3000
  是基数，EP 每开一层加 1、只增不减），新旧两边后打开的总在上面。提示消息每推一条取一次。直接用 Reka 原语写新弹层时也要接它。
- **点外部**：Reka 的模态层把 `body` 设成 `pointer-events: none`，并把「点到层外」当作关闭信号。`kb-compat.css` 让挂在
  `body` 下的 EP / Vant 浮层仍可点（里面挂着新浮层的 EP 对话框除外——那时模态层就是新浮层）；新层的
  `@pointer-down-outside` / `@focus-outside` / `@interact-outside` 接 `keepOpenOnForeign`，点到旧浮层或提示消息不关。
- **焦点陷阱与 Esc**：两边各有焦点陷阱，互看对方都在层外会来回抢焦点；EP 的陷阱还在 document 上响应 Esc。
  - 新浮层打开期间 `usePauseForeignTraps(open)` 往 EP 的焦点层栈压一个空层，EP 的陷阱暂停（不抢焦点、不响应 Esc）。
    没有它时，旧对话框里的新对话框 / 选择框按 Esc 会把旧对话框一起关掉。
  - 新浮层的触发器在 EP 对话框 / 抽屉里时，浮层挂进那个对话框（`foreignPortalTarget`，Portal 的 `to`）。
  - 从新对话框里弹 EP 确认框：`messageBox` 用 `withForeignFocus` 在确认框存在期间暂停 Reka 的陷阱（只在有新模态层时）。
  - 菜单项打开 EP 对话框：菜单关闭时不把焦点还给触发器，而是聚焦那个对话框（`keepFocusForForeign`，修掉了 P0 的焦点问题）。
- 新组件按界面成组迁移仍是原则，垫片只兜界面之间的跳转处。实测过的组合：新对话框里的 `el-select`（可搜索）能打开、
  能选、不误关；旧对话框里的新选择框、组合框、下拉菜单（含子菜单）、气泡、新对话框都能用，Esc 只关最上层。
  其它 EP 表单控件没有逐一验证，新界面里不要再放 EP 控件。
