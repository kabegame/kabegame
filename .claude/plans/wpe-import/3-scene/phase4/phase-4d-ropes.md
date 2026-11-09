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
- **死亡计数的清零：**
  - WPE 在高水位 > 0 时就清零死亡计数和 rope 表（rea-p4d-rope 2.4）；我们的 `suspend` 只在有存活粒子时清空。
  - 差别在「全部粒子已死后再隐藏」时，`uvscrolling` 的 `TP0` 起点不同。
  - 步骤 2 要改同一段清空逻辑（ropetrail 的历史），一起处理。
- **探针不传 `fps`：** kabegame-dev MCP 的 `particle_corners` / `render_scene` 回放只传 `passes`，低 fps 下 rope 的 `Rf` 仍按 60 算。只影响绳没满的填充期。
- `dev` 的 `particleTrack` 对 rope 系统仍按槽序输出粒子，不是表序。
- 暂停时改 `instanceoverride` 的 `count` / `lifetime`，`TL` 要到下一次步进才更新。

## 步骤 2 — `ropetrail`

- **新增** 历史环形缓冲：`段数 × N4` 个位置、每粒子已存段数、`uvscrolling` 计数，计时和后移照步骤 0。
- **修改** 顶点写入：每个粒子一串段；写 `g_RenderVar0` 的 x、z、w，以及宏 `TRAILRENDERER`、`TRAILSCROLLALPHA`、`TRAILFADEALPHA`、`TRAILFADESIZE`。
- **修改** 模块表与能力表：`ropetrail` 进表。

**验收：**
- `proj/p4d-ropetrail` 在 fps 60 和 fps 10 下，`gs_out` 与整帧都和 WPE 一致。
- 变异检查：计时器余量、后移方向、首段 UV，各有测试失败。
- 现有画面哈希不变。

## 步骤 3 — `mapsequence*`

- **新增** 两个 initializer，字段、缺省值、公式按步骤 0。序号是模块的运行状态，做法同 emitter 的 `EmitterState`，按 `FUN_14022f790` 的条件清零。
- **修改** `controlPointCount`：计入它们引用的控制点（`mapsequencebetweencontrolpoints` 引用两个）。

**验收：**
- `proj/p4d-map` 回放，和 WPE 逐帧比，限值同 P4c。
- 变异检查：序号起点、`limitbehavior`、清零时机，各有测试失败。
- `3811764016`、`3816870245` 不再报粒子键；`3823859141`、`3823864170` 加上步骤 1 后也不报。

## 步骤 4 — `remap*`

- **新增** `particles/remap.ts`：输入、变换函数、运算、输出四张小表，`remapinitialvalue` 和 `remapvalue` 共用，噪声复用 `noise.ts`。
- **修改** 模块表：两个模块进表，只放开步骤 0 定下要实现的取值。
- 输出是控制点：如果步骤 0 读清楚了，控制点更新跳过这些点（`controlpoints.ts`）；没读清就照报。

**验收：**
- `proj/p4d-remap` 里每个实现了的取值都和 WPE 逐帧比，噪声类按 P4b 的误差包络。
- `3815289650` 只剩 `particle:children`。

## 步骤 5 — 距离类与 `vortex_v2`

- **新增** 四个 operator，字段、缺省值、公式按步骤 0。
- **修改** `ParticleSystem.suspend`：不可见时照常更新控制点（rea-p4c-sim 5.6），重新可见后第一帧的 previous 和 WPE 一致。

**验收：**
- `proj/p4d-dist` 在 fps 60 和 fps 10 下回放，和 WPE 逐帧比。
- 变异检查：`Δcp` 的方向、`variablestrength` 的钳制、环形分支，各有测试失败。
- `3832133196` 只剩 `particle:children`；kabegame-sample 不再报 P4d 的键。

## P4d 收尾

和 P4a–P4c 一样，最后统一写 `cocs/wpe/WPE_SCENE.md`（翻译器的几何着色器展开还要写进 `src-tauri/wpesl2wgsl/README.md`）、changelog 和回归文档，并把总计划的覆盖数改成重算的口径。

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

## 风险

1. **几何着色器展开是翻译器的新能力。** WPE 的 GS 写法要能被预处理器和 naga 接受；`TRAILSUBDIVISION` 决定输出顶点数，要进缓存键。
2. **顺序决定整条绳的形状。** 索引表读错，所有绳都错。确定性工程必须覆盖中间先死和空槽复用。
3. **覆盖数是上限。** 绳系统进编译后可能暴露新的不支持项；那个开 `REFRACT` 的绳系统要走折射快照。
4. **只解锁 1 张。** 主要靠确定性工程和 dev 强制渲染验证。
5. **`remap*` 的取值可能很多。** 步骤 0 先列全。按「读码确定的全做」可能比预期大，超出时按取值拆步骤，或者照报，到时再问用户。
