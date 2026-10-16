# AGENTS.md

本文件适用于 `packages/**`。

## 目录类型与维护边界

- `kabegame-i18n/` 是主仓库直接维护的共享前端包。
- `kabegame-element-plus/`、`kabegame-element-plus-icons/` 是主仓库内维护的 vendored fork，
  不跟随 npm 上游包自动升级。
- `kabegame-plugin-sdk/`、`kabegame-types/`、`photoswipe-vue/` 是独立 git submodule。修改应在各自
  子仓库中完成并提交，主仓库只更新对应 gitlink；不要用主仓库的批量格式化改写这些目录。
- `kabegame-pathql-client/` 是生成型 workspace 包：`package.json` 外壳入库，保证
  `@kabegame/pathql-client` 可作为 workspace 成员安装；`index.ts` 是生成物，不入库。

## 组件库——fork 自 element-plus

本仓**不再依赖 npm 的 `element-plus` / `@element-plus/icons-vue`**，两者已 vendor 成自有组件库并
fork 维护（不跟上游）。**不要从 `"element-plus"` 导入任何东西**：

```ts
import { ElButton, ElMessageBox } from "@kabegame/element-plus";
import { ArrowLeft } from "@kabegame/element-plus-icons";
```

类名前缀目前仍是 `el-`（namespace 开关未翻），但**不要按「第三方库覆盖」的思路加 hack CSS**——
给组件加主题一律下沉到 `kabegame-element-plus/src/theme-chalk/src/common/var.scss` 的 token map
（方向恒为 `--kb-el-* ← --anime-*`），而不是在业务侧写 `.el-xxx { ... }`。新写的通用组件可以直接
进 vendored 包（`KbTab` 已取代删掉的 `ElTabs`）。

接线有三处必须同步：vite alias、根与 `apps/kabegame` 的 tsconfig `paths`（app 的是**整体覆盖**不合并）、
web 的 `manualChunks`。改任何前端组件或样式前先读
[`cocs/ui/COMPONENT_LIBRARY.md`](../cocs/ui/COMPONENT_LIBRARY.md)。

## 格式化边界

根命令 `deno task format` / `deno task format:check` 会把 `packages/` 交给 Prettier，但以下内容由
`.prettierignore` 排除：

- 三个 git submodule：`kabegame-plugin-sdk/`、`kabegame-types/`、`photoswipe-vue/`。Prettier 只认
  目录树、不认 submodule，批量格式化会直接写进独立仓库并留下无法随主仓提交的脏改动。
- 两个 vendored fork：`kabegame-element-plus/`、`kabegame-element-plus-icons/`。整包格式化会让
  vendor 差异难以阅读。
- 生成物 `kabegame-pathql-client/index.ts`。

其余格式约束以 [`.cursor/rules/code-formatting.mdc`](../.cursor/rules/code-formatting.mdc) 为准。

## PathQL 客户端生成

```bash
deno task pathql:generate
```

命令由 `scripts/generate-pathql-client.ts` 实现：默认先增量构建 debug `kabegame-cli`，再执行
`pathql generate`；传 `--skip-build` 时复用现有二进制。新 checkout 或修改 DSL 后必须先生成，
否则前端 vue-tsc / Vite 构建会因缺少 `kabegame-pathql-client/index.ts` 明确报错。
