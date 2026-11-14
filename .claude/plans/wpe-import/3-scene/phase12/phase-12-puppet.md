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
  - 网格标志：0 有 144 个，`0x4` 10、`0x1000` 5、`0x100c` 1、`0x2` 1。步骤 0 查明（rea-p12-mdl 第 8 节）：
    - bit1 是纹理通道网格；
    - bit2 是 `SKINNING_ALPHA`（6 张）；
    - bit3 是绘制组加动态索引缓冲；
    - bit12 是变形目标的每顶点透明度，没有它时一个变形目标都不写；
    - bit13 加 `MORPHING_MODIFIERS`；
  - v21 起的两个可选块：可选块 1 有 45 个网格、可选块 2 有 116 个；v23 的记录表非空 5 个网格（4 张），名字形如 `masks/clipping_mask_<hash>`。步骤 0 查明：
    - 可选块 1 是每顶点的图像空间坐标，运行时没找到读者；
    - 可选块 2 是绘制组；
    - 记录表就是裁切遮罩，记录名是遮罩纹理。
- **段**（按图层计）：
  - `MDLS0001–0004` 155 个，即 5 个图层没有骨骼，是静态 puppet 网格（`3354366708`、`3811769317` 只有这种）；
  - `MDLA0001/0003/0005/0006` 143 个；`MDLE0002` 45、`MDAT0001` 34、`MDMP0001` 6。
- **骨骼**：
  - 132 个带骨骼的 mdl 文件（按文件计，下同）：骨骼数 1–8 的 96 个、9–16 的 17 个、17–32 的 10 个、33–64 的 5 个、更多的 4 个，最多 86 根。WPE 的 `BONECOUNT` 上限 128，都放得下；
  - 每根骨骼带一段 JSON（`FUN_140265c30` 解析）。共 1245 根，795 根非空：
    - 795 根都有 `a`、`s`、`tp`，691 根有 `lamin` / `lamax` / `tm`，685 根有 `rax` / `ray` / `raz`；
    - 物理参数（`m`、`gd`、`ge`、`r`、`re`、`rf`、`ri`、`rs`、`t`、`tf`、`ti`、`ts`、`la`、`lt`、`ltmax`、`se`）15 根；
    - IK 参数（`ik*`、`tax` / `tay` / `taz`）9 根，`ik` 全是假。
  - `r` 或 `t` 为真的骨骼 14 根，在 5 张场景。步骤 0 查明，物理要 `(r‖t) && (se‖re)` 才开，真正开物理的是 8 根骨骼、4 张场景：`2345214324`（4 根）、`3577990983`（2）、`3426865175`（1）、`3554161528`（1，`t`）。`3829467967` 的那根骨骼不开物理。
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
| P12a puppet 网格与骨骼动画 | puppet 网格 0 代替四边形（直接上屏，以及带 effect 时用 puppet 网格采样合成 RT 上屏）、`MDLS` / `MDLA`、动画层的时钟与混合、`SKINNING` / `BONECOUNT` 蒙皮、绘制组与绘制顺序（可选块 2、网格标志 bit3）、动画层字段的属性与脚本绑定；去掉 `model:puppet`、`object:animationlayers` | 88 → 97 | 135 → 148 |
| P12b 挂点、变形、骨骼透明度、裁切遮罩、纹理通道 | `MDAT` 与对象 `attachment`、`MDMP` 与变形纹理（`MORPHING`）、`SKINNING_ALPHA`（网格标志 bit2）、v23 记录表（裁切遮罩）、纹理通道（bit1，`puppettexturechannels`）；去掉 `object:attachment` | 100 | 156 |
| P12c 脚本 | `getAnimationLayerCount` / `getAnimationLayer`、`IAnimationLayer` 的全部成员、动画层字段上的脚本、`addEndedCallback`、`MDLA` 事件 | 100 | 163 |
| P12d 骨骼物理 | 骨骼 JSON 的物理参数（`(r‖t) && (se‖re)` 才开）、每帧求解 | 101 | 167 |

口径（步骤 0 之后按读码与实测重算，`ignore/p12/ana_sub2.py`）：
- **只做 P12**：HEAD 上 13 张只差 P12，按 a → b → c → d 依次解锁 9、3、0、1 张。
- **P4–P11 先做完**：
  - P4–P6 的键沿用 `ana_phases.py`，另把进行中的 P4f（`script:api:particle.*`）、P5c（`model:pending`）、P5d（`value:animation:camera`）、P6b（`text:script*`、`text:anchor:*`）算作做完，能渲染 108 张；P8 之后 111、P10 之后 114、P11 之后 135。
  - 之后只差 P12 的 32 张，按 a → b → c → d 依次解锁 13、8、7、4 张。
  - 每张按它要的子类归到最后一节：
    - 要挂点、变形、骨骼透明度（bit2）、记录表或纹理通道（任一网格带 bit1）的归 b；
    - 要脚本的归 c，要物理的归 d。
  - 写总计划时这里是 15、5、7、5，步骤 0 后有三处改动：
    - 网格标志 bit2 原来是骨骼透明度、bit12 是变形的每顶点透明度，用到它们的 5 张从 a 挪进 b；
    - `3811424158` 有纹理通道网格，从 a 挪进 b；
    - 物理的门比原来算的严，`3829467967` 的那根骨骼不开物理，从 d 挪进 b。
- **P12 场景还差别的节**（P4–P11 做完之后）：32 张只差 P12；2 张还差 P13（`3465215190`、`3706286085`）；3 张还差没归属的键（`model:passthrough:children:framebuffer` 2 张、`uniform:g_Texture3MipMapInfo` 1 张），不归 P12。
- P12 场景同时依赖别的节（HEAD 上）：18 张还差 P11，11 张还差 P10。用 `getAnimationLayer` 的脚本都在光标回调里，要 P6c。上面的「P4–P11 先做完」都假设它们先做完。
- PLAN 的表是 165 张口径（用到 35、只差它 5、累计 154），这里按 183 张重算，累计的假设也不同。

**P12 不做，继续报不支持：**
- **模型对象的骨骼**：`3706286085` 的 `BoostModel` / `FBX3`，报 `mdl:skeleton` / `mdl:animation` / `mdl:morph`。只这 1 张，还差 P13 的雾、反射、阴影；`src/puppet/` 的骨骼运行时写成模型路径也能用，接线归 P12（见「决定」2，2026-11-14 改定）。
- **语料 0 处的脚本 API**：骨骼、混合形状、挂点的读写，`createAnimationLayer` / `playSingleAnimation` / `destroyAnimationLayer`，`transformAttachmentToTexture`，照报原来的 `script:api:layer.*`。
- **IK 与骨骼约束**：WPE 的 IK 只看 `MDLS` v≥2 里的 IK 链记录，和骨骼 JSON 的 `ik` 无关。语料里一条 IK 链记录都没有，`ik` 也全是假。所以骨骼 JSON 的 IK 键中性，有 IK 链、约束、键表、链表记录的 mdl 照报 `puppet:ik`（步骤 0）。
- **`MORPHING_MODIFIERS`**（网格标志 bit13）、变形的法线与切线差（bit10 / bit11）：语料 0 个 puppet，照报细分键。
- **WPE 会崩溃的两种组合**：有骨骼透明度轨道但网格 0 没有 bit2、有绘制顺序轨道但没有 bit3。WPE 在这两种情况下写空指针，进程退出（前者实测，后者读码推断），所以没有可照着画的结果。语料 0 个，照报 `puppet:alpha-track` / `puppet:order-track`。

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
4. **骨骼物理**：PLAN 没提。骨骼 JSON 带物理参数，步骤 0 查明 4 张场景、8 根骨骼真正开着，单列 P12d。
5. **分节**：PLAN 没分节，这里按「网格与动画 → 挂点与变形 → 脚本 → 物理」分四节。
6. **模型对象的骨骼**：PLAN 把它算在 P12 里。本计划起先定为随 P13 接线，2026-11-14 用户改定为归 P12，和 PLAN 一致（「决定」2）。

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

子计划见 [phase-12a-mesh-animation.md](phase-12a-mesh-animation.md)（2026-11-14）：mdl 解析与 puppet 数据 → 运行时 → 编译期接线 → 渲染接线 → 真机对照 → 收尾。下面是写子计划之前的范围。

**已完成**（2026-11-14，子计划「实施记录」）：按 192 张能渲染 100 → 110，解锁 9 张加 `3351072238`，比本节表里的「只做 P12：88 → 97」多一张（`3351072238` 在 P3 修了属性缺省之后才算数）。和下面范围的出入：
- `p12-order`、`3463520581` 没有单独验收。绘制顺序轨道照报 `puppet:draw-order`（语料 1 张），`3463520581` 还差挂点；
- `p12-bind`（运行中改属性）只有单测，没做 WPE 对照；
- `rsqrtps` 的差在 4K 坐标下会被绑定平移放大，平移分量差到 1e-4 量级。生成工程逐像素相同，`2896608544` 有 ≤ 2 级的顶点舍入差。
文档见 `cocs/wpe/WPE_SCENE.md`「puppet 与骨骼动画（P12a）」。

语义依据见 [rea-p12-mdl](rea-p12-mdl.md) 第 1–4、7、9 节、[rea-p12-runtime](rea-p12-runtime.md) 与 [p12-REPORT](p12-REPORT.md) 第一部分用例 1–4、7、8。

- **编译期**：
  - `parseMdl` 读出 `MDLS`（骨骼、可选骨骼矩阵、绘制顺序基数）、`MDLA`（动画、轨道、各版本的附加轨道、事件）与可选块 2（绘制组）（`compile/mdl.ts`）。`MDLE` 只跳过：图像层的加载、更新、绘制都不读它。
  - 图像层读模型 JSON 的 `puppet`（字符串，且对象不是 fullscreen、不是组合层），`layer.puppet` 带网格 0、骨骼、动画、绘制组。`compile/bundle.ts` 只接线，解析与打包放 `compile/puppet.ts`。
    - 只用网格 0；puppet 的索引一律按 u16 读。
    - 顶点坐标是图层局部像素，不按 `size` 缩放。
  - 组合键：有骨骼时加 `SKINNING` 与 `BONECOUNT` = 真实骨骼数（不取 2 的幂，和模型路径不同）。静态 puppet（没有 `MDLS`）不加组合键。
  - 动画层：`animation` 找不到时整层丢掉；`rate` / `blend` / `visible` / `additive` / `blendin` / `blendout` / `blendtime` / `name` 的缺省值照读码。
  - 能力表：去掉 `model:puppet`、`object:animationlayers`；P12b–d 的用法和没查清的报细分键 `puppet:*`。
- **主线程**（`src/puppet/`，纯 TS，float32 照 WPE）：
  - 时钟和 P10 关键帧同一套：每帧加 `rate × dt`，帧号 = `t / spf`。模式在 `MDLA` 的动画记录里。`visible` 为假的层时钟不走、也不参与混合。
  - 采样：平移和缩放线性插值，旋转按最短路径 nlerp。静止姿势用 `MDLS` 的可选骨骼矩阵，没有时用局部矩阵。
  - 混合：按层序逐层叠，有覆盖、权重、加法三种。权重和不归一化。淡入时长 `min(D/2, blendtime)`，非 single 只淡一次，淡出只在 single 有效。
  - 蒙皮矩阵 = 父链世界矩阵 × 绑定姿势的逆。绑定姿势的逆由 `MDLS` 局部矩阵沿父链相乘再求逆得到。
  - 绘制组：只有绘制顺序轨道写入时，才按 `trunc(基数 + 轨道) + 组偏移` 升序重写索引；没有轨道时保持文件顺序。
  - 帧里的位置：和粒子在同一个更新循环里，在相机、P10 关键帧、脚本之前。图层隐藏时照样推进，壁纸暂停时冻结。
  - 绑定字段的生效：用户属性当帧生效，脚本写回下一帧生效。
  - 重编译时保留时钟（同 P10）。
- **渲染**：
  - 不带 effect：图像层直接上屏的四边形换成 puppet 网格。UV 乘「图像宽高 / GPU 纹理宽高」：DXT 纹理会缩放，PNG / JPG 纹理按图像尺寸上传、比例为 1。
  - 带 effect：基础 pass 照旧画四边形进合成 RT（按图像尺寸）。effect 在平面图像上做完后，最后用 puppet 网格采样合成 RT 上屏，UV 不缩放。
  - `g_Bones` 按翻译器给的 uniform 布局写（每骨骼 64 字节），不照搬 WPE 的 48 字节布局。
- **确定性回放**：dev 探针 `renderFrame` 与 kbp 回放按帧时间序列推进动画层时钟，从第 1 帧起。
- **验收**：
  - 生成工程 `p12-modes` / `-fade` / `-mix` / `-bind` / `-order` / `-fx` / `-fx2` 与语料 `3203778110`、`3463520581` 逐帧比 `g_Bones` 与顶点输出，残差到 float32 舍入级（步骤 0 的读码模型已做到 ≤ 5 ulp）；
  - 解锁的场景和 WPE 同一时刻比整帧；
  - 语料：去掉的键只落在 puppet 场景上，别的场景逐张不变。

## P12b — 挂点、变形、骨骼透明度、裁切遮罩、纹理通道

语义依据见 [rea-p12-mdl](rea-p12-mdl.md) 第 5–8 节、[rea-p12-attach-physics](rea-p12-attach-physics.md) 第 1 节与 [p12-REPORT](p12-REPORT.md) 第一部分用例 5、6、11、第二部分第 2、3 节。

- **挂点**：对象 `attachment` 在父 puppet 的 `MDAT` 里按全名查第一个。子对象的世界矩阵是 `W_父 · Pose[骨骼] · Att · T·R·S`，其中 `W_父` 是基类矩阵（不含 alignment）、`Pose` 是本帧动画之后的骨骼矩阵。
  - 挂点退成普通父子的情况：查不到、父不是 puppet、子排在父前面。
  - 粒子、文本、分组子对象都走同一个世界矩阵。
  - 接进层级（P4a）的父链：父的 puppet 更新要排在子之前。
- **变形**：
  - `MDMP` 打成 `R16G16B16A16_SNORM` 变形纹理放槽 5，纹素 0 = (0, 0, 0, 1)，目标 t 第 v 个变形顶点在 `1 + t·nv + v`；
  - 每帧写 `g_MorphOffsets` / `g_MorphWeights`：最多 11 个生效目标，按权重从大到小排；
  - 网格标志没有 bit12 时一个目标都不写，但仍按权重把变形顶点的透明度乘 (1 − w)；
  - 图像层不加 `MORPHING_NORMALS`。
- **骨骼透明度**：网格标志 bit2 加 `SKINNING_ALPHA`，`g_BonesAlpha` 来自动画的每骨骼透明度轨道，覆盖、权重、加法三种合成照实测。
- **裁切遮罩**（v23 记录表）：照 p12-REPORT 第二部分 3.4 的步骤画。
  - 记录的 `list2` 是遮罩，画进半分辨率的 R8 遮罩 RT，用 `clippingmaskimage4`；遮罩组照常也作为普通组画一次。
  - `list1` 是被裁切的组，只用 `CLIPPINGUVS` + `CLIPPINGTARGET` 变体画。
  - 每条记录各清一次、画一次遮罩。
- **纹理通道**（任一网格带 bit1，`3811424158`）：`puppettexturechannels` 加 `BLENDROWCOUNT` 能翻译；合成出的 RT 怎么替换图层的槽 0，步骤 0 没查清，P12b 子计划先补读码。
- **验收**：挂点子对象的四角、变形顶点、`g_BonesAlpha` 逐帧和 WPE 比（生成工程 `p12-att` / `p12-am`、语料 `3463520581`）；`3253330537` 的眼睛与嘴、`3491865410` 的裁切遮罩整帧比。

## P12c — 脚本

语义依据见 [rea-p12-attach-physics](rea-p12-attach-physics.md) 第 4 节与 [p12-REPORT](p12-REPORT.md) 第一部分用例 9。

- `getAnimationLayerCount`、`getAnimationLayer`。
  - 参数：整数按下标；字符串按层的 `name`，同名取最后一个。
  - 找不到时返回 `null`：非整数、数字字符串、非 puppet 图层、静态 puppet 都算找不到。计数在这些情况下是 0。
  - 返回的包装对象直接调 puppet 播放器，做法同 P10b 的 `IAnimation`，同一层每次返回同一个对象。
- `IAnimationLayer` 的成员以实测为准：
  - 可写：`blend`、`name`、`rate`、`visible`、`additive`、`blendin`、`blendout`、`blendtime`；
  - 方法：`play` / `pause` / `stop` / `isPlaying`、`setFrame` / `getFrame`、`addEndedCallback`、`getAnimation`；
  - 只读的 `fps` / `frameCount` / `duration`，赋值抛 TypeError；
  - 方法调用下一帧生效；`setFrame` 抑制紧接着那次播完回调；`play()` 不重新淡入。
- `addEndedCallback`：loop 每次回绕、mirror 每次换向、single 一次时调，回调不带参数。
- `MDLA` 的事件：层时钟越过事件时间时，调同一图层上脚本的 `animationEvent`，`event` 是事件 JSON 的全部字段。接到 P10b 已有的派发。
- 动画层字段上挂的脚本：`thisObject` 是那个 `IAnimationLayer`，`thisLayer` 是图像层。
- 从 `scriptApi.ts` 的缺失表删掉这两个方法。
- **验收**：生成工程 `p12-script` 每一步和 WPE 的日志、抓帧一致；8 张用到的场景在 dev 强制渲染下脚本不报错（`3326873240` 照 WPE 抛 TypeError）。点击触发要等 P6c。

## P12d — 骨骼物理

语义依据见 [rea-p12-attach-physics](rea-p12-attach-physics.md) 第 2 节与 [p12-REPORT](p12-REPORT.md) 第一部分用例 10、第二部分第 1 节。

- 开关：骨骼 JSON 要 `(r‖t) && (se‖re)` 同时成立才开物理，否则标志清零。语料 4 张场景、8 根骨骼。
- 求解：
  - 位置：动画采样与父链之后、蒙皮之前，按骨骼下标逐根算。
  - 步长：dt 就是帧时间，没有子步，积分比例 `min(60·dt, 1)`。
  - 惯性：用上一帧物理之后的世界骨骼矩阵。图层移动会带动骨骼；脚本移动图层时，物理用的是上一帧脚本写的位置。
  - 回弹：`re` 没有回弹，`se` 有弹簧。
  - 另有重力、角度限制、平移弹簧与距离钳制；`rotTo` 的点积阈值要照抄。
  - 首帧不算物理，隐藏照算，暂停冻结。
- 状态：重编译保留；确定性回放喂同一串帧时间。
- **验收**：
  - 误差包络：`rotTo` 阈值附近差 1 ulp 就翻转、`re` 不回弹，逐位一致做不到。包络按「200 帧内物理转角误差 ≤ 2e-5 rad」量级定（p12-REPORT 第二部分 1.3）。
  - 生成工程 `p12-phys` / `p12-phys2` 与语料 `2345214324`、`3426865175` 逐帧比骨骼矩阵，在包络以内；
  - 4 张物理场景和 WPE 同一时刻比整帧。

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
- **P13**：模型对象的骨骼（`3706286085`）归 P12 接线，和 P13 总计划（`be03b279`）的口径一致（2026-11-14 用户定，已告知 P13 会话）。这张要画出来，还要等 P13 的雾、屏幕空间反射、阴影与灯的运行时。
- **工具**：kbp-tools 的 puppet mdl 编码与 b2 常量读取，按它的协议加（在 SKILL 里登记）。

## 决定（2026-11-14 用户：按推荐开始）

1. **蒙皮在哪做**：推荐 GPU，用翻译后的 WPE 着色器（`SKINNING` 等组合键），理由见「总体设计思路」。另一种是 CPU 蒙皮后当静态网格画：不用改翻译器，但 `SKINNING_ALPHA`、`MORPHING_MODIFIERS` 的公式要在 TS 里重写一遍，每帧还要重传顶点。
2. **模型对象的骨骼**：起先推荐 P12 只接 puppet 图层，模型对象的接线随 P13 做。**2026-11-14 用户改定：归 P12**，和 PLAN、P13 总计划一致，已告知 P13 会话。只影响 `3706286085` 1 张，它还差 P13 的雾、反射与阴影，所以 P12 做完也不解锁。放进哪一节写子计划时定，倾向 P12b（模型的变形 `0x400` 也在那一节）。
3. **分节**：推荐 P12a → P12b → P12c → P12d。物理放最后、单独一节：只 5 张（步骤 0 后是 4 张），求解器的形状要等步骤 0；如果读出来很重，P12d 可以再拆，先照报 `puppet:physics`。
4. **顺序**：步骤 0 现在就做（只读码、只实测）。P12a 要改图像层几何、帧循环、能力表和翻译器，和 P5、P6、P8、P10、P11 的会话错开。

## 风险

1. ~~**段格式与插值**~~：步骤 0 读出全部段的格式（语料 137 个 mdl 逐段读到段末、编码器往返 136 个逐字节相同），动画的时钟、采样、混合和 WPE 差 ≤ 5 ulp。
2. ~~**翻译器**~~：步骤 0 预检四个 puppet 着色器在全部组合下都能翻译（`puppettexturechannels` 要给 `BLENDROWCOUNT`），不用改翻译器；还没在真 WebGPU 上建过管线，P12a 第一步补。
3. **物理的确定性**：步骤 0 定了做法：dt 就是帧时间，回放喂同一串帧时间。`rotTo` 的阈值附近差 1 ulp 就翻转判定，`re` 又不回弹，所以逐位一致做不到，按误差包络验收（见 P12d）。
4. **性能**：一张场景最多 21 个 puppet、单个最多 86 根骨骼，每帧在 CPU 上采样、混合、算矩阵。P12a 实测每帧开销，必要时把不可见、没有动画层的 puppet 跳过。
5. ~~**测试工程**~~：编码器 `ignore/p12/defs/puppet.py` 已写好、往返核对通过，13 个生成工程在 `ignore/p12/defs/p12.py`。还没并进 kbp-tools，别的会话也在改它，等它们空下来再并。
6. **共享文件**：和多个会话同时改图像层、帧循环与能力表。按块暂存，必要时在 HEAD 快照里实现再三方合并。

## 实施记录

### 步骤 0 — 调研（2026-11-14）

读码三份（代理读 `wallpaper64.exe` 2.8.42 与 `scenescript64.dll`；REA 在本机三次都卡在启动分析超时，改读全量反汇编 `ignore/p4/rea/wp.asm`）：
- [rea-p12-mdl](rea-p12-mdl.md)：段格式与图像层的 puppet 加载；
- [rea-p12-runtime](rea-p12-runtime.md)：动画层时钟、采样、混合、蒙皮与上传；
- [rea-p12-attach-physics](rea-p12-attach-physics.md)：挂点、骨骼物理、IK、脚本 API。

实测见 [p12-REPORT](p12-REPORT.md)，分三部分：
- 主会话：翻译器预检、6 张语料场景的真值、复核；
- 第一部分：13 个生成工程、11 类用例；
- 第二部分：语料里的物理、挂点、裁切遮罩与绘制组。

工具与数据在 `ignore/p12/`：
- mdl 解析器 `rea/mdl/mdl12.py`、编码器 `defs/puppet.py`、工程定义 `defs/p12.py`；
- 读码模型 `rea/runtime/posemodel.py`、`rea/attach/physmodel.py`，组合模型 `meas/combo.py`；
- 翻译器预检 `pre/`，分节统计 `ana_sub2.py`。

结论（逐条见三份读码与报告）：
- **动画**：时钟和 P10 关键帧同一套，采样、三种混合、淡入淡出、绑定字段的生效帧都实测过。读码模型和 WPE 的骨骼矩阵差 ≤ 5 ulp，多数逐位相同。
- **画法**：
  - puppet 只画网格 0，`BONECOUNT` 等于真实骨骼数；
  - 不带 effect 时直接上屏，UV 按 GPU 纹理尺寸缩放；
  - 带 effect 时，基础 pass 照旧画四边形进合成 RT（按图像尺寸），最后用 puppet 网格采样合成 RT 上屏；
  - 静止姿势不用 `MDLE`。
- **网格标志**：bit1 纹理通道、bit2 骨骼透明度、bit3 可变绘制顺序、bit12 变形的每顶点透明度、bit13 变形修正。
- **挂点、物理、裁切遮罩**：公式和画法都对上。物理按误差包络验收。
- **脚本**：查找规则、成员、播完回调、`MDLA` 事件都实测过。动画层字段脚本里的 `thisObject` 是动画层。
- **IK**：语料里中性。
- **翻译器**：不用改。

对后面各节的影响已改进上文：
- 分节表与口径重算：a → b → c → d 依次解锁 13、8、7、4 张，只做 P12 时是 9、3、0、1 张；
- 骨骼透明度、变形的每顶点透明度、纹理通道挪进 P12b，物理改为 4 张、8 根骨骼；
- P12a–d 按读码与实测写明做法和验收样本；
- 「P12 不做」补上 IK 链、`MORPHING_MODIFIERS`、会让 WPE 崩溃的两种组合；
- 风险 1、2、5 划掉，3 改成按误差包络。

**WPE 崩溃一次。** 实测代理的生成工程里有一个 puppet，带骨骼透明度轨道、网格却没开 bit2。打开它时，用户常驻的 WPE 往空指针写、进程退出，桌面壁纸和别的会话的测试窗口一起断了。之后 WPE 被重新拉起（`-silent`），主会话核过：已重新注入，桌面壁纸窗口在。肇事的 puppet 已经从工程定义和生成的工程里删掉；「有绘制顺序轨道、没有 bit3」读码推断同样会崩，没有跑。实现时这两种组合照报不支持，不照抄。

**和 P13 总计划的出入**：本计划按「决定」2 把模型对象的骨骼（`3706286085`）留给 P13 接线；P13 总计划（`be03b279`）的「P4–P12 先做完」把这张的骨骼算作 P12 做完。两边要统一，由用户定。骨骼运行时本来就写成两边都能用，差别只在模型路径的接线归哪一节。（2026-11-14 用户定：归 P12，见「决定」2。）

没查清、留给各节子计划：
- 纹理通道合成出的 RT 怎么替换槽 0（P12b）；
- 同一条裁切记录的 `list1` 有多个组时怎么画；
- 遮罩 RT 的一半是对窗口还是对场景 RT；
- 带 effect 的 puppet 上的裁切；
- 变形的负权重与并列排序；
- 物理的 `la` 限位、`lt`、轴锁、不可见时照算；
- 挂点父有 `alignment`、挂在物理骨骼上；
- 对象整体隐藏与壁纸暂停时动画推不推进的实测；
- `blend` 绑用户属性的生效帧；
- 语料 0 处的脚本 API。

我的失误：
- 第一次试抓的 `3351072238`，puppet 默认被用户属性隐藏，没画；
- 总计划把 `3811424158` 当作「1 根骨骼的简单样本」，其实它带纹理通道；
- 给两个实测代理的简报没说明回放进程是本会话共用的：一个代理收尾时关掉了另一个代理打开的抓帧，被关的那两项已重读、逐字节相同；
- 给生成工程的代理的简报只限制了「卡死、忙等、死循环」，没要求先避开读码里可疑的组合，结果弄崩了共享的 WPE。
