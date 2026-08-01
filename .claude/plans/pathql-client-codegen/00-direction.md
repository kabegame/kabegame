# PathQL Client 代码生成器 — 总体方向

> 状态:方向定稿(2026-08-01,两轮对齐);API 细化见 01-design.md。

## 目标

`kabegame-cli pathql generate --target typescript --out <path>` 生成**类型化 pathql
client**(对标 Prisma Client)。客户端只负责**产出合法路径字符串**(段转义 `~~` +
percent-encoding、段顺序、组合器结构);**不提供 invoke**——执行仍由调用方走
`pathql_fetch` / `pathql_list` / `pathql_entry`。

## 已定决策(全部用户拍板)

1. **运行时自省,无 IR**:pathql-rs 内部新增 `runtime.client_codegen(target)` 接口
   (独立 feature),walk 活的 `ProviderRegistry` + schemas 表直接产出目标语言代码;
   kabegame-cli 只是调用方。多来源(DSL/程序化/动态注册)天然支持;scheme 根注册无
   来源问题。
2. **不可具体化节点 → 占位类型**:程序化 provider 与动态 delegate 只生成类型定义、
   不具体化——通用占位节点 `AnyProviderNode`:保留全部 `$` 方法面,索引访问返回
   `AnyProviderNode` 自身(不是 `any`/`unknown`),链式每步仍是节点;每来源一个命名
   别名(命名方案见 01-design §3,由 Claude 设计)。
3. **resolve 正则:注解字段 `alias`**。带 `alias: "{alias}"` 的 resolve 项生成
   `.$resolve{Alias}(seg: string)` 类型化接口——**所有这些方法函数体相同**(拼接转义后
   的段字符串),只有返回类型不同;无 alias 的正则项不生成方法,用户用 `$raw` 手动。
4. **生成流程:手动、产物不入库**。deno 构建流不加 CLI 构建/生成步骤;DSL 不常改,
   改了手动跑一次 generate;生成物 **gitignore,不进版本库**。dev 不重新生成。
   `--out` 可配置。
5. **自省时可以加载插件**:代价只是生成一些没人引用的类型,可接受;不需要
   builtin-only init。
6. **底层基座也生成,一次性到位**:转义/组装/组合器 builder 等 runtime 底座不做手写
   包,由 emitter 与类型一起产出——生成物**自包含**(零 import)。
7. **客户端 API:不可变链式 builder**;组合器 `$any`/`$not` 回调以组入口节点类型为根。

## 核心模型:按 provider 生成节点类型

路径树因 comb/递归路由无限,不枚举路径;每个可具体化 provider 生成一个节点类型,边:

| registry 来源 | 生成物 |
|---|---|
| `list` 静态项(字面 key) | getter(非法标识符用带引号属性名)→ 目标节点类型 |
| `resolve` 项 + `alias` | `.$resolve{Alias}(seg: string)` → 目标节点类型 |
| `resolve` 项无 alias | 不生成;`$raw` 手动 |
| `list` 动态 SQL 项(目标 provider 静态可知) | `.$child(name: string)` → 目标节点类型 |
| `list`/`resolve` 动态 delegate、模板 provider | 占位类型(AnyProviderNode) |
| 程序化 provider | 占位类型(AnyProviderNode) |
| 组合器 | 每节点 `$any(…)` / `$not(…)` |
| 逃生口 | `$raw(segment)`(自动转义)→ 占位类型 |

## 已知代价(接受)

- 产物不入库 ⇒ 新 checkout 在前端接入 client(Phase 3)之后需要先
  `cargo build -p kabegame-cli`(debug)+ 手动 generate 一次,vue-tsc 才能过。
  落地时在 CLAUDE.md / README 记一步准备命令。
- 加载插件自省 ⇒ 产物含本机已装插件的 provider 类型,机器间产物可能不同;因不入库、
  无人引用即无害,不处理。

## 阶段划分

- **Phase 0**:✅ 方向定稿。→ 01-design.md:API 示例集、alias schema、占位命名、
  CLI 参数、生成物结构。
- **Phase 1:pathql-rs `client_codegen`**(feature 门控):AST/schema 加 `alias` 字段
  + registry/schemas 自省 + TypeScript emitter(含自包含 runtime 底座)+ 快照测试。
- **Phase 2:kabegame-cli `pathql generate` 子命令**(`--target`/`--out`)+ gitignore
  + CLAUDE.md 准备步骤说明。
- **Phase 3:前端接线与迁移**:tsconfig paths / vite alias 指向生成物;按
  effervescent-tumbling-boot 计划的调用点清单逐模块换 typed client(那份「手动接
  helper」计划被本方向吸收;parse 侧仍手写,客户端只管 build)。
- **Phase 4(远期)**:Rust client target 等。

## 与既有工作的关系

- 引擎侧 `~` 转义契约(`where_group.rs::escape_path_segment` + `~~` classify)与组合器
  语义(分支旁路、组入口、尾部不自动闭合,27 项端到端测试)是生成 runtime 的规格。
