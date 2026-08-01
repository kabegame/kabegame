# @kabegame/element-plus-icons

Vendored 的 element-plus-icons 源码，**已 fork，不跟上游**。与
[@kabegame/element-plus](../kabegame-element-plus/README.md) 配套。

- vendor base：`element-plus-icons` tag `v2.3.2`
- 上游仓库：<https://github.com/element-plus/element-plus-icons>
- 许可证：MIT，见 [LICENSE](./LICENSE)

## 与上游的结构差异

上游是 pnpm 双包 monorepo（`packages/svg` 存原始 SVG，`packages/vue` 用 tsx 脚本把 SVG
生成 Vue 组件、再用 esbuild 打成 `dist/`，生成物 gitignore）。本仓用 Deno 的 npm workspace，
不认嵌套子 workspace，且是纯源码消费、无构建步骤，故：

| 上游 | 这里 |
| --- | --- |
| `packages/svg/*.svg` | `svg/*.svg`（293 个，**真源，保留**） |
| `packages/vue/src/{index,global}.ts` | `src/{index,global}.ts` |
| `packages/vue/src/components/`（生成物，gitignore） | `src/components/`（生成物，**入库**） |
| `packages/vue/build/generate.ts`（tsx + camelcase/consola/prettier/tinyglobby） | `scripts/generate.ts`（零依赖 Deno 脚本） |
| `packages/vue/build/build.ts`（esbuild 打 dist） | 删除，不产 dist |

其余已删除的上游内容：`.git`（嵌套仓库）、`.github`、`.vscode`、`playground`、
`pnpm-workspace.yaml` / `pnpm-lock.yaml`、`.npmrc`、`eslint.config.js`、各 `tsconfig*.json`、
子包 `package.json`、`svgo.config.js`。

## 改图标

`svg/` 是真源。增删或修改 SVG 后重跑生成器：

```bash
deno run -A packages/kabegame-element-plus-icons/scripts/generate.ts
```

组件名由文件名 PascalCase 得到（`d-arrow-left.svg` → `DArrowLeft`），与上游
`camelcase({ pascalCase: true })` 的结果逐个核对过，293 个名字与 npm 包 `2.3.2` 的导出完全一致。

## 消费方式

与 `@kabegame/core` 同一套约定（alias 指向 `src/`，无构建产物）：

- vite alias：`vite.config.pub.ts` 里 `@kabegame/element-plus-icons` → 本目录 `src/`
- 类型：根 `tsconfig.json` 与 `apps/kabegame/tsconfig.json` 的 `paths`（后者整体覆盖前者的
  `paths`，两处都要写）

```ts
import { ArrowLeft, Close } from "@kabegame/element-plus-icons";
```

全量注册（`main.ts` 目前的做法，实际只用到 57 个，后续按需收敛）：

```ts
import * as Icons from "@kabegame/element-plus-icons";
```
