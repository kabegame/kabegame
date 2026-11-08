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

- **修改** `compile/tex.ts`：解析 TEXS 帧表。
```ts
export interface TexFrame {
  image: number;      // 图像下标
  frametime: number;
  x: number; y: number; width: number; height: number; // 像素；字段顺序按步骤 0 定
}
export interface TexResult {
  // …
  frames?: TexFrame[]; // 新增：替换 c.skip(frameCount * 32)
}
```
- **新增** `SceneTexture.sheet`：帧数、帧宽、帧高占比、是否 NPOT，渲染器据此写 `g_RenderVar1`。算法按步骤 0 读到的写。
- **修改** `compile/bundle.ts`：
  - 帧表纹理只用在粒子材质槽 0 时不报 `tex:animation`；用在图像层、粒子的其它槽，照报。
  - 多图帧表（`imageCount > 1`）先报 `tex:animation:multi-image`，除非步骤 0 读清楚。
  - 粒子材质按步骤 0 读到的条件写 `SPRITESHEET`、`THICKFORMAT`、`SPRITESHEETBLEND`、`SPRITESHEETBLENDNPOT`，走 P4a 已有的 `defines` 参数，进缓存键。
- **修改** 模拟器：
  - `sequence` 模式：判死之后、死亡处理之前写 frame 列，`frame = age · (1 / life) · sequencemultiplier`（O1 第 2 步，rea-framework 模拟第 3 步）。
  - `randomframe` 模式：出生时 `frame = R`。
  - `rcpps(life)` 按上面的决定不复刻。
- **修改** `particles/vertices.ts`：认 `a_TexCoordVec4C1`，写速度 xyz 和 frame。
```ts
export const PARTICLE_ATTRIBUTES = {
  a_Position: ["position", 3],
  a_TexCoordVec4: ["texCoord", 4],
  a_TexCoordC2: ["rotation", 2],
  a_Color: ["color", 4],
  a_TexCoordVec4C1: ["thick", 4], // 新增：速度 xyz、frame（着色器取 frac）
};
```
- **修改** `render/uniforms.ts`：有帧表时写 `g_RenderVar1`。
- **修改** 能力表：去掉 `particle:animationmode`、`particle:sequencemultiplier`；`particle:flags:2` 按步骤 0 的结论处理。

**验收：**
- `proj/p4b-tex` 的帧表系统（`sequence`、`randomframe`、`sequencemultiplier` 2 和 3、混帧、NPOT）和 WPE 整帧逐像素比，frame 列和 WPE 的 `TEXCOORD1` 逐帧比。
- 图像层用帧表纹理的场景仍报 `tex:animation`。
- 语料的变化只在帧表相关键上，逐条解释。
- 30 组画面哈希不变。

## 步骤 3 — 发射时序、`boxrandom` 与确定性模块

- **新增** 模块表记录：
  - emitter：`boxrandom`；
  - initializer：`alpharandom`；
  - operator：`sizechange`、`alphachange`、`colorchange`、`oscillatesize`、`vortex`、`capvelocity`。
  - `positionoffsetrandom` 如果步骤 0 证明不用噪声，也放这里。
- **修改** `particles/emitters.ts`，`sphererandom` 和 `boxrandom` 共用：
  - `delay` 倒数、`duration` 到期结束；
  - `flags` bit1：每帧至多发 1 个；
  - `flags` bit2：周期发射。
  - 去掉 `zeroOnly`、`periodic` 两个限制。
```ts
// 帧尾（rea-p4a B【确】）：delay > 0 → delay −= dt；否则 duration > 0 → duration −= dt，≤ 0 时置 −1 并结束；
// 否则 rate ≤ 0 且（instantaneous == 0 或非周期）→ 结束
export function emitterTail(state: EmitterState, fields: ParticleFields, dt: number): void;
```
- `vortex` 用到非 0 控制点时报不支持，留给 P4c；`capvelocity` 的近似倒数不复刻。
- `instanceoverride` 的乘法按步骤 0 读到的接进字段表的 `instance`（`sizechange` 是否乘 `size` 要核对，C5 写的是「min / max」）。

**验收：**
- `proj/p4b`、`proj/p4b-emit` 回放，和 WPE 逐帧比：限 1e-3，位置大于 1000 时 2e-3。`capvelocity` 按相对 3.7e-4 的上界换算出的限值，并记录实际差值。P4a 的 `o2-cap-*` 一起重放。
- 变异检查：每个新模块、每条时序分支各有测试失败。
- `1504316159`、`3820104696` 没有不支持项，统计量和 WPE 一致：粒子数、位置范围、尺寸、alpha 分布。
- 语料变化逐条解释，30 组画面哈希不变。

## 步骤 4 — 噪声类模块

- **新增** `particles/noise.ts`：逐位移植 WPE 的噪声函数，float32 语义，常量表来自步骤 0 导出的数据。
  > 说明：单测要钉住若干输入的输出值，真值来自回放 WPE 轨迹时反推，或者 REA 读到的中间结果。不拿通用实现的输出当真值。
- **新增** 模块表记录：`turbulentvelocityrandom`、`turbulence`；`positionoffsetrandom` 如果用噪声，放这里。
- 确定性工程把用到 `R` 的范围收成 0 宽度（例如 `phasemin = phasemax`），让 `R` 从公式里消掉，轨迹才能逐帧比。哪些量经过 `R` 由步骤 0 读出。

**验收：**
- `proj/p4b` 的噪声系统回放，和 WPE 逐帧比，限值同步骤 3。
- 变异检查：改常量表一项、改噪声的一个系数、时间不乘 `timescale`，各有测试失败。
- 带噪声模块的真实场景解锁后比统计量。这一步预计不解锁新场景，就用 dev 强制渲染看一张，和 WPE 并排看形态。

## 步骤 5 — `REFRACT` 与 `CUTOUT`

- **修改** `PARTICLE_COMBOS` 加 `REFRACT`、`CUTOUT`、`NORMALMAP`。
- **修改** 粒子层的快照：按步骤 0 读到的时机核对 `planParticleLayer` 的 `snapshot`，不对就改。
- `g_RefractAmount`、`g_Cutout*` 是材质常量，翻译器已能处理；`g_ViewRight`、`g_ViewUp` P4a 已按语义写入，折射才第一次真的读它们，要和 WPE 比。

**验收：**
- `proj/p4b-refract` 和 WPE 整帧逐像素比：带和不带 `NORMALMAP`、`CUTOUT`、两个折射层前后叠放。
- 语料变化只在这三个 COMBO 上，30 组画面哈希不变。

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
