# P12 — 骨骼与 puppet（总计划）

> 上级：[PLAN.md](../PLAN.md)「P12 — 骨骼与 puppet」。前置：步骤 0 只读码、只实测，可以和别的节并行（2026-11-14 用户：「其他地方在做 phase5，phase6，phase8，phse10，phase11；phase4、phase9、phase7 已完成 你趁这个时间开始 P12」）。改渲染器共享文件的步骤要和它们错开，见「和其它节的交界」。
> 本文件只定目标、分节和验收；各节动工前另写子计划，步骤 0 先读码再实测。
> 统计基于 HEAD `d58a7048` 的语料扫描 `ignore/p12/out/corpus-head.json`（183 个工程，能渲染 88 张；源码快照 `ignore/p12/head`。之后的 `79a3fe66` 只改文档）。覆盖数：`ignore/p12/ana_p12.py`（P4–P6 的键沿用 `ignore/p6/ana_phases.py`）、分节 `ignore/p12/ana_sub.py`。逐场景清单：`ignore/p12/scan_p12.py` → `ignore/p12/out/scan.json`；骨骼 JSON、挂点、变形段：`scan_bones.py`；物理骨骼：`scan_phys.py`；`attachment` 的父对象：`att.py`；脚本用法：`members.py`。mdl 的读取沿用 P5 的 `ignore/p5/rea/mesh/mdl.py`。
> 现状行号按 HEAD `d58a7048`。

## 总体设计思路

puppet 是图像层的一种形态：图像层的模型 JSON 写了 `puppet: "models/xxx_puppet.mdl"`，WPE 就用这个 mdl 的网格代替图像层的四边形，用图像层自己的材质（语料里全是 WPE 自带的 `genericimage4` / `genericimage2`）去画，网格的顶点由骨骼带着动。P5c 已经查明，mdl 只有一个加载函数（`FUN_140261880`），调用者只有模型资源和图像层（`0x1401fbedd`，就是 puppet）两个，容器格式完全共用（rea-p5-mesh 1.1）。所以 P12 不另写一套 mdl 读取，而是把 P5c 的 `parseMdl` 从「段只记标签、整段跳过」扩成把骨骼（`MDLS`）、动画（`MDLA`）、挂点（`MDAT`）、变形（`MDMP`）和 `MDLE` 都读出来。

一个 puppet 图层每帧要做的事，按已读到的部分推断是这样（步骤 0 逐项确认）：
- 推进对象上每个动画层（`animationlayers` 的一项）的时钟；
- 在各自的时刻采样 `MDLA` 里的骨骼轨道，按 `blend`、`additive`、淡入淡出（`blendin` / `blendout` / `blendtime`）混合成每根骨骼的局部变换；
- 骨骼物理（P12d）在这个姿势上再算一遍；
- 沿父链得到世界矩阵，乘绑定姿势的逆，得到蒙皮矩阵，交给着色器的 `g_Bones[BONECOUNT]`；
- 挂在它某个挂点（`attachment`）上的子对象，世界矩阵跟着那根骨骼走。

蒙皮在 GPU 上做，用 WPE 自己的着色器。`genericimage4.vert` 里有四套和 puppet 有关的组合：
- `SKINNING`：读 `g_Bones`、`a_BlendIndices`、`a_BlendWeights`；
- `SKINNING_ALPHA`：每根骨骼一个透明度 `g_BonesAlpha`；
- `MORPHING`：变形目标打包在隐藏纹理 `g_Texture5` 里，按 `g_MorphOffsets` / `g_MorphWeights` 取；
- `MORPHING_MODIFIERS`：按骨骼的规则衰减变形，`g_MorphBoneTransform` / `g_MorphBoneRules`。

这些语义都写在着色器里，我们照常翻译 WPE 的着色器、按 WPE 的规则设组合键和 uniform，就不用在 TS 里重写一遍公式。WPE 把 `g_Bones` 放在单独的常量缓冲 `g_bufAnimation`（b2，rea-p7-shader 第 728 行），翻译器要照这个形状出绑定。

编译期和运行时的分工照 P10：
- **编译期（Worker）**：mdl 解析出网格、骨骼（父、绑定姿势、骨骼 JSON 里的物理参数）、动画（帧率、长度、逐骨骼轨道）、挂点、变形目标（打包成变形纹理的字节）。图像层的 bundle 多一份 `puppet`，材质 pass 按 WPE 的规则加组合键后编译。动画层的字段登记成绑定（P3a 的 `BindingTarget`），用户属性和脚本写回走 `SceneState.write`。
- **主线程**：新模块 `apps/wpe-scene/src/puppet/` 管全部 puppet 的姿势，仿 `animation/`。
  - 每层一个时钟；
  - 采样、混合、蒙皮矩阵都是纯 TS，dev 探针、Node 单测和 kbp 回放共用；
  - 每帧算完写进图层的骨骼 uniform；
  - 挂点子对象的世界矩阵交给层级（P4a 的 `W_parent` 链）。
- **渲染**：图像层「画自己」的几何从四边形换成 puppet 网格。直接上屏和画进合成 RT 的基础 pass 都要换：26 张场景的 puppet 带 effect。顶点布局、缓冲沿用 P5c 的 `render/mesh.ts`。

关键决策沿用前几节：
- WPE 语义以读码加实测为准。
- 能力表是唯一事实来源，没实现的照报。
- 验收和 WPE 比，不和作者的预览图比。

P12 另有三条：
- **mdl 一个解析函数。** P5c 的 `parseMdl` 扩展，不另起一个 puppet 专用的读取。WPE 本来就共用，两份读取迟早对不上。
- **蒙皮用 WPE 的着色器，不在 CPU 上算。** 理由见上。代价是翻译器要能编带这些组合键的 `genericimage4` / `genericimage2` / `clippingmaskimage4`；语料里这几种组合一次都还没真正编过，步骤 0 先试。
- **新代码放进独立模块。** `src/puppet/`，共享文件（`compile/bundle.ts`、`compile/mdl.ts`、`compile/features.ts`、`render/graph.ts`、`render/scene.ts`、`render/renderer.ts`、`host.ts`、`script/api.ts`）里只加接线。

## 范围与覆盖

语料（`ignore/p12/out/scan.json`）：
- **规模**：37 张场景报 P12 的键：
  - `model:puppet` 35 张、`object:animationlayers` 32、`object:attachment` 10；
  - `script:api:layer.getAnimationLayer` 8、`getAnimationLayerCount` 3；
  - `mdl:skeleton` / `mdl:animation` / `mdl:morph` / `mdl:flags:0x400` 各 1 张，都是模型对象 `3706286085`（PLAN 写的 33 张是 165 张口径）。
- **puppet 图层**：
  - 160 个图层在 35 张场景里，每张 1 到 21 个（只有 1 个的 13 张）；
  - 35 张都是正交场景（37 张里唯一的透视场景是模型对象 `3706286085`）；2 个图层带 `perspective: true`；77 个图层（26 张）带 effect；
  - 材质 pass 全是 WPE 自带的：`genericimage4` 149 个、`genericimage2` 11 个，两个着色器都有 `SKINNING` 分支。
- **mdl**（按图层计）：
  - 版本 v23 109、v19 28、v21 12、v16 10、v13 1。PLAN 写的只有 v21 / v23；LWE 也只认这两个，只画静态网格；
  - 网格格式 `0x180000f` 138（位置、法线、切线、uv、骨骼下标与权重）、`0x1800009` 11、`0x181000e` 6（多 `a_PositionVec4`，变形用 `w` 存下标）、`0xf` 5（没有骨骼数据）、`0x800021` 1；
  - 网格标志：0 有 144 个，`0x4` 10、`0x1000` 5、`0x100c` 1、`0x2` 1。bit2 的含义没查（5 张）；bit10–13 决定变形段多读哪些块（rea-p5-mesh 1.7）；
  - v21 起的两个可选块：可选块 1 有 45 个网格、可选块 2 有 116 个；v23 的记录表非空 5 个网格（4 张），名字形如 `masks/clipping_mask_<hash>`，推测是裁切遮罩（`clippingmaskimage4`）。
- **段**（按图层计）：
  - `MDLS0001–0004` 155 个，即 5 个图层没有骨骼，是静态 puppet 网格（`3354366708`、`3811769317` 只有这种）；
  - `MDLA0001/0003/0005/0006` 143 个；`MDLE0002` 45、`MDAT0001` 34、`MDMP0001` 6。
- **骨骼**：
  - 132 个带骨骼的 mdl 文件（按文件计，下同）：骨骼数 1–8 的 96 个、9–16 的 17 个、17–32 的 10 个、33–64 的 5 个、更多的 4 个，最多 86 根。WPE 的 `BONECOUNT` 上限 128，都放得下；
  - 每根骨骼带一段 JSON（`FUN_140265c30` 解析）。共 1245 根，795 根非空：
    - 795 根都有 `a`、`s`、`tp`，691 根有 `lamin` / `lamax` / `tm`，685 根有 `rax` / `ray` / `raz`；
    - 物理参数（`m`、`gd`、`ge`、`r`、`re`、`rf`、`ri`、`rs`、`t`、`tf`、`ti`、`ts`、`la`、`lt`、`ltmax`、`se`）15 根；
    - IK 参数（`ik*`、`tax` / `tay` / `taz`）9 根，`ik` 全是假。
  - 开着物理（`r` 或 `t` 为真）的 14 根骨骼在 5 张场景：`2345214324`（5 根）、`3426865175`（4）、`3577990983`（3）、`3554161528`（1，`t`）、`3829467967`（1）。
- **动画层**（`animationlayers`）：
  - 142 个对象、219 项；每个对象 1 项的 95 个，2 项 31、3 项 8、4 项 6，最多 9 项；
  - 每项都有 `id`、`animation`（整数，指 `MDLA` 里的动画）、`name`、`additive`；`blend` 203、`rate` 175、`visible` 167、`blendin` / `blendout` / `blendtime` 165；
  - 绑用户属性的：`visible` 41、`rate` 27、`blend` 12；挂脚本的：`rate` 17、`visible` 11、`blend` 4。绑了的在 13 张场景。
- **挂点**（`attachment`）：
  - 161 个对象在 10 张场景，取值全是字符串（挂点名）；
  - 父对象都是 puppet，父的 mdl 都有 `MDAT`；子对象：图像层 145、粒子 9、别的 7；
  - 22 个带 `MDAT` 的 mdl：1 个挂点的 14 个，2 个 5，3 个 2，8 个 1。
- **变形**（`MDMP`）：puppet 6 个 mdl 在 2 张场景（`3253330537` 的眼睛与嘴，标志 `0x1000`；`3577990983`，`0x100c`），另有模型对象 `3706286085`（`0x400`）。
- **脚本**：
  - `getAnimationLayer` 8 张：
    - 直接写的 5 张是同一种写法，`cursorClick` 里 `thisLayer.getAnimationLayer("dianji").play()`，只调 `.play()`（`3276911872`、`3308867900`、`3326873240`、`3361965869`、`3400241651`）；
    - 3 张用同一个脚本库（NSL，`3400241651`、`3486806915`、`3492627662`），1 张混淆过（`2887099508`），用到哪些成员步骤 0 细看；
  - `3326873240` 在一个不是 puppet 的图层上调，WPE 那边应该返回空、回调报错（步骤 0 确认）；
  - 骨骼、混合形状、挂点的 API，以及 `createAnimationLayer` / `playSingleAnimation` / `destroyAnimationLayer`：语料 0 处。

| 节 | 内容 | 只做 P12 时累计能渲染 | P4–P11 先做完时累计 |
|---|---|---|---|
| P12a puppet 网格与骨骼动画 | puppet 网格代替四边形（直接上屏、合成 RT 的基础 pass）、`MDLS` / `MDLA` / `MDLE`、动画层的时钟与混合、`SKINNING` / `BONECOUNT` 蒙皮、动画层字段的属性与脚本绑定、可选块；去掉 `model:puppet`、`object:animationlayers` | 88 → 97 | 135 → 150 |
| P12b 挂点、变形与裁切遮罩 | `MDAT` 与对象 `attachment`、`MDMP` 与变形纹理（`MORPHING*`）、`SKINNING_ALPHA`、v23 记录表（裁切遮罩）；去掉 `object:attachment` | 99 | 155 |
| P12c 脚本 | `getAnimationLayerCount` / `getAnimationLayer`、`IAnimationLayer` 的全部成员 | 99 | 162 |
| P12d 骨骼物理 | 骨骼 JSON 的物理参数、每帧求解 | 101 | 167 |

口径：
- **只做 P12**：HEAD 上 13 张只差 P12，按 a → b → c → d 依次解锁 9、2、0、2 张。
- **P4–P11 先做完**：
  - P4–P6 的键沿用 `ana_phases.py`，另把进行中的 P4f（`script:api:particle.*`）、P5c（`model:pending`）、P5d（`value:animation:camera`）、P6b（`text:script*`、`text:anchor:*`）算作做完，能渲染 108 张；P8 之后 111、P10 之后 114、P11 之后 135。
  - 之后只差 P12 的 32 张，按 a → b → c → d 依次解锁 15、5、7、5 张。
  - 每张按它要的子类归到最后一节：要挂点、变形或记录表的归 b，要脚本的归 c，要物理的归 d。
  - 有 5 张用到网格标志 bit2 或 bit12（`2964778792`、`3253330537`、`3361965869`、`3577990983`、`3832133196`），上面先按「这两位不需要另做」算；步骤 0 查清后再归节。
- **P12 场景还差别的节**（P4–P11 做完之后）：32 张只差 P12；2 张还差 P13（`3465215190`、`3706286085`）；3 张还差没归属的键（`model:passthrough:children:framebuffer` 2 张、`uniform:g_Texture3MipMapInfo` 1 张），不归 P12。
- P12 场景同时依赖别的节（HEAD 上）：18 张还差 P11，11 张还差 P10。用 `getAnimationLayer` 的脚本都在光标回调里，要 P6c。上面的「P4–P11 先做完」都假设它们先做完。
- PLAN 的表是 165 张口径（用到 35、只差它 5、累计 154），这里按 183 张重算，累计的假设也不同。

**P12 不做，继续报不支持：**
- **模型对象的骨骼**：`3706286085` 的 `BoostModel` / `FBX3`，报 `mdl:skeleton` / `mdl:animation` / `mdl:morph`。只这 1 张，还差 P13 的雾、反射、阴影；`src/puppet/` 的骨骼运行时写成模型路径也能用，接线随 P13 做（见「决定」2）。
- **语料 0 处的脚本 API**：骨骼、混合形状、挂点的读写，`createAnimationLayer` / `playSingleAnimation` / `destroyAnimationLayer`，`transformAttachmentToTexture`，照报原来的 `script:api:layer.*`。
- **IK**：语料 9 根骨骼带 IK 参数，`ik` 全是假。步骤 0 确认 `ik` 为假时中性；为真的照报细分键。

## 现状锚点

**a. puppet 图层一律报 `model:puppet`**（`apps/wpe-scene/src/compile/features.ts:944`）
```ts
export function checkModelFeatures(model: ModelJson, unsupported: Set<string>): void {
  for (const [key, value] of Object.entries(model)) {
    if (SUPPORTED_MODEL.has(key)) continue;
    if (MODEL_FLAGS.has(key) ? modelFlag(model, key) : active(value)) unsupported.add(`model:${key}`); // 现状：`puppet` 是路径字符串，报 model:puppet，整张退回
  }
  // 关键帧（语料 0 处，防御用）；puppet 的 `animationlayers` 是整数 id，不报
  scanValue(model, unsupported);
}
```

**b. `attachment` 在对象开关表里，`animationlayers` 是未知键**（`compile/features.ts:278`、`:808`、`:849`）
```ts
const OBJECT_FLAGS = [
  "fullscreen",
  "passthrough",
  "attachment", // 现状：取值为真（挂点名字符串）就报 object:attachment
  "castshadow",
  // …
];
// checkObjectFeatures
  for (const key of OBJECT_FLAGS)
    if (active(object[key]) && !lightKey(key) && !modelKey(key)) unsupported.add(`object:${key}`);
  // … 未知键
      active(value)
    )
      unsupported.add(`object:${key}`); // 现状：`animationlayers` 落到这里，报 object:animationlayers
```

**c. mdl 的段只记标签、整段跳过，可选块与记录表读过即丢**（`compile/mdl.ts:232`、`:275`）
```ts
      let puppet = false;
      if (version >= 21) {
        if (reader.u8()) {
          reader.u32();
          reader.block(); // 现状：可选块 1 丢掉，只记 puppet = true
          puppet = true;
        }
        // … 可选块 2、v23 记录表同样
      }
    // …
    if (version > 12)
      for (;;) {
        const tag = reader.cstr();
        if (!tag) break;
        file.sections.push(tag); // 现状：只记标签；能力表按标签报 mdl:skeleton / animation / morph / attachment
        const end = reader.u32();
        if (end < reader.pos || end > bytes.length) throw new Truncated();
        reader.pos = end; // 现状：段内容整段跳过
      }
```

**d. 图像层只读模型 JSON 的材质，几何是四边形**（`compile/bundle.ts:1753`）
```ts
    if (!model.material) {
      unsupported.add("material:missing");
      return false;
    }
    const materialText = await fs.text(model.material);
    // …
    for (const [k, raw] of material.passes.entries()) {
      // …
      layer.passes.push(await compilePass(pass, { key: `objects/${index}/passes/${k}` })); // 现状：不加 SKINNING / BONECOUNT 等组合键
    }
    // 现状：`model.puppet` 没人读；图层按 `layer.size` 画四边形（`render/graph.ts`、`render/scene.ts`）
```

**e. 动画层与骨骼的脚本 API 在缺失表里**（`compile/scriptApi.ts:131`）
```ts
    // 纹理动画、动画层、骨骼与混合形状（W5 / P6）；`getVideoTexture` 已实现（P9b）
    ...methods(
      "any",
      [
        "getTextureAnimation",
        "getAnimationLayerCount", // 现状：用到就报 script:api:layer.getAnimationLayerCount
        "getAnimationLayer",
        "createAnimationLayer",
        "playSingleAnimation",
        "destroyAnimationLayer",
      ],
      UNIQUE,
    ),
    ...methods("any", ["getBoneCount", "getBoneTransform", /* … 骨骼与混合形状共 16 个 */], UNIQUE),
```

**f. 帧循环：粒子 → 声音与关键帧 → 脚本 → `sync` → `update` → `encode`**（`render/renderer.ts:686`）
```ts
    try {
      scene.sync(state);
      scene.stepParticles(frametime, wrapped, state, cursor); // 现状：粒子先于脚本（P4c 步骤 4）
    } catch (error) {
      // …
    }
    scene.setCamera(camera);
    if (live) this.options.stepObjects?.(frametime); // 声音（P6a）；关键帧动画（P10a）也在脚本之前
    if (live) this.options.beforeFrame?.(frametime, this.spectrum); // 脚本
    // …
      scene.sync(state); // 现状：骨骼姿势在帧里排在哪一步由步骤 0 定
      scene.update({ time: wrapped, frametime, /* … */ }, state);
      scene.encode(encoder, state);
```

## 与 PLAN.md 的差异

1. **语料**：PLAN 写「33 张」「`animationlayers` 31 张」，现在是 37 张、32 张；累计数按 183 张、P4–P11 先做完重算。
2. **mdl 版本**：PLAN 写 MDLV0021 / MDLV0023，语料还有 v13、v16、v19（50 个图层）。P5c 的解析器本来就照 WPE 认全部版本，P12 不按版本限制。
3. **着色器的组合键**：PLAN 只提 `BONECOUNT`；`genericimage4` 还有 `SKINNING_ALPHA`、`MORPHING`、`MORPHING_NORMALS`、`MORPHING_MODIFIERS`，以及裁切遮罩的 `clippingmaskimage4`，P12b 一起做。
4. **骨骼物理**：PLAN 没提。骨骼 JSON 带物理参数，5 张场景开着，单列 P12d。
5. **分节**：PLAN 没分节，这里按「网格与动画 → 挂点与变形 → 脚本 → 物理」分四节。
6. **模型对象的骨骼**：PLAN 把它算在 P12 里，这里定为随 P13 接线（「决定」2）。

## 步骤 0 — 调研（整节一次）

**读码**（交给代理，REA 看 `wallpaper64.exe` 2.8.42；rea-p5-mesh 1.7、2.4–2.6 与 rea-p5-modelflags 已读到的部分只复核）：
- **段格式**：
  - `MDLS` v1–v4 每骨骼的完整布局：`+0x64` 那个 u32 是什么，v≥2 的记录与可选矩阵；
  - 骨骼 JSON（`FUN_140265c30`）每个键的含义与缺省值；
  - `MDLE0002` 的矩阵是什么（绑定姿势的逆？），和 `MDLS` 的局部矩阵什么关系；
  - `MDLA` v1 / v3 / v5 / v6：动画的 id、名字、帧率、长度、模式、逐骨骼轨道（平移 / 旋转 / 缩放的存法）、有没有事件；
  - `MDAT`：每项那个 u16 是不是骨骼下标，矩阵是不是挂点相对骨骼的局部变换；
  - `MDMP` 与网格标志 bit10–13，变形纹理（`g_Texture5`，格式 0x13）怎么打包；
  - v21 的两个可选块、v23 的记录表是什么，和裁切遮罩什么关系；网格标志 bit2。
- **图像层的 puppet 路径**：
  - 加载（`0x1401fbedd`）：网格怎么代替四边形，和图层 `size`、`autosize`、对齐、UV 内缩的关系；`(flags & 0x22) != 0` 时跳过（rea-p5-modelflags）复核；
  - 给材质加哪些组合键（`SKINNING`、`BONECOUNT`、`SKINNING_ALPHA`、`MORPHING*`），条件是什么；
  - 带 effect 时基础 pass 怎么画网格；`perspective: true` 的 puppet。
- **每帧更新**（骨骼运行时 `obj+0x2d8`，`FUN_14021c480`）：
  - 在帧里的位置：相对粒子、P10 关键帧、脚本、`update(value)`；
  - 动画层的时钟：`+= rate × dt`、模式（循环 / 单次）、`visible` 为假时推不推进；
  - 采样：帧间插值（线性、四元数球面插值？）、首尾帧；
  - 混合：`blend` 权重、`additive`、`blendin` / `blendout` / `blendtime` 的淡变曲线，多层的合成顺序；
  - 蒙皮矩阵：父链、绑定姿势的逆、`g_Bones` 的布局（`mat4x3`，转不转置）与上传；`g_BonesAlpha` 从哪来；
  - 对象隐藏、壁纸暂停时推不推进。
- **挂点**：子对象世界矩阵的公式（父的 `W` · 骨骼世界矩阵 · 挂点矩阵 · 子的局部？），子对象是粒子时发射器跟不跟；`transformAttachmentToTexture` 只记结论。
- **物理**：求解器的形状（弹簧、阻尼、重力、角度与位移限制）、积分步长（固定步长还是帧时间、有没有子步）、和动画的先后、受不受对象移动影响；IK 在 `ik` 为假时是否完全不走。
- **脚本**：`getAnimationLayer(名字 | 下标)` 找谁、找不到返回什么、在非 puppet 图层上返回什么；`getAnimationLayerCount`；`IAnimationLayer` 每个成员的原生实现；puppet 动画会不会发 `AnimationEvent`（`lib.sceneScript.d.ts` 的注释这么说）。
- **动画层字段的绑定**：`rate` / `visible` / `blend` 的用户属性与脚本写回走不走描述符 setter，生效时机。

**翻译器预检**（我自己做）：用编译管线把 `genericimage4` / `genericimage2` / `clippingmaskimage4` 按 `SKINNING=1` 与 `BONECOUNT` 16 / 32 / 64 / 128，`MORPHING`、`MORPHING_NORMALS`、`MORPHING_MODIFIERS`、`SKINNING_ALPHA` 的组合各译一次，列出失败。已知要处理的写法：`uvec4` 属性、`mat4x3` 数组、`uint` 数组 uniform、顶点着色器里采样纹理、单独的常量缓冲。

**实测（WPE + RenderDoc）：**
- **测试工程**：kbp gen 加 puppet mdl 的编码（照读码写，先只写静态网格 + 少量骨骼 + 一段动画）。
  - 一根骨骼、一段平移或旋转动画：定时钟、插值、`g_Bones` 布局；
  - 两层动画：`blend`、`additive`、淡入淡出；
  - `rate`、`visible` 的属性绑定，单次与循环；
  - 一个挂点、挂一个小图像层和一个粒子；
  - 变形目标一个；`SKINNING_ALPHA` 一个（如果读码查清怎么触发）；
  - 一根开物理的骨骼，在动画带动下抓一段，改 `rs` / `rf` / `gd` 各抓一组。
- **读值**：每帧从抓帧读 `g_bufAnimation`（`g_Bones`）、`g_BonesAlpha`、变形权重，网格的顶点输出，配上 CLK 图层的场景时间与帧时间。kbp 现有的 `rdc consts` 读常量缓冲，按需补读 b2。
- **脚本**：`getAnimationLayer` 的查找、`play` / `pause` / `stop` / `setFrame` / `rate` / `blend` / `visible` 打日志；非 puppet 图层上调用的结果。
- **语料**：只差 P12 的里挑几张（一张只有 1 根骨骼的 `3811424158`、一张静态 puppet `3354366708`、一张带挂点的、一张带物理的），用 `kbp content isolate` 做缩减工程，抓一组作为语料验收的真值。

**产出：** 读码文档（按代理分：`rea-p12-mdl.md` 段格式与加载、`rea-p12-runtime.md` 每帧更新与混合、`rea-p12-attach-physics.md` 挂点、物理与脚本），`p12-REPORT.md`（实测），本文件的步骤 0 实施记录；kbp-tools 的 puppet mdl 编码与 b2 常量读取。

## P12a — puppet 网格与骨骼动画

- **编译期**：
  - `parseMdl` 读出 `MDLS`、`MDLA`、`MDLE` 与可选块（`compile/mdl.ts`）；
  - 图像层读模型 JSON 的 `puppet`，`layer.puppet` 带网格、骨骼、动画（`compile/bundle.ts` 接线，解析与打包放 `compile/puppet.ts`）；
  - 材质 pass 照 WPE 加组合键；动画层的字段登记成绑定（用户属性、脚本）；
  - 能力表：去掉 `model:puppet`、`object:animationlayers`；没查清或没实现的用法报细分键 `puppet:*`。
- **主线程**（`src/puppet/`）：
  - 动画层时钟、轨道采样、层混合、蒙皮矩阵都是纯 TS，float32 照 WPE；
  - 每帧写图层的骨骼 uniform，帧里的位置照步骤 0；
  - 重编译时保留时钟（同 P10）。
- **渲染**：图像层画自己的几何换成 puppet 网格（直接上屏与合成 RT 的基础 pass），翻译器出 `g_bufAnimation` 的绑定。
- **确定性回放**：dev 探针 `renderFrame` 与 kbp 回放按帧时间序列推进动画层时钟。
- **验收**：
  - 确定性工程逐帧比 `g_Bones` 与顶点输出，残差到 float32 舍入级；
  - 解锁的场景和 WPE 同一时刻比整帧；
  - 语料：去掉的键只落在 puppet 场景上，别的场景逐张不变。

## P12b — 挂点、变形与裁切遮罩

- **挂点**：`MDAT` 与对象 `attachment`，子对象（图像、粒子、别的）的世界矩阵跟骨骼走；层级（P4a）里的父链按步骤 0 的公式接上。
- **变形**：`MDMP` 打包成变形纹理，`g_MorphOffsets` / `g_MorphWeights` 每帧写；`MORPHING_NORMALS`、`MORPHING_MODIFIERS` 照读码。
- **`SKINNING_ALPHA`** 与 v23 记录表（裁切遮罩）：按步骤 0 的结论定做法。
- **验收**：挂点子对象的四角、变形顶点逐帧和 WPE 比；`3253330537` 的眼睛与嘴整帧比。

## P12c — 脚本

- `getAnimationLayerCount`、`getAnimationLayer`（名字或下标）返回包装对象，直接调 puppet 播放器，做法同 P10b 的 `IAnimation`；非 puppet 图层上照 WPE 的返回值。
- `IAnimationLayer` 的全部成员（`fps`、`frameCount`、`duration`、`name`、`rate`、`blend`、`visible`、`play` / `pause` / `stop` / `isPlaying`、`setFrame` / `getFrame` 等，以步骤 0 读到的为准）；从 `scriptApi.ts` 的缺失表删掉这两个方法。
- puppet 动画如果发 `AnimationEvent`，接到 P10b 已有的 `animationEvent` 派发。
- **验收**：脚本工程每一步和 WPE 的日志、抓帧一致；8 张用到的场景在 dev 强制渲染下脚本不报错。点击触发要等 P6c。

## P12d — 骨骼物理

- 骨骼 JSON 的物理参数解析进 bundle，`src/puppet/physics.ts` 每帧求解，位置照步骤 0（推测在动画采样之后、蒙皮矩阵之前）。
- 求解器是有状态的：重编译保留状态，对象隐藏、壁纸暂停时的行为照 WPE。
- 确定性回放喂同一串帧时间；如果 WPE 用固定步长，回放照抄步长。
- **验收**：物理工程逐帧比骨骼矩阵（误差包络按步骤 0 的实测定）；5 张物理场景和 WPE 同一时刻比整帧。

## 和其它节的交界

- **共享文件**：P5、P6、P8、P10、P11 的会话都在改 `compile/bundle.ts`、`compile/features.ts`、`render/graph.ts`、`render/scene.ts`、`render/renderer.ts`、`host.ts`、`script/api.ts`。
  - P12 的新代码放 `src/puppet/` 与 `compile/puppet.ts`；
  - 共享文件只加接线，按块暂存；
  - 改帧循环和图像层几何之前先看一次别的会话的状态，同 P6–P11 的约定。
- **P4a 层级**：挂点子对象的父链；161 个挂点子对象里 9 个是粒子，发射器位置跟不跟骨骼由步骤 0 定。
- **P5b / P5c**：puppet 网格的顶点布局、缓冲、`parseMdl` 都在 P5c；`(flags & 0x22)` 跳过 puppet 的规则在 P5b。
- **P6c**：用 `getAnimationLayer` 的脚本都在光标回调里。
- **P7 翻译器**：带骨骼组合键的着色器、`g_bufAnimation` 常量缓冲、`uint` 数组 uniform。改的是 Rust 翻译器，和场景渲染器的共享文件不冲突。
- **P8**：puppet 图层上的 effect、对齐、依赖，走 P8 已有的合成 RT 路径，只换基础 pass 的几何。
- **P10**：动画层的 `rate` / `visible` / `blend` 挂脚本时走 P3b / P10 的写回；puppet 动画的 `AnimationEvent` 接 P10b 的派发；动画层时钟和 P10 的时钟可能是同一种 float32 累加（步骤 0 比对），能共用就共用。
- **P11**：P12 的 37 张里 18 张还差 P11，主要是音频 uniform 与媒体回调。
- **P13**：模型对象的骨骼（`3706286085`）随 P13 接线。
- **工具**：kbp-tools 的 puppet mdl 编码与 b2 常量读取，按它的协议加（在 SKILL 里登记）。

## 决定（2026-11-14 用户：按推荐开始）

1. **蒙皮在哪做**：推荐 GPU，用翻译后的 WPE 着色器（`SKINNING` 等组合键），理由见「总体设计思路」。另一种是 CPU 蒙皮后当静态网格画：不用改翻译器，但 `SKINNING_ALPHA`、`MORPHING_MODIFIERS` 的公式要在 TS 里重写一遍，每帧还要重传顶点。
2. **模型对象的骨骼**：推荐 P12 只接 puppet 图层，骨骼运行时写成模型路径也能用，模型对象的接线随 P13 做。只影响 `3706286085` 1 张，它还差 P13 的雾、反射与阴影。
3. **分节**：推荐 P12a → P12b → P12c → P12d。物理放最后、单独一节：只 5 张，求解器的形状要等步骤 0；如果读出来很重，P12d 可以再拆，先照报 `puppet:physics`。
4. **顺序**：步骤 0 现在就做（只读码、只实测）。P12a 要改图像层几何、帧循环、能力表和翻译器，和 P5、P6、P8、P10、P11 的会话错开。

## 风险

1. **段格式与插值**：`MDLA` 四个版本、骨骼 JSON 的键都只能靠读码，没有公开资料（LWE 只画静态网格）。步骤 0 先读格式，再用编码出来的测试工程逐帧核对。
2. **翻译器**：带骨骼组合键的 `genericimage4` 从来没真正编过，`mat4x3` 数组、`uint` 数组、顶点着色器采样纹理、单独的常量缓冲都可能要补规则。步骤 0 先预检。
3. **物理的确定性**：有状态、可能依赖帧时间，和 WPE 逐帧比时误差会累积。步骤 0 定误差包络和回放方式。
4. **性能**：一张场景最多 21 个 puppet、单个最多 86 根骨骼，每帧在 CPU 上采样、混合、算矩阵。P12a 实测每帧开销，必要时把不可见、没有动画层的 puppet 跳过。
5. **测试工程**：要先能编码 puppet mdl，比 P10 多一层工具活。编码器照读码写，先用语料里的 puppet 往返解析核对。
6. **共享文件**：和多个会话同时改图像层、帧循环与能力表。按块暂存，必要时在 HEAD 快照里实现再三方合并。
