# Phase 3 — 前端接线与渐进迁移

> 前置:Phase 2 已落地(commit 32383584)。生成命令
> `kabegame-cli pathql generate --target typescript --out …`,真实产物已过
> deno check + 行为断言。本阶段把生成客户端接进前端,并按调用点清单分批迁移。
> 迁移分工:机械替换批次派 run-sonnet(前端归 sonnet),我复核 + 验证。

## 总体思路

生成物落 `packages/kabegame-pathql-client/index.ts`(已 gitignore),以
`@kabegame/pathql-client` alias 接入。迁移只动 **build 侧**(拼路径)——parse 侧
(galleryPath.ts 的 parse 家族)保留手写,但转义原语改为从生成物导入,保证
build/parse 与引擎三方同构。`galleryPath.ts` 的 `buildComposablePath` 大序列化器
(sort/search/filter_comb 复杂拼装)**不迁**:它与 parse 深度配对、churn 大,只统一
其段转义函数;简单调用点(单段拼接)全部换 typed client。

顺带修掉 effervescent-tumbling-boot 探索发现的编码不一致(同一实体一处编码一处不
编码)与 `~` 撞名洞:凡数据进段处,要么走 client 方法(自动转义),要么走导出的
`encodeSeg`;parse 往返点配对 `decodeSeg`。注意这不是「在 encodeURIComponent 外再加
一层」而是**换机制**:迁移后的调用点不再 percent-encode(引擎的 percent-decode 只是
过渡期兜底,前端迁完即移除,见点 3)。

## 点 0 — 生成 runtime 换转义原语并补导出(pathql-rs)

> 前置:引擎已切**反斜线统一转义**(`\X`=字面 X、未转义 `/` 才分段、字面前导 `~` 写
> `\~`、`~~` 废除、percent-decode 降为过渡期兜底)。

- **修改** `client_codegen/runtime.ts`:
  - `encodeSeg` 改反斜线版并 `export`:`\`→`\\`、`/`→`\/`,结果以 `~` 开头则前置 `\`;
    **不再 encodeURIComponent**。
  - **新增** `export const decodeSeg`:`\X`→`X`(任意 X),孤立尾 `\` 按字面——与引擎
    `unescape_path_segment` 同构。
  - 生成物同时 `export { pql }`(现状)与这两个原语,手拼/解析代码共享同一转义。
- 快照测试断言(encodeSeg 函数体)、Phase 2 的 deno 行为脚本(`~~` 断言改 `\~`)同步;
  `cargo test -p pathql-rs --all-features` 回归。

## 点 1 — 接线

- **修改**
  - 产物路径约定 `packages/kabegame-pathql-client/index.ts`;CLAUDE.md 示例命令同步
    (现在写的是 `client.ts`)。
  - 三处接线(照 COMPONENT_LIBRARY.md 惯例):vite alias(`@kabegame/pathql-client`
    → 该文件)、根 tsconfig `paths`、`apps/kabegame` tsconfig `paths`(整体覆盖,
    别漏);web `manualChunks` 先不切(编译后体积小,列为后续可选)。
  - CLAUDE.md「新 checkout / 前端 typecheck 前先 generate」一句话(vue-tsc 缺产物
    会直接报错——这是不入库决策的已接受代价);`deno task prepare` 是否顺带提示,
    落地时看 scripts 现状定。
  - `scripts/build-web.sh`:host 侧 JS 构建前确认产物存在(存在性检查 + 报错提示,
    不自动构建 CLI)。

## 点 2 — 迁移批次(每批独立可验收,run-sonnet 执行)

**批次 A(单段拼接,低风险)**
- `App.vue:422`:`images://id_${encodeURIComponent(id)}` → `pql.images.$resolveId(`id_${…}`)`
  (注意 id_ 前缀语义,取 `$resolveId("id_" + id)` 还是给 DSL 再加捕获别名,落地时定)。
- `stores/albums.ts:370,578`、`utils/surfMediaCount.ts`、`utils/albumMediaTree.ts`。
- 配对修未编码点:`stores/albumDetailRoute.ts:69,78`、`surfImagesRoute.ts:70,80`、
  `taskDetailRoute.ts:76,86` 的 rootPrefix 改走 `encodeSeg`;parse 侧
  `galleryPath.ts:300 extractRootIdAndBody` 补 `decodeSeg`(存量未编码路径 decode
  是无操作,兼容)。

**批次 B(galleryFilterTree 家族)**
- `context.ts`:`providerPathSegment`/`pluginPath`/`pluginExtendPath` 换 client 或
  `encodeSeg`;各 node 组件(Plugin/PluginExtend/MediaType/Date/Name/Size/Aspect)
  的段拼接同步;`MediaTypeProviderChildrenNode` 顺带补编码。
- `PluginExtendProviderChildrenNode` 的内联段编码(第 6 份拷贝)删除。

**批次 C(三份组件拷贝收敛)**
- `GalleryFilters.vue` / `GalleryToolbar.vue` / `GalleryFilterControl.vue` 的
  `countProviderPath`/`listProviderDirs`/`normalizeExtendPath`/
  `pluginExtendPathForProvider` 本地拷贝 → 收敛到一个共享模块(基于 client/encodeSeg);
  `GalleryToolbar.vue:1496-1505` 的段比对用 `decodeSeg` 对齐表示。

**批次 D(galleryPath.ts 收边)**
- `serializeFilter`/搜索词/`providerPathSegment`/`decodePathSegment` 的编码解码
  原语换成 `encodeSeg`/`decodeSeg` 导入(**结构不动**,只换原语);删掉本地第 5 份
  拷贝。`packages/kabegame-core` 的 `PluginProviderPanel.vue`(plugin:// 占位类型链)
  换 client,顺带修 pluginId 未编码。

## 点 3 — 验证

1. 每批次后:`check-kabegame --skip cargo`(vue-tsc 秒级)。
2. 路径等价对照:一次性 deno 脚本,对每个迁移调用点断言「新写法输出 === 旧写法输出」
   (旧逻辑当场内联为 fixture,不需要 vitest 基建)。存量路径(URL query 持久化)
   兼容性靠 decode-无操作保证,抽查 gallery-path query 往返。
3. 全部批次完成后:kabegame-chromium skill 冒烟(画廊过滤树展开、album/surf/task
   详情翻页、搜索特殊字符词)——需要你跑 dev app。
4. `cargo test -p pathql-rs --all-features`(点 0 回归)。
5. **收尾:移除引擎过渡期 percent-decode 兜底**(`classify_segment` 字面分支里
   「不含 `\` 的段尝试 percent-decode」的 TODO),全量回归 + 冒烟。存量持久化路径
   (URL query 里的 `%xx`)自此按字面解释——桌面应用会话级状态,已接受。

## 风险与边界

- **产物缺失即前端编译失败**:接线落地后,任何没跑过 generate 的环境 vue-tsc 必红。
  已是接受的决策代价;缓解 = CLAUDE.md 步骤 + build-web.sh 存在性检查的明确报错。
- filter_comb 组合段、sort/search 前缀等复杂序列化仍在 galleryPath.ts 手拼——本阶段
  只统一转义原语,不改结构;将来若引擎组合器进前端 UI,再评估用 `$any`/`$not` 重写。
- `plugin://` 链是占位类型(程序化 root),类型弱是预期行为。
