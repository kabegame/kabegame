# L0 — 基线与 WPE 补测（子计划）

> 上级：[../phase-live-scene.md](../phase-live-scene.md)「L0」。2026-11-16 用户：「其他所有工作已经全部停下」。
> 所以不开独立工作树，直接在主工作区做；现在存的基线在之后几步里不会被别的会话改动带偏。
> 主工作区里有别的会话留下、还没提交的改动（约 1600 行，P13f2 / P5e 等）。基线就按「主工作区现状」取，之后各步也在它上面做。

## 总体设计思路

L0 不改产品代码。它做两件事：
- 把之后每步要比的三份基线存下来；
- 去 WPE 补测 L5 / L6 要对齐的行为。

三份基线各管一层：
- **编译产物摘要**（Node，无 GPU）：管 L1、L2、L7 的「逐字节相同」。
- **画面哈希**（dev 应用里的屏外宿主）：管 L4 起「GPU 按对象装卸后画面不变」。
- **`scriptCorpus`**（同上，不跑 GPU）：管 L3、L5、L6「状态与脚本行为不变、只少了重编译」。

每份基线都跑两遍，先确认工具本身可复现。两遍不同的场景记进排除表，之后各步不拿它们判回归。

画面哈希要覆盖整库，不只 FINAL_CHECK 那十几张。L4 把加载路径换成逐对象装，回归面就是全部种类：组、依赖、puppet、文本、粒子、体积光、反射、阴影、视频。现成的 `hash_baseline` 碰到第一张两次渲染不同的场景就整个停下（`scripts/kabegame-dev/hash.ts` 的 `break outer`），整库跑不完。所以另写一个驱动脚本：每张场景单独起一个 `hash-baseline` 任务，共用一个宿主，不稳定的照记、接着跑。输出格式和 `hash-*.json` 相同，`hash_compare` 能直接比。

## 点 1 — 宿主产物换成主工作区现状

- 用 `deno run -A apps/kabegame-dev-mcp/src/buildSceneHost.ts` 重建，记下 `index-*.js` 的名字。
- 画面哈希和 `scriptCorpus` 两份基线都用这份产物。

## 点 2 — 编译产物摘要与重编译目标统计（`ignore/live/l0/bundlehash.test.ts`）

- **新增**：拷 `ignore/p6/d3/bundlehash.test.ts`。
  - 摘要部分不变。
  - 另加 `KBP_STATS_OUT`：每张场景列出 `bindings` 里 `target.kind === "recompile"` 的条目，取属性名、`reason`、`path`。
- **跑两遍**，两遍摘要逐张相同。结果：
  - `bundle-base-1.json`、`bundle-base-2.json`；
  - `recompile-bindings.json`。

## 点 3 — 画面哈希（`ignore/live/l0/hash_all.mjs`）

- **新增**：驱动脚本，走 vite REST。
  1. `pathql_fetch` 取库里全部场景 id，写法同 `ignore/p6/d2/corpus_run.mjs` 的 `sceneIds`。
  2. `POST /hosts { hidden: true }` 开一个宿主。
  3. 每张场景 `POST /jobs { kind: "hash-baseline", params: { ids: [id], host } }`，轮询 `GET /jobs/:id` 到结束，把 `result.baseline.scenes` 并进总表。
     - 任务失败的，记进 `errors`，接着下一张。
  4. 关宿主，写文件。
     - 顶层字段同 `hash-*.json`（`recordedAt`、`time`、`levels`、`hostBuild`、`scenes`、`closed`）；
     - 另加 `unstable`、`errors` 两张表。
- **跑两遍**：`hash-base-1.json`、`hash-base-2.json`，用 `hash_compare` 比。
- **排除表**：两遍之间不同的，以及单遍内两次渲染就不同的，进 `hash-unstable.txt`，写明原因（视频、随机、时钟……）。之后各步比较时不看它们。

## 点 4 — `scriptCorpus`

- 用 `node ignore/p6/d2/corpus_run.mjs --out ignore/live/l0/corpus-1`，再跑一遍到 `corpus-2`。
- 用 `ignore/p6/d2/corpus_diff.mjs` 比两遍，不同的进 `corpus-unstable.txt`。
- 从 `corpus-1` 的各行 `recompile` 统计脚本触发的重编译：按原因、路径末段分，写进 `recompile-scripts.json`。

## 点 5 — 统计汇总（`ignore/live/l0/stats.md`）

- 绑定触发的重编译（点 2）：按目标字段分，每类几张场景、哪几张。
- 脚本触发的重编译（点 4）：按字段分，每类几张场景、哪几张。
- 结论用于定 L6 先做哪几种。

## 点 6 — WPE 补测（`ignore/live/l0/make_step0.py`，日志前缀 `[kblive]`）

照 `ignore/p6/d3/make_step0.py` 的写法：`COMMON` 日志函数、阶段标记方块 M、`kbp` 生成库。
动手前先读 `script/api.ts` 与 rea 笔记，确认 WPE 里 `size`、`colorBlendMode`、文本 `font` 能不能由脚本写；不能写的只用属性测。

工程：
- **`live-size`**：一个纯色图层 A 绑属性 `sz` 到 `size`（不是 `autosize`），同一个场景里另放一个粒子层 P（数量、轨迹看得出连续性）。
  - 第 120 帧脚本写 `A.size`（能写的话）；
  - 另用 `apply_properties` 改 `sz`。

  抓改动前后各 3 帧，看：哪一帧生效；P 的粒子是否连续（不重新预热）；A 的 effect 链是否跟着变。
- **`live-cbm`**：A 带一个 effect，绑属性 `cbm` 到 `colorBlendMode`。0 → 31 → 5 各改一次，看生效帧与 P 是否连续。
- **`live-font`**：文本层 T 绑属性 `fnt` 到 `font`，在两种系统字体之间切换，看生效帧和同场景粒子。
- **原 P6d4 步骤 0 的四项**（工程 `live-clone`，日志读字段值、抓帧读画面）：
  - **克隆粒子层**：加载时的粒子层 P（`starttime` 非 0），第 N 帧在 `update` 里 `createLayer(P 的初始配置)`。抓 N、N+1、N+2：新层当帧有没有预热出的粒子、发射从哪一刻算。
  - **克隆带关键帧的对象**：关键帧动画的时钟从 0 起还是接模板（日志读字段）。
  - **克隆带属性绑定的对象**：克隆之后 `apply_properties` 改属性，克隆跟不跟。
  - **克隆的图层收不收光标事件**：`input_play` 喂光标到克隆上，看 `cursorEnter` / `cursorClick` 日志。
- **`p6d-frame` 的日志夹具**：截一份 WPE `log.txt`，供 L5 逐行比。
- 每个工程的结论写进 `ignore/live/l0/wpe-results.md`：每项一句结论加证据（帧号、日志行、抓帧路径）。
  - 结论回填到总计划 L5 / L6 对应的点，改「待实测」的写法。

## 验收

- 三份基线各两遍，排除表以外逐项相同。
- `stats.md`、`wpe-results.md` 写完。
- 总计划 L5 / L6 里依赖实测的地方按结果改好。
- 不改产品代码：`git status` 里本步只多了 `ignore/live/l0/` 与计划文件。
