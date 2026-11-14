# P13 — 3D 反射、光照与阴影（总计划）

> 上级：[PLAN.md](../PLAN.md)「P13 — 3D 反射、光照与阴影」。前置：步骤 0 只读码、只实测，可以和 P5、P6、P8、P10、P11、P12 并行（2026-11-14 用户：「其他地方在做 phase5，phase6，phase8，phase10，phase11，phase12；phase4、phase9、phase7 已完成 你趁这个时间开始P13」）。改渲染器共享文件的步骤要和它们错开，见「和其它节的交界」。
> 本文件只定目标、分节和验收；各节动工前另写子计划，步骤 0 先读码再实测。
> 统计基于 HEAD `d58a7048` 的语料扫描 `ignore/p13/out/corpus-head.json`（183 个工程，能渲染 88 张；源码快照 `ignore/p13/head`）。覆盖：`ignore/p13/ana_p13.py`（键的归属与子类）、`ignore/p13/ana_sub.py`（分节累计）；逐场景的灯、`lightconfig`、雾、反射对象与材质 COMBO：`ignore/p13/scan_p13.py` → `ignore/p13/out/scan.json`（`show_scan.py` 打印）；工程原文搜索：`ignore/p13/grep.py`。
> 现状行号按 HEAD `d58a7048`。

## 总体设计思路

P13 是 3D 的最后一块。P5 已经给了网格、深度、透视相机与相机对象，`lighting-REPORT` 已经实现了 `#require LightingV1` 的四种灯和无 effect 图层的光照。剩下的东西按落点分成三类，各走一条通路：

- **主 pass 之外的场景视图：平面反射与阴影。** WPE 的场景绘制函数有三种模式（rea-p5-mesh 4.1）：模式 0 是主 pass；模式 1 把 `reflected` 不为 false 的可画对象用镜像视图画进 `_rt_Reflection`；模式 2 把 `castshadow` 且不透明的对象画进阴影图集。三种模式遍历的是同一份对象表，只是目标、视图、剔除方向和名单不同。我们现在的绘制循环（`render/scene.ts` 的 `encode`）只认一个目标、一个视图，每次绘制的 MVP 在建 draw 时就写死成主视图的。P13 照 WPE 的形状，把它参数化成「场景视图」：目标、视图投影、眼位、剔除是否翻转、名单。主 pass 是其中一个视图，反射 pass 与每盏投影灯的阴影 pass 是另外几个。按视图变的 uniform（矩阵、眼位、视图向量）每个视图各写一份，其余共用。这是 P13 最大的改动，平面反射先建它，阴影接着复用。
- **主 pass 之后的帧缓冲加工：屏幕空间反射与体积光。** `generic3` / `generic4` / `genericimage2–4` 的 `REFLECTION` 不读 `_rt_Reflection`，读的是 `_rt_MipMappedFrameBuffer`：主 pass 的结果拷出来、生成 mip，着色器按粗糙度取 mip 级（`g_Texture3MipMapInfo`）。这和 `_rt_FullFrameBuffer` 的快照是同一类东西，多一步生成 mip（WebGPU 没有现成的生成函数，要自己写一个缩小 pass）。体积光（`castvolumetrics`）在步骤 0 之前还不知道是不是这一类，读码先回答它在帧里的位置和读什么。
- **喂给着色器的引擎数据：遗留灯、雾、灯的运行时状态。** 遗留灯（`"light": "point"`）写 `g_LightsPosition[4]` 与 `g_LightsColorRadius[4]`（`generic` / `generic2` 读）或 `g_LightsColorPremultiplied[3]`（`genericimage2` 读，步骤 0 更正）；雾是 `FOG_DIST` / `FOG_HEIGHT` 两个引擎宏加一组 uniform。灯现在是编译期常量（`lights.ts`），绑属性的字段登记重编译，关键帧照报，挂父对象照报；灯字段上的脚本照常运行，但 `targetOf` 给它的目标是 `unsupported`，返回值不落地，也不报键（`3706286085` 的两盏灯画面会静默不同）。P13 把灯改成和图层一样的运行时状态：编译期给每盏灯一份字段表（类型、字段、绑定目标），渲染器每帧由 `SceneState` 沿父链算世界矩阵、可见性，再算灯光 uniform。属性、关键帧（P10 的运行时）、字段脚本都走就地路径，`object:parent`（灯）与 `value:animation:light` 一起去掉。

另外三项是零散的：
- **能力表误报**：`combo:REFLECTION` 按名字报。7 张里有 5 张用了工坊 effect `cursorripple`，它的同名选项是波纹在边界反弹的开关（`cursorripple_simulate_force.frag`）；1 张是 `genericimage2` 不带法线图的 `REFLECTION`。这两种都不读引擎数据。只有误报的 5 张；另 2 张（`3453730450`、`3706286085`）还有真正的屏幕空间反射。真正要引擎数据的两种反射已经由读到的 RT 与 `g_Texture3MipMapInfo` 报出，所以 `REFLECTION` 不该再按名字报。
- **翻译器**：`generic` 用 `#define g_NormalMapSampler g_Texture1` 这类宏别名给采样器起名，`generic4` 的 `SHADINGGRADIENT` 同样（`GRADIENT_SAMPLER`）。我们的 `texSample2D` 改写在宏展开之前，认不出别名。
- **`sprite` 对象**（ricepod 的太阳）：一种独立的可画对象，带自己的材质，几何与朝向由步骤 0 读出。

**画质档位。** WPE 的 `config.json` 有 `shadows`、`volumetrics` 两个画质项（p2-REPORT：disabled / low / medium / high / ultra，用户现在都是 `low`），反射也有用户设置（rea-p5-mesh 第 5 节的 `reflection`、`resolution`）。它们和 `postprocessing` 一样决定画面，照 D9 的做法：Kabegame 加一组设置，缺省跟随 WPE，也可以固定档位或关掉（「决定」3）。

关键决策沿用前几节：
- WPE 语义以读码加实测为准；能实测的不只靠读码。
- 能力表是唯一事实来源，没实现的照报，整张退回。
- 验收和 WPE 比，不和作者的预览图比。

P13 另有三条：
- **一套场景视图。** 反射、阴影和主 pass 遍历同一份对象表，分开写会有三套排序、可见性与剔除，P5d 刚统一的深度规则也会分叉。
- **灯是运行时状态。** 父对象、关键帧、脚本、属性四件事都要求灯每帧可变；只补其中一件，其余三件还得再改一次。
- **新代码放进独立模块。** 场景视图与反射放 `render/views.ts`、`render/reflection.ts`，阴影放 `render/shadows.ts`，体积光放 `render/volumetrics.ts`，运行时灯放 `render/lights.ts`，雾的编译期数据并进 `compile/lights.ts`；共享文件只加接线。

## 范围与覆盖

语料（`ana_p13.py`、`scan_p13.py`）：
- **规模**：15 张用到 P13 的键，HEAD 上只差 P13 的 8 张：`arsenal`、`audiophile`、`demon_core`、`fantasticcar`、`ricepod`、`3287715210`、`3413921910`、`3498150384`。
- **灯**：7 张场景有灯对象（`lpoint` 10 盏、遗留 `point` 3 盏、`ldirectional` 1 盏），5 张写了 `lightconfig`。带 `castvolumetrics` 的灯 9 盏、`castshadow` 的 4 盏；挂父对象的 3 盏（2 盏的父对象是模型）；字段绑属性的 `intensity` 2 处、`color` 1、`visible` 1，挂脚本的 `intensity` 2 处（`3706286085`，按住鼠标改亮度），关键帧 1 处（`3465215190` 的 `intensity`）。
- **材质**：开 `LIGHTING` 的 pass 6 个（`generic4`，3 张 3D 工坊场景），`REFLECTION=1` 5 个，`FOG=1` 5 个（只有 `3706286085` 在 `general` 里开了雾），`generic` 的 `lightmap` / `normalmap`（小写键）6 个（arsenal），车漆 `car` 的 `metal` / `paintwork`（fantasticcar，HEAD 上已经翻译通过）。
- **反射对象**：`reflected` 写成真值的 3 个（audiophile 1、fantasticcar 2）；缺省也进名单（rea-p5-mesh 第 5 节），所以名单比这个大。
- **语料里没有的**：`lighting:prelighting`、`lighting:effect`（带 effect 或 passthrough 的图层开光照，PLAN 列在 P13）0 张；`spotcookie` / `spotshadow` / `spotshadowcookie` 0 张。

| 键 | 子类 | 张数 | 场景 |
|---|---|---|---|
| `combo:REFLECTION` | 误报 | 7 | `2974757317`、`3400241651`、`3413921910`、`3453730450`、`3498150384`、`3706286085`、`3833971732` |
| `texture:rendertarget:_rt_Reflection` | 平面反射 | 3 | arsenal、audiophile、fantasticcar |
| `uniform:g_LightsPosition` / `g_LightsColorRadius` | 遗留灯 | 1 | demon_core |
| `shader:generic:rewrite:…`、`shader:generic4:rewrite:…GRADIENT_SAMPLER` | 采样器宏别名 | 2 | arsenal、`3453730450` |
| `texture:rendertarget:_rt_MipMappedFrameBuffer`、`uniform:g_Texture3MipMapInfo` | 屏幕空间反射 | 2 | `3453730450`、`3706286085` |
| `lightconfig:pointshadow` / `directionalshadow` | 阴影 | 3 | `3287715210`、`3465215190`、`3706286085` |
| `object:castvolumetrics` | 体积光 | 4 | `3287715210`、`3453730450`、`3465215190`、`3837478759` |
| `general:fog*` | 雾 | 1 | `3706286085` |
| `object:parent`（灯）、`value:animation:light` | 灯的运行时 | 3 | `3453730450`、`3465215190`、`3706286085` |
| `object:sprite`、`material:depthtesting` / `depthwriting` | sprite 对象 | 1 | ricepod |

分节（推荐顺序，`ana_sub.py`）：

| 节 | 内容 | 只做 P13 时累计能渲染 | P4–P12 先做完时累计 |
|---|---|---|---|
| P13a 能力表纠错、遗留灯与 generic 着色器 | `combo:REFLECTION` 不按名字报；遗留灯 uniform；翻译器展开采样器宏别名 | 88 → 91 | 165 → 171 |
| P13b 平面反射 | 场景视图；`reflected` 名单按镜像视图画进 `_rt_Reflection` | 94 | 174 |
| P13c sprite 对象 | `sprite` 对象的几何与绘制；ricepod 拼错的深度键 | 95 | 175 |
| P13d 阴影 | 阴影图集、投射者的阴影 pass、`g_LFeature_Shadow*`、比较采样 | 95 | 175 |
| P13e 体积光 | `castvolumetrics` | 96 | 177 |
| P13f 雾与灯的运行时 | `FOG_DIST` / `FOG_HEIGHT`；灯每帧由状态算（父链、关键帧、脚本、属性） | 96 | 177 |
| P13g 屏幕空间反射 | `_rt_MipMappedFrameBuffer` 的拷贝与 mip、`g_Texture3MipMapInfo` | 96 | 177 |
| P13h 透视场景的余项（决定 2） | `transparentsorting`、透视场景里的文本与带子层的组合层 | 96 | 180 |

口径：
- **只做 P13**：8 张只差 P13。P13a 解锁 `3413921910`、`3498150384`、demon_core；P13b 解锁 audiophile、fantasticcar、arsenal（arsenal 还要 P13a 的翻译器）；P13c 解锁 ricepod；P13d + P13e 解锁 `3287715210`（阴影和体积光都要）。
- **P4–P12 先做完**：把 P5d、P6、P10、P11、P12、P4f 的键都算作做完，能渲染 165 张。之后只差 P13 的 15 张（含 P13h；不含时 12 张），全部做完 180（不含 P13h 时 177）。
- **还挡着的**：`3465215190` 另差 `model:passthrough:children:framebuffer`（没有归属，不归 P13），P13 全做完也不能渲染；这个键另外 2 张（`3233141951`、`3524852519`）同样。
- **P13 场景还差别的节**（HEAD，按场景数）：P6 6 张、P11 4、P12 4、P10 3、P5d 2。3D 工坊场景 `3453730450`、`3706286085`、`3465215190` 都要好几节先合入，P13 自己的验收主要靠默认工程和确定性工程。
- PLAN 的表是 165 张口径（用到 11、只差它 2、累计 165），这里按 183 张重算，累计的假设也不同。

**P13 不做，继续报不支持：**
- **带 effect 或 passthrough 的图层开光照**（`lighting:prelighting`，`PRELIGHTING` 与 `g_Alt*`）、**effect 自己开光照**（`lighting:effect`）：语料 0 张，按需（决定 4；`PRELIGHTING` 的照报处标了 `TODO:[WPE_SCENE]`）。
- **聚光的阴影与 cookie**（`lightconfig:spotshadow` / `spotcookie` / `spotshadowcookie`，`_alias_lightCookie`）：语料 0 张。步骤 0 读到阴影图集的通用规则时顺带记下聚光的部分，实现按需。
- **`model:passthrough:children:framebuffer`**：带子层的组合层读帧缓冲，不是 3D，不归 P13。

## 现状锚点

**a. `REFLECTION` 按名字报**（`apps/wpe-scene/src/compile/features.ts:170`、`:1230`）
```ts
const ENGINE_COMBOS = new Set(["SPRITESHEET", "REFLECTION", "SKINNING", "SKINNING_ALPHA", "MORPHING", "PRELIGHTING"]);
// checkProgramFeatures
  for (const combo of result.combos ?? [])
    if (combo.value !== 0 && ENGINE_COMBOS.has(combo.name.toUpperCase()))
      unsupported.add(`combo:${combo.name.toUpperCase()}`); // 现状：cursorripple 的同名选项（缺省 1）也报 combo:REFLECTION
```

**b. 遗留灯的 uniform 不是引擎 uniform**（`compile/features.ts:138`、`compile/lights.ts:7`）
```ts
export function isEngineUniform(name: string): boolean {
  // 灯光数组由 `lights.ts` 随材质常量写入
  return (
    ENGINE_UNIFORMS.has(name) ||
    UNREAD_UNIFORMS.has(name) ||
    /^g_Texture\d+(?:Resolution|Texel)$/.test(name) ||
    /^g_L(?:Point|Spot|Tube|Directional)_/.test(name) // 现状：g_LightsPosition / g_LightsColorRadius 不在里面，读到就报
  );
}
// lights.ts 头注释
 * - **`"light": "point"` 是遗留灯**，不进这里的数组：它写 `g_LightsPosition` 等，只有 `generic` / `generic2` 读。
```

**c. 运行时 RT 表里没有的名字就报**（`compile/bundle.ts:1503`）
```ts
      if (name.startsWith("_rt_")) {
        if (bindRuntime(slot, name))
          formats.push({ slot, format: FBO_FORMATS[context.fbos?.get(name)?.format ?? "rgba8888"].tex });
        else issues.add(`texture:rendertarget:${name}`); // 现状：_rt_Reflection、_rt_MipMappedFrameBuffer 走到这里
        continue;
      }
```

**d. 阴影灯数照报**（`compile/lights.ts:21`、`:41`）
```ts
/** 阴影与 cookie 的灯数键：要 `_rt_shadowAtlas` / `_alias_lightCookie`，渲染器没有。 */
const SHADOW_KEYS = ["spotshadowcookie", "spotshadow", "spotcookie", "directionalshadow", "pointshadow"];
export function lightConfigIssues(general: Record<string, unknown>): string[] {
  // …
  return SHADOW_KEYS.filter((key) => count(source[key]) > 0).map((key) => `lightconfig:${key}`); // 现状：有阴影灯数就报
}
```

**e. 灯的键表没有体积光，挂父对象照报**（`compile/features.ts:511`、`:789`）
```ts
const LIGHT_KEYS = new Set([
  "light", "intensity", "radius", "exponent", "innercone", "outercone", "controlpoint", "density",
  "volumetricsexponent", "cascadedistance0", "cascadedistance1", "cascadedistance2", "lightsourcesize",
  "castshadow", "usecookie", // 现状：没有 castvolumetrics，按未知键报 object:castvolumetrics
]);
// checkObjectFeatures
  // 灯的位置取本地 origin（`lights.ts`），挂在父链下时的位置没有和 WPE 比过，照报
  if (kind === "light" && parent !== null) unsupported.add("object:parent");
```

**f. 灯是编译期常量**（`compile/bundle.ts:1057`、`compile/animations.ts:225`）
```ts
  /** 开了光照的程序才读；没人用时不解析灯对象，也不登记它们的绑定。 */
  let lights: Record<string, number[]> | null = null;
  const sceneLights = () =>
    (lights ??= lightUniforms(
      scene.objects,
      counts,
      bindingReader(bindings, properties, (path) => recompile("layer-structure", path)), // 现状：绑属性的灯字段一律重编译
    ));
// animations.ts collectAnimations
    if (isRecord(object) && isLightObject(object)) {
      unsupported.add("value:animation:light"); // 现状：灯字段的关键帧没有就地目标
      return;
    }
```

**g. 雾的 general 键不在中性表**（`compile/features.ts:452`）
```ts
  for (const [key, value] of Object.entries(g))
    if (
      !NEUTRAL_GENERAL.has(key) &&
      !PARSED_GENERAL.has(key) &&
      // … bloom* / cameraparallax* / camerashake* / supportsaudioprocessing / zoom
      active(value)
    )
      unsupported.add(`general:${key}`); // 现状：fogdistance、fogheight 等 12 个键各报一条
```

**h. 对象类型里没有 `sprite`**（`compile/features.ts:529`）
```ts
const OBJECT_KINDS = ["image", "model", "particle", "sound", "text", "light"] as const; // 现状：sprite 对象的 `sprite` 键按未知键报 object:sprite
```

**i. 翻译器在宏展开之前改写纹理调用**（`src-tauri/wpesl2wgsl/src/rewrite.rs:1544`）
```rust
        let texture_name = args.first().map(|a| a.trim()).unwrap_or_default();
        let Some(texture) = textures.iter().find(|t| t.name == texture_name) else {
            return Err(format!(
                "{function} 的第一个参数不是已声明的纹理：{texture_name}" // 现状：g_NormalMapSampler 是 #define 别名，这里认不出
```

**j. 绘制循环只有一个场景目标、一个视图**（`render/scene.ts:3553`）
```ts
    const begin = (view: GPUTextureView = sceneView): GPURenderPassEncoder => {
      if (open && open.view === view) return open.pass;
      end();
      const scene = view === sceneView;
      // …
      const pass = encoder.beginRenderPass({
        label: scene ? "scene" : "group", // 现状：只有场景目标与组的合成 RT 两种目标；每次绘制的矩阵在建 draw 时按主视图写好
```

## 与 PLAN.md 的差异

1. **语料**：PLAN 写「用到 11、只差它 2」（165 张），现在 183 张：用到 15，HEAD 上只差 P13 的 8 张，P4–P12 做完后只差 P13 的 12 张。
2. **反射有两种**：PLAN 只写了 `reflected` 与反射 RT、`REFLECTION` COMBO。实际 `REFLECTION` 多数是误报；真正的反射一种是平面反射（`reflected` 名单画进 `_rt_Reflection`，`generic` / `generic2` / `grid` 读），一种是屏幕空间反射（`_rt_MipMappedFrameBuffer`，`generic3` / `generic4` / `genericimage2–4` 读）。
3. **`PRELIGHTING` 与 effect 光照**：PLAN 列为新增，语料 0 张，改为不做、照报。
4. **材质**：PLAN 写「内置 `generic` 的 lightmap / normalmap / reflection；车漆 shader 的 metal / paintwork；`selfillum`」。`generic` 的问题是翻译器认不出采样器宏别名；车漆在 HEAD 上已经翻译通过，fantasticcar 只差 `_rt_Reflection`；`selfillum`、无内容的变换节点、arsenal「1 处引用解析为空」在 HEAD 的扫描里都没有键，步骤 0 复核。
5. **audiophile 的 `grid.tex`**：PLAN 说 grid 缺 `materials/grid/grid.tex`。工程里确实只有 `grid.png` + `grid.tex-json`，但扫描没报缺纹理，模型用的可能是 `grid2`（有 `.tex`）。步骤 0 核实用的是哪份材质，以及 WPE 遇到只有 `tex-json` 的纹理怎么办。
6. **新增**：`sprite` 对象之外，P5d 照报、没有归属的三项（`transparentsorting`、透视场景里的文本、带子层的组合层）挡着 3 张 3D 场景，见「决定」2；WPE 的阴影 / 体积光 / 反射画质设置，见「决定」3。

## 步骤 0 — 调研（整节一次）

**读码**（两个代理并行，REA 看 `wallpaper64.exe` 2.8.42；rea-p5-mesh 第 4、5 节、lighting-REPORT、p2-REPORT A4 与 RT 表已读到的部分只复核）：

`rea-p13-passes.md`（多出来的 pass）：
- **平面反射**（rea-p5-mesh 第 5 节已读到名单与入口）：
  - 镜像视图 `FUN_14017e180`：镜面是哪个平面、怎么从相机算（正交与透视各自）、有没有斜裁剪面；
  - `_rt_Reflection` 的尺寸（`resolution` 设置的 full / half）、格式、深度（D16 或借后备缓冲深度的条件）、清屏颜色；
  - 剔除翻转（`alignmentfliph` 的反、R 标志 bit0）；名单里的对象类型（模型、粒子、图像、精灵、文本）各自在反射 pass 里用哪个材质变体、矩阵与 `g_EyePosition` 写什么；
  - 反射 pass 在帧里的位置（主 pass 之前？每帧都画？）；用户设置 `reflection` 关掉时 `_rt_Reflection` 里是什么；
  - 读它的着色器（`generic` 的 `REFLECTION`、`generic2`、工程自带的 `grid`）要的 `g_TexelSizeHalf` 等 uniform。
- **阴影**：
  - 模式 2 的阴影 pass `FUN_140196530`：图集 `_rt_shadowAtlas` 的尺寸与布局（按 `shadows` 档位），点光的六个面、平行光的级联（`cascadedistance0–2`）、聚光各占几块，每块的视图投影；
  - 投射者：`castshadow` 且不透明（`obj+0x120 & 0xc00`），模型缺省开；用什么着色器画（深度 only 的变体？），图像层、粒子能不能投射；
  - `g_LFeature_Shadow*` 等 uniform 的内容；比较采样器的设置（比较函数、过滤、边界）；`lightsourcesize`（软阴影？）；
  - `shadows: disabled` 时 `lightconfig` 的阴影灯数、宏与 `_rt_shadowAtlas` 绑什么。
- **体积光**：`castvolumetrics` 的 pass 在哪、读什么（深度？阴影图集？）、画进哪里、分辨率按 `volumetrics` 档位怎么变；`density`、`volumetricsexponent` 怎么用；档位 disabled 时的行为。
- **`_rt_MipMappedFrameBuffer`**（p2-REPORT：general bit11 时建、每帧拷贝后生成 mip）：bit11 由什么置位；拷贝的时机（主 pass 之后一次？某个对象之前？）；mip 级数与生成方法；HDR 下的格式；`g_Texture3MipMapInfo` 的值。

`rea-p13-lights.md`（喂给着色器的数据与对象）：
- **遗留灯**：`FUN_14025d1f0` 写 `g_LightsPosition[4]` / `g_LightsColorRadius[4]` 的规则：取哪几盏（顺序、多于 4 盏、隐藏、父链）、坐标空间、颜色是否乘强度、半径；`g_LightAmbientColor` / `g_LightSkylightColor` 在 `generic` 里的用法；哪些着色器读。
- **雾**：`general.fog*` 到 `FOG_DIST` / `FOG_HEIGHT` 宏与 uniform 的映射（`FUN_1401a5c40` 已知写宏）、单位、颜色空间；`CalculateFogPixelState` / `ApplyFog` 在公开头文件里，只核对引擎给的值。
- **灯的运行时**：灯光 uniform 是加载时算一次还是每帧算（`FUN_140190c80` 的调用点）；父链下的世界矩阵（lighting-REPORT「灯对象带 parent」的待查项）；灯字段的脚本（灯在脚本里是什么对象、`thisLayer` 能写哪些字段）、关键帧、属性在运行中怎么生效；灯数超配时的排序键（`FUN_140186990`，lighting-REPORT 的待查项）。
- **`sprite` 对象**：工厂里怎么建、几何（公告板？尺寸从哪来？）、矩阵与 uniform、绘制顺序；ricepod 拼错的 `depthtesting` / `depthwriting` 是不是不读（P5d 记的推断）。
- **透视场景的余项**（决定 2 并进 P13h）：`transparentsorting` 已读（rea-p5-mesh 4.2，复核「相机前向是哪一轴」）；透视场景里的文本选 `_depth` 材质（rea-p6b-raster 1）；带子层的组合层在透视场景里的矩阵。

**Claude 自己读的**：
- 翻译器的改写顺序（`rewrite.rs`、预处理）：宏别名在哪一步展开最小改动，照 WPE「先预处理、再编译」的顺序；`generic` 的小写 combo 键（`lightmap`）在 WPE 里按什么大小写匹配，我们现在怎么传。
- `combo:REFLECTION` 的六张误报：逐张确认翻译出的程序不读 `_rt_*` 与 `g_Texture3MipMapInfo`；`3400241651` 的 `genericimage2` 有没有法线图槽（`NORMALMAP` 是 `formatcombo`）。

**实测（WPE + RenderDoc）**，工程用 kbp gen 生成，mdl 用 `ignore/p5/c0/mdl_enc.py`（顺带并进 kbp gen）：
- **误报**：`3413921910`、`3498150384` 直接抓帧，和我们 force 渲染比整帧。
- **遗留灯**：一个 `generic` 网格，1–5 盏遗留灯（含隐藏、挂父对象、超过 4 盏），读常量缓冲里的两个数组。
- **平面反射**：地面（`generic2` 或 `grid`）加两三个反射物，切换 `reflected`、相机角度；抓 `_rt_Reflection` 的内容、视图矩阵、光栅状态。正交与透视各一组。
- **阴影**：点光 / 平行光各一盏，带投射者与接收者；`capture_sweep` 扫 `shadows` 的五档（扫完自动改回用户的 `low`），抓图集与 uniform。
- **体积光**：同上，扫 `volumetrics`。
- **屏幕空间反射**：`generic4` 的 `REFLECTION` + 法线图，抓 `_rt_MipMappedFrameBuffer` 的 mip 链与 `g_Texture3MipMapInfo`。
- **雾**：距离雾、高度雾各一组，读宏与 uniform。
- **灯的运行时**：灯字段绑属性（运行中 `apply_properties` 改）、挂关键帧、挂父对象（父对象运动），逐帧读灯光 uniform。
- **sprite 对象**：ricepod 解包加日志，按日志回放；另做一个只有 sprite 对象的确定性工程。

**产出：**
- `rea-p13-passes.md`、`rea-p13-lights.md`（读码）、`p13-REPORT.md`（实测）、本文件的步骤 0 实施记录；
- kbp-tools：mdl 生成（收 `mdl_enc.py`）、灯对象与 `lightconfig` 的生成，在 SKILL 里登记。

## P13a — 能力表纠错、遗留灯与 generic 着色器

**实现**（按步骤 0 的结论细化）：
- **能力表**：`REFLECTION` 移出 `ENGINE_COMBOS`。真正要引擎数据的反射由读到的 RT（`texture:rendertarget:_rt_Reflection` / `_rt_MipMappedFrameBuffer`）与 `uniform:g_Texture3MipMapInfo` 报出，注释写明理由。
- **遗留灯**：编译期按步骤 0 的规则选出至多 4 盏遗留灯，`g_LightsPosition` / `g_LightsColorRadius` 进引擎 uniform 表，渲染器写值；`p2a.test.ts` 的「内置表与渲染器写的值一一对应」跟着补。灯的运行时（P13f）之前按编译期常量写，和现在的 V1 灯一致。
- **翻译器**：采样器的对象式宏别名在纹理调用改写之前展开；combo 键的大小写照步骤 0。`generic` 的 `LIGHTMAP` 第二套 UV（`a_TexCoordVec4`）在 P5c 的顶点布局里核对。翻译器 README 补规则。

**验收：**
- `3413921910`、`3498150384` 和 WPE 整帧比；
- demon_core 和 WPE 整帧比（透视、按日志回放）；遗留灯确定性工程逐像素；
- 翻译器：`cargo test -p wpesl2wgsl` 的语料与请求夹具，`generic` / `generic4` 的新请求进夹具；
- 语料：去掉的只有这几类键，其余场景逐张不变；能渲染 88 → 91（HEAD）。

## P13b — 平面反射

**实现：**
- **场景视图**（`render/views.ts`）：绘制循环参数化成「目标、视图投影、眼位与视图向量、剔除是否翻转、名单」；按视图变的 uniform 每个视图一份（改成 draw 的矩阵块按视图存，或动态偏移，子计划定），其余共用。主 pass 走同一条路、画面逐字节不变。
- **反射 pass**（`render/reflection.ts`）：场景里有读 `_rt_Reflection` 的材质时才建 RT、才画；名单是 `reflected` 不为 false 的可画对象；镜像视图、剔除翻转、尺寸、深度、清屏、在帧里的位置照步骤 0。
- **编译期**：`_rt_Reflection` 进运行时 RT 表；对象的 `reflected` 进 bundle；管线按「剔除翻转」各建一份。
- **画质**：`resolution`、`reflection` 用户设置按「决定」3。

**验收：**
- 确定性工程（正交与透视）和 WPE 逐像素比 `_rt_Reflection` 与整帧；
- audiophile、fantasticcar、arsenal 和 WPE 整帧比（按日志回放）；fantasticcar 的车身 / 条纹 / 轮毂颜色属性就地生效（PLAN 的验收项）；
- 没有反射的场景逐字节不变（`kbp regress --corpus` 与基线）；
- 能渲染 91 → 94。

## P13c — sprite 对象

**实现：** `sprite` 进对象类型，编译期按步骤 0 建它的几何、矩阵与材质（ricepod 的 `sprite` 着色器在工程里）；在反射名单与绘制顺序里的位置照步骤 0。ricepod 的 `depthtesting` / `depthwriting` 如果 WPE 确实不读，按中性键放行。

**验收：** 确定性工程逐像素；ricepod 按日志回放和 WPE 整帧比（相机路径、透视抖动已在 P5d）；能渲染 94 → 95。

## P13d — 阴影

**实现：**
- **编译期**：`lightconfig` 的阴影灯数照步骤 0 进宏；灯的 `castshadow`、对象的 `castshadow` 进 bundle；读 `_rt_shadowAtlas` 的程序绑比较采样器（翻译器对 `sampler2DComparison` 的支持在步骤 0 核对，缺了先补翻译器）。
- **阴影 pass**（`render/shadows.ts`）：每盏投影灯按步骤 0 的布局占图集的几块，每块是一个场景视图，名单是投射者，用深度 only 的变体画；`g_LFeature_Shadow*` 每帧写。
- **画质**：图集尺寸与过滤按 `shadows` 档位（「决定」3），disabled 时照 WPE。

**验收：** 确定性工程各档位和 WPE 逐像素比图集与整帧；不解锁（`3287715210` 还要 P13e）。

## P13e — 体积光

**实现：** 照步骤 0。去掉 `object:castvolumetrics`；`density`、`volumetricsexponent` 从中性键改成真正读取；档位按 `volumetrics`。

**验收：** 确定性工程各档位逐像素；`3287715210` 和 WPE 整帧比；能渲染 95 → 96（P4–P12 先做完时另加 `3837478759`）。

## P13f — 雾与灯的运行时

**实现：**
- **雾**：`general.fog*` 解析成编译期数据，`FOG_DIST` / `FOG_HEIGHT` 进 `engineDefines`，数值 uniform 每帧写；开关绑属性重编译、数值绑属性就地（照步骤 0 的 WPE 行为）。`thisScene` 的 `fog*` 脚本字段（`scriptApi.ts` 的缺失表）语料没人用，照报。
- **灯的运行时**（`render/lights.ts`）：编译期给每盏灯一份字段表（类型、字段原值、绑定目标），绑定表（P3a）加「灯字段」目标；渲染器每帧由 `SceneState` 算世界矩阵（沿父链，同图层）、可见性（沿父链）、灯光 uniform（V1 与遗留灯）。属性、关键帧（P10a 的运行时加灯目标）、字段脚本都写进 `SceneState`。超配时的选灯顺序照步骤 0。
- **能力表**：去掉灯的 `object:parent`、`value:animation:light`、`general:fog*`。

**验收：** 确定性工程逐帧比灯光 uniform（属性、关键帧、父对象运动、脚本）；雾的确定性工程逐像素；不解锁（三张 3D 工坊场景还差别的节）。

## P13g — 屏幕空间反射

**实现：** 场景用到 `_rt_MipMappedFrameBuffer` 时建带 mip 的 RT，按步骤 0 的时机拷贝主 pass 的结果、逐级缩小生成 mip（WebGPU 没有现成的 mip 生成，写一个缩小 pass，滤波照步骤 0）；`g_Texture3MipMapInfo` 进引擎 uniform 表。

**验收：** 确定性工程逐级比 mip 链与整帧；不解锁（`3453730450`、`3706286085` 还差 P13f、P13h 与别的节）。

## P13h — 透视场景的余项（决定 2）

**实现：** `transparentsorting`（透视下先画不透明、再按局部 `origin` 在相机前向上的投影从远到近画半透明，rea-p5-mesh 4.2）；透视场景里的文本（`_depth` 材质）；透视场景里带子层的组合层。

**验收：** 各一个确定性工程逐像素；P4–P12 先做完时 177 → 180（`3453730450`、`3706286085`、`3509243656`）。

## 和其它节的交界

- **共享文件**：别的会话在改 `compile/features.ts`、`compile/bundle.ts`、`compile/animations.ts`、`render/scene.ts`、`render/graph.ts`、`render/programs.ts`、`render/uniforms.ts`、`render/renderer.ts`、`host.ts`。
  - P13 的新代码放 `render/views.ts`、`render/reflection.ts`、`render/shadows.ts`、`render/volumetrics.ts`、`render/lights.ts`；
  - 共享文件只加接线，按块暂存；
  - 场景视图要改 `render/scene.ts` 的绘制循环，是 P13 和别的会话冲突最多的地方：动工前看一次别的会话的状态，在 HEAD 快照里实现再三方合并（同 P5d 的做法）。
- **P5c / P5d**：网格、顶点布局、深度与剔除、透视相机、相机对象都是 P13 的底座；P5d 照报的三项并进 P13h（「决定」2）；P5d 收尾的 `3706286085` 走查和 P13 的样本重叠。
- **P6**：`3453730450` 的光标回调、`3706286085` 灯字段脚本里的 `input.cursorLeftDown`（P6c）。
- **P10**：灯字段关键帧的就地目标建在 P10a 的运行时上。
- **P11 / P12**：`3706286085` 的骨骼（P12）、`3837478759` 的木偶与媒体（P11、P12）。
  - P12 总计划（`phase12/phase-12-puppet.md`「待定」2，2026-11-14 还没定）建议：P12 只接 puppet 图层，骨骼运行时写成模型路径也能用，模型对象的骨骼（`3706286085` 的 `BoostModel` / `FBX3`，`mdl:skeleton` / `animation` / `morph`）随 P13 接线。如果那边这样定，P13 在 P13f 之后加一步接线（只这 1 张），在那之前本计划的覆盖数把 `mdl:*` 算作 P12。
- **P2b 后处理档位**：阴影 / 体积光 / 反射的画质档位照 `postprocess.ts` 的做法（「决定」3）。
- **翻译器**：P7、P7e 已完成，P13a 的宏别名与 P13d 的比较采样器改 `src-tauri/wpesl2wgsl`，同步 README 与语料夹具。
- **工具**：kbp-tools 的 mdl 生成与灯对象生成按它的协议加，在 SKILL 里登记。

## 决定（2026-11-14 用户：「同意，但prelighting用TODO:[WPE_SCENE] 注释标出」，五条按推荐；4 另加 TODO 注释）

1. **分节与顺序**：推荐 P13a → P13b → P13c → P13d → P13e → P13f → P13g（P13h 见下一条）。P13a 改动小、马上解锁 3 张，翻译器的改动也是 arsenal 的前置；P13b 建场景视图，P13d 接着复用；P13f、P13g 服务的三张 3D 工坊场景还要别的节，排在后面。
2. **P5d 照报的三项要不要并进 P13**（`transparentsorting`、透视场景里的文本、带子层的组合层）：推荐并进，作为 P13h（已定：并进，步骤 0 的 `rea-p13-lights.md` 读它们）。P5d 明确不做，别的节也没有；它们只出现在 3 张 3D 场景里（`3453730450`、`3706286085`、`3509243656`），P4–P12 做完后这 3 张只差 P13 + 这三项。排序规则 rea-p5-mesh 已读到。另一种是继续照报、按需，P13 全做完 177 而不是 180。
3. **画质档位**：WPE 的 `shadows`、`volumetrics`（disabled / low / medium / high / ultra）和反射的 `reflection` / `resolution` 设置决定画面。推荐照「场景后处理」（D9）的做法：Kabegame 加一组设置，缺省跟随 WPE 的 `config.json`，也可以固定档位或关掉（集显的性能开关）；跟随时读法、重新加载照 `postprocess.ts`。另两种：只跟随 WPE、不加设置；或者固定一个档位、不跟随。
4. **`PRELIGHTING` 与 effect 光照**：语料 0 张。推荐不做、照报 `lighting:prelighting` / `lighting:effect`，按需。用户另定：`PRELIGHTING` 的照报处（`compile/bundle.ts` 报 `lighting:prelighting` 的地方）写 `TODO:[WPE_SCENE]` 注释，说明缺什么（基础 pass 的 `PRELIGHTING=1`、三个 `g_Alt*` 矩阵、上屏 pass 关光照），随总计划一起提交。
5. **顺序**：步骤 0 现在就做（只读码、只实测）。P13a 只改能力表、翻译器和 uniform 表，可以在步骤 0 之后先做；P13b 起改绘制循环，等 P5d 收尾、和别的会话错开。

## 风险

1. **场景视图是架构改动**：每次绘制的矩阵现在按主视图写进 draw 自己的 uniform；改成按视图各一份会碰 `render/scene.ts` 的大函数与管线缓存，和并行会话冲突多。验收要证明主 pass 逐字节不变。
2. **阴影与体积光的读码量大**：图集布局、级联、过滤、体积光的步进都只能部分实测核对，像素要按误差包络比。
3. **WebGPU 的差别**：比较采样器、D16 深度、mip 生成都要自己处理；`sampler2DComparison` 的翻译没有现成用例。
4. **验收样本**：只差 P13 的 8 张里 5 张是默认工程（透视、带相机路径与抖动），整帧比要按日志回放；3D 工坊场景要别的节先合入，在那之前靠确定性工程。
5. **画质设置**：测各档位要改 WPE 的设置。用 `capture_sweep` 扫（扫完自动改回用户的值），不手动改 `config.json`。

## 实施记录

### 步骤 0 — 调研（2026-11-14）

**读码**：两个代理并行，产出 [rea-p13-passes.md](rea-p13-passes.md)（反射、阴影、体积光、mip 帧缓冲、一帧的顺序）与 [rea-p13-lights.md](rea-p13-lights.md)（遗留灯、雾、灯的运行时、sprite 对象、透视场景余项、材质细节）。两个代理的 REA（Ghidra）都在 330 s 导入期限内超时，全程按地址切片读 `ignore/p4/rea/wp.asm`，二进制哈希核对一致，没有新增标注。代理读码期间我把抓帧事实转给它们，五组抓帧在读码里都找到了对应代码。我抽查了 6 条（density 0.65、mip 数公式、点光阴影近平面、半径 × 0.99、`genericimage2` 的 uniform、雾的参数打包），都对得上。

**实测**：[p13-REPORT.md](p13-REPORT.md)「P13 语义的实测核对」，20 条全部成立。只用了真实样本（5 张默认工程、4 张工坊场景，抓帧 `A:\p13\samples\`、`A:\p13\sweep\`），确定性工程留到各节子计划的步骤 0（清单见报告「没有实测的」）。两次 `capture_sweep` 各重启 WPE 4 次，设置都自动改回、`config.json` 哈希复原；第一次重启关掉了用户开着的 WPE 浏览窗口。

**Claude 自己读的两项**：
- 翻译器：预处理器保留 `#define` 行、交给 naga 展开，纹理调用的改写（`rewrite.rs` 的 `rewrite_texture_calls`）在展开之前，所以认不出 `#define g_NormalMapSampler g_Texture1` 与 `GRADIENT_SAMPLER`。P13a 在改写时沿对象宏查别名。
- `combo:REFLECTION` 的误报：5 张只有误报的场景 HEAD 上不报任何 `_rt_*` 或 `g_Texture3MipMapInfo`；`cursorripple` 的 `REFLECTION` 分支要有鼠标移动才会走到，静止帧比不出，整帧对照放进 P13a 的验收。

**对各节的影响**：
- **决定 3 的设置形状**：WPE 有三项，`reflection`（布尔，同时管平面反射与 mip 帧缓冲）、`shadows`、`volumetrics`（disabled / low / medium / high / ultra）；`resolution` 不影响 `_rt_Reflection`。用户现在是 `reflection: false`、两项 `low`。
- **P13a**：
  - 遗留灯按工厂给的槽位写（`lpoint` 也占槽，第 5 盏起落到槽 0，同槽后写覆盖先写，隐藏写 (0, 0, 0, 1)），每帧在对象更新里写、比脚本晚一帧；
  - 空槽 (0, 100, 0) / (0, 0, 0, 1)；`genericimage2` 读 `g_LightsColorPremultiplied[3]`（颜色 × 半径²，第 4 盏的 rgb 拆进三个 w）；
  - combo 键名 WPE 加载时转大写，我们已经这样做。
- **P13b 拆两步**：
  - b1 设置与「反射关」：`_rt_Reflection` 每帧清成清屏色（alpha 1）、不画。跟随 WPE 且 WPE 关着反射（用户现在的设置）时，audiophile、fantasticcar、arsenal 只要这一步就和 WPE 一致；设置为开而 b2 没做时照报新键（`reflection:enabled` 之类，子计划定名）。
  - b2「反射开」：场景视图。镜面恒为世界 y = 0，视图 `S·V`、投影 `P[1][1]` 取反，`g_EyePosition` / `g_ViewRight` / `g_ViewUp` 的 y 取反，剔除不变；RT 窗口尺寸 RGBA8（HDR 下也是），借场景深度；只在有模型网格读 `_rt_Reflection` 时画；名单是可画对象缺省进，读 `_rt_Reflection` 的模型整个排除（图像层、粒子不排除）。
- **P13c**：sprite 对象（类型码 3）不用对象自己的变换，顶点是写死的 (−1, 0, 1)、视图平移清零；本体的两个轴 × 2k，k 来自上一帧的遮挡查询（WebGPU 有 occlusion query，结果异步，按 WPE 用上一帧的）；进反射名单、不进阴影；拼错的 `depthwriting` / `depthtesting` 不读，按中性放行。
- **P13d**：
  - 阴影在灯光 uniform 那一步画，排在反射与主 pass 之前；只有模型能投射；剔除实际是 NONE（照抄 WPE 的疏漏）、SlopeScaledDepthBias −4；
  - 图集按灯打包，点光一块 2 × 3 六面，平行光三级级联；
  - `shadows: disabled` 时解析期丢掉阴影计数，着色器整个不声明图集。
- **P13e**：体积光是灯对象自己的绘制，在 `objects` 里灯的位置画进光缓冲，到下一个非灯对象前合成；RT 是 `_rt_volumetricsBack` / `_rt_volumetricsSingle` / `_rt_volumetricsLightBuffer`。
- **P13f**：
  - 雾的宏只在材质加载时定，条件是 general 开关为真且组合表里 `FOG` 非 0（着色器的 `[COMBO]` 缺省先并进，`generic4` 缺省 1）；数值就地生效，开关运行中改不重编；
  - V1 灯每帧在动画与脚本之后算，当帧生效；
  - 超配排序：类型升序 → `flags & 3` 降序 → 局部 origin 在 `g_ViewForward` 上的投影升序，32 盏内稳定。
- **P13g 同 P13b 拆两步**：「反射关」时 `_rt_MipMappedFrameBuffer` 只在加载时清成 (0, 0, 0, 1)，mip 数照公式；「反射开」时主 pass 画完、泛光之前拷 0 级再生成 mip，主 pass 读到的是上一帧。
- **P13h**：
  - 透视场景里带子层的组合层和正交时一样画（代码不分场景类型），确定性工程核对后 `camera:perspective:group` 可能直接去掉；
  - `transparentsorting` 按局部 origin 在 `normalize(center − eye)` 上的投影降序、稳定，`fullscreen` / `projectlayer` 排最后；
  - 文本的 `_depth` 等于测深度、不写。
- **覆盖**：分节累计不变。按用户现在的 WPE 设置，平面反射与屏幕空间反射在跟随时只需要「关」的路径，P13b、P13g 的第一步成本很低。

### P13a — 能力表纠错、遗留灯与采样器宏别名（2026-11-14）

子计划与实施记录见 [phase-13a-legacy-lights.md](phase-13a-legacy-lights.md)。`REFLECTION` 移出引擎 COMBO；遗留灯按 WPE 的槽位规则在编译期写三个数组（步骤 0 的确定性工程 6 条预测全部成立，另需逐步按单精度算）；翻译器沿对象宏找采样器别名。语料只去掉预期的键，干净 +3 张（`3413921910`、`3498150384`、demon_core，另加测试工程）；arsenal 只差 `_rt_Reflection`（P13b1）。

### P13b1 — 反射设置与「反射关」（2026-11-14）

子计划与实施记录见 [phase-13b1-reflection-off.md](phase-13b1-reflection-off.md)。三条待定按推荐（2026-11-14 用户：「按你的推荐开始」）：P13g 的「反射关」并进本节、设置只加反射一项、`_rt_Reflection` 用整张 RT。步骤 0 的 7 个确定性工程推翻一处预测：没有模型读 `_rt_Reflection` 时 WPE 给读它的图像层绑 6×6 棋盘格，照做。语料干净 100 → 108（arsenal、audiophile、fantasticcar 加测试工程）；三张按日志逐帧回放和 WPE 比，读反射图的地面逐像素相同，余下的是网格边的覆盖翻转。
