# 组件库：kabegame 自有 element-plus（vendored fork）

**结论先行：本仓不再依赖 npm 的 `element-plus` / `@element-plus/icons-vue`。**
两者都已 vendor 进仓，作为**自有组件库**维护，不跟上游。写代码时不要再从 `"element-plus"`
导入任何东西，也不要按「第三方库覆盖」的思路给它加 hack CSS。

| | 包名 | 路径 | vendor base |
| --- | --- | --- | --- |
| 组件 | `@kabegame/element-plus` | `packages/kabegame-element-plus/` | element-plus tag `2.13.0`（commit `21ff9b1`） |
| 图标 | `@kabegame/element-plus-icons` | `packages/kabegame-element-plus-icons/` | element-plus-icons tag `v2.3.2` |

各自的包内 README 记录了与上游的逐项结构差异，这里只写**跨包的约定与踩坑**。

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
   `src/`。与 `@kabegame/core` 同一套约定：纯源码消费，无构建产物。
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
44 个文件、208 行 `.el-*`（大头：`packages/kabegame-core/src/styles/anime-theme.css` 46 行、
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
`packages/kabegame-core/src/components/common/form/KbDate.vue` 由此从 194 行日历皮肤降到 **0 行 `.el-*`**。

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

## 自有组件放哪

既然是自有组件库，**新写的通用组件可以直接进 vendored 包**，不必挤在 `kabegame-core`。
已有先例：`ElTabs` / `ElTabPane` 整个删掉，换成
`@kabegame/element-plus/components/kb-tab` 的 `KbTab`（只管 tab 头本身，内容由调用方按
`v-model` 自行切换）。

另一个先例是 `kb-filter-dropdown` 的 `KbFilterDropdown`。名字来自第一个用例（画廊过滤
维度），但它本质是**「chip 触发器 + 浮层」的通用单选器**，两种形态：

- **内置列表**：给 `options`（可带 `count`），组件自己渲染选项行。行高 32 / 圆角 6 /
  hover 与选中的粉色浓度都对齐 `ProviderChildrenNode`，因为同一层弹层里内置列表与
  过滤树面板会混用，尺寸和配色不一致会很扎眼。
- **`#panel` 插槽**：一旦用了插槽，内置列表整个不渲染，浮层内容完全由调用方决定
  （过滤树、搜索模式 + 输入框都是这么接的）。此时面板宽度交给内容（`is-custom`），
  不再走内置列表那条 `clamp(260px, 24vw, 340px)`。

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
