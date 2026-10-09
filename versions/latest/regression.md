# v4.5.1 regression

本版回归 checklist。任何改动可预见的回归路径，要在上线前 check 完毕。
按「操作」一步步点，对照「预期」，通过就把第一列勾上。

## 搜索表达式（且 / 或 / 非 / 分组 / 转义）+ 高级条件双重取非边界

搜索框输入改为表达式：`,` 且、`;` 或、前置 `!` 非（多重 `!` 两两抵消）、`()` 分组，`\` 转义、`"…"` 字面量。
由 `utils/searchExpr.ts` 解析 / 规范打印；勾选维度作用在**每个词**上（词 = 任一维度含它，`!词` = 所有维度都不含）——
多维度时逗号的含义从「同一维度内同时含」变为「逐词跨维度」。`serializeSearchTerm` 把语法树展开成
`search` 段 + `~any`/`~not`；`foldSearchTree` 解析后按勾选维度并集把连续节点读回语法树，重新序列化逐段一致才折叠，
高级条件边界外壳 `~not/~not/…/~end/~end` 不参与折叠。语法错误的输入不提交，底部说明指出位置。
后端元数据 / 原生元数据搜索谓词对 LEFT JOIN 的 NULL 列加 `COALESCE`，取非时不再丢掉没有元数据的图。

| 是否完成 | 标题 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 解析 / 序列化 / 折叠自动化 | 前端 Vitest | `npx vitest run`（apps/kabegame） | 23 个文件、227 个用例通过（含 500 棵随机语法树往返、边界不混淆、旧路径兼容） | 已实测；vue-tsc 通过 |
| [x] | 取非不丢 NULL 行 | Rust e2e | `test-kabegame` driver：`kabegame-core --test dsl_e2e` | 40 个用例通过；新增用例在修复前于 metadata 上只剩 1/122 张 | 已实测；夹具补了 `search_text` 列与 `image_metadata` 表 |
| [ ] | 示例表达式 | 桌面 CEF / Web | 只勾「标签」，输入 `(girl; boy), cute, !genshin` | 结果为含 cute、含 girl 或 boy、不含 genshin 的图；底部说明读作「（含「girl」或含「boy」）和含「cute」和不含「genshin」」 | |
| [ ] | 多维度取非 | 桌面 CEF / Web | 勾显示名 + 标签，输入 `!genshin` | 显示名或标签任一处含 genshin 的图都被排除 | |
| [ ] | 元数据取非 | 桌面 CEF / Web | 只勾「元数据」，输入 `!一个不存在的词` | 计数等于全部图片数（没有元数据的图不被排除） | 修复前会只剩有元数据的图 |
| [ ] | 转义与引号 | 桌面 CEF / Web | 本地路径搜 `Foo (1).jpg`、`a\,b`、`"a, b"`、`\!x` | 各自按字面匹配；刷新后输入框显示规范形 | |
| [ ] | 语法错误不提交 | 桌面 CEF / Web | 输入 `(girl;` 停顿 | 底部红字指出第 1 个字符括号未闭合，列表不重查；补上 `)` 后才应用 | |
| [ ] | 只用逗号、单维度不变 | 桌面 CEF / Web | 只勾一个范围，用逗号搜索，对比改动前 | URL 与结果均不变 | |
| [ ] | 旧多维度逗号链接 | 桌面 CEF / Web | 打开改动前保存的「多范围 + 逗号」搜索链接 | 结果不变；条件显示为高级 OR 组（新语法无法表达「同一范围内同时含」） | |
| [ ] | 高级条件边界 | 桌面 CEF / Web | 简单搜索输入 `!a`，高级里再加一条搜索 `b` 与一个媒体类型条件，刷新 / 前进后退 | URL 含 `~not/~not/…/~end/~end`；两部分各自留在原处，计数正确 | |
| [ ] | 旧 URL 兼容 | 桌面 CEF / Web | 打开改动前保存的带单分支 `~any` 高级条件的链接 / 历史记录 | 高级条件仍显示在高级区 | |
| [ ] | 详情页 | 桌面 CEF | 画册 / 任务 / 畅游详情里用 `!`、括号搜索并追加高级条件 | 路由正常、结果正确 | |

## 标签搜索改用不相关 IN 子查询

`search/label/<词>` 的 WHERE 从相关 `EXISTS (… lai.image_id = images.id …)` 改为
`images.id IN (SELECT lai.image_id FROM albums la JOIN album_images lai … WHERE la.type = 'label' AND instr(…))`。
每张图平均挂约 20 个标签，相关子查询会逐图展开全部标签行并回表求值；改后命中集合整条查询只算一次。
prod 库副本实测 `gallery/hide/` 下三个 `!词`（原生元数据 OR 标签）+ 宽高比 + 大小：COUNT 205ms → 21ms、
翻页 12.8ms → 7.1ms，完整结果集逐行一致（10188 行）；正向单词 COUNT 145ms → 2.5ms。

| 是否完成 | 标题 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 标签搜索 e2e | Rust e2e | `test-kabegame` driver：`kabegame-core --test dsl_e2e` | 41 个用例通过；新增取非 / `~any` OR 原生元数据组合用例，SQL 形状断言含 `images.id IN (` 且不含相关条件 | 已实测 |
| [ ] | 正向标签搜索 | 桌面 CEF / Web | 只勾「标签」搜一个常见词，再加一个词 | 结果与改动前一致，列表与总数明显更快出来 | |
| [ ] | 标签取非 + 多维度 | 桌面 CEF / Web | 勾「原生元数据」+「标签」，输入 `!a, !b, !c` 并叠加宽高比 / 大小高级条件，翻到靠后页 | 总数与改动前一致，翻页不卡顿 | |
| [ ] | 详情页标签搜索 | 桌面 CEF | 画册 / 任务 / 畅游详情里按标签搜索与取非 | 路由正常、结果正确 | |

## 宽高比生成列 `images.aspect_ratio`（v036）

新增 VIRTUAL 生成列 `aspect_ratio = width / height`（宽高无效为 NULL）+ 索引，SQLite 自动维护。
`sort/by-aspect` 按 `aspect_ratio, id` 走索引，100 万图副本、引擎真实 SQL 实测按宽高比排序翻页 3.5s → 1ms。
筛选与桶的改动见下一节「宽高比改为区间段」。`hide/` 改不相关 NOT IN 实测在真实查询里更慢，已放弃。

| 是否完成 | 标题 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 迁移与分桶一致性 | Rust 单测 / e2e | `test-kabegame` driver：`kabegame-core --lib migrations`、`kabegame-core --test dsl_e2e` | 15 + 43 个用例通过；v036 幂等、自动维护、16:9 边界相等、排序走索引；e2e 逐桶与旧整数公式比对 | 已实测 |
| [x] | 已有库升级 | CLI 本地模式 | dev 数据目录上 `kabegame-cli pathql query --via local --list --with-count images://gallery/.../aspect` | 打开时执行 v036，各桶计数正常返回 | 已实测 |
| [ ] | 按宽高比排序 | 桌面 CEF / Web | 排序选「宽高比」，切升 / 降序并翻到靠后页，打开预览深链接 | 顺序正确、翻页立即出结果，预览定位到正确页 | 宽度为 0 的异常图现在与无宽高的图一起排在最前 |
| [ ] | 新导入图片 | 桌面 CEF | 导入 / 下载新图后按宽高比筛选与排序 | 新图立即出现在正确的桶与位置（无需应用侧回填） | |

## 宽高比改为区间段（`aspect/-3x4` 等）

`aspect/` 不再列举，也不再是固定的五个名字，改为四种段：`-<w>x<h>`（≤）、`<w>x<h>-<w>x<h>`、`<w>x<h>-`（>）、`unknown`，
区间左开右闭。应用的桶改为 `-3x4` / `3x4-4x3` / `4x3-16x9` / `16x9-` / `unknown`：过窄并入竖屏、过宽并入宽屏，
「其他」只剩宽高缺失的图并改名「未知比例」，正好 3:4 的图从方正归入竖屏。VD「按尺寸」目录名随之更新，每项落到同一组桶。
区间用整数交叉乘法并禁止走宽高比索引；旧段名（`landscape-4x3-16x9` 等）不再解析，旧链接不兼容。
100 万图副本实测：各桶组合筛选一页约 20ms、COUNT 0.3～0.8s；`unknown` 走索引瞬时返回；五个桶计数之和等于总数。

| 是否完成 | 标题 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 区间语义与分区 | Rust e2e | `test-kabegame` driver：`kabegame-core --test dsl_e2e` | 45 个用例通过；9 种段与有理数参考实现逐行一致（含 9:16、7:3 边界与宽高为 NULL / 0 / 负数）；五个桶互不重叠且合起来为全部；`~not` 保留未知比例；不可列举；旧段名与非法段报错 | 已实测 |
| [x] | VD 与前端同桶 | Rust e2e | 同上 | 五种语言「按尺寸」各 5 个目录，逐目录结果集与对应画廊段一致；目录名不含 Windows 非法字符 | 已实测 |
| [x] | 前端归桶与往返 | 前端 Vitest | `deno task test -c kabegame --skip cargo` | 27 个文件、244 个用例通过；`aspectBucketForDimensions` 边界、五个桶段解析 / 序列化往返 | 已实测；vue-tsc 通过 |
| [ ] | 筛选下拉与 chip | 桌面 CEF / Web | 简单筛选与高级面板里逐个选五个宽高比桶 | 文案为新名称；URL 为 `aspect/-3x4` 等；计数之和等于总数 | |
| [ ] | 过宽 / 过窄 / 3:4 归属 | 桌面 CEF / Web | 找一张超宽全景、一张 1:3 长图、一张 3:4 照片，分别打开详情点「按此宽高比筛选」 | 分别进入宽屏、竖屏、竖屏，且结果里包含该图 | |
| [ ] | 未知比例 | 桌面 CEF / Web | 选「未知比例」 | 只有尺寸读取失败的图；正常库为空 | |
| [ ] | VD 按尺寸 | 桌面 CEF（虚拟盘） | 打开挂载盘的「按尺寸」目录，切换应用语言 | 5 个本地化目录，内容与画廊对应桶一致 | |

## PathQL 计数去掉最外层 ORDER BY

`runtime.count()` 原样包 `SELECT COUNT(*) FROM (<inner>)`，inner 带着排序，SQLite 无法压平子查询：
按排序索引扫全表、逐行做全部 LEFT JOIN 并算出所有字段再临时排序。`count_composed` 改为克隆 composed、
清掉最外层 `order` 后再构建；`~~` 内层 CTE 的排序保留，ORDER BY 中的绑定参数随之消失不错位。
100 万图副本同一条计数实测快 1.5～4.5 倍（随缓存状态波动），结果一致。画廊总数、`list_with_count`、
日期等列举计数都经此路径。

| 是否完成 | 标题 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 计数 SQL 形状 | Rust 单测 | `cargo test -p pathql-rs count_` | 带参数随机排序的计数 SQL 不含 ORDER BY 及 seed 参数，WHERE 参数与 LIMIT 保留 | 已实测；pathql-rs 419 通过 |
| [x] | 计数 = 行数 | Rust e2e | `test-kabegame` driver：`kabegame-core --test dsl_e2e` | 随机排序 / 反序 / 分页 / `~~` 切页 / rank 定位 / 画册计数 hide 下 `count == fetch().len()` | 已实测；44 通过 |
| [ ] | 画廊总数与页数 | 桌面 CEF / Web | 各排序（含随机、宽高比、降序）下看总数与末页 | 总数与改动前一致，末页条数正确 | |
| [ ] | 画册树计数 / 带计数列举 | 桌面 CEF | 画册树、媒体类型 / 日期筛选下拉的计数 | 计数与改动前一致 | |
| [ ] | 预览深链接定位 | 桌面 CEF | 带 `pvwimgid` 打开，后台刷新跟页 | 跳到目标图所在页（rank 依赖内层排序，不受影响） | |

## 收藏 / 隐藏标记与 `hide/` 改用相关 EXISTS

`is_favorite` / `is_hidden`（画廊与 VD）由 `LEFT JOIN album_images` 改为相关 `EXISTS`，`hide/` 与画册 `~~/images/hide`
改为 `NOT EXISTS`。主键 `(album_id, image_id)` 保证 JOIN 最多一行，行数与取值不变。100 万图副本（三种写法交替 5 轮中位数）：
翻页与原来同价，收藏 / 隐藏集合多大都不变（不相关 IN 在隐藏 50% 时一页 2.5ms → 57ms，故未采用）；
`gallery/all` COUNT 1.7s → 0.86s，`gallery/hide/all` COUNT 1.3s → 1.0–1.2s。

| 是否完成 | 标题 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 标记取值与 hide 计数 | Rust e2e | `test-kabegame` driver：`kabegame-core --test dsl_e2e` | 45 个用例通过；画廊与 VD 行的收藏 / 隐藏标记只在对应图上为 1；`hide/all` 少且只少隐藏图；SQL 不含 `LEFT JOIN album_images` | 已实测 |
| [ ] | 收藏 / 隐藏图标 | 桌面 CEF / Web | 收藏、隐藏若干图后在画廊、画册详情、VD 挂载盘里查看 | 角标与菜单状态正确；取消收藏 / 隐藏后立即更新 | |
| [ ] | 隐藏过滤与计数 | 桌面 CEF / Web | 开关「隐藏已隐藏的图」，看画廊总数、画册树 `image_count` | 计数与改动前一致 | |
| [ ] | 未分类视图 | 桌面 CEF / Web | 打开「未归入画册」视图 | 仅在收藏画册的图仍出现，结果与改动前一致 | 依赖 `is_favorite` 别名 |

## 原生元数据回填后视图实时刷新，预览保持显示

原生元数据参与 `search/native-metadata`，但预览按需解析、整理回填、下载按哈希共享挂载都不发事件，
带 `!词` 的视图要手动刷新才会把图移出。`ensure_native_metadata_*` 改为返回实际改动的图片 id，三处调用方
先发 `image-changed`（`imageMetadataId`，前端 `ImageInfo` 新增该字段）再发 `images-change("change")`；
原生元数据缓存 key 纳入 `imageMetadataId`，面板同图换 id 时保留内容重新取数。前端被动刷新把当前预览图移出视图、rank 定位为空时，继续给弹窗同一个
`ImageInfo` 对象（不再退回裸 id 重取），视图外照旧不给左右箭头。

| 是否完成 | 标题 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 挂载改动 id 单测 | Rust 单测 | `test-kabegame` driver：`kabegame-core --lib native_metadata_attach` | 2 个用例通过：只报告 `image_metadata_id` 真正变化的图片 | 已实测 |
| [x] | 预览对象保留 / 面板不闪自动化 | 前端 Vitest | `npx vitest run`（apps/kabegame） | 24 个文件、232 个用例通过；定位为空时 `previewImage` 仍是同一对象、两侧箭头为 false；同图换 `imageMetadataId` 重新取数但不清空内容 | 已实测；vue-tsc、cargo check 通过 |
| [x] | 整理回填实时更新视图 | 桌面 CEF dev | 清空 dev 库原生元数据后，`!1girl` 搜索下只勾「补充原生元数据」运行整理 | 第 1 页先收到 53 行 `imageMetadataId` 补丁，总数随批次 1397→1342→…→911 实时缩减；终态界面 911 = CLI total 911，第 1 页 100 行 `imageMetadataId` 与库逐行一致 | 已实测（CDP 每 200ms 采样）；用户先前也实测过一次 |
| [x] | 打开预览触发回填 | 桌面 CEF dev | `!1girl` 搜索第 5 页打开 627（PNG 含 1girl、未解析） | +60ms 收到 `image-changed`（`imageMetadataId` 1843）；+596ms 网格移出 627、总数 1399→1398；预览仍是 627，左右箭头收起 | 已实测（CDP 每 30ms 采样）；用户先前也实测过 |
| [x] | 预览不闪烁 | 桌面 CEF dev | 同上，打开后 150ms 内放大到 2 倍 | 移出视图前后缩放保持 2 倍，预览 `<img>` 始终是同一个 DOM 节点 | 已实测 |
| [x] | 无关视图不受影响 | 桌面 CEF dev | 不带搜索的画廊第 6 页打开 628（未解析） | 收到补丁（`imageMetadataId` 1844）后 3s 内列表成员、总数 1644、左右箭头均不变 | 已实测 |
| [x] | 原生元数据面板不闪 | 桌面 CEF dev | 打开未解析过原生元数据的图（628） | +31ms 面板 `loaded`；+92ms 补丁触发后台重取，期间一直 `loaded`，没有回到 `loading` / 空白 | 已实测（30ms 采样） |

## 预览中删除后按设置的切图方向接续

「设置 → 通用 → 切图方向」提供自动（默认）、上一张、下一张三档。`ImageGrid.resolvePreviewAnchor`
在自动模式记住本次预览最近 5 次**手动**切图（箭头 / 键盘 / 滑动）的方向，取出现较多的一方，平票取最近一次，
没有记录为下一张；幻灯片自动播放的切图不计入（弹窗 `switch` 事件带 `source: "manual" | "slideshow"`），
关闭预览时清空记录。固定模式则直接使用设置方向。
删除 / 隐藏 / 滑动移除当前预览图后：往后接续同下标那张（原行为）；往前接续旧顺序里最近一张仍在视图的
上一张，本页前面已无图片时交给分页器翻到上一页末张。本页被删空时不再关闭预览，改为翻到上一页末张。

| 是否完成 | 标题 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 方向接续自动化 | 前端 Vitest | 执行 `deno task test -c kabegame --skip cargo` | 自动、固定上一张、固定下一张均通过 | 已实测；vue-tsc 通过 |
| [ ] | 设置默认值与持久化 | 桌面 CEF / Web / Android | 首次打开设置，再依次选择上一张、下一张并重启 / 刷新 | 默认选中「自动（跟随最近 5 次手动切图的多数方向）」；选择后保持不变 | |
| [ ] | 往后切后删除 | 桌面 CEF / Web | 预览中按右键切到下一张，删除当前图 | 显示原来的下一张，与改动前一致 | |
| [ ] | 往前切后删除 | 桌面 CEF / Web | 预览中按左键切到上一张，删除当前图 | 显示原来的上一张；连续删除持续往前 | |
| [ ] | 固定上一张 | 桌面 CEF / Web / Android | 设置切图方向为「上一张」，不手动切图，隐藏或删除预览中的图片 | 始终接续原来的上一张；位于页首时按需翻到上一页末张 | |
| [ ] | 固定下一张 | 桌面 CEF / Web / Android | 设置切图方向为「下一张」，先往前切图，再隐藏或删除当前图片 | 忽略最近切图方向，接续原来的下一张 | |
| [ ] | 往前切删到本页首张 | 桌面 CEF / Web，图片多于一页 | 在第 2 页往前切到本页第一张后删除 | 翻到第 1 页并显示其末张，提示「已进入上一页」，弹窗不关闭 | |
| [ ] | 第一页首张往前删除 | 桌面 CEF / Web | 第 1 页往前切到首张后删除 | 退到同下标那张（原下一张），不关闭 | |
| [x] | 多数方向自动化 | 前端 Vitest | `npx vitest run src/components/ImageGrid.previewFollowPage.test.ts`（apps/kabegame） | 31 个用例通过：手动 next、next、prev（中间夹幻灯片 prev）后删除按下一张接续；6 次 3:3 时只看最近 5 次（next 3:2）按下一张接续 | 已实测 |
| [x] | 多数方向 | 桌面 CEF / Web | 预览中按右键两次、再按左键一次，删除当前图 | 按多数方向接续原来的下一张，而不是最近一次的上一张 | 桌面 CEF dev 已实测（CDP，用隐藏代替删除）：222→225→227→225，隐藏 225 后显示 227 |
| [x] | 幻灯片不计入 | 桌面 CEF | 手动按右键一次后开启向前幻灯片播放若干张，停止后删除当前图 | 按下一张接续（幻灯片的向前切图不影响方向） | 桌面 CEF dev 已实测：227→234（手动），幻灯片自动退回 227 后停止，隐藏 227 显示 234 |
| [x] | 关闭后方向复位 | 桌面 CEF / Web | 往前切后关闭预览，重新打开某张图直接删除 | 按下一张接续 | 桌面 CEF dev 已实测：连按左键 3 次后关闭，重开 222 直接隐藏，显示 227 |
| [ ] | 隐藏 / Android 滑动移除 | 桌面 CEF / Android | 往前切后用隐藏或上滑移除 | 同样按上一张接续 | |

## 预览切图不再先关闭再打开

`ImageGrid.reconcilePreview` 改为不对称协调：目标 id 在当前快照里就直接交给弹窗，不等
`liveQuery.loading` 结束；只有不在快照里时才等列表就绪再定位或降级。修复被动刷新在途时
（web 弱网尤甚）点上/下一张，`previewProp` 短暂为 `null` 导致弹窗关闭又重开、幻灯片被停、缩放重置。

| 是否完成 | 标题 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 读取在途切图自动化 | 前端 Vitest | 执行 `deno task test -c kabegame --skip cargo` | 22 个文件、167 个用例通过；新增 3 个用例在修复前失败 | 已实测；前端类型检查通过 |
| [ ] | web 弱网视图内切图 | Web + DevTools 限速（Slow 3G） | 有后台下载持续产生 `images-change` 时打开预览，连续点下一张 / 按方向键 | 弹窗始终不关闭、无闪烁；幻灯片播放不被打断 | 修复前高概率先关后开 |
| [ ] | web 弱网跨页切图 | Web + DevTools 限速 | 预览页尾图点下一张跨到下一页 | 新页就绪后直接显示首张，弹窗不经历关闭 | |
| [ ] | 切图后目标被刷新移走 | 桌面 CEF / Web | 切到邻居后，在途刷新返回时该图已被挤出本页（开跟页） | 返回前保持当前图；就绪后定位并翻到所在页，id 与缩放保持 | 关跟页时转单图模式 |
| [ ] | 深链接首次打开不受影响 | 桌面 CEF / Web | 通过 URL `pvwimgid` 打开不在当前页的图 | 仍等当前页就绪后定位，目标页确认后才打开 | |

## yande.re / konachan / danbooru 插件：标签、分数分级扩展与移除标签列表模式

yande.re 插件升到 1.1.0：下载时把详情页侧栏标签按类型写入 `yandere/<类型>` 标签画册
（artist / copyright / character / circle / faults / general，未知类型并入 general），key 为站点标签名；
新增 `metadata_migrations/migrate.js` 的 `provideLabels`，给 1.0.0 下载的历史图片补标签。同时把插件自带的「标签类型 → 标签」PathQL 扩展换成与 konachan 相同的分数（score）、分级（rating）筛选。规则与 konachan 1.3.0 一致。
konachan（1.4.0）与 yande.re 都移除「标签列表」爬取模式、对应配置项与推荐配置，只保留「全部」和「标签」。
danbooru 升到 1.2.0，同样移除「标签列表」模式、对应配置项与推荐配置，只保留标签、人气榜和全部；「每页条数」只在全部和标签模式显示。

| 是否完成 | 标题 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [ ] | 新下载带标签 | 桌面 CEF | 用 yande.re 插件「全部」模式爬 1 页 | 画册页「标签」分区出现 `yandere/` 下各类型目录；单图标签数约等于侧栏标签数 | |
| [ ] | 标签类型分组 | 桌面 CEF | 打开一张带画师、角色、版权标签的图的标签面板 | 画师在 `yandere/artist`、角色在 `yandere/character`、版权在 `yandere/copyright` | |
| [ ] | 历史图片补标签 | 桌面 CEF | 用 1.0.0 下载若干图后升级到 1.1.0，等元数据迁移完成 | 旧图补上与新下载同规则的标签，metadata 内容不变 | |
| [ ] | 按标签搜索 | 桌面 CEF | 画廊搜索里按某个 yande.re 标签筛选 | 只返回挂了该标签的图 | |
| [ ] | yande.re 分数扩展 | 桌面 CEF | 画廊插件扩展进入 yande.re → score | 列出有图的 `N+` 档位且计数正确；手输 `100-500`、`-50` 路径能过滤 | |
| [ ] | yande.re 分级扩展 | 桌面 CEF | 画廊插件扩展进入 yande.re → rating | 按 Safe / Questionable / Explicit 顺序列出且计数正确；不再出现「标签类型 → 标签」 | |
| [ ] | 标签列表模式已移除 | 桌面 CEF | 打开 konachan、yande.re 与 danbooru 的收集弹窗 | konachan 与 yande.re 只有「全部」「标签」，danbooru 只有「标签」「人气榜」「全部」；标签匹配式、标签类型、排序、跳过数等配置项不再出现；推荐配置里没有标签列表示例 | |
| [ ] | 旧标签列表配置 | 桌面 CEF | 用升级前保存的标签列表运行配置执行任务 | 任务报「未知的爬取模式」失败，不卡住 | |
| [ ] | 剩余模式不受影响 | 桌面 CEF | 三个插件各跑一次剩余的每种模式 1 页 | 正常下载，带标签与元数据 | konachan.com 与 donmai.moe 需先在畅游过验证 |

## zerochan 首页人气 500、随机排序与标签

zerochan 插件升到 1.1.0。「浏览全部 + 人气」请求 `/?s=fav&p=1` 时站点返回 500：首页人气榜的「全部时间」档（`t=0`，也是不带 `t` 时的默认）在站点侧就坏了，
站点菜单里的链接同样 500，标签页的人气不受影响。新增 `popular_range`（`t=1` 近一周 / `t=2` 近三个月，默认 2），只在全部 + 人气时显示，非法值回落到 2；
新增 `random` 排序，首页可翻页，标签页和搜索只有一页。
下载时把侧栏标签按类型写入 `zerochan/<类型>` 标签画册（类型集合同 description.ejs 的 TYPE_ORDER，未知并入 theme），key 由规范名派生：
变音符折叠、撇号去掉、其余标点换空格、转小写，超过 64 字节跳过；新增 `metadata_migrations/migrate.js` 的 `provideLabels` 给历史图片补标签，最低应用版本 4.5.0。

| 是否完成 | 标题 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 全部 + 人气 | dev CLI（`--data dev`） | `run-cli.sh zerochan --var crawl_mode=all --var sort_order=fav --var quality=medium`，限时 40s | 列表 URL 为 `/?s=fav&t=2&p=1`，第 1 页 48 条，正常下载 | 已实测；改前同配置报「打开页面失败（HTTP 500）」 |
| [x] | 全部 + 随机 | dev CLI | `crawl_mode=all sort_order=random`，限时 40s | 列表 URL 为 `/?s=random&p=1`，第 1 页 48 条，正常下载 | 已实测；curl 确认第 2 页也有作品 |
| [ ] | 时间范围显隐 | 桌面 CEF | 收集弹窗里切换爬取模式与排序 | 只有「浏览全部 + 人气」时显示「人气时间范围」，默认近三个月 | |
| [ ] | 近一周 | 桌面 CEF | 全部 + 人气 + 近一周跑 1 页 | 列表 URL 带 `t=1`，正常下载 | |
| [ ] | 标签 / 搜索 + 随机 | 桌面 CEF | 标签 `Arknights` 选随机，起止页 1~2 | 第 1 页正常下载，第 2 页为空时任务正常结束 | |
| [ ] | 标签 + 人气不受影响 | 桌面 CEF | 标签 `Arknights` 选人气跑 1 页 | URL 不带 `t`，正常下载 | |
| [x] | 下载带标签 | dev CLI | `crawl_mode=tag tag=Arknights sort_order=fav quality=medium`，限时 35s | 10 张均有 metadata；标签关联 112 条，等于元数据标签总数；`Kal'tsit` 落为 `zerochan/character/kaltsit` | 已实测 |
| [x] | 迁移脚本派生 | deno 脚本 | 用 dev 库 126 条 zerochan metadata 调 `provideLabels` | 1056 个标签派生 1053 个，key 全部合规；只跳过 2 个超过 64 字节的系列名 | 已实测 |
| [ ] | 历史图片补标签 | 桌面 CEF | 用 1.0.0 下载若干图后升级到 1.1.0，等元数据迁移完成 | 旧图补上 `zerochan/<类型>` 标签，metadata 不变 | |
| [ ] | 标签分类与搜索 | 桌面 CEF | 画册页查看「标签」分区，并在画廊搜索里按某个 zerochan 标签筛选 | 角色、作品、画师、来源等分在对应目录；搜索只返回挂了该标签的图 | |

## konachan / yande.re 排行榜与 danbooru 分级过滤

konachan（1.4.0）与 yande.re（1.1.0）新增「排行榜」爬取模式，对应 Moebooru 的人气榜：日 / 周 / 月榜走 `popular_by_day|week|month`，
可指定日期并往前回溯多期；最近 24 小时 / 一周 / 一月 / 一年走 `popular_recent?period=`，只有当期。每期只有一页、最多 40 张，`page` 参数无效。
榜单页不接受 `tags`，分级过滤改由插件读页面脚本 `Post.register` 里的单字母 rating 筛选；konachan.net 本身只渲染全年龄作品。
danbooru（1.2.0）新增「分级过滤」（g / s / q / e，只在全站显示）：全部与标签模式拼 `rating:` 元标签（实测不占 2 标签名额），
人气榜按 `article[data-rating]` 筛，某页筛空时继续下一页；画廊插件扩展新增 `rating` 维度（`$.rating` 四档）。

| 是否完成 | 标题 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | yande.re 往期日榜 + 分级 | dev CLI（经主程序） | `run-cli.sh yandere --var crawl_mode=popular --var popular_scale=day --var popular_date=2026-09-01 --var popular_periods=2 --var rating=questionable --var quality=medium`，限时 60s | 依次打开 9/1、8/31 日榜；分级过滤 40→27、40→21；入库全部 Questionable 且带标签 | 已实测：27 张全 Questionable，271 条标签关联；与站点页面脚本统计一致 |
| [x] | konachan.com 年榜 + 限制级 | dev CLI | `source_site=com crawl_mode=popular popular_scale=1y rating=explicit`，限时 45s | 注入畅游 Cookie 与 CEF UA；40→32；入库全 Explicit | 已实测：29 张全 Explicit |
| [x] | konachan.net 当期周榜 | dev CLI | `source_site=net crawl_mode=popular popular_scale=week`，限时 40s | 不注入 Cookie；只拿到全年龄作品 | 已实测：18 张全 Safe |
| [x] | danbooru 标签 + 分级元标签 | dev CLI | donmai.moe 上 `crawl_mode=tags mode_tag_value=touhou,1girl rating=g` | 请求带 `rating%3Ag`；正常返回 20 张，不触发 2 标签上限 | 已实测；同环境 3 个普通标签返回 422 |
| [x] | danbooru 人气榜筛空继续翻页 | dev CLI | donmai.moe 上 `crawl_mode=popular end_page=2 rating=s` | 两页都提示「没有分级为 s 的作品，继续下一页」，不在第 1 页就结束 | 已实测；donmai.moe 只有 General |
| [x] | danbooru 分级扩展 SQL | dev 库直查 | 用等价的 composed 子查询执行 `rating_router` / `rating_provider` 的 SQL | 按 General / Sensitive / Questionable / Explicit 顺序列出且计数正确 | 已实测：197 / 21 / 4 / 17；按 Sensitive 筛出 21 |
| [ ] | 排行榜表单显隐 | 桌面 CEF | 两插件收集弹窗选「排行榜」，在日 / 周 / 月与「最近」类型间切换 | 只有日 / 周 / 月显示「排行榜日期」「回溯期数」；起止页、标签组合不显示；yande.re「排序」不显示 | |
| [ ] | 排行榜日期边界 | 桌面 CEF | 日期选今天、留空，各跑月榜 1 期 | 留空取当期；今天在站点时区尚未开始时榜单可能为空，任务正常结束不报错 | |
| [ ] | danbooru 分级配置显隐 | 桌面 CEF | danbooru 收集弹窗在 donmai.moe / 全站之间切换 | 只有全站显示「分级过滤」；切回 donmai.moe 后提交参数里没有 `rating` | |
| [ ] | danbooru 全站分级过滤 | 桌面 CEF | 先在畅游通过 danbooru.donmai.us 验证，再用全站跑标签与人气榜模式加分级 | 入库作品分级与所选一致 | 本机直连全站已被 Cloudflare 质询拦截，未能实测 |
| [ ] | danbooru 分级扩展入口 | 桌面 CEF | 画廊插件扩展进入 Danbooru → rating | 列出四档分级与计数，点进后只剩对应分级 | CLI 的 pathql 查不到插件扩展，需在 app 里验证 |

## V8 任务取消立即结束

`execute_v8_entry` 让 `run_crawl` 与任务取消 token 做 `select!`，取消即丢弃整个运行时 future；
同步死循环仍由 `terminate_execution` 打断。修复两种事件循环空闲时的取消失效：插件 `await` 计时器时要等计时器到点才结束；
插件 `try/catch` 吞掉 `Task canceled` 后继续执行，最终以成功（`Ok`）收尾。常规 HTTP 下载的单次尝试与重试退避同样随任务取消立即中断，
不再等首包或 600s 请求超时。

| 是否完成 | 标题 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 空闲事件循环取消自动化 | Rust 单测 | `.claude/skills/test-kabegame/driver.sh kabegame-core --lib plugin::v8` | 17 个用例通过；新增 `execute_entry_cancels_idle_event_loop_immediately` 覆盖计时器与吞错两种情形 | 已实测；修复前探针分别 7.7s / 8s 才结束且吞错情形返回 `Ok(())`，修复后均 <1ms 返回 `Canceled` |
| [x] | 下载器单测 | Rust 单测 | `.claude/skills/test-kabegame/driver.sh kabegame-core --lib downloader` | 21 个用例通过 | 已实测 |
| [ ] | 插件 sleep 期间取消 | 桌面 CEF | 运行带分页间隔 sleep 的 V8 插件，在 sleep 期间点取消 | 任务立即变为已取消，不再发出后续请求 | |
| [ ] | 慢下载取消 | 桌面 CEF | V8 插件下载大图或慢速源时取消任务 | 进行中的下载立即结束、不再计入成功；任务状态为已取消 | |
| [ ] | 死循环插件取消 | 桌面 CEF / CLI | 运行 `for (;;) {}` 的插件后取消 | 仍能正常取消 | `terminate_execution` 路径未变 |

## V8 任务偶发卡死 / 进程闪退（op 轮询跨线程竞争）

`execute_v8_entry` 原先在调度器的多线程 runtime 上 `Handle::current().block_on`。deno_core 的 op driver 经 `deno_unsync::spawn`
把 !Send 的 op 轮询任务派到「当前」runtime（前提是 current_thread），于是它落到别的 tokio worker 上，与 V8 线程并发借用同一个
`RefCell` 提交队列：`futures_unordered_driver.rs:294/309` 报 `RefCell already borrowed`，轮询任务死掉后任务永久卡住
（fetch 的 30s 超时也在被遗弃的 op 里，不会触发），或 panic 落在不可展开的 V8 回调里使**整个进程 abort**。
与插件和配置无关，op 越多越容易撞上；`deno_unsync` 里的 `debug_assert` 因 dev profile 对依赖关了 `debug-assertions` 未能报出。
改为每个任务在自己的 blocking 线程上新建 current_thread runtime 来 `block_on`，取消 watcher 挂在主 runtime 上。

| 是否完成 | 标题 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 压测单测 | Rust 单测 | `.claude/skills/test-kabegame/driver.sh kabegame-core --lib execute_entry_async_ops_never_lose_wakeups` | 多线程 runtime 下 3000 轮 × 32 个并发 `crypto.subtle.digest` 在 1s 内完成 | 已实测：修复前 4/4 失败（2 次 panic 后卡满 60s、2 次进程 abort），修复后 6/6 通过，约 0.3s |
| [x] | V8 单测回归 | Rust 单测 | `.claude/skills/test-kabegame/driver.sh kabegame-core --lib plugin::v8` | 18 个用例全部通过，含两条取消用例 | 已实测 |
| [x] | 临时插件复现 / 对照 | dev app（`app-run.sh`） | 只做异步 op 的临时插件，四种模式各跑：并发 digest、串行 digest、并发 `setTimeout`、仅同步 | 全部 completed，app 不闪退 | 已实测：修复前用旧 CLI `--via local` 跑，并发 digest 7/7 失败（卡死或 abort 134）、串行 digest 3/8 失败，`setTimeout` 与仅同步全部完成；修复后在 dev app 中 6/6 completed，并发 digest 9.6 万个 op 约 0.25s |
| [x] | 真实插件回归 | dev app | wallhaven 排行榜跑 1 页 | 正常完成并下载 | 已实测：20 张新下载 + 4 张去重，0 失败 |
| [ ] | 长任务不再偶发卡住 | 桌面 CEF | 用 fetch 较多的插件（如 wallhaven 多页、anihonet）连续跑几个多页任务 | 没有任务停在某条日志后不动；任务抽屉进度正常推进 | 修复前偶发，需多跑几次 |
| [ ] | 取消仍立即生效 | 桌面 CEF / CLI | 任务运行中、sleep 中、`for (;;) {}` 死循环中分别取消 | 均立即变为已取消 | watcher 改挂主 runtime 后需在真实环境确认死循环取消 |
| [ ] | Android V8 任务 | Android | 跑一个 V8 插件 1 页 | 正常完成 | 线程模型改动同样作用于 Android |

## konachan R18 站借用畅游 Cookie 与分级过滤

konachan 插件升到 1.4.0。源站选 konachan.com 时，页面、`post.json` 和 `/jpeg/` 原图都会被 Cloudflare 质询拦成 403，
现在任务开始时会 `requireCookie("konachan.com")` 并换成畅游的 CEF UA（`cf_clearance` 绑定签发时的 UA）。原图和页面同域，所以浏览器身份全程保留，下载时也带着；
返回 403 或验证页时任务报错，并提示先在畅游里通过验证。新增「分级过滤」配置（`rating:` 元标签拼进搜索串），「全部」和「标签」两种爬取模式都生效，只在源站选 com 时显示。konachan.net 不注入 Cookie。

| 是否完成 | 标题 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | com 站标签模式 + 限制级 | dev CLI（`--data dev`） | `run-cli.sh konachan --var source_site=com --var crawl_mode=tags --var mode_tag_value=bikini --var rating=explicit --var quality=high`，限时 50s | 日志显示已注入 Cookie 与 CEF UA；31 张全部 Explicit，均带 metadata；标签数 757 与侧栏标签总数一致；原图约 6712×3509 / 12MB | 已实测；与 Chrome 中同一搜索页比对，31 个 ID 正是源站页前 31 条。改前同配置第一页就 403 |
| [x] | com 站标签列表 + 存疑 | dev CLI | `crawl_mode=tag_list tag=genshin rating=questionable quality=medium`，限时 40s | 每个标签的列表 URL 带 `+rating%3Aquestionable`；25 张全部 Questionable | 已实测；标签列表模式已在本版移除，此项仅留作记录 |
| [x] | net 站全部模式回归 | dev CLI | `source_site=net crawl_mode=all`，限时 30s | 不注入 Cookie，照常下载；16 张全部 Safe | 已实测 |
| [ ] | 未通过验证的提示 | 桌面 CEF | 清掉畅游里 konachan.com 的 Cookie 后，用 com 站跑任务 | 出现「未从畅游取到 Cookie」警告；任务以「返回 403 / 返回了验证页，请先在畅游中打开 … 通过验证」失败 | |
| [ ] | 分级配置显隐 | 桌面 CEF | 打开收集弹窗，在 net / com 之间切换源站 | 只有 com 时显示「分级过滤」；切回 net 后提交的参数里没有 `rating` | |

## 移除 `add_task` 命令

后端 `add_task`（只落库 + 发 `task-added`，不入调度队列）没有任何前端调用方，从 core `commands::task`、
Tauri 命令注册、ACL 白名单与 web JSON-RPC 入口一并删除。创建任务统一走 `start_task`；
`Storage::add_task` 与应用 IPC 的 `StorageAddTask` 不受影响。

| 是否完成 | 标题 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | Rust 编译 | 本机 | `.claude/skills/check-kabegame/driver.sh --skip vue` | 无 error | 已实测 |
| [ ] | 手动收集任务 | 桌面 CEF | 收集弹窗选插件提交 | 任务抽屉立即出现新任务并正常下载 | 走 `start_task` |
| [ ] | 本地导入 / 拖入导入 | 桌面 CEF | 画廊拖入文件夹；「本地导入」弹窗提交 | 任务创建并导入成功 | |
| [ ] | 定时任务 | 桌面 CEF | 运行配置设为 1 分钟后触发 | 到点创建任务并执行 | 调度器直接用 `Storage::add_task` |
| [ ] | web 端建任务 | Web | web 端提交收集任务 | 正常创建；调用 `add_task` 返回方法不存在 | |

## kabegame-cli 优先经应用 IPC 执行

CLI 的 PathQL、插件导入/运行和单文件导入通过 `Backend` 共用一套业务组合：同数据目录的主程序
可用时走 IPC，否则回退 CLI 本地运行时。`PluginRun` 的解析、配置合并与任务提交统一在
`commands::task::run_plugin`；`data import-image` 改为 `local-import` 任务并移除 `--metadata`。

| 是否完成 | 标题 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | Rust 编译检查 | 本机 | `.claude/skills/check-kabegame/driver.sh --skip vue` 与 `-c kabegame-cli --skip vue` | app/core/CLI 无 error | 已实测 |
| [x] | core 参数解析单测 | 本机 | `.claude/skills/test-kabegame/driver.sh kabegame-core --lib commands::task` | key=value、positional、options 名称映射和未知 key 报错均通过 | `3 passed / 0 failed / 0 ignored` |
| [x] | CLI 单测 | 本机 | `.claude/skills/test-kabegame/driver.sh kabegame-cli` | 全部通过；`--metadata` 已被 clap 拒绝 | `20 passed / 0 failed / 0 ignored` |
| [x] | app/local PathQL 一致 | dev app + debug CLI | app 运行时用 `--data dev` 构建的 CLI 查询 `images://gallery/all/x10x/1`，再以 `--via local` 查询 | 两者输出一致；app 模式顶部显示主程序版本 | 已实测：`x5x/1` 两种模式输出逐字节一致，stderr 显示「经主程序执行（版本 4.5.1）」；单次约 0.04s |
| [x] | 单文件导入与去重 | dev app + debug CLI | 向 `/父/子` 画册导入图片，再重复导入 | 任务抽屉出现 `local-import`；画廊/画册立即刷新；CLI 分别打印成功/去重计数 | 已实测（未加入画册）：画廊计数 1457→1458 实时刷新，任务抽屉出现本地导入；重复导入打印「去重 1」。`--album` 仅验证了不存在路径经 IPC 报「未找到画册树路径」，未向真实画册写入 |
| [x] | 临时包与已安装插件 | dev app + debug CLI | 两种模式各运行 `.kgpg --id test-x --var k=v --dry-run` 和已安装 id | 最终配置一致；未知 key 均列出可用 key；实际运行日志/进度正常 | 已实测：konachan 已安装 id 与 `.kgpg --id konachan-ipc-test` 两种模式 dry-run 输出一致（含默认配置合并、`end_page` 转数字）；`--var max_pages=1` 两种模式报同样的可用 key；`--id` 用于 id 模式报错 |
| [x] | 取消任务 | dev app + debug CLI | `plugin run` 执行中按 Ctrl-C | CLI 经选中后端取消，任务状态变为 canceled | 已实测：app 模式 konachan 运行 12s 后 SIGINT，CLI 打印「任务已取消」，任务抽屉显示已取消（下载 2 张）；stderr 无 `[DEBUG]` |
| [x] | WebView 宿主能力 | dev app + debug CLI | app 模式运行 WebView 插件，再加 `--via local` | app 模式可运行；local 模式明确报只支持 V8 | 已实测：app 模式 `plugin run webpage --var url=https://konachan.net/post --var backend=webview` 发现 81 张、完成 81 张；`--via local` 报只支持 v8（`webpage` 的 script_type 为 builtin，改动前本地同样不可跑）。注意：运行期间不要用 playwright 连 CDP，会劫持 WebView 原生下载导致「Native download failed」 |
| [x] | 插件导入 | dev app + debug CLI | 导入正常 `.kgpg`，再导入坏包 | 正常包使插件列表立即刷新；坏包在 CLI 本地解析阶段失败且无目录残留 | 已实测：随机字节 `.kgpg` 在本地解析阶段报「读取 KGPG v3 头部失败」，插件目录无残留；app 模式重新导入 konachan.kgpg 成功 |
| [x] | 数据目录门控 | dev app + prod 构建的 CLI | app 运行时用默认（prod）构建的 CLI，再加 `--via app` | auto 提示目录不同并回退 local；app 强制模式报错 | 已实测：默认（prod）构建的 debug CLI 在 dev app 运行时 auto 提示「数据目录不同」并回退 local；`--via app` 报同样原因 |
| [x] | 主程序未运行 | 关闭 app | 执行 auto 与 `--via app` 命令 | auto 立即本地执行，无 10s 等待/无弹窗；app 强制模式报未连接 | 已实测（以不同 `TMPDIR` 模拟 socket 不存在，未关闭 app）：auto 0.06s 内本地执行、无弹窗；`--via app` 报连接失败 |
| [ ] | 任务 panic 兜底 | dev app（debug 构建） | 临时在某插件执行路径注入 `panic!`（或复现上一行的修复前场景）后运行任务 | 任务变为「失败」，日志含「任务执行时发生内部错误（panic）」；其余任务照常执行，运行名额被释放 | `worker_loop` 以 `catch_unwind` 包住 `run_task`；仅代码检查，未注入 panic 实测 |
| [ ] | CLI 日志语言跟随应用设置 | dev app + 以 `--data dev` 构建的 debug CLI | 应用设置切到中文 / 英文后分别执行 `data import-image` 或 `plugin run` | 日志文案与应用界面语言一致，无 `{"_i18n":...}` 原文；`--via local` 同样跟随设置 | local 模式已实测（设置 zh → 中文日志）；app 模式待重启 dev app 后验证 |
| [ ] | 重复导入不再卡死任务 | dev app（debug 构建）+ 下载间隔 > 0 | 对同一已入库文件反复执行 `data import-image`（或 GUI 拖入同一文件）数十次 | 每次都是「去重 1」并完成；终端无 `attempt to subtract with overflow`；任务抽屉无停在「运行中 0%」的本地导入 | 修复前偶发：`local-import` 的 start_time 比当前时间晚 1ms，`wait_after_download_if_needed` 下溢 panic 掉 task worker |
| [ ] | IPC 调试与旧版协议 | 本机 | 设 `KABEGAME_IPC_DEBUG=1`；再用旧 app 配新 CLI | 开关打开时恢复 DEBUG；旧 app 下 auto 回退且不挂起 | `KABEGAME_IPC_DEBUG=1` 已实测恢复 DEBUG；旧版 app 未测（无旧版二进制） |
| [x] | CLI 移除 `--data` | dev app + 以 `--data dev` 构建的 debug CLI | `plugin run <id> --data dev`；再不带参数执行 `plugin run <id> --dry-run`、`plugin import`、`pathql query` | 前者被 clap 拒绝（退出码 2）；后三者使用 `.kabegame/debug/data`，dev app 运行时走 app 模式 | 已实测：`--data dev` 退出码 2；不带参数的 `plugin run --dry-run`、`plugin import`、`pathql query` 均显示「经主程序执行」并使用 `.kabegame/debug/data`；`plugin run --help` 不再含 `--data` |

## konachan / yande.re / danbooru id 范围模式（konachan 1.5.0、yandere 1.2.0、danbooru 1.3.0）

三个插件新增爬取模式 `id_range`：配置项 `id_start` / `id_end`（`int`，`min: 1`）只在该模式下显示。脚本校验两者为正整数、
`id_end >= id_start` 且相差不超过 5000，然后用站点元标签 `id:A..B order:id` 升序翻列表页；总数（Moebooru 取
`post.xml?…&limit=1` 的 `count`，danbooru 取 `/counts/posts.json`）只用来摊进度、并在抓满后停止，取不到时翻到空页或首条重复为止。
分级过滤照常拼 `rating:`；yande.re 的「排序」在该模式下不拼。danbooru 列表页不渲染已删除作品但计数算它们，所以搜索串加
`-status:deleted`；donmai.moe 列表页只渲染 General，所以该源站固定加 `rating:g`。danbooru 的「每页条数」在该模式下也显示。
yande.re 列表里仍保留已删除作品（站点不支持搜索端排除），详情页取不到图时记 WARN 跳过。

| 是否完成 | 标题 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | konachan 单页区间 | dev CLI | `run-cli.sh konachan --var crawl_mode=id_range --var id_start=380000 --var id_end=380060` | completed，新下载 14，与 `post.xml` count 一致 | 已实测 |
| [x] | konachan 跨页区间 | dev CLI | 同上，`id_end=380300` | completed，新下载 94（= count），打开 3 页后停止，入库 id 在 380010..380300 内，进度 100% | 已实测 |
| [x] | yande.re 跨页区间 | dev CLI | `run-cli.sh yandere --var crawl_mode=id_range --var id_start=1200000 --var id_end=1200050` | completed，count 51，新下载 50，打开 2 页后停止；1200015 为站点已删除作品，WARN「详情页没解析出图片地址」后跳过 | 已实测 |
| [x] | danbooru 全站跨页 | dev CLI | `run-cli.sh danbooru --var source_site=danbooru --var crawl_mode=id_range --var id_start=9000000 --var id_end=9000060 --var per_page=20` | completed，新下载 49，与 `/counts/posts.json`（含 `-status:deleted`）一致，打开 3 页 | 已实测 |
| [x] | danbooru 分级 + 每页 200 | dev CLI | 同上，`id_end=9000100 rating=g per_page=200` | completed，新下载 70（= count），只开 1 页 | 已实测 |
| [x] | danbooru donmai.moe | dev CLI | 默认源站，`id_start=9000000 id_end=9000010` | completed，计数 6、新下载 6、只开 1 页（修正前计数 9 与页面 6 张不符，会多翻一页空页） | 已实测 |
| [x] | 相差超过 5000 | dev CLI | konachan `1..5002`、yandere `10..5011` | 任务 failed：「id 范围最多相差 5000，当前 … 相差 5001」，不发任何请求 | 已实测 |
| [x] | 结束小于起始 | dev CLI | konachan `500..400`、danbooru `500..499` | 任务 failed：「结束 id（…）需要不小于起始 id（…）」 | 已实测 |
| [x] | 旧模式回归 | dev CLI | konachan / yandere `crawl_mode=all` 第 1 页；danbooru 全站 `crawl_mode=tags mode_tag_value=hatsune_miku` 第 1 页 | 正常打开列表页并下载 | 已实测（限时取消） |
| [ ] | 表单显隐 | 桌面 CEF | 收集弹窗分别选三个插件，爬取模式切到「id 范围」 | 只显示起始 id / 结束 id（及源站、质量、分级；danbooru 另有每页条数），页数、排行榜字段与 yande.re 的排序隐藏 | |
| [ ] | konachan R18 站 + 分级 | 桌面 CEF | 畅游通过 konachan.com 验证后，源站选 R18 站、分级选 Explicit，跑一个小区间 | 只下载 Explicit 作品；若 `post.xml` 被拦，日志总数显示「未知」但仍逐页抓完 | |

## wallhaven 插件：通用搜索与搜索 URL（插件 0.3.0）

新增 V8 插件 `wallhaven`。站点的 `/latest`、`/toplist` 只是 `/search` 的预设（匿名默认 `categories=110&purity=100`）。插件提供「搜索条件」与
「搜索 URL」两种模式：前者直接暴露关键词、分类（综合 / 动漫 / 人物）、分级（SFW / 擦边）、排序（上传时间 / 相关度 / 随机 / 浏览 / 收藏 / 排行榜 / 热门）、
顺序、排行范围（仅排行榜显示）、最低分辨率（任意 / 2K / 4K）、画面方向（横屏 / 竖屏 / 方形）与精确比例（站点比例表原值）；后者仿照 e-shuushuu
接受 `https://wallhaven.cc/search?…`，原样转交搜索参数，只删除 `page`，由统一的起止页控制分页。Latest 与月度 Toplist 作为推荐配置提供。
列表走 `/api/v1/search`，每张再调 `/api/v1/w/<id>` 补上传者与标签；API 匿名限流 45 次/分钟，
所有请求串行节流到 1.5s 一次，429 时等 20s 重试。实测的站点行为：
- `purity=000` 时网页与 API 都退回只搜 SFW（结果与 `purity=100` 逐项相同），插件显式发 `100` 并 warn；`categories=000` 时 API 返回全部分类，插件显式发 `111`；
- `ratios` 里只要出现具体比例，`landscape` / `portrait` 就被整体忽略（`1x1,landscape` 只剩 1x1），所以与方形或精确比例混选时，
  横屏 / 竖屏展开为比例表的宽 + 超宽列 / 竖屏列；只选横屏 / 竖屏时保留 token（覆盖 4:3、3:4 等表外比例，竖屏 6.7 万张，展开后只剩 7.6 千）；
- 最低分辨率按比例换算：每个比例取「短边 1440 / 2160、长边按比例」的框（横屏 / 竖屏 token 按 16:9），`atleast` 取各框逐边最小值，未选比例为短边 × 短边；
- API 忽略 `seed`（同 seed 同页两次结果不同），网页 `/search` 认 seed，所以随机排序由插件自生成 seed、改从网页列表取 ID，原图地址从详情接口拿。
- 示例 URL `categories=110&purity=010&atleast=1280x800&ratios=16x9&sorting=date_added&order=desc&page=2` 的网页与 API 前两页均为 24 条，
  ID 序列逐项一致；URL 模式删除 `page=2` 后，实际页码由 `start_page` / `end_page` 覆盖。

标签统一挂到 `wallhaven/tag`，key 派生不出时退回 `tag-<id>`；`description.ejs` 还原源站暗色侧栏。站点在中国大陆直连超时，插件标记 `auth.needProxy`；
宿主 fetch 只读 `HTTP_PROXY` 等环境变量，GUI 启动的 app 没有这些变量时请求会挂到超时。

| 是否完成 | 标题 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 默认配置 = Latest | release CLI | `run-cli.sh wallhaven --release --var end_page=1` | 搜索参数为 `categories=110&purity=100&sorting=date_added&order=desc`；ID 序列与网页 `/latest` 第 1 页逐项一致 | 0.3.0 已回归：24 张全部按 URL 去重、0 失败；此前 API 同参数第 2 页与 `/latest?page=2`、`sorting=toplist&topRange=1M` 第 2 页与 `/toplist?page=2` 也逐项一致 |
| [x] | 排行榜 + 横屏 + 2K | dev CLI（经主程序） | `--var sorting=toplist --var top_range=1w --var orientation=landscape --var min_resolution=2k --var end_page=1` | 参数带 `ratios=landscape&atleast=2560x1440`；ID 序列与网页同条件逐项一致 | 已实测：24/24 带 metadata，分辨率均 ≥ 2560×1440 |
| [x] | 分级全不勾 + 多选比例 | dev app `app-run.sh` | `{"categories":["anime","people"],"purity":[],"sorting":"views","min_resolution":"2k","orientation":["portrait","square"]}` 跑 1 页 | warn「SFW 与擦边都未勾选」；参数为 `categories=011&purity=100&…&ratios=9x16,10x16,9x18,1x1,3x2,4x3,5x4&atleast=1440x1440`；ID 序列与网页 `purity=000` 同条件逐项一致 | 已实测：24 张全 SFW，短边均 ≥ 1440 |
| [x] | 随机翻页 | dev CLI（经主程序） | `--var sorting=random --var end_page=2` | 两页互不重复；用日志里的 seed 请求网页，两页 ID 序列逐项一致 | 已实测：48 张新下载、0 去重，全部取到 `full/` 原图 |
| [x] | 精确标签搜索 | dev CLI（经主程序） | `--var q=id:1 --var sorting=hot --var end_page=1` | 参数为 `q=id:1&…`；本页 24 张都带 anime 标签 | 已实测：24/24 带 anime。对照：`+anime` 在站点上模糊匹配标签名与别名，会命中别名含「Anime Cars」的 car 标签图（如 `lyg79p`），网页端结果相同，属站点行为，说明已写进关键词描述与 README |
| [x] | 搜索 URL 去掉分页 | release CLI | `--var mode=url --var search_url='https://wallhaven.cc/search?categories=110&purity=010&atleast=1280x800&ratios=16x9&sorting=date_added&order=desc&page=2' --var start_page=1 --var end_page=1` | 日志参数不含 URL 自带的 `page=2`，实际抓第 1 页；24 张 ID 与网页第 1 页逐项一致，原图、metadata 与标签正常 | 已实测：24 张新下载、0 失败，ID 顺序逐项一致；24/24 有 metadata，共挂载 470 个标签 |
| [x] | 搜索 URL 校验 | release CLI | URL 模式分别留空、输入非 URL、输入非 wallhaven 域名或非 `/search` 路径 | 任务给出明确 warn 并正常结束，不发列表请求 | 已实测：四种输入均 completed、各 1 条明确 warn、0 下载 |
| [x] | 分页上限 | dev CLI（经主程序） | `--var page_size=2 --var start_page=50 --var end_page=50`；再跑 `start_page=1 end_page=11`；`--dry-run` 看默认值 | 第 50 页正常下载 2 张（页码不设上限）；1–11 页任务失败，提示「一次最多复制 10 页…请分几次运行」；默认 `page_size=20` | 已实测；CLI 不按 `max` 拦截，`page_size=500` 原样传入，由插件截到 100 |
| [ ] | 表单显隐 | 桌面 CEF | 切换「搜索条件 / 搜索 URL」；在搜索条件中切换排序 | URL 模式只显示 URL 与起止页；搜索条件模式显示筛选项，且只有「排行榜」显示「排行范围」、「随机」不显示「顺序」 | |
| [ ] | 推荐配置 | 桌面 CEF | 插件详情里分别以「最新」「月度排行榜」运行 | 表单回填对应条件，任务正常下载 3 页 | |
| [x] | 详情模板 | `render-desc.ts wallhaven --db` | 渲染一张有来源、≥ 8 个标签的图 | 分辨率 / 来源 / 配色条 / 按纯度着色的标签 / Properties 与源站侧栏一致；非 JPEG 显示「5.1 MiB - PNG」 | 0.1.0 时实测截图对照，0.2.0 / 0.3.0 未改模板与 metadata |
| [ ] | 多页限流 | debug CLI `--via local` | `--var start_page=1 --var end_page=3` | 不出现 429 重试日志，约 2 分钟跑完 3 页 | |

## 逐任务最大并发下载

下载任务现在可单独设置最大并发，实际值不超过全局上限；收集弹窗、自动配置、任务抽屉与 CLI / app IPC 共用同一字段。运行中调大立即唤醒等待者，调小不打断在途下载；任务上限为空时随全局设置变化。

| 是否完成 | 标题 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 类型与编译检查 | 本机 | `.claude/skills/check-kabegame/driver.sh` 与 `-c kabegame-cli --skip vue` | Vue、app/core 与 CLI 均无 error | 已实测；两次均为 `vue-tsc 0 个 error / cargo 0 个 error` |
| [x] | v035 迁移幂等 | Rust 单测 | `.claude/skills/test-kabegame/driver.sh kabegame-core --lib up_adds_task_max_concurrent_downloads_and_is_idempotent` | tasks / run_configs 新列只添加一次 | 已实测；`1 passed / 0 failed` |
| [x] | 任务并发闸门 | Rust 单测 | `.claude/skills/test-kabegame/driver.sh kabegame-core --lib task_download_gate_admits_atomically_and_expands_after_limit_change` | limit=1 时并发提交不超发，调到 2 后第二个请求入队 | 已实测；`1 passed / 0 failed` |
| [x] | 参数边界 | Rust 单测 | `.claude/skills/test-kabegame/driver.sh kabegame-core --lib validate_task_max_downloads_rejects_zero_only` | 只拒绝 0，接受 1、99 与跟随全局 | 已实测；`1 passed / 0 failed` |
| [x] | 前端状态与控件 | Vitest | `deno task test -c kabegame --skip cargo` | 显式 null 不丢失，− 到 1 禁用，+ 到全局写 null | 已实测；`26 files / 237 tests` 全通过 |
| [ ] | 抽屉实时调整与任务公平性 | 桌面 CEF | 全局设 5；双任务分别设 1 与跟随全局，在抽屉连续按 −/+ | 在途/上限显示正确；A 不挤占 B；调小后自然降至上限，调回顶端显示跟随全局 | |
| [ ] | 收集与运行配置回填 | 桌面 CEF | 收集弹窗设 2 后提交、再次执行、保存为配置并编辑自动配置 | 抽屉显示 x/2；各入口均保存并回显 2 | |
| [ ] | CLI 与 app IPC 实时调整 | dev app + CLI | `plugin run <id> --max-downloads 2`，再执行 `task concurrency <id> 1` / `global` | 抽屉实时变化；主程序未运行或 `--via local` 时给出明确错误 | |

## 2dwallpapers 插件停止收集（插件 0.2.5）

2dwallpapers.com 约自 2026-04 起下线：域名仍注册在 Spaceship，但无 A 记录；ip138 解析历史中的原源站 `45.154.14.62`（首尔 MOACK）
443 / 80 在全球节点均超时。原先任务报 `connection closed via error`（经代理 TLS 握手 EOF），含义不明。
`crawl` 入口改为直接抛出中英双语的「站点已下线」错误，原抓取逻辑保留以便站点恢复；插件不下架，已有图片继续按插件索引、渲染 `description.ejs`。
商店描述与五份插件 README、插件总览 README 均标注下线。

| 是否完成 | 标题 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 入口报错 | debug CLI `--via local` | `run-cli.sh twodwallpapers --var orderby=date --var start_page=1 --var end_page=1 --via local` | 任务立即失败，错误为「2dwallpapers.com 已下线…」，无网络请求、无新增文件 | 已实测：v0.2.5，`at crawl (crawl.v8.js:323)`，新增文件 0 |
| [ ] | app 内报错展示 | 桌面 CEF | 收集弹窗选 2dwallpapers 运行任意配置 | 任务卡片 / 错误详情显示下线说明，而非 TLS 连接错误 | |
| [ ] | 已有图片不受影响 | 桌面 CEF（有 2dwallpapers 历史图的库） | 升级插件后打开画廊按插件过滤，预览一张旧图 | 插件维度仍列出 2dwallpapers 及其图片；「插件详情」面板正常渲染 | 本地 dev / prod 库均无该插件图片，未实测 |
| [ ] | 商店与文档 | 桌面 CEF | 插件商店与插件详情弹窗查看 2dwallpapers | 描述带「站点已下线」；文档顶部显示 ⚠️ 下线说明（不出现 `[!WARNING]` 原文） | |

## gelbooru「全部」模式选排序后抓不到图（插件 1.1.1）

`tags=all` 只是站点空搜索的占位；`crawlAll` 恒定在搜索串前拼 `all`，选了非默认排序时请求变成 `tags=all+sort:…`，
站点把 `all` 当真实标签去搜，列表为空，任务日志只有「第 1 页没有作品，结束」。改为只放排序 token，为空时才回落到 `all`。
「高分精选」推荐配置（`crawl_mode=all` + `sort:score:desc`）同样受影响。

| 是否完成 | 标题 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 全部 + 最近更新 | dev app + debug CLI | `run-cli.sh gelbooru --var crawl_mode=all --var sort_order=sort:updated:desc --var end_page=1 --var quality=medium` | 列表 URL 为 `tags=sort%3Aupdated%3Adesc`，正常下载 | 已实测：60s 内新增 27 个文件；curl 对照 `all+sort:…` 0 条、`sort:…` 42 条 |
| [ ] | 高分精选推荐配置 | 桌面 CEF | 收集弹窗选 gelbooru 推荐配置「高分精选」运行 | 两页正常下载 | |
| [ ] | 全部 + 最新（默认） | 桌面 CEF | 「全部」模式排序选「最新发布」运行第 2 页 | URL 仍为 `tags=all&pid=42`，正常下载 | |
| [ ] | 标签 + 排序不受影响 | 桌面 CEF | 「标签」模式填 `kirisame_marisa`，排序「高分优先」 | URL 为 `tags=kirisame_marisa+sort%3Ascore%3Adesc`，正常下载 | |

## ziworld 选任何目录都不下载（插件 0.3.6，随 0.4.0 发布）

站点 `date.json` 从 `{ data: [...] }` 改为直接返回顶层数组，插件读 `res.data` 得到空列表，任务静默以成功结束、一张不下。
改为两种结构都认；解析不出目录列表时直接报错，不再静默成功。同时把站点新增的「鬼刀」「初音未来」两个目录加进选项与默认勾选。

| 是否完成 | 标题 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 单选一个目录 | dev app + debug CLI | `run-cli.sh ziworld --var category=鬼刀` | 下载该目录全部图片 | 已实测：新增 172 个文件，与 `date.json` 中鬼刀的 zid 数一致 |
| [ ] | 全选 | 桌面 CEF | 收集弹窗 ziworld 保持默认全选运行 | 各目录依次下载，进度正常推进 | |
| [ ] | 视频目录 | 桌面 CEF | 只勾 `video` 运行 | mp4 正常下载并生成预览 | probe 已确认 `files.zohopublic.com.cn` 返回 mp4 |
| [ ] | 旧配置兼容 | 桌面 CEF | 用升级前保存的 ziworld 运行配置 / 「再次执行」旧任务 | 正常下载；新增的两个目录在旧配置里为未勾选 | |

## ziworld 目录标签（插件 0.4.0）

下载时把图片所属目录写成标签 `ziworld/category/<key>`，显示名为站点原目录名（`原神`、`未归类`…）。
目录名多为中文、label key 只允许 ASCII，已知 17 个目录用固定英文 key（`genshin-impact`、`uncategorized`…），
站点以后新增的目录按码点确定性编码为 `u-xxxx-…`。新增 `metadata_migrations/migrate.js` 的 `provideLabels`，按 `metadata.category`
给历史图片补标签；最低应用版本提升至 `4.5.0`。原「目录」PathQL 浏览保留。

| 是否完成 | 标题 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 新下载带标签 | dev app + debug CLI | `run-cli.sh ziworld --var category=未归类` 后查 `album_images` | 每张图挂一个 `ziworld/category/uncategorized`，名称「未归类」 | 已实测：38/38 |
| [x] | 迁移脚本规则 | node | 用 dev 库 `ziworld-test` 的真实 metadata 调 `provideLabels` | `鬼刀` → `ghostblade`，`未归类` → `uncategorized`；未知中文目录 → `u-…`；空目录 → 不出标签 | 已实测；未经应用迁移 runner 跑（dev 库无已安装 `ziworld` 的历史图） |
| [ ] | 历史图片补标签 | 桌面 CEF（有 0.3.x 下载的 ziworld 图） | 升级插件到 0.4.0 | 忙碌面板出现迁移进度；完成后画册「标签」分区出现 `ziworld/category` 下各目录，计数等于对应目录图片数 | |
| [ ] | 标签浏览 | 桌面 CEF | 画册页标签分区进入 `ziworld → category → 原神` | 只列出原神目录的图 | |

## Web 模式每页条数 20 / 50 / 100（默认 20）

候选与默认值收敛到 `utils/galleryPageSize.ts`：web 为 20 / 50 / 100、默认 20，桌面 / Android 仍是 100 / 500 / 1000、默认 100。
设置项、工具条、安卓 picker 与画廊 / 画册详情 / 任务详情 / 畅游图片四个 route store 的默认值都读这一份；
已存的旧值不在候选内时（如 web 里残留的 500）回退到默认值。设置说明文案去掉了写死的「100、500 或 1000」。

| 是否完成 | 标题 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 类型检查 | 前端 vue-tsc | `check-kabegame` driver `--skip cargo` | 0 error | 已实测 |
| [ ] | Web 默认 20 | Web | 清空站点数据后打开画廊 | 每页 20 张，路径带 `x20x/`；设置页分段为 20 / 50 / 100 且选中 20 | |
| [ ] | Web 切换页大小 | Web | 设置里依次切到 50、100 | 画廊、画册详情、任务详情每页条数随之变化，刷新后保持 | |
| [ ] | Web 旧值回退 | Web | localStorage 里把 galleryPageSize 写成 500 后刷新 | 画廊按 20 加载，设置页选中 20 | |
| [ ] | 桌面不受影响 | 桌面 CEF | 打开设置与画廊 | 候选仍为 100 / 500 / 1000，原有选择保留 | |
| [ ] | Android picker | Android | 画廊 header 折叠菜单打开每页数量 picker | 候选为 100 / 500 / 1000，选择后生效 | |

## 桌面应用 Web 服务器（JSON-RPC / SSE / 文件 / MCP）

原 MCP 独立监听器合并为默认关闭的应用 Web 服务器：默认只绑定 `127.0.0.1:7490`，同一端口提供
`/rpc`、`/events`、图库文件路由、`/mcp` 与 `/__ping`，不提供 `/proxy`。允许局域网访问时改绑
`0.0.0.0` 并放开 MCP Host 白名单。最外层拒绝带 `Origin` 或 `Sec-Fetch-*` 的浏览器请求，不添加
CORS。旧 `mcpEnabled` / `mcpPort` 不迁移，新服务仍保持关闭与默认端口。

| 是否完成 | 标题 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 桌面与 web check | 本机 | `check-kabegame` 全量；再跑 `--mode web --skip vue` | Vue、桌面 Rust、web Rust 均无新增 error | 已实测：全量 `vue-tsc 0 / cargo 0`；web `cargo 0`；收尾分跑前端、桌面 Rust、web Rust 也均为 0 error |
| [x] | 旧 MCP 设置不迁移 | Rust 单测 | `test-kabegame` driver：`kabegame-core --lib settings` | 旧 `mcpEnabled: true` / 自定义端口不启用新服务；能力禁用列表保留 | 已实测：`1 passed / 0 failed / 0 ignored` |
| [x] | 默认回环与路由集合 | 桌面 CEF | 开启服务，依次请求 `/__ping`、`/rpc`、`/events`、`/file`、`/proxy` | 前五项按契约返回；`/proxy` 为 404；关闭开关后全部断开 | 已实测（dev app + curl）：`/__ping` ok；`/file` 图库图片 200 image/jpeg、`/thumbnail` 200；非图库路径 `/file?path=/etc/hosts` 404；`/proxy` 404；关闭后 7490 无监听 |
| [x] | RPC super 语义 | curl | 调用只读方法；写方法分别不带/带 `?super=1` | 只读成功；不带 super 返回 `-32001`；带 super 执行写入 | 已实测：`get_settings` 成功（受 web 原有 `WEB_READABLE_SETTING_KEYS` 白名单过滤）；`set_auto_deduplicate` 不带 super → `-32001 forbidden`，带 super → `result:null`；未知方法 `-32601` |
| [x] | SSE 双向事件 | curl + 桌面 CEF | `curl -N /events` 后在 app 改设置或建画册 | 先收到 `connected`，再收到对应事件；app 内部刷新仍正常 | 已实测：先收 `connected {"super":false}`，super 写入后收到 `setting-change` id=1 |
| [ ] | MCP 合并监听 | Claude Code / Codex | 连接 `http://127.0.0.1:7490/mcp`，读取资源并调用允许的工具 | 与服务开关和端口同步启停；能力勾选仍生效 | 部分实测：curl `initialize` 200 并返回 `mcp-session-id`；回环模式下 `Host: 192.168.x` 403；真实 Claude Code / Codex 客户端未测 |
| [x] | 局域网绑定与风险提示 | 两台同网段设备 | 开启局域网访问，以本机 LAN IP 请求 `/rpc` 和 `/mcp`；再关闭 | 开启时可连接且设置页显示无鉴权风险；关闭后 LAN IP 被拒 | 已实测（同机用 LAN IP 192.168.5.137 模拟）：开启后监听 `*:7490`，`/rpc`、`/mcp` 200，带 Origin 仍 403；关闭后回到 `127.0.0.1:7490`，LAN IP 连接被拒。切换瞬间的请求可能失败一次（重启窗口） |
| [ ] | 开启失败回滚 | 桌面 CEF | 占用 7490 后打开 Web 服务器开关 | 后端返回错误，开关保持关闭并提示端口被占用 | |
| [ ] | 运行时禁用监听设置 | 前端 Vitest + 桌面 CEF | 服务器关闭时修改端口与局域网访问；开启服务器后再次查看两个控件 | 关闭时均可修改；开启及开启请求期间两个控件禁用，并提示需关闭服务器后修改；关闭后恢复可编辑 | 组件测试已通过：关闭时两个控件均可用；开启时均 `disabled=true`，直接触发 change / before-change 也不保存；桌面交互待实测 |
| [x] | 拒绝浏览器请求 | curl + 浏览器 | 向全部端点分别添加 `Origin`、`Sec-Fetch-Mode`；地址栏打开 ping；网页发 fetch | 均失败或返回 403；响应没有 `Access-Control-*` 头；普通 curl 不受影响 | 已实测：curl 四种头对 `/rpc` `/__ping` `/events` `/mcp` `/file` 均 403、无 `Access-Control-*`；CEF 页面内 fetch `Failed to fetch`、EventSource error、`<img>` error |
| [x] | 复制地址（服务器 / MCP） | 桌面 CEF | 设置 → 高级 → Web 服务器，查看并点击两个地址卡；开关局域网访问 | 仅两项：服务器地址 `http://127.0.0.1:<端口>`（局域网开启时变为本机局域网 IP）、MCP 地址 `http://127.0.0.1:<端口>/mcp`；地址整行可见、点击复制 | 已实测：局域网开启后显示 `http://192.168.5.137:7490`，MCP 仍为 127.0.0.1；`get_web_server_lan_ip` 返回 192.168.5.137 |
| [ ] | 服务器地址喂给插件 | 桌面 CEF | 复制「服务器地址」粘贴到「Kabegame 服务器」插件的服务器地址并运行 | 能翻页复制图片 | |

## Kamechan 浮在所有弹层之上

`modalStack` 栈位新增 `owner`，`topZIndex(excludeOwner)` 返回压在「除该 owner 外」所有栈位之上的 z-index。
kamechan 自己的工具箱 / 菜单 / 历史弹窗都带 `owner: "kamechan"`，host 取 `topZIndex("kamechan") ?? 1600`：
其它弹窗打开时 kamechan（含消息气泡）始终在最上层；自己的菜单与历史弹窗与它同层时按 DOM 顺序压住它。

| 是否完成 | 标题 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 设置弹窗内的消息可见 | 桌面 CEF | 打开设置弹窗，触发一条 kamechan 消息（如 Web 服务器重启失败） | kamechan 与气泡显示在弹窗遮罩之上 | 已实测：设置弹窗 overlay z=2000，kamechan z=2010，气泡完整可见 |
| [x] | 自己的右键菜单不被挡 | 桌面 CEF | 设置弹窗开着时右键 kamechan | 菜单盖在 kamechan 之上 | 已实测 |
| [ ] | 消息历史弹窗不被挡 | 桌面 CEF | 设置弹窗开着时右键 kamechan → 消息历史 | 历史弹窗在 kamechan 之上，可正常操作 | |
| [ ] | 无弹窗时层级不变 | 桌面 CEF | 关闭所有弹窗 | kamechan 回到 z-index 1600，不遮挡 Element Plus 弹出层 | |
| [ ] | 预览 / 其它 useModal 弹窗 | 桌面 CEF | 打开图片预览、画册选择等弹窗 | kamechan 均在最上层，不影响弹窗交互 | |

## Kabegame 服务器插件（新插件 kabegame-server 0.2.0）

新增 V8 插件 `kabegame-server`：经另一个 Kabegame 的 `POST /rpc`（Web 版，默认 `https://demo.kabegame.com`；或桌面端 Web 服务器）复制图片。
两种模式都是一条 images:// 路径加 `/x<N>x/<页>` 分页（每页默认 20、最多 100，超出由插件截断；一次最多 10 页，像 konachan 的 100 页限制一样超出直接拒绝）：「全站」为 `images://gallery/[hide/]sort/<random-<种子> | by-time/desc | by-id>`，默认随机，种子每次运行生成一次、各页共用；「过滤」粘贴「高级查询」弹窗底部的路径，只剥末尾 `[x<N>x/]<页码>`，排序与 `desc` 保留，省略 scheme 时补 `images://gallery/`。
先用 `images://gallery` 判断能否连上，再对查询取总数，两类错误分开提示。
然后逐图并发 8 路取
`get_image_metadata_full` 与 `albums://of_image_<id>/album_kind/label`：元数据按服务器 metadata 行共用一行本地 metadata，包成
`{ schema, server, source: { pluginId, pluginVersion, surfRecordId, metadataId }, metadata }`；标签按服务器 `label_path` 原样拆成
category + key；帖子地址取服务器 `post_url`，为空就留空，不填服务器地址；媒体 Web 版走 CDN 直链，桌面服务器的本地路径走同端口 `/file?path=`。
详情模板执行**来源插件**的 `description.ejs`：爬虫把服务器上该插件的模板（`get_plugin_detail.descriptionTemplate`）与
`get_plugin_data` 存进本插件 plugin_data（`servers[server].plugins[pluginId]`）；本插件模板在 iframe 内读出，用构建时内嵌的、
与宿主同一份 ejs 3.1.10 按宿主参数渲染，脚本补 nonce 依次执行、补发 `DOMContentLoaded`；`__bridge.getPluginData` 换成来源插件的数据，
`getCache` / `setCache` 的 key 加 `src:<pluginId>:` 前缀隔离；畅游 / 网页收集快照照宿主放进 `sandbox=""` + CSP 的内层 iframe；
无模板时显示原始元数据。

| 是否完成 | 标题 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 默认服务器分页 | dev CLI（本地） | `run-cli.sh kabegame-server --var page_size=5` | 新下载 5、0 失败；入库顺序为服务器 id 4/10/11/13/14，与 `gallery/hide/sort/by-id/x5x/1` 一致 | 已实测 |
| [x] | 全站 · 默认随机 | dev CLI（经主程序） | 不传 `sort`，`--var page_size=2` | 日志路径为 `hide/sort/random-<种子>`，下载 2 张 | 已实测；排序下拉里随机排第一，原「默认」改名「ID 升序」 |
| [x] | 全站 · 时间 | dev CLI（经主程序） | `--var sort=time --var page_size=3` | 与服务器 `hide/sort/by-time/desc/x3x/1`（29590 / 29588 / 29589）一致 | 已实测 |
| [x] | 全站 · 随机 | dev CLI（经主程序） | `--var sort=random --var page_size=3` 跑两次；再跑 `--var end_page=2` | 两次结果不同，各与日志里种子的服务器结果一致；两页 6 张互不重复且与服务器两页一致 | 已实测 |
| [x] | 过滤 · 弹窗路径 | dev CLI（经主程序） | `--var mode=filter --var pathql=images://gallery/hide/plugin/pixiv/filter_comb/sort/by-time/desc/1 --var page_size=3` | 日志的过滤路径去掉了末尾 `1`；总数 788；与服务器同路径 `x3x/1` 一致 | 已实测 |
| [x] | 过滤 · 省略 scheme、带每页数量尾巴 | dev CLI（经主程序） | `pathql=hide/plugin/pixai/filter_comb/sort/by-id/x100x/7`，`start_page=end_page=2` | 补成 `images://gallery/…/sort/by-id`，`x100x/7` 被剥掉，按插件每页 3 取第 2 页（55 / 58 / 61） | 已实测 |
| [x] | 过滤 · 组合器 | 桌面 Web 服务器 | `pathql=images://gallery/hide/~any/plugin/pixai/~or/plugin/pixiv/~end/sort/by-time/desc/1` | 总数 236，与服务器同路径第 1 页一致（含 emoji 文件名） | 已实测 |
| [x] | 过滤 · 错误路径 | dev CLI | `pathql=images://gallery/nope/sort/by-id/1` | 任务失败，提示「服务器无法解析查询」而不是连不上服务器 | 已实测 |
| [ ] | 表单显隐 | 桌面 CEF | 收集弹窗里切换模式 | 全站显示排序与「包含隐藏图片」；过滤只显示「PathQL 查询」；每页数量 / 起始页 / 结束页始终在同一行 | |
| [x] | 元数据与标签原样复制 | dev CLI + sqlite | 对比上一条任务的 metadata 与服务器 `get_image_metadata_full` | 内层 `metadata` 与服务器逐字段相等；本地挂上的标签 141 个 = 服务器 5 张图标签总数，路径同为 `konachan/<分类>/<key>` | 已实测 |
| [x] | 多来源插件 | dev CLI | `page_size=1` 分别取 pixai / miyoushe / bilibili / heybox / pixiv 各一张 | 全部成功；plugin_data 累积 6 个来源插件的模板与数据（miyoushe 数据约 390KB） | 已实测；demo 上所有图片 `post_url` 本就为空，本地也为空 |
| [x] | 来源模板执行一致性 | 无头 Chrome 测试壳（宿主同款 bridge 注入、nonce 正则与 CSP） | 包装渲染 vs 直接按宿主流程渲染来源模板，比对 iframe 文本、错误与 bridge 调用 | konachan / pixai / miyoushe / bilibili / pixiv 文本逐字一致、无错误；miyoushe 读到来源插件 plugin_data 并以 `src:miyoushe:` 前缀读写缓存，pixiv 的 `__bridge.fetch` 正常发出 | 已实测；heybox 只差 `toLocaleString` 日期格式（测试壳的直渲在 Deno 里执行 EJS，app 里两者都在 CEF 执行） |
| [x] | 兜底分支 | 无头 Chrome 测试壳 | 来源插件无模板 / 畅游快照（含脚本与 onerror） / 来源无元数据 | 分别显示原始元数据；快照在 `sandbox=""` + CSP iframe 内且脚本未执行；只显示来源条 | 已实测 |
| [ ] | app 内详情面板 | 桌面 CEF | dev app 里打开上面任一张 kabegame-server 图片的预览 | 「插件详情」顶部显示来源条，下方为来源插件原样式；链接点击用外部浏览器打开 | |
| [x] | 桌面 Web 服务器 | dev app 开 Web 服务器 + dev CLI（经主程序） | 关闭去重后以 `--var server_url=http://127.0.0.1:7490 --var page_size=3` 跑一页 | 媒体经 `/file?path=` 下载成功（含 1 个 mp4）；`post_url` 与服务器相同；标签 14 = 服务器 3 张图标签总数 | 已实测 |
| [x] | 包含隐藏图片 | dev CLI | `--var include_hidden=true` 对比默认 | 路径不带 `hide/`，总数多出服务器隐藏图片数（demo 为 19979 vs 19970） | 已实测：日志总数 19979，前 2 张已存在被去重 |
| [x] | 地址错误 | dev CLI | `--var server_url=http://127.0.0.1:1` | 任务失败，错误提示检查地址、桌面端需开启 Web 服务器 | 已实测 |

## 预览标签面板「添加标签」可展开标签目录

预览弹窗标签面板的「添加标签」选择器里，标签目录（含插件建的 `yandere/`、`konachan/` 等目录）此前被判为不可选，
禁用行连展开箭头一起锁死，目录下的标签叶子无法选中。现在目录行保持可用、点击只展开不选择，叶子照常可选，已挂的标签仍禁用。

| 是否完成 | 标题 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [ ] | 展开插件目录 | 桌面 CEF | 预览一张图 → 标签面板「添加标签」→ 点插件目录行或其箭头 | 目录不变灰，逐级展开到叶子；点叶子即挂上该标签并收起选择器 | |
| [ ] | 目录不可被选中 | 桌面 CEF | 点任一标签目录行 | 只展开 / 折叠，不会挂上目录、不报错 | |
| [ ] | 已挂标签禁用 | 桌面 CEF | 展开到当前图已挂的标签 | 该叶子变灰不可点 | |
| [ ] | 其它选择器不受影响 | 桌面 CEF | 新建标签对话框的「父目录」选择器、画册移动选择器 | 目录仍可被选为父级 | |

## dev 构建使用独立的应用 IPC 地址

`kabegame_core::ipc::ipc` 的应用 IPC 地址按 `debug_assertions` 加 `-dev` 后缀：Windows 命名管道
`\\.\pipe\kabegame-app-dev`，Unix socket `temp_dir/Kabegame/kabegame-dev.sock`；release 构建保持
`kabegame-app` / `kabegame.sock` 不变。dev app 与已安装的 release 版可同时运行，互不抢占 IPC 地址、
第二实例唤起也只落到同 profile 的那个。debug CLI 只连 dev app，release CLI 只连 release app。

| 是否完成 | 标题 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 编译检查 | 本机 macOS | `check-kabegame` driver `--skip vue` | cargo 0 个 error | 已实测 |
| [ ] | dev 与 release 并存 | 桌面 Windows / macOS / Linux | 先启动已安装的 release 版，再 `deno task dev -c kabegame` | 两者都正常启动，dev 不再被当作第二实例退出或唤起 release 窗口；macOS/Linux 下 `$TMPDIR/Kabegame` 同时有 `kabegame.sock` 与 `kabegame-dev.sock` | |
| [ ] | 同 profile 第二实例 | 桌面 | dev 运行时再启动一次 dev；release 运行时再启动一次 release | 各自唤起已有窗口并退出 | |
| [ ] | CLI 路由 | 桌面 | debug CLI（`deno task b -c kabegame-cli --data dev`）与 release CLI 分别执行 `pathql query`，dev app 与 release app 同时运行 | debug CLI 经 dev app 执行，release CLI 经 release app 执行；只有一个 app 运行时，另一 profile 的 CLI 回退本地模式 | |

## `deno task b` 的 `--data` 默认值随 `--release` 切换

`scripts/plugins/data-plugin.ts` 计算 `--data` 默认值：带 `--release` 一律 `prod`；不带时 `dev` 与 `build`
命令默认 `dev`，`start` / `check` / `test` 仍默认 `prod`。显式传入的 `--data` 优先。行为变化：不带 `--release`
的 `deno task b`（含 `-c kabegame` 的 tauri build 与 CI 中的 `deno task b -c kabegame-cli`）此前默认 prod，现在默认 dev。

| 是否完成 | 标题 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [ ] | b 不带 --release | 本机 | `deno task b -c kabegame-cli`，再执行 `target/debug/kabegame-cli pathql query …` | 输出 `[DataPlugin] KABEGAME_DATA=dev`，CLI 使用 `.kabegame/debug/data` | |
| [ ] | b 带 --release | 本机 | `deno task b -c kabegame-cli --release` | 输出 `KABEGAME_DATA=prod`，CLI 使用系统用户数据目录 | |
| [ ] | 显式优先 | 本机 | `deno task b -c kabegame-cli --release --data dev`；`deno task b -c kabegame-cli --data prod` | 分别为 `dev`、`prod` | |
| [ ] | dev / check 不变 | 本机 | `deno task dev -c kabegame`；`check-kabegame` driver | 分别为 `dev`、`prod` | |
| [ ] | 主应用 release 包 | 桌面 | `deno task b -c kabegame --release` | `KABEGAME_DATA=prod`，安装后使用系统用户数据目录 | |

## 抽屉重复路由到当前任务后标题只剩「任务」

任务详情页的状态全部来自 `?path=task/<id>/...`。在任务详情页里从抽屉打开同一个任务时，抽屉会 `router.replace("/tasks/<id>")`，这一步不带 query，`?path=` 被清空，store 退回默认状态。默认状态的 `currentRouteTaskId()` 读的是 `params.id`，但路由参数名是 `taskId`，结果 taskId 变成空串；而 `route.params.taskId` 没变，TaskDetail 的 watch 不会再写回，于是 `task` 为 null，标题退回到「任务」。现在改为读 `params.taskId`。

| 是否完成 | 标题 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 重复打开同一任务 | 桌面 CEF / Android | 从抽屉点任务的「查看图片」进入任务详情，再次打开抽屉点同一任务的「查看图片」 | 标题仍是插件名，计数与图片列表正常，不会变成「任务」+ 空列表 | 已在 macOS 桌面 CEF 经 CDP 实测：修复前 store taskId 为空、标题「任务」、计数全 0；修复后标题 danbooru-test、30 张图。Android 未测 |
| [x] | 切换到另一任务 | 桌面 CEF / Android | 在任务详情页里从抽屉打开另一个任务 | 标题、计数、图片切到新任务，搜索条件清空 | 已在 macOS 桌面 CEF 实测（切到 yandere-test）；Android 未测 |
| [x] | 直接打开任务链接 | 桌面 CEF / Web | 直接访问 `/tasks/<id>`（不带 `?path=`） | 标题与图片正常 | 已在 macOS 桌面 CEF 整页加载实测；Web 未测 |

## 任务详情页 header 增加「再次执行」

任务详情页 header 新增「再次执行」（`HeaderFeatureId.TaskRerun`，桌面放在按钮区末尾，紧凑模式进 fold）。行为与抽屉右键「再次执行」一致：普通插件先把任务参数写进全局 `taskConfig` 再打开收集弹窗，`webpage` / `local-import` 打开各自的弹窗。判断与分流逻辑从 `TaskDrawer.vue` 抽到 `composables/useTaskRerun.ts`，两处共用；按钮显隐沿用 `canRerun`（Web 不显示内建两类，紧凑模式不显示 `local-import`）。

| 是否完成 | 标题 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 普通插件再次执行 | 桌面 CEF | 进入一个普通插件任务的详情页，点 header 末尾的「再次执行」 | 打开「开始收集」，插件、输出目录、输出画册、HTTP 头、并发均为原任务的值；不会自动提交 | 已在 macOS 桌面 CEF 经 CDP 实测：danbooru-test 任务，`taskConfig` 回填后弹窗打开 |
| [x] | 抽屉右键不回退 | 桌面 CEF / Android | 抽屉里右键任务 →「再次执行」 | 行为与改动前一致 | 已在 macOS 桌面 CEF 实测：taskConfig 由 null 回填为原任务并打开收集弹窗；Android 未测 |
| [ ] | 网页收集任务 | 桌面 CEF | 网页收集任务详情页点「再次执行」 | 打开网页收集弹窗并回填 URL 等参数 | |
| [ ] | 本地导入任务 | 桌面 CEF | 本地导入任务详情页点「再次执行」 | 打开本地导入弹窗并回填路径、递归等参数 | |
| [ ] | 紧凑模式 | Android | 任务详情页右上角折叠菜单 | 有「再次执行」，点击后打开收集弹窗；本地导入任务没有该项 | |
| [ ] | Web | Web | 网页收集 / 本地导入任务详情页 | 不显示「再次执行」；普通插件任务显示 | |

## Web 版 `/rpc` 接口埋点

Web 发布版在 `rpc_handler` 里对每次 `POST /rpc` 计时，经有界队列异步向 umami 发 `rpc_call` 事件（`data.method` / `ok` / `code` / `ms`）。不读取、不转发客户端请求头，未注册方法记为 `(unknown)`。`web` feature 门控，由 `KABEGAME_UMAMI_SEND_URL` / `KABEGAME_UMAMI_WEBSITE_ID` / `KABEGAME_UMAMI_HOSTNAME` 环境变量开启。umami isbot 会丢弃 `名字/版本` 形式的 UA，因此服务端 UA 用 `Mozilla/5.0 (X11; Linux x86_64) kabegame-web/<版本>`。详见 `cocs/web/RPC_TRACKING.md`。

| 是否完成 | 标题 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 编译门控 | Rust check | `check-kabegame` driver：`--mode web --skip vue` 与默认桌面 `--skip vue` | 两种模式均 0 error | 已实测 |
| [x] | payload 通过 umami 校验 | umi.kabegame.com | 用代码同形 payload 与不存在的 website UUID POST `/api/send` | 返回 `Website not found.`（已过 schema 校验，不写入数据）；非法 UUID 对照组返回 schema 错误 | 已实测 |
| [x] | UA 不被判 bot | umami 容器 | 用容器内 isbot 规则测试候选 UA | `Mozilla/5.0 (X11; Linux x86_64) kabegame-web/x` 不是 bot；`Kabegame/1.0`、`reqwest/0.11`、`kabegame-web/x` 都是 bot | 已实测 |
| [ ] | 未配置时关闭 | Web | 不设环境变量启动 web 二进制 | 启动日志打印 `RPC tracking disabled`，`/rpc` 行为与改动前一致 | |
| [x] | 配置后上报 | Web（demo） | 写入 systemd drop-in 后重启，网页里翻几页画廊 | 启动日志出现 `✓ RPC tracking → …`；umami 新 website 的 Events 里出现 `rpc_call`，按 `method` 可拆分 | 已在 demo 部署实测：启动日志出现 `✓ RPC tracking → …`，umami `kabegame-api` 收到 `get_plugins` 事件（hostname / url / ok 正确）；网页翻页未测 |
| [ ] | 插件调用也被统计 | 桌面 CEF + Web（demo） | 桌面端用 `kabegame-server` 插件从 demo 复制 1 页 | umami 中 `pathql_entry`、`pathql_fetch`、`get_image_metadata_full`、`get_plugin_detail`、`get_plugin_data` 计数上涨 | |
| [x] | 错误与未知方法 | Web（demo） | `curl -X POST https://demo.kabegame.com/rpc -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"nope"}'` | umami 记一条 `method=(unknown)`、`ok=false`、`code=-32601` | 已在 demo 实测：`method=(unknown)`、`ok=false`、`code=-32601` |
| [ ] | umami 不可达不影响接口 | Web | 把 `KABEGAME_UMAMI_SEND_URL` 指向不可达地址后重启并访问网页 | 网页正常；日志只打一行 `[umami] RPC tracking failed`，不刷屏 | |
| [ ] | 桌面 Web 服务器不上报 | 桌面 CEF | 「设置 → 高级」开启 Web 服务器，即使设了环境变量也调用 `/rpc` | 无任何上报（非 `web` feature 编译不含埋点） | |

## Web 版 CDN 原图 URL 百分号编码

`web/image_rewrite.rs` 的 `rewrite_fs_path` 把落盘文件名原样拼进 `https://cdn.kabegame.com/<目录>/<文件名>`。
yandere 等插件落盘的文件名自带字面量 `%20`（如 `yande.re%20447155%20….jpg`），CDN 会把 URL 里的 `%20` 解码成空格，
原图因此 404；缩略图是 UUID 文件名，不受影响。现在目录段与文件名段都按 RFC 3986 unreserved 之外的字符做百分号编码
（字面量 `%` → `%25`，空格、`#`、`?`、非 ASCII 同理）。线上实测：`…/yande.re%20447155….jpg` 404，`…/yande.re%2520447155….jpg` 200。

| 是否完成 | 标题 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 改写单测 | Rust 单测 | `kabegame --lib image_rewrite` | 6 个用例通过（含字面量 `%`、空格、`#?`、中文文件名） | 已实测；macOS 下测试二进制需 `DYLD_FALLBACK_FRAMEWORK_PATH=target/Frameworks` |
| [ ] | yandere 任务原图 | Web（demo） | 打开 `/tasks/6df35cbc-43aa-4ef3-b6cb-b66db416408a`，点开任一图预览 / 下载 | 原图正常加载，Network 中 URL 为 `yande.re%2520…`，不再 404 | 需部署 web 后验证 |
| [ ] | 普通文件名不变 | Web（demo） | 画廊中打开 UUID / 纯 ASCII 文件名的图 | URL 与改动前一致，正常加载 | |
