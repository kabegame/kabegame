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

- **新增** 翻译器的几何着色器展开（`src-tauri/wpesl2wgsl`），按决定 1。
```ts
interface TranslateRequest {
  vertex: string;
  fragment: string;
  geometry?: string; // 新增：.geom 原文。给了就定义 GS_ENABLED，把顶点着色器的 GS 分支和几何着色器拼成一个顶点着色器
  // …其余不变
}
interface TranslateResult {
  // …其余不变
  geometry?: {
    // 新增：顶点输入全部按实例步进（每段一个实例），vertex_index 是输出顶点下标，拓扑三角形带
    maxVertices: number; // [maxvertexcount(...)] 展开后的常量，如 4 + TRAILSUBDIVISION * 2
  };
}
```
  README 写明展开规则（每次 `Append` 计数，第 `vertex_index` 次的值是输出）和限制（只支持点输入、单个输出流）。
- **新增** `particles/rope.ts`：
```ts
/** rope 索引表（新增）：出生时追加、判死时移除，顺序就是绳上的先后（步骤 0 核实）。 */
export class RopeOrder {
  constructor(capacity: number);
  push(slot: number): void; // spawn 时调
  remove(slot: number): void; // ageAndKill 判死时调
  readonly slots: Uint32Array;
  readonly length: number;
}
/** 按索引把存活粒子写成每段一个实例的顶点，返回段数；每段的内容照步骤 0（新增）。 */
export function writeRopeSegments(system: ParticleSystem, layout: RopeVertexLayout, out: Float32Array): number;
```
- **修改** `particles/system.ts`：`spawn`、`ageAndKill` 维护 `RopeOrder`（只有 rope 系统建）。
- **修改** `compile/bundle.ts`、`compile/particles.ts`：
  - `rope` 系统的 pass 换成 `genericropeparticle` 的三个文件，写步骤 0 读到的宏；
  - `ParticleRenderer.kind` 加 `rope`，`trail` 换成按种类给出的 `g_RenderVar0`。
- **修改** `render/scene.ts`：绳的管线用三角形带、实例步进，存活数 ≤ 1 不画；`g_RenderVar0.zw` 每帧写。
- **修改** 模块表与能力表：`rope` 进表，字段取值按步骤 0。
- **修改** `dev/particleCorners.ts`：改写入口时支持实例输入，读回整条带子。

**验收：**
- `proj/p4d-rope` 的 `gs_out` 逐顶点和我们读回的比，差不超过 0.01 像素；整帧逐像素比。
- 变异检查：索引表顺序、样条控制点、细分的 `smoothstep`、UV，各有测试失败。
- `2254685070` 没有不支持项，和 WPE 比画面（做法同 P4c 收尾的 `3832772446`）。
- 语料变化逐条解释，现有画面哈希不变。

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
