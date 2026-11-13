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

另一个先例是 `kb-filter-dropdown` 的 `KbFilterDropdown`。名字来自第一个用例（画廊过滤
维度），但它本质是**「chip 触发器 + 浮层」的通用单选器**，两种形态：

- **内置列表**：给 `options`（可带 `count`），组件自己渲染选项行。行高 32 / 圆角 6 /
  hover 与选中的粉色浓度都对齐 `ProviderChildrenNode`，因为同一层弹层里内置列表与
  过滤树面板会混用，尺寸和配色不一致会很扎眼。
- **`#panel` 插槽**：一旦用了插槽，内置列表整个不渲染，浮层内容完全由调用方决定
  （过滤树、搜索模式 + 输入框都是这么接的）。此时面板宽度交给内容（`is-custom`），
  不再走内置列表那条 `clamp(260px, 24vw, 340px)`。

面板里再弹出、teleport 到 body 的子层（浮层、popconfirm）点了会被当成「外部」，连带关掉面板。
`KbFilterDropdown` 的 `clickOutsideIgnore`（CSS 选择器，透传到 tooltip 内容的 `onClickOutside`
`ignore`）用来豁免它们，子层自己挂上对应的类即可；popconfirm 为此补了可追加的 `popperClass`。
用例见 [收藏视图](../gallery/SAVED_VIEWS.md)。dialog 档（紧凑模式）没有点外部关闭，不需要。

内置列表的选项可以带 `expandable: true`（`KbFilterDropdownOption`）：点这一行**不选中、不关闭**，而是在它下方
就地展开一块区域，内容由调用方的 `#option-panel="{ option, close }"` 插槽给；调用方在面板里完成选择后自己发
导航 / 改值并调 `close()` 关掉整个下拉。组件只管展开收起：同一时间至多展开一个，面板重新打开时收起；行尾有一个
随展开转向的箭头；键盘上 Enter（焦点在面板容器上时还有空格）切换展开；展开区落在滚动区之外时自动滚进视野。
用了 `#panel` 插槽（整体自定义面板）时不渲染展开区。选它而不是侧向弹出二级浮层，是因为同一个下拉在窄屏上是
居中对话框，侧向浮层放不下，就地展开在两种承载方式下都成立，也没有「点了子浮层把父面板关掉」的问题——
展开区里再 teleport 出去的层（如 popconfirm）仍要靠 `clickOutsideIgnore` 豁免。用例是画廊排序下拉的「颜色」
一行，展开区是色桶面板（[COLOR_PALETTE.md](../gallery/COLOR_PALETTE.md)「色桶面板」）；`modelValue` 仍可以等于这
一行的 `value` 来点亮它，选中值的实际含义（哪个颜色）由调用方自己持有。

`clearable`（默认 `true`）区分两种语义：过滤维度可清空——有「任意」行、选中后 chip
右上角出清除徽章、chip 进粉色高亮态；排序 / 每页条数这类**恒有值**的必选场景传
`false`，三者全部关掉——恒有值时高亮不构成对比，只会满行发亮。

仍是 el-dropdown 的地方分两类：**值选择器**（画册页排序/每页、失败图按插件过滤等）
该逐步换过来；**动作菜单**（编辑/复制/删除、header 折叠动作）没有 `modelValue` 语义，
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

**现有组件**：`Button`（`primary` 墨色实心 / `outline` / `ghost` / `ghost-danger`，尺寸 `sm` / `md` / `icon` /
`icon-sm` / `icon-xs`，可做 Reka 触发器的 as-child 子元素）、`Tooltip`（`content` 为空不弹，自带 Provider）、
`DropdownMenu` + `DropdownMenuContent` / `DropdownMenuItem` / `DropdownMenuSeparator` / `DropdownMenuTrigger`、
`Popover` + `PopoverContent` / `PopoverTrigger` / `PopoverAnchor`（根组件都已接 `useModalBack`；`Popover` 默认非模态）、
`Tabs`（分段式选项卡，`items: TabItem[]` 接口同原 `KbTab`：计数、行内角标、可删除、动作项；只管 tab 头，
内容由调用方按 v-model 切换）、`Switch`（开是墨色）、`Progress`（`value` 为 null 是不定进度；`accent` / `danger` /
`neutral`）、`Empty`（`#icon` / `#image` + 标题 + 说明 + `#actions`）、`CountBadge`（右上角计数，`accent` / `danger`）。

**已迁移**：
- P0：`PageHeader` 与所有顶栏功能按钮（注册表 `header/headerFeatures.ts` 的图标已换成 lucide）、`CollectAction`、
  插件详情顶栏、画廊副标题与查询行行尾的清除过滤。查询行的 chip（`KbFilterDropdown`）还在这个包里，但 token map
  已改取 `--kb-*`。
- P1：`App.vue` 布局与侧栏导航（`el-config-provider` 留到 P9）、底部导航、工具箱（`GlobalToolsPopover` /
  吉祥物气泡共用 `GlobalToolsList` + `ToolRow`；整理、清理隐藏、检查更新三个自带逻辑的条目也是 `ToolRow`，做完
  emit `done` 让工具箱关闭）、后台任务入口与卡片（共用 `busy/BusyTaskCard`）、`UpdateButton`、`KbTab` 的四处调用、
  `ScrollButtons`、`EmptyState` / `DetailPanelEmptyState`、`SuperModeToggle`、`FileDropOverlay`、启动页、吉祥物气泡。
  同时做了 EP 全局换皮（下面「token 方向」），没迁的界面观感也已对齐。

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
- **单个组件迁到新外观**时，它的 token map 改取 `--kb-*`（`KbFilterDropdown` 是第一个）；`--kb-accent` /
  `--kb-danger` / `--kb-success` / `--kb-warning` / `--kb-ring` 挂在 `--anime-*` 上，插件详情运行时改写 `--anime-*`
  换肤仍能波及。中性色（文字、底、线、填充）是新值，不来自 `--anime-*`。

**层级**：element-plus 的弹出层从 3000 起递增（`App.vue` 的 `el-config-provider`），Reka 浮层用
`--kb-z-popover`（3000）/ `--kb-z-tooltip`（3100），内容元素上的 `z-index` 会被 Reka 复制到定位外层。

**混用期的已知问题**：Reka 菜单项打开 element-plus 对话框后，焦点会回到菜单触发器（菜单关闭动画期间
对话框遮罩盖上来，触发菜单项的 `pointerleave`，Reka 把焦点移回菜单内容，关闭后还给触发器）。鼠标操作
不受影响；对话框迁到 Reka 后自然消失。另外 Reka 的模态浮层打开期间给 `body` 设 `pointer-events: none`，
这时打开的 element-plus 浮层（挂在 `body` 下）点不了，所以弹层类组件要成组迁移。
