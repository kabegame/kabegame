# @kabegame/element-plus

Vendored 的 element-plus 源码，**已 fork，不跟上游**。

- vendor base：`element-plus` tag `2.13.0`（无 `v` 前缀），commit `21ff9b11658f696cee2ebda404ba785001ed58cb`
- 上游仓库：<https://github.com/element-plus/element-plus>
- 许可证：MIT，见 [LICENSE](./LICENSE)

## 为什么 vendor

Element Plus 的默认设计撑不住 kabegame 的二次元主题，全仓靠后置 CSS 覆盖硬掰（约 1733 行、
147 处 `!important`），且这些覆盖与 EP 内部 DOM 强绑定，升级即碎。vendor 之后把主题写进组件
自身，类名与 CSS 变量前缀统一为 `kb-el` / `--kb-el-*`，业务侧不再出现任何 `.el-*` 选择器。

## 与上游的结构差异

上游是 pnpm 多包 monorepo（`packages/{components,hooks,utils,...}` 各自成包，互相以
`@element-plus/*` + `workspace:` 引用）。本仓用 Deno 的 npm workspace，**不认嵌套子
workspace**，故已平铺成单包：

| 上游 | 这里 |
| --- | --- |
| `packages/element-plus/*.ts`（入口包） | `src/*.ts` |
| `packages/{components,constants,directives,hooks,locale,theme-chalk,utils}` | `src/<同名>` |
| `@element-plus/<子包>` 内部 specifier | `@kabegame/element-plus/<子包>` |
| `typings/{env,style}.d.ts` | `src/{env,style}.d.ts` |

`@element-plus/icons-vue` 是独立的 npm 包，不在 vendor 范围内，specifier 保持原样。

其余已删除的上游内容：`internal/`（构建链）、`docs/`、`play/`、`__tests__/`、`test-utils`、
`scripts/`、各子包 `package.json`、`pnpm-workspace.yaml` / `pnpm-lock.yaml`、vitest/eslint 配置、
每个组件的 `style/css.ts`（引用的 `theme-chalk/el-*.css` 是构建产物，源码树里不存在）。
`src/locale/lang` 只保留 kabegame 支持的 5 种语言：`en` / `ja` / `ko` / `zh-cn` / `zh-tw`。

## 消费方式

纯源码消费，无构建产物，与 `@kabegame/core` 同一套约定：

- vite alias：`vite.config.pub.ts` 里 `@kabegame/element-plus` → 本目录 `src/`
- 类型：根 `tsconfig.json` 与 `apps/kabegame/tsconfig.json` 的 `paths`（后者会整体覆盖前者的
  `paths`，两处都要写）
- 样式：`src/theme-chalk/src/index.scss` 可被 sass 独立编译，内部 `@use` 全是相对路径

## 本仓已做的改动

- `src/version.ts` —— 上游由构建脚本从 package.json 生成，这里手写常量。
- `src/env.d.ts` —— 删去 `declare global { const process }`（与根 `@types/node` 冲突）；
  补 `/// <reference types="vue/jsx" />`，本包的 `.tsx`（table-v2 / avatar 等）需要全局
  `JSX.IntrinsicElements`，而根 tsconfig 只设了 `"jsx": "preserve"`。
- `src/index.ts` —— 加 `/// <reference path="./env.d.ts" />`，让 `App[INSTALLED_KEY]` 的模块增强
  进入编译程序。
- **date-picker 主题下沉**：`$datepicker` token map 直接取 `--anime-*`，并追加
  `active-bg` / `hover-bg-color` / `today-ring-color` / `disabled-text-color` /
  `cell-radius(-large)`；日/月/年表与 popper 的选择器改在组件自身。业务侧
  （`components/common/form/KbDate.vue`）不再有任何 `.el-*` 覆盖。
  注意 `.el-picker__popper` 的 border 必须写成 `&.el-popper.is-light`——
  `popper.scss` 里的 `.el-popper.is-light` 特异性相同且排在后面。
- **`tabs` 组件已删除，由 `kb-tab` 取代**（`ElTabs`/`ElTabPane` 不再导出）。KbTab 只管
  tab 头本身，内容由调用方按 v-model 自行切换。样式走 SFC scoped，不进 theme-chalk。
- **新增 `kb-filter-dropdown`**：画廊 facet 等场景共用的 chip + 双列计数面板，复用
  `ElTooltip`/Popper 基建；支持本地搜索、loading/empty、排除计数、键盘选择及整体面板插槽，
  样式和 `--anime-*` 映射统一位于 theme-chalk。

## 待办

前缀改 `kb-el`、其余 hack 样式合并、组件改名 `KbEl*` 等，见
[cocs/ui/COMPONENT_LIBRARY.md](../../cocs/ui/COMPONENT_LIBRARY.md) 的「剩余工作」。
