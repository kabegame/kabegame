# 06 验证与文档

## 总体设计思路

验证分三层。纯计算（色盘、距离）与存储（迁移、入库、色桶增删）用单测覆盖，这些都不依赖界面；查询用 DSL e2e 加执行计划断言固定「走索引、不排序」这一前提；界面与整条链路用 `kabegame-chromium` skill 在跑着的 dev 应用里真机勾选。常量（合并半径、明度权重、满量程、基本色桶的 rgb）不靠单测定，P1 结束时拿真实图库看每个色桶的前几页，调到排序看着对为止，再把最终值写进文档。

## 点 1 — 单测清单

| 位置 | 用例 |
|---|---|
| `media/palette.rs` | [01-palette.md](01-palette.md) 点 4 表里的各种输入；再并（两个平均色相近的聚合点并成一个、按权重取平均、相距不小于半径的不并）；聚合点的颜色是成员平均而不是种子（构造一团偏在中心一侧的点验证）；同一输入两次结果相同；`to_json` / `from_json` 往返；非法 JSON、空数组 → `None` |
| `media/palette.rs` | `distance_to`：同色为 0；`None` 为 65536；有色盘的结果不超过 65535；[02-storage.md](02-storage.md) 点 1 的算例表（允许 ±1）；红色图到红桶比到蓝桶近 |
| `media/decode.rs` | `sample_video_frames`：对一段测试视频取到 ≤ 8 帧且首尾帧不同；一秒以内的短视频不报错 |
| `migrations/v052_image_palette.rs` | 加列、两表、12 个色桶；存量 N 张图得到 12N 行、全是 65536；重复执行幂等；删图片行后关系行级联消失；`EXPLAIN QUERY PLAN` 按色桶排序用到 `idx_image_color_distances_bucket` |
| `migrations/init.rs` | 全新建库的 schema 与「旧库 + v052」逐表一致（现有的 schema 对比测试若覆盖全部表则自动包含） |
| `storage/images.rs` | `add_image` 对带色盘的 `ImageInfo` 写入 `palette` 列与 12 行距离，返回值带同一份色盘；`palette: None` 写 12 行 65536；`palette` 是坏 JSON 时当作没有；两个删图入口都清关系行 |
| `backfills/image_palette.rs` | 有缩略图的行算出色盘并改写距离，且带一条 `palette` 补丁；文件缺失的行保持 NULL / 65536、不发补丁；游标可续跑；空库一批完成（结构照搬 `wpe_dir_hash` 的三个测试） |
| `utils/palette` 的 vitest | `parsePalette`：正常解析并补出六位 hex（黑色是 `000000`）；null、空串、坏 JSON、形状不对 → 空数组 |
| `imageViewRelevance.test.ts` | `palette` 补丁只让颜色排序（`by-color` / `by-any-color`）的视图刷新 |
| `storage/color_buckets.rs` | [04b-custom-buckets.md](04b-custom-buckets.md) 点 4 |
| `storage/dsl_funcs.rs`、`providers` e2e | [04-arbitrary-color.md](04-arbitrary-color.md) 点 3 |
| `providers` e2e | [03-pathql.md](03-pathql.md) 点 4 |
| `utils/galleryPath` 的 vitest | `by-color` 与 `by-any-color` 的构造与解析往返；大写、位数不对、不带颜色的裸段回落默认排序；`colorSortFor` 按色桶集合给出两个字段；收藏视图查询体原样保留排序段 |
| `GalleryQueryBar.test.ts` | 校正排序段：`by-color` 的颜色不在色桶里 → 换成 `by-any-color`；`by-any-color` 的颜色在色桶里 → 换成 `by-color`；色桶未加载完成时不动；不是颜色排序时不动 |

运行：后端用 `test-kabegame` skill（`deno task test`），前后端类型与编译用 `check-kabegame` skill（`deno task check -c kabegame`）。Android 目标至少跑一次 `deno task check -c kabegame --mode android`（`media/palette.rs` 与抽帧在 Android 上也编译）。

## 点 2 — 调常量（已做）

P1 结束时用对照页工具（`media/palette/tests.rs` 里 `#[ignore]` 的 `palette_report`，目录从环境变量 `KABEGAME_PALETTE_REPORT_DIR` 读）对生产缩略图目录跑过，并做了一轮变体对比。结论已并入 [README.md](README.md)「常量与调参结论」与 01、02。定案后删掉测试文件里的实验模块 `mod experiments`，对照页工具保留，以后调常量时重跑：

```
KABEGAME_PALETTE_REPORT_DIR=<目录> KABEGAME_PALETTE_REPORT_OUT=<输出目录> \
  .claude/skills/test-kabegame/driver.sh kabegame-core --lib palette_report -- --ignored --nocapture
```

对比表与结论写进 `cocs/gallery/COLOR_PALETTE.md`（P6）。

## 点 3 — 真机勾选（`kabegame-chromium` skill，dev 应用）

升级路径（用现有 dev 数据目录，升级前备份）：

- [ ] 启动经过 v052，启动页不报错；启动后忙碌卡片出现「色盘」回填并走完。
- [ ] 回填期间按颜色排序可用，没算到的图排在最后；回填完成后刷新，顺序稳定。
- [ ] 回填期间按时间排序的画廊不随每批刷新（debug ingest 数 `pathql_fetch` 次数），按颜色排序的画廊会刷新。
- [ ] 回填期间开着一张还没算到的图的预览：算到后基本信息里自己出现色带，不用重开。
- [ ] 回填中途退出再启动，从上次的位置继续，不重头来。

代表色：

- [ ] 预览侧栏与详情弹窗的「基本信息」里有色带，段数与占比和画面相符；悬停显示 `#rrggbb` 与百分比。
- [ ] 点色带的一段：预览 / 详情关闭，当前页面换成按这个颜色排序（路径是 `…/sort/by-any-color_0x<hex>/…`、最接近的在前、回到第 1 页），原来的过滤条件都还在；在画册页、任务详情、畅游图片页点同样留在本页，不跳画廊；浏览器后退回到点之前的排序。
- [ ] 纯色图只有一段；白色 / 黑色为主的图色带边界清楚，不融进面板背景（浅色与深色主题各看一次）。
- [ ] 没有色盘的图（没有 `schemecolor` 也没有预览图的 WPE 壁纸）不显示色带、不留空位。
- [ ] 刚下载的图打开预览就有色带（`images-added` 带着色盘）。
- [ ] 带 `pvwimgid` 的深链接直接打开的预览也有色带。

排序（色桶）：

- [ ] 画廊排序下拉出现「颜色」，点开在面板里展开 12 个基本色块；选「红」后路径是 `…/sort/by-color_0xff0000/…`，第一页明显偏红。
- [ ] 切升降序（最远的在前）、翻页、改每页条数，总数与按时间排序时一致。
- [ ] 叠加过滤（媒体类型、插件、搜索）后仍可按颜色排序，总数等于同过滤下其它排序的总数。
- [ ] 画册页、任务详情、畅游图片页同样可用。
- [ ] 按颜色排序时打开预览、左右切图、带 `pvwimgid` 的深链接跳到正确的页。
- [ ] 「用当前视图轮播」在按颜色排序的视图上可用，切换壁纸按距离顺序前进。

排序（任意颜色，现算）：

- [ ] 点「其它颜色」取一个不在色桶里的颜色，选「按这个颜色排序」：路径是 `…/sort/by-any-color_0x<hex>/…`，色桶表行数不变（查 `color_buckets://`），「其它颜色」色块显示成这个颜色并带选中描边。
- [ ] 结果合理、总数不变；升降序、翻页、预览定位、叠加过滤都可用。
- [ ] 在取色面板里取一个恰好是色桶的颜色并排序：路径是 `by-color_0x…`（前端判断，不走现算）。
- [ ] 把现算排序的视图存成收藏视图：色桶表行数仍不变；重启后应用这个视图，路径仍是 `by-any-color_0x…`。
- [ ] prod 构建下记录现算排序第 1 页与深页的耗时，与随机排序、色桶排序对比。

入库：

- [ ] 按颜色排序的视图开着时下载一张图：新图出现在按距离应在的位置（而不是缺席）。
- [ ] 本地导入一张图、一个 GIF、一个视频，各自能按颜色排到合理位置。
- [ ] 导入 WPE 壁纸：视频类按画面颜色；有 `schemecolor` 的网页 / 场景按该颜色；没有 `schemecolor` 的按预览图；连预览图都没有的排在最后。
- [ ] 文件夹同步进来的图同样有色盘。
- [ ] 删除图片后关系表没有残留行（`kabegame-cli pathql` 或直接查库核对行数 = 图片数 × 色桶数）。

保存与删除色桶：

- [ ] 取一个颜色点「保存为色桶」：按钮转圈后色块出现在用户色块里，当前排序变成 `by-color_0x<hex>`；另一个页面的排序面板里也出现（事件刷新）。
- [ ] 先按某个颜色现算排序，再把它保存成色桶：路径从 `by-any-color` 换成 `by-color`，画面顺序不变、不跳页。
- [ ] 再保存同一个颜色时按钮置灰并提示；存到上限后同样置灰。
- [ ] 删除用户色桶：确认框不会把下拉关掉；正按它排序的页面换成 `by-any-color_0x<hex>`，顺序不变；基本色块没有删除角标。
- [ ] 色桶删除后应用一个存着 `by-color_0x<该色>` 的收藏视图：自动换成现算段，不是空结果。
- [ ] 保存色桶期间同时有下载任务在跑，任务不报错，保存完后新下载的图对新色桶有距离（按它排序能看到新图）。
- [ ] 轮播正按某个用户色桶排序时删掉这个色桶：下一次切换跳过、不报错、轮播不关；设置页能看出来源为空。

安卓（`--mode android`）：

- [ ] 排序对话框里展开色块、选择、返回键关闭顺序正确。
- [ ] 下载的图片与视频有色盘（`content://` 路径）。

Web 版：

- [ ] 色桶排序与现算排序都可用；保存 / 删除色桶按 Web 的写权限档表现（只读时入口不出现或被拒）。

## 点 4 — 文档

- **新增**
  - `cocs/gallery/COLOR_PALETTE.md`：色盘格式与提取流程、常量及其依据、距离公式与算例、关系表不变量与三处写入、回填、两个排序段（`by-color` 预计算、`by-any-color` 现算）与「由调用方选段」的约定、宿主函数 `kb_palette_distance`、保存 / 删除色桶与事件、前端的选段与校正、基本信息里的色带；附「适用场景」。在 `cocs/README.md` 的「画廊与查询」下加索引条目。
- **修改**
  - `AGENTS.md`：架构规则里加一段「按颜色排序」（色盘只在入库算一次、关系表不变量、`add_image` 必须带色盘参数、新入库入口必须算色盘）。
  - `cocs/storage/DB_MIGRATIONS_AND_BACKFILLS.md`：v052 与回填作业 `image_palette`。
  - `cocs/downloader-tasks/DOWNLOADER_FLOW.md`：后处理多一步「入库前尽力算色盘」。
  - `cocs/wpe/WPE_IMPORT.md`：WPE 行的色盘来源（`schemecolor` → 预览图）。
  - `cocs/provider-dsl/RULES.md`：§2.1 提到的「引用内层 JOIN 别名的排序」例子里补上 `by-color`；参数化排序段的说明；§11.1 宿主函数清单加 `kb_palette_distance`。
  - `cocs/gallery/PROVIDER_IMAGEQUERY_COMPOSABLE.md`：排序维度清单。
  - `cocs/mcp/MCP_SERVER.md`：`color_buckets://` 与排序段说明（若该文档列了 scheme 清单）。
  - `cocs/ui/COMPONENT_LIBRARY.md` 或 `packages/kabegame-element-plus/README.md`：`KbFilterDropdown` 的 `expandable` 与 `option-panel` 插槽。
  - `apps/docs`：用户文档里画廊排序一节加「按颜色」。
- **回归与 changelog**
  - `versions/latest/regression.md`：按 `versions/v4.5.1/regression.md` 的格式加一节「按颜色排序」，条目取点 3 的清单，真机勾过的打勾。
  - `versions/latest/changelog.md`：一两行（详情显示代表色；新增按颜色排序，可用基本色桶、任意颜色，或把常用颜色保存成色桶；升级后后台计算一次色盘）。
