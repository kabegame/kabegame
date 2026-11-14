# P12b — 挂点、骨骼透明度、变形、裁切遮罩（子计划，草稿）

> 上级：[P12 总计划](phase-12-puppet.md)「P12b」。WPE 语义以 [rea-p12-mdl](rea-p12-mdl.md) 第 5–8 节、[rea-p12-runtime](rea-p12-runtime.md) 第 6.4 节、[rea-p12-attach-physics](rea-p12-attach-physics.md) 第 1 节与 [p12-REPORT](p12-REPORT.md)（第一部分用例 5、6、11，第二部分第 2、3 节）为准。
> 现状行号按 HEAD `a8b33fdf`。2026-11-14 用户：「开始 12b」。
> 步骤 0b（补读码、语料统计与两次抓帧）已做完，结果记在下面各点与「实施记录」；等用户看过再动工。

## 总体设计思路

P12b 在 P12a 的 puppet 上再接四样东西，四样都是 WPE 图像层 puppet 的一部分，读码与实测已经把公式定下来：
- **挂点**：子对象的世界矩阵是 `W_父 · Pose[骨骼] · Att · T·R·S`。`W_父` 是父的基类世界矩阵（不含对齐偏移，和我们的 `worldMatrixOf` 一致），`Pose` 是本帧动画之后的模型空间骨骼矩阵（P12a 的 `PuppetRuntime.world`，已经每帧算好，只是没有对外交出来），`Att` 是 mdl `MDAT` 里的 64 字节矩阵。挂点在编译期解析成每个子图层的 `{ 父, 骨骼, 矩阵 }`，渲染时 `worldMatrixOf` 在乘父矩阵之前先左乘 `Pose · Att`。
- **骨骼透明度**：网格 0 标志 bit2 时加 `SKINNING_ALPHA`，每帧按动画的每骨骼透明度轨道求 `g_BonesAlpha`，三种叠法照实测（cur 从 1 开始）。
- **变形**：网格 0 格式含 `a_PositionVec4` 时加 `MORPHING`。`MDMP` 在编译期打成变形纹理（纹素 0 = (0, 0, 0, 1)，目标 t 第 v 个变形顶点在 `1 + t·nv + v`，网格 0 没有 bit12 时只有纹素 0），绑在槽 5；每帧按动画的每目标权重轨道求权重（cur 从 0 开始），取生效目标、按权重从大到小排，写 `g_MorphOffsets` / `g_MorphWeights`。
- **裁切遮罩**（v23 记录表）：编译期照 WPE 的命令表（`FUN_14020b720`）把网格 0 的绘制组切成段，每段一份索引；每帧按命令画：普通段直接画，每条记录先清遮罩 RT、用 `clippingmaskimage4` 画遮罩段，再用「基础材质着色器 + `CLIPPINGUVS` + `CLIPPINGTARGET`」画目标段，遮罩 RT 绑 `g_Texture8`。带 effect 的 puppet 走同一套命令，只是普通段与两种绘制的槽 0 都换成合成 RT。

边界和 P12a 一样：
- 数据全在编译期（Worker）定好，`ScenePuppet` 多几个字段；
- 运行时 `src/puppet/` 仍是纯 TS，`ScenePuppets` 多交出三样：`pose(对象)`、`boneAlpha(对象)`、`morph(对象)`；
- 渲染侧只多三样：每帧多写几个 uniform、一张变形纹理、一张全场共用的半分辨率 R8 遮罩 RT。

几处要改现有结构：
- **帧里的顺序**：WPE 的对象更新循环按 `objects` 顺序跑，挂点子对象（粒子在自己的更新里就要世界矩阵）总排在父 puppet 之后，所以粒子读到的是本帧姿势（实测 `p12-att` 的 `c_part`、`3426865175` 的粒子都对本帧）。我们现在是「粒子 → puppet」，要改成「puppet → 粒子」。puppet 不读粒子的任何东西，这样换序对 P12a 的结果中性。
- **世界矩阵的刷新**：现在只有标脏的图层在 `sync` 时刷新世界矩阵。挂点子对象的姿势每帧都变，它们和它们的子孙要每帧标脏。
- **一次 puppet 绘制拆成多次**：有记录的 puppet 在同一个图层步骤里要按段画，裁切段中间要离开场景 pass 去画遮罩 RT，再回来（同合成 RT 的做法）。

不做、继续照报：纹理通道（`puppet:texture-channels`）与模型对象的骨骼（`mdl:skeleton` 等）——见下节「拆分」；`MORPHING_MODIFIERS`（bit13）与语料 0 处的记录标志。

### 拆分（2026-11-14 用户定：照推荐拆）

P12b 拆成两半，各自能独立验收：
- **P12b1（本子计划）**：挂点、骨骼透明度、变形、裁切遮罩。解锁 6 张（见下节）。
- **P12b2（另写子计划）**：纹理通道（只有 `3811424158`，它还差精灵表动画 `tex:animation` / `combo:SPRITESHEET`）与模型对象的骨骼、动画、变形（只有 `3706286085`，它还差 P13 的雾、反射、阴影）。两样只做 P12 时都不解锁任何场景，读码也还没做完。

### 能解锁的场景

按 HEAD `a8b33fdf` 的工作树重扫（226 个工程，能渲染 151 张，`ignore/p12/b/corpus/report.txt`）：带 P12b 键的 22 张里，只差 P12b 的 6 张全部归 P12b1，能渲染 151 → 157；P12b2 再加 0 张。
- 只要挂点：`3463520581`、`3829467967`；
- 只要骨骼透明度：`2964778792`、`3500648585`；
- 再加裁切：`3491865410`（还要挂点）；
- 挂点 + 透明度 + 变形：`3253330537`。

P12b 之后只差一两项的：`3426865175`（物理）、`3830665420`（动画层脚本）、`3346715292`（动画层脚本 + `getAnimationLayer`）、`3593919489`（`text:script:backgroundcolor`）、`3832133196`（`getEffect`）、`3811424158`（精灵表，P12b2 之外）。P12b–d 全做完累计解锁 9 张。

语料里四样的用法（同一份报告第 2 部分）：
- **挂点**：13 张、225 个子对象（图像 209，其中 puppet 65；粒子 9；分组 7；文本、声音 0），42 个父全是 puppet、`alignment` 全部缺省；名字都找得到、没有重名、没有子排在父前；`Att` 只有平移；挂点骨骼和它的父链上都没有物理骨骼；嵌套最深 3 层（`3463520581`，1 / 2 / 3 层 = 144 / 53 / 28 个）。父的变换由脚本驱动的有 `3491865410` #74（`origin` 挂脚本、`scale` 绑属性）、`3830665420` #1134，祖先被脚本驱动的还有 `3346715292`、`3492627662`。
- **骨骼透明度**：9 张、19 个 puppet，用到的动画都有透明度轨道；没有「有轨道没有 bit2」。叠法：`3253330537` 单个加法层（blend 0.4），`3577990983` 1 个覆盖层 + 3 个加法层，`2916324703` 两层（blend 1 / 0）。
- **变形**：puppet 的变形都在网格 0、每个网格 1 个目标、只有 bit12；同一帧最多 1 个非零权重，所以排序、并列、超过 11 个都碰不到。**`3253330537` 的 5 个都有负权重**（最小 −0.047），嘴最大到 1.075——负权重算不算生效决定这张的画面。
- **裁切**：5 个 mdl、8 个对象、5 张场景，记录标志全是 0，`list2` 和别的记录的 `list1` 都不相交；遮罩纹理 `materials/masks/clipping_mask_*.tex` 都在各自的 `scene.pkg` 里（语料代理只查了散文件、报成没有，主会话按 pkg 内容核过 5 张都在）。直接上屏：`3486806915`、`3491865410`；合成路径（都因为有 effect）：`3577990983`、`3808922316`（3 个对象各 4 条记录）、`3830665420`（`list2` 有 10 段）。
- **P12b2**：模型对象的骨骼有两张：`3706286085`（FBX3 / RioSonicLite / BoostModel，动画层的 `rate` / `blend` 挂脚本）与 `3662790108`（deimos，对象上没有 `animationlayers`），模型都没有 `MDAT`；`object:animationlayers` 现在只剩 `3706286085` 的模型对象在报。纹理通道的 `3811424158` 那个 puppet 没有 `animationlayers`，通道权重的动画不会播。

## 现状锚点

**a. mdl 只读 `MDLS` / `MDLA`，`MDAT` / `MDMP` 整段跳过**（`compile/mdl.ts:465`）
```ts
function readSection(reader: MdlReader, tag: string, end: number, file: MdlFile): void {
  const kind = tag.slice(0, 4);
  if (kind !== "MDLS" && kind !== "MDLA") return; // 现状：MDAT、MDMP、MDLE 只记标签（file.sections），内容不读
  ...
}
```

**b. `MDLA` 的骨骼透明度与变形权重轨道只校验长度、不存内容**（`compile/mdl.ts:624`）
```ts
    let boneAlpha = false;
    if (version >= 3) {
      scalars(reader.u32());
      if (reader.u8()) {
        boneAlpha = true;          // 现状：只记有没有
        scalars(trackCount);
      }
    }
    if (version >= 4 && reader.u8())
      for (let m = 0; m < meshes; m++) {
        if (!(reader.u32() & 1)) continue;
        reader.u32();
        const targets = reader.u16();
        for (let t = 0; t < targets; t++) {
          reader.u16();
          checkTrack(reader.block(), 4, frames); // 现状：每网格每目标的权重轨道，读过即丢
        }
      }
```

**c. 记录表与绘制组已经读出来**（`compile/mdl.ts:158`）
```ts
export interface MdlDrawGroup { bone: number; order: number; start: number; count: number; }
export interface MdlRecord { id: number; name: string; flags: number; list1: number[]; list2: number[]; }
// 现状：MdlMesh 有 drawGroups、records、blendRowCount；MdlAnimation 只有 boneAlpha / drawOrderTrack 两个布尔
```

**d. `buildPuppet` 把这四样都报成不支持**（`compile/puppet.ts:238`）
```ts
  if (mesh.flags & 1) issues.add("puppet:index32");
  if (mesh.flags & 4) issues.add("puppet:alpha");                       // P12b 去掉
  if (mesh.format & POSITION_VEC4) issues.add("puppet:morph");          // P12b 去掉
  if (mesh.records.length) issues.add("puppet:clipping");               // P12b 去掉
  if (file.meshes.some((item) => item.flags & 2)) issues.add("puppet:texture-channels"); // P12b2
```
组合键只有 `SKINNING` / `BONECOUNT`（`compile/puppet.ts:300`）：
```ts
    combos: skinned ? { SKINNING: 1, BONECOUNT: bones.length } : {},
```

**e. 放行表**（`compile/features.ts:1311`）
```ts
export const PUPPET_UNIFORMS: ReadonlySet<string> = new Set(["g_Bones"]);
export const PUPPET_COMBOS: ReadonlySet<string> = new Set(["SKINNING"]);
// 现状：SKINNING_ALPHA、MORPHING 在 ENGINE_COMBOS 里，照报 combo:*；g_BonesAlpha、g_MorphOffsets、g_MorphWeights 照报 uniform:*
// CLIPPINGUVS、CLIPPINGTARGET、BLENDROWCOUNT 不在 ENGINE_COMBOS 里，从来不报（只当着色器分支）
```
`object:attachment` 由对象标志表报（`compile/features.ts:285`、`:850`）：
```ts
const OBJECT_FLAGS = ["fullscreen", "passthrough", "attachment", "castshadow", "reflected", "skin"];
  for (const key of OBJECT_FLAGS)
    if (active(object[key]) && !lightKey(key) && !modelKey(key) && key !== "reflected")
      unsupported.add(`object:${key}`);
```

**f. 世界矩阵沿父链惰性计算、按 `sync` 的缓存复用，只有标脏的层刷新**（`render/layout.ts:286`、`render/scene.ts:3460`、`render/state.ts:663`）
```ts
export function worldMatrixOf(object, layers, cache): Mat4 {
  ...
  for (let i = chain.length - 1; i >= 0; i--) {
    const local = layerLocalMatrix(layers.get(chain[i])!);   // 现状：L = T·Rz·Ry·Rx·S，没有挂点
    base = base ? multiply(base, local) : local;
    cache.set(chain[i], base);
  }
  return base!;
}
  sync(state: SceneState): void {
    const dirty = state.takeDirty();                          // 现状：只刷新 dirty.layers 里的层
    const worlds = new Map<number, Mat4>();
    ...
    for (const object of dirty.layers)
      for (const draw of this.drawsByLayer.get(object) ?? []) this.refreshLayer(draw, state, worlds);
```
对齐偏移只用于图层画自己（`drawMatrixOf`，`render/layout.ts:326`），子孙用不带偏移的 `worldMatrixOf`——和 WPE「子对象调父的基类世界矩阵」一致。粒子的模型矩阵与控制点也读 `worldMatrixOf`（`render/scene.ts:2809`、`:4077`）。

**g. 姿势已经算好，但只交出蒙皮矩阵**（`puppet/player.ts:72`、`:171`）
```ts
interface PuppetRuntime {
  ...
  /** 模型空间骨骼矩阵（每骨骼 16 个 f32，跨帧保留，同 WPE 的 `P+0x2c8`）。 */
  readonly world: Float32Array;   // 现状：挂点要的 Pose 就是它，没有访问器
  readonly skin: Float32Array;
}
  skin(object: number): Float32Array | null {
    return this.byObject.get(object)?.skin ?? null;
  }
```
`evaluate` 逐层 `blendInto` 只叠 TRS（每骨骼 10 个 f32），没有透明度与变形权重（`puppet/player.ts:246`）。

**h. 帧里的顺序：粒子在 puppet 之前**（`render/renderer.ts:783`、`:796`）
```ts
    scene.stepParticles(...);                                   // 783
    ...
    if (live) this.options.stepPuppets?.(frametime);            // 796：现状在粒子之后
    scene.setCamera(camera);
```
dev 探针同样是粒子之后、相机之前（`dev/particleCorners.ts:622`、`:714`）。

**i. puppet 绘制是一次整网格、每帧只写 `g_Bones`**（`render/scene.ts:2880`、`:3995`）
```ts
      meshDraw = {
        indexBuffer: this.meshBuffer(puppet.mesh.indices, GPUBufferUsage.INDEX, `${name} indices`),
        indexFormat: "uint16",
        count: puppet.mesh.indexCount,                          // 现状：整网格一次
        ...
      };
  update(frame: FrameInput, _state?: SceneState): void {
    ...
      if (draw.puppet !== null) {
        const skin = this.puppets?.skin(draw.puppet);
        if (skin) draw.block.set("g_Bones", skin);              // 现状：只有 g_Bones
      }
```

**j. 纹理槽与渲染目标的种类**（`render/graph.ts:97`、`:134`）
```ts
export type TextureRef =
  | { kind: "texture"; index: number } | { kind: "composite"; index: number } | { kind: "fbo"; effect: number; name: string }
  | { kind: "framebuffer" } | { kind: "reflection" } | { kind: "mip-framebuffer" } | { kind: "atlas"; color: boolean }
  | { kind: "layer"; object: number } | { kind: "user"; slot: UserTextureSlot; fallback: TextureRef };
export type TargetRef = { kind: "scene" } | { kind: "composite"; index: number } | { kind: "fbo"; effect: number; name: string };
// 现状：没有变形纹理与遮罩 RT 的种类；没有程序输入的槽绑 dummy（render/scene.ts:3028）
```
渲染目标可以任意格式与尺寸（`createTarget`，`render/scene.ts:1529`），离开场景 pass 画别的目标再回来的写法见 `render/scene.ts:4577`。

**k. 设备只开 BC 压缩**（`render/device.ts:24`）
```ts
const OPTIONAL_FEATURES: GPUFeatureName[] = ["texture-compression-bc"];
// 现状：变形纹理要的 rgba16snorm（texture-formats-tier1）或 rgba32float 可过滤（float32-filterable）都没开；本机 NVIDIA 两个都有
```

## 步骤 0b — 补读码、语料与实测

读码（代理，只读，`ignore/p12/b/rea/`）：
- `clip-morph-attach.txt`：多组 `list1` 怎么画、遮罩 RT 的尺寸来源（含合成路径）、记录标志与 `g_RenderVar0`、绘制组排序的并列规则、变形权重的生效条件与排序（负数、并列、加法层）、挂点子对象在父被脚本移动时的时机。
- `texchan-model.txt`：纹理通道与模型对象的骨骼路径（给 P12b2）。

语料（代理，`ignore/p12/b/corpus/`）：HEAD 上的不支持项与只差 P12b 的场景；每样用法的统计（挂点子对象的类型、父的对齐与脚本 / 关键帧驱动、挂在物理骨骼上的；变形的目标数、同时生效数、负权重与并列；记录表的分组与是否走合成路径）。

实测（主会话）：读码只剩一处需要抓帧——「合成路径上屏不写变形 uniform、用残留值」——它会改变解锁场景 `3253330537` 的画面。抓了 `3253330537` 与 `3577990983` 各 3 帧（`A:\p12\b\`），结论见「实施记录 步骤 0b」：**读码这一条不成立**，两张的合成路径上屏都用 puppet 自己的变形值；同一次抓帧顺带证实了合成路径上的裁切与遮罩 RT 的尺寸。其余项读码都是【静态确认】且和语料、步骤 0 的实测吻合，不另测，留给步骤 6 的整帧对照。

## 步骤 1 — mdl 与 puppet 数据（`compile/mdl.ts`、`compile/puppet.ts`）

### 点 1 — `parseMdl` 读 `MDAT`、`MDMP` 与两种轨道（`compile/mdl.ts`）
- **新增**
```ts
/** `MDAT0001` 的一项（rea-p12-mdl 5.1）：名字、骨骼下标、64 字节矩阵（同 MDLS 局部矩阵的存法）。 */
export interface MdlAttachment { name: string; bone: number; matrix: Float32Array; }
/** `MDMP0001` 的一个网格（rea-p12-mdl 6.1）：缩放、变形顶点数 nv、目标（位置差 i16 × 3nv，bit12 时每顶点 i16 透明度）。 */
export interface MdlMorph {
  scale: number;
  count: number;
  targets: { id: number; name: string; position: Int16Array; alpha: Int16Array | null }[];
}
```
- **修改** `MdlFile` 加 `attachments: MdlAttachment[]`；`MdlMesh` 加 `morph: MdlMorph | null`；`readSection` 认 `MDAT` / `MDMP`（`MDLE` 仍跳过）。法线 / 切线差（bit10 / bit11）与 bit13 的四个值照读码读过、不存（图像层不用；bit13 照报）。
- **修改** `MdlAnimation.boneAlpha` 从布尔改成 `Float32Array | null`（每帧 × 每骨骼，帧数 + 1 帧）；**新增** `morphWeights: Float32Array[] | null`（网格 0 每目标一条）。原来只用布尔的地方（`puppet:alpha-track`）改成判空。
  > 说明：读法照 rea-p12-mdl 4.2 / 4.7 与 rea-p12-runtime 6.4，块内值都是 f32；`scalars` / 权重轨道现在读过即丢，改成存下来。

### 点 2 — `buildPuppet` 整理成 `ScenePuppet`（`compile/puppet.ts`）
- **修改** `ScenePuppet`：
```ts
export interface ScenePuppet {
  ...
  /** 新增：MDAT（只有 skinned 时挂点乘 Pose·Att，rea-AP 1.2：`P+0x2c8` 为空时不乘）。 */
  attachments: { name: string; bone: number; matrix: Float32Array }[];
  /** 新增：网格 0 标志 bit2 且 skinned → SKINNING_ALPHA；每帧要求 g_BonesAlpha。 */
  boneAlpha: boolean;
  /** 新增：网格 0 格式含 a_PositionVec4 → MORPHING；变形纹理（rea-mdl 6.3）与目标数、nv、缩放。 */
  morph: { scale: number; vertices: number; targets: number; side: number; texels: Int16Array } | null;
  /** 新增：v23 记录（见步骤 5）。 */
  clipping: PuppetClipping | null;
}
export interface PuppetAnimation {
  ...
  alpha: Float32Array | null;     // 新增
  morph: Float32Array[] | null;   // 新增：每目标一条
}
```
- **修改** 组合键：skinned 时 `SKINNING`、`BONECOUNT`，再按网格 0：bit2 → `SKINNING_ALPHA`；格式含 `a_PositionVec4` → `MORPHING`（不看有没有目标，rea-mdl 9.3）；不加 `MORPHING_NORMALS`。
- **修改** 细分键：去掉 `puppet:alpha`、`puppet:morph`、`puppet:clipping`；**新增**语料 0 处的照报：
  - `puppet:morph:modifiers`（bit13，`MORPHING_MODIFIERS`）；
  - `puppet:clipping:flags`（任一记录 flags 非 0：bit0 目标改加法、bit1 遮罩取反、bit2 遮罩组不再当普通组画，读码清楚但语料没有；bit3 WPE 自己的查表有 bug，不复刻）；
  - `puppet:clipping:nested`（某条记录的遮罩被另一条记录裁切，命令 2，要第二张中间遮罩 RT）。
  `puppet:alpha-track`、`puppet:order-track` 保留（WPE 会崩溃）。
- 变形纹理在编译期打好（`texels` 随 bundle 转移，不拷贝）：`count = 目标数 · nv + 1`，`side = ⌊√count⌋`、不够加 1；纹素 0 = (0, 0, 0, 32767)；网格 0 有 bit12 时写目标数据，否则只有纹素 0。

### 点 3 — 单测
- 往返：`ignore/p12/defs/puppet.py` 的编码器生成带 MDAT / MDMP / 两种轨道的 mdl（`p12-am`、`p12-att` 的定义），解析结果逐字段对上；语料 137 个 mdl 仍全部读到段末。
- 变形纹理与 `p12-REPORT` 用例 6 的 3×3 纹理逐纹素相同（`out/case-p12-am-morphtex.txt`）。

## 步骤 2 — 运行时（`puppet/pose.ts`、`puppet/player.ts`）

- **新增** `pose.ts` 两个纯函数（float32 逐步）：
```ts
/** 骨骼透明度（p12-REPORT 用例 5、rea-RT 6.4）：网格 bit2 时每帧先全置 1；标量插值 (1 − f)·a + b·f；
 *  覆盖 lerp(lo, hi, f)；混合 lerp(cur, v, w)；加法 clamp(cur + (v − 1)·w, min(cur, v), max(cur, v))。 */
export function blendScalarAlpha(...): void;
/** 变形权重（clip-morph-attach 5(1)(2)）：每帧权重与生效位清 0；生效 = |v| ≥ FLT_EPSILON（负权重也生效，NaN 也算）。
 *  覆盖：生效置位、写 v，不生效清位、权重不动；混合：生效置位（从不清位），权重总是 lerp(cur, v, w)；
 *  加法：不生效整条跳过，否则置位，a = v·w，权重 = max(min(cur, a), min(max(cur, a), cur + a))（同号取绝对值大的，不相加）。 */
export function blendMorphWeights(...): void;
```
- **新增** `morphUniforms(weights, active, nv, scale, out)`（`FUN_14020cff0`）：按目标号升序取前 11 个生效目标（不是权重最大的 11 个）→ 按带符号权重降序**稳定**排序（负权重排在正权重后）→ `g_MorphOffsets = [n, t₀·nv, t₁·nv, …]`、`g_MorphWeights = [scale, w₀, w₁, …]`，其余权重 0。语料同一帧最多 1 个生效目标，排序碰不到；`3253330537` 的负权重要按生效画。
- **修改** `ScenePuppets`：
```ts
  pose(object: number): Float32Array | null;      // 新增：runtime.world（模型空间，每骨骼 16 个 f32）；静态 puppet 为 null
  boneAlpha(object: number): Float32Array | null; // 新增：没有 bit2 为 null
  morph(object: number): { offsets: Float32Array; weights: Float32Array } | null; // 新增：没有 MORPHING 为 null
```
  没有可见层时：透明度全 1、变形生效数 0（`g_MorphOffsets[0] = 0`）。P12a 的「没有可见层且上次也是静止就不重算」照留，透明度与变形一并跳过。
- 单测：`p12-am` 的 40 帧 `g_BonesAlpha` 三种叠法、`g_MorphOffsets` / `g_MorphWeights`（含权重超过 0.5 后的换序帧 177–187）逐位对 WPE 抓帧。

## 步骤 3 — 挂点（`compile/bundle.ts`、`compile/features.ts`、`render/layout.ts`、`render/scene.ts`、`render/renderer.ts`）

### 点 1 — 编译期解析
- **新增** `SceneLayer.attachment: { parent: number; bone: number; matrix: Float32Array } | null`：子对象的 `attachment` 是字符串、`parent` 指向的图层有 skinned puppet、父在 `objects` 里排在子前面、父 mdl 的 `MDAT` 里有同名项（区分大小写，取第一个）时才有；否则 null，按普通父子（WPE 一样，不报键）。
- **修改** `features.ts`：`attachment` 移出 `OBJECT_FLAGS`（中性）。父是模型对象时按普通父子（模型的挂点查找和图像层同构，P12b2 接；语料的模型都没有 `MDAT`）。

### 点 2 — 世界矩阵
- **修改** `worldMatrixOf` 多一个可选参数，挂点子对象的本地矩阵先左乘 `Pose[骨骼] · Att`：
```ts
export function worldMatrixOf(
  object: number,
  layers: ...,
  cache: Map<number, Mat4>,
  attach?: (object: number) => Mat4 | null,   // 新增：挂点子对象返回 Pose[骨骼]·Att（float32，照 WPE 先 Pose·Att 再乘 L 的顺序），否则 null
): Mat4 {
  ...
    const local = layerLocalMatrix(layers.get(chain[i])!);
    const pre = attach?.(chain[i]) ?? null;                      // 新增
    const placed = pre ? multiply(pre, local) : local;           // 新增
    base = base ? multiply(base, placed) : placed;
```
  `GpuScene` 给它的 `attach` 由 `ScenePuppets.pose(父)` 与 `layer.attachment` 现算。`drawMatrixOf`、粒子的模型矩阵与控制点都经它，所以图像、粒子、文本、分组子对象一起跟。
- **修改** 刷新：有挂点的子对象及其子孙每帧标脏（`SceneState` 多一个 `attachedSubtrees`，`GpuScene.sync` 在 puppet 推进过的帧把它们并进 `dirty.layers`）。
  > 说明：语料 13 张共 225 个挂点子对象，最多的 `3463520581` 嵌套三层；每帧多刷新这些层（含子孙）的矩阵 uniform，步骤 6 量帧时间。

### 点 3 — 帧里的顺序
- **修改** `render/renderer.ts`：`stepPuppets` 挪到 `stepParticles` 之前；dev 探针（`dev/particleCorners.ts`）同改。
  > 说明：WPE 按 `objects` 顺序逐个更新，挂点子对象排在父之后，粒子子对象用本帧姿势（实测）。puppet 不读粒子，换序后 P12a 的回放结果不变（步骤 6 复核 P12a 的生成工程逐像素不变）。
- 父被脚本移动时的时机（clip-morph-attach 6(3)(4)，【静态确认】）：WPE 一帧是「对象更新循环 → 脚本 → 渲染」。
  - 图像子对象在渲染时现算世界矩阵：用脚本写过的新 `W_父` 与本帧姿势，没有滞后。我们的脚本写入会把子树标脏、`sync` 现算，同样没有滞后。
  - 粒子子对象模拟时取更新阶段的旧 `W`（上一帧脚本写的 origin、本帧姿势），绘制时再现算一次。我们的粒子本来就在脚本之前步进、绘制时读 `worldMatrixOf`，换序后自然对上。
  - 语料里 `3491865410` 的挂点父 #74 的 `origin` 挂脚本，步骤 6 用它核对。

## 步骤 4 — 骨骼透明度与变形的渲染（`compile/features.ts`、`render/scene.ts`、`render/device.ts`）

- **修改** 放行表：
```ts
export const PUPPET_UNIFORMS = new Set(["g_Bones", "g_BonesAlpha", "g_MorphOffsets", "g_MorphWeights"]); // 修改
export const PUPPET_COMBOS = new Set(["SKINNING", "SKINNING_ALPHA", "MORPHING"]);                         // 修改
```
- **修改** `GpuScene.update`：puppet 绘制每帧在写 `g_Bones` 之后写 `g_BonesAlpha`、`g_MorphOffsets`、`g_MorphWeights`（块里有才写）。直接上屏与合成上屏都带（rea-mdl 9.3：两种材质变体的组合键相同）。
- **新增** 变形纹理：
  - `TextureRef` 加 `{ kind: "morph" }`；puppet 的两种上屏步骤把槽 5 设成它（`graph.ts`，同 WPE「槽 5 直接设成变形纹理」）。
  - 建场景资源时每个带 `morph` 的 puppet 建一张 `side × side` 纹理，点采样、钳制：
    - 适配器有 `texture-formats-tier1`：`rgba16snorm`，原样上传 i16（和 WPE 同格式，转换由硬件做）；
    - 否则有 `float32-filterable`：`rgba32float`，值为 `max(c / 32767, −1)`（float32）；
    - 都没有：报 `render:morph-texture` 退回。
  - `device.ts` 的 `OPTIONAL_FEATURES` 加这两个特性。
- 单测（假设备）：`p12-am` 的 puppet 在第 173 帧的 uniform 字节与 WPE 常量逐位相同；没有 bit12 的变形 puppet 纹理只有纹素 0。

## 步骤 5 — 裁切遮罩（`compile/puppet.ts`、`compile/bundle.ts`、`render/graph.ts`、`render/scene.ts`）

### 点 1 — 编译期建命令表（clip-morph-attach 第 1 节，`FUN_14020b720`，`ignore/p12/b/rea/cm_cmdlist.py` 可直接移植）
- 绘制组按组表顺序，**加载时不排序**（rea-p12-mdl 说的「排序」是这张命令表；只有绘制顺序轨道写入时才重排，那归 `puppet:draw-order`）。
- 节点标志：记录 `list1` 的组是目标，`list2` 的组是遮罩。
- 每条记录：目标位置、首末遮罩位置；遮罩段 = [首遮罩位置, 末遮罩位置] 之间的全部位置减去**本记录**的目标（夹在中间的普通组、别的记录的目标也画进遮罩，在 m = 0 处擦掉遮罩）。
- 沿位置走：不是目标的组（包括遮罩组本身）累积成普通段，目标不打断累积；走到某条记录的末遮罩位置时，先把累积的普通段落成一段，再发射这条记录（遮罩段 + 目标段，一条记录的多个 `list1` 组合成**一个**目标段、只画一次遮罩）；同一位置发射多条记录时按最小目标位置稳定排序。最后剩下的普通段落成一段。
- 每段一份 u16 索引（节点按位置顺序拼接 `mesh0 索引 + 起点`）。
```ts
export interface PuppetClipping {
  /** 命令，照 WPE 的 `P+0x430`：normal 画下一段普通段；clip 依次画 record 的遮罩段与目标段。 */
  commands: ({ kind: "normal"; segment: number } | { kind: "clip"; record: number; mask: number; target: number })[];
  segments: Uint16Array[];
  /** 每条记录的遮罩纹理：`materials/<记录名>.tex`（在 `scene.pkg` 里）。 */
  records: { mask: string }[];
}
```
- 语料 5 个网格的段与 `cm_cmdlist_out.txt` 逐段相同；`3491865410` 的 6 段与 p12-REPORT 二 3.2 实测的 6 次绘制、两次清屏逐个相同。

### 点 2 — 材质
- 遮罩：`materials/util/clippingmaskimage4.json`，组合键 `SKINNING`、`BONECOUNT`、bit2 → `SKINNING_ALPHA`、`MORPHING`；基础材质 blending 为 alphatocoverage 时加 `ALPHATOCOVERAGE`。槽 0 = 普通段的槽 0（直接上屏是反照率，合成路径是合成 RT），槽 1 = 记录名的纹理，槽 5 = 变形纹理；`g_RenderVar0.x = 0`（只有 flags bit1 时是 1；实测的 y = 10 是别的绘制留下的，着色器不读）。混合 SrcAlpha / InvSrcAlpha、只写 RGB（遮罩 RT 是 R8），同一 MVP、`g_Bones`、变形值。
- 目标：**基础材质的着色器** + puppet 组合键 + `CLIPPINGUVS` + `CLIPPINGTARGET`，槽 0 同普通段，`g_Texture8` = 遮罩 RT（线性、钳制）；混合固定 translucent（flags bit0 才是 additive），**不用基础材质的 blending**。直接上屏与合成路径都是这一份（合成路径时槽 0 是合成 RT，实测 `3577990983` 第 400 帧事件 840）。
- `CLIPPINGCOMPOSE` 永远不设（WPE 里没有这个字符串）。

### 点 3 — 渲染
- **新增** 全场一张遮罩 RT：`r8unorm`，WPE 是 `_rt_FullAlphaMask` = 后备缓冲宽、高各整除 2（至少 2），和场景、图层都无关（读码 + 实测：1920×1080 窗口下是 960×540）。我们按场景分辨率画（窗口的对应物是场景目标），所以取场景目标宽、高各整除 2，随场景目标重建；有裁切 puppet 时才建。`TargetRef` / `TextureRef` 各加 `{ kind: "clip-mask" }`。
  > 说明：窗口和场景不同尺寸时遮罩 RT 的分辨率不同，属于已登记的「WPE 按窗口分辨率画」；走查用同尺寸窗口。
- **修改** puppet 的上屏步骤：有 `clipping` 时一次绘制换成按命令的一串：`normal` 用原来的程序画一段；`clip` 先 `clear` 遮罩 RT（0）、画遮罩段，再回场景目标画目标段。每段自己的索引缓冲；MVP、`g_Bones`、透明度、变形 uniform 三种程序各一块，每帧照写。
- 遮罩 pass 不挂深度附件；目标段照基础材质的深度与剔除。

## 步骤 6 — 真机对照（照 `FINAL_CHECK.md`）

- **生成工程**：`p12-am`（透明度三种叠法、变形含没有 bit12 的）、`p12-att`（挂点：图像、粒子、重名、查不到、子在父前），再补一个裁切的生成工程 `p12-clip`（编码器加 v23 记录：两条同遮罩记录、一条多组 `list1`、一个带 effect 的合成路径、遮罩段中间夹普通组）。WPE 录一段，我们按帧时间回放，整帧逐像素比，差异逐处解释。
- **语料复制工程**（`kbp content isolate`，窗口与场景同尺寸、无边框）：
  - 6 张解锁场景：`3463520581`（挂点三层）、`3829467967`（挂点）、`2964778792`、`3500648585`（透明度）、`3491865410`（裁切 + 挂点父挂脚本）、`3253330537`（挂点 + 加法层透明度 + 负权重变形 + 合成路径变形）；
  - 加核：`3426865175`（粒子挂在透视 puppet 上）、`3577990983` 或 `3808922316`（合成路径裁切）。
- **P12a 不变**：P12a 的 5 个生成工程与两张复制工程逐像素不变（帧序换了）。
- **解锁场景整张**：能画、不退回、脚本 `init` 成功。

## 步骤 7 — 收尾

`cocs/wpe/WPE_SCENE.md`「puppet 与骨骼动画」加 P12b 一节、`cocs/README.md` 索引、回归、changelog、PLAN 与总计划的进度。

## 和其它会话的交界

- **共享文件**：`compile/bundle.ts`、`compile/features.ts`、`render/scene.ts`、`render/graph.ts`、`render/renderer.ts`、`render/layout.ts`、`dev/particleCorners.ts` 都是热点。步骤 1、2 只动 `compile/mdl.ts`、`compile/puppet.ts`、`src/puppet/`，在工作区直接做；步骤 3–5 在 HEAD 快照的独立工作树里做，三方合并（同 P12a）。
- **P7**：`CLIPPINGTARGET` 的隐藏槽 `g_Texture8` 与 `v_ScreenPos` 的 y 翻转靠翻译器；步骤 0 的预检说四个 puppet 着色器全部组合都能翻译，步骤 5 在真 WebGPU 上建管线核对。
- **P12c / P12d**：脚本的 `getAttachmentMatrix` 等语料 0 处照报；物理之后的 `Pose` 由 P12d 接（挂点自然跟着物理走）。
- **P13**：模型对象的骨骼归 P12b2。

## 风险

1. **帧序换了**：puppet 挪到粒子之前。读码与实测都支持；P12a 的回放结果要复核逐像素不变。
2. **每帧刷新挂点子树**：层多的场景每帧多写几百个矩阵 uniform，步骤 6 量帧时间。
3. **裁切要离开场景 pass**：每个裁切段多两次 pass 切换（语料最多一张 2 条记录），开销小，但要核对深度附件与 `clearenabled: false` 的场景目标不受影响。
4. **变形纹理格式**：靠可选特性；两种都没有的适配器上退回。
5. **翻译器**：`CLIPPINGTARGET` 没在真 WebGPU 上建过管线。

## 实施记录

### 步骤 0b — 补读码、语料与实测（2026-11-14）

**读码**（代理，只读 `wp.asm` 切片，`ignore/p12/b/rea/`）：
- `clip-morph-attach.txt`：
  - 裁切命令表的构建与解释、分段与发射位置、遮罩段范围、嵌套（命令 2）；
  - 遮罩 RT `_rt_FullAlphaMask` 的尺寸、记录 flags 四位、`g_RenderVar0`、`CLIPPINGCOMPOSE`；
  - 绘制组加载时不排序；变形权重的生效条件、三种叠法与上传排序；挂点在父被脚本移动时的时机。
  - 命令表模拟器 `cm_cmdlist.py` 对语料 5 个网格的输出在 `cm_cmdlist_out.txt`。
- `texchan-model.txt`：纹理通道与模型对象的骨骼路径，给 P12b2，本子计划不用。

**更正读码**：
- rea-p12-mdl 7.2 说 `FUN_14020b720` 是排序，实际是裁切命令表的构建；绘制组加载时不排序。
- p12-REPORT 用例 7「`frac_order` 并列时 A 在前」不是并列规则：键本来就有序，根本没重写索引。
- p12-REPORT 二 3.4「遮罩 RT 是当前渲染目标的一半」应为「后备缓冲的一半」（那次窗口与场景都是 1600×900，分不开）。

**语料**（代理，`ignore/p12/b/corpus/report.txt`）：见上文「能解锁的场景」。代理把遮罩纹理报成「没有文件」，是只查了散文件；主会话核过 5 张都在 `scene.pkg` 里。

**实测**（主会话，`A:\p12\b\3253330537-morph\`、`A:\p12\b\3577990983-morph\`，1920×1080，各 3 帧；`ignore/p12/b/meas/morphdraws.py`）：
- 读码推断「合成路径上屏不调 `FUN_14020cff0`，用残留的变形 uniform」，预测 `3253330537` 的 1544 借别人的权重、`3577990983` 的 `sl` 不变形。**不成立**：
  - `3253330537` 第 278–280 帧 5 次读变形 uniform 的绘制，缩放各不相同（5.41 / 54.12 / 66.46 / 60.50 / 51.77），没有任何两次相同。1544 的网格缩放是 66.4632，对应事件 2397。2397 的槽 0 是 90×99 的渲染目标，所以它确实是合成路径上屏，用的是自己的缩放与权重（−0.0106），和 1536 的（缩放 54.12、−0.0070）不同。
  - `3577990983` 的 `sl`（合成路径，86 根骨骼）4 次绘制的权重是自己的、逐帧变化（0.0008 / 0.0387 / 0.2020）。
- 结论：两种上屏路径都写自己的变形值。实现照这个做，不复刻「残留」。
- 同一次抓帧顺带证实了合成路径上的裁切（`3577990983` 第 400 帧，4 次绘制 = 普通 / 遮罩 / 目标 / 普通，和命令表预测相同）：
  - 遮罩绘制（事件 817）画进 960×540 的 R8 目标，正好是 1920×1080 后备缓冲的一半；槽 0 是合成 RT（3840×2867），槽 1 是遮罩纹理（R8 1920×1433，8 倍各向异性）；
  - 目标绘制（事件 840）槽 0 是合成 RT、另一槽是 960×540 的遮罩 RT（线性、钳制），混合 SrcAlpha / InvSrcAlpha。

### 步骤 1–5 的分工（2026-11-14 用户：「1、2 和 3–5 两个代理并行做，做完和计划一起提交」）

- **接口先定**：主会话先把两边共用的接口写进主工作区：
  - `compile/puppet.ts`：`PuppetAttachment`、`PuppetMorph`、`PuppetClipping` 三个类型与 `ScenePuppet` 的四个新字段，`buildPuppet` 先填缺省值；
  - `puppet/player.ts`：`ScenePuppets.pose` 已是实值，`boneAlpha` / `morph` 先返回 null；
  - `render/p12a.test.ts`：给夹具补缺省字段。
  三个文件原样拷进独立工作树，工作树 tsc 0 error。
- **步骤 1、2**：执行代理在主工作区做，只改 `compile/mdl.ts`、`compile/puppet.ts`、`src/puppet/` 与它们的测试。
- **步骤 3–5**：执行代理在独立工作树 `ignore/p12/b/wt` 做。基点是 `e695bfed`（P13b2），带两个 `node_modules` 联接，并拷了被忽略的两个 wasm。它不改上面三处文件，按接口写，测试用手搭的 `ScenePuppet` 和假的 `ScenePuppets`。
- **合并**：两边做完后由主会话三方合并（祖先取 `e695bfed`），再在 dev app 里做真 GPU 核对。
- 报告分别写在 `ignore/p12/b/impl/steps12.txt`、`steps345.txt`。

### 步骤 1–5 — 实现、合并与真 GPU 核对（2026-11-15）

**步骤 1、2**（执行代理，主工作区，报告 `ignore/p12/b/impl/steps12.txt`）：
- `parseMdl` 读出 `MDAT`、`MDMP`、两种轨道；`buildPuppet` 填实四个接口字段与组合键，细分键照计划。
- 运行时的透明度、变形权重、`morphUniforms` 都是 float32 逐步。
- 和计划的出入：
  - 轨道 `flags & 3 == 1` 的骨骼不参与透明度（汇编 `0x1401ff1fb`），`PuppetAnimation` 多一个 `alphaMask`；
  - 静态 puppet 不加透明度 / 变形组合键、不报键，裁切命令表照建；
  - 变形生效位不复刻 WPE 的 64 位位图混叠；
  - 新增 `puppet:clipping:groups`（记录下标越界，WPE 加载时 `int 0x29`）。
- 主会话复核：
  - 改动只在授权文件内，接口没动；
  - tsc 0 error，6 个文件 218 个测试全过；
  - 变异 3 处（排序反向、负权重不生效、加法不相加）都被测试抓住。
- 对 WPE 真值：`p12-am` 40 帧 × 9 个 puppet 的 `g_BonesAlpha` 与 `g_MorphOffsets` / `g_MorphWeights` 逐位相同（含换序帧），变形纹理逐纹素相同。
- 语料：137 个 mdl 读到段末；5 个带记录的网格命令表与 `cm_cmdlist_out.txt` 逐段相同。

**步骤 3–5**（执行代理，独立工作树，报告 `ignore/p12/b/impl/steps345.txt`）：
- 挂点：`resolveAttachment`、`worldMatrixOf` / `drawMatrixOf` 的挂点钩子、挂点子树每次 `sync` 刷新、puppet 挪到粒子之前（渲染器与 dev 探针）。
- 透明度与变形：放行表、每帧写 uniform、变形纹理。
- 裁切：遮罩与目标材质、按命令表展开、全场一张 R8 遮罩 RT。
- 本机翻译器核对：目标变体有槽 8（binding 17 / 18），`v_ScreenPos.y` 已翻转；`g_MorphOffsets` 反射为 `array<vec4<u32>, 12>`，写入逐位正确。

**合并**（主会话，祖先 `e695bfed`）：
- 12 个文件三方合并，10 个自动合上。
- `render/scene.ts` 5 处、`dev/particleCorners.ts` 1 处冲突，按块保留两边：
  - puppet 先于粒子的回调加上别的会话的「回放媒体也 `sync`」；
  - R8 遮罩格式加上 P13c 的 sprite 遮挡写法；
  - 挂点钩子加上别的会话改的光标投影。
- 合并后主工作区 tsc 0 error；全量 vitest 4212 个通过、2 个失败。两个失败都不是 P12b：
  - `p5d.test.ts` 拼错的材质键：P13c 会话未提交的改动把它们改成中性了；
  - `pipeline.test.ts` 语料读取上限：HEAD 原有。

**真 GPU 核对**（dev app，屏外宿主，1920×1080，后处理超高，开脚本，第 30 帧）。6 张解锁场景的解包工程（`ignore/p12/b/proj/*-kbp`）一开始只有 4 张能画，查出三个 bug，都已修好：
1. **变形纹理 `rgba16snorm` 绑不上**（`3253330537`）：Dawn 上这个格式只能当 unfilterable-float 采样，翻译出的着色器是 `textureSampleLevel` + 普通 sampler，auto layout 要 filterable。改成一律 `rgba32float`（`max(c/32767, −1)`，要 `float32-filterable`，没有时报 `render:morph-texture`），删掉 `rgba16snorm` 分支，`OPTIONAL_FEATURES` 去掉 `texture-formats-tier1`。
2. **裁切的遮罩纹理没上传**（`3491865410`，建场景时 `createView` 读到 null）：`uploadableTextures` 漏了 `puppet.clip` 的遮罩与目标 pass。
3. **遮罩 pass 的 `g_RenderVar0` 被报成 `uniform:g_RenderVar0`**（`3491865410`，产品里整张退回）：新增遮罩 pass 专用放行表 `PUPPET_CLIP_MASK_UNIFORMS`，别的 puppet pass 读到它仍照报。

单测都是手搭的 puppet，所以漏了这三个。补了本机语料用例：6 张解锁场景整张编译 `unsupported` 为空。修完之后：
- 6 张都能画，`unsupported` 全空、脚本 `init` 全部成功、没有退回；
- `3500648585` 有一条脚本告警：作者把拖拽 `origin` 的脚本挂在 `visible` 上，`update` 拿到布尔值，不属于 P12；
- 相关 7 个测试文件 246 个测试全过。

`3577990983`（加核的合成路径裁切）建不起来，报 `render:texture-missing:4`。它本来还差物理、动画层脚本等，编译器确定退回后就停止读纹理，强制渲染缺数据，不是 P12b 的问题。合成路径裁切只有单测与 WPE 抓帧的结构核对，整帧对照等它能渲染时再做。

**已知缺口**（语料里都没有这种组合）：
- 光标命中（`cursor.ts`）、相机对象的世界矩阵、`particles/track.ts` 的加载期静态世界矩阵没接挂点钩子；
- 平面反射 pass 对带裁切的 puppet 只画目标段、没画遮罩；
- 挂点子树每帧刷新两次（`sync` 每帧调两次）。

**还没做**：步骤 6（逐像素走查）与步骤 7（收尾）。
