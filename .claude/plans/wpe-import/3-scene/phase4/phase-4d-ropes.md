# P4d — 绳与映射（子计划）

> 上级：[phase-4-particles.md](phase-4-particles.md)「P4d」。底座沿用 P4a–P4c（[phase-4a-base.md](phase-4a-base.md)、[phase-4b-tier2.md](phase-4b-tier2.md)、[phase-4c-controlpoints.md](phase-4c-controlpoints.md)），已有语义见 [p4-particles-REPORT.md](p4-particles-REPORT.md) 与 `rea-*.md`，本节新增的语义由步骤 0 写进 `rea-p4d-rope.md`、`rea-p4d-modules.md` 和报告。
> 语料用 P4c 收尾后的代码（`c345e1cd`）重扫：152 个工程加 kabegame-sample，能渲染 22 张。统计脚本是 `ignore/p4/d0/corpus.test.ts`、`scan_d.py`、`per_sample.py`，结果在 `ignore/p4/d0/out/scan.txt`。
> 分六步：步骤 0 只调研，步骤 1–5 每步能单独验收、单独提交。

## 总体设计思路

P4d 有两块性质不同的内容：绳是一种新的绘制，映射类和距离类是普通模块。

**绳是新的绘制，不是新的模拟。** `rope` 把系统里全部存活粒子按顺序连成一条带子；`ropetrail` 给每个粒子拖一条带子，由它的历史位置连成。两者在 WPE 里画法相同：每段一个点，几何着色器把点展开成一条三角形带。内置的 `genericropeparticle.geom` 按两端的位置、尺寸、颜色和样条控制点算出 `4 + 2·subdivision` 个顶点，中间点走三次贝塞尔。语料里 48 个绳系统全用 `genericparticle` 材质，WPE 画绳时把着色器换成 `genericropeparticle`（rea-p4c-render 6.2），所以只需要这一个内置着色器。

难点在几何着色器。P4a 能直接用 `genericparticle.vert` 的非 GS 分支，因为它和 GS 路径的几何实测相同。`genericropeparticle.vert` 的非 GS 分支却和 GS 路径不同：
- 没有细分；
- 不看 `ORIENTATION`，总用 `g_OrientationForward`；
- 有一处运算优先级错误：`position += right * uvs.x * 2.0 - 1.0` 让带子偏到一侧，还整体平移了 `(−1, −1, −1)`。

WPE 恒定义 `GS_ENABLED`，实际画的是 GS 路径，所以绳要复刻 GS。

推荐做法是**翻译器加「几何着色器展开」**。请求多带一份 `.geom` 原文，翻译器把顶点着色器的 GS 分支和几何着色器拼成一个顶点着色器：
- 每段是一个实例，顶点输入按实例步进；
- `vertex_index` 是第几个输出顶点；几何着色器的函数体照跑，第 `vertex_index` 次 `OUT.Append` 的顶点就是输出；
- 管线用三角形带拓扑。实例之间本来就断开，和 GS 每次调用输出一条带等价。

这样用的仍是用户 WPE 安装里的原件。COMBO（`REFRACT`、雾）、头文件和 uniform 都走现有的翻译路径，P4c 的四角探针改一下入口照样能读回顶点。代价是每个输出顶点都把 GS 函数体重跑一遍。`subdivision` 钳到 `[0, 32]`，一段最多 68 个顶点；语料最大是 16，即 36 个。绳系统的 `maxcount` 多数是 128，开销可以忽略。另外两种做法见「决定」。

模拟侧只多两份状态：
- `rope` 的顺序索引。WPE 的 rope 表是存槽号的 `std::vector`：出生时追加，判死后保序删除，表序就是出生序（rea-p4d-rope 第 2 节）。我们的槽位复用第一个空槽，槽序不是绳上的顺序。
- `ropetrail` 每个粒子的位置历史。计时器每系统一个，间隔 `length / segments`，到点时所有存活粒子的历史一起后移一格、新的在前，余量丢掉，每帧最多采一次（rea-p4d-rope 第 5 节）。

CPU 每帧把它们写成「每段一个实例」的顶点。每段写什么（两端、样条控制点、`w` 分量、先后）见 rea-p4d-rope 1.3–1.4、5.3。

**映射类和距离类是普通模块，读 P4c 的控制点。**
- `mapsequence*` 是 initializer，按序号把粒子放到控制点周围，或两个控制点之间。序号是模块自己的状态，有两处清零（rea-p4d-modules 1.3）：
  - 对象不可见且有粒子时，系统复位无条件清零；
  - 周期发射进入新周期时，`between` 看 `flags & 0x20`；`around` 读的是记录里没写过的一个字，值不确定，按 0 实现。
- `remap*` 是「输入 → 分量 → 归一化 → 变换函数 → 输出区间 → 运算」的通用管线。两个模块在好几处不同，比如：
  - `particlesystemtime` 在 `remapvalue` 里就是场景时间；
  - 噪声在 `remapinitialvalue` 里是 P4b 移植的 `snoise1`，在 `remapvalue` 里是 FastNoise2 的二维 Simplex / FBm，要新移植。
- `maintaindistance*`、`reducemovementnearcontrolpoint`、`vortex_v2` 是 operator，改粒子的位置或速度。

它们都经 `ControlPointSet` 取 current / previous，进模块表后同时计入控制点个数（`controlPointCount`）。`maintaindistance*` 读 previous，所以 P4c 留下的「不可见时不更新控制点」（`system.ts` 中 `suspend` 的注释）要在本节补上。

几个关键决定：

- **步骤 0 一次做完。** 两个 REA 代理并行，绳的绘制一份、模块一份；一次 WPE 会话抓完全部确定性工程。
- **取值沿用 P4b、P4c 的规矩。** 读码确定的取值全部实现，各有确定性工程；读不清的照报 `particle:<模块>:<字段>`。`remap*` 的输入、变换函数、运算、输出都按这条。
- **验收照旧靠回放。** 绳比 `gs_out` 的每个顶点和整帧像素，模块比轨迹。
- **按覆盖排先后。** `rope` 一项新增 9 张覆盖、解锁 1 张，排第一。`ropetrail` 和它共用着色器与顶点路径，紧随其后。`mapsequencearoundcontrolpoint` 再加 4 张。其余模块各只有 1–2 张，或只为 kabegame-sample。

## 范围与解锁

| 步骤 | 内容 | 新增覆盖 | 解锁 |
|---|---|---|---|
| 0 | 调研：REA 读码、确定性工程抓帧 | — | — |
| 1 | `rope`：翻译器几何着色器展开、顺序索引、段顶点 | 9 | `2254685070` |
| 2 | `ropetrail`：历史缓冲、计时、渐隐、UV 滚动 | 0 | — |
| 3 | `mapsequencearoundcontrolpoint`、`mapsequencebetweencontrolpoints` | 4（其中 2 张还要步骤 1） | — |
| 4 | `remapinitialvalue`、`remapvalue` | 0 | — |
| 5 | `maintaindistancebetweencontrolpoints`、`reducemovementnearcontrolpoint`、`maintaindistancetocontrolpoint`、`vortex_v2`；不可见时更新控制点 | 0 | — |

覆盖的口径同 P4b「完成情况」：152 个工程里带粒子的 95 张中，不报任何 `particle:*` 键的场景数。P4c 收尾时是 44 张，P4d 做完是 57 张（总计划里的 47 张是旧口径）。能渲染的场景从 22 张到 23 张。

各键挡住的场景数（一张场景可以被多项挡住）：
- `rope` 22、`ropetrail` 8、`mapsequencearoundcontrolpoint` 8、`remapvalue` 2；
- `mapsequencebetweencontrolpoints`、`maintaindistancebetweencontrolpoints`、`reducemovementnearcontrolpoint` 各 1，都是 `3832133196`；
- `remapinitialvalue` 只出现在 `3832133196` 的子系统里，能力表不报；
- `maintaindistancetocontrolpoint`、`vortex_v2` 是 0，只有 kabegame-sample 用。

`ropetrail` 的 8 张都还差子系统或属性绑定，做完它不新增覆盖。

新增覆盖的 13 张：
- 只差 `rope` 的 9 张：`2254685070`、`3326873240`、`3351072238`、`3361965869`、`3400241651`、`3470764447`、`3492627662`、`3524852519`、`3600630828`；
- 只差 `mapsequencearoundcontrolpoint` 的 2 张：`3811764016`、`3816870245`；
- 两者都要的 2 张：`3823859141`、`3823864170`。

其中只有 `2254685070` 没有别的不支持项。`3811764016` 还差 `object:shape`，`3811798465` 还差 `particle:children`。

字段用法（按系统计，含子系统和 kabegame-sample）：
- `rope` 30 个：`subdivision` 写了 10 个（0 有 7 个、3 有 2 个、16 有 1 个），`uvsmoothing false` 7 个，`uvscale 0.5`、`uvscrolling true` 各 1 个；`maxcount` 多数是 128，最大 500；材质混合 additive 27 个、translucent 3 个，1 个开了 `REFRACT`。
- `ropetrail` 18 个：都写了 `length`（3 有 6 个、0.2 有 4 个，1、4、30 各 2 个，0.4 有 1 个），`segments 16` 2 个，`subdivision` 4 个（0、2）；`maxcount` 最大 1000。
- `mapsequencearoundcontrolpoint` 9 个：`count 5` 8 个（kabegame-sample 是 2.2），`speedmin = speedmax = "0 100 0"` 8 个，`bounds "0 1"` 3 个，`limitbehavior "repeat"` 3 个，`axis` 1 个。
- `mapsequencebetweencontrolpoints` 8 个：`count` 8 / 10 / 64，`flags` 15 / 19 / 23，`arcamount 0.1` 6 个，`limitbehavior "mirror"` 1 个。
- `remapvalue` 6 个：
  - `input`：`"particlesystemtime"`；
  - `transformfunction`：sine 3 个、simplexnoise 2 个、fbmnoise 1 个；
  - `output`：opacity 3 个、velocity 2 个、speed 1 个；
  - 另有 `operation "remap"`、`flags 3`、`blendin*`，以及标量或向量的 `outputrange*`。
- `remapinitialvalue` 3 个，都在子系统里：`input "distancetocontrolpoint"`、`operation "multiply"`。
- `reducemovementnearcontrolpoint` 12 个：`controlpoint 1`、`distanceinner 20`、`distanceouter 50`、`reductioninner 1000`。`maintaindistancebetweencontrolpoints` 6 个，全用缺省。
- `vortex_v2`、`maintaindistancetocontrolpoint` 各 1 个，都在 kabegame-sample 的 `magic_vortex_orb`（sample-gaps §2.2、§2.3）。

**本节不做，继续报不支持：**
- 一个系统多个 renderer（`particle:renderers`，P4c 决定 3）：绳系统全是单 renderer。
- `inheritcontrolpointvelocity`：读控制点的 previous，语料 0 张，不在总计划里。
- 子系统（P4e）。`remapinitialvalue` 只出现在子系统里，本节实现它、靠确定性工程验收，用到它的场景要等 P4e。
- `audioprocessing*`（P4e）、脚本写控制点（P4f）、粒子开 `LIGHTING`（P4 不做）。

## 现状锚点

**a. rope 两类不在模块表里**（`particles/modules.ts:325`）
```ts
/**
 * 档 1 的 12 个模块、…、P4c 步骤 3 的 operator `controlpointattract`，加 renderer `sprite`、`spritetrail`
 * （P4c 步骤 5）。rope 两类属 P4d，表外照报。 // 现状：报 particle:renderer:rope / ropetrail
 */
export const PARTICLE_MODULES: readonly ParticleModuleDef[] = [
```

**b. 绘制用的 renderer 只有两种**（`compile/particles.ts:196`）
```ts
export interface ParticleRenderer {
  kind: "sprite" | "spritetrail"; // 现状：没有 rope、ropetrail
  trail: [number, number, number] | null; // 拖尾的 g_RenderVar0.xyz
  orientation: ParticleOrientation;
}
export function particleRenderer(renderers: readonly ParticleModule[]): ParticleRenderer {
  // 现状：只找 sprite / spritetrail，找不到按缺省 sprite 画
  const module = renderers.find((item) => item.name === "sprite" || item.name === "spritetrail");
```

**c. 每粒子 4 个顶点，按索引画三角形列表**（`particles/vertices.ts:1`、`render/scene.ts:1705`）
```ts
// vertices.ts：WebGPU 没有几何着色器，绘制统一走顶点展开：每粒子 4 个顶点、6 个索引（`0 1 2 0 2 3`）
// scene.ts：
pass.setIndexBuffer(this.particleIndices!.buffer, this.particleIndices!.format);
pass.drawIndexed(particles.count * 6); // 现状：没有「每段一个实例、三角形带」的画法
```

**d. 槽位复用第一个空槽，不记顺序**（`particles/system.ts:404`）
```ts
private spawn(emitter: ResolvedEmitter): void {
  const c = this.columns;
  let slot = this.searchFrom;
  while (slot < c.capacity && c.life[slot] !== 0) slot++; // 现状：槽序不是出生序，绳的顺序无处可取
```

**e. renderer 宏只认拖尾**（`compile/bundle.ts:175`）
```ts
export function particleRendererDefines(system: ParticleSheetSystem): Record<string, string> {
  return system.renderer?.kind === "spritetrail" ? { THICKFORMAT: "1", TRAILRENDERER: "1" } : {};
}
```

**f. 翻译器不处理几何着色器**（`src-tauri/wpesl2wgsl/README.md:151`）
```md
- `GS_ENABLED`、`REVERSEDEPTH` WPE 恒定义，这里有意不定义：WebGPU 没有几何着色器，粒子走「顶点着色器自己展开四角」的分支……
```
请求只有 `vertex`、`fragment` 两份源码。

**g. 表外模块不计控制点个数**（`particles/controlpoints.ts:112`）
```ts
/**
 * … 表外模块（P4d 的 `reducemovementnearcontrolpoint` 等）不计：场景已因 `particle:<类别>:<名字>` 退回，它们也不执行。
 */
export function controlPointCount(def: Pick<SceneParticle, "emitters" | "initializers" | "operators">): number {
  // 现状：只数模块表里带 `controlpoint` 字段的模块
```

**h. 不可见时不更新控制点**（`particles/system.ts:287`）
```ts
/**
 * … WPE 不可见时控制点照常更新（rea-p4c-sim.md 5.6），这里不更新：…差别只在 `previous`…
 * 本步没有读 `previous` 的模块，只影响 P4d。
 */
suspend(): boolean {
```

## 步骤 0 — 调研

不改产品代码。

### 0a — REA 读码（两个子代理并行）

**`rea-p4d-rope.md`**，格式同 `rea-p4c-render.md`，每条标地址和证据等级。已知线索在 rea-p4c-render 6.2–6.6、7.7，rea-p4b-render 2.4（`need |= 4 / 8`），rea-framework「模拟 `FUN_140236cd0`」第 4 步。
1. **段顶点：** `FUN_1402308a0` 的 rope 路径（`0x1402309f8`，读 `fps` 的那段）每段写哪些输入：
   - 两端的位置、尺寸、颜色；
   - 样条控制点 `in_SplineCP0` / `in_SplineCP1` 怎么由相邻粒子算出；
   - `a_TexCoordVec4.w`、`a_TexCoordVec4C1.w`；
   - 段的先后；存活数 ≤ 1 时怎样。
2. **顺序索引：** rope 索引表存在哪、出生时怎么插、判死时怎么删，两遍模式和预热下怎样，是不是出生顺序。
3. **字段与宏：**
   - 字段：`rope` 的 `subdivision`、`uvscale`、`uvscrolling`、`uvsmoothing`；`ropetrail` 的 `length`、`segments`、`subdivision`、`fadealpha`、`fadesize`、`uvscale`、`uvscrolling`；缺省值分正交、透视。
   - 宏：写哪些（`TRAILSUBDIVISION`、`ORIENTATION`、`THICKFORMAT`、`TRAILRENDERER`、`TRAILSCROLLALPHA`、`TRAILFADEALPHA`、`TRAILFADESIZE`），条件是什么。
   - 系统 `flags` 的 `0x80000`、`0x10000`，厚格式的条件。
4. **uniform：** `g_RenderVar0` 各分量（6.3 已读到 z、w，`uvscrolling` 时还有 x）；`ORIENTATION ≠ 0` 时用的 `g_Orientation*`，确认就是 P4c `orientation.ts` 算的那三个。
5. **`ropetrail` 的历史缓冲**（6.5）：
   - 计时器的比较常量；
   - 采样时写入的是哪一份位置，出生时的初值；
   - `uvscrolling` 计数；
   - 读 `fps` 的作用。
6. **着色器替换：** rope 两类是不是无条件换成 `genericropeparticle`，材质写了自定义着色器时怎样；WPE 画绳是不是 `PointList` 加 GS（0b 抓帧确认）。
7. 世界空间、透视粒子（系统 `flags` bit0、bit2）下的绳。

**`rea-p4d-modules.md`**，格式同 `rea-p4c-sim.md`。已知线索在 rea-p4c-sim 第 3 节（控制点读法）、1.2（`0x10000`），sample-gaps §2.2、§2.3，rea-p4b-modules A3 末尾（`FUN_14022f790`）。
1. **`mapsequencearoundcontrolpoint`**（init 13，`0x14023c4fd`）**、`mapsequencebetweencontrolpoints`**（init 14，`0x14023cac1`）：
   - 字段、缺省值、公式；
   - 序号状态（`rec+8`），`FUN_14022f790` 的清零条件和调用时机；
   - `count` 为非整数时、`limitbehavior` 各值、`bounds`、`flags` 各位、`arcamount`。
2. **`remapinitialvalue`**（init 15）**、`remapvalue`**（op 19，`0x140244bd4`）：
   - 全部输入、变换函数、运算、输出的枚举和公式；`simplexnoise`、`fbmnoise` 的维数、频率与倍频。
   - 输出是控制点时怎么写，`0x10000` 的完整语义。
   - `flags`、blend 变体；`inputcontrolpoint*` 怎么计入控制点个数。
3. **`maintaindistancetocontrolpoint`**（op 11）**、`maintaindistancebetweencontrolpoints`**（op 12）**、`reducemovementnearcontrolpoint`**（op 13）：字段、缺省、公式；`M` 的来源与 `Δcp` 的方向（sample-gaps §2.3 没追的两项）。
4. **`vortex_v2`**（op 16）：环形分支（`0x140243575`–`0x1402437f3`）、`xmm8` 与 `[rbp+0xf0]` 的来源、切向项乘不乘 dt（sample-gaps §2.2）。
5. **共通：**
   - 以上 operator 在两遍模式下用 `h` 还是 `k`，blend 变体的权重；
   - 在世界空间系统里怎样；
   - 对象不可见时读 previous 的模块怎样（rea-p4c-sim 5.6）。

### 0b — 确定性工程与实测（Claude）

- **新增** 生成器 `ignore/p4/gen_d.py`，复用 `gen_c.py`，出这几个工程：
  - `proj/p4d-rope`：
    - 粒子沿已知轨迹排成一串；
    - `subdivision` 0 / 3 / 16，`uvscale`，`uvscrolling`，`uvsmoothing` 开和关，`orientation` 三种；
    - 尺寸、颜色随年龄变，看两端是不是各取各的；
    - 中间的粒子先死、空槽被新粒子复用，看索引表；
    - `maxcount 1`，看存活数 ≤ 1 时不画。
  - `proj/p4d-ropetrail`：`length` / `segments` 的几种组合，以及 `subdivision`、`fadealpha`、`fadesize`、`uvscrolling`。
  - `proj/p4d-map`：两个 `mapsequence*` 的各字段，加周期发射，看序号怎么清零。
  - `proj/p4d-remap`：`remap*` 的每种输入、变换函数、运算、输出各至少一个。
  - `proj/p4d-dist`：三个距离类 operator 与 `vortex_v2` 的各分支。读 previous 的模块要控制点在动：用 `flags 2` 的控制点，再用脚本移动对象（P4c 世界空间工程的做法，脚本里的 `angles` 是度）。
- 绳的几何读 `gs_out`：把 `rdc_track_b.py` 的四角读取扩成整条带子，每次 GS 调用 `4 + 2·subdivision` 个顶点。
- 用 `wpe-renderdoc` 一次会话抓完。fps 60 全抓；`p4d-ropetrail`、`p4d-dist`、`p4d-remap` 另抓 fps 10，看历史计时和 `h` / `k`。开会话前用 `rd status` 确认没有别的会话在用这个工具，WPE 不是我们启动的就请用户退出，结束后还原设置。
- 结论写进报告新节「P4d 语义的实测核对」。

**验收：**
- 两份读码文档覆盖上面各项，模块都有字段表、缺省值、公式和证据等级。
- 抓帧确认 WPE 画绳走 GS（有 `gs_out`），并确认非 GS 分支的差异确实存在，这是决定 1 的前提。
- 绳的段顶点和顺序有实测；`remap*` 的取值清单定下来，写明哪些实现、哪些照报。
- 步骤 1–5 要回放的数据都已抓到。

### 步骤 0 实施记录（2026-11-09）

**0a 读码。** 两份文档是 [rea-p4d-rope.md](rea-p4d-rope.md)、[rea-p4d-modules.md](rea-p4d-modules.md)。Claude 抽查了 5 处，都对得上：
- rope 缺省 `subdivision 4`、`uvsmoothing true`（`0x1401c0d00`、`0x1401c0dd3`）；
- rope 表的保序删除（`0x1402370d3`–`0x1402370ec`）；
- op 11 的 `Δcp = current − previous`（`0x140241a3f`）；
- op 19 的输入 11 和输入 9 走同一支，都读 `ctx+0x130`；
- `vortex_v2` 的两个速度乘 `k`。

**0b 实测。**
- 6 个确定性工程（`ignore/p4/gen_d.py`），抓了 11 组：fps 60 六组，fps 10 五组。结论见报告「P4d 语义的实测核对」。
- 结果：
  - **绳：** GS 展开逐顶点和 WPE 一致（最大差 2.3e-4 像素）；rope 的段内容、表序、缺省值、两粒子特例，以及 ropetrail 的采样、钳制、`RV0`，全部成立。
  - **mapsequence：** 两个模块成立。
  - **距离类：** `vortex_v2` 的切向乘 `k`；maintaindistance 在两遍模式下跟随两倍。
  - **remap：** `remapvalue` 的 `particlesystemtime` 是场景时间，噪声是 FastNoise2 加 `R` 种子（残差 ≤ 4e-4）。几处 WPE 自己的怪行为都实测确认了：`positionbetween` 读 `outputcontrolpoint`，`remapinitialvalue` 把控制点写成 0，op 用 `trunc`。

**WPE 会话。**
- 用户从托盘退出后，注入启动一次会话，两轮抓完。
- `sweep_b.py` 改了收尾：`driver.py stop` 是强杀，`HKCU\Software\WallpaperEngine\faultyShutdown` 会留在 1，下次启动就弹「上次可能崩溃」、不加载壁纸。所以每次 `stop` 之后用 `ignore/wpe-mcp/exp/exp.py clear` 清成 0，收尾用 `exp.py spawn` 普通 `-silent` 启动，不再 `stop --relaunch`。
- 设置按字节还原，`config.json` 哈希是 `793251d6…`，和测前相同。收尾时 WPE 的 PID 是 437564，桌面壁纸 2.2 s 回来，没有弹窗，前台一直是 VS Code。
- 读取：remap fps 60 两次在桥接上超时（每次都紧跟别的读取之后），单独重跑就好了，逐帧逐调用计时都在 2 s 以内。
- **以后的抓帧：** 抓完以后用户改成了常驻注入，见工具基建会话 2026-11-09 晚的消息。WPE 一直开着并已注入，不再杀进程、写注册表或用旧 driver；用 `ignore/wpe-mcp/exp/exp.py` 开自己的窗口来抓，抓完只关自己的窗口。步骤 1–5 要补测时照这个做。

**对读码和计划的更正：**
1. 一段最多 68 个顶点（`subdivision` 钳到 32），不是 36。已改总体设计。
2. ropetrail 的 `uvscrolling` 是 `0x80000`，rea-p4b-render 1.3、2.3 写成了 rope 的。
3. `maintaindistancebetweencontrolpoints` 读两个点的 current 和 previous，rea-p4c-sim 第 3 节写的是「一个点的 previous」。
4. `vortex_v2` 的切向是 `r̂ × a`，乘 `k`。sample-gaps §2.2 方向写反了，乘什么也没定。
5. 绳的光栅化是 `NoCull`，`upright` / `fixed` 只让 u 左右对调，不会整条不画。
6. 两遍模式下 maintaindistance 两个模块每遍都平移完整的 `Δcp`。世界空间的粒子在低 fps 下会跑到对象前面去；这是 WPE 的行为，照做。

**没测到的，按读码实现：**
- R9：绳没满时 `Rf = min(fps, R)` 的分支。抓帧时绳都已满。
- T7：预热后历史塌缩到当前位置。T7 在 WPE 里一直没有存活粒子，原因留给步骤 2 用我们的模拟对照时再查。
- ma-hide：不可见时清零序号。`count 5` 的序号是周期的，看不出来。
- dist-hide：不可见时照常更新控制点。重新可见的第一帧没有粒子。
- rm-eq：`reductionouter == reductioninner` 时差存成 1.0。这组参数下分辨不了。

## 步骤 1 — `rope`

分两半，各由一个子代理做、各自验收：1a 翻译器的几何着色器展开（Rust，能单独测），1b 宿主接入（TS，要 1a 的 wasm）。

### 1a — 翻译器的几何着色器展开（`src-tauri/wpesl2wgsl`）

**现状：** 编排在 `lib.rs::translate`，顺序是：
1. 扫注释元数据；
2. 建宏表（平台宏 < COMBO < `TEX<n>FORMAT` < `defines`）；
3. 顶点、片元各自 `Preprocessor::run`；
4. `rewrite::build(vs_lines, fs_lines)`；
5. naga。

改写层按行切：单行的 `uniform` / `attribute` / `varying` 进声明表，其余都是正文；`in … gl_*` 的行跳过；同一阶段重复的 uniform 合并。`GS_ENABLED` 有意不定义（`lib.rs:35`、README「内部流程」2）。

**做法：** 在预处理和改写之间，把预处理后的几何段合进顶点段，得到一段「顶点着色器」交给现有的 `rewrite::build`。改写层、naga 阶段基本不动。

- **新增** 请求字段 `geometry?: string`（`.geom` 原文）。有它时：
  - 宏表加 `GS_ENABLED=1`，三段都定义，WPE 恒定义；
  - 几何段用同一张宏表预处理，**跳过顶点段已经展开过的头文件**。`common_particles.h` 没有头文件保护，两段都 include 它，不跳过会重复定义函数；
  - 几何段缺头文件时同样报 `phase: "include"`，阶段记作新增的 `Stage::Geometry`。
- **新增** `src/geometry.rs`：`merge(vertex: &[Line], geometry: &[Line], pp: &Preprocessor) -> Result<(Vec<Line>, u32), RewriteError>`，规则如下。
  1. **输出顶点数：** `[maxvertexcount(<表达式>)]` 用 `Preprocessor::eval` 按最终宏表求值，作为 `maxVertices`。缺这一行或有多行时报错。
  2. **顶点段：**
     - `varying T x;` 改成私有全局 `T kb_gsin_x;`，正文里的 `x` 都改成 `kb_gsin_x`；
     - `gl_Position` 改成 `kb_gsin_gl_Position`（`vec4`）；
     - `main` 改成 `kb_vs_main`。
  3. **几何段：**
     - `in T x;` 删掉，但要核对顶点段有同名、同类型的 varying；`gl_Position` 除外；
     - `out T x;` 改成 `varying T x;`，这就是真正的顶点输出，和片元按名字配对；`out vec4 gl_Position;` 删掉；
     - `IN[0].x` 改成 `kb_gsin_x`。下标不是 0 就报错，只支持点输入；
     - `PS_INPUT` 改成生成的 `struct PS_INPUT { <每个 out 字段>; vec4 kb_Position; }`，`.gl_Position` 字段访问改成 `.kb_Position`（结构体字段不能以 `gl_` 开头）；
     - `OUT.Append(e);` 改成 `kb_gs_append(e);`；`OUT.RestartStrip()` 报错，只支持单条带；
     - `main` 改成 `kb_gs_main`；
     - `normalize(` 改成 `kb_gs_normalize(`，见第 6 条。
  4. **for 循环变量：** for 头里声明的变量，如果循环体顶层又声明了同名变量（`.geom` 里的 `for (int s…) { float s = smoothstep(…) …}`），把 for 头里的那个改名为 `kb_<名>`。GLSL 的循环体不开新作用域，会报重复声明；HLSL 允许遮蔽。
  5. **拼接顺序：**
     1. 私有全局：`kb_gsin_*`，以及状态 `kb_gs_target`、`kb_gs_count`、`kb_gs_hit`、`kb_gs_degenerate`、`kb_gs_selected`；
     2. `struct PS_INPUT`；
     3. `kb_gs_append`、`kb_gs_normalize`；
     4. 顶点段正文；
     5. 几何段正文；
     6. 新的 `main`：
```glsl
void main() {
  kb_vs_main();
  kb_gs_target = gl_VertexIndex; kb_gs_count = 0; kb_gs_hit = false; kb_gs_degenerate = false;
  kb_gs_main();   // 每次 kb_gs_append：kb_gs_count == kb_gs_target 时记下，kb_gs_count++
  if (kb_gs_hit && !kb_gs_degenerate) {
    gl_Position = kb_gs_selected.kb_Position;
    // 每个 out 字段原样赋给同名 varying
  } else {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // 整个图元落在裁剪体外，见第 6 条
  }
}
```
  6. **零向量 `normalize` 时整个图元不画：**
     - `kb_gs_normalize` 有 `float` / `vec2` / `vec3` / `vec4` 四个重载。`dot(v, v) == 0.0` 时置 `kb_gs_degenerate`、原样返回，否则返回 `v * inversesqrt(dot(v, v))`。
     - 依据：WPE 下 `normalize(0)` 得 NaN，D3D 丢弃含 NaN 顶点的三角形。绳的两种 GS 里，右向量一旦是 NaN，带上每个三角形都含 NaN 顶点（rea-p4d-rope 1.5），所以等价于整个图元不画；步骤 0 实测的 NaN 顶点数和这个预测逐帧相同。
     - 不靠检测 NaN：WGSL 允许实现假定没有 NaN，`x != x` 可能被优化掉。
- **新增** 结果字段 `geometry: { maxVertices }`，只在有几何段时给。`attributes` 照旧；有几何段时，渲染器把全部属性按实例步进。
- **修改** 前端胶水的 `TranslateRequest` / `TranslateResult` 类型加这两个字段；README 新增「几何着色器展开」一节，写规则和限制（点输入、单条带、`normalize` 退化整个图元不画及其依据）。

**测试：**
- **单测，每条规则一个：** `IN[0]` 改写、`Append` 计数选中第 N 个、结构体字段与 `kb_Position`、`normalize` 退化、for 变量改名、`maxvertexcount` 求值、跨段 include 只展开一次、`IN[1]` 和 `RestartStrip` 报错。
- **语料门槛：** `genericropeparticle` 加 `.geom`，翻译通过、WGSL 回读通过，`maxVertices = 4 + 2·TRAILSUBDIVISION`。组合有：
  - rope：`THICKFORMAT 1`；`TRAILSUBDIVISION` 0 / 4 / 16 / 32；`ORIENTATION` 0 / 1 / 2；
  - ropetrail：`TRAILRENDERER 1`；`TRAILSCROLLALPHA`、`TRAILFADEALPHA`、`TRAILFADESIZE` 全开；
  - 再各加一组 `REFRACT`、`FOG_DIST`、`LIGHTING`（带一盏点光）。
- **不变的：** 不带 `geometry` 的请求，原有语料结果和输出 WGSL 逐字节不变（取一批对，翻译前后比较）。

**验收（Claude）：**
- `git status` 查越界；`cargo test -p wpesl2wgsl --lib` 和语料测试自跑；`deno task build:wpesl2wgsl` 能出 wasm。
- 读生成的 GLSL，核对 rope `SUB 3` 的拼接结果。
- 变异检查：`Append` 计数从 1 起、退化时照常输出、跳过 include-once，各有测试失败。

### 1b — 宿主接入（TS）

路径相对 `apps/wpe-scene/src/`。

**现状锚点**（调研摘录，2026-11-10）：
- **编译：** `compileParticle`（`compile/bundle.ts:738`）对材质的每个 pass 调 `compilePass(pass, { particle: sheetSystem })`。
  - 着色器名直接取 `pass.shader`，不替换；
  - `defines` 来自闭包 `particleDefines`（`bundle.ts:678`），见下面的代码；
  - `ShaderCompiler.translate`（`compile/shader.ts:166`）只读 `.vert`、`.frag`；
  - 缓存键是 `shaderCacheKey`（`shader.ts:100`）。
```ts
const thick = system.renderer?.kind === "spritetrail" || !!texture?.sheet;
const tex0 = particleTex0Format(format, thick, system);
return { ...particleRendererDefines(system), ...particleSheetDefines(texture?.sheet, system), ...(tex0 !== undefined ? { TEX0FORMAT: String(tex0) } : {}) };
// particleRendererDefines：spritetrail → { THICKFORMAT: "1", TRAILRENDERER: "1" }，其它 {}
```
- **renderer：** `particleRenderer()`（`compile/particles.ts:204`）只找 `sprite` / `spritetrail`，找不到按缺省 sprite。模拟器不读 renderer（`particles/system.ts:193` 只解析 emitter / initializer / operator）。
- **管线：** 顶点布局 `vertexPacking`（`render/programs.ts:110`）的 `stepMode` 写死 `"vertex"`。`PipelineSpec.list`（`render/scene.ts:307`）对粒子取 `triangle-list`，图层取 `triangle-strip`。
- **顶点：** 每粒子 4 个顶点，全场共用 `quadIndices`。
  - `createParticles`（`scene.ts:1060`）按 `capacity × 4 × stride` 建缓冲；
  - `uploadParticles`（`scene.ts:1531`）在数据过期时调 `writeVertices`；
  - `draw`（`scene.ts:1693`）调 `drawIndexed(count * 6)`；
  - `particleAttributeProblems`（`scene.ts:336`）只认 sprite 的 5 个属性，其余报 `render:particle-attribute:*`。
- **uniform：** `particleBuiltins`（`render/uniforms.ts:395`）写 `g_Orientation*` 和 `g_RenderVar0 = trail ? [...trail, 0] : 0`。建 draw 时写一次；对象变换变脏时，`refreshLayer` 重写 `g_Orientation*`。
- **模拟：** `spawn`（`system.ts:404`）取第一个空槽；`ageAndKill`（`system.ts:366`）按槽号升序判死；`advance` 的顺序是：判死 → 帧 → 控制点 → 发射 → operator → 控制点帧尾。
- **能力表：** `checkParticleFeatures`（`compile/features.ts:637`）对表外模块报 `particle:<类别>:<名字>`。现在的 rope 报 `particle:renderer:rope`（`compile/particles.test.ts:1033`）。
- **四角探针：** `dev/particleCorners.ts:137` 把顶点 WGSL 改成计算着色器。
  - `instance_index` 恒传 `0u`；
  - 按 `index * stride` 读输入；
  - dispatch `particles × 4` 个。
- **回放：** 产品仓的 `particles/replay.test.ts` 读 `particles/fixtures/*.json`。P4c 拿抓帧比对的回放在 `ignore/p4/c5/`（独立的 vitest 配置）：`replay.test.ts` 用 `out/<tag>-log.txt` 差分出每帧 dt，`corners-offline.test.ts` 和 `gs_out` 比。

**做法：**
- **新增** 模块表的 `rope` 条目（`particles/modules.ts`）：
  - 字段：`subdivision` int，缺省 4，钳到 `[0, 32]`；`uvscale` num，缺省 1；`uvscrolling` bool，缺省 false；`uvsmoothing` bool，缺省 true；另加共用的 `RENDERER_FIELDS`。
  - `run: null`。`ropetrail` 仍在表外，留给步骤 2。
- **修改** `ParticleRenderer`（`compile/particles.ts`），`kind` 加 `"rope"`，并新增：
```ts
rope: {
  subdivision: number;   // TRAILSUBDIVISION
  inverseScale: number;  // K = 1/uvscale；uvscale 为 0 时不改，保持 1（rea-p4d-rope 3.1）
  scrolling: boolean;    // 0x20000，为真时不看 uvsmoothing
  smoothing: boolean;    // 0x40000
  lifetime: number;      // L：第一个中点非零的 lifetimerandom 的 min + (max − min)·0.5，没有则 0（3.2）
  rate: number;          // R：第一个 rate 非零的 sphererandom / boxrandom 的 rate，没有则 0
} | null;
```
  `g_RenderVar0` 对 rope 写 0：rope 分支不读它。WPE 写的 `z = 0`、`w = 存活数` 不复刻，步骤 2 的 ropetrail 才每帧写。
- **修改** 编译（`compile/bundle.ts`、`compile/shader.ts`）：
  - rope 系统的 pass，着色器一律换成 `genericropeparticle`，不论材质写的是什么（rea-p4d-rope 第 6 节）；blending、深度、纹理、常量照旧取材质；
  - `ShaderCompiler.compile` 加 `geometry` 选项，为真时读 `shaders/<名>.geom`，放进请求的 `geometry` 字段，缓存键加这一项；
  - rope 的宏：`THICKFORMAT=1`、`TRAILSUBDIVISION`、`ORIENTATION`；格式在 8–11 时写 `TEX0FORMAT`；不写 `SPRITESHEET*`（3.4）。
- **新增** `particles/rope.ts`：
```ts
/** rope 表（sys+0x218）：存槽号，出生时追加，判死后保序删除（同一槽出现多次也删光），表序就是出生序。 */
export class RopeOrder {
  constructor(capacity: number);
  push(slot: number): void;
  removeDead(slots: readonly number[]): void; // 一帧的死亡槽号，升序
  clear(): void;
  readonly slots: Uint32Array;
  length: number;
}
/** 每段一个实例，写进 out（按翻译结果的属性偏移），返回段数（存活数 ≤ 1 时为 0）。TL / TP0 照 1.2，每步 float32。 */
export function writeRopeSegments(system: ParticleSystem, layout: RopeVertexLayout, out: Float32Array, fps: number): number;
```
  - 段 k 写的内容照 1.3–1.4：起点 `idx[k]`、终点 `idx[k+1]`；CP0 取 `idx[k−1]`，首段取起点自身；CP1 取 `idx[k+2]`，末段取终点自身；w 分量依次是 `size[a]`、`TL`、`k + TP0`、`size[b]`；最后是终点颜色、起点颜色。
  - `R`、`L` 乘 `instanceoverride` 的 `count`、`lifetime`，不看系统 flags 的禁用位。
  - `fps` 取宿主的帧上限，和 `particlePasses` 用的是同一个值。
- **修改** `particles/system.ts`：
  - rope 系统建 `RopeOrder` 和死亡计数 `deaths`（`sys+0x350`）；
  - `spawn` 末尾 `push`；
  - `ageAndKill` 收集当帧死亡的槽号，循环后 `removeDead`，`deaths` 加上死亡数；
  - `clear` 清空两者。预热、`suspend` 都经过 `clear`。
- **修改** 绘制（`render/programs.ts`、`render/scene.ts`）：
  - 翻译结果带 `geometry` 时，`vertexPacking` 的 `stepMode` 用 `"instance"`，管线拓扑用 `"triangle-strip"`（`PipelineSpec` 的 `list` 换成 `topology`，进管线键）；
  - 顶点缓冲按 `capacity × stride` 建；
  - `uploadParticles` 走 `writeRopeSegments`，`count` 是段数；
  - 绘制用 `pass.draw(maxVertices, count)`，`count` 为 0 时不画；
  - `particleAttributeProblems` 对 rope 程序检查 6 个 rope 属性。
- **修改** 能力表：rope 进表后不再报 `particle:renderer:rope`。`particle:renderers`（多个 renderer）照旧报。
- **修改** `dev/particleCorners.ts`：程序带 `geometry` 时：
  - `vertex_index` 取 `id % maxVertices`，`instance_index` 取 `id / maxVertices`；
  - 按 `instance × stride` 读输入；
  - dispatch `段数 × maxVertices` 个；
  - 结果按段给出整条带子：位置、uv、颜色。

**测试（子代理）：**
- **单测：**
  - `RopeOrder`：追加；中间删除保序；重复项删光；`clear`。
  - `writeRopeSegments`：首段、中段、末段的 CP 和 w 分量；存活数 2 的特例、≤ 1 返回 0；平滑分支（含 `存活数 = N − 1` 的边界、`L = 0`）；滚动分支；`K`；读 `fps` 的分支。
  - 模块表：rope 的缺省值与钳制。
  - 编译：着色器替换、宏、缓存键带 `geometry`、`TEX0FORMAT` 只在格式 8–11 时写。
  - 假设备：rope 绘制调 `draw(maxVertices, 段数)`、实例步进、三角形带；sprite 的调用不变。
- **回放（`ignore/p4/d1/`，做法同 `ignore/p4/c5/replay.test.ts`）：**
  - 用 `out/p4d-rope-fps60-log.txt` / `fps10` 的帧时间回放 `proj/p4d-rope`，16 个系统；
  - 每个抓到的帧，用 `writeRopeSegments` 的输出和 `tracks/rd-p4d-rope-fps*.json` 的 `vs_in` 逐段比：位置、尺寸、颜色的限值同 P4c 回放，`TL`、`TP` 差 ≤ 1e-4。
- **离线展开：** 用 1a 的 wasm 翻译出的 WGSL 跑 `particleCorners` 的计算着色器改写，输入 WPE 的 `vs_in`，输出和 WPE 的 `gs_out` 逐顶点比，差 ≤ 0.01 像素。做法同 `ignore/p4/c5/corners-offline.test.ts`；`gs_out` 是三角形列表，奇数号三角形写成 `(v1, v3, v2)`，比之前先还原成带。

**验收（Claude）：**
- `git status` 查越界；tsc、vitest、Prettier 自跑；回放与离线展开自跑。
- 变异检查：保序删除改成交换删除、首段 CP0 改取下一段、`TL` 不乘 `K`、平滑分支的比较改成严格小于，各有测试失败。
- **真机：**
  - dev app 渲染 `proj/p4d-rope`，用四角探针读回的带子和 WPE `gs_out` 比，差 ≤ 0.01 像素；
  - `2254685070` 不再有不支持项，和 WPE 比画面，做法同 P4c 收尾的 `3832772446`。
- 语料重扫（`ignore/p4/d0/corpus.test.ts`）：变化逐条解释；现有画面哈希不变。

### 步骤 1 实施记录（2026-11-10）

**1a（子代理实现，Claude 验收）。**
- **新增 `src/geometry.rs`：** 规格 1–7 条照做。
- **规格外加了一条，必需：** 几何段里局部变量的初始值、`PS_INPUT` 字段的整体赋值，右边包一层 `kb_gs_as_<T>(…)`。
  - 原因：HLSL 允许 `vec4` 隐式截断成 `vec3`，比如 `vec3 eyeModel = mul(vec4, mat4)`；GLSL 不允许，naga 会报错。
  - 包装按实参类型重载：同类型原样返回，更宽的取前几个分量，标量铺满。
- **另外几处细节：**
  - `kb_gs_target = int(gl_VertexIndex)`；
  - `kb_gs_selected` 声明在结构体之后；
  - 跳过的头文件仍处理宏、只是不出行，这样头文件里的 `#define` 照样驱动几何段的 `#if`；
  - `GS_ENABLED` 排在 COMBO 之前，请求里的 `defines` 能覆盖它。
- **测试：**
  - 单测 55 个，其中新增 11 个；
  - 几何门槛 27 组；
  - 语料 158/167，和改动前相同；
  - 不带 `geometry` 的 177 次翻译、708 个输出文件，和改动前逐字节相同（`ignore/p4/d1/baseline/`）。
- **Claude 验收：** 自跑上面的测试；读 rope `SUB 3` 拼出的 GLSL（`ignore/p4/d1/rope-thick-sub3-ori0.vert.glsl`），结构正确。变异检查：子代理做了 4 处，Claude 另做 1 处（去掉 for 变量改名），各有测试失败。

**1b（子代理实现，Claude 验收）。** 规格「做法」都照做了，另外自定了几处：
- `bool` 字段类型照 jsoncpp `asBool`；
- `smoothing = !scrolling && uvsmoothing`；
- `ORIENTATION 0` 的绳不因 `g_Orientation*` 是 NaN 而跳过；
- `ParticleOptions.fps` 缺省 60，渲染器传 `maxFps`。

改的文件：
- 新增 `particles/rope.ts`；
- 修改 `particles/modules.ts`、`particles/system.ts`、`compile/particles.ts`、`compile/bundle.ts`、`compile/shader.ts`、`render/programs.ts`、`render/scene.ts`、`render/renderer.ts`、`dev/particleCorners.ts`。

**验收结果：**

| 项目 | 结果 |
|---|---|
| tsc、vitest（49 个文件、1331 个测试）、Prettier | Claude 自跑，通过 |
| 回放（`ignore/p4/d1/replay.test.ts`）：WPE 帧时间回放 `p4d-rope`，`writeRopeSegments` 的输出和 `vs_in` 逐段比 | 两种 fps、16 个系统，段数逐帧相同。位置 ≤ 4.3e-4（R11 坐标超过 1000，7.3e-4）；`TL` 差 0，`TP` 差 ≤ 5.7e-5。R7 的尺寸差 4.8e-3，在 `sizechange` 的近似倒数包络内 |
| 离线展开（`corners-offline.ts`，Deno WebGPU）：我们翻译出的着色器吃 WPE 的 `vs_in`，输出和 `gs_out` 比 | 34 组、201 帧，位置差 ≤ 2.3e-4 像素，uv 差 ≤ 9.5e-7，颜色 0；WPE 里含 NaN 的段，我们这边全部整段落在裁剪体外 |
| 真机，dev app 四角探针（`ignore/p4/d1/cmp_live.py`），fps 60 第 918 帧 | 17 个系统 ≤ 0.004 像素；R9 的 19 个 NaN 段一一对应 |
| 真机，fps 60 的 R11 | 差 494 像素。探针回放只步进粒子、不跑场景脚本，R11 的对象由脚本移动、旋转，复现不了；上面两项已经覆盖了 R11 |
| 真机，fps 10 第 161 帧 | R9 差 6e-5，其它约 0.16 像素。WPE 日志缺第 151–155 帧，工具按平均值平分；1b 从 R9 位置反推出的真实帧时间最多偏 0.0007 s，按 200 px/s 正好是这个量级 |
| 变异检查 | 子代理做了 4 条（保序删除改交换、首段 CP0 改取下一个、`TL` 不乘 `K`、平滑相等时不进），Claude 另做 1 条（滚动分支不用死亡计数），各有测试失败；最后一条回放里 R3、R12 的 `TP` 差 55–65 |
| 画面哈希（`ignore/p4/d1/out/hash-after.json` 对 `c5/out/hash-after.json`） | 10 张干净场景、三档，全部相同 |
| 语料重扫（`ignore/p4/d0/diff_corpus.py`） | 只去掉 `particle:renderer:rope`（22 张工坊场景加 kabegame-sample），不新增键；能渲染 22 → 23（`2254685070`），粒子用法完全覆盖 44 → 53 |

**`2254685070`：**
- 不再报不支持项；
- 绳系统 "Trails 1" 的控制点 0 是 `flags 1`（跟随指针），这是一个鼠标拖尾。`render_scene` 的光标固定，粒子都在一点上，段全是零长、不画，WPE 在鼠标不动时也是这样；
- 和 WPE 比画面要在抓帧时移动鼠标，照 P4c 的做法留到 P4d 收尾。

**遗留：**
- **死亡计数的清零（2026-11-10 核对，不是问题）：** 1b 子代理担心 WPE 在高水位 > 0 时就清零、我们只在有存活粒子时清零。看反汇编：
  - 不可见分支先在 `0x14023068e` 查存活数（`obj+0x604`），为 0 就整段跳过；
  - 复位发射器（`0x1402306bc`）、清零高水位与存活数（`obj+0x600` 按 qword 写 0）、死亡计数（`obj+0x610`）、rope 表（`obj+0x4e0 = obj+0x4d8`）都在这个分支里；
  - 「高水位 > 0」只是分支里的又一道检查。

  所以存活数为 0 时 WPE 也不清零，和我们的 `suspend` 一致。rea-p4d-rope 2.4 的写法容易误读，以 rea-p4d-modules 5.3 为准。
- **探针不传 `fps`：** kabegame-dev MCP 的 `particle_corners` / `render_scene` 回放只传 `passes`，低 fps 下 rope 的 `Rf` 仍按 60 算。只影响绳没满的填充期。
- `dev` 的 `particleTrack` 对 rope 系统仍按槽序输出粒子，不是表序。
- 暂停时改 `instanceoverride` 的 `count` / `lifetime`，`TL` 要到下一次步进才更新。

## 步骤 2 — `ropetrail`

几何着色器展开、实例步进的三角形带、四角探针，都直接用步骤 1 的。新的是模拟侧：每系统一个计时器，加上每粒子的位置历史。另外 `g_RenderVar0` 要每帧写。语义以 rea-p4d-rope 第 3.1、3.4、4、5 节为准，实测见报告「P4d 语义的实测核对」的 ropetrail 表。路径相对 `apps/wpe-scene/src/`。

**现状锚点**（步骤 1 之后）：
- **renderer 表：** `compile/particles.ts:239` 的 `DRAWN_RENDERERS = new Set(["sprite", "spritetrail", "rope"])`，不含 `ropetrail`，能力表照报 `particle:renderer:ropetrail`。
- **编译：** `compile/bundle.ts:194` 只给 rope 换着色器、写宏：
```ts
if (renderer?.kind === "rope")
  return { THICKFORMAT: "1", TRAILSUBDIVISION: String(renderer.rope?.subdivision ?? 0), ORIENTATION: … };
```
- **`g_RenderVar0`：** `render/uniforms.ts:407` 在建 draw 时写一次（`renderer.trail ? [...trail, 0] : 0`）。每帧只写 `frameNames` 里的帧内建。
- **模拟：** `particles/system.ts:330` 的 `step` 只调 `advance(dt')`，模拟之后没有挂钩；`clear` 不碰别的状态；`suspend` 只在存活数 > 0 时清空，和 WPE 一致（见步骤 1 实施记录）。
- **绘制：** `render/scene.ts:1093` 的几何着色器分支固定用 `ropeVertexLayout`（rope 的 6 个属性）和 `writeRopeSegments`。

**做法：**
- **新增** 模块表的 `ropetrail` 条目（`particles/modules.ts`），`DRAWN_RENDERERS` 加 `ropetrail`。字段与缺省照 rea 3.1：

| 字段 | 缺省 | 钳制 |
|---|---|---|
| `length` | 1 | 至少 0.001 |
| `segments` | 4 | `[2, 32]` |
| `subdivision` | 1 | `[0, 32]` |
| `fadealpha` | false | |
| `fadesize` | false | |
| `uvscale` | 1 | 0 时不改 |
| `uvscrolling` | false | |

  另加共用的 `RENDERER_FIELDS`。
- **修改** `ParticleRenderer`，`kind` 加 `"ropetrail"`，新增：
```ts
ropetrail: {
  segments: number;      // n
  interval: number;      // f32(length / segments)，sys+0x250
  subdivision: number;   // TRAILSUBDIVISION
  inverseScale: number;  // K = 1/uvscale，和 rope 共用 sys+0x30
  scrolling: boolean;    // 0x80000
  fadeAlpha: boolean;
  fadeSize: boolean;
} | null;
```
- **修改** 编译：ropetrail 也换成 `genericropeparticle` 并读 `.geom`，和 rope 同一条路。宏照 rea 3.4：
  - `TRAILSUBDIVISION`、`ORIENTATION`、`TRAILRENDERER=1`；
  - `TRAILSCROLLALPHA=1`，只在 `uvscrolling` 时写；
  - `TRAILFADEALPHA`、`TRAILFADESIZE`，只在对应字段为真时写；
  - 格式在 8–11 时写 `TEX0FORMAT`；
  - 不写 `THICKFORMAT`、`SPRITESHEET*`。
- **新增** `particles/ropetrail.ts`：
```ts
/** ropetrail 的历史（rea-p4d-rope 第 5 节）：每粒子 n 个位置（新的在前）、已存段数 C、uvscrolling 计数 U，每系统一个计时器。 */
export class TrailHistory {
  constructor(capacity: number, segments: number, scrolling: boolean);
  timer: number;                                            // sys+0x24c，初值 0；clear、预热都不重置
  born(slot: number, columns: ParticleColumns): void;      // 出生，在全部 initializer 之后：h[*] = 出生位置，C = 1，U = 0
  afterPrewarm(columns: ParticleColumns, highWater: number): void; // 预热后 0..高水位−1 每个槽：C = 1，h[*] = 当前位置，U = 0
  sample(dt: number, interval: number, columns: ParticleColumns, highWater: number, alive: number): void;
}
/** 每个存活粒子按槽序恒写 n 段（rea 5.3），返回段数（存活数 · n）。 */
export function writeTrailSegments(system: TrailSource, layout: TrailVertexLayout, out: Float32Array): number;
/** g_RenderVar0（rea 第 4 节）：z = 1 − max(timer, 0)/interval；w = n − 0.5，uvscrolling 时 w = (n − 1)·K、x = n − 1。 */
export function trailRenderVar0(renderer: …, timer: number): [number, number, number, number];
```
  - **`sample` 照 5.2，每步 float32：**
    1. 存活数为 0 时直接返回，计时器停走；
    2. `timer = timer − dt'`，`dt'` 已乘 `instanceoverride.rate`；
    3. `!(0 < timer)` 时：`timer = interval`，余量丢掉；每个存活粒子的历史整体后移一格，`h[0]` 写本帧模拟后的位置，`C = min(C + 1, n)`，`U` 加 1（u16 回绕）。
    - 每帧最多采一次；`dt' > interval` 时也只采一次。
  - **段的内容照 5.3：**
    - 段 0：`p → h[0]`，CP0 是 `p`，CP1 是 `h[1]`；
    - 段 1：`h[0] → h[1]`，CP0 是 `p`，CP1 是 `h[2]`；
    - 段 k（2 … n−2）：`h[k−1] → h[k]`，CP0 是 `h[k−2]`，CP1 是 `h[k+1]`；
    - 末段：`h[n−2] → h[n−1]`，CP0 是 `h[n−3]`，CP1 是终点自身；
    - `n = 2` 时段 1 的 CP0 是 `p`、CP1 是 `h[1]`。
  - **段的属性：**
    - `a_PositionVec4 = (起点, size)`；
    - `a_TexCoordVec4 = (终点, w)`，`a_TexCoordVec4C1 = (CP0, w)`，`a_TexCoordVec3C2 = CP1`；
    - `a_Color` 是当前颜色和 alpha；
    - w 分量：不滚动时依次是 `C·K` 和 `k`；滚动时依次是 `k` 和 `k − U`。
  - 未填满的段零长，由几何着色器展开的退化规则整段不画，不另外处理。
- **修改** `particles/system.ts`：
  - ropetrail 系统建 `TrailHistory`；
  - `spawn` 在全部 initializer 之后调 `born`；
  - `prewarm` 末尾调 `afterPrewarm`；
  - `step` 在 `advance` 之后调 `sample`，`dt'` 用同一个值。预热不采样（预热不走顶点函数，5.1）。
- **修改** 绘制（`render/scene.ts`、`render/uniforms.ts`）：
  - 几何着色器分支按 renderer 种类选布局和写入函数：rope 是 6 个属性和 `writeRopeSegments`，ropetrail 是 5 个属性和 `writeTrailSegments`；
  - ropetrail 的顶点缓冲按 `capacity × n` 段分配，`draw(maxVertices, 存活数 · n)`；
  - ropetrail 的 `g_RenderVar0` 每帧按当时的 `timer` 写（`trailRenderVar0`）。不滚动时 `x` 写 0（着色器只在 `TRAILSCROLLALPHA` 分支读它，WPE 留的是上一次绘制的值）。
- **修改** `dev/particleCorners.ts`：确认 ropetrail 能读回，它有 `vec3` 输入，按段给出整条带子。

**测试（子代理）：**
- **单测：**
  - `TrailHistory`：出生；`timer` 恰好为 0 时采样；余量丢掉；`dt' > interval` 也只采一次；存活数为 0 时停走；新的在前；`C` 封顶；`U` 加 1；`afterPrewarm`；`clear` 不重置计时器。
  - `writeTrailSegments`：段 0、1、k 和末段的 CP；`n = 2`；两种 w；按槽序、跳过死槽。
  - `trailRenderVar0`。
  - 模块表的缺省值与钳制（`segments` 0 / 40、`length` 0、`subdivision` 40）。
  - 编译：宏，以及不写 `THICKFORMAT`。
  - 假设备：`draw(maxVertices, 存活数 · n)`，`g_RenderVar0` 每帧更新。
- **回放（`ignore/p4/d2/`，做法同 `ignore/p4/d1/replay.test.ts`）：**
  - 用 WPE 帧时间回放 `proj/p4d-ropetrail`，每个抓到的帧和 `tracks/rd-p4d-ropetrail-fps*.json` 逐段比：`vs_in` 的 `POSITION`、`TEXCOORD0`、`TEXCOORD1`、`TEXCOORD2`（vec3）、`COLOR`；`g_RenderVar0` 取 `consts.vertex`。
  - 轨迹 JSON 里有 Python 写的 `NaN`，读前换成 `null`。
  - fps 10 的日志只到第 150 帧，第 151–156 帧要反推：用 T4seg40 在第 157 帧的历史（32 段、每帧采样、x 方向匀速 300 px/s）求逐帧 dt，和第 157 帧的 `time` 核对合计。
  - T7（`starttime 1`）在 WPE 的抓帧里一直没有绘制。我们的回放在这些帧里也应当没有存活粒子；对不上就查清原因写进汇报。猜测是满容量时发射计时冻结，周期变成约 3.95 s。
- **离线展开：** 同 `ignore/p4/d1/corners-offline.*`，ropetrail 12 个系统、两种 fps，和 `gs_out` 逐顶点比，差 ≤ 0.01 像素，NaN 段对应整段落在裁剪体外。

**验收（Claude）：**
- `git status` 查越界；tsc、vitest、Prettier、回放、离线展开自跑。
- 变异检查，各有测试失败：
  - 余量带进下一周期；
  - 后移方向反了（新的在后）；
  - 首段 CP0 改取 `h[0]`；
  - `RV0.z` 不取 `max(timer, 0)`；
  - 一帧可采多次。
- **真机：** dev app 四角探针读回 `p4d-ropetrail` 的带子，和 WPE `gs_out` 比，fps 60 差 ≤ 0.01 像素。
- 画面哈希不变：10 张干净场景三档，对 `ignore/p4/d1/out/hash-after.json`。
- **语料：** 只去掉 `particle:renderer:ropetrail`，不新增键。用到它的 8 张都还差子系统或属性绑定，所以能渲染数（23）和覆盖数（53）预计不变。

### 步骤 2 实施记录（2026-11-10）

子代理实现，Claude 验收。

**新增和修改的文件：**
- 新增 `particles/ropetrail.ts`（`TrailHistory`、`writeTrailSegments`、`trailRenderVar0`）；
- 修改 `particles/modules.ts`、`particles/system.ts`、`compile/particles.ts`、`compile/bundle.ts`、`render/scene.ts`、`render/uniforms.ts`、`dev/particleCorners.ts`。

**规格之外自定的几处：**
- 新增 `isRopeRenderer(kind)`，编译两处共用；
- 段写入按 `system.trail` 分派，`ParticleDraw.rope` 的形状不变；
- `particleUniformValues` 多一个参数 `trailTimer`：建 draw 时写计时器初值的 `RV0`，之后每帧由 `update` 重写；
- 不滚动时 `RV0.x`、`RV0.y` 写 0；
- `writeTrailSegments` 放不下一整个粒子的 n 段时就停。

**其间别的会话提交了 `95715c09`（P5a）**，也动过 `bundle.ts`、`features.ts`。核对过，这两个文件里未提交的改动只有 ropetrail 的。

**验收结果：**

| 项目 | 结果 |
|---|---|
| tsc、vitest（51 个文件、1382 个测试）、Prettier | Claude 自跑，通过 |
| 回放（`ignore/p4/d2/replay.test.ts`），和 `vs_in`、`g_RenderVar0` 逐段、逐帧比 | 12 个系统、两种 fps，每帧段数和 WPE 相同。位置 ≤ 4.4e-4；尺寸、颜色、alpha、两个 w 分量都是 0；`RV0` ≤ 2.2e-6 |
| fps 10 缺的第 151–156 帧 | 用 T4seg40 在第 157 帧的历史反推：和日志重叠的 13 帧逐帧差 ≤ 1.3e-6；6 帧的合计和按 `time` 算出的差 −7.8e-7 |
| T7 为什么在 WPE 里一直没画 | 我们的回放在两段抓帧窗口里同样没有存活粒子。满容量时发射计时冻结（P4b 已实现），周期约 3.94 s：2 s 攒满，加 1.95 s 存活；预热 1 s 只攒到 0.5。T1 的出生时刻（fps 60 下 2.02、5.94、9.87、13.81 s）也对得上 |
| 离线展开（Deno WebGPU），和 `gs_out` 逐顶点比 | 22 组（T7 两种 fps 都没有绘制），位置 ≤ 2.3e-4 像素，uv ≤ 2.4e-7，颜色 0；NaN 段一一对应 |
| 真机（dev app 四角探针，fps 60 第 926 帧，`ignore/p4/d1/cmp_live.py`） | 11 个系统 ≤ 4.6e-4 像素，NaN 段一一对应；T7 双方都没有绘制 |
| rope 不回退 | `ignore/p4/d1` 的回放通过，离线展开的输出和步骤 1 逐字相同 |
| 变异检查 | 子代理做了 5 条（规格「验收」所列），Claude 另做 1 条（已存段数不封顶），各有单测失败。其中「`RV0.z` 不取 `max(timer, 0)`」回放查不出：采样后计时器重置为间隔，存下的值总在 (0, 间隔] 内，只能靠单测 |
| 画面哈希（`ignore/p4/d2/out/hash-after.json` 对 `d1/out/hash-after.json`） | 10 张干净场景、三档，全部相同 |
| 语料（`ignore/p4/d2/out/corpus-*.json`，基线是 HEAD 导出的） | 只去掉 `particle:renderer:ropetrail`（8 张工坊场景加 kabegame-sample），不新增键。能渲染 24、覆盖 53，前后不变；24 比步骤 1 多出的 1 张来自 P5a |

**遗留：** 「预热后历史塌缩到当前位置」只有单测。T7 的设计里预热期间根本不出粒子，WPE 实测测不到。要补测，得让预热期间真的出粒子，比如 `rate 2` 或 `instantaneous 1`。

## 步骤 3 — `mapsequence*`

两个 initializer 按序号把新粒子放到控制点周围或两个控制点之间。新东西只有一样：**initializer 第一次有了运行状态**（序号 `seq` 和步长 `step`），要跟着系统的复位与周期发射清零。公式以 rea-p4d-modules 1.1–1.3 为准，实测见报告「P4d 语义的实测核对」的 mapsequence 表（全部成立）。路径相对 `apps/wpe-scene/src/`。

**语料（`ignore/p4/d3/scan_map.py`）：**
- `around` 有 8 张场景，全是同一个鼠标拖尾文件 `Cherry_Blossoms_2.json`：`count 5`，`speedmin = speedmax = "0 100 0"`，发射器都不是周期发射。其中 3 张的对象带 `instanceoverride.count`：3487328036 是 0.02，3811764016、3811798465 是 0.5。
- kabegame-sample 的 `dna.json`：同一系统里先 `around`（`axis "0 1 0"`、`count 2.2`），再 `between`（`count 64`）。
- `between`：
  - 3832133196 的闪电，`flags 23`，子系统是 `flags 19`，周期发射；对象覆盖了 `controlpoint1`，没有 `count`；
  - kabegame-sample 的 `dischargearc.json`：`flags 15`，mirror。

**现状锚点：**
- **模块执行函数没有状态**（`particles/modules.ts:194`、`particles/system.ts:129`）：
```ts
export type ParticleModuleRun = (fields: ParticleFields, context: ParticleRunContext) => void; // 现状：只有字段和上下文
interface ResolvedModule { name; def; base; fields; run }                                      // 现状：只有 emitter 另有 state
```
- **`instanceoverride` 无条件乘**（`particles/modules.ts:998` `resolveParticleFields`）：字段定义的 `instance` 有就乘。`between` 的 `count` 只在模块 `flags & 0x10` 时乘，现在表达不了。
- **周期发射的新周期**（`particles/emitters.ts`，`emissionCount` 的间歇分支）：
```ts
else { const u = random.a(); state.pending = …; state.burst = 0; state.period = lerp(…); } // 现状：新周期只重置发射计时
```
- **复位**（`particles/system.ts:327` `suspend`）：只复位 emitter 计时（`resetEmitterTiming`，即 `FUN_14022f6c0` 的 emitter 部分），再 `clear`。
- **控制点个数**（`particles/controlpoints.ts:119`）：只数模块表里带 `controlpoint` 字段的模块，不认 `controlpointstart` / `controlpointend`。
- **能力表**：两个模块不在表里，照报 `particle:initializer:mapsequence*`。

**做法：**
- **修改** `particles/modules.ts`：
```ts
export type ParticleModuleRun = (fields: ParticleFields, context: ParticleRunContext, state?: unknown) => void; // 修改：可选的模块状态
export interface ParticleModuleDef {
  // …其余不变
  /** 新增：模块的运行状态（WPE 存在流记录里、每实例一份）。有它的模块，模拟器建一份、传给 run。 */
  createState?: (fields: ParticleFields) => unknown;
  /** 新增：系统复位（`FUN_14022f6c0`）时调。 */
  resetState?: (state: unknown) => void;
  /** 新增：周期发射进入新周期（`FUN_14022f790`）时调；按字段决定清不清零。 */
  newPeriod?: (state: unknown, fields: ParticleFields) => void;
}
interface ParticleFieldDef {
  // …其余不变
  /** 新增：按解析值决定这一项乘不乘 `instance`（`between` 的 `count` 只在 `flags & 0x10` 时乘，条目 4）。 */
  instanceIf?: (fields: Readonly<Record<string, ParticleFieldValue>>) => boolean;
}
```
  - `resolveParticleFields` 照 `instanceIf` 决定乘不乘，看的是基值的 `flags`。
- **新增** 模块表的两个 initializer，执行函数放在新文件 `particles/mapsequence.ts`。字段照 rea 1.1、1.2 的字段表：

| 模块 | 字段 | 缺省 | 解析 |
|---|---|---|---|
| 两者 | `count` | 32 | around：`step = 1/max(count, 1e-4)`；between：`step = 1/max(count − 1, 1e-4)`；都是 float32 `divss` |
| 两者 | `bounds` | `"0 1"` | 两个数，缺的分量是 0，不钳制；存 `b0 = x`、`Δb = y − x` |
| 两者 | `limitbehavior` | `"repeat"` | 只有精确等于 `"mirror"` 才是 mirror |
| around | `speedmin`、`speedmax` | `"0 0 0"` | 乘 `instanceoverride.speed`（`by("speed")`，条目 0xa） |
| around | `axis` | `"0 0 1"` | 基向量照 rea 1.1 的 `FUN_1401c19e0`：零向量换成 z，`a.x = a.y = 0` 时 `B1 = (1,0,0)`、`B2 = (0,1,0)` |
| around | `controlpoint` | 0 | `clampControlPoint` |
| around | `flags` | 0 | WPE 不解析，任何值都不起作用。`count` 不乘 `instanceoverride.count`（「决定」3 实测） |
| between | `controlpointstart` / `controlpointend` | 0 / 1 | `clampControlPoint` |
| between | `flags` | 0 | 读的位只有 1、2、4、8、0x10、0x20；别的位照报 `particle:initializer:mapsequencebetweencontrolpoints:flags` |
| between | `arcamount` | 0.3 | |
| between | `arcdirection` | `"0 1 0"` | 不归一化，也不乘控制点矩阵 |
| between | `sizereductionamount` | 0.9 | |
| between | `count` 的覆盖 | | `instanceIf: flags & 0x10`，乘 `instanceoverride.count` |

```ts
/** 序号状态（rec+8 与 rec+4 的 step），每个系统实例一份。step 在 mirror 时会变号，复位不恢复它的符号（rea 1.3）。 */
export interface SequenceState { seq: number; step: number; }
/** 用完一个序号之后推进（rea 1.1 / 1.2）：seq′ = f32(step + seq)；
 *  seq′ > 1：repeat 时 around 取 fmodf(seq′, 1)、between 归零；mirror 时 seq = 1 − (seq′ − 1)，step 取反；
 *  seq′ < 0（只有 mirror 会出现）：seq = −seq′，step 取反。比较都是严格的，所以 around 的第一圈留着 1.0。 */
export function advanceSequence(state: SequenceState, mirror: boolean, wrapToZero: boolean): void;
/** around 的基向量（rea 1.1 的 `FUN_1401c19e0`，全部精确 sqrt / 除法）。 */
export function aroundBasis(axis: readonly number[]): { axis: Vec3; b1: Vec3; b2: Vec3 };
export function mapSequenceAround(fields: ParticleFields, context: ParticleRunContext, state: SequenceState): void;
export function mapSequenceBetween(fields: ParticleFields, context: ParticleRunContext, state: SequenceState): void;
```
  - **`around` 的执行照 rea 1.1，逐步 float32：**
    - `M` 是控制点 `current` 的 3×3，`C` 是它的平移。`A = M·axis`，`B1′ = M·B1`，`B2′ = M·B2`，用 `mulBasis`，乘完不再归一化。
    - `d = P − C`，`proj = (d.x·A.x + d.y·A.y) + d.z·A.z`，`r = d − proj·A`，`L = sqrt((r.x² + r.y²) + r.z²)`。
    - `θ = ((Δb·seq) + b0)·f32(2π)`；`s = f32(sin θ)`、`c = f32(cos θ)`（CRT 的 `sinf` / `cosf`，可能差 1 ulp，同 `eulerBasis` 的处理）。
    - `dirA = c·B2′ + s·B1′`，`dirB = (−s)·B2′ + c·B1′`。
    - **无条件**从 A 区间依次抽 `u1`、`u2`、`u3`；`speed` 全为 0 也照抽。
    - 位置**覆盖**成 `(dirA·L) + ((proj·A) + C)`。
    - 速度**加上** `((((dirA·smin.y + u3·(dirA·Δs.y)) + smin.x·dirB) + u2·(Δs.x·dirB)) + smin.z·A) + u1·(Δs.z·A)`。括号就是加法顺序，`Δs = speedmax − speedmin`，在乘过 `speed` 之后求差。
    - 最后推进序号。
  - **`between` 的执行照 rea 1.2：**
    - `S`、`E` 是两个控制点 `current` 的平移；`D = E − S`；`L = sqrt(…)`；`Lc = L > FLT_MIN ? L : FLT_MIN`（NaN 也取 `FLT_MIN`）；`û = D / Lc`。
    - 世界系统（`context.world`）先 `P −= S`；本地系统按系统原点量，**不减**。
    - `proj = P·û`，`r = P − proj·û`，`t = seq·Δb + b0`，`w = 1 − f32(x·x)`，其中 `x = |(seq + seq) − 1|`。`w` 用的是 `seq`，不是 `t`。
    - 各位：`flags & 1` 时 `r *= w`；位置写 `r + ((t·û)·Lc + S)`；`flags & 8` 时再加 `arcdirection·((w·Lc)·arcamount)`；`flags & 2` 时 `vel *= w`；`flags & 4` 时 `size0 *= (1 − srm) + srm·w`。
    - 不抽随机数。最后推进序号（repeat 时归零）。
  - `createState` 给 `{ seq: 0, step: f32(1 / …) }`。`instanceoverride` 改值重算时，`between` 在 `flags & 0x10`、且系统 `flags` 没禁用 `count`（bit5）时，`step` 直接重写成正的 `1/max(count·ic − 1, 1e-4)`（条目 4，`FUN_1401d15a0` 的 `case 4`）。所以 mirror 走到一半会回到正向。`around` 不登记条目，不动；两者的 `seq` 都不动。（原规格写「大小更新、符号保留」，是没核对条目 4 的推测，实施时按读码更正。）
  - `resetState`：两者都 `seq = 0`，`step` 不动。
  - `newPeriod`：只有 `between` 在 `flags & 0x20` 时 `seq = 0`；`around` 不清零（配周期发射的照报，见「决定」3）。
- **修改** `particles/system.ts`：
  - `ResolvedModule` 加 `state`，有 `createState` 的模块才建，`run(fields, context, state)`；`setInstance` 重算字段后按上一条更新 `step`。
  - `suspend`：在复位 emitter 计时的同一处，对每个有状态的模块调 `resetState`（同在 `FUN_14022f6c0` 里，同样只在有存活粒子时做）。
  - `emit`：emitter 进入新周期时（`emissionCount` 里 `EmitterState` 新增的 `periodStarted` 标记，算数量时置位），先对全部 initializer 调 `newPeriod`，再出生这个 emitter 本帧的粒子。这个调用在 `FUN_1402378a0` 里，早于本帧的新粒子。
  - 子系统的复位（`def+0x64 & 2`）归 P4e，不做。
- **修改** `particles/controlpoints.ts` 的 `controlPointCount`：也数 `controlpointstart`、`controlpointend`。`between` 不写字段时 `end` 缺省为 1，所以控制点个数至少 2（`def+0x2c = max(·, start + 1, end + 1)`）。
- **修改** 能力表（`compile/features.ts`）：两个模块进表后不再报。另加 `around` 的系统级检查：系统里有发射器开了周期发射（`flags & 4`）时，报 `particle:initializer:mapsequencearoundcontrolpoint:periodic`（「决定」3：bit1 没实测）。

**测试（子代理）：**
- **单测：**
  - `advanceSequence`：`count 5` repeat 的前 12 个值（含第一圈的 1.0 和之后的 `0.20000005`）；`count 2.2` repeat 和 mirror；`between` `count 8` 一圈 8 个点含两端、`count 4` mirror。都对 rea 1.1、1.2 的 float32 推演，逐位相同。
  - `aroundBasis`：缺省轴、零向量、`"0 0 -1"`、`"0 1 0"`（`B1 = (1,0,0)`、`B2 = (0,0,−1)`）。
  - 两个执行函数：`θ = 0` 在 +y；保留出生点到轴的距离；`speed` 三个分量的方向；每粒子正好抽 3 次 A；`between` 的本地 / 世界两种分支，以及 `flags` 各位。
  - `instanceIf`：`between` 只在 `flags & 0x10` 时乘 `count`；`setInstance` 后 `step` 重写成正的新值（条目 4）。
  - 复位：`suspend` 清零 `seq`、`step` 保留符号；周期新周期只清 `between` `flags & 0x20` 的。
  - `controlPointCount`：`between` 不写字段时得 2。
- **回放（`ignore/p4/d3/`，做法同 `ignore/p4/d1/replay.test.ts`）：**
  - 用 WPE 帧时间回放 `proj/p4d-map`，和 `tracks/rd-p4d-map-fps60.json` 每帧**按槽序逐粒子**比位置和尺寸。
  - 序号的相位取决于加载以来发了多少粒子，所以逐粒子比能同时验发射和序号，步骤 0 的「看圈数集合」做不到这一点。
  - `ma-hide` 的对象每 10 s 的 [7, 8) 不可见：回放在这些帧调 `suspend` 而不是 `step`。判断用哪一帧的场景时间，照 P4c「一帧里粒子先于脚本」的结论。这一组能验步骤 0 没测到的「复位清零序号」：清零与否，重新可见后各槽的方向不同。
  - `mb-period32` / `mb-period0` 能验新周期清零的时刻。
  - `ma-speed` 只在 `Δs = 0` 时可比；随机数和 WPE 不同步，这组只比位置。
- **离线 / 真机：** 这一步只有模拟，不涉及绘制，不做真机。原来写的「真机渲染 3816870245」做不到：它另有 23 个非粒子的不支持项（文字对象、`general:cameraparallax`、`tex:video`、两处着色器错误），步骤 0 说它「只差 around」是按粒子覆盖的口径。

**验收（Claude）：**
- `git status` 查越界；tsc、vitest、Prettier、回放自跑。
- 变异检查，各有测试失败：
  - 序号先加后用；
  - `around` 超过 1 时归零（`between` 的写法）；
  - mirror 不把 `step` 取反；
  - `θ = 0` 改在 +x；
  - `between` 本地系统也减 `S`；
  - `w` 用 `t` 不用 `seq`；
  - 复位不清零 `seq`；
  - 新周期不看 `flags & 0x20`。
- 画面哈希不变：10 张干净场景、三档。
- **语料：**
  - 只去掉 `particle:initializer:mapsequencearoundcontrolpoint`、`…betweencontrolpoints`，不新增键（语料里没有周期发射配 `around`）；
  - 能渲染数不变（24），见上一条；
  - 覆盖 53 → 57（3811764016、3816870245、3823859141、3823864170）。

### 步骤 3 实施记录（2026-11-10）

**做法：** 并行会话（P5a）在 `apps/wpe-scene` 里有大量未提交改动，也动了 `compile/features.ts`，所以这一步走 kbp-tools 的快照流程：
- `kbp snapshot export HEAD` 出两份快照：`ignore/p4/d3/head` 是基线，`ignore/p4/d3/ov` 是开发副本；
- 子代理只在 `ov` 里实现、测试；
- `kbp snapshot diff` 出补丁 `ignore/p4/d3/step3.patch`（10 个文件，+1141 / −17），提交时再打进工作区和索引，只提交这些块。

**测的是什么：** 先实测「决定」3（`around` 的残留字），结论见那一节。子代理实现期间看门狗中止过一次，从断点续做。

**新增和修改的文件（相对 `apps/wpe-scene/src/`）：**
- 新增 `particles/mapsequence.ts`（序号状态、`advanceSequence`、`aroundBasis`、两个执行函数、状态钩子）和 `particles/mapsequence.test.ts`（35 个单测）；
- 修改 `particles/modules.ts`、`particles/system.ts`、`particles/emitters.ts`、`particles/controlpoints.ts`、`compile/features.ts`；
- 三个测试文件只改了期望值（模块表多两项，`EmitterState` 多一个字段）。

**规格之外自定的几处：**
- `setInstance` 的钩子起名 `instanceState`；`step` 的符号按读码更正，见「做法」；
- `resetEmitterTiming` 也清新周期标记；
- `between` 的 `flags` 多余位，走模块表字段的 `supported`，由现有机制报 `…:flags`。

**验收结果：**

| 项目 | 结果 |
|---|---|
| 越界 | `apps/wpe-scene/` 未动（改动条目数和开工前相同，都是 P5a 的）；`head` 快照和 HEAD 逐文件相同 |
| tsc、vitest（`ov`，带 `KABEGAME_WPE_ROOT`）、Prettier | Claude 自跑：tsc 0 错，52 个文件、1417 个用例全过。Prettier 13 个文件通过：`ignore/` 在 `.gitignore` 里，`--check` 要加 `--ignore-path .prettierignore`，否则是空检查 |
| 回放 `kbp replay d3`（`p4d-map` fps 60，按槽序逐粒子比位置和尺寸） | 20 个系统，逐帧粒子数相同，全部通过。<br>`mb-*` 9 组逐位为 0，`mb-f2` 3.7e-4。<br>`ma-*` 差/限 0.42–0.69，是 `sphererandom` 的近似倒数。<br>`ma-hide` 在第 421 帧清空，之后逐粒子对上，即「复位清零序号」成立；这一条步骤 0 没测到 |
| 回放里钉住的变体 | 复位不清零：ma-hide 超限 9.5e4 倍；新周期不清零：mb-period32 超限 5.25e5 倍 |
| 回归 `kbp regress`（head 对 ov，8 个现有案例） | 全部逐字节相同；ropetrail 的老式回放（`d2/replay.test.ts`，`KB_SRC`）两边也逐字节相同 |
| 变异检查 | 子代理 9 条（规格的 8 条，「新周期不看 0x20」拆成总清零 / 从不清零），各有单测或回放失败；其中「`w` 用 `t`」回放查不出（`bounds "0 1"` 时 t = seq），只靠单测。<br>Claude 另做 1 条（`around` 的切向 `dirB` 反号）：ma-speed 超限 1.6e5 倍，2 个单测失败。还原后重出的补丁和原补丁逐字节相同 |
| 语料（`d3/out/corpus-diff.txt`） | 只去掉两个模块键（around 9 张、between 2 张，都含 kabegame-sample），不新增键，编译出错 0。<br>覆盖 53 → 57，能渲染 24 不变 |

**遗留**（都已收进「未实测清单」，P4d 收尾统一走查）：
- 可见性按上一帧还是本帧的脚本，这组数据分不出（两种都通过）。WPE 不可见期间照不照常模拟（rea 5.3【推】）也分不出：ma-hide 的位置和粒子年龄无关。
- `around` 配周期发射照报（bit1 没测），语料 0 张。
- 「干净重启后只解析过桌面壁纸」的情况没测（`restart_wpe` 被权限拦下）。

## 步骤 4 — `remap*`

**设计。** 两个模块是同一条管线：输入 → 分量 → 归一化 → 变换 → 输出区间 → 运算写回。
- 只写一份 `particles/remap.ts`，每一段按模块种类（`init` / `op`）取变体。WPE 的两份实现在下面列的 18 处不同，其余逐位相同。
- 读码与实测在 rea-p4d-modules 第 2 节、报告「P4d 语义的实测核对」的 remap 表；按「决定」2，读码确定的全做，`timeofday` 和未知枚举照报。路径相对 `apps/wpe-scene/src/`。

**管线外要补的状态：**
- 系统时间 `St`（`sys+0x3f0`）、图层时间（`obj+0x770`）、对象原点 `W.t`；
- 控制点个数的新引用规则；
- 被 remap 写的控制点打 `0x10000`。

**拆成两步，各自单独验收、单独提交：**
- **4a**：管线、全部非噪声取值、新状态。
- **4b**：噪声的两种实现（`init` 的 `snoise1` / `fbm1`，`op` 移植 FastNoise2），以及写控制点的三种情况：输出 `controlpoint`；`op` 只写 lane 0；`init` 的输入 16–18 把控制点写成 0。
- 4a 期间这几项按字段照报，4b 放开。

**语料（`ignore/p4/d0/out/scan.txt`）：**
- `remapvalue` 有 6 个（顶层 5、子系统 1），在 3815289650、3832133196 两张场景：
  - 输入都是 `particlesystemtime`（3 个写了，其余吃缺省 `lifetimefraction`）；
  - 变换 `sine` 3、`simplexnoise` 2、`fbmnoise` 1；
  - 输出 `opacity` 3、`velocity` 2、`speed` 1；
  - 运算 `remap` 2（其余缺省 `multiply`）；`flags` 0 / 3；三个带 `blendin*`。
- `remapinitialvalue` 只有 3832133196 子系统里的 3 个：`distancetocontrolpoint`、`multiply`。

**现状锚点：**
- **两个模块不在表里**（`particles/modules.ts:402` 的 `PARTICLE_MODULES`）：
```ts
export const PARTICLE_MODULES: readonly ParticleModuleDef[] = [ /* …没有 remapinitialvalue、remapvalue */ ];
// 现状：能力表照报 particle:initializer:remapinitialvalue、particle:operator:remapvalue
```
- **字段类型没有「字符串读三个数、数字铺满」**（`particles/modules.ts:76`）：
```ts
export type ParticleFieldType = "number" | "int" | "vec3" | "vec3z" | "vec3str" | "string" | "bool";
// 现状：vec3 写成数字时报不支持；vec3z 只给 z；vec3str 保持缺省。remap 的 inputrange* / outputrange* 写数字时要铺满三分量
```
- **执行上下文没有系统时间、图层时间、对象原点**（`particles/modules.ts:163` 的 `ParticleRunContext`）：
```ts
export interface ParticleRunContext {
  time: number;          // 场景时间 T（现状：唯一的时间）
  model: Float32Array;   // W 的 3×3（现状：没有平移）
  // …
}
```
- **系统时间、图层时间没人维护**（`particles/system.ts` 的 `step` / `suspend`）：`step` 只累加 `elapsed`（缺省的场景时间）；`suspend` 只复位 emitter 计时与模块状态，再 `clear`。
- **控制点个数只认三个字段名**（`particles/controlpoints.ts:123`）：
```ts
const CONTROL_POINT_FIELDS = ["controlpoint", "controlpointstart", "controlpointend"] as const; // 现状：remap 的 icp / ocp 不计
```
- **`0x10000` 预留了但没人置**（`particles/controlpoints.ts:54`、`:278`）：`update` 见 `CONTROL_POINT_FLAGS.remap` 就跳过、建系统时不吃实例覆盖，但 `flags` 只来自 JSON。
- **每遍开头从初始值复制当前值**（`particles/system.ts` `advance` 里的 `columns.resetCurrent`）：已经和 WPE 一样。`remapvalue` 写 `size` / `alpha` / `color`，两遍结果不变，不用改。
- **出生时 frame 列先于 initializer 写**（`particles/system.ts` `spawn`）：`randomframe` 写 `R`、否则 0。`remapinitialvalue` 的 `lifetimefraction` 读它，正是 WPE 的行为（rea 2.2），不用改。

### 4a — 管线与非噪声取值

- **新增** 字段类型 `vec3splat`（`particles/modules.ts`）：字符串读三个数，缺的分量是 0；数字原样铺满三分量（rea 2.1，`inputrange*` / `outputrange*`）。
- **新增** 模块表的两项。字段照 rea 2.1 的字段表，缺省不分正交 / 透视：

| 字段 | 缺省 | 解析与照报 |
|---|---|---|
| `operation` | `"multiply"` | `remap` / `multiply` / `add` / `subtract`；别的字符串照报 `…:operation`（WPE 不写） |
| `input` | init `"maxlifetime"`，op `"lifetimefraction"` | 20 个名字（rea 2.2 的表）；`timeofday` 和未知名字照报 `…:input`。4a 期间 init 的 `controlpoint` / `deltatocontrolpoint` / `directiontocontrolpoint` 也照报，4b 放开 |
| `output` | `"size"` | 同一张名字表；`lifetimefraction`、`runtime`、`timeofday`、`particlesystemtime`、`layertime`、`layerorigin` 读码确定不写，照常放行。未知名字照报。4a 期间 `controlpoint` 照报 |
| `inputcomponent` / `outputcomponent` | `"all"` | `all` / `x` / `y` / `z` / `sum` / `average` / `max` / `min`，未知照报。输出分量写出时只认 `all`–`z`，其余不写（读码确定，放行） |
| `transformfunction` | `"none"` | `none` / `sine` / `square` / `saw` / `triangle` / `simplexnoise` / `fbmnoise`，未知照报。4a 期间两种噪声照报 |
| `inputrangemin` / `inputrangemax` | 0 / 1 | `vec3splat`。差为 0 的分量换成 `FLT_EPSILON`；op 在这之上取 `rcp`（WPE 解析期 `rcpps`，这里执行时现算，好让近似运算包络覆盖到） |
| `outputrangemin` / `outputrangemax` | 0 / 1 | `vec3splat`，差不防 0 |
| `inputcontrolpoint0` / `outputcontrolpoint0` / `inputcontrolpoint1` / `outputcontrolpoint1` | 0 / 0 / 1 / 1 | `clampControlPoint`；`inputcontrolpoint1` 两个模块都不读，只计数 |
| `transforminputscale` | 2 | op 的 sine 用 `s·π`（解析期预乘，同样执行时现算） |
| `transformoctaves` | 3 | `asUInt32`，不钳制（4b 用） |
| `flags` | 1 | bit0 归一化后夹到 [0, 1]，bit1 输出区间后夹到 [0, 1]；别的位没有读者，中性 |
| blend 四键 | — | 只有 op（`BLEND`、`readBlend`，类型 0x27） |

- **新增** `particles/remap.ts`：
```ts
/** 枚举（rea 2.1 的名字表，下标就是 WPE 的属性编号；-1 是未知）。 */
export const REMAP_PROPERTIES: readonly string[]; // 20 个，lifetimefraction = 0 … layerorigin = 19
export type RemapKind = "init" | "op";
/** 一个粒子走一遍管线：读输入 → 分量 → 归一化 → 变换 → 输出区间 → 运算写回。init 的 slot 是新粒子，op 的是 [0, count) 里的每个槽。 */
export function remapParticle(kind: RemapKind, fields: ParticleFields, context: ParticleRunContext, slot: number, blend: number | null): void;
export function remapInitialValue(fields: ParticleFields, context: ParticleRunContext): void; // 对 context.slot 一次
export function remapValue(fields: ParticleFields, context: ParticleRunContext): void;        // [0, count) 每个槽（含死槽），有 blend 时按年龄算 b
```
  - **18 处变体**，逐条按 rea 第 2 节，逐步 float32；WPE 用近似指令的位置调 `rcp` / `rsqrt`：
    1. 输入 `lifetimefraction`：init 读 `frame` 列；op 是 `rcp(life)·age`。
    2. 输入 `size` / `opacity` / `color`：init 读初始值（`size0` / `alpha0` / `color0`），op 读当前值。
    3. 输入 `speed`：init `sqrt((x²+y²)+z²)`；op `sqrt((y²+x²)+z²)`。
    4. 输入 `distancetocontrolpoint`：同上，加法顺序不同。
    5. 输入 `positionbetweentwocontrolpoints`：两边都用 `ocp0` / `ocp1`。
       - init：`L > FLT_EPSILON` 时 `v = dot(P−A, D/L)/L`，否则 0；
       - op：`v = dot(P−A, D)·rcp(|D|²)`，`|D|² ≤ 0` 时 0，点积顺序 `(Py·Dy + Px·Dx) + Pz·Dz`。
    6. 输入 `particlesystemtime`：init 读系统时间 `St`，op 读场景时间 `T`（和 `runtime` 相同）。
    7. 输入 `controlpoint` / `deltatocontrolpoint` / `directiontocontrolpoint`：op 读 `C`、`C − P`、`(C − P)·rsqrt`（带掩码）；init 的写法归 4b。
    8. 输入 `angularspeed`：两边都是有角速度列时读 `angvz`，否则 0。
    9. 分量 `sum` / `average` / `max` / `min`：只在输入编号 > 12 时生效；加法顺序 init `(x+y)+z`、op `(y+x)+z`（逐位相同，照写）。
    10. 归一化：
        - init 三分量各自 `(in − min)/range`；
        - op 的向量输入是 `(in − min)·rcp(range)`；
        - op 的标量输入（编号 ≤ 12）只用 x 分量的 min 和倒数，夹完再铺到 y、z。
    11. `sine`：init `sin((v·π)·s − π/2)·0.5 + 0.5`；op `sin(v·(s·π) − π/2)·0.5 + 0.5`。两边乘法顺序不同，都用 `Math.sin`（CRT `sinf` / `sin_ps` 不复刻，同 P4a）。
    12. `square` / `saw` / `triangle`：init 用 `floorf`、`roundf`（半数远离零）；op 用 `trunc`、偶舍入。`saw` 的符号看缩放前的 `v`。
    13. 输出区间：init 三分量都算；op 只在输出是向量（编号 > 12）时算 y、z。
    14. 输出 `size` / `opacity` / `color`：init 写初始值，op 写当前值。
    15. 输出 `speed`：init 是 `L ≠ 0` 时 `s /= L`；op 是 `L > 0` 时 `s = rcp(L)·s`。
    16. 输出 `distancetocontrolpoint` / `positionbetweentwocontrolpoints` / `directiontocontrolpoint`：照 rea 2.7 表的两列（init 精确除法，op `rsqrt` 加掩码）。
    17. 运算：`remap` → `o`，`multiply` → `o·old`，`add` → `o + old`，`subtract` → `old − o`。op 有 blend 时是 `(op(old, o) − old)·b + old`，标量输出用 `o.x`。
    18. 列标志：op 输出 `opacity` 置 `COLUMN_FLAGS.alpha`，输出 `color` 置 `COLUMN_FLAGS.color`（`columnFlagsOf`）；init 不置。
  - **其余输出与输入：**
    - 输出 `maxlifetime` 写 `life`；`rotation` 写 z 旋转；`angularspeed` 要有角速度列；`position` / `velocity` / `deltatocontrolpoint` 按分量写。
    - 输入 `runtime` 读 `T`，`layertime` 读图层时间，`layerorigin` 读 `W.t`，`position` / `velocity` / `color` 读对应列。
- **修改** `particles/modules.ts` 的 `ParticleRunContext`：新增 `systemTime`（`St`）、`layerTime`、`origin`（`W.t`，Float32Array(3)）。
- **修改** `particles/system.ts`：
  - `step` 在模拟之前 `systemTime = f32(systemTime + dt′)`、`layerTime` 同样累加（`FUN_1402308a0` 开头 `0x1402308c2`；`0x140230810`），`advance` 写 `origin`；
  - `suspend` 在有存活粒子时两者清零（`FUN_14022f6c0`、`FUN_140230650`）；
  - 预热不累加（读码没追，见「未实测清单」）。
- **修改** `ParticleModuleDef` 新增 `controlPointRefs?(fields) → number[]`，`controlPointCount` 也认它（`particles/controlpoints.ts`）。remap 的规则（rea 2.1，`FUN_1401bc480` / `FUN_1401bc4a0`）：
  - 输入或输出属于 {7, 8, 16, 17, 18} 时计 `icp0`、`ocp0`；
  - 输入或输出是 8 时再计 `icp1`、`ocp1`。
- 能力表（`compile/features.ts`）不用改：进表后由模块表的 `supported` 报字段键。

### 4b — 噪声与写控制点

- **新增** `particles/fastnoise2.ts`：二维 Simplex、FBm，照 rea 2.9，逐步 float32、32 位回绕。步骤 0 的 Python 移植 `ignore/p4/d0/fastnoise2.py` 已和实测对上（rv-noise 三分量残差 ≤ 4e-4），照它和 rea 写。
```ts
export function simplex2(seed: number, x: number, y: number): number;
export function fbm2(seed: number, x: number, y: number, octaves: number): number; // 归一系数按 octaves 现算，≤ 1 时为 1
```
- **修改** `remap.ts` 的变换：
  - init 的 `simplexnoise` 是 `snoise1(v·s)·0.5 + 0.5`（`noise.ts`，P4b C1），输出是向量时 y、z 各自算；`fbmnoise` 是 `fbm1`：频率从 `s` 起每倍频 ×2、振幅 ×0.5，`Σ a·snoise1(f·v)/Σ a`，`octaves = 0` 时 0/0。
  - op 的是 `simplex2(seed, v·s, 0)·0.5 + 0.5` 或 `fbm2(…)`；种子 x 取 `R` 的位，y 是 `R ^ 0x0b3924ad`，z 是 `R ^ 0x493a8e83`；y、z 只在输出是向量时算。
- **修改** 写控制点：
  - 输出 `controlpoint`：
    - init 每个新粒子按出生顺序写一次；
    - op 每 4 个槽一组（含死槽），只有每组的 lane 0（槽 `4g`）生效，逐组读当前的 `C`、按分量运算后写回。
    - 不复刻的写坏：`t.w` 和 `previous` 的前两个 float 会被写坏，但没有模块读它们。
  - init 的输入 16–18：每个新粒子把 `cp[icp0].current` 的平移写成 0，输入是 0 / `0 − P` / `normalize(−P)`（rea 2.2，WPE 的 bug，实测确认）。本地系统不重算 `current`，所以一直是 0。
  - `ControlPointSet` 建系统时，对「输出是 `controlpoint` 的 remap」的 `ocp0` 置 `0x10000`：
    - `ControlPointSource` 已经带三类模块；
    - `ParticleModuleDef` 新增 `controlPointFlags?(fields) → [下标, 位][]`，remap 返回 `[[ocp0, 0x10000]]`。
- 放开 4a 期间照报的几项。

### 测试与回放

- **数据：** 步骤 0 的四份 remap 轨迹原是 draws 认法（`rdc_rope.py`），2026-11-10 用 `kbp rdc track` 按 points 认法重提，旧文件改名为 `*.rdc_rope.json`。fps 10 的 `[kbp]` 日志不满一行就没写出，缺帧用 `gap: "split"`。
- **单测：** 18 处变体各至少一个（两个模块同输入、给出不同结果）；`vec3splat`；`controlPointRefs`；`St` / 图层时间的累加与复位；4b 的 FastNoise2 已知值（取 `fastnoise2.py` 的输出）、种子异或、lane 0、`0x10000`、init 写 0。
- **回放案例 `d4`**（`ignore/p4/cases/`，做法同 `d3`）：
  - `p4d-remap` 与 `p4d-remap2` 的 fps 60（一遍）、fps 10（两遍），按槽序逐粒子比位置、尺寸、颜色、alpha、旋转；
  - 4a 只比 4a 放开的系统，4b 补上噪声与写控制点的系统；
  - `timeofday` 两组跳过，`unsupported` 写进期望；
  - 噪声组从 frame 列（`randomframe`，厚格式 `TEXCOORD1.w`）读出每粒子 `R`，按出生序注入（`r`）。
- **关注的已知差：** rv-time 的 alpha 在步骤 0 差 0.0006，量级正是 `rcpps(10)` 的近似，应落在包络里。

**验收（Claude）：**
- `git status` 查越界；tsc、vitest、Prettier、回放自跑；`kbp regress` 现有案例逐字节相同。
- **变异检查：** 每处变体各一条（op 的 `lifetimefraction` 读 frame、op 的 `particlesystemtime` 读 `St`、init 读 `T`、op 标量输入按分量归一化、op 用 `floor`、init 用 `trunc`、op 写初始列、输出区间 y/z、blend 公式、`flags` bit0 不夹）。4b 另加：
  - 种子异或常数对调、FBm 不加种子、init 噪声用 `R`；
  - 控制点每个 lane 都写、不置 `0x10000`、init 不写 0。
- **语料：**
  - 4a 后 `remapvalue` / `remapinitialvalue` 的模块键去掉，只剩噪声的字段键；
  - 4b 后 3815289650、3832133196 都不再报 remap 的键。原来写的「3815289650 只剩 `particle:children`」不对：它另有文字对象（`object:*`）和一处着色器解析错误（4a 语料核对时查到）；`remapinitialvalue` 只在 3832133196 的子系统文件里，子系统不编译，两边都不报；
  - 能渲染数、覆盖数不变（「范围与解锁」表里步骤 4 是 0）。
- 画面哈希不变：10 张干净场景、三档。
- **做法：** 同步骤 3，`kbp snapshot` 出 `ignore/p4/d4/head` 与 `ov`，子代理只在 `ov` 里做，出补丁后按块暂存、只提交自己的。

### 步骤 4a 实施记录（2026-11-10）

**做法：**
- 快照取自 `6a3c3854`，子代理只在 `ignore/p4/d4/ov` 里做。补丁是 `ignore/p4/d4/step4a.patch`，6 个文件，+1927 / −12。
- 开工期间 HEAD 前进到 `ff100954`（P5a 的提交），都没碰补丁里的文件，`git apply --check` 对工作区和索引都干净。
- 回放用的轨迹：步骤 0 的四份 remap 轨迹按 points 认法重提（见「测试与回放」）。

**新增和修改的文件（相对 `apps/wpe-scene/src/`）：**
- 新增 `particles/remap.ts`（文件头列 18 处变体）和 `particles/remap.test.ts`（44 个单测）；
- 修改 `particles/modules.ts`、`particles/system.ts`、`particles/controlpoints.ts`；
- `compile/particles.test.ts` 只改期望值。
- 补丁之外：回放案例 `ignore/p4/cases/d4.json` + `d4.hook.ts`，变异清单 `ignore/p4/d4/mutations.py`，Claude 另加的 `ignore/p4/d4/mut_claude.py`。

**对照汇编补清的读码（rea 第 2 节没写细的，子代理逐段核对 `init15.asm`、`op19.asm`、`op19b.asm`）：**
- op 的变换和输出区间一样，y、z 只在输出是向量时算。
- 掩码因输出而异：`distancetocontrolpoint`、`positionbetween` 用 `L ≠ 0`（NaN 也算不等，粒子正好在控制点上时位置得 NaN，WPE 同样）；`directiontocontrolpoint` 用 `0 < L`。
- init 的 `positionbetween` / `direction` 输出在 `L ≤ FLT_EPSILON` 时不做除法，不是跳过不写。
- 未知 `operation` 返回旧值，复合输出照样往下算；blend 也包在复合输出外面。
- `deltatocontrolpoint` / `directiontocontrolpoint` 输出只对选中的分量运算，位置三分量无条件写回。
- op 的 `s·π` 在执行段开头算（`0x14024498e`），不是解析期。

**规格之外自定的：**
- 执行上下文的三项新字段是可选的，缺省按 0。
- `timeofday` 和未知输入读成 0；它们照报，不影响能渲染的场景。
- `vec3splat` 对布尔、非数字字符串照报，比 WPE 的 `asFloat` 严。
- **op 的输出 `maxlifetime` 照报、不执行**（Claude 复核后改）：
  - WPE 的 op 按 4 个一组写到组尾，把死槽写回非零 `life`，存活数（无符号）下溢后不再发射。这是回放里看到的数据形状：每帧只有一个真实粒子，另有带垃圾值的槽。
  - 我们的存活数会变负、照常发射，行为两样，又复刻不了。语料 0 处用到；init 的 `maxlifetime` 照常支持。

**回放里的两处处理（`d4.hook.ts`）：**
- **fps 10 日志缺帧：** 日志只到第 150 帧，151–156 帧没有 dt，按平分时 `rate 2` 的两个系统超限。改用 `ri-time` 出生尺寸反解出生帧的系统时间（系统时间 = 2 × 场景时间）补出各帧的时间。
  - 日志帧上的核对：系统时间 / 2 和日志的差 2.5e-6。
  - 缺帧里出生的 `ri-time` 粒子按构造就对得上，不算独立验证；同段别的系统是独立的。
- **`rv-saw` / `rv-square` 新生粒子落在间断点上：**
  - 年龄 0 时 `v = (0 − 0.5)·rcp(0.5)` 正好是 −1。精确倒数下 saw 得尺寸 40；WPE 的 `rcpps(0.5) = 1.99951…`，得 5.0256。
  - 这些粒子改按「rcp 偏置 −2⁻¹²」重模拟（在 2 的幂上正好等于 `rcpps`），和 WPE 逐位相同。
  - 产品按「近似倒数不复刻」不改：只影响新生粒子的第一帧，且只在输入区间让 `v` 正好落在整数上时出现。

**验收结果：**

| 项目 | 结果 |
|---|---|
| 越界 | `apps/` 里补丁的文件没被动过；工作区另有并行会话改的 `particles/colorn.test.ts` 等 4 个文件（22:53 改，把噪声表来源挪进 `apps/wpe-scene/scripts/fixtures`），不在补丁里。`head` 快照和 `6a3c3854` 逐文件相同 |
| tsc、vitest、Prettier | Claude 自跑：tsc 0 错；53 个文件、1461 个用例全过；Prettier 8 个文件通过 |
| 回放 `kbp replay d4`（Claude 自跑两次） | 四段全部通过，最大差/限：`p4d-remap` fps 60 0.79、fps 10 0.77；`p4d-remap2` fps 60 0.65、fps 10 0.64。<br>`p4d-remap` 比 19 个系统，`p4d-remap2` 比 58 个；不比的是 4b 的几组、两个 `timeofday`、op 的 `maxlifetime`。编译不支持项和期望精确相等。<br>rv-time 在步骤 0 差 0.0006 的那条，落在近似倒数包络里 |
| 回归 `kbp regress --corpus`（Claude 自跑） | 现有 9 个案例（b3、b4、b6、c1–c4、d1、d3）两边逐字节相同。<br>语料 152 张：只去掉两张的 `particle:operator:remapvalue`，3815289650 新增噪声的字段键；干净 24 不变，出错 0 |
| 变异检查 | 子代理 21 条全部检出（单测加回放 12 条，只有单测 9 条），源码按原字节还原。<br>Claude 另加 2 条（正弦去掉 −π/2；init 的输入 `size` 读当前值列），单测和回放都检出 |

**4a 里只有单测、没有 WPE 数据验证的**（已收进「未实测清单」）：
- op 标量输入按 x 分量归一化：rv-vec 的 `flags 1` 把两种写法都夹成 1；
- init 的 `floor` 对 `trunc`：`ri-*` 新生粒子的 `t = −3` 是整数，两者相同；
- 输出 `speed` 的除法写法、正弦的乘法顺序、`distance` 的掩码：只差 1 ulp，或要粒子正好在控制点上。

### 步骤 4b 实施记录（2026-11-11）

**做法：**
- 快照取自 `50d2e9c0`（4a 的提交），子代理只在 `ignore/p4/d4b/ov` 里做。补丁是 `ignore/p4/d4b/step4b.patch`，8 个文件，+1073 / −76。
- 开工期间 HEAD 前进到 `4dd05464`（别的会话的提交），补丁涉及的文件没人改过，`git apply --check` 对工作区和索引都干净。
- 回放案例 `d4` 扩充成 4b 版（4a 版备份在 `ignore/p4/d4b/*.4a`），变异清单 `ignore/p4/d4b/mutations.py`，Claude 另加 `ignore/p4/d4b/mut_claude.py`。

**新增和修改的文件（相对 `apps/wpe-scene/src/particles/`）：**
- 新增 `fastnoise2.ts`（`simplex2`、`fbm2`、`fractalBounding`）、`fastnoise2.test.ts`、`remap4b.test.ts`；
- 修改：
  - `remap.ts`：两种噪声、写控制点、init 的输入 16–18、`remapControlPointFlags`；
  - `noise.ts`：新增 `fbm1`，即 `FUN_14027b4b0`；
  - `modules.ts`：`ParticleModuleDef.controlPointFlags`，remap 读的列加上 `random`；
  - `controlpoints.ts`：建系统时把模块要求的位并进控制点的 `flags`；
- `remap.test.ts` 只改期望：4a 期间照报的几项改成照常执行。

**对照汇编补清的读码：**
- **FBm**（`fbm2_sse4.asm` 逐条核对）：
  - 循环次数按无符号比较；
  - 每层依次是坐标 ×2、种子 +1、`amp·(((n+1)·0.5 − 1)·0 + 1)·0.5`、`sum += n·amp`；
  - weighted strength 那一步照写，`n` 非有限时得 NaN。
- **init 的 `fbm1`**（`0x14027b4b0`）：调用方传 `{频率 s, 振幅 1, 倍频 2, 增益 0.5}`，结果是 `Σ snoise1(f·v)·a / Σ a`。y、z 分量只在输出是向量时才算。
- **lane 0：**
  - op 每组读一次 `C`，三个分量各自 `shufps 0` 广播后写回，只有槽 `4g`（`4g < count`）生效，死槽也算；
  - blend 版同样是 `(op(C, o) − C)·b + C`。
- **`0x10000` 的点：** 初值仍是 `base = I + offset`（rea 2.8）。`add` 运算时 offset 是起点，规格里「offset 不起作用」只对 `remap` 运算成立，照读码做。
- **init 的输入 `directiontocontrolpoint`：** 粒子在原点时 `normalize(0)` 得 NaN，和 WPE 实测相同（ri-in-directiontocontrolpoint 的尺寸是 NaN）。

**规格之外自定的：**
- **`transformoctaves` 不钳制、最大到 2³²：** `fbm2`、`fbm1` 和归一系数遇到两种情况提前停下，否则会卡死：
  - 和已经是 NaN；
  - 振幅下溢成 0，且坐标或频率为 0。

  提前停下和照常走完逐位相同，单测拿朴素循环在 octaves 600 / 700 时核对过。
- `REMAP_CONTROL_POINT_FLAG = 0x10000` 在 `remap.ts` 里另写一份，避免 `modules → remap → controlpoints` 成环，由单测核对和 `CONTROL_POINT_FLAGS.remap` 相等。

**回放（`d4.hook.ts`）里新加的处理：**
- **R 的注入：** 先照常模拟一遍得到每个槽的出生序号（R 不影响寿命和槽位分配），按序号从 frame 列（厚格式的 `TEXCOORD1.w`）收集 R，再按出生序注入。核对过同一序号各帧的值一致。
- **近似倒数的拟合：**
  - 只用 rv-noise 的速度（108 个分量），拟合一个标量：remapvalue 里 `rcp` 的相对偏置 b。fps 60 得 −2.4440e-4，fps 10 得 −2.4418e-4。两次独立抓帧一致，约等于 −2⁻¹²，`rcpps(1)` 已知就是 1 − 2⁻¹²。
  - 用这个 b 去比 rv-fbm1 / rv-fbm3：它们没参与拟合，所以是独立验证。
  - 发射器的近似倒数另开一份包络，和 remap 的分开偏置。
  - 速度另加输入精度包络：日志的 dt 只有 6 位小数。
- **为什么要拟合：** 输出 `speed` 是 `vel·rcp(L)·o`，`o < 0` 时速度反向。一遍模式下，方向等于各帧 `o` 的符号之积；`o` 过零的那一帧，符号取决于 `rcpps` 和精确倒数的差。
  - 精确倒数下，fps 60 有 6 个粒子·帧和 WPE 整段反向；拟合后是 0。
  - 两遍模式每帧乘两次，符号抵消，所以 fps 10 不受影响。

**验收结果：**

| 项目 | 结果 |
|---|---|
| 越界 | 补丁涉及的 `apps/` 文件从 `50d2e9c0` 起没人改过；工作区另有并行会话（P5a 步骤 4）改的 `particles/simulator.test.ts`、`track.ts`，不在补丁里。`head` 快照和 `50d2e9c0` 逐文件相同 |
| tsc、vitest、Prettier | Claude 自跑：tsc 0 错（钩子另查 0 错）；57 个文件、1562 个用例全过；Prettier 通过 |
| 回放 `kbp replay d4`（Claude 自跑） | 四段全部通过：`p4d-remap` 26 个系统、`p4d-remap2` 63 个。<br>4b 新比的系统差/限都 ≤ 0.70：rv-noise、rv-fbm1、rv-fbm3、ri-noise、ri-fbm、rv-cpout、ri-cpbug，以及 remap2 的输入 16–18、输出 `controlpoint`。<br>ri-in-controlpoint 尺寸 5、ri-in-deltatocontrolpoint 尺寸 60，正好证明 init 读的是 0（按 C 读会是 32.5 / 58.2）。<br>FBm 的倍频细节验证了，步骤 0 没能区分的这一项从「未实测清单」划掉 |
| 回归 `kbp regress --corpus`（Claude 自跑） | 现有 9 个案例两边逐字节相同。<br>语料 165 张（别的会话加了场景、干净数涨到 36），只有 3815289650 去掉 `particle:operator:remapvalue:transformfunction`，不新增键，出错 0 |
| 变异检查 | 子代理 44 条：42 条检出，2 条是等价变异（y、z 多算了没人读；哈希右移只差高位、梯度只读低 3 位）。<br>只靠单测检出的：控制点每个 lane 都写（rv-cpout 的输入各槽相同）、不置 `0x10000`（rv-cpout 的点本来就不重算）。<br>Claude 另加 2 条（init 不把控制点写成 0；梯度常数改 2e-4），单测和回放都检出 |

**和 WPE 不同、按「近似倒数不复刻」接受的：**
- 一遍模式下，`remapvalue` 输出 `speed` 且区间跨 0 时，个别粒子在 `o` 过零的那一帧会和 WPE 符号相反，之后整段反向运动。
- 语料里 3815289650 有一处这样的写法（`fbmnoise`、区间 −5..7）。这些是噪声驱动的粒子，统计上看不出区别，但逐粒子和 WPE 对不上。

## 步骤 5 — 距离类与 `vortex_v2`

**设计。** 四个都是普通 operator，只改位置或速度，各自照 rea-p4d-modules 第 3、4 节写。新东西只有两处：
- 两个 maintaindistance 模块第一次读控制点的 `previous`；
- `vortex_v2` 的切向项乘 `k`，不是 `h`（步骤 0 实测，球形、柱形逐粒子差 ≤ 1.4e-3）。

`previous` 只在帧尾更新（`ControlPointSet.endFrame`，已有），两遍模式下每遍都看到同一个 `Δcp`，一帧平移两次。这是 WPE 的行为（步骤 0 的 md-move 在 fps 10 下以两倍速跟随），按现在的结构自然得到，不用特意做。

读 `previous` 带出 `suspend` 的问题。现在对象不可见时既不更新控制点，也不拷 `previous`。重新可见的第一帧，`Δcp` 就是整段隐藏期间的位移，粒子会被一次拽过去。WPE 不可见时照常更新控制点（rea-p4c-sim 5.6，读码），所以改成：
- 不可见的每一帧都按当帧的 `W` 更新控制点、帧尾拷 `previous`；
- 清空粒子的条件不变（有存活粒子时才清）。

步骤 0 的 dist-hide 没测到这一条（重新可见 1 s 后才发出第一个粒子），本步重做实验。

近似指令（`rsqrtps`、`rcpps`）照「近似倒数不复刻」用产品已有的 `rsqrt` / `rcp`，回放挂近似运算包络。`vortex_v2` 带 `centerforce` 时误差被 `|P′|/h` 放大（步骤 0 估的包络 1.3–2.2），要看包络够不够。

**语料**（`ignore/p4/d0/out/scan.txt`）：
- `reducemovementnearcontrolpoint` 12 个，都在 3832133196：`controlpoint 1`、`distanceinner 20`、`distanceouter 50`、`reductioninner 1000`；
- `maintaindistancebetweencontrolpoints` 6 个，都在 3832133196，全用缺省；
- `maintaindistancetocontrolpoint`、`vortex_v2` 各 1 个，在 kabegame-sample 的 `magic_vortex_orb`：
  - `vortex_v2`：`flags 2`、`distanceinner 0`、`distanceouter 1`、`speedinner 0`、`speedouter 2500`；
  - 那个系统的 `controlpointangle1` 是关键帧，另报 `value:animation`，不归本步。

**现状锚点：**
- **四个模块不在表里**（`particles/modules.ts` 的 `PARTICLE_MODULES`）：能力表照报 `particle:operator:<名字>`；
  `controlPointCount` 不数表外模块（`particles/controlpoints.ts:128`）。
- **`vortex` 已在表里**（P4b），`vortex_v2` 是另一个模块，不共用执行函数（公式不同：`vortex` 不读控制点 3×3、没有环形分支）。
- **不可见时什么都不做**（`render/scene.ts` 的 `stepParticles`）：
```ts
if (state && !effectiveVisible(draw.object, state.layers)) {
  if (particles.system.suspend()) particles.stale = true; // 现状：不传 W，控制点不更新、不拷 previous
  continue;
}
```
```ts
suspend(): boolean {
  if (this.alive === 0) return false; // 现状：没有粒子时直接返回
  // …复位 emitter 计时、模块状态、系统时间与图层时间，clear()
}
```

### 点 1 — 四个 operator（`particles/distance.ts`，新增）

字段表照 rea 3.1–3.3、第 4 节。缺省值分正交 / 透视的写成 `num({ orthographic, perspective })`；blend 变体用现成的 `BLEND` / `readBlend`。

| 模块 | 字段（缺省 正交 / 透视） | 要点 |
|---|---|---|
| `maintaindistancetocontrolpoint`（op 11，blend 0x21） | `distance` 200 / 1、`variablestrength` 0、`controlpoint` 0 | `s` = 1（`variablestrength` 精确等于 0）或 `clamp01(vs·h)`（NaN 得 0）；先平移 `Δ = current.t − previous.t`；`T = inverse(mat3(current))`（glm：`1/det` 后乘伴随阵）；`f = (rsqrt(\|u\|²)·distance − 1)·s`，blend 只乘 `f` |
| `maintaindistancebetweencontrolpoints`（op 12，blend 0x22） | `controlpointstart` 0、`controlpointend` 1 | 两个点的 current 和 previous 都读；`n` 或 `np` ≤ 2⁻⁴⁶（`0x28800000`）时整条跳过；比例 `clamp01(t·qp)·L`；垂直偏移不转 |
| `reducemovementnearcontrolpoint`（op 13，blend 0x23） | `distanceinner` 100 / 0.5、`distanceouter` 350 / 1、`reductioninner` 100、`reductionouter` 0、`controlpoint` 0 | 只改速度：`vel *= 1 − clamp01(r·h)`；`distanceouter == distanceinner` 时倒数存 1.0；`reductionouter == reductioninner` 时差存 1.0（WPE 的 bug，照做）；`n = 0` 时 `t = 1`（`minps` 的 NaN 取第二个操作数） |
| `vortex_v2`（op 16，blend 0x25） | `distanceinner` 500 / 1、`distanceouter` 650 / 2、`speedinner` 2500 / 1、`speedouter` 0、`centerforce` 1、`ringradius` 300 / 1、`ringwidth` 50 / 0.2、`ringpulldistance` 50 / 0.25、`ringpullforce` 10 / 0.05、`axis` `"0 0 1"`、`flags` 0（只存低 8 位）、`controlpoint` 0 | 两个速度乘 `instanceoverride.speed`（条目 7，系统 `flags` bit4 时不乘）；`axis` 的 `(x²+y²)+z² < 0.001` 时取 (0, 0, 1)，否则精确归一化；轴乘 `current` 的 3×3（不再归一化）；切向 `(r̂ × a)·spd`，`spd` 已乘 `k`；`centerforce` 只在 `flags & 2` 时读，系数 `cf/h`（精确除法）；环形（`flags & 4`）的 `ringwidth`、`ringpulldistance` 占内外距离的槽，`ringpulldistance` 为 0 时倒数存 1.0；`audioprocessing` 的 `mode ≠ 0` 照报 `…:audioprocessing`（P4e） |

- 公式逐步 float32，加法顺序照 rea（例如 `n = (r.y² + r.x²) + r.z²`），WPE 用 `rsqrtps` / `rcpps` 的位置调产品的 `rsqrt` / `rcp`。
- 每遍处理 `[0, count)` 的全部槽（含死槽），同现有 operator。
- `columns`：maintaindistance 两个是位置；`reducemovement` 是位置、速度；`vortex_v2` 是位置、速度。有 blend 时加 `age`、`life`。

### 点 2 — 模块表（`particles/modules.ts`）

- **新增** 四项，`run` 指向点 1 的函数，`normalize` 钳控制点下标（`clampControlPoint`）。
- `controlPointCount` 因此自动计入它们的控制点（字段名 `controlpoint` / `controlpointstart` / `controlpointend` 已认）。核对：`maintaindistancebetweencontrolpoints` 不写字段时也计 0、1 两个点（按缺省值算）。

### 点 3 — 不可见时更新控制点（`particles/system.ts`、`render/scene.ts`）

```ts
/**
 * 不可见的一帧：按当帧的 W 更新控制点、帧尾 previous ← current（rea-p4c-sim 5.6，P4d 步骤 5，新增）；
 * 有存活粒子时照旧清空并复位（返回 true）。
 */
suspend(inputs: ControlPointInputs = IDENTITY_INPUTS): boolean {
  this.controlPoints.update(inputs);   // 新增
  this.controlPoints.endFrame();       // 新增
  if (this.alive === 0) return false;
  // …其余不变
}
```
- 渲染器不可见的分支照可见时的算法算 `world` 与 `pointer`，传给 `suspend`。
- 只改控制点。系统时间、图层时间、不可见期间发不发射，仍按现状（见「未实测清单」），本步的新实验顺带看。
- dev 探针、`kbp` 回放里调 `suspend` 的地方一起改（回放钩子自己传 `W`）。

### 测试与回放

**新工程 `p4d-dist2`**（`ignore/p4/defs/p4d5.py`，`kbp gen`），补「未实测清单」里归本步的两项，另顺带看两项：

| 系统 | 设置 | 验什么 |
|---|---|---|
| `hide-r` | 世界系统，`maintaindistancetocontrolpoint` 读 1 号点（`offset (200, 0)`、`variablestrength 0.001`），`rate 20`；对象匀速右移、每 10 s 的 [7, 8) 隐藏 | 重新可见的第一帧就有粒子：控制点不可见时照常更新，那个粒子只多平移一帧的 `Δcp`；不更新则多平移约 20 像素 |
| `hide-ref` | 同上，不隐藏 | 对照 |
| `rm-eq2` | `reducemovement` `reductioninner = reductionouter = 2`，粒子以 100/s 远离 1 号点 | 差存 1.0 时 `r = 2 + t`（远处 3），按 0 实现是 2：速度衰减 `e^(−3t)` 对 `e^(−2t)`，最终走过 33 对 50 像素 |
| `rm-ref2` | 同上，`reductionouter` 0 | 对照 |

- 顺带看（钩子里两种取法都跑、只报告）：可见性按上一帧还是本帧的脚本生效（`rate 20` 时切换帧上的出生数会差一）；WPE 不可见期间照不照常模拟（照常的话，最后一个不可见帧发出的粒子会活到可见）。
- 抓帧用 wpe-renderdoc MCP 的 `capture_sweep`：fps 60、fps 10 各一轮（改 `fps` 要 `restart_wpe`，有别的会话的窗口时会被拒，到时再说），1920×1080 窗口，`log_dir` 写 `ignore/p4/out`。

**数据：**
- 步骤 0 的 `p4d-dist` 两份轨迹是 draws 认法，用 `kbp rdc track --points` 重提，旧文件改名 `*.rdc_rope.json`（同步骤 4）。fps 10 的日志不全，缺帧用 `gap: "split"` 或钩子补。
- 新工程的轨迹照常提。

**回放案例 `d5`**（`ignore/p4/cases/`，做法同 `d3`、`d4`）：
- `p4d-dist` fps 60 / 10、`p4d-dist2` fps 60 / 10，按槽序逐粒子比位置、尺寸。
- 钩子：
  - 脚本驱动的对象按上一帧的 `engine.runtime` 算 `W`（同 c4、d3）：`md-move`、`md-move-ref`、`dist-hide`、`hide-r`、`hide-ref` 的 `x = 300 + 20·T`；`mb2-move` 平移加绕 z 旋转（脚本里是度）；
  - `dist-hide`、`hide-r` 的隐藏帧调 `suspend(inputs)`，同 d3；
  - 变体（只报告或要求超限）：不可见时不更新控制点（应在 `hide-r` 上超限）、可见性取本帧、不可见期间照常模拟。
- 不比的：`ma-*` 以外没有随机方向的问题，全比；`v2-*` 的 `centerforce` 组要是超包络，先看是不是近似倒数，再定。

**单测：**
- 四个模块各自的公式（含 blend）、缺省值、`flags` 各位；
- 两个 WPE 的 bug（`distanceouter == distanceinner` 存 1.0、`reductionouter == reductioninner` 存 1.0）；
- `vortex_v2`：乘 `k` 不乘 `h`、`r̂ × a` 的方向、轴乘控制点 3×3、环形拉力的符号与环带内为 0；
- 两遍模式下 maintaindistance 平移两次 `Δcp`；
- `suspend` 更新控制点、拷 `previous`，没有粒子时也做。

**验收（Claude）：**
- `git status` 查越界；tsc、vitest、Prettier、`kbp replay d5` 自跑；`kbp regress --corpus` 现有案例逐字节相同。
- **变异检查：** `Δcp` 方向反了、`variablestrength` 不钳制、`T` 不求逆、between 只读一个点的 previous、两个 bug 不复刻（各一条）、`vortex_v2` 乘 `h`、切向方向反、轴不乘 3×3、环形拉力符号反、`suspend` 不更新控制点。
- **语料：** 四个模块的键去掉；3832133196 只剩它别的键（子系统等），kabegame-sample 不再报这四个模块；能渲染数、覆盖数按「范围与解锁」表（步骤 5 是 0）。
- 画面哈希不变：干净场景、三档。
- **做法：** 同步骤 3、4，`kbp snapshot` 出 `ignore/p4/d5/head` 与 `ov`，子代理只在 `ov` 里做，出补丁后按块暂存、只提交自己的。

### 步骤 5 实施记录（2026-11-11）

**数据：**
- 快照取自 `bafb4a93`（`ignore/p4/d5/head`、`ov`），开工时工作区 `apps/` 没有并行改动。
- `p4d-dist` 的两份轨迹按 points 重提，旧文件改名 `rd-p4d-dist-fps*.rdc_rope.json`。
- 新工程 `p4d-dist2`（`ignore/p4/defs/p4d5.py`），wpe-renderdoc MCP 的 `capture_sweep` 抓 fps 60 / 10 各 10 帧，在 `A:\p4d\p4d-dist2-fps*`。
  - 隐藏窗口先按绝对时刻（每 20 s 的 [12, 13)）设计，两次都落空：加载耗时不稳，一次抓帧时场景时间 17.8 s（重新可见那帧的粒子已死），一次 12.1 s（正在隐藏）。改成周期的「每 5 s 隐藏最后 1 s、寿命 4.5 s」后一次抓到。
  - WPE 的 `fps` 由 MCP 改成 60 / 10 再改回测前的 20；`config.json` 的哈希和测前相同（`4a4c71fd…`）。fps 10 的日志照旧不全。
- **新实验的直接读数**（回放之前，按对象位置粗看）：
  - 不可见时控制点照常更新：`hide-r` 的粒子相对对象的偏移是连续的一串（fps 60：100.12–100.32；fps 10：103.7–149.6，每帧约 2），没有多出 20 像素（两遍 40）的离群点。重新可见那一帧有没有粒子出生，由回放确认。
  - `reductionouter == reductioninner` 时差存成 1.0：`rm-eq2` 两种 fps 都停在 x ≈ 33.33 = 100/3，即 `r = 3`；按 0 实现会停在 50。

**实现：**
- 子代理只在 `ignore/p4/d5/ov` 里做。补丁 `ignore/p4/d5/step5.patch`，9 个文件，+1066 / −24（相对 `apps/wpe-scene/src/`）：
  - 新增 `particles/distance.ts`（`inverseBasis` 与四个执行函数）、`particles/distance.test.ts`（30 个用例）；
  - 修改 `particles/modules.ts`（模块表四项）、`particles/system.ts`（`suspend(inputs)` 先更新控制点、拷 `previous`，再看有没有粒子）、`render/scene.ts`（不可见分支照可见时的算法算 `W` 与跟随点）；`particles/controlpoints.ts` 只改注释；
  - 三个测试只改期望：原来拿 `reducemovementnearcontrolpoint` 当表外模块的例子，换成 `boids`。
- 补丁之外：回放案例 `ignore/p4/cases/d5.json` + `d5.hook.ts`，变异清单 `ignore/p4/d5/mutations.py`，Claude 另加的 `ignore/p4/d5/mut_claude.py`。
- 开工期间 HEAD 前进到 `74b65d27`（文档提交）；工作区另有并行会话（P6a 声音、P5a 收尾的 kbp-tools）改的文件，都不在补丁里，`git apply --check` 干净。

**对照汇编补清的读码（rea 第 3、4 节没写细或写错的）：**
- `FUN_1401d8df0` 的钳制让 NaN 原样通过（`maxss` / `minss` 取第二操作数），不是 rea 写的「NaN → 0」。
- `inverse` 的运算顺序逐条照 `FUN_140228b00`：三个余子式、`det = (A·m0 − B·m3) + C·m6`、`1/det` 用 `divss`、余子式先取反再乘。
- between：跳过的判定是 lane 0 的 `comiss`，NaN 也跳过；blend 乘的是整段增量 `((s·D̂ − t·D̂p) + ΔA)·b`。
- `vortex_v2`：
  - 轴的归一化是 `axis·(1/sqrtss)`，舍入两次，不是 rea 写的「精确归一化」；
  - 轴变换用完整 4×4、`w = 0`；
  - 环形的 blend 是 `spd·b` 与 `(c₀ + pull)·b`（rea 没写）；拉力的符号是把 `e` 的符号位或上去；
  - `n = 0` 或 `|P′| = 0` 时照 WPE 写 NaN，不像 `vortex` 那样跳过。
- `audioprocessingmode` 进字段表，只支持 0，非 0 照报 `…:audioprocessingmode`（P4e）；另外四个 `audioprocessing*` 键中性。

**回放 `d5`（Claude 自跑，和子代理的报告逐项相同，四段全部通过）：**
- 逐帧比较通过的，差/限都 ≤ 0.77：`md-soft`、`md-move`、`md-move-ref`、`mb2-move`、`mb2-same`、`rm-basic`、`rm-eq`、`v2-sphere`、`v2-cyl`、`v2-axis`、`dist-hide`，两种 fps；`hide-r`、`hide-ref`、`rm-eq2`、`rm-ref2`，两种 fps。
- **改成只报告、另做单步核对的：** `md-hard`、`md-scale`（两种 fps，差/限 2.2–4.0，绝对差 0.04–0.09 像素），fps 10 的 `v2-ring-in`、`v2-ring-out`（4.5、1.2）。
  - 原因：WPE 的 `rsqrtps` 误差随输入逐帧变化（md-hard 的半径在 200 上下 ±2.6e-4 相对误差），在把粒子拉回半径的系统里是随机游走；近似运算包络是常量偏置，界不住。
  - 单步核对：每个抓帧把粒子换成 WPE 上一帧的状态、步进一帧再比，全部通过（位置差/限 ≤ 0.70；`vortex_v2` 比速度，差/限 ≤ 0.43）。
  - `mb2-move` 两次 `rsqrtps`（`q`、`qp`）的误差可以一正一负，钩子另加「按调用奇偶交替 ±」两个包络变体后 fps 10 的单步通过。
  - `v2-center`、`v2-ring-*` 在 fps 60 的逐帧包络有上百像素，逐帧比较等于没比，真正起作用的是单步核对。fps 10 的两遍模式下位置反推不出速度（非厚格式没有速度列），两个 ring 组只报告，依据是 fps 60 的单步核对和两种 fps 下相近的绝对差。
- **缺帧：**
  - `p4d-dist` fps 10 缺 151–156 帧，平分最好；
  - `p4d-dist2` fps 10 缺 101–124 帧，钩子按 `hide-ref` 的出生组位置、`rm-ref2` 的锚点和逐帧出生数用加权最小二乘反推场景时间，组残差 RMS 4.7e-3 像素。`hide-r` 的出生数参与了反推，它的位置没参与。
- **三个变体：**
  - **不可见时不更新控制点：** `p4d-dist2` fps 10 的 `hide-r` 超限 1156 倍，钉住了「WPE 不可见时照常更新控制点」。fps 60 那段发射器复位后第 3 帧才有粒子出生，`dist-hide` 两段同样如此，区分不了，钩子自动只报告。
  - **可见性取本帧的 runtime：** 四段都更差（`dist-hide` 差/限 1.05、53.9，`hide-r` 2.80，fps 10 有 10 帧粒子数不同），按上一帧取是对的。
  - **不可见期间照常模拟发射：** 四段的粒子数都对不上（6、6、8、10 帧），WPE 不可见期间不发射（或最后一个不可见帧发出的粒子活不到可见）。

**验收结果：**

| 项目 | 结果 |
|---|---|
| 越界 | 补丁 9 个文件，工作区里没人改过；`apps/` 里并行会话的改动都不在补丁里 |
| tsc、vitest、Prettier | Claude 自跑：tsc 0 错（钩子另查 0 错）；59 个文件、1622 个用例全过；Prettier 9 个文件通过 |
| 回放 `kbp replay d5` | 见上，四段全部通过 |
| 回归 `kbp regress --corpus` | 现有案例两边逐字节相同，只有 `d5` 不同（head 里没有这四个模块，预期）。<br>语料 165 张、干净 36 不变、出错 0：3832133196 去掉 `maintaindistancebetweencontrolpoints`、`reducemovementnearcontrolpoint`；3585875739 去掉 `vortex_v2`，新增 `vortex_v2:audioprocessingmode`（两个粒子文件都是 mode 3，照报正确）。kabegame-sample 另扫：只去掉 `maintaindistancetocontrolpoint`、`vortex_v2` |
| 变异检查 | 子代理 17 条全部检出：只靠单测的 3 条（`variablestrength` 不钳制、`distanceouter == distanceinner` 不存 1.0、`flags` 不截低 8 位，回放的参数碰不到）。<br>Claude 另加 2 条（`suspend` 不拷 `previous`、环形拉力乘 `k`），单测和回放都检出 |
| 合并后（2026-11-11，用户同意合并后做） | 补丁打进工作区（工作区另有 P6a 声音、P5a 收尾的未提交改动，和补丁不重叠）。<br>tsc 0 错；vitest 64 个文件、1691 个用例全过（含并行会话的新测试）。<br>`kbp regress --src d5/head --src apps/wpe-scene/src --corpus`：回放案例只有 `d5` 不同；语料里本步的变化同上，其余（去掉 `object:sound` 等、新增 `script:api:layer.*`、`sound:volume:script`）是 P6a 的未提交改动 |
| 画面哈希 | `hash_baseline` 按 `ignore/p5/cur/out/hash-after.json` 的 10 张场景 × 3 档。<br>撤掉补丁重建宿主（`index-DJgn3uDz.js`）量 `ignore/p4/d5/out/hash-before.json`；打回补丁重建（`index-CkqkbydK.js`）量 `hash-after.json`。<br>`hash_compare` 全部相同。dev 宿主已按合并后的工作区重新构建（`--mode development`） |

## 未实测清单（P4d 收尾统一走查）

各步按读码实现、但没有实测核对的项，汇总在这里，2026-11-10 用户定：P4d 收尾统一走查。每项写清现状、为什么没测到、怎么补。后面的步骤补测了就在这里标「已测」。

**等后面的步骤回放覆盖：** 步骤 5 做完后已经没有了（都移到下面的「已测」）。

**要重新抓 WPE 才能补：**

| 项 | 来源 | 现状与原因 | 怎么补 |
|---|---|---|---|
| rope 绳没满时 `Rf = min(fps, R)`（R9） | 步骤 0 | 两种 fps 下抓帧时绳都已满 | 抓加载后头几百毫秒、或一个 `rate` 高而 `maxcount` 大到永远不满的系统 |
| ropetrail 预热后历史塌缩到当前位置（T7） | 步骤 0、2 | T7 的设计里预热期间根本不出粒子（满容量冻结发射计时），WPE 里一直没有存活粒子；现在只有单测 | 让预热期间真的出粒子，如 `rate 2` 或 `instantaneous 1` |
| `around` 配周期发射时新周期清不清零（`rec+0x58 & 2`） | 步骤 3 | 没测，能力表照报 `…:periodic`；语料 0 张 | 测试工程配周期发射，出生方向序列按周期看 |
| `around` 的残留字在「干净重启后只解析过桌面壁纸」时的值 | 步骤 3 | `restart_wpe` 被权限拦下；另外三种先行解析都是「不乘」 | 用户放行 `restart_wpe` 后补抓一次 `p4d-around-ic` |
| `2254685070` 和 WPE 的画面对照 | 步骤 1 | 鼠标拖尾，要移动鼠标才有画面 | P4d 收尾抓帧时移动鼠标，做法同 P4c |
| `remapvalue` 标量输入只用 x 分量归一化再铺满，`remapinitialvalue` 按分量 | 步骤 0、4a | rv-vec / ri-vec 设计时漏写 `flags 0`，归一化被夹到 1，两种算法都得 50；4a 只有单测 | 补一个 `flags 0`、`inputrange*` 各分量不同的工程 |
| init 的 `square` / `saw` 用 `floorf`，op 用 `trunc` | 4a | `ri-*` 新生粒子的 `t = −3` 是整数，`floor` 和 `trunc` 相同；只有单测 | 让 init 的输入出生时是负的非整数，如 `randomframe` 配输入 `lifetimefraction`（读到 `R`）、`inputrangemin 0.5` |
| 系统时间 `St` 在预热期间累不累加、对象不可见期间累不累加（rea 5.3【推】） | 4a | 我们预热不累加；不可见时不步进，所以也不累加 | 带 `starttime` 或会隐藏的对象，配 `remapinitialvalue` 输入 `particlesystemtime` |

**工具与边角：**
- kabegame-dev MCP 的 `particle_corners` / `render_scene` 回放不传 `fps`，低 fps 下 rope 的 `Rf` 仍按 60 算，只影响绳没满的填充期（步骤 1）。
- dev 的 `particleTrack` 对 rope 系统按槽序输出，不是表序（步骤 1）。
- 暂停时改 `instanceoverride` 的 `count` / `lifetime`，rope 的 `TL` 要到下一次步进才更新（步骤 1）。

**已测（从清单里划掉）：**
- `mb2-move` 的定量、`md-soft` 的收敛、`reducemovement` 在 fps 10 下的停止位置、`vortex_v2` 的两遍模式（步骤 0）：步骤 5 的回放 fps 60 / 10 逐粒子对上；fps 10 的 `v2-ring-*` 只报告，见步骤 5 实施记录。
- WPE 不可见时照常更新控制点（步骤 0 的 dist-hide 没测到）：步骤 5 新工程 `p4d-dist2` 的 `hide-r`，fps 10 段「不更新」的变体超限 1156 倍。
- `reductionouter == reductioninner` 时差存成 1.0（步骤 0 的 rm-eq 分辨不了）：`rm-eq2` 两种 fps 都停在 100/3，回放逐粒子对上。
- 可见性按上一帧还是本帧的脚本生效（步骤 3 两种都通过）：步骤 5 的四段里「本帧」都更差，按上一帧。
- WPE 不可见期间照不照常模拟（步骤 3）：步骤 5「照常发射」的变体四段粒子数都对不上，不可见期间不发射。
- 不可见时复位清零 `mapsequence*` 的序号（步骤 0 没测到）：步骤 3 的回放逐粒子对上，见步骤 3 实施记录。
- `remap2` 的全部取值（两个 `timeofday` 与 op 的 `maxlifetime` 除外，三者照报）：4a 回放 58 个系统，4b 补上输入 16–18 与输出 `controlpoint`，共 63 个，两种 fps 全部通过，见步骤 4a、4b 实施记录。
- FBm 的倍频细节（步骤 0 没能区分）：步骤 4b 的回放年龄精确，rv-fbm1 / rv-fbm3 逐粒子对上；变异「不加种子 / 不归一 / 振幅不乘 0.5 / 坐标不乘 2」回放都查得出。

## P4d 收尾

先按上面的「未实测清单」逐项走查（2026-11-10 用户定）。和 P4a–P4c 一样，最后统一写 `cocs/wpe/WPE_SCENE.md`（翻译器的几何着色器展开还要写进 `src-tauri/wpesl2wgsl/README.md`）、changelog 和回归文档，并把总计划的覆盖数改成重算的口径。

## 决定

**已定（2026-11-10 用户，两项都按推荐 A）：**
1. 绳的几何着色器怎么复刻：**A**，翻译器加几何着色器展开。选项留作记录：
   - **A（推荐）：翻译器加几何着色器展开。** 用的是用户安装里的 WPE 原件，COMBO、头文件、uniform 都走现有翻译路径，四角探针也能复用。翻译器要多认 WPE 的 GS 写法：`[maxvertexcount]`、`IN[0]`、`OUT.Append`、`PS_INPUT`。
   - **B：自己写一份绳的顶点着色器**，把 `.geom` 逐行改写成按输出下标算顶点。翻译器不用改，但仓库里要放一份从 WPE 着色器改写来的源码，`REFRACT`、雾这些分支也要自己维护。
   - **C：CPU 算出全部输出顶点**，配一个只做 MVP 的顶点着色器。折射切线和雾要的量还得在着色器里算，两边各写一半。
   - 步骤 0 补充：照原件公式由 WPE 的顶点输入展开，和 `gs_out` 逐顶点差 2.3e-4 像素（`ignore/p4/d0/rope_gs.py`）。三种做法的几何都能精确复刻，差别只在维护成本。
2. `remap*` 做哪些取值（风险 5）：**A**，读码确定的全做，`timeofday` 和未知枚举照报。读码是 20 个输入、8 个分量、7 个变换、4 个运算、14 个有效输出，两个模块各一套，有好几处不同。选项留作记录：
   - **A（推荐）：读码确定的全做。** 只有 `timeofday`（写入点没找到）和未知的枚举值照报。理由：
     - 这是表驱动的代码，两个模块共用；
     - `remap2` 已经抓了全部取值，可以逐项回放验收。
   - **B：只做语料用到的。**
     - `remapvalue`：输入 `particlesystemtime`；变换 `sine`、`simplexnoise`、`fbmnoise`；输出 `opacity`、`velocity`、`speed`；运算 `remap`，加 blend。
     - `remapinitialvalue`：输入 `distancetocontrolpoint`；运算 `multiply`。
     - 其余照报。

**已定（2026-11-10 用户选 C，实测后照实测做）：**

3. `mapsequencearoundcontrolpoint` 的残留字：`count` **不乘** `instanceoverride.count`，不报；配周期发射时照报 `particle:initializer:mapsequencearoundcontrolpoint:periodic`。
   - **实测：** 工程 `ignore/p4/proj/p4d-around-ic`（`ignore/p4/d3/gen_around.py`），抓帧在 `A:\p4d\around-ic-ctx*`，读数用 `ignore/p4/d3/ana_around.py`。
     - 系统照抄 `Cherry_Blossoms_2.json` 在 `around` 之前的模块序列，所以 `around` 记录在暂存区里的偏移和语料相同。
     - 三个系统：ic 的 `count` 覆盖是 0.02，ic50 是 0.5，ref 不覆盖。
   - **三种先行解析：** 用过一天的 WPE；刚开过 3487328036；刚开过 kabegame-sample。
     - 三次里三个系统按出生先后的方向都是 0、0.2、0.4…，相邻差 0.2，和对照组一样。
     - 如果乘了，ic 会全是 0，ic50 相邻差 0.4。
   - **没测到的：**
     - 「干净重启后只解析过桌面壁纸」这一种，`restart_wpe` 被权限拦下，没做；
     - bit1（周期发射的新周期清零）没测。语料里没有周期发射配 `around`，照报不影响覆盖。
   - 选项留作记录：
   - **问题：** WPE 解析这个模块时不读 `flags`，记录的 `rec+0x58` 从来没被写过，存的是解析暂存区里上一次解析留下的值（rea-p4d-modules 1.1）。可它有两个读者：
     - **bit0：** `count` 乘不乘 `instanceoverride.count`；
     - **bit1：** 周期发射的新周期清不清零序号。
   - **残留值说不准：** 暂存区在渲染器构造时分配、从不清零，所以这个字取决于这次 WPE 运行里之前解析过什么，包括桌面壁纸和别的窗口。
   - **语料：**
     - 没有周期发射配 `around` 的；
     - 3 张对象带 `instanceoverride.count`：3487328036 是 0.02，3811764016、3811798465 是 0.5。
   - **差别有多大：** 0.5 时 `step` 是 0.2 还是 0.4，方向集合相同，只是先后顺序不同。0.02 时乘了就是 `step = 10`，每个粒子都在 θ = 0，和不乘完全两样。
   - **影响：** 3811764016 是步骤 3 要解锁的覆盖之一（它另有 `object:shape`，不影响能不能渲染的计数）。
   - **A（推荐）：照报。** 系统里有 `around` 且对象的 `instanceoverride.count` 生效值不是 1（或绑了属性 / 脚本）时，报 `particle:initializer:mapsequencearoundcontrolpoint:instance-count`；配周期发射时报 `…:periodic`。其余照「不乘、不清零」实现。
     - 符合「读不清的照报」；
     - 3811764016 不解锁，覆盖 53 → 56。
   - **B：按不乘、不清零实现，不报。** 3811764016 解锁，覆盖到 57；WPE 实际乘了的话，它的方向顺序和 WPE 不同（画面差别很小）。
   - **C：先实测再定。**
     - 用 wpe-renderdoc MCP 在测试窗口里抓 3487328036（0.02 那张最好分辨：乘了的话所有粒子都朝 +y）；
     - 分两种情况各抓一次：只开着桌面壁纸时、先开过别的工程之后；
     - 两次结果相同，就照实测做，并把这张场景的结果写进报告；不同就退回 A。
     - 代价是一次抓帧会话。

## 风险

1. **几何着色器展开是翻译器的新能力。** WPE 的 GS 写法要能被预处理器和 naga 接受；`TRAILSUBDIVISION` 决定输出顶点数，要进缓存键。
2. **顺序决定整条绳的形状。** 索引表读错，所有绳都错。确定性工程必须覆盖中间先死和空槽复用。
3. **覆盖数是上限。** 绳系统进编译后可能暴露新的不支持项；那个开 `REFRACT` 的绳系统要走折射快照。
4. **只解锁 1 张。** 主要靠确定性工程和 dev 强制渲染验证。
5. **`remap*` 的取值可能很多。** 步骤 0 先列全。按「读码确定的全做」可能比预期大，超出时按取值拆步骤，或者照报，到时再问用户。
