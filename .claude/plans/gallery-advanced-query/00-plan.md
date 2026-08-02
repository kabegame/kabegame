# 画廊高级查询弹窗(大纲式)— 总体计划

> 设计稿:仓库根 `高级查询弹窗.html`(bundled,已解包核对)+ `高级查询弹窗-selection.png`。
> 引擎前置:pathql 路径 WHERE 组合器 `~any/~or/~not/~end` 已落地(e7c9021c + 458fc56b),
> 组内只许 where + LEFT JOIN;经核查画廊全部维度 join 均为 LEFT,组内安全。

## 总体设计思路

前端过滤模型从「单层 `GalleryFilterSet`」升级为「三枚举递归查询树」,与 Rust 侧
`WhereQuery { Is / Any / Not }` 同构:**原子谓词 = 一整行八个格**(搜索 + wallpaperOrder /
plugin / mediaType / date / name / size / aspect——`noAlbum` 不进树,保留给简单过滤;
`pageSize`/`sort`/`page` 永远在树外,这同时是引擎组内约束的要求)。**搜索是原子的第八格**
(`search-selection.png` / `is-query-selection.png`):mode(名称/元数据/原生元数据)+
关键词,底层复用现有搜索链——query provider 贡献 LEFT join(`in_need`)+ where,组内安全;
其 resolve 整体 delegate 回 `gallery_route`,故搜索叶天然是**超级枢纽**(能续任意维度/
sort)。AND 没有专门节点,由**数组序列**承担——与引擎「路径折叠即 AND」一一对应:顶层是
节点序列,或组分支也是节点序列。

语义呈现上,「且/或都是限制,非是排除」:按 **not 嵌套宇称**渲染下拉计数——祖先链上
`not` 包裹层数为**奇数**时,计数渲染为 **`−N` 且用 error 色**(token 走
`--kb-el-color-error ← --anime-*`),明示「选它会排除这么多」;**偶数层(含 0 与双重
否定)翻转回正数**正常色。宇称只影响展示与计数口径,树结构本身不变。

序列化把树映射到组合器路径。关键规则是**游标二态**:路径上任一点要么在「枢纽」
(gallery 根 router / `gallery_filter_comb`,能路由全部维度),要么在某维度的「叶
router」(只 resolve `filter_comb`/分页)。原子内部维度间连 `/filter_comb/`;原子结束
后接任何东西都先 `/filter_comb/` 回枢纽;**组永远在枢纽处开**,于是每个分支从枢纽出发
可路由任意维度,`~end` 后游标也回到枢纽,后继节点直接续写。空树退化为 `all`。解析是
同一套三枚举的递归下降,挂在 `parseBody` 遇到 `~` 记号段的分支上——路径仍是唯一事实源,
高级查询状态随 URL query 持久化,不另设并行存储。

下拉预览沿用现有 facet 机制的推广:`buildDimensionCountPath` 今天已经会「把该维度从
集合中拿掉、维度 router 段放路径末尾、由引擎 list children 带 count」;高级弹窗把
「集合」换成「整棵树减去当前格」,即 序列化(树 − 该原子的该维度) + `/filter_comb/<维度
router>`,`pathqlList(path, with_count)` 一次拿到全部候选与计数;命中徽章 =
`pathqlEntry(整树路径).total`。已知语义近似:当该格位于或组分支内时,facet 计数是
「(树−格) AND 候选」,与「格=候选后的整树」在其它分支贡献并集行时略有偏差——这是
标准 faceted-search 语义,接受并在代码注释里写明。

UI 拆三层:**图标**进 `kabegame-element-plus-icons`(svg 真源 + Deno 生成器);
**KbFilterDropdown** 进 vendored `kabegame-element-plus`(搜索框 + label/count 双列 +
「任意」行的下拉,主题一律下沉 var.scss token map,业务侧零 `.el-*` 覆盖);**弹窗本体**
留在 apps(业务编排)。入口在画廊工具栏,与简单过滤互斥,角标显示条件数;首期只接主
画廊路由(album/task/surf 详情路由后续再开)。

关键决策与理由:
- **not 用三枚举的 `{not: 序列}` 节点而不是原子上的布尔标志**:UI 的「非」开关 =
  包/解包一层 not 节点,序列化天然映射 `~not/…/~end`,解析无歧义。
- **序列化复用 `serializeFilter`**(每维度段的拼法与转义原样继承),高级查询不新增
  转义面,与 pathql-client Phase 3(批次 D 换转义原语)解耦,两者可独立推进。
- **嵌套上限 3 层**(设计稿标注)由 UI 强制,引擎无上限;超限入口置灰。

## 现状锚点

**a. 原子的字段基础**([galleryPath.ts:37](apps/kabegame/src/utils/galleryPath.ts#L37))
```ts
export interface GalleryFilterSet {
  wallpaperOrder?: boolean;
  noAlbum?: boolean;          // 现状:8 维;高级查询原子只取其余 7 维
  plugin?: { pluginId: string; extendPath?: string };
  mediaType?: { kind: "image" | "video"; format?: string };
  date?: { segment: string };
  name?: { bucket: string };
  size?: { range: string };
  aspect?: { range: string };
}
```

**b. 现有序列化与 facet 计数**([galleryPath.ts:484,496](apps/kabegame/src/utils/galleryPath.ts#L484))
```ts
export function serializeFilterSet(filters: GalleryFilterSet): string {
  const parts = DIMENSION_ORDER
    .map((dim) => filterForDimension(filters, dim))
    .filter((filter) => filter.type !== "all")
    .map(serializeFilter);
  return parts.join(`/${FILTER_COMB}/`);   // 现状:平铺 AND,无组
}
export function buildDimensionCountPath(filters, dimSeg) {
  // 现状:把本维度从集合拿掉、维度段放末尾 → 引擎 list children 带 count
  // (高级弹窗预览是它的树版推广)
}
```

**c. buildComposablePath 的过滤位**([galleryPath.ts:149-179](apps/kabegame/src/utils/galleryPath.ts#L149)):
`[search/…/][rootPrefix/]<filterPath>/filter_comb/sort/<field>[/desc][/xNx]/<page>`,
`parseComposablePath` 逆向;二者是路由状态唯一事实源。

**d. 枢纽 provider**(`gallery_filter_comb.json5`):list 路由全部 7 维 + `sort`,
**尚无 `search`**(需新增,见点 5);维度叶 router(如 `gallery_size_range_router`)只
resolve `filter_comb` 与分页。

**d2. 搜索链**(`images/gallery/search/`):`search` → `gallery_search_router`(mode)→
`gallery_search_<mode>_router` `(.+)`(alias `query`)→ query provider:
```json5
"query": {
    "join": [{ "kind": "LEFT", "table": "metadata", "as": "metadata_im", "in_need": true, ... }],
    "where": "LOWER(metadata_im.search_text) LIKE ..."   // 现状:LEFT + where,组内合法
},
"resolve": { ".*": { "delegate": { "provider": "gallery_route" }, ... } }  // 现状:搜索叶 = 超级枢纽
```
现状搜索只作**全局路径前缀**(`buildComposablePath` 的 `searchPrefix`,parse 侧
`stripSearchPrefix` 剥前三段)。

**e. 取数 API**([context.ts:117,127](apps/kabegame/src/components/galleryFilterTree/context.ts#L117)):
`pathqlList(path, with_count)` → children 带 count;`pathqlEntry(path)` → `{ total }`。

**f. Rust 侧三枚举**(`pathql-rs/src/ast/where_query.rs`):`Is(SqlExpr) / Any(Vec) /
Not(Box)`——前端镜像的参照。

## 点 1 — 查询树模型(新增 `apps/kabegame/src/utils/galleryQuery.ts`)

- **新增**
  - 三枚举递归类型(AND = 数组序列):
```ts
export interface GalleryAtomSearch { mode: GallerySearchMode; query: string }
export type GalleryAtom = Omit<GalleryFilterSet, "noAlbum"> & { search?: GalleryAtomSearch };
export type GalleryQueryNode =
  | { is: GalleryAtom }                  // 原子:一行七维(行内 AND)
  | { any: GalleryQueryNode[][] }        // 或组:分支列表;分支 = 节点序列(AND)
  | { not: GalleryQueryNode[] };         // 取非:包裹一个节点序列
export type GalleryAdvancedQuery = GalleryQueryNode[];   // 顶层 AND 序列
```
  - `MAX_GROUP_DEPTH = 3`;`conditionCount(tree)`(工具栏角标);`isEmptyQuery`;
    `normalizeQuery`:剪掉空原子/空分支(或组仅剩单分支时不塌缩——用户可能正要加分支);
    **同级相邻原子的规范化**——维度不冲突则合并为一个原子(AND 语义等价;代价是两行
    无冲突纯原子在重开弹窗时合为一行,接受),**冲突**(同维度都有值,含两个 search)
    则把后者包进单分支 `{any:[[…]]}`(引擎单分支组退化为普通过滤,语义不变)充当行边界。
    这保证 `parse(serialize(t)) ≡ normalize(t)` 的往返确定性——路径上原子之间没有显式
    分隔记号,解析按「维度冲突即断行」聚合。
  - `notParity(nodePath)`:祖先链 not 层数奇偶(下拉 −N/error 色渲染依据,双重否定翻正)。
  - 节点定位器 `NodePath = number[]`(UI 操作树上某键)与 `getNode/updateNode/removeNode`
    不可变更新工具。

## 点 2 — 序列化(galleryQuery.ts + buildComposablePath 接入)

- **新增** `serializeAdvancedQuery(tree): string`:
  - 原子 → `serializeFilterSet`(现有函数,七维内部已用 `/filter_comb/` 连接)+
    **search 段固定排原子末位**:`…/filter_comb/search/<mode>/<q>`。search 收尾的原子
    落在超级枢纽(query provider delegate `gallery_route`),后继任何段**免补**
    `filter_comb`;混合原子首段恒为普通维度,降低整树以 `search` 开头的场景。
  - `{any}` → `~any/<分支>/~or/<分支>/~end`,`{not}` → `~not/<序列>/~end`;
  - 游标三态:**枢纽 A**(gallery 根 / 搜索叶 delegate,路由维度+search+sort 全量)、
    **枢纽 B**(`filter_comb`,路由 7 维 + sort + search〔点 5 新增〕)、**维度叶**
    (只 resolve `filter_comb`/分页)。规则:上一项收在叶 → 先补 `/filter_comb/`;
    收在枢纽 → 直接续;组恒在枢纽处开,`~end` 后回到开组处的枢纽。
  - 空树 → `"all"`;尾部 `sort`:游标在枢纽直接续 `sort/…`,在叶补 `/filter_comb/sort/…`。
  - **全局搜索前缀歧义守卫**:整树序列化结果以 `search` 开头(仅纯 search 单原子打头时
    发生)且其后紧跟 `filter_comb` —— parse 侧靠这一特征区分(见点 3),序列化端无需
    额外前缀段。
- **修改** `ComposablePathParams.filters` 增收 `GalleryAdvancedQuery`
  (判别:`Array.isArray`);`buildComposablePath` 过滤位改调
  `serializeAdvancedQuery`;树以组结尾时尾部 `sort` 直接续(枢纽路由 sort),
  否则维持现状 `/filter_comb/sort/…`。
- **修改** `buildComposableCountPath` 同步增收树(命中徽章用)。

## 点 3 — 解析(galleryPath.ts `parseBody` 分支)

- **修改** `parseBody`:遇到 `~any`/`~not` 记号段,整段 body 交给新的递归下降
  `parseAdvancedBody(segs)`(三枚举镜像:记号开组/`~or` 切分支/`~end` 收束;
  非记号段按现有 `parseDimensionChunk` 聚原子——**扩展识别 `search/<mode>/<q>` 三段
  chunk** 归入原子 `search` 格;`filter_comb` 为分隔符跳过;**同维度再现即断行**开新原子,
  与点 1 的规范化规则互为镜像);返回 `ParsedGalleryPath` 新增字段
  `advanced?: GalleryAdvancedQuery`。
- **修改** `stripSearchPrefix`:剥全局搜索前缀加一个 lookahead 守卫——**紧随三段之后是
  `filter_comb` 时不剥**(那是原子内的 search 格;全局前缀之后只会是 root 段/维度/`all`/
  `sort`,存量路径不受影响)。
- 未闭合/记号错位 → 整个 body 视为不可解析,回退 `filters: {}` 并 `console.warn`
  (与引擎「未闭合拒绝执行」呼应;路径来源只有本序列化器,正常不触发)。
- **删除**:无。存量非高级路径走原有分支,零影响。
- 往返性质:`parse(serialize(tree)) ≡ normalize(tree)`,deno 测试锁住(见点 9)。

## 点 4 — 预览取数(新增 `apps/kabegame/src/composables/useAdvancedQueryFacets.ts`)

- **新增**
  - `facetListPath(tree, nodePath, dim)`:整树减去 `(nodePath, dim)` 后序列化,
    末尾接 `/filter_comb/<维度 router 段>`(`plugin`/`media-type`/`date`/`name`/
    `size`/`aspect`;`wallpaper-order` 是布尔、`search` 是自由文本,都不走 facet 列表);
    **not 宇称参与计数口径**:该格祖先链上的 not 层数为奇时,构造路径前先把这些 not
    包裹解开(exclusion 语境下数字回答「会排除多少」,即 not 作用域内容按正向谓词与
    树其余部分 AND 后的 facet;偶数层双重否定翻回正向,不解包)。
  - `useDimensionFacet(...)`:`pathqlList(path, true)` → `{name, count, meta}[]`,
    顶部合成「任意」行(count = `pathqlEntry(减格树).total`);随行返回
    `negated = notParity(nodePath) 为奇`,供 KbFilterDropdown 渲染 `−N`/error 色;
    fetch-then-overwrite,不先清后取(闪烁教训);同一弹窗会话内按 path 做 LRU 缓存;
  - `useAdvancedHitCount(tree)`:整树 count,防抖 300ms。

## 点 5 — 引擎侧改动与回归(kabegame-core)

- **修改** `gallery_filter_comb.json5`:list 新增 `"search": { "provider":
  "gallery_search_router" }`——分支内/原子中位的 search 由此可从枢纽 B 进入。搜索叶
  (query provider)已 delegate `gallery_route`,无需改。
- **新增** DSL E2E 测试(真实内置 DSL + 内存 sqlite),断言:七维各自进 `~any` 分支
  可折叠执行;**search 进分支**(LEFT join `in_need` 跨分支共享)与原子中位
  `…/filter_comb/search/<mode>/<q>/date/…` 续接;`~not/<原子>/~end`;嵌套 3 层;
  plugin+extend(LEFT join)跨分支;组在枢纽 B 开、`~end` 后 `filter_comb/sort/
  by-time/desc/x100x/1` 尾部可执行;搜索叶(枢纽 A)后直续维度/开组;`all` 空树不回归。
- 若发现某维度组内被拒(理论上不会,join 已核全 LEFT),回来改该 DSL(LEFT 化或
  where 化),补 patch 于本点。

## 点 6 — 图标(packages/kabegame-element-plus-icons)

- **新增** 缺失的维度 svg(先盘点现有:`calendar`(时间)、`picture`(种类)等可能已
  有;比例/尺寸/名称/壁纸/插件按设计稿绘制或从上游 iconset 选形),入 `svg/`,跑包内
  Deno 生成器重产组件;命名 kebab-case。
- 「非」「或组」「且」徽章是文字胶囊,不做图标。

## 点 7 — KbFilterDropdown(packages/kabegame-element-plus 新组件)

- **新增** `src/components/kb-filter-dropdown`(KbTab 先例):
  - 触发器插槽默认渲染维度 chip:`icon + 维度名 + 当前值/「任意」 + ▾`;选中态
    chip 高亮并把 ▾ 换 ✕(点 ✕ 重置任意不开弹层)。
  - 弹层:可选搜索框(`searchable`)+ 选项行(label 左、count 右、千分位)+
    「任意」置顶 + loading/empty 态;键盘上下/回车。
  - Props:`modelValue / options: {label, value, count?}[] / searchable / loading /
    anyLabel / disabled / negated`;事件 `update:modelValue / open`(open 时父层才拉
    facet)。`negated` 时计数渲染 `−N` + error 色(exclusion 语境,见总体思路的宇称规则)。
  - **计数为 0 的选项不 disable**(现有 size 等维度下拉「0 即禁选」的限制不带入,且在
    点 8 顺手移除简单过滤侧的同类限制):0 也是合法选择,尤其 not 语境下 `−0` 表示
    「排除不掉任何东西」本身就是信息。
  - 弹层内容默认是选项列表;提供 `#panel` 具名插槽整体替换(搜索格的「模式 tab + 关键词
    输入 + 说明文案」面板用它实现,组件不感知搜索语义)。
  - 主题:全部走 `theme-chalk/src/common/var.scss` token map(`--kb-el-* ← --anime-*`),
    参照 date-picker 范例;禁止业务侧 `.el-*` hack。
- 三处接线(vite alias / 两处 tsconfig / web manualChunks)已覆盖包级,无需增改。

## 点 8 — 弹窗与入口(apps/kabegame)

- **新增** `components/gallery/GalleryAdvancedQueryDialog.vue`:
  - 桌面 940×680 圆角卡片;compact(≤390)维度 chip 换行铺开、或组卡片纵排
    (设计稿两版式);Android `useModalBack`。
  - 结构:头部(标题 + 命中徽章 + 关闭)→ 条件区(条件行 = 非开关 + **搜索格 + 7 维
    KbFilterDropdown**(搜索格用 `#panel` 插槽:KbTab 三模式 + 关键词输入 + 说明文案,
    按 `search-selection.png`;chip 显示 `搜索 <模式徽章> <关键词>`,选中态同其它格)
    + 行删除;或组卡片 = 徽章 + 整组取非 + 分支列表 + 「＋分支」;「且/或」连接元素;
    「＋添加条件」「＋添加或组」;第 3 层禁再嵌)→ 底部路径条(只读 + 复制)+
    重置/取消/应用。not 宇称沿树向下传给每行的下拉(`negated`),双重否定翻回正常显示。
  - 顺手移除简单过滤侧「计数为 0 即 disable 选项」的限制(与 KbFilterDropdown 口径统一)。
  - 状态:弹窗内编辑副本,「应用」才 `buildComposablePath(page=1)` 写路由;「重置」清树。
- **修改** `GalleryToolbar.vue`:「高级」入口 + 条件数角标;高级激活时简单过滤下拉置灰
  (互斥,反向亦然);`galleryRoute` store 读 `parsed.advanced` 供角标/回显。
- i18n:新 key 走 `@kabegame/i18n` 命名空间规范,中英日至少中英。
- UnoCSS 优先,复杂连线/卡片阴影允许少量 `<style>`。

## 点 9 — 验证

1. deno 单测(纯 TS,不涉 vite alias):序列化游标规则(叶后补 filter_comb、枢纽后
   直续、search 收尾走超级枢纽)、往返 `parse(serialize(t)) ≡ normalize(t)`(含相邻
   原子合并/冲突断行、search 格)、全局搜索前缀 lookahead 守卫(`search/m/q/filter_comb`
   不剥 vs 存量前缀照剥)、not 宇称、空树/空分支/嵌套上限、facet 减格路径(含奇偶宇称
   解包)。
2. `cargo test -p kabegame-core <新增测试>`(点 5)。
3. `check-kabegame --skip cargo`(每前端批次后)。
4. kabegame-chromium 视觉核对(需你跑 dev app):对照 png 逐区块截图;compact 版式;
   下拉计数与真实库一致;应用后画廊结果与路径条一致;简单/高级互斥。

## 执行分工与批次

- 批 1(codex):点 1-3 + 点 9.1 deno 测试(纯逻辑,可独立验收)。
- 批 2(codex):点 5 引擎回归。
- 批 3(codex/run-sonnet):点 6 图标 + 点 7 组件结构;**视觉打磨由我做**
  (codex 样式不达标的既往约定)。
- 批 4(run-sonnet):点 8 弹窗结构 + 接线;我做视觉打磨与截图核对。
- 每批独立提交;与 pathql-client Phase 3 无依赖,可并行或先后。

## 风险与边界

- facet 计数在或组分支内是标准 faceted 语义近似(见总体思路),UI 不承诺「选后命中数
  恰等于预览行数」;命中徽章始终以整树 count 为准。
- 或组内 `wallpaperOrder` 原子在设计稿路径示例里有 `~not/wallpaper-order/~end` 用法,
  引擎侧 where 纯净,可行。
- detail 路由(album/task/surf)首期不接高级查询;树只在主画廊路径出现,三个 detail
  store 的 parse 遇到记号段会走回退(显式 warn),不会误解析。
- `~` 相关转义:七维的值段(bucket/range/kind/segment)都是受限字面,不会以 `~` 开头;
  plugin id/format 经 `serializeFilter` 现有转义。**但 search 是自由文本**:引擎已切
  反斜线严格语义(458fc56b),以 `~` 开头的关键词若只走 `encodeURIComponent` 会被判
  Reserved 报错(存量全局搜索今天即有此边缘)。故本特性落地前置:**先做 pathql-client
  Phase 3 点 0-1(接线),搜索词编码统一走 `encodeSeg`**(顺手修掉全局搜索同一边缘);
  若不想等接线,退路是 galleryPath 内先放同构本地转义、Phase 3 批 D 再收敛——默认取
  前者。
- 图标:搜索格用现有 `search.svg`(放大镜)即可,无需新绘。
