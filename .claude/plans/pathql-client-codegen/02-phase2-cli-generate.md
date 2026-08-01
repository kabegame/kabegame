# Phase 2 — kabegame-cli `pathql generate` 子命令

> 前置:Phase 1 已落地(commit b7f2f869):pathql-rs `client-codegen` feature、
> `ProviderRuntime::client_codegen(CodegenTarget::TypeScript)`、574 测试全绿、
> 生成物过 deno check + deno 行为测试。

## 总体思路

kabegame-cli 加 `pathql generate --target typescript --out <file>` 子命令,复用
`data query` 已有的初始化链路(`init_standalone_globals()` → 惰性 `provider_runtime()`,
[main.rs:641-646](src-tauri/kabegame-cli/src/main.rs#L641-L646)):storage/settings 起来后
runtime 单例自动完成 DSL 注册 + schema 注册 + validate。插件 provider 按「加载到什么算
什么」的既定决策(00-direction 决策 5)——不为 codegen 添加专门的插件加载逻辑,也不排除。

生成物不入库、手动重生成、dev 不接构建流(用户拍板)。本阶段同时给核心路由撒**第一批
alias**,让 Phase 3 的前端迁移有类型化边可用。

## 现状锚点

- CLI 子命令结构:`Commands`(Plugin / Data 两组)在 [main.rs:34-42](src-tauri/kabegame-cli/src/main.rs#L34-L42);
  `data query` 走 `init_standalone_globals()`(main.rs:511 起的共享初始化,含
  `Storage::init_global`)。
- runtime 初始化:`kabegame-core providers/init.rs::provider_runtime()` OnceLock 单例,
  executor 拿 `Storage::global().db`(codegen 不执行 SQL,但复用该单例最省事且与
  data query 行为一致)。
- Phase 1 入口:`pathql_rs::client_codegen::CodegenTarget` +
  `ProviderRuntime::client_codegen`(feature `client-codegen`)。
- 真实 DSL 目前**没有任何 alias**——直接生成的话所有 resolve 边都是 `$raw` 档。

## 点 1 — feature 接线

- **修改**
  - `kabegame-cli/Cargo.toml`:给 pathql-rs 依赖(直接或经 kabegame-core 转发)启用
    `client-codegen` feature。倾向 CLI 直接依赖 `pathql-rs = { features = ["client-codegen"] }`,
    靠 cargo feature 统一作用到共享构建;若 CLI 尚无直接依赖则新增。
    > 主 app(kabegame)不启用该 feature,桌面构建零开销。

## 点 2 — 子命令(pathql 命令组:generate + query 共用)

- **新增**(main.rs)
  - `Commands::Pathql(PathqlCommands)`;`PathqlCommands::Generate(GenerateArgs)`:
    - `--target <typescript>`(ValueEnum,默认 typescript);
    - `--out <path>`(必填;写文件前建父目录);
  - handler:`init_standalone_globals()` → `provider_runtime().client_codegen(target)` →
    写文件;stdout 打一行统计(provider 数 / 占位数 / 输出路径)。
  - `--out -` 输出到 stdout(便于管道与 diff)。
- **修改**(用户拍板:`data query` 迁到同组)
  - `DataCommands::Query` **移除**,原样迁为 `PathqlCommands::Query(DataQueryArgs)`
    (参数结构与 `data_query` handler 逻辑不变,只挪归属);`DataCommands` 只剩
    `ImportImage`。不留旧名 alias(CLI 是开发工具,破坏性改名可接受)。
  - 同步引用:main.rs 顶部模块注释;`cocs/gallery/GALLERY_PAGINATION_AND_IMAGE_LOAD.md:56`
    的「CLI:`data query`」句。

## 点 3 — 第一批 alias(核心路由)

- **修改**(`kabegame-core/src/providers/dsl/` 各 json5;引擎语义不变,只加注解)
  - 至少覆盖 Phase 3 迁移清单里最常用的边:
    - `gallery_all_router` 的 `desc|xNNNx|页码` 组合正则 → `alias: "page"`(或按实际
      resolve 项拆分粒度定名);
    - `gallery_plugins_router` / `gallery_albums_router` / `gallery_tasks_router` /
      `gallery_surfs_router` 的 id 捕获项 → `plugin` / `album` / `task` / `surf`;
    - `albums_root_provider` 的 `by_sub_tree` 相关动态边(如适用)。
  - 落地时逐文件核对 resolve 结构再定名;alias 命名以「边的语义」为准,不绑 provider 名。
  - `validate_dsl`(启动期)会自动把格式/唯一性错误暴露出来。

## 点 4 — gitignore 与文档

- **修改**
  - `.gitignore`:加约定输出路径 `packages/kabegame-pathql-client/`(Phase 3 接线的
    默认落点;`--out` 仍可任意)。
  - `CLAUDE.md`:Other 命令段落加一行 generate 用法 + 「产物不入库,改 DSL 后手动重生成」。
  - `cocs/provider-dsl/RULES.md`:§schema 相关处补 `alias` 字段一句话(codegen 专用,
    引擎忽略);cocs/README.md 的 RULES 条目描述补 alias 与 client codegen 关键词。
  - `apps/docs` CLI reference(`reference/cli.md`)补子命令说明。

## 点 5 — 验证

1. `cargo build -p kabegame-cli`(debug)后实跑:
   `kabegame-cli pathql generate --target typescript --out /tmp/.../client.ts --data dev`
   (沿用 CLI 既有 `--data` 语义,dev 数据目录避免碰系统数据)。
2. 真实全量 DSL 产物:`deno check` 通过;抽查 `pql.gallery.all`、新 alias 边、
   `pql.albums` 的类型形状;跑一版行为断言(几条真实路径与手拼串逐字节相等,含组合器)。
3. 决定性:同机连跑两次 generate,产物逐字节相同。
4. `cargo test -p pathql-rs --all-features` 与 check-kabegame `--skip vue` 无回归
   (alias 注解改动会被启动期 validate 覆盖)。

## 不做的事

- 不接 deno task 构建流、不加 `--check` 漂移检测(产物不入库,无漂移可言)。
- 不为 codegen 定制插件加载;CLI 初始化链路里插件 provider 有就生成、没有就略过。
- 前端 tsconfig/vite 接线与调用点迁移是 Phase 3。
