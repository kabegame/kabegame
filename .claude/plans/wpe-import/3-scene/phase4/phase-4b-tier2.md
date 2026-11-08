# P4b — 帧表、纹理格式与档 2（子计划）

> 上级：[phase-4-particles.md](phase-4-particles.md)「P4b」。底座沿用 P4a（[phase-4a-base.md](phase-4a-base.md)），框架语义见 [p4-particles-REPORT.md](p4-particles-REPORT.md)、[rea-framework.md](rea-framework.md)、[rea-p4a.md](rea-p4a.md)，本节新增的语义由步骤 0 写进 `rea-p4b.md` 和报告。
> 语料是 2026-11-07 用 P4a 收尾后的代码重扫的 152 个工程（`ignore/p4/step5/out/p4b-plan.json`），能渲染 14 张。
> 分七步：步骤 0 只调研，步骤 1–6 每步能单独验收、单独提交。`colorn`（步骤 6）与 DXT1 / DXT3（步骤 1）2026-11-08 用户同意纳入。

## 总体设计思路

P4b 在 P4a 的底座上沿三条线扩展，底座本身不改形状。

**纹理线：** `rg88`、`r8` 全局放开，图像层和粒子一起受益。D3D 与 WebGPU 对单、双通道纹理的采样结果相同（缺的通道补 0，alpha 补 1），通道换算由着色器按 `TEX<n>FORMAT` 做，这条已在引擎宏修正里落地。所以渲染器只要按原格式上传，不做 CPU 转换。帧表只接进粒子路径：TEXS 帧表解析进 bundle，粒子材质的槽 0 是帧表纹理时写 `SPRITESHEET` 一类宏，`g_RenderVar1` 给帧尺寸和帧数，模拟器维护 frame 列。图像层的帧动画仍属 P6，同一张帧表纹理用在图像层上照报 `tex:animation`。判定看纹理用在哪里，不看纹理本身。

**模块线：** 新增 11 个模块和发射时序，全部照 P4a 的模块表加记录：字段表、缺省值、列、列标志、执行函数。能力表从表生成，所以加一个模块，能力表就少报一个键，不会漂移。模块分两批：确定性的一批（步骤 3）和用噪声的一批（步骤 4）。噪声逐位移植 WPE 自己的实现，连同常量表，不用通用的 simplex 库：粒子轨迹要和 WPE 逐帧比，噪声差一点轨迹就会分叉。

**着色器线：** `REFRACT`（含它带出的 `NORMALMAP`）和 `CUTOUT` 是 `genericparticle` 自带的分支。`CUTOUT` 只改 alpha。`REFRACT` 要 `_rt_FullFrameBuffer`：粒子层的计划已经会在本层之前拷一次快照（WPE 也是每对象每帧一次，rea-p4a C6），只是没和 WPE 比过。

几个关键决定：

- **步骤 0 一次做完。** 一个 REA 代理读完本节全部条目，写成 `rea-p4b.md`；一次 WPE 会话抓完全部确定性工程，带日志的 dt。后面各步只回放，不再开 WPE 会话，除非回放发现读码有错。P4a 就有一条读码结论被实测推翻（预热遍数），所以没实测的不当已确认。
- **验收靠回放。** 照 P4a 步骤 3：随机范围收成 min = max，按 WPE 日志的 dt 序列步进，用 `cmp_track.py` 逐帧比；纹理、帧表、折射比整帧像素。真实样本只比统计量。
- **近似倒数不复刻。** `capvelocity`、`alphafade` 等处 WPE 用 `rcpps` / `rsqrtps`，结果随 CPU 厂商不同（Intel 和 AMD 的近似表不一样），WPE 自己在不同机器上也不一致。验收按理论误差上界（相对 3.7e-4）放宽，记录实际差值。P4a 的 `o2-cap` 已经量过：乘上近似系数后残差 ≤ 2.1e-4，说明其余逻辑是对的。
- **`1838478131` 移到 P4c。** 总计划原以它为 P4b 的解锁目标，条件是控制点中性。它的控制点 0 写了 `flags 1`，而 `sphererandom` 的发射位置总要加控制点 0 的平移（rea-p4a B 第 8 步），这正是「粒子跟着指针」的效果，不中性。步骤 0 实测确认后，总计划把它移到 P4c。

## 范围与解锁

| 步骤 | 内容 | 解锁 |
|---|---|---|
| 0 | 调研：REA 读码、确定性工程抓帧 | — |
| 1 | `r8`、`rg88`、DXT1、DXT3 全局；`tex:alpha-priority` 确认中性后放行 | `3799426930`、`3812822229`、`3829603837`（只差 R8），`2854083091` |
| 2 | 粒子帧表：`animationmode`、`sequencemultiplier`、`SPRITESHEET*`、`THICKFORMAT`；系统 `flags` bit1 | — |
| 3 | 发射时序（`duration`、`delay`、emitter `flags` bit1 / bit2）、`boxrandom`；`alpharandom`、`sizechange`、`alphachange`、`colorchange`、`oscillatesize`、`vortex`、`capvelocity` | `1504316159`、`3820104696`（还要步骤 1、2） |
| 4 | 噪声类：`turbulentvelocityrandom`、`turbulence`、`positionoffsetrandom` | — |
| 5 | `REFRACT`（含 `NORMALMAP`、帧缓冲快照）、`CUTOUT` | — |
| 6 | `instanceoverride.colorn` | — |

P4b 一共解锁 6 张，能渲染的场景从 14 张到 20 张。另外 `3821678218` 在 P4b 之后只差形状对象（PLAN W1）。

各项挡住的场景数（重扫结果，一张场景可以被多项挡住）：`tex:format:9` 81、`tex:animation` 65（含图像层，P4b 只解决粒子用的）、`tex:format:8` 59、`turbulentvelocityrandom` 42、`animationmode` 39、`boxrandom` 37、`sequencemultiplier` 35、`sizechange` 35、`alpharandom` 33、`turbulence` 30、emitter `flags` 22、`tex:alpha-priority` 20、`REFRACT` / `NORMALMAP` 15、`vortex` 13、系统 `flags` bit1 12、`oscillatesize` 9、`colorchange` 6、`alphachange` 2、周期发射 2、`positionoffsetrandom` 1、`capvelocity` 1。`colorn` 是 60 张，比上面任何一项都多。

**本节不做，继续报不支持：**
- 模块上的 `audioprocessing*` 字段（P4e）。`boxrandom`、`turbulentvelocityrandom`、`turbulence`、`vortex` 都有场景带它。
- `hsvcolorrandom`、`colorlist`、`inheritcontrolpointvelocity` 等档 2 以外的模块：语料 0 张。
- 图像层的帧动画（P6）。
- `vortex` 用到控制点时（P4c）；`vortex_v2` 属 P4d。

## 现状锚点

**a. 纹理格式与 alpha-priority 被直接拒绝**（`compile/tex.ts:201`）
```ts
if (flags & TEX_FLAGS.video) unsupported.push("tex:video");
if (flags & TEX_FLAGS.animated) unsupported.push("tex:animation");    // 现状：帧表一律拒绝，图像层、粒子不分
if (format !== 0 && format !== 4) unsupported.push(`tex:format:${format}`); // 现状：只认 RGBA8888 和 DXT5
// …
if (flags & TEX_FLAGS.alphaPriority) unsupported.push("tex:alpha-priority"); // 现状：读码看运行时不读，没实测
```

**b. 上传只有两种格式**（`render/textures.ts:22`）
```ts
export const TEXTURE_FORMATS: Readonly<Record<number, FormatInfo>> = {
  0: { gpu: "rgba8unorm", block: 1, bytesPerBlock: 4 },
  4: { gpu: "bc3-rgba-unorm", block: 4, bytesPerBlock: 16, feature: "texture-compression-bc" },
  // 现状：没有 8（rg88）、9（r8）；上传走 writeTexture，行跨度不用对齐 256
};
```

**c. TEXS 帧表只跳过，不解析**（`compile/tex.ts:252`）
```ts
if (flags & TEX_FLAGS.animated) {
  const magic = await c.magic();
  // …
  frameCount = await c.u32();
  if (animatedVersion === 3) { gifWidth = await c.u32(); gifHeight = await c.u32(); }
  c.skip(frameCount * 32); // 现状：每帧 32 字节的矩形和帧时长被丢掉
}
```

**d. 发射时序只认缺省值**（`particles/modules.ts:202`）
```ts
// 发射时序属 P4b（`delay` 倒数、`duration` 结束）
duration: num(0, zeroOnly),
delay: num(0, zeroOnly),
// bit0 用 `sign`（支持）；bit1 每帧至多 1 个、bit2 周期发射没实现
flags: int(0, (value) => (Number(value) & ~1) === 0),
minperiodicduration: num(2, periodic), // 现状：flags 有 bit2 时这几个字段报不支持
```
模块表只有档 1 的 12 个模块加 `sprite`，档 2 的模块都报 `particle:<类别>:<名字>`。

**e. 帧表相关的系统键**（`compile/features.ts:634`）
```ts
if (flags & 2) unsupported.add("particle:flags:2");                       // 现状：读取点没找到
if (animationMode !== "sequence") unsupported.add("particle:animationmode");
if (sequenceMultiplier !== 1) unsupported.add("particle:sequencemultiplier");
```

**f. 粒子 COMBO 只放行两个**（`compile/features.ts:548`）
```ts
const PARTICLE_COMBOS = new Set(["WORLDBLUR", "USERCOLORBLEND"]); // 现状：REFRACT、NORMALMAP、CUTOUT 报 particle:combo:<名字>
```

**g. `g_RenderVar1` 写死 0**（`render/uniforms.ts:377`）
```ts
g_RenderVar0: [0, 0, 0, 0],
g_RenderVar1: [0, 0, 0, 0], // 现状：帧表要的帧宽、帧高、帧数、宽高比都没有
```

**h. 顶点不认 `a_TexCoordVec4C1`**（`particles/vertices.ts:40`）
```ts
export const PARTICLE_ATTRIBUTES = {
  a_Position: ["position", 3],
  a_TexCoordVec4: ["texCoord", 4],
  a_TexCoordC2: ["rotation", 2],
  a_Color: ["color", 4],
  // 现状：THICKFORMAT 的 a_TexCoordVec4C1（速度 xyz、frame）报 render:particle-attribute
};
```

**i. 粒子层的快照已有，没比过**（`render/graph.ts:159`）
```ts
// 材质需要 `_rt_FullFrameBuffer` 时照图像层直接上屏的规则 1，在本层开始前拷一次快照。……这条没有和 WPE 比过。
if (pass.framebuffer) steps.push({ kind: "snapshot" });
```

## 步骤 0 — 调研

不改产品代码。

### 0a — REA 读码（子代理）

两个代理并行，结果分别写成 `phase4/rea-p4b-modules.md`（第 3、4、5、8 项）和 `phase4/rea-p4b-render.md`（第 1、2、6、7 项），格式同 `rea-p4a.md`：每条标地址和证据等级【确】【推】【未知】。

1. **纹理：**
   - `rg88`、`r8` 建成什么 DXGI 格式。
   - `.tex` 加载路径读不读标志 0x80000。sample-gaps §2.9 只做了有界搜索，这次要从标志字段的每个读者查起。
   - 纹理尺寸大于图像尺寸（NPOT 填充）时，UV 和 `g_Texture0Resolution` 怎么取。
2. **帧表：**
   - TEXS 每帧 32 字节里哪些字段进运行时。
   - `g_RenderVar1` 四个分量怎么算：帧宽、帧高占比、帧数、`textureRatio`。
   - 引擎在什么条件下定义 `SPRITESHEET`、`SPRITESHEETBLEND`、`SPRITESHEETBLENDNPOT`、`THICKFORMAT`。
   - 系统 `0x1000000` 的置位条件。
   - frame 列：`sequence` 模式已读到 `age·rcpps(life)·sequencemultiplier`（rea-framework 模拟第 3 步），补 `randomframe` 写 `R` 的位置。
   - `a_TexCoordVec4C1` 的内容。
   - 一张纹理有多个图像（`imageCount > 1`）时帧表怎么用。
   - 系统 `flags` bit1 的读取点。
3. **发射：**
   - `duration`、`delay` 的帧尾逻辑已读到（rea-p4a B），补完 bit1。
   - bit2 周期发射：状态机、随机数从哪个流抽、抽取顺序、`maxtoemitperperiod` 限额。
   - `boxrandom`：位置、速度的公式和抽取顺序；`distancemin`、`directions` 在盒形里的含义。
4. **模块：** `alpharandom`、`turbulentvelocityrandom`、`positionoffsetrandom`、`sizechange`、`alphachange`、`colorchange`、`oscillatesize`、`turbulence`、`vortex`、`capvelocity`。每个都要：
   - 字段和正交 / 透视两套缺省值；
   - 公式、读写的列、置的列标志；
   - 两遍模式下的行为、乘哪项 `instanceoverride`、用不用 `R`；
   - 近似倒数和近似平方根倒数的位置；
   - 有没有 blend 记录（四个 `blend*` 键）。
5. **噪声：** `turbulence` 一类用的噪声函数。常量表（置换表、梯度表）的地址和内容导出成数据文件，放 `ignore/p4/rea/`，步骤 4 转成产品代码里的常量。
6. **`REFRACT`：** C6 读到「每对象每帧拷一次」，补拷贝在粒子绘制前的哪个时刻；`g_RefractAmount` 和 `NORMALMAP` 槽的来源。
7. **`colorn`**：`FUN_1401d15a0` 的 HSV 路径；`0x200000` 的置位条件；「与系统颜色差 0.0035」里系统颜色的来源。
8. **`audioprocessing*`：** 只列出哪些模块带这些字段，给 P4e 用。

### 0b — 确定性工程与实测（Claude）

- **新增** 生成器 `ignore/p4/gen_b.py`，出四个工程：
  - `proj/p4b`：每个模块一个系统，随机范围收成 min = max；
  - `proj/p4b-emit`：`duration`、`delay`、emitter `flags` bit1、周期发射、`boxrandom`；
  - `proj/p4b-tex`：图像层和粒子各用 R8、RG88、DXT1、DXT3；帧表的 `sequence`、`randomframe`、`sequencemultiplier` 2 和 3、混帧、NPOT；
  - `proj/p4b-color`：几种 `colorn` 配不同的 `colorrandom`，以及 `color`（0–255）写法；
  - `proj/p4b-refract`：`REFRACT` 带和不带 `NORMALMAP`、`CUTOUT`，以及两个折射层前后叠放。
  > 说明：纹理用 WPE `assets` 里现成的 R8、RG88、帧表纹理（`particle/fog1`、`particle/smoke2`、`particle/rain1` 一类），不自己写 `.tex`。只有 alpha-priority 的对照组要在工程里复制一份 RG88 纹理，改掉标志位。
- 用 `wpe-renderdoc` 一次会话抓完，带日志 dt。开会话前请用户先退出 WPE，结束后还原设置。`rdc_track.py` 加读 `TEXCOORD1`（`THICKFORMAT` 的速度和 frame）。
- **直接回答、不等实现的问题：**
  - `tex:alpha-priority`：同一纹理有无这个标志，整帧逐像素相同就是中性。
  - 系统 `flags` bit1 改不改画面。
  - `1838478131` 的控制点 0（`flags 1`）是不是跟随指针：确认后总计划把它移到 P4c。
  - 周期发射的时序，和读码比。
- 结论写进报告新节「P4b 语义的实测核对」，读码被推翻的单独标出来。

**验收：**
- `rea-p4b.md` 覆盖上面 8 项，每个模块都有字段表、缺省值、公式和证据等级。
- 步骤 1–6 要回放的数据都已抓到，`rdc_track.py` 能读出来。
- 上面四个问题有实测结论。

## 步骤 1 — 纹理格式

独立提交，图像层同时受益。

- **修改** `render/textures.ts`：格式表加两项。
```ts
export const TEXTURE_FORMATS: Readonly<Record<number, FormatInfo>> = {
  0: { gpu: "rgba8unorm", block: 1, bytesPerBlock: 4 },
  4: { gpu: "bc3-rgba-unorm", block: 4, bytesPerBlock: 16, feature: "texture-compression-bc" },
  6: { gpu: "bc2-rgba-unorm", block: 4, bytesPerBlock: 16, feature: "texture-compression-bc" }, // 新增：DXT3
  7: { gpu: "bc1-rgba-unorm", block: 4, bytesPerBlock: 8, feature: "texture-compression-bc" },  // 新增：DXT1
  8: { gpu: "rg8unorm", block: 1, bytesPerBlock: 2 }, // 新增：采样得 (r, g, 0, 1)，与 D3D R8G8_UNORM 相同
  9: { gpu: "r8unorm", block: 1, bytesPerBlock: 1 },  // 新增：采样得 (r, 0, 0, 1)，与 D3D R8_UNORM 相同
};
```
  > 说明：DXT1、DXT3 语料 12 张，都还有十几项别的不支持项，不会马上解锁，和 DXT5 同一段上传代码，顺手放开（2026-11-08 用户）。
  > 说明：DXGI 格式以步骤 0 读到的为准。通道换算（RG88 → `rrrg`、R8 → `(1, 1, 1, r)`）由着色器按 `TEX<n>FORMAT` 做，没有 `formatcombo` 的槽位两边都拿原始采样值。
- **修改** `compile/tex.ts`：格式检查改成「格式表里没有才报」，不再写死 0 和 4。
```ts
if (!(format in TEXTURE_FORMATS)) unsupported.push(`tex:format:${format}`); // 修改：表是唯一事实来源
```
  > 说明：`TEXTURE_FORMATS` 现在在 `render/` 下，编译期也要读。挪到 `compile/` 和渲染器共用，或者只把格式号集合导出到编译期，二选一，不复制两份。
- **删除** `tex:alpha-priority`：只在步骤 0 实测中性时删，否则留到查清为止。
- `FBO_FORMATS` 已有 `rg88`、`r8`，不动。

**验收：**
- `proj/p4b-tex` 里图像层、粒子的 R8、RG88、DXT1、DXT3 静态帧和 WPE 整帧逐像素一致。
- `3799426930`、`3812822229`、`3829603837`、`2854083091` 没有不支持项。真机和 WPE 并排比，有动画的比统计量。
- 语料的变化只在 `tex:format:6`–`9`、`tex:alpha-priority` 上，干净场景 14 → 18。
- 现有 30 组画面哈希不变。

## 步骤 2 — 粒子帧表

> 2026-11-08 按步骤 0 的读码与实测重写，并以步骤 1 改过的代码为基准。依据：[rea-p4b-render.md](rea-p4b-render.md) 2.1–2.7，报告「P4b 语义的实测核对」的帧表一行。

### 思路

WPE 判断一个粒子系统用不用帧表，看的是**材质槽 0 纹理头里的标志 bit2**（`0x4`，`.tex` 的「animated」），不看粒子 JSON。命中时系统置内部标志 `0x1000000`，之后三件事都由它驱动：
- 编译期给粒子材质写 `THICKFORMAT`、`SPRITESHEET` 和两个混帧宏；
- 模拟器每帧算 frame 列；
- 绘制前写 `g_RenderVar1`。

所以这一步的主线是：编译期认出帧表，把一份描述放进 bundle，模拟器和渲染器各自读它。

**帧号的分工照 WPE：**
- **引擎侧：** 只维护 frame 原值（`age / life · sequencemultiplier`，可以大于 1），连同速度写进第二组顶点属性 `a_TexCoordVec4C1`。
- **着色器侧：** 取小数，再换算成网格上的帧与混帧系数。

我们走 `genericparticle` 的顶点展开分支，算法和 WPE 的几何着色器分支等价：两边都是 `ComputeSpriteFrame(frac(frame))`，四个角加同样的帧尺寸偏移，Claude 已对过 `.vert` 与 `.geom`。所以顶点只要多写一组属性，帧表的数学全部留在翻译后的着色器里，不在 TS 里重写。

`rcpps(life)` 不复刻（见总体设计）。frame 原值和 WPE 的相对误差约 3.7e-4。两种模式下的影响：
- **混帧开着时：** 只让混帧系数差约 1%；
- **混帧关着时：** 帧号正好落在帧边界附近的粒子可能差一帧。

验收按这一点设计。

### 现状锚点

**a. 帧表只跳过，而且帧表纹理不解码**（`compile/tex.ts:250`、`:257`、`:300`）
```ts
if (flags & TEX_FLAGS.animated) unsupported.push("tex:animation");
const shouldDecode = decode && unsupported.length === 0 && !freeImageMime; // 现状：带 tex:animation 时 mip 不解码
// …
if (flags & TEX_FLAGS.animated) {
  // …读 TEXS 头和帧数
  c.skip(frameCount * 32); // 现状：每帧 32 字节被丢掉
}
```

**b. 纹理的不支持项按纹理缓存，不看用途**（`compile/bundle.ts:499` 起的 `getTexture`）
```ts
const existing = textureIndex.get(file.path);
if (existing !== undefined) {
  for (const key of textureIssues.get(existing) ?? []) issues.add(key); // 现状：同一张纹理用在哪里都报同样的键
```

**c. 粒子材质只知道「是粒子」**（`compile/bundle.ts:629`、`:662`）
```ts
particle.passes.push(await compilePass(pass, { key: `objects/${index}/particle/passes/${k}`, particle: true }));
// …
const defines = context.particle && pass.shader ? await particleDefines(pass, formats, scope) : {};
// 现状：particleDefines 只写 TEX0FORMAT（步骤 1），不知道系统 flags、animationmode，也不看槽 0 纹理的标志
```

**d. 模拟器只在出生时写 frame**（`particles/system.ts:230`、`:279`）
```ts
private advance(dt: number, frameDt: number, passes: 1 | 2): void {
  this.ageAndKill(dt);
  this.emit(dt);            // 现状：判死和发射之间没有序列帧这一步
  // …operator
}
c.frame[slot] = this.def.animationMode === "randomframe" ? r : 0; // 出生时已对（rea-p4b-render 2.5）
```

**e. 顶点和 uniform**：`PARTICLE_ATTRIBUTES` 没有 `a_TexCoordVec4C1`，见锚点 h；`particleBuiltins()` 的 `g_RenderVar1` 写死 0，见锚点 g。

**f. 能力表**（`compile/features.ts`，`checkParticleFeatures`）
```ts
if (flags & 2) unsupported.add("particle:flags:2");                       // 现状：读取点已找到，只关混帧
if (animationMode !== "sequence") unsupported.add("particle:animationmode");
if (sequenceMultiplier !== 1) unsupported.add("particle:sequencemultiplier");
```

### 点 1 — 解析 TEXS 帧表（`compile/tex.ts`）

- **修改** 读帧表，替换 `c.skip(frameCount * 32)`。
```ts
/** TEXS 的一帧（rea-p4b-render 2.1）。坐标已按该帧所在图像的第 0 级 mip 尺寸归一化（精确除法）。 */
export interface TexFrame {
  image: number;      // imageId（i32）；越界或该图像没有 mip 时 6 个坐标为 0
  frametime: number;
  x: number; y: number; width: number; widthY: number; heightX: number; height: number;
}
export interface TexResult {
  // …
  frames?: TexFrame[]; // 新增：TEXS0001 的 6 个坐标是 i32，0002 / 0003 是 f32
}
```
- **修改** `tex:animation` 照报，但**不再挡解码**：`shouldDecode` 只看其余不支持项。帧表纹理在粒子槽 0 是合法用法，要有 mip 才能上传。
  > 说明：用在图像层时场景反正退回，多解码一张纹理只在 `exhaustive` / `force` 下发生。
- **新增** 帧表的不支持项：`imageCount > 1` 报 `tex:animation:multi-image`（WPE 只采第 0 张，帧落在别的图像上会错，【推】）；帧数为 0 报 `tex:animation:empty`。

### 点 2 — 帧表描述进 bundle（`compile/bundle.ts`）

- **新增** `SceneTexture.sheet`：只在头标志 bit2 置位时有。
```ts
/** 粒子帧表（rea-p4b-render 2.2）：只用第 0 帧。渲染器原样写进 g_RenderVar1。 */
export interface SceneSpriteSheet {
  /** (帧宽 / W, 帧高 / H, 帧数, (纹理高 / 纹理宽) · ((帧高 / H) / (帧宽 / W)))，W、H 是第 0 帧所在图像的第 0 级 mip。 */
  renderVar1: [number, number, number, number];
  /** 图像宽 < 纹理宽（只比宽度）→ SPRITESHEETBLENDNPOT。 */
  npot: boolean;
}
```
- **修改** `getTexture` 带用途：粒子材质槽 0 调用时，从这次的问题里去掉 `tex:animation`；其它用途照旧。缓存的 `textureIssues` 仍是纹理自己的全部问题，按用途过滤，不改缓存。
- **修改** `compilePass` 的 `PassContext.particle` 从布尔改成一份系统描述，`particleDefines` 据此写宏（`FUN_1401d2340`，rea-p4b-render 2.4）。
```ts
interface PassContext {
  // …
  /** 粒子材质（P4b 步骤 2 起带系统描述）。 */
  particle?: { flags: number; animationMode: "sequence" | "randomframe" };
}

// particleDefines：槽 0 纹理带 sheet 时
//   THICKFORMAT = 1、SPRITESHEET = 1
//   SPRITESHEETBLEND = (flags & 2) === 0 && animationMode !== "randomframe" ? 1 : 0   // 写 0 也写键，同 WPE
//   SPRITESHEETBLENDNPOT = sheet.npot ? 1 : 0
//   TEX0FORMAT 照步骤 1（格式 8–11）
// 不带 sheet：只有步骤 1 的 TEX0FORMAT，和现在逐字相同
```
  > 说明：值为 0 的宏也写，和 WPE 一致：`genericparticle` 全用 `#if`，结果一样；项目自定义着色器如果用 `#ifdef`，只有照写才对。
- **新增** `SceneParticle.spriteSheet: boolean`（槽 0 纹理带 sheet），编完材质后由 `compileParticle` 填，模拟器据此决定算不算序列帧。

### 点 3 — 模拟器写 frame（`particles/system.ts`）

- **新增** 判死之后、发射之前的一步（O1：年龄与判死 → **序列帧** → 死亡处理 → 发射）。
```ts
private advance(dt: number, frameDt: number, passes: 1 | 2): void {
  if (!(dt > 0)) return;
  this.ageAndKill(dt);
  this.sequenceFrames(); // 新增
  this.emit(dt);
  // …
}

/** `0x1000000` 且非 randomframe：frame = (1 / life) · age · sequencemultiplier（0x140237022），对 [0, highWater) 全部槽。 */
private sequenceFrames(): void {
  if (!this.def.spriteSheet || this.def.animationMode !== "sequence") return;
  const { frame, age, life } = this.columns;
  const m = f32(this.def.sequenceMultiplier);
  for (let i = 0; i < this.highWater; i++) frame[i] = f32(f32(f32(1 / life[i]) * age[i]) * m);
  // life 为 0 的死槽得 inf / NaN，写顶点时跳过，和 WPE 一样不影响结果
}
```
  > 说明：预热走同一个 `advance`，自然也算。出生当帧 `frame = 0`（序列）或 `R`（randomframe），下一帧才更新，和 WPE 一致。
- `particleSnapshot` / 轨迹多输出一项 `thick: [vx, vy, vz, frame]`，和 `rdc_track_b.py` 读出的 `TEXCOORD1` 同义。

### 点 4 — 顶点与 uniform

- **修改** `particles/vertices.ts`：`PARTICLE_ATTRIBUTES` 加 `a_TexCoordVec4C1: ["thick", 4]`，`writeVertices` 在布局里有它时写 `(vx, vy, vz, frame)`，4 个角相同，不取小数。
  > 说明：偏移照旧按反射布局，不写死。WPE 非 GS 的厚格式是 68 字节，我们按翻译器排，验收看值不看偏移。
- **修改** `render/uniforms.ts`：`particleBuiltins` 收这个粒子 pass 槽 0 纹理的 `sheet`，有就写 `g_RenderVar1 = sheet.renderVar1`，否则仍是 0。
  > 说明：WPE 在帧向量为空时不写、保留上一次绘制的值；我们已把空帧表报不支持，碰不到。
- `g_Texture0Resolution` 不改：步骤 1 已核对过 NPOT 时是 (纹理宽, 纹理高, 图像宽, 图像高)，`SPRITESHEETBLENDNPOT` 用它的 `z / x`。

### 点 5 — 能力表（`compile/features.ts`）

- **删除** `particle:animationmode`、`particle:sequencemultiplier`、`particle:flags:2`。系统 `flags` bit1 唯一的读取点就是关混帧（rea-p4b-render 2.3，【确，有界】）。
- **保留** 帧表用在图像层或粒子其它槽：`tex:animation`（图像层帧动画属 P6）。`spritetrail` / `rope` 带帧表时照旧由 renderer 键挡住（P4c / P4d）。
- 这几个键写成绑定或关键帧时照旧报（`particle:binding:system:*`、`value:animation`）。

### 验收

真值数据是步骤 0 已抓的 `A:\p4b\p4b-tex-fps60`（3 帧）、轨迹 `tracks/rd-p4b-tex-fps60.json`、日志 `out/p4b-tex-fps60-log.txt`。不用再开 WPE。

- **frame 原值：** 我们回放 WPE 日志的 dt，和 WPE 的 `TEXCOORD1` 逐帧比 15 个帧表系统。
  - `w`（frame）相对差 ≤ 4e-4（`rcpps` 的上界），`xyz`（速度）逐位相同。
  - `s-fog1/2/3` 要看到 `sequencemultiplier` 的倍数关系，以及大于 1 不回绕。
  - `s-rand` 的 frame 是 `R`，我们的 `R` 和 WPE 不同，只核对「整生不变」。
- **整帧像素：** 回放同一 dt，和 WPE 导出的整帧逐像素比。
  - **硬条件：**
    - 非帧表区域和步骤 1 的结果逐像素相同（步骤 1 只有 DXT1 粒子、R8 / RG88 图像层有 1 个色阶的差）；
    - 每个帧表粒子的四边形宽高比、所在帧都和 WPE 一致（帧宽高比按 `g_RenderVar1.w`，`lightning` 0.25、`fire` 2、`bubble` 1.2、`raindrops` 4）。
  - **允许的差异：**
    - 混帧开着的系统，像素差来自混帧系数（约 1%），逐系统列出最大色阶差；
    - 混帧关着的系统（`s-flag2`），帧号离整数边界不到 0.5% 的粒子可能差一帧，列出来逐个说明。
  - `s-rand` 用探针注入 WPE 的 `R`（见下）后比。
  - `s-npot-w`（图像宽 896）每行只取 7 帧；`s-npot-h`（只改高）和 `s-fog1` 结果相同。
- **探针：** `renderFrame` 的 `particles` 加可选的 `random: Record<对象下标, number[]>`。它按出生顺序顶替这个系统抽到的 `R`，用完退回种子随机数。这一项只在 dev 构建里，`s-rand` 的 `R` 从 WPE 轨迹的 frame 读出。
- **语料：**
  - 变化只在 `tex:animation`（粒子槽 0）、`particle:animationmode`、`particle:sequencemultiplier`、`particle:flags:2` 上，以及帧表宏第一次进编译带出的新键，逐条解释；
  - 不应有场景新增解锁：`1504316159`、`3820104696` 还差 `alpharandom`，属步骤 3；
  - 列出语料里用帧表的粒子材质：着色器（内置 / 项目自定义）、格式、帧数、是否 NPOT。项目自定义着色器翻译失败的单独列。
- **翻译：** 语料里出现的帧表宏组合（`SPRITESHEETBLEND` 0 / 1 × `SPRITESHEETBLENDNPOT` 0 / 1 × 格式）都能翻译，`checkParticleProgram` 不报新项。
- **变异检查：**
  - frame 不乘 `sequencemultiplier`；
  - 序列帧放在发射之后；
  - 混帧条件漏掉 bit1 或 `randomframe`；
  - NPOT 比成高度；
  - `renderVar1.w` 漏掉纹理宽高比；
  - 槽 0 以外的帧表纹理也放行；
  - 顶点 frame 取了小数。

  以上各改坏一处，都要有测试失败。
- **哈希：** 现有 30 组画面哈希不变。没有帧表的粒子材质，缓存键和宏逐字不变。

## 步骤 3 — 发射时序、`boxrandom` 与确定性模块

> 2026-11-08 按步骤 0 的读码与实测重写，以步骤 1、2 的代码为基准（当时还没提交）。依据：[rea-p4b-modules.md](rea-p4b-modules.md) A0–A4、B1、B4、B5、B7、B8、B9；报告「P4b 语义的实测核对」的发射、`sizechange`、`capvelocity`、`vortex` 几行。公式以 rea 文档为准，这里只写结构和容易错的地方。

### 思路

这一步全在模块表和模拟器里，不碰 GPU，也不碰着色器。

- **模块表加 8 条记录：** emitter `boxrandom`，initializer `alpharandom`，operator `sizechange`、`alphachange`、`colorchange`、`oscillatesize`、`vortex`、`capvelocity`。能力表从表生成，加一条就少报一个键。
- **发射逻辑是 emitter 共有的：** `emissionCount` 照 A1、A3 补上三件事：
  - 周期计时，即两态计时器加每周期限额；
  - `flags` bit1，每帧至多 1 个；
  - `duration < 0` 的分支。

  `sphererandom` 和 `boxrandom` 共用它，两者只有执行函数（写位置和速度）不同。所以发射的公共字段抽成一份，两个模块表记录共用。
- **噪声类不在这一步：** `positionoffsetrandom` 读码证明用二维噪声，和 `turbulentvelocityrandom`、`turbulence` 一起属步骤 4。

几个决定（步骤 0 已定，这里照做）：
- **近似运算不复刻：** `rcpps`、`rsqrtps` 一律用精确的 `1/x`、`1/sqrt(x)`（总体设计「近似倒数不复刻」）。涉及 `capvelocity` 的截速比例、`vortex` 的径向单位向量、`*change` 解析期的 `1/(endtime − starttime)`、生命比例 `age/life`。验收按相对 3.7e-4 的上界放宽，记录实际差值。
- **`oscillatesize` 的 `sin` 用 `Math.sin`：** WPE 是 `sse_mathfun` 的 `sin_ps`。P4a 的 `oscillate*` 也用 `Math.sin`，实测在限内，保持一致。
- **控制点：** `boxrandom` 和 `vortex` 的 `controlpoint` 非 0 时报不支持（P4c）。控制点 0 按单位阵、平移 0 处理，和 `sphererandom` 一样；控制点有 `offset` 时，能力表已经报 `particle:controlpoint`。
- **`sizechange` 乘 `instanceoverride.size`：** 实测确认两者叠用时按 `size²` 放大，照做。
- **`colorchange` 与 `colorn` 的 HSV 路径不在这一步：** 写了 `colorn` 的场景仍由 `particle:instance:colorn` 挡住，属步骤 6。

### 现状锚点

**a. 发射状态没有周期计时**（`particles/emitters.ts:13`）
```ts
export interface EmitterState {
  acc: number;      // 累积余数（rec+0x24）
  pending: number;  // 待发的 instantaneous
  delay: number;
  duration: number;
  ended: boolean;   // 现状：没有 burst（rec+0x3c）、周期计时 P（rec+0x40）
}
```

**b. 数量计算只有连续发射**（`particles/emitters.ts:65` 的 `emissionCount`）
```ts
const x = f32(f32(rate * dt) + state.acc);
if (x < 1) state.acc = f32(x - n0);   // 现状：少了「或 duration < 0」
else {
  const k = Math.floor(x);
  state.acc = f32(x - (k + n0));
  n0 += k;                            // 现状：bit1 不限 1 个，周期发射没有限额
}
```

**c. 时序字段只认缺省值**（`particles/modules.ts:202`）
```ts
duration: num(0, zeroOnly),
delay: num(0, zeroOnly),
flags: int(0, (value) => (Number(value) & ~1) === 0),  // 现状：bit1、bit2 报不支持
minperiodicduration: num(2, periodic),                 // 现状：有 bit2 时周期字段报不支持
```
`delay`、`duration` 的帧尾逻辑已经写在 `emissionCount` 末尾（P4a 照读码写的），和 A2 一致，不用改。

**d. 模块表只有档 1**（`particles/modules.ts:185` 的 `PARTICLE_MODULES`）：12 个模块加 `sprite`，这一步的 8 个都报 `particle:<类别>:<名字>`。

### 点 1 — 发射状态与数量（`particles/emitters.ts`）

- **修改** `EmitterState` 加两项，`emitterState` / `resetEmitterTiming` 一起清零（A3 末条：计时复位时 `acc`、`burst`、`P` 归零）。
```ts
export interface EmitterState {
  acc: number;
  pending: number;
  delay: number;
  duration: number;
  ended: boolean;
  /** 新增：本周期已连续发射数（rec+0x3c），只数连续发射，不数 instantaneous。 */
  burst: number;
  /** 新增：周期计时 P（rec+0x40）：正数是本周期剩余时长，负数是剩余间歇，初值 0。 */
  period: number;
}
```
- **修改** `emissionCount` 照 A1 + A3，多传一个随机源。周期的随机数从流 A 抽（`random.a()`），抽取时机在本 emitter 算数量时，早于它本帧的新粒子。
```ts
export function emissionCount(state, fields, dt, alive, capacity, random: ParticleRandom): number {
  let rate = fields.rate;                       // 已乘 count
  let emit = 0;
  if (alive < capacity && !state.ended && state.delay <= 0) {
    if (flags & 4) {
      if (state.period > 0) {                   // 周期内
        state.period = f32(state.period - dt);
        if (state.period < 0) state.period = -lerp(mindelay, maxdelay - mindelay, random.a()); // 进入间歇；本帧照常发
      } else {                                  // 间歇（含初值 0）
        state.period = f32(state.period + dt);
        if (state.period < 0) rate = f32(rate * 0);
        else {                                  // 新周期：不补零头，计时直接设成抽到的时长
          const u = random.a();
          state.pending = instantaneous 初值;    // 不乘 count（实测）
          state.burst = 0;
          state.period = lerp(minduration, maxduration - minduration, u);
        }
      }
    }
    let n0 = state.pending; state.pending = 0;
    const x = f32(f32(rate * dt) + state.acc);
    if (x < 1 || state.duration < 0) state.acc = f32(x - n0);
    else {
      let k = Math.floor(x);
      state.acc = f32(x - (k + n0));            // 先扣全部 k，限额砍掉的不退回
      if (flags & 2) k = Math.min(1, k);
      if ((flags & 4) && maxtoemit !== 0) { k = Math.min(k, Math.max(0, maxtoemit - state.burst)); state.burst += k; }
      n0 += k;
    }
    emit = min(n0, capacity - alive);
  }
  // 帧尾不变（A2）
}
```
  > 说明：满容量或 `delay > 0` 时整段跳过，周期计时也停住（A1）。`maxtoemitperperiod` 乘 `count` 后**截断成整数**（条目类型 1：`int(f32(value) · count)`），`rate` 乘 `count` 不截断（类型 2）。
- **修改** `modules.ts` 的周期字段解析期修正：`minperiodicduration = min(min, max)`、`minperiodicdelay` 同理（A0），放进 `normalize`。

### 点 2 — `boxrandom`（`particles/emitters.ts`、`particles/modules.ts`）

- **新增** 发射公共字段表，`sphererandom` 和 `boxrandom` 共用：`rate`（乘 `count`）、`duration`、`delay`、`instantaneous`、`flags`、四个周期字段、`maxtoemitperperiod`（乘 `count`）。`flags` 支持 bit0–2，其余位报不支持。
  > 说明：`boxrandom` 不读 `sign`，bit0 对它中性（A4），所以同一个支持判断就够了。
- **新增** `boxrandom` 的记录：字段与正交 / 透视缺省值见 A4 表。`distancemin` / `distancemax` 是**向量**、只接受字符串；`speedmin` / `speedmax` 乘 `speed`；没有 `sign`、`cone`；`controlpoint` 非 0 报不支持。
- **新增** 执行函数 `boxRandom`，照 A4 伪代码：
  - 抽取顺序 z、y、x 各一个 `uB`，`r_i = (2u − 1)·directions_i`；
  - `q_i = s_i·((s_i·r_i)·(max_i − min_i) + min_i)`，`s_i` 是 `r_i` 的符号（0 时为 0）；
  - 位置 `q + origin`；`d` 用写进列的 float 重新减；
  - `|d|` 太小时（`fastInvSqrt` 判 1e-4）回退：再抽 z、y、x 三个 `uB` 当方向；
  - 速度 `uB·(max − min) + min` 乘 `d / |d|`，精确 `sqrt`。
  > 说明：`fastInvSqrt`（`0x5f375a86` 加一次牛顿迭代）只用在 1e-4 的判断上，用 `Float32Array` / `Int32Array` 互转逐位照抄，成本很低。`|d| = 0`（`directions "0 0 0"`）时 WPE 乘出 NaN，这里按 0 处理，和 `sphererandom` 一样。

### 点 3 — initializer `alpharandom`（`particles/initializers.ts`）

- **新增** `alphaRandom`：`t = uA`（`exponent ≠ 1` 时取幂），`alpha0 = (t·(max − min) + min)·alpha0`。缺省 `min 0.05`（float `0x3d4ccccd`）、`max 1`、`exponent 1`，两套相同，没有覆盖项。
  > 说明：写的是 alpha **初值**列，不碰当前值列，不置列标志。当前值在每遍 operator 开头从初值复制，所以结果一样。

### 点 4 — operator（`particles/operators.ts`）

公式和缺省值见 B4、B5、B7、B8，这里列要点：

- **`sizechange` / `alphachange` / `colorchange`：**
  - `t = max(0, min(1, (age/life − starttime) · (1/(endtime − starttime))))`。`t` 是生命比例；中间值是 NaN 时得 1（`minps`），`endtime = starttime` 就会这样，要照做。
  - 当前值乘上去：`size *= start + t·(end − start)`；`alpha` 乘当前值列（置 bit4）；`rgb` 逐通道同样乘（置 bit3）。
  - `colorchange` 的两个颜色是 0–1 的倍数，**不除以 255**，只接受字符串。
  - `sizechange` 的 `startvalue`、`endvalue` 都乘 `size`。
  - 三者都不用 `h`、`k`、`R`，没有 blend。
- **`oscillatesize`（有 blend）：**
  - `ω = R·(fmax − fmin) + fmin`，`τ = (R·(pmax − pmin) + pmin) + age`，`s = sin(τ·ω)`，`amp = R·((smax − smin)·0.5)`。
  - 无 blend：`size *= (s + 1)·amp + smin`。
  - 有 blend：`size *= (((s + 1)·amp + (smin − 1))·b) + 1`，`b` 用现有的 `readBlend` / `blendFactor`。
  - 缺省频率 1 / 10、相位 0 / 2π、幅度 0.8 / 1.2；频率**不乘** `speed`。
- **`vortex`（无 blend）：**
  - 解析期：`axis` 精确归一化，`|axis|² < 0.001` 时取 `0 0 1`；存 `1/(outer − inner)`，两者相等时存 1.0；`speedinner`、`speedouter` 乘 `speed`。
  - `flags` 只认 bit0，其余位报不支持；`controlpoint` 非 0 报不支持。
  - 执行：
    - 中心 `C = offset`（控制点 0 平移按 0，`offset` 不旋转）；`d = pos − C`；
    - `flags` bit0 置位时去掉沿轴分量（柱形），否则不去（球形，实测确认）；
    - `t = clamp01((|r| − inner)·rcpRange)`，`spd = t·(speedouter − speedinner)·k + speedinner·k`；
    - `v += (r̂ × axis)·spd`。
  - **乘的是 `k`，不是 `h`。** `ParticleRunContext` 里已有 `k`。fps ≥ 40 时两者相等，fps 10 的数据能区分。
  - `|r| = 0` 时 WPE 是 NaN，这里跳过这个粒子。
- **`capvelocity`（有 blend）：**
  - `q = maxspeed / sqrt(|v|²)`（精确）；无 blend 时 `s = min(1, q)`，有 blend 时 `s = min(0, q − 1)·b + 1`；`v *= s`。
  - 缺省 `maxspeed` 正交 100、透视 1；**没有覆盖项**，`speed` 放大速度但不放大上限。
  - `v = 0` 时 `q = inf`、`s = 1`。
  - 两遍模式每遍都截。

列与列标志按 B9 和 rea-framework「标志位来源」：`alphachange` bit4，`colorchange` bit3，其余不置。

### 点 5 — 能力表（`compile/features.ts`，从模块表生成，基本不用手改）

- **删除** 报的键：`sphererandom` 的 `duration`、`delay`、`flags`（bit1、bit2）、四个周期字段、`maxtoemitperperiod`；8 个模块的 `particle:<类别>:<名字>`。
- **保留**：
  - 模块上的 `audioprocessing*`（P4e），作为表外字段照报；
  - `boxrandom` / `vortex` 的 `controlpoint` 非 0；
  - `vortex` 的 `flags` 除 bit0 以外的位；
  - emitter `flags` bit3 及以上。
- 写成 `{user}` / `{script}` / 关键帧的照报，规则不变。

### 验收

真值数据都是步骤 0 抓的，不用再开 WPE：
- 模块：`tracks/rd-p4b-fps60.json`、`rd-p4b-fps10.json`；
- 发射：`rd-p4b-emit-fps60.json`；
- 日志：`out/p4b-fps60-log.txt`、`p4b-fps10-log.txt`、`p4b-emit-fps60-log.txt`；
- P4a 的固定数据 `particles/fixtures/`（含 `o2-cap-*`）。

回放照 `ignore/p4/b2/replay.test.ts`：从磁盘编译工程，按日志累计时间差分出 dt，回放到抓帧的那几帧，逐粒子比。

- **模块回放**（`proj/p4b` 的 `alpharandom`、`sizechange`、`size-ovr`、`size-ref`、`colorchange`、`alphachange`、`oscsize`、`oscsize-blend`、`cap-*`、`vortex-*`）：
  - 限值同 P4a：位置 1e-3，坐标大于 1000 时 2e-3；尺寸、颜色、alpha、旋转照 b2 的 `LIMITS`。
  - **`capvelocity`：** 截速那一步 WPE 是 `rsqrtps`，第一步比例差约 7e-5。按「每次截速相对 3.7e-4」算出位置限值，记录实际差值。P4a 的 `o2-cap-*` 现在由产品代码跑，回放工具临时补的 `capvelocity` 删掉。
  - **`vortex`：** fps 60 和 fps 10 都要在限内。fps 10 时把 `k` 换成 `h` 应该超限，用这一点证明乘的是 `k`。`rsqrtps` 每帧都参与，误差会累积，按帧数给出限值并记录实际差值。
  - **`oscsize`：** `R` 进了 ω、相位、幅度三处。从 WPE 一帧反推每个粒子的 `R`，经 `particleTrack` 的 `random` 注入后逐帧比（同 P4a 的 `rfit`、步骤 2 的 `s-rand`）。
  - **`size-ovr`：** 尺寸是 `size-ref` 的 2 倍。
- **发射回放**（`proj/p4b-emit` 全部 9 个系统）：
  - `delay-dur`、`bit1`、`periodic`、`periodic-bit1`、`periodic-count`、`periodic-full`：每帧粒子数和每个粒子的出生帧都和 WPE 一致，位置照限值比。周期发射的随机数是 min = max，结果确定。
  - `box-line`、`box-corner`、`box-zero`：符号随机，逐粒子比不了。比的是形状：
    - `box-line` 的 `|x − 900| = 100 + 50·age`；
    - `box-corner` 全在角块里，横向距离 50–100；
    - `box-zero` 走回退分支，位置在中心、速度 ±50 沿 x；
    - 数量逐帧一致。
- **变异检查：** 以下各改坏一处都要有测试失败：
  - bit1 不限 1 个；
  - 限额不扣 `burst`、新周期不清 `burst`；
  - 周期计时补零头；
  - 满容量时周期计时不冻结；
  - `instantaneous` 乘了 `count`、`maxtoemitperperiod` 不截断；
  - 少了 `duration < 0` 分支；
  - `vortex` 用 `h`、柱形掩码取反；
  - `capvelocity` 的 blend 公式写成无 blend 的；
  - `sizechange` 不乘 `size`；
  - `*change` 的 NaN 不按 1；
  - `alpharandom` 写进当前值列；
  - `oscillatesize` 的幅度不乘 `R`；
  - `boxrandom` 的抽取顺序改成 x、y、z，或者 `distancemin` 当成盒壳；
  - 回退分支不抽新随机数。
- **语料**（和步骤 2 的语料输出 `ignore/p4/b2/out/` 比）：
  - 变化只在上面删掉的键上，逐条解释；
  - 干净场景 18 → 20，新增正好是 `1504316159`、`3820104696`。
- **解锁的两张：** 编译后没有不支持项。真机和 WPE 比统计量（粒子数、位置范围、尺寸、alpha 分布）由 Claude 做，代理不开 WPE。
- **哈希：** 30 组画面哈希不变（Claude 做）。

## 步骤 4 — 噪声类模块

> 2026-11-08 按步骤 0 的读码与实测重写，以步骤 1–3 的代码为基准（当时还没提交）。依据：[rea-p4b-modules.md](rea-p4b-modules.md) B2、B3、B6、B9、C1–C5；报告「P4b 语义的实测核对」的 `turbulence`、`turbulentvelocityrandom` 两行。公式以 rea 文档为准，这里只写结构和容易错的地方。

### 思路

这一步加三个用噪声的模块：initializer `turbulentvelocityrandom`、`positionoffsetrandom`，operator `turbulence`。它们共用一个新文件 `particles/noise.ts`，并且都要用场景时间，这是模拟器第一次需要帧时间以外的时钟。

- **噪声照 WPE 逐位移植，不用开源实现。** WPE 有三个噪声函数（C1–C3），结构来自 Gustavson 的 simplex，但改过几处：二维的梯度选择条件不同，三维的单形顶点顺序在坐标相等时不同、第 4 个角的哈希不同。常量表在 `ignore/p4/rea/p4b-mod/noise-tables.json`，搬进产品代码成常量文件，产品代码不能读 `ignore/`。浮点常量按位模式写（如 `0x3eca3d71`），每一步 `Math.fround`。
- **场景时间进模拟器。** 噪声的时间输入 `T` 是 `ctx+0x130`，和着色器的 `g_Time` 同源（C 节「命名」【推】）：钳过的帧时间累加，超过 432000 归零。`ParticleSystem.step` 多收一个 `time`，渲染器传 `FrameClock` 的 `g_Time`，dev 探针和回放按日志的 `runtime` 列传。预热期间 `T` 按 0（B2 末条【推】），由 Claude 另抓数据核对（见验收）。
- **`turbulence` 乘 `k`，不乘 `h`。** 和步骤 3 的 `vortex` 一样，`ParticleRunContext` 里已有 `k`。

### 现状锚点

**a. 运行上下文没有时间**（`particles/modules.ts` 的 `ParticleRunContext`）
```ts
export interface ParticleRunContext {
  columns: ParticleColumns;
  random: ParticleRandom;
  slot: number;
  count: number;
  h: number;
  k: number;   // 现状：没有场景时间 T
}
```

**b. 步进只收帧时间**（`particles/system.ts:211`、`render/scene.ts` 的 `stepParticles`、`particles/track.ts`）
```ts
step(frameDt: number): void {                                       // system.ts
  this.advance(f32(f32(frameDt) * this.rate), frameDt, this.passes);
}
particles.system.step(frametime);                                   // scene.ts：现状只传帧时间
for (const { system } of systems) system.step(dt);                  // track.ts：现状只有 dt 序列
```

**c. 模块表没有这三个模块**：它们报 `particle:initializer:turbulentvelocityrandom`（42 张）、`particle:initializer:positionoffsetrandom`（1 张）、`particle:operator:turbulence`（30 张）。

### 点 1 — 噪声（新增 `particles/noise.ts`、`particles/noiseTables.ts`）

- **新增** `noiseTables.ts`：由 `noise-tables.json` 生成的常量（256 字节置换表；`snoise3` 的 512 字节 `perm`、`permMod12`；三张 12 项梯度表 `gx`、`gy`、`gz`；全部标量常量的位模式）。文件头注明来源和地址。
- **新增** 三个函数，签名都是 float32 进、float32 出：
```ts
/** C1，FUN_14027b090：Gustavson noise1，系数 0.395（0x3eca3d71），没有半径截断。turbulentvelocityrandom 用。 */
export function snoise1(x: number): number;
/** C2，FUN_14027b170：结构同 SimplexNoise1234::noise2，梯度条件是 (h & 0x3c) == 0，输出 ×45.23065（0x4234ec30）。positionoffsetrandom 用。 */
export function snoise2(x: number, y: number): number;
/** C3，FUN_1400fd010（SSE4.1 版）：Gustavson 2012 半径 0.6、×32；顶点顺序与 gi3 照 C3 伪代码。turbulence 用。 */
export function snoise3(a: number, b: number, c: number): number;
```
  > 说明：取整照读码：C1、C2 是截断再修正（`cvttss2si`，`f32(i) > x` 时减 1），C3 是向下取整（`roundps`）。整数加法先做（`t = f32(i + j)·G2`）。加法、乘法的结合顺序照伪代码的括号，一步一个 `Math.fround`。
- **单测真值不用开源实现的输出，从 WPE 轨迹里取：**
  - `snoise2`：`posoffset-1`（`octaves 1`、`directions 1 1 0`）每个粒子的出生偏移 `(Δx, Δy) / distance` 就是 `snoise2(px·scale, Ts)` 和 `snoise2(Ts, py·scale)`。出生时刻由出生帧定，出生位置就是发射原点。
  - `snoise1`：`turbvel` 每个粒子的速度方向给出 `ang = n·π`（`scale 1`、`offset 0`），即 `n = snoise1(T_出生·timescale)`。
  - `snoise3`：没有直接可观测的单点值，靠 `turb*` 的轨迹回放核对。
  - 另外钉几个读码能手算的点：整数输入时 `snoise1` 为 0；`snoise3` 在单形顶点上的取值。

### 点 2 — 场景时间（`particles/modules.ts`、`particles/system.ts`、`render/scene.ts`、`particles/track.ts`、`dev/probe.ts`）

- **修改** `ParticleRunContext` 加 `time`（float32 的 `T`）。
- **修改** `ParticleSystem.step(frameDt, time)`：`time` 是本帧的 `g_Time`（已加上本帧钳过的 dt、已按 432000 回绕）；预热时 `time = 0`。
  > 说明：「本帧」还是「上一帧」的 `g_Time` 读码没写死。先按本帧实现，回放时两种都试，取吻合的那个，写进实施记录。
- **修改** `GpuScene.stepParticles(frametime, time, state?)`，渲染循环传 `FrameClock` 的 `time`（和 `g_Time` uniform 同一个值）。
- **修改** `particleTrack` / `renderFrame` 的回放选项加 `times`（和 `dts` 等长）。没给时按 `dts` 的 float32 累加算，和 `FrameClock` 一致。

### 点 3 — initializer `turbulentvelocityrandom`（B2）

- **新增** 模块表记录和执行函数。字段与两套缺省值见 B2 表：`speedmin` / `speedmax` 乘 `speed`（条目类型 6）；`timescale` 乘 `instanceoverride.rate`（类型 2，**不受系统 `flags` 禁用位影响**）；`forward`、`right` 是向量、只接受字符串；没有 `up` 键。`audioprocessing*` 照报（P4e）。
- **执行**（照 B2 伪代码）：
  - 先抽 `u1 = uA`（相位），算 `t = ((u1·prange + phasemin) + T)·timescale`，`n = snoise1(t)`，`ang = ((n·π)·scale) + offset`（`π` 用 `0x40490fdb`）；
  - 按 `glm::rotate` 的展开式绕 `normalize(right)` 转 `forward`（`forward` **不**归一化），`cos` / `sin` 用 `Math.cos` / `Math.sin` 再 `fround`；
  - 再抽 `u2 = uA`（速度），`spd = u2·(speedmax − speedmin) + speedmin`；
  - 速度**加上** `M · (dir·spd)`。`M` 是发射器的控制点 3×3：控制点 0 无旋转，按单位阵（有内容的控制点已经由 `particle:controlpoint` 挡住）。
  - 不用 `R`，不置列标志。
  > 说明：WPE 的 `sinf` / `cosf` 是 CRT 实现，和 `Math.sin` 取整后可能差 1 ulp，回放时记录这部分误差。

### 点 4 — initializer `positionoffsetrandom`（B3）

- **新增** 记录和执行函数。字段与缺省值见 B3 表：`directions`、`sign` 是向量；`scale` 正交 0.001、透视 1；`distance` 正交 100、透视 0.1；`timescale` **不乘** `rate`；`octaves` 解析时钳到 `[1, 8]`，按无符号比较（负数当很大，钳成 8）。`|sign|² > 1.19e-7` 时才启用 sign 处理。没有覆盖项、没有音频。
- **执行**：`Ts = timescale·T`；三个轴各一次 fbm（`f` 从 1 开始每倍频翻倍、`a` 从 1 开始每倍频减半，结果是 `sum / norm`），参数顺序 X `(px·scale, Ts)`、Y `(Ts, py·scale)`、Z `(pz·scale, −Ts)`；乘 `directions`；sign 处理；`pos_i = o_i·distance + p_i`。完全确定，不抽随机数。
  > 说明：`p` 是发射器和排在它前面的 initializer 写下的位置，所以 initializer 的 JSON 顺序会影响结果，照 P4a 按顺序执行就对了。

### 点 5 — operator `turbulence`（B6）

- **新增** 记录和执行函数，有 blend（用现有的 `readBlend` / `blendFactor`）。字段与两套缺省值见 B6 表：`mask` 是向量，每轴非 0 才算这一轴，三轴全 0 时整个模块跳过；`speedmin` / `speedmax` 乘 `speed`（类型 7）；`timescale` 乘 `rate`（类型 2）；`phasemin` 解析但执行时**不读**（实测确认）。
- **执行**（照 B6 伪代码）：
  - `Ts = T·timescale`；`mk_i = k·mask_i`（**是 `k`**）；
  - 每个粒子：`φ = R·(phasemax − phasemin) + Ts`，`spd = R·srange + smin`（有 blend 时再乘 `b`）；
  - `X = (x + φ)·scale`，`Y`、`Z` 同理；按掩码只算需要的轴：`Nx = snoise3(X, Y, Z)`、`Ny = snoise3(Z, X, Y)`、`Nz = snoise3(Y, Z, X)`；
  - `v_i = (N_i·mk_i)·spd + v_i`。
  - 不置列标志，不用控制点。两遍模式时每遍用 `k/2`，两遍之间的位置变化会改变噪声输入，照常处理。

### 点 6 — 能力表

- **删除** 三个键：`particle:initializer:turbulentvelocityrandom`、`particle:initializer:positionoffsetrandom`、`particle:operator:turbulence`（模块表加记录后自动消失）。
- **保留**：三个模块上的 `audioprocessing*`（表外字段照报）；向量字段写成非字符串时报不支持（B「向量字段」：WPE 会把数字当指针用）；绑定与关键帧规则不变。

### 验收

真值数据都是步骤 0 抓的，代理不开 WPE：
- 轨迹：`tracks/rd-p4b-fps60.json`、`rd-p4b-fps10.json` 里的 `turb`、`turb-ph5`、`turb-xyz`、`turb-ovr`、`turbvel`、`turbvel-axes`、`posoffset-1`、`posoffset-6`、`posoffset-sign`；
- 日志：`out/p4b-fps60-log.txt`、`p4b-fps10-log.txt`。每行是 `帧号,frametime,runtime`，`runtime` 就是 `T`（6 位小数）。

回放照步骤 3 的工具（`ignore/p4/b3/`）：从磁盘编译 `proj/p4b`，按日志累计时间差分出 dt，`T` 用日志的 `runtime`，回放到抓帧的那几帧，逐粒子比。

- **噪声单测：** `snoise2`、`snoise1` 的真值按点 1 从 WPE 轨迹反推，钉进 `particles/fixtures/`（不依赖 `ignore/`）。限 1e-5（日志 `runtime` 只有 6 位小数，误差按此估计，超了先查输入精度）。
- **回放**（fps 60 和 fps 10 都要过）：
  - 限值同步骤 3：位置 1e-3，坐标大于 1000 时 2e-3；`turbulentvelocityrandom` 若受 `sinf` 的 1 ulp 影响超限，记录实际差值并说明。
  - `turb` 和 `turb-ph5` 在我们的模拟器里也逐位相同。
  - fps 10 时把 `turbulence` 的 `k` 换成 `h` 应该超限，用这一点证明乘的是 `k`。
  - `turb-ovr`（`speed 2`、`rate 0.5`）验证覆盖项：`speedmin/max` × 2，`timescale` × 0.5，`dt` × 0.5。
  - `T` 取本帧还是上一帧的 `g_Time`：两种都跑，写明哪种吻合。
- **变异检查**，以下各改坏一处都要有测试失败：
  - 常量表改一项（三张表各一次）；
  - `snoise2` 的梯度条件换成原版 `(h & 7) < 4`；
  - `snoise3` 的 `gi3` 换成原版 `perm[kk + 1]`；
  - `snoise3` 的顶点顺序换成原版（坐标相等时）——这一条如果轨迹测不出，要在单测里构造相等坐标测；
  - `turbulence` 用 `h` 不用 `k`、`timescale` 不乘 `rate`、`phasemin` 参与相位、三轴的参数顺序写错；
  - `turbulentvelocityrandom` 的两个 `uA` 顺序对调、`forward` 被归一化、速度覆盖而不是相加；
  - `positionoffsetrandom` 的 Z 轴时间不取负、`octaves` 不钳、fbm 不除以 `norm`。
- **语料**（和步骤 3 的语料输出比）：变化只在这三个模块键上，逐条解释；列出干净场景的变化（预计没有新增）。
- **预热期的 `T`（Claude 做）：** 另抓一个工程，`turbulence`、`turbulentvelocityrandom`、`positionoffsetrandom` 各带 `starttime 3`，看预热出生的粒子是否按 `T = 0` 算。
- **真实场景（Claude 做）：** 这一步预计不解锁新场景。挑一张只差噪声类和少数别的键的场景，用 dev 强制渲染和 WPE 并排看湍流形态。
- **哈希：** 30 组画面哈希不变（Claude 做）。

## 步骤 5 — `REFRACT` 与 `CUTOUT`

> 2026-11-08 按步骤 0、2 的结论重写，写成可以直接派发的版本。依据：[rea-p4b-render.md](rea-p4b-render.md) 第 6 节、2.3、2.7；报告「P4b 语义的实测核对」的折射一行；步骤 2 实施记录的最后一条。

### 思路

折射、裁切都是 `genericparticle` 自带的分支，数学全在着色器里，引擎只负责三件事：
- 定义 COMBO；
- 在本粒子对象画之前拷一份帧缓冲，绑到 `g_Texture3`；
- 写视图轴 `g_ViewRight`、`g_ViewUp`。

这三件我们大多已经有了，所以这一步主要是放开能力表，再和 WPE 逐像素比。

- **COMBO：**
  - `REFRACT`、`CUTOUT` 是材质写的普通 COMBO。
  - `NORMALMAP` 是采样器 COMBO：槽 1 按名字绑了纹理就定义，WPE 运行时不读注解里的 `require` / `requireany`（rea 6.2）。
  - `g_Texture1` 的声明在 `#if REFRACT || LIGHTING` 里，所以没开折射时 `NORMALMAP` 定义了也不起作用，语料 `2903412088` 就是这种情况。三个 COMBO 都放行即可。
- **法线解码：** 按 `TEX1FORMAT` 选（RGBA 走 `wx` 交换、RG88 走 `gr`）。`g_Texture1` 带 `formatcombo`，翻译器已按槽位写这个宏（引擎宏修正时落地），不用改。
- **快照：** 粒子层计划已经在本层前面放了一个 `snapshot`（`render/graph.ts` 的 `planParticleLayer`，`pass.framebuffer` 为真时），和 WPE「每对象每帧在第一个 renderer 画之前拷一次」的时机相同。
  - WPE 在存活数为 0 时不拷。我们照拷也看不出差别：读快照的每一层在读之前都会自己重拷，所以不改。
- **视图轴：** 步骤 0 的抓帧里，折射着色器第一次真的读了这两个量。实测正交、透视粒子都是 `g_ViewRight = (1, 0, 0)`、`g_ViewUp = (0, 1, 0)`（`ignore/p4/rdc_consts.py`，第 907 帧事件 78、185），和 `particleBuiltins` 现在写的相同。
  - 同一组抓帧还读到：`g_RefractAmount` 取材质值（0.2、缺省 0.05、0.1）；`g_CutoutStart` / `End` / `Opacity` 是 0.3 / 0.5 / 0.8；`g_Overbright` 是 1。都是普通材质常量。
- **D3D 坐标：** 翻译器恒定义 `HLSL`，`ComputeScreenRefractionTangents` 的 y 翻转、片元里 `#ifndef HLSL` 的翻转都按 D3D 走，WebGPU 的纹理坐标与 D3D 相同。
- **粒子其它槽位的帧表纹理：** 顺带放开。
  - WPE 只看**槽 0** 纹理的标志位来置 `0x1000000`（rea 2.3 `FUN_14015c470`），绑定时只取第 0 张图像（2.7）。
  - 槽 1 的帧表法线图因此只是一张普通纹理：片元用和槽 0 相同的 `v_TexCoord.xy` 采它。槽 0 是帧表时，这个 UV 已是帧内 UV，法线图只要和颜色图同样排帧就对得上。
  - 语料里这 7 处都是这样配对的：`particles 256x1280 blank` 配 `256x1280N`（6 张），`rain_drops_sheet` 配 `rain_drops_sheet_normal`（1 张）。
  - 这条是读码推出的【推】，所以补抓一组核对，见验收。

WPE 的场景目标开了 MSAA（快照是 `ResolveSubresource`，不是 Copy），我们没有。轴对齐、落在整像素上的四边形覆盖率是 0 或 1，Resolve 前后相同。步骤 0 的折射工程里图像层、粒子都是这样摆的，所以理论上逐像素相同；如果有差，先看是否只在边缘。

### 现状锚点

**a. 粒子 COMBO 只放行两个**（`compile/features.ts`，`PARTICLE_COMBOS`）
```ts
/** 粒子材质允许非 0 的 COMBO：`shimmering_particles` 自带 `particle` 着色器的分支，本节实现（总计划「P4a 实现」）。 */
const PARTICLE_COMBOS = new Set(["WORLDBLUR", "USERCOLORBLEND"]); // 现状：REFRACT、NORMALMAP、CUTOUT 报 particle:combo:<名字>
```

**b. 帧表纹理只在粒子槽 0 放行**（`compile/bundle.ts`，`compilePass` 里两处 `getTexture`，步骤 2 加的）
```ts
const texture = await getTexture(name, scope, issues, !!context.particle && slot === 0);
// …注解 default 的那一处同样是 `binding.slot === 0`
// 现状：粒子槽 1 的帧表法线图照报 tex:animation（7 处，都带 REFRACT / NORMALMAP）
```
`getTexture` 的第 4 个参数名是 `sheetSlot`，只在上报时过滤 `tex:animation`，缓存不变。帧表语义（`particleSheetDefines`、`SceneParticle.spriteSheet`）另按槽 0 的纹理定，和这个参数无关。

**c. 粒子层的快照**（`render/graph.ts`，`planParticleLayer`）
```ts
// 材质需要 `_rt_FullFrameBuffer` 时照图像层直接上屏的规则 1，在本层开始前拷一次快照。……这条没有和 WPE 比过。
if (pass.framebuffer) steps.push({ kind: "snapshot" });
```

**d. 视图轴**（`render/uniforms.ts`，`particleBuiltins`）
```ts
g_ViewUp: [0, 1, 0],
g_ViewRight: [1, 0, 0], // 现状：照语义给，P4a 时着色器没读；步骤 0 实测和 WPE 相同
```

### 点 1 — 能力表放行三个 COMBO（`compile/features.ts`）

- **修改** `PARTICLE_COMBOS` 加 `REFRACT`、`NORMALMAP`、`CUTOUT`，注释写明依据：`NORMALMAP` 按槽位定义，不看 `require`；没开折射时不起作用。
```ts
/**
 * 粒子材质允许非 0 的 COMBO（`genericparticle` 自带的分支）：
 * - `WORLDBLUR`、`USERCOLORBLEND`：P4a（`shimmering_particles` 的项目 `particle` 着色器）；
 * - `REFRACT`、`CUTOUT`：P4b 步骤 5，快照时机与常量和 WPE 逐像素核对过；
 * - `NORMALMAP`：槽 1 按名字绑了纹理就定义（rea-p4b-render 6.2），`g_Texture1` 在 `#if REFRACT || LIGHTING` 里，没开折射时不起作用。
 */
const PARTICLE_COMBOS = new Set(["WORLDBLUR", "USERCOLORBLEND", "REFRACT", "CUTOUT", "NORMALMAP"]);
```
- `particle:lighting` 不动：`LIGHTING` 仍报。

### 点 2 — 粒子其它槽位的帧表纹理当普通纹理（`compile/bundle.ts`）

- **修改** 两处 `getTexture` 的 `sheetSlot`：从「粒子且槽 0」改成「粒子」，参数改名为 `particleSlot` 一类，注释写明只有槽 0 带帧表语义。
```ts
const texture = await getTexture(name, scope, issues, !!context.particle); // 修改：粒子材质的任何槽位都不报 tex:animation
```
- `tex:animation:multi-image`、`tex:animation:empty` 不受影响，照报。
- 图像层、effect 材质照旧报 `tex:animation`（图像层帧动画属 P6）。

### 点 3 — 快照与渲染（`render/graph.ts`、`render/scene.ts`）

不改代码，只改注释：把 `planParticleLayer` 的「没有和 WPE 比过」改成核对结论，并写明存活数为 0 时照拷也不影响画面的理由。验收发现差异时再改。

### 验收

**真值数据：**
- **已有的：** 步骤 0 已抓。
  - 工程 `ignore/p4/proj/p4b-refract`，对象顺序：图像 A → `P` → 图像 B → `Q` → `R` → `CUT` → `P0` → `PP`。
    - `P`：`REFRACT` 加 RGBA 法线 `drop_normal`，强度 0.2；
    - `Q`：只有 `REFRACT`；
    - `R`：`REFRACT` 加 RG88 法线 `smoke2normal`，强度 0.1；
    - `CUT`：`CUTOUT`，R8 的 `lambda`；
    - `P0`：寿命 0.3 s，有的帧没有存活粒子；
    - `PP`：透视粒子。
  - 抓帧 `A:\p4b\p4b-refract-fps60`（4 帧，RenderDoc 帧 906–909，脚本帧 907–910），轨迹 `ignore/p4/tracks/rd-p4b-refract-fps60.json`，日志 `ignore/p4/out/p4b-refract-fps60-log.txt`。
- **要补抓的：** 一组 `p4b-refract2`，在 `ignore/p4/gen_b.py` 加一个工程函数：
  - `S`：`REFRACT`，槽 0 帧表 `particle/water/rain_drops_sheet`，槽 1 帧表法线 `particle/water/rain_drops_sheet_normal`（两张都在 WPE `assets`），向右运动、寿命 3 s，同时有几个粒子在不同帧；
  - `N0`：槽 1 绑了 `particle/drop_normal`、**不开** `REFRACT`，对照组是同一纹理不绑槽 1 的 `N1`，两者应逐像素相同；
  - 背景放一张有纹理的图像层（同 `p4b-refract` 的 `kbr/plant1`）。
- **补抓的步骤：**
  - 命令：`python -X utf8 -I ignore/p4/sweep_b.py 60 p4b-refract2:4`。
  - WPE 必须先退出：
    - 用户启动的 WPE，请用户从托盘退出；
    - 如果在运行的 WPE 是上一次 `sweep_b.py` 的 `--relaunch` 拉起的，核对进程号和启动时间后可以结束（`rd stop --relaunch` 的输出里有 `relaunched` 进程号）。
  - 跑完会自动 `stop --relaunch` 还原 `config.json`。用户的桌面壁纸是网页壁纸时，工具会误报「没有窗口」，看 `webwallpaper64.exe` 是否在运行即可。
  - 再用 `ignore/p4/rdc_track_b.py A:/p4b/p4b-refract2-fps60 p4b-refract2-fps60 p4b-refract2` 提取轨迹，用 `ignore/p4/step4/wpe_rt.py A:/p4b/<标签> <名字>` 导出整帧。

**比较：**
- **整帧像素：** 照步骤 2 的做法，复用 `ignore/p4/b2v/`：
  - `cases.test.ts` 生成按 WPE 日志 dt 回放的用例；
  - `real.mjs --cases` 在屏外宿主渲染，测试工程先用 `ignore/p4/b1/import.mjs` 导入；
  - `cmp.py` 改坐标后逐像素比；
  - 测完用 `ignore/p4/b1/cleanup.mjs` 经 `batch_remove_images` 移除测试行。
  - 这几个工程的随机范围都收成 min = max，没有 `randomframe`，不用注入 `R`。
  - **限值：** `p4b-refract` 的 4 帧、`p4b-refract2` 的全部帧，除帧号与时钟图层外逐像素相同；有差时列出位置，判断是不是 MSAA 边缘。
- **快照次数：** 用 `ignore/p4/rdc_events.py` 列 WPE 每帧的 Resolve 事件；我们这边在 dev 探针里数粒子层的 `snapshot` 操作。两边每帧的快照对象一一对应，`P0` 没有存活粒子的帧除外：WPE 不拷，我们照拷，画面不受影响，要写明。
- **常量：** 我们渲染时 `g_ViewRight`、`g_ViewUp`、`g_RefractAmount`、`g_Cutout*` 的值和上面「思路」里 WPE 的实测值相同，可以用单测钉住。
- **语料：**
  - 变化只在 `particle:combo:REFRACT`（15 张）、`particle:combo:NORMALMAP`（15 张，两者合计 16 张），以及这 7 处 `tex:animation`（粒子槽 1）上，逐条解释；`CUTOUT` 语料 0 张。
  - 预计不解锁新场景：离得最近的 `1333579536` 还差子系统和 passthrough 模型。
  - 放开后这 16 张第一次编完折射材质，可能带出新的不支持项，要逐条列出。
- **变异检查：** 以下各改坏一处，都要有测试失败：
  - `PARTICLE_COMBOS` 漏掉其中一个；
  - 粒子槽 1 的帧表纹理照报；
  - 图像层的帧表纹理也被放行；
  - `particleBuiltins` 的 `g_ViewUp` 写成 `(0, −1, 0)`；
  - 粒子层不放 `snapshot`。
- **哈希：** 30 组画面哈希和翻译器修复提交之后的基线比，应全部相同。步骤 2 时 `2418800402` 因翻译器修复变了，基线要用修复后的，见步骤 2 实施记录。

## 步骤 6 — `instanceoverride.colorn`

`colorn` 挡住 60 张，是粒子里最多的一项，其中 27 张绑了用户属性（颜色选择器）。它是 P4a 步骤 5 留下的：HSV 路径没读全，只要写了就报 `particle:instance:colorn`。

- **修改** `ParticleInstance.colorn` 走 HSV 路径；系统 `0x200000` 时直接作实例颜色。公式按步骤 0 的第 7 项。
- **修改** `BindingTarget` 的 `particle-instance` 支持向量字段 `colorn`，用户改色就地生效，不重编译。
- **删除** 能力表的 `particle:instance:colorn`；`brightness`（HDR）照旧。

**验收：**
- `proj/p4b-color`：几种 `colorn` 配不同的 `colorrandom`，和 WPE 比新粒子颜色。
- 改颜色属性不重编译，已有粒子保留原颜色（同 P4a 的 `instanceoverride` 实测）。
- 语料里不再被 `colorn` 挡住的场景逐条列出，30 组画面哈希不变。

## P4b 收尾

和 P4a 一样，步骤 6 之后统一写 `cocs/wpe/WPE_SCENE.md`、changelog 和回归文档，并更新总计划的覆盖数。

## 决定

1. `colorn` 纳入 P4b，作为步骤 6（2026-11-08 用户）。它是粒子里挡场景最多的一项，和 P4a 步骤 5 是同一条绑定路径。
2. DXT1（格式 7）、DXT3（格式 6）在步骤 1 一起放开（2026-11-08 用户）。PLAN 原把 DXT3 排在 W6，DXT1 没有排。

## 风险

1. **噪声移植是本节最大的不确定性。** WPE 的噪声如果依赖 SIMD 指令的特定舍入，float32 移植也可能有 ulp 级差异，长程会放大。限值先按步骤 3 的标准，超了再分析是精度问题还是公式错。
2. **帧表的宏和顶点格式第一次进粒子路径。** `THICKFORMAT` 改变顶点布局，`vertexPacking` 要按反射排，不能写死，否则会影响没有帧表的系统。
3. **解锁的场景少。** 步骤 2、4、5 都不解锁新场景，主要靠确定性工程验收。
4. **R8 纹理用得广（81 张）。** 放开后，部分场景会第一次走到后面的编译阶段，可能暴露新的不支持项。语料比较要逐条解释，不能只看干净数。
5. **`rcpps` 不复刻。** 位置比较要留余量。如果某个模块的近似误差会累积（例如每帧都乘一次近似倒数），限值要按帧数放宽，并在实施记录里写明。

## 实施记录

### 步骤 0 — 调研（2026-11-08）

两个子代理读码，Claude 设计并抓取确定性工程、独立核对。没有改产品代码。

- **读码：** [rea-p4b-modules.md](rea-p4b-modules.md)（发射、档 2 模块、三个噪声函数，常量表在 `ignore/p4/rea/p4b-mod/noise-tables.json`）、[rea-p4b-render.md](rea-p4b-render.md)（纹理格式、帧表、折射、`colorn`）。Claude 抽查了两条最反直觉的：`turbulence` 用的是解释器第三个参数 `k`（`0x14023fbfa` 广播、`0x140240290` 每条重装），`snoise2` 的梯度判断是 `test al, 0x3c`。两条都对。
- **实测：** 结论写在 [报告](p4-particles-REPORT.md)「P4b 语义的实测核对」。17 条里 16 条成立，**推翻 1 条**：`colorchange` 加 `colorn` 时，终止色平移后是 `(0, 0, 0)`，不是读码预测的 `(1, 0, 0)`。
- **四个要直接回答的问题：**
  - **alpha-priority：** 中性，步骤 1 删掉 `tex:alpha-priority`。
  - **系统 `flags` bit1：** 读取点找到了，作用只是关掉 `SPRITESHEETBLEND`（`randomframe` 也会置它），步骤 2 实现。
  - **`1838478131`：** 控制点 0 的 `flags 1` 跟随指针，归 P4c。
  - **周期发射：** 时序和读码一致，满容量冻结留给步骤 3 回放。
- **数据：** 6 个工程、7 组抓帧，见报告开头一段。后续各步按 `out/p4b*-log.txt` 的 dt 回放。

对后续各步的影响：

- **步骤 1：** DXGI 格式和计划里的表一致。`TEX0FORMAT` WPE 只对格式 8–11（或非 `screen` 朝向）写；P4a 对粒子无条件写，格式 0、4 时着色器分支相同，画面不受影响，但缓存键可以按 WPE 收窄。
- **步骤 2：**
  - 宏的条件：`SPRITESHEET` 一定伴随 `THICKFORMAT`；`SPRITESHEETBLEND` = 系统 `flags` 没有 bit1 且不是 `randomframe`；`SPRITESHEETBLENDNPOT` 只比宽度（图像宽 < 纹理宽）。
  - `g_RenderVar1` 只用第 0 帧：`(帧宽 / 纹理宽, 帧高 / 纹理高, 帧数, (纹理高 / 纹理宽) · (帧高 / 帧宽))`，坐标按第 0 级 mip 归一化。
  - `0x1000000` 的置位条件是材质槽 0 纹理的头标志 bit2。
  - 多图像帧表继续报不支持。
- **步骤 3：**
  - `boxrandom` 的 `distancemin` / `distancemax` 是向量、只接受字符串。
  - `instantaneous` 不乘 `count`，`maxtoemitperperiod` 乘。
  - `sizechange` 的两个值乘 `instanceoverride.size`。
  - `vortex` 乘 `k`；中心是控制点平移加 `offset`，`offset` 不旋转。
- **步骤 4：**
  - 三个噪声函数照 WPE 移植，不能用开源原版：二维噪声的梯度条件不同，三维噪声第 4 个角的哈希不同。
  - 场景时间 `T` 要进模拟器。
  - `turbulence` 乘 `k`，不读 `phasemin`。
  - `turbulentvelocityrandom` 用 CRT 的 `sinf` / `cosf`，和 `Math.sin` 可能差 1 ulp。
- **步骤 5：** WPE 的场景目标开了 MSAA（快照是 Resolve），边缘像素可能对不上，比较时要单独统计边缘。
- **步骤 6：** 先补读 `colorchange` 的 `0xc` 记录，解释终止色为什么是 0。系统色取自颜色模块，不是粒子 JSON 的 `colorn` 键（改 rea-p4a C5）。

工具在 `ignore/p4/`：`gen_b.py`、`sweep_b.py`、`rdc_track_b.py`、`rdc_cols.py`、`rdc_events.py`、`check_b.py`、`ana_b.py`、`ana_emit.py`、`ana_color.py`、`ana_cchange.py`、`cmp_ap.py`；DXT1 / DXT3 纹理从语料导出在 `texsrc/`。

### 步骤 1 — 纹理格式（2026-11-08）

子代理实现，Claude 独立验收。

- **修改** `compile/tex.ts`：新增 `TEXTURE_FORMATS`（0、4、6、7、8、9），是格式支持范围的唯一来源；编译期、渲染器（`render/textures.ts` 改为导入）、能力表的 `SUPPORTED.textureFormats` 都读它。格式检查改成「表里没有才报」；FreeImage 形态仍只收格式 0（`planBitmapUpload` 只认 0）。
- **删除** `tex:alpha-priority`，`TEX_FLAGS.alphaPriority` 留作文档。
- **修改** `compile/bundle.ts`：粒子 `TEX0FORMAT` 只在槽 0 格式是 8–11 时写（`particleWritesTex0Format`），照 WPE。
- **修改** `compile/pipeline.test.ts`：语料快速路径的请求上限 150 → 200。R8 放开后 `3820104696` 要编完 7 个 effect、15 张纹理才遇到第一个不支持项，169 次请求，每个资源各查一次，没有重复。
- Claude 验收时另改：`compile/tex.test.ts` 的 1 MB mip 比较从 `toEqual` 改成逐字节比较（原写法单独跑 5.6 秒，会超时）；dev 探针 `renderFrame` 加可选的 `pointer`（`g_PointerPosition`，和 WPE 抓帧比时填抓帧里的值）。

验收结果：

| 项 | 结果 |
|---|---|
| tsc、vitest、Prettier | 0 error；34 个文件、950 个用例全过（新增 38 个）；格式通过 |
| 变异检查（代理 10 处、Claude 8 处） | BC1 / BC2 / R8 / RG88 字节数、DXT1 映射、格式 9 删掉、`TEX0FORMAT` 边界、FreeImage 守卫、BC 行跨度，各有用例失败。Claude 的一处（`textureFormat` 走原型链）和原代码等价，不算 |
| 语料（和步骤 1 前比） | 干净场景 14 → 18，新增正好是 `2854083091`、`3799426930`、`3812822229`、`3829603837`；去掉的只有 `tex:format:6/7/8/9` 与 `tex:alpha-priority`，没有新增键 |
| 纹理和 WPE 逐像素比（`p4b-tex` 的静态格式区域，子集工程 `p4b-tex1` 回放 WPE 日志 dt） | R8、RG88、DXT3、alpha-priority 有无、NPOT 粒子 0 个像素不同；DXT1 粒子 15 个像素、R8 图像层 45 个、RG88 图像层 2 个，都只差 1 个色阶 |
| 四张场景和 WPE 比（按场景分辨率开窗口重抓，WPE 窗口高度被屏幕压到 2130，cover 比例 1、上下各裁 15 行，逐像素） | `3799426930` 1.3% 像素不同；`3812822229` 3.7%；`3829603837` 35%；`2854083091`（4000×2667，有缩放，按抓帧里的指针渲染）构图和画面一致 |
| 真机哈希 | 10 张干净场景 × 三档，30 组和 P4a 步骤 5 全部相同 |

**发现的翻译器问题：** 三张差异都落在 `foliagesway` 的遮罩区域，其余部分逐像素一致。原因是翻译器把两个阶段的同名 uniform 合成一个、只留第一次声明的注解：`foliagesway` 的顶点 `g_Speed` 绑 `speed`（缺省 1），片元绑 `speeduv`（5），我们的片元拿到 1，摇摆慢 5 倍。WPE 两个阶段的常量缓冲分开（RenderDoc：片元 `g_Speed = 5`）。时间扫描 ±0.3 s 误差不变，排除了相位；按场景分辨率重抓排除了 mip 选择。assets 里还有 `perspective`（4 个 uniform 缺省值不同）和 `clouds`（同键不同类型）。用户定先修翻译器再提交（2026-11-08），见下一节。

测试行 13818（`p4b-tex`）、13819（`p4b-tex1`）已用 `batch_remove_images` 移除，导入任务已删。工具在 `ignore/p4/b1/`：`mutate.py`、`diff_corpus.py`、`real.mjs`（`--cases`）、`cmp.py`、`cmp_n.py`、`heat.py`、`tsweep.mjs`、`stage_uniforms.py`、`import.mjs`、`cleanup.mjs`、`hash-after.json`；抓帧在 `A:\p4b\<id>-fps60[-<宽x高>]`。

### 步骤 1 补充 — 翻译器按阶段拆分同名 uniform（2026-11-08）

子代理实现，Claude 独立验收。

- **修改** `src-tauri/wpesl2wgsl/src/rewrite.rs`：普通 uniform 先按阶段各自收集，再由 `merge_uniforms` 跨阶段合并或拆分。
  - 取值来源：有字符串 `material` 的是材质常量，来源 = (`material`, `default`)，`default` 按数字列表比较；其余算引擎值。
  - 类型和来源都相同才合并，没有冲突的着色器输出逐字节不变。否则拆成两格：片元一侧改名 `kb_fs_<名字>`；材质常量对引擎值时，改材质常量那一侧，引擎值永远保留原名。两侧都是引擎值而类型不同，照旧报错。
- **修改** `lib.rs`：反射 `Uniform` 加 `stage`、`original`。README 新增「两阶段同名 uniform」一节。
- **修改** 宿主：`shaderUniforms` 按材质键分组，同键的两格都写；同键不同类型、又给了值时报 `constant:mixed-type:<键>`，因为 WPE 的向量补齐规则没查到。
- 语料扫描：assets、默认工程和 144 个工坊项目共 16 组冲突。同时生效的有三处：`foliagesway`（33 个工坊项目各带一份）、`perspective` 的旧版预览着色器、工坊 `frame_builder`。`clouds`、`auto_sway` 的两侧在不同条件分支里，不会同时出现。

验收结果：

| 项 | 结果 |
|---|---|
| Rust | 43 个单测加语料集成测试全过（语料 158/167 不变）；`cargo fmt --check` 通过。Claude 重编 wasm，和拷进宿主的逐字节相同 |
| tsc、vitest、Prettier | 0 error；35 个文件、957 个用例全过；格式通过 |
| 变异检查（代理 10 处、Claude 4 处） | 不比缺省值、引擎一侧被改名、改名前缀错、拆分不标阶段、绑定只写第一格等，各有用例失败 |
| 语料 | 干净场景 18 不变；`frame_builder` 越过两阶段类型冲突后，停在一个无关的 naga 校验错误 |
| `foliagesway` 三张和 WPE 逐像素比（3840×2130 重抓） | `3799426930` 0.03%、`3812822229` 0.04%、`3829603837` 0.07% 像素不同，几乎都只差 1（修正前 1.3%、3.7%、35%） |
| 真机哈希 | 30 组里 27 组不变；`2418800402`（凝光，自带 `foliagesway`）三档都变。按 1024×575 抓 WPE 逐像素比：差 1 的 12.7 万像素、差 2 的 1.3 万，超过 8 的 81 个，是全图 4×4 方块状的解码舍入；画面一致，变化是修正带来的 |

验收用的宿主构建和测试都在分叉会话开始改步骤 2（03:17）之前。

**待办（不属于本节）：** 材质常量写成单个数字、uniform 是向量时，我们只填 x 分量；WPE 的 vec3 setter 会把这个数铺满三个分量。

### 步骤 2 — 粒子帧表（2026-11-08）

子代理实现，Claude 独立验收。在步骤 1 与翻译器修复的未提交改动之上做，没有碰 `compile/shader.ts` 和翻译器。

- **修改** `compile/tex.ts`：
  - 解析 TEXS 帧表（`TexFrame`，v1 坐标按 i32、v2 / v3 按 f32，按所在图像的第 0 级 mip 归一化，`imageId` 越界时坐标为 0）。
  - `tex:animation` 照报但不再挡解码。
  - 新增 `tex:animation:multi-image`、`tex:animation:empty`。
- **修改** `compile/bundle.ts`：
  - 新增 `SceneTexture.sheet`（`renderVar1`、`npot`）。
  - `getTexture` 按用途过滤：只在粒子槽 0 去掉 `tex:animation`，缓存不变。
  - `PassContext.particle` 改成系统描述（`flags`、`animationMode`），`particleSheetDefines` 写 `THICKFORMAT`、`SPRITESHEET`、`SPRITESHEETBLEND`、`SPRITESHEETBLENDNPOT`（值为 0 也写键）。
  - `compileParticle` 填 `SceneParticle.spriteSheet`。
- **修改** 模拟器：
  - `sequenceFrames()` 放在判死之后、发射之前。
  - 构造函数加可选的 `R` 替换（`injectedR`，只给 dev 探针与回放工具用，生产构建里只剩一个可选参数）。
- **修改** 顶点：`a_TexCoordVec4C1 = (vx, vy, vz, frame 原值)`。
- **修改** uniform：`particleBuiltins(sheet)` 写 `g_RenderVar1`。
- **修改** 能力表：删掉 `particle:animationmode`、`particle:sequencemultiplier`、`particle:flags:2`。
- **修改** dev 探针：`renderFrame`、`particleCorners`、`particleTrack` 都收 `particles.random`。

和计划不同、或计划没写、由代理按证据定的：
- **「序列帧放在发射之后」的变异：** 新生粒子 `age = 0`，两种顺序 frame 相同，只能用 `sequencemultiplier: -1` 时 `+0` / `−0` 的差别测出来。
- **`tex:animation:empty`：** 在读完 mip 之后才能判断，所以不挡解码。
- **FreeImage 帧表**（语料 3 张）：沿用 `freeImageTextureSize`，纹理尺寸取图像尺寸，没和 WPE 比过。
- **粒子槽 1 的帧表法线图**（7 处，都带 `REFRACT` / `NORMALMAP`）：照计划仍报 `tex:animation`。WPE 只按槽 0 置 `0x1000000`，片元用同一个 UV 采槽 1，所以这里报得偏保守，步骤 5 再定。

验收结果：

| 项 | 结果 |
|---|---|
| tsc、vitest、Prettier | 0 error；37 个文件、996 个用例全过（新增 39 个）；改过的 17 个文件格式通过 |
| 变异检查（代理 12 处、Claude 5 处） | 计划列的 7 处加额外 5 处；Claude 另改坏帧宽高比用图像尺寸、速度分量写反、过滤时连缓存一起改、`randomframe` 每帧重算、帧时长按整数读，各有用例失败；源码按原字节还原 |
| frame 回放（`ignore/p4/b2/replay.test.ts`，WPE 日志 dt，3 帧 × 15 个帧表系统） | 粒子数一致，速度逐位相同；frame 相对差 2.44e-4–2.48e-4（WPE `rcpps(3)` 的固定偏差，限 4e-4）；`sequencemultiplier` 2、3 的倍数关系成立，大于 1 不回绕；`s-rand` 注入 WPE 的 `R` 后 frame 逐位相同 |
| 整帧像素（Claude，屏外宿主回放 WPE 日志 dt、注入 `s-rand` 的 `R`，3 帧逐像素） | 不同像素 938–1146 个（排除帧号与时钟图层），最大差 2 个色阶，没有大于 3 的；`s-flag2`（混帧关）、`s-rand` 0 个像素不同；其余帧表系统的差来自混帧系数（`rcpps`）；非帧表区域和步骤 1 逐像素相同（图像层 47 个、DXT1 粒子 15 个，都是 1 个色阶） |
| 语料 | 去掉的键：`tex:animation` 46 张、`particle:animationmode` 39、`particle:sequencemultiplier` 35、`particle:flags:2` 12；没有新增键，干净场景 18 → 18。`1504316159`、`3820104696` 只差 `alpharandom`。语料里用帧表的粒子材质全是内置 `genericparticle`，102 组全部翻译成功 |
| 真机哈希 | 30 组里 27 组和步骤 1 相同；`2418800402` 三档都变，它没有粒子、没有帧表纹理，变化来自翻译器修复（同名 uniform 按阶段拆分，见上一节），和步骤 2 无关 |

测试行 14101（`p4b-tex`）已用 `batch_remove_images` 移除，导入任务已删。工具：代理的在 `ignore/p4/b2/`（`replay.test.ts`、`corpus.test.ts`、`mutate.py`、`explain.py`、`sheets.py`，结果在 `out/`）；Claude 的在 `ignore/p4/b2v/`（`cases.test.ts`、`real.mjs`、`cmp.py`、`hash_input.py`，结果与热图在 `out/`）。

### 步骤 3 — 发射时序、`boxrandom` 与确定性模块（2026-11-08）

子代理实现，Claude 独立验收（见本节末尾）。在步骤 1、2 与翻译器修复的未提交改动之上做，只改了 `particles/` 下的文件和测试，没有碰 `compile/shader.ts`、翻译器、`render/`；`compile/features.ts` 没改（能力表从模块表生成）。

- **修改** `particles/emitters.ts`：
  - `EmitterState` 加 `burst`、`period`，`emitterState` / `resetEmitterTiming` 一起清零。
  - `emissionCount` 多收随机源，照 A1–A3 补上周期两态计时（流 A，不补零头）、bit1、`maxtoemitperperiod` 限额和 `duration < 0` 分支。满容量或 `delay > 0` 时整段跳过、计时冻结。帧尾读记录里的 `rate`，不是间歇里乘了 0 的那个。
  - 新增 `boxRandom`（A4）和 `fastInvSqrt`（`0x5f375a86` 加一次牛顿迭代，只用于回退判断）。
- **修改** `particles/modules.ts`：
  - 发射公共字段 `EMITTER_FIELDS` 与 `normalizeEmitter`（周期字段 `min = min(min, max)`），`sphererandom`、`boxrandom` 共用。`flags` 支持 bit0–2。
  - 字段定义加 `truncate`（条目类型 1），`resolveParticleFields` 乘完 `instanceoverride` 再截断，只用在 `maxtoemitperperiod`。
  - 加 8 条记录：`boxrandom`、`alpharandom`、`sizechange`、`alphachange`、`colorchange`、`oscillatesize`、`vortex`、`capvelocity`。
- **修改** `particles/initializers.ts`：`alphaRandom`，写 alpha 初值列。
- **修改** `particles/operators.ts`：六个 operator，加 `saturatePs`（`minps` 再 `maxps`，NaN 得 1）。
- **修改** `particles/f32.ts`：新增 `rsqrt`（WPE `rsqrtps` 的位置，按精确值算）。和 `rcp` 一样只在近似指令的位置调用，回放工具靠这两个函数加偏置算包络。
- **修改** `particles/system.ts`：`emit` 把随机源传给 `emissionCount`。
- **测试**：
  - 新增 `particles/emission.test.ts`（22 个）、`particles/tier2.test.ts`（24 个）。
  - `compile/particles.test.ts` 更新模块表、两套缺省值、能力表的用例（+13 个）。
  - `simulator.test.ts` 里「表外模块」的例子换成 `turbulence`；`lifecycle.test.ts` 的复位断言多两项。

和计划不同、或计划没写、由代理按证据定的：

- **`box-line` 的形状公式：** 计划写 `|x − 900| = 100 + 50·age`，应为 `100 + 50·(age + 出生帧 dt)`：新粒子出生当帧 `age = 0`，但照常走完那一帧。WPE 的粒子按这个式子最大偏差 4.6e-4（`box-zero` 7.7e-4）。
- **bit1 加 `instantaneous`：** rea A 节「建议的实验」预测「第一帧 5 + 1 个，之后每帧正好 1 个」，漏了 `instantaneous` 的欠账：`acc` 被扣成负数，之后要等一两帧才继续发。WPE 每帧粒子数和这个算法逐帧一致。
- **回放限值用「近似运算包络」：**
  - 基础限值同 P4a。另把产品代码 `f32` 的 `rcp`、`rsqrt` 换成乘 `(1 ± 3.7e-4)` 的版本，四种符号组合各跑一遍；逐粒子逐分量取 `|偏置 − 精确|` 的最大值，加到基础限值上。
  - `vortex` 每帧都有 `rsqrt`，`capvelocity` 每次截速一次，这样得出的限值是按帧数累积的。
  - 基础限值的坐标分档按粒子出生以来的最大坐标：`box-line` 往左走的粒子当前坐标小，但历史上在 800–1000，float32 累加误差按历史量级算。
- **`vortex-*` 的符号：** 出生点在中心 ±200，符号随机。先和 WPE 比直接、关于中心对称两种情况，定出每个粒子的符号；再把那一次 `cosθ` 的 uA 换成 `1 − uA` 重跑（`cosθ` 精确取反），逐粒子直接比。核对过每粒子正好 11 次抽取。
- **`oscsize`：** 工程里频率、相位的范围都是 0，`R` 只进幅度，`size` 对 `R` 线性。注入 `R = 0` 和 `1` 各跑一遍，求出每个出生序号的 `R`（每个粒子取斜率最大的那帧），注入后再和其余各帧比。
- **fps 10 日志缺第 151、152 帧：** 日志每 50 帧刷一次，只到第 150 帧。
  - 两帧合计 0.198864 s，由轨迹的 `time` 反推（同一个钟，其它 tag 上核对过）。
  - 先平分，出生在这两帧的粒子（cap-* 各 6 个）不比：两遍模式下截速粒子出生帧走 `(300 + 100)/2·dt`，对拆分敏感。
  - 再用这些粒子各自反推第 152 帧 dt：cap-300 / 250 / 173 的 18 个值在 2.3e-5 以内一致，中位数 0.099521（平分是 0.099432）。按它重跑，全部粒子都在限内。
- **读码没写死、按推断实现的：**
  - `fastInvSqrt` 的牛顿式取经典写法 `y·(1.5 − 0.5x·y·y)`。单测钉住临界点：`|d| = 0.9995e-4` 时精确平方根判回退，近似值判不回退。
  - `vortex` 的 `axis` 用除法归一化；语料和工程里都是单位轴。
  - `capvelocity` 在 `v = 0` 时跳过。`maxspeed = 0` 时 WPE 是 `inf·0 = NaN`【推】。
- **并行会话：** 工作区里另有会话在改 `compile/shader.ts`、`bindings.ts`、`bundle.ts`、`host.ts`、`render/state.ts`、`script/api.ts`、`materialValues.ts` 和 wasm。
  - 验收用 `ignore/p4/b3/ov`：步骤 3 前的快照 `base/src` 叠上本步改过的 11 个文件。变异也在这份拷贝上改，不碰 `apps/wpe-scene`。
  - 回放在 `ov` 和工作区各跑一遍，结果逐字相同。

验收结果：

| 项 | 结果 |
|---|---|
| tsc、vitest、Prettier | 工作区 tsc 0 error；`ov`（快照 + 本步）39 个文件、1055 个用例全过（快照 37 个文件、996 个，新增 59 个）；工作区（含并行会话的改动）收尾时 40 个文件、1074 个用例全过；改过的 11 个文件格式通过 |
| 模块回放 fps 60（1 遍，6 帧） | 全部 15 个系统在限内。alpharandom、size-ovr / size-ref 位置 6e-5、尺寸与 alpha 0 差；`size-ovr` 正好是 `size-ref` 的 2 倍（40 / 20，两边都是）。sizechange 尺寸 5.4e-3（包络 1.65e-2）；colorchange 颜色 4.8e-4；alphachange alpha 7.1e-4。oscsize 尺寸 5e-5；oscsize-blend 尺寸 8.5e-3（包络 1.3e-2，来自 blend 的 `rcp`） |
| `capvelocity` | WPE 截后速度 99.9926–99.9929（初速 300、250），初速 173 时 99.9977–99.9979，我们 100.0000；第一步比例差 7.3e-5、2.2e-5。位置差：fps 60 为 7.1e-3、7.1e-3、2.2e-3，cap-blend 1.2e-2；fps 10 为 7.5e-3、7.4e-3、2.2e-3，cap-blend 1.6e-2。都不到包络限值的 0.62 |
| `vortex` | 位置差：fps 60 为 0.44、0.36、0.38 px（坐标到 3900–5200，包络 1.6–1.8 px，差 / 限 ≤ 0.37）；fps 10 为 0.30、0.41、0.41 px（包络 0.9–1.0 px，差 / 限 ≤ 0.46）。`k` 换成 `h`：fps 60 差 / 限 1.9–2.1（只有抓帧的 5 帧 dt > 0.025），fps 10 为 2655–2843，都超限，说明乘的是 `k` |
| 模块回放 fps 10（2 遍） | 平分一轮跳过 18 个粒子，其余在限内；按反推的拆分重跑，全部 15 个系统在限内 |
| 发射回放（`p4b-emit`，fps 60，6 帧） | `delay-dur`、`bit1`、`periodic`、`periodic-full`、`periodic-bit1`、`periodic-count` 每帧粒子数一致，逐粒子位置 ≤ 1.2e-3（坐标 1664），出生帧逐个对上。`box-line`、`box-zero` 逐粒子比 `|x − 900|` ≤ 1.4e-3。`box-corner` 每帧粒子数一致（100、101、100…），两边都没有角块外的粒子：WPE 50.10–99.25、均值 75.00，我们 50.71–99.69、均值 74.60，四个象限都有 |
| P4a 回放（`p4-0`、`p4a2` 共 9 个 tag，产品代码跑 `capvelocity`，回放工具不再补模块） | 全部系统在限内，`pre-small`、`pre-big`、`osc-r`、`osc-y` 照 P4a 不比。`o2-cap-ab` / `ba` 位置差 2.1e-3–2.6e-3，包络 1.1e-2–1.3e-2，差 / 限 ≤ 0.20；`p4-0` 编译不再有不支持项 |
| 变异检查（33 处） | 计划列的 20 处（「限额不扣 burst」「补零头」各拆两处）和额外 13 处都有用例失败。额外的包括：周期时长从流 B 抽、帧尾用乘了 0 的 `rate`、方向用 `q` 本身、回退阈值用精确平方根、`inner = outer` 时不取 1、`axis` 判零阈值、`maxspeed` 乘 `speed`、`t` 按秒算、`alphachange` 写初值列、颜色 ÷255、blend 漏 `smin − 1`、周期字段不做 `min(min, max)`、`flags` 放行 bit3。源码按原字节还原（`ignore/p4/b3/out/mutate.txt`） |
| 语料（和步骤 2 的 `b2/out/after.json` 比；快照的语料与它逐张相同） | 干净场景 18 → 20，新增正好是 `1504316159`、`3820104696`，两张都只差 `alpharandom`。去掉的键都在点 5 的范围里：`boxrandom` 37、`sizechange` 35、`alpharandom` 33、`sphererandom:flags` 22（语料里 `flags` 只有 2、4）、`vortex` 13、`oscillatesize` 9、`colorchange` 6、`alphachange` 2，以及周期四个字段 2、`maxtoemitperperiod` 1。新增的键只有 `audioprocessing*`：`boxrandom` 上 4 张、`vortex` 上 3 张，`audioprocessingmode` 都是 3（开着），P4e 照报。没有场景把距离写成数字，也没有 `vortex` 的 `controlpoint` / `flags` 问题 |

工具在 `ignore/p4/b3/`：`replay.test.ts`、`corpus.test.ts`、`mutate.py`、`explain.py`、`vitest.config.ts`，`ov/`（快照 + 本步）与 `ovbase/`（快照），结果在 `out/`（`replay.txt`、`replay.json`、`mutate.txt`、`before.json`、`after.json`、`explain.txt`）。

Claude 独立验收：

| 项 | 结果 |
|---|---|
| 改动范围（对派发前拷的 `ignore/p4/b3/base/src`） | 代理只改了 `particles/` 下 10 个文件和 `compile/particles.test.ts`；同期的其余改动（`bindings.ts`、`bundle.ts`、`shader.ts`、`materialValues.ts`、`host.ts`、`render/state.ts`、`script/api.ts`、wasm）是另一个会话的「步骤 1 补充 2」 |
| 读码对照 | `emissionCount`、`boxRandom`、6 个 operator、`alphaRandom` 和 8 条模块记录逐条对 rea A1–A4、B1、B4、B5、B7、B8：周期两态计时、先扣全部 `k` 再限额、`boxrandom` 的 z、y、x 抽取与长度加法顺序、`vortex` 乘 `k` 与叉积分量、`capvelocity` 的 blend 式、`*change` 的 `minps` NaN 语义、`maxtoemitperperiod` 截断，都一致 |
| tsc、vitest、Prettier（工作区） | 0 error；40 个文件、1074 个用例全过；代理改过的 11 个文件格式通过 |
| 变异检查（Claude 8 处，和代理的不重复，`mutate_claude.py`） | `vortex` 叉积反向、内外速度对调、`oscillatesize` 相位加在 ωτ 上、`capvelocity` 不取 `min(1, q)`、`boxrandom` 幅度不取绝对值、`alpharandom` 用 max 当范围、周期间歇里照常连续发射、`sizechange` 的 `t` 不减 `starttime`，各有用例失败；源码按原字节还原 |
| 回放重跑（工作区） | `out/replay.txt` 和代理的逐字相同 |
| 真机哈希（屏外宿主） | 30 组和步骤 2（`b2v/out/hash-after.json`）、另一会话 11:46 那轮（`b1/hash-after-1c.json`）全部相同 |
| 两张新解锁的场景（屏外宿主，回放 20 s，`real.mjs`） | `1504316159`（库内 14105）、`3820104696`（13639）没有不支持项，画面正常（雾、雨线都在）；帧时间均值 3.74 / 4.01 ms |
| 两张场景和 WPE 比统计量（WPE 抓帧 `A:\p4b\<id>-fps60`，`wpe_stats_b.py` 另认厚格式；`cmp_stats.py`） | 雾都用编辑器预设：`fog2`（每秒 1 个、寿命 3–5 s，存活 3–5 个）、`fog1`（每秒 1.5 个，存活 4–8 个）。粒子数我们 5 / 7 / 5 / 8 和 5，WPE 4–5 / 5–6 / 4 / 6 和 3–4，都在理论范围内；我们读在第 20 秒整、正好有新粒子出生，所以偏上沿。尺寸都在 500–1100，位置范围同量级，alpha 都在 0–0.27，`fog1` 初速 WPE 38、66（设定 25–80） |

### 步骤 1 补充 2 — 材质常量取值对齐 WPE（2026-11-08）

起因：翻译器修正的代理顺带发现，标量常量进向量 uniform 时我们只填 x。用户让代理先调研影响，再按实测修完。

- **调研：** 报告 [vector-constant-REPORT.md](../vector-constant-REPORT.md)。读码结论：数字进向量铺满；字符串进向量按空格逐段 `atof`；float 只收数字；缺省先转字符串；布尔、下拉、condition、颜色属性绑 float 不写；就地写整体重写；同一个材质键在 WPE 里只有一份存储，两阶段合并时片元覆盖顶点。
- **实测：** 代理生成 36 格的 `p4b-vec`，Claude 用 WPE 抓帧逐格读像素，读码 36 / 36 格吻合；当时我们只对 14 格。其中 `stage-def` 推翻了上一节翻译器修正的一半：同键不同缺省时 WPE 两阶段都读片元的缺省，不该拆开。
- **用户决定不复刻两条冷门行为：** 同一阶段同键只上传后声明的那个；按声明行（含注释）的子串定类型。
- **修改：**
  - 翻译器：只在材质键不同时拆开，同键合并、注解取片元的。
  - 宿主新增 `compile/materialValues.ts`，编译期、就地写、脚本写回共用同一个 setter；`shader.ts`、`bindings.ts`、`render/state.ts`、`host.ts`、`script/api.ts` 改为调用它。
  - 新增不支持项 `constant:slots`：单个 pass 超过 48 个 float 时报，语料最多 43。
  - 代理顺带写了回归文档（V1–V5）、changelog 一行，以及 `cocs/wpe/WPE_SCENE.md`、`cocs/README.md` 各一条。

验收结果：

| 项 | 结果 |
|---|---|
| Rust | 44 个单测全过；`cargo fmt --check` 通过；Claude 重编 wasm，和宿主里的逐字节相同 |
| tsc、vitest、Prettier | 0 error；40 个文件、1073 个用例全过（含另一个会话步骤 2 的改动）；格式通过 |
| 变异检查（代理 9 处、Claude 5 处） | 不跳前导空白、前导空格只读一次、拷满整格、主格不排第一、同键注解取顶点，各有用例失败 |
| `p4b-vec` 真机（屏外宿主 `renderFrame` 对 WPE 抓帧） | 31 / 36 格一致；不一致的是不复刻的 3 格（`dup-val` 碰巧相等），以及两个脚本格（`renderFrame` 不跑脚本；屏外宿主不出帧，`update` 没被调用，写回由单测核对） |
| `foliagesway` 三张、凝光 | 和上一节逐像素结果完全相同 |
| 真机哈希 | 30 组和上一节翻译器修正后全部相同 |
| 语料（基准 `p4b1b-mine.json`） | 没有 `constant:*` 不支持项，没有场景掉出；干净场景 18 → 20，多的两张（`1504316159`、`3820104696`）来自同期步骤 3 的 `alpharandom`，不是本节的改动 |

测试行 14106（`p4b-vec`）已用 `batch_remove_images` 移除，导入任务已删。工具在 `ignore/p4/vec/`：`check_wpe.py`、`pair.py`、`livehost.mjs`、`mutate_mine.py`；抓帧在 `A:\p4b\p4b-vec-fps60`。

补充（2026-11-08，用户同意占用图库预览）：在主窗口预览里实跑 `p4b-vec`（测试行 14107，验完已移除）。
- **脚本写回：** `scr-num-v3` (0.6, 0.6, 0.6)、`scr-num-v4` (0.6 ×4)、`scr-vec2-v3` 保持初值 (0.1, 0.2, 0.3)，与 WPE 一致，`update` 各跑 184 次。加上屏外比对的 31 格，除不复刻的 3 格外全部一致。
- **运行中改属性：**
  - `p_slider` 0.3 → (0.3, 0.3, 0.3)；`p_bool` false → 保持 0.3；都是就地写、0 次重编译。
  - `p_color3` 的 `"0.2"` 被应用的属性校验拒绝，改用 `"0.2 0.3 0.4"` → (0.2, 0.3, 0.4)。
  - 属性已还原，预览已关。

### 步骤 4 — 噪声类模块（2026-11-08）

子代理实现，Claude 独立验收。代理开工时步骤 1–3 还没提交，中途被提交了；同期另一个会话在同一工作区做步骤 5（`compile/bundle.ts`、`features.ts`、`sheet.test.ts`、`refract.test.ts`、`render/graph.ts`，以及 `render/uniforms.ts`、`compile/particles.test.ts` 里的几块）。步骤 4 的改动按块分出来单独提交（`ignore/p4/b4v/make_step4_patch.py`），验收也在「HEAD + 步骤 4 补丁」拼出的树上做（`ignore/p4/b4h/`），不含步骤 5。

- **新增** `particles/noise.ts`：照 rea C1–C3 逐位移植 `snoise1` / `snoise2` / `snoise3`，float32 每步舍入；常量表 `noiseTables.ts` 由 `ignore/p4/b4/gen_tables.py` 从 `noise-tables.json` 生成，标量按位模式写。
- **新增** 模块表记录：initializer `turbulentvelocityrandom`、`positionoffsetrandom`，operator `turbulence`。`InstanceScale` 加 `rate`（`timescale` 乘钳过的 `rate`，没有禁用位）；`positionoffsetrandom` 的 `octaves` 解析期按无符号比较钳到 [1, 8]；`turbulentvelocityrandom` 的 `up` 不在解析段里，登记成中性字段。
- **新增** 场景时间 `T`：`ParticleRunContext.time`，`ParticleSystem.step(frameDt, time?)`（不给时按收到的帧时间 double 累加），渲染器传本帧 `g_Time`，`particleTrack` / 回放探针收 `times`；预热时 `T = 0`。
- **新增** `src/sceneTime.ts` 放 432000 回绕常量，`particles/` 不再从 `render/uniforms` 引它（Claude 验收时提出）。

和计划不同、或计划没写、由代理按证据定的：
- **`turb*` 从加载起整段回放达不到 1e-3：** 湍流场对输入敏感，给日志里 6 位小数的 dt、`T` 加 ±5e-7 的扰动，我们自己的模拟就发散到 186 px（`turb`）/ 710 px（`turb-xyz`），和 WPE 残差（15 / 699 px）同量级。改用短程强制回放：从 WPE 抓帧的 float32 原值（精确）出发反解速度，再走 4 帧逐粒子比，钉进产品测试，全部 ≤ 3.1e-4。
- **`turbulentvelocityrandom` 整段回放超基础限值（4.6×），在日志 `T` 的舍入包络内：** 每个出生帧在日志 `T` 的 ±1e-6 里联合拟合后，残差落到反推精度量级。没有看出 CRT `sinf` / `cosf` 的 1 ulp 影响。
- **`T` 取本帧的 `g_Time`：** 取上一帧时 `snoise1` 残差 5e-2、`posoffset` 差 13–56 px、`turbvel` 差 164 / 589 px。
- **预热期 `T = 0`：** Claude 另抓 `proj/p4b-pre`（`A:\p4b\p4b-pre-fps60`，`ana_pre_t.py`）证实：预热里出生的 `turbulentvelocityrandom` 粒子方向全是 90°，`positionoffsetrandom` 粒子偏移完全相同。同一工程里参照组 `ref-turb`（出生点 300, 700）不动，是三维噪声在 `(300, 700, 0) + T·(1, 1, 1)` 这条线上约为 1e-7，参考实现算出的方向与 WPE 一致。

验收结果：

| 项 | 结果 |
|---|---|
| tsc、vitest、Prettier（HEAD + 步骤 4 补丁的树） | 0 error；41 个文件、1100 个用例全过（新增 26 个）；改过的文件格式通过 |
| 噪声单测（真值从 WPE 轨迹反推，`fixtures/noise.json`） | `snoise1` 40 点最大 3.0e-6，`snoise2` 58 点 2.3e-6，方向角 40 点 5.2e-6 rad（限 1e-5）；`snoise3` 由相邻三帧反推 156 点 7.5e-4（限 1e-3，反推精度约 1e-4） |
| 噪声移植对拍（Claude 独立写的 `ignore/p4/noise_ref.py`，照 rea 伪代码） | 13033 组输入（随机、整数点、负数、大坐标、坐标相等）逐位相同；代理另对拍 60 万组 |
| 回放（fps 60 / fps 10） | `posoffset-*` 不加包络 ≤ 2.4e-4；`turbvel*` 在包络内；`turb*` 短程强制回放 ≤ 3.1e-4；`turb` 与 `turb-ph5` 逐位相同；fps 10 把 `k` 换成 `h` 超限（1.9–3.6 px）；`turb-ovr` 的三项覆盖各拿掉一项都超限 |
| 变异检查（代理 24 处 + blend 1 处、Claude 8 处） | 全部有用例失败。Claude 第一轮发现「`turbulence` 丢掉 blend 系数」存活，代理补了读码单测后被抓到；源码逐字节还原 |
| 语料 | 步骤 4 前与步骤 3 逐张相同；去掉的只有三个模块键（`turbulentvelocityrandom` 42 张、`turbulence` 30、`positionoffsetrandom` 1），新增的只有它们的 `audioprocessing*` 字段；干净场景 20 → 20 |
| 真机哈希（屏外宿主，宿主由「HEAD + 步骤 4 补丁」构建，入口 `index-CmRLVj2T.js`） | 10 张干净场景 × 三档，30 组和步骤 3（`b3/hash-after.json`）全部相同 |
| 真实场景（屏外宿主强制渲染，`b4v/real.mjs`；WPE 抓帧 `A:\p4b\<id>-fps60`，`b3/wpe_stats_b.py`；`b4v/cmp_stats.py`） | `3778549173`（`turbulence`）：回放到 WPE 抓帧的时刻（945 帧），`Ash` 2335 个（WPE 2335–2341）、积雪 283（WPE 280–281），尺寸、位置、alpha 范围一致；`Ash` 的数量由 `count 1.3`、`rate 0.05` 和预热 26 步（float32 累加）算得出 2028 + 19.5/s，两边都吻合。心形层跟随指针，属 P4c，不比位置。`3819646765`（`turbulentvelocityrandom`）：叶子 16 s 时我们 8 个、WPE 6–7（理论平均 7.7），尺寸 49–52 一致，位置范围同量级；WPE 多一层子系统（P4e）。画面正常（`b4v/out/ours-*.png`）|

真实场景按 WPE 时刻重跑的那两次，用的是另一会话 14:32 从整个工作区重建的宿主（含步骤 5 半成品）；比的是粒子数和范围，属模拟层，不受步骤 5 影响。宿主备份因此没有还原。

工具：代理的在 `ignore/p4/b4/`（`replay.test.ts`、`xcheck.*`、`mutate.py`、`mutate_blend.py`、`corpus.test.ts`、`explain.py`，结果在 `out/`）；Claude 的在 `ignore/p4/b4v/`（`make_step4_patch.py`、`make_xcheck.py`、`mutate_claude.py`、`mutate_b4h.py`，结果在 `out/`）与 `ignore/p4/`（`noise_ref.py`、`ana_pre_t.py`、`gen_b.py` 的 `p4b-pre`）。
