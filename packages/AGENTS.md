# AGENTS.md

本文件适用于 `packages/**`。

## 目录类型与维护边界

- `kabegame-i18n/` 是主仓库直接维护的共享前端包。
- `kabegame-plugin-sdk/`、`kabegame-types/`、`photoswipe-vue/` 是独立 git submodule。修改应在各自
  子仓库中完成并提交，主仓库只更新对应 gitlink；不要用主仓库的批量格式化改写这些目录。
- `kabegame-pathql-client/` 是生成型 workspace 包：`package.json` 外壳入库，保证
  `@kabegame/pathql-client` 可作为 workspace 成员安装；`index.ts` 是生成物，不入库。

## 组件库不在 packages 里

前端组件库是 app 内的 `apps/kabegame/src/components/ui/`（reka-ui + UnoCSS），不是 workspace 包。原来的 vendored
`kabegame-element-plus/`、`kabegame-element-plus-icons/` 已在界面重构 P9 删除，不要再建组件库包；见
[`cocs/ui/COMPONENT_LIBRARY.md`](../cocs/ui/COMPONENT_LIBRARY.md)。

## 格式化边界

根命令 `deno task format` / `deno task format:check` 会把 `packages/` 交给 Prettier，但以下内容由
`.prettierignore` 排除：

- 三个 git submodule：`kabegame-plugin-sdk/`、`kabegame-types/`、`photoswipe-vue/`。Prettier 只认
  目录树、不认 submodule，批量格式化会直接写进独立仓库并留下无法随主仓提交的脏改动。
- 生成物 `kabegame-pathql-client/index.ts`。

其余格式约束以 [`.cursor/rules/code-formatting.mdc`](../.cursor/rules/code-formatting.mdc) 为准。

## PathQL 客户端生成

```bash
deno task pathql:generate
```

命令由 `scripts/generate-pathql-client.ts` 实现：默认先增量构建 debug `kabegame-cli`，再执行
`pathql generate`；传 `--skip-build` 时复用现有二进制。新 checkout 或修改 DSL 后必须先生成，
否则前端 vue-tsc / Vite 构建会因缺少 `kabegame-pathql-client/index.ts` 明确报错。
