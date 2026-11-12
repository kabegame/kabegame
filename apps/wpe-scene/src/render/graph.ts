/**
 * 图层渲染图（PLAN P2a）：把 bundle 里一个图层的基础材质、启用的 effect 与 passthrough 排成按序执行的步骤。
 * 开关由调用方给（缺省取 bundle 里的 `enabled`，3c）：关着的 effect 不产生步骤、不计入合成次数，但下标仍是 `layer.effects`
 * 里的位置，fbo 引用不移位。
 * 纯函数，不碰 GPU：`scene.ts` 照步骤建资源、逐帧编码，单测直接核对步骤。规则来自对 WPE 2.8.42 的只读逆向
 * （`.claude/plans/wpe-import/3-scene/p2-REPORT.md` B5–B8，`FUN_1401ea500` 分配、`FUN_1401e8aa0` 执行、`FUN_1401ebf60` effect pass）：
 *
 * - **直接上屏**（P1 路径，原样保留）：没有启用的 effect，且 colorBlendMode ∈ {0, 31}。基础 pass 用图层几何画到场景，
 *   31 时混合改 additive。
 * - **合成**：基础 pass 关闭混合（不透明写入、保留 alpha）画满合成 RT；effect 逐 pass 在合成 RT 与 fbo 之间 ping-pong；
 *   只有最后一个启用 effect 的最后一个绘制 pass 用图层几何、基础材质的 blend 画到场景（B7），其余画全屏四边形到各自目标。
 *   colorBlendMode ∉ {0, 31} 时所有 effect 都留在合成 RT，最后由 passthrough 上屏（B8）。
 * - **合成 RT 数** = min(2, 写进合成链的次数)。每个 effect 的最后一个绘制 pass 与每个 `compose` pass 各写一次，基础 pass 写一次、
 *   上屏的那次不算，正好是 WPE 的 `min(2, passthrough + Σ(1 + compose))`（B5）：passthrough 的 +1 就是最后一个 effect 也留在合成链。
 *   第 n 次写进合成 RT `n % 2`。尺寸取基础材质槽 0 纹理的图像尺寸（没有纹理、不是 instanced 的 `solidLayer` 或组合层取图层 size，
 *   fullscreen 取 `fullscreenSize`），再取 max(4, ·)。
 * - **instanced**（P5b 步骤 5，`SceneLayer.instanced`，p5-REPORT `p5b-inst2`）：模型同时是 solidlayer，但合成 RT 仍按槽 0 纹理的图像尺寸
 *   （J1 `util/white` 32×32、J2 补边纹理 48×40，`size` 900×1000 不起作用），fbo 跟着它；上屏照 solidlayer 不内缩（J1、J2 末 pass
 *   UV 0–1，J3 直接上屏 UV 正好是图像 / 纹理）。
 * - **`_rt_FullFrameBuffer`**（B8）：场景目标的整帧快照，每图层至多拷一次，时机是三处里最早满足的一处：
 *   图层开始时（基础材质需要帧缓冲，或走 passthrough）、需要帧缓冲的 effect 的第一个 pass 之前、上屏 pass 之前。
 *   合成链不画进场景，所以三处拷到的都是画到本图层之前的场景。WPE 第一处另有「非 fullscreen 或有子层、无 passthrough 父层」
 *   的条件。前半只差在 fullscreen 走合成路径时：WPE 在图层开始时不拷快照，而是把当前目标直接拷进合成 RT 0，我们为了这次拷贝先拍
 *   一次快照（见下「fullscreen」），内容相同（都是画到本图层之前的场景），之后规则 2、3 不再重拷。fullscreen 直接上屏时照规则 1。
 *   后半是组里的图层（P5b 步骤 4）：WPE 在组里不拍新的快照、读组开始时那份；我们照规则拍，拍的是真正的场景目标（`scene.ts`），
 *   组里的绘制都落在组的合成 RT 上、不碰场景目标，所以拍到的和组开始时那份内容相同。组里要读快照的用法照报
 *   （`model:passthrough:children:framebuffer`），只有嵌套组自己的基础 pass 例外（`p5b-nest`：它采的正是组开始时那份）。
 * - **组合层**（P5b 步骤 2，`SceneLayer.passthroughModel`，p5-REPORT `p5b-cl`）：不带子层时就是基础 pass 换了写法的合成路径。
 *   没有启用的 effect、colorBlendMode ∈ {0, 31}、没有子层时整层不画（空计划；WPE 照拷一次快照，看不出来，不拷）。否则基础 pass 按
 *   `copyBackground` 分两种：true 画基础材质（composelayer 着色器，角色 `compose`），用 a_TexCoord 铺满合成 RT，按图层 MVP 算这块在
 *   屏幕上的位置去采快照；false 不画基础材质，合成 RT 0 清成 (0, 0, 0, 0)（`clear` 步骤）。两种都占合成链的第一次写入。合成 RT 按
 *   图层 size、上屏（末 pass、passthrough）不内缩。快照照上面的规则：composelayer 材质的槽 0 是 `_rt_FullFrameBuffer`，规则 1 在图层
 *   开始时拷（`copyBackground` 为 false 时同样拷，同 WPE 的拷贝时机，只是没人读）。
 * - **fullscreen**（P5b 步骤 3，`SceneLayer.fullscreen`，p5-REPORT `p5b-fs`、`p5b-fsnofx`、`p5b-fsmvp`）：几何一律是 2×2 的 NDC
 *   四边形（`geometry: "fullscreen"`），两种内缩都为 0。
 *   - 直接上屏（没有启用的 effect、colorBlendMode ∈ {0, 31}、不是组合层）：UV 照常取纹理上界，MVP 照常（`scene.ts`），着色器乘不乘
 *     MVP 决定铺不铺满全屏（FSBG / FSQ）。fullscreenlayer 是组合层，这时同上「组合层」整层不画（`p5b-fsnofx`）。
 *   - 合成路径：不画基础材质。先 `snapshot`，再 `copy`（快照 → 合成 RT 0，占合成链的第一次写入），之后照常跑 effect 链；上屏
 *     （`final`、`passthrough`）也是 NDC 四边形，矩阵是单位阵加 NDC 正交（`scene.ts`），所以正好铺满全屏。这个判断排在组合层的
 *     compose / clear 之前：fullscreenlayer 有 effect 时走拷贝，不看 `copyBackground`（`p5b-fs` 的 F1：一次 Resolve、没有基础 draw）。
 *   - 合成 RT 取 `fullscreenSize`（槽 0 静态纹理的图像尺寸；`_rt_FullFrameBuffer` 或没有纹理时取场景尺寸）。
 * - **组**（P5b 步骤 4，带子层的组合层，`SceneLayer.subtree` 非空，p5-REPORT `p5b-grp-*`、`p5b-nest`、`p5b-grpptc`）：基础 pass
 *   （compose / clear；fullscreenlayer 带子层照报，这里照拷贝）之后紧跟 `subtree` 步骤，把 `layer.subtree` 画进当前的合成 RT（组的
 *   子孙在顶层不画，`scene.ts`）。它不算合成链的一次写入（子孙画在基础 pass 写的那张上）。之后有 effect 或 colorBlendMode 混合时
 *   照常往下；都没有时不是空计划，而是用 `layer.groupUpload`（`effectpassthrough`，`采样 × g_Color4`）上屏：角色 `final`、槽 0 是
 *   当前合成 RT、图层四边形、UV 0–1、不内缩；混合 `copyBackground` 为 true 时取材质的（normal，即不混合），false 时 translucent
 *   （`p5b-grp-nofx` 事件 125 关混合、`nofx0` 事件 120 translucent；rea-p5-modelflags §2.6 的 `(flags & 0x60) == 0x20`），
 *   colorBlendMode 31 照普通上屏改 additive（读码，没有实测）。
 * - **粒子层**（P4a 步骤 4，`planParticleLayer`）：`particles` 步骤直接画到场景目标，和图像步骤同样按 `objects` 顺序；有子系统时
 *   按模板树先序给出每个模板的步骤（P4e 步骤 1、2），绘制顺序与快照由渲染器每帧现排。
 * - **文本层**（P6b 1d，`SceneLayer.text`，rea-p6b-layout 3–5，p6b-fx 抓帧）：图像层的一种，基础 pass 换成 `text` 步骤（逐字四边形，
 *   见 `TextStep`），尺寸来自排版（`TextLayout.size`、`compositeSize`），不来自 JSON 的 `size`；排版为空时整层不画。直接上屏是
 *   `[背景] → 普通字形 → [彩色字形]`；合成路径的基础 pass 是「清成背景色」（开了 `opaquebackground`）或 `composelayer_clearalpha`
 *   （`compose` 角色，读快照），之后字形画进同一张合成 RT，effect 链、passthrough 与上屏照图像层（上屏借 `basefont` 的 translucent，
 *   UV 内缩的分母是文字框的整数部分）。文本层的 effect 开关会改 `padding` 与文字框，切换走整场重编译，不预备变体。
 * - **模型层**（P5c 步骤 2，`SceneLayer.model`，`planModelLayer`）：每个网格一个 `mesh` 步骤，顺序是编译期排好的 `model.order`（不透明在前，
 *   MSVC `std::sort`），全部直接画到场景目标，和图像步骤、粒子同样按 `objects` 顺序。没有合成路径：WPE 的模型对象不读 `effects`（编译期报
 *   `model:effects`），也没有 colorBlendMode 的上屏（rea-p5-mesh 2.6）。
 */
import { FRAMEBUFFER_RT, type SceneFbo, type SceneLayer, type ScenePass, type SceneTexture } from "../compile/bundle";
import { MAX_CHILD_DEPTH, type SceneParticle } from "../compile/particles";
import { NO_INSET, textureUvExtent, uvInset } from "./layout";

export type TextureRef =
  | { kind: "texture"; index: number }
  | { kind: "composite"; index: number }
  | { kind: "fbo"; effect: number; name: string }
  | { kind: "framebuffer" }
  /**
   * 文本层的字形图集（P6b 1d）：本层排版结果所在的 R8 主图集（`color: false`）或 RGBA8 彩色图集（`true`），按字体键共享，渲染器建场景时
   * 整张上传。线性过滤、repeat、没有 mip（rea-p6b-raster 3.2，p6b 抓帧的采样器是 Wrap）。
   */
  | { kind: "atlas"; color: boolean };
export type TargetRef =
  { kind: "scene" } | { kind: "composite"; index: number } | { kind: "fbo"; effect: number; name: string };

/**
 * - `direct`：直接上屏的基础 pass；`base`：画进合成 RT 的基础 pass；`effect`：画全屏四边形到合成 RT / fbo；
 * - `final`：最后一个 effect 的最后一个绘制 pass，上屏；`passthrough`：colorBlendMode 混合的上屏 pass；
 * - `compose`：组合层（`copyBackground` 为 true）画进合成 RT 的基础 pass（P5b 步骤 2）：图层四边形、图层 MVP（同直接上屏），
 *   composelayer 着色器自己按 a_TexCoord 铺满合成 RT。和 effect pass 的 `compose` 字段（B5，`SceneEffectStep.compose`）不是一回事。
 */
export type DrawRole = "direct" | "base" | "effect" | "final" | "passthrough" | "compose";
/**
 * - `layer`：图层世界四边形（模型空间、未缩放的 size），场景视图投影 × 图层模型矩阵；
 * - `fill`：同一个四边形用正交投影画满目标、单位模型矩阵（基础 pass 画进合成 RT）；
 * - `fullscreen`：2×2 的 NDC 四边形（±1）。effect 中间 pass 的 MVP 为单位阵；fullscreen 模型的图层（P5b 步骤 3）直接上屏、上屏也用它，
 *   UV 取步骤的 `uv` / `inset`，矩阵见 `scene.ts`。
 */
export type Geometry = "layer" | "fill" | "fullscreen";

export interface DrawStep {
  kind: "draw";
  role: DrawRole;
  pass: ScenePass;
  /** fbo 引用所属的 effect 下标（`layer.effects`）；基础 pass / passthrough 为 null。 */
  effect: number | null;
  target: TargetRef;
  /** 每个槽位的纹理来源（含材质静态纹理）；着色器声明了、这里没有的槽位绑占位纹理。 */
  inputs: Record<number, TextureRef>;
  geometry: Geometry;
  /** 纹理坐标上界：基础 pass 是图像 / 纹理，其余采样合成 RT 或 fbo 全图为 (1, 1)。 */
  uv: [number, number];
  /** UV 内缩：上屏的四边形才有，见 `uvInset`。 */
  inset: readonly [number, number];
  /** 混合模式（`programs.ts` 的 `blendState`）；null = 关闭混合、四通道直写。 */
  blending: string | null;
}
/**
 * 粒子层的绘制（P4a 步骤 4）：粒子材质的 pass 直接画到场景目标，和图像步骤一样按 `objects` 顺序执行。几何不是图层四边形，
 * 是模拟器每帧写的顶点（每粒子 4 个顶点、6 个索引，`particles/vertices.ts`），MVP = 视图投影 × 对象世界矩阵。
 */
export interface ParticleStep {
  kind: "particles";
  pass: ScenePass;
  target: { kind: "scene" };
  /** 每个槽位的纹理来源（材质静态纹理，或 `_rt_FullFrameBuffer`）。 */
  inputs: Record<number, TextureRef>;
  blending: string;
  /** 系统 `flags & 4`：换透视粒子的视图投影（`layout.ts` 的 `particleViewProjection`）。 */
  perspective: boolean;
  /**
   * 这个系统在树里的模板路径（P4e 步骤 1、2）：顶层 `[]`，子系统 `[n]`、`[n, m]`…，每层是 `SceneParticle.children` 的下标；事件条目下的
   * 系统同样一个模板（实例不计序号），每帧出现 0…n 次。渲染器只为 `[]` 建模拟器（整棵树），按 `ParticleSystem.forEachDrawn` 每帧现排。
   */
  node: number[];
  /** 这个系统 `flags & 1`（世界空间）：绘制的模型矩阵是单位阵（`ParticleSystem.forEachDrawn`）。 */
  world: boolean;
  /**
   * 模板路径经过事件条目（P4e 步骤 2）：每个活跃实例各画一次（rea-p4e-children 第 6 节，「决定」1），绘制资源按需建、模型矩阵每帧在变。
   * 否则（顶层与 static 子孙）每帧恰好一次。
   */
  instanced: boolean;
}
/**
 * 文本层的一次绘制（P6b 1d，rea-p6b-layout 3.2、4、5）：几何不是图层四边形，是排版出的逐字四边形（`text/layout.ts` 的 `TextMesh`，
 * 每字形 4 个顶点、6 个索引，三角形列表，`text/mesh.ts` 的顺序），或背景的一个四边形。一个文本层最多三次：
 * - `background`：`fontbackground`（`flat` 着色器），只在直接上屏且开了 `opaquebackground` 时画，四边形是整数文字框
 *   （`compositeSize`），平移 `(−w/2 − pad.x, −h/2 − pad.y)`；
 * - `glyphs`：`basefont`，槽 0 是 R8 主图集；
 * - `color`：`basefontrgba`，槽 0 是 RGBA8 彩色图集，有彩色字形时才画，在普通字形之后。
 * `space`：`direct` 画到场景目标，矩阵是图层 MVP（世界矩阵含对齐偏移）× 平移 `directTranslation`；`composite` 画进合成 RT，矩阵是
 * RT 像素的正交 × 平移 `compositeTranslation`（`render/uniforms.ts` 的 `textMatrices`）。
 */
export interface TextStep {
  kind: "text";
  part: "background" | "glyphs" | "color";
  pass: ScenePass;
  space: "direct" | "composite";
  target: TargetRef;
  /** 槽 0 的图集（背景没有纹理）。 */
  inputs: Record<number, TextureRef>;
  /** 直接上屏：colorBlendMode 31 时 additive，否则材质的 translucent；画进合成 RT：材质自己的 translucent。 */
  blending: string;
}

/**
 * 模型图层的一次网格绘制（P5c 步骤 2，rea-p5-mesh 2.6、4.3）：几何是 mdl 的顶点与索引（`SceneMesh`，原样上传），带索引的三角形列表，直接
 * 画到场景目标。矩阵同图像层直接上屏（`g_ModelMatrix` 是世界矩阵、不乘 `size`），颜色组固定为 1（`p5c-color`，`render/scene.ts`）。
 * 剔除按 `pass.cullmode`（normal 剔背面、屏幕上逆时针为正面，`p5c-cull`），顶点布局按网格格式（`render/mesh.ts`）。
 */
export interface MeshStep {
  kind: "mesh";
  /** `layer.model.meshes` 的下标（步骤按 `model.order` 排）。 */
  mesh: number;
  pass: ScenePass;
  target: { kind: "scene" };
  /** 每个槽位的纹理来源（材质静态纹理，或 `_rt_FullFrameBuffer`）。 */
  inputs: Record<number, TextureRef>;
  blending: string;
}

/** 渲染图要的那部分排版结果（`text/layout.ts` 的 `TextLayout`）：有没有字形、文字框与合成 RT 尺寸。 */
export interface TextPlanLayout {
  mesh: { glyphs: readonly unknown[]; colorGlyphs: readonly unknown[] } | null;
  size: readonly number[];
  compositeSize: readonly number[];
}

export type LayerStep =
  | DrawStep
  | ParticleStep
  | TextStep
  | MeshStep
  | { kind: "snapshot" }
  /**
   * 整张拷贝（B6，D3D CopyResource）。`effect` 同 `DrawStep.effect`：effect 的 `copy` 命令是它的下标；fullscreen 的基础 pass
   * （快照 → 合成 RT 0，P5b 步骤 3）不属于任何 effect，为 null。来源与目标的 fbo 引用各带自己的 effect 下标，解析不读这个字段。
   */
  | { kind: "copy"; effect: number | null; source: TextureRef; target: TargetRef }
  | { kind: "swap"; effect: number; source: string; target: string }
  /**
   * 把目标清成 (0, 0, 0, 0)：组合层 `copyBackground` 为 false 时代替基础 pass（P5b 步骤 2，WPE 只清颜色、不清深度）。
   * `color: "text-background"`（P6b 1d）：文本层走合成且开了 `opaquebackground`，RT 清成 `(背景色, 图层 alpha)`（rea-p6b-layout 4），
   * 颜色由渲染器按文本表的背景常量与图层当前的 alpha 现算。
   */
  | { kind: "clear"; target: TargetRef; color?: "text-background" }
  /**
   * 组画子树（P5b 步骤 4）：按 `layer.subtree` 依次画可见的子孙，它们「画到场景」的绘制改画进 `target`（组当前的合成 RT），视图投影
   * 换成组的局部正交（`scene.ts`）。不算合成链的写入。
   */
  | { kind: "subtree"; target: TargetRef };

export interface LayerPlan {
  /** 合成 RT 的张数与尺寸；直接上屏时为 null。 */
  composite: { count: number; width: number; height: number } | null;
  steps: LayerStep[];
  /** 渲染器还不会画的结构（原因键）。 */
  reasons: string[];
}

type TextureSize = Pick<SceneTexture, "width" | "height" | "textureWidth" | "textureHeight">;

/**
 * 合成 RT 尺寸（B5 `FUN_1402091e0`）：fullscreen 取 `fullscreenSize`（P5b 步骤 3：槽 0 静态纹理的图像尺寸，`_rt_FullFrameBuffer`
 * 或没有纹理时取场景尺寸），排在最前；否则基础材质槽 0 纹理的图像尺寸，没有纹理、`solidLayer` 且不是 `instanced`（P5b 步骤 5，
 * `p5b-inst2` 的 J1 32×32、J2 48×40，对照组 J0 900×1000）或组合层（取 `round(size)`，rea-p5-modelflags §2.3，`p5b-cl` 实测 600×300）
 * 取图层 size；最后取 max(4, ·)。精灵表取单帧留到 P6。
 */
export function compositeSize(
  layer: Pick<SceneLayer, "size" | "solidLayer" | "instanced" | "passthroughModel" | "fullscreenSize">,
  texture: TextureSize | undefined,
): [number, number] {
  const [w, h] = layer.fullscreenSize
    ? layer.fullscreenSize
    : texture && !(layer.solidLayer && !layer.instanced) && !layer.passthroughModel
      ? [texture.width, texture.height]
      : [layer.size[0] ?? 0, layer.size[1] ?? 0];
  return [Math.max(4, Math.round(w)), Math.max(4, Math.round(h))];
}

/**
 * 合成 RT 的采样（P8 步骤 1，p8-REPORT「合成 RT 与基础纹理的采样」、rea-p8-layer §3 `FUN_1401ea500`）：寻址只看对象的 `clampuvs`
 * （`SceneLayer.clampUVs`，缺省钳制），和基础纹理 `.tex` 的 ClampUVs 无关；过滤在对象 `nointerpolation` 或基础纹理 `.tex` 的
 * NoInterpolation 时最近邻，否则线性。池化与被依赖图层独占的合成 RT 同一套。`texture` 是基础材质槽 0 的静态纹理；组合层、文本层等
 * 没有的传 undefined，只看对象（文本、形状的虚表 +0x128 给 0；组合层实测 `clampuvs` 不写 / true 为 Clamp / Linear、false 为 Wrap）。
 */
export function compositeSampling(
  layer: Pick<SceneLayer, "clampUVs" | "noInterpolation">,
  texture: Pick<SceneTexture, "noInterpolation"> | undefined,
): { clamp: boolean; nearest: boolean } {
  return { clamp: layer.clampUVs, nearest: layer.noInterpolation || !!texture?.noInterpolation };
}

/**
 * 文本层的合成 RT 尺寸（P6b 1d）：排版的 `compositeSize`（`trunc(2·padding + 文字框)`，rea-p6b-layout 3.1 `FUN_140258ab0`），WPE 不套
 * max(4, ·)；这里只保证至少 1（纹理尺寸不能为 0）。fbo 按它算（`fboSize`）。
 */
export function textCompositeSize(layout: Pick<TextPlanLayout, "compositeSize">): [number, number] {
  const [w = 1, h = 1] = layout.compositeSize;
  return [Math.max(1, w), Math.max(1, h)];
}

/**
 * fbo 尺寸（B6、PLAN P2a）：W′ / H′ 取 `width` / `height`（≤4096 时生效），否则取合成 RT 尺寸；有 `fit`（≤4096）时
 * W′ < H′ 则 h = min(fit, H′)、w = W′/H′·h，否则 w = min(fit, W′)、h = H′/W′·w，截断成整数；最后整除 `scale`，各边至少 2。
 */
export function fboSize(
  fbo: Pick<SceneFbo, "scale" | "width" | "height" | "fit">,
  composite: readonly [number, number],
): [number, number] {
  let w = fbo.width ?? composite[0],
    h = fbo.height ?? composite[1];
  if (fbo.fit && w > 0 && h > 0) {
    if (w < h) {
      const fitted = Math.min(fbo.fit, h);
      w = Math.trunc((w / h) * fitted);
      h = Math.trunc(fitted);
    } else {
      const fitted = Math.min(fbo.fit, w);
      h = Math.trunc((h / w) * fitted);
      w = Math.trunc(fitted);
    }
  }
  const scale = Math.max(1, fbo.scale);
  return [Math.max(2, Math.floor(w / scale)), Math.max(2, Math.floor(h / scale))];
}

/** 图层要不要走合成：有启用的 effect，或 colorBlendMode 混合（∉ {0, 31}）。 */
export function needsComposite(
  layer: Pick<SceneLayer, "effects" | "colorBlendMode">,
  enabled: (effect: number) => boolean = (e) => layer.effects[e].enabled,
): boolean {
  return layer.effects.some((_, e) => enabled(e)) || isPassthroughBlend(layer.colorBlendMode);
}
export function isPassthroughBlend(colorBlendMode: number): boolean {
  return colorBlendMode !== 0 && colorBlendMode !== 31;
}

/**
 * 粒子层的计划（P4a 步骤 4）：每个要画的模板一个 `particles` 步骤，直接画到场景目标。其余运行时纹理（fbo 名）粒子没有，报不支持。
 * 没有 pass（粒子 JSON 读不到、材质缺失）时为空计划。
 *
 * 子系统（P4e 步骤 1、2，rea-p4e-children 第 6 节，`FUN_1402366f0` 的先序递归）：步骤按**模板树**的先序列出——父自己 → static 子系统
 * （条目顺序、深度优先）→ 事件条目的子系统（条目顺序，P4e 步骤 2；实例共用它，`instanced`）。每个步骤用自己系统的 pass、混合、透视位，
 * `node` 是模板路径。步骤只用来预备管线与程序、做渲染器自查：一帧里实际画几次、按什么顺序、快照拷在哪里，由渲染器沿
 * `ParticleSystem.forEachDrawn` 每帧现排（`render/scene.ts` 的 `particle-tree` op），所以计划里不再有快照步骤。
 * - 基础材质为空（没有 pass）的系统整棵子树都不画（`sys+0x358 == 0` 直接返回），也不列出它的子孙。
 * - `renderer: []`（`renderers` 为空）的系统自己不画、不给步骤，照常列出子系统（语料里只靠子系统出图的发射器）。
 *
 * 快照（P4b 步骤 5，`genericparticle` 的 `REFRACT` 从 `g_Texture3` 读 `_rt_FullFrameBuffer`）的规则见 `particleTreeWantsFramebuffer` 与
 * 渲染器：本帧先序里第一个需要帧缓冲的系统之前拷一次，每对象至多一次（折射位 `obj+0x93d` 父子共用）。
 */
export function planParticleLayer(layer: Pick<SceneLayer, "particle">): LayerPlan {
  const reasons: string[] = [];
  const steps: LayerStep[] = [];
  const particle = layer.particle;
  if (!particle) return { composite: null, steps, reasons };
  visitParticleTemplates(particle, (system, node, instanced) => {
    const pass = system.passes[0];
    if (!pass) return false;
    // 编译期已报 `particle:material:passes`；渲染器只画第一个
    if (system.passes.length > 1) reasons.push("render:multi-pass");
    const inputs: Record<number, TextureRef> = {};
    for (const [slot, index] of Object.entries(pass.textures)) inputs[Number(slot)] = { kind: "texture", index };
    for (const [slot, name] of Object.entries(pass.runtime)) {
      if (name === FRAMEBUFFER_RT) inputs[Number(slot)] = { kind: "framebuffer" };
      else reasons.push(`render:texture-rt:${name}`);
    }
    if (system.renderers.length)
      steps.push({
        kind: "particles",
        pass,
        target: { kind: "scene" },
        inputs,
        blending: pass.blending,
        perspective: (system.flags & 4) !== 0,
        node,
        world: (system.flags & 1) !== 0,
        instanced,
      });
  });
  return { composite: null, steps, reasons };
}

/**
 * 按模板树先序走一个粒子定义（P4e 步骤 2）：自己 → static 子系统（条目顺序）→ 事件条目的子系统（条目顺序），各自递归。`instanced` 是路径
 * 经过事件条目。`visit` 返回 `false` 时不走这个系统的子孙。深度上限同模拟器（`MAX_CHILD_DEPTH`，编译期已按它截断；这里防手写的环）。
 */
export function visitParticleTemplates(
  particle: SceneParticle,
  visit: (system: SceneParticle, node: number[], instanced: boolean) => boolean | void,
): void {
  const walk = (system: SceneParticle, node: number[], instanced: boolean): void => {
    if (visit(system, node, instanced) === false || node.length >= MAX_CHILD_DEPTH) return;
    system.children.forEach((child, index) => {
      if (child.type === "static") walk(child.system, [...node, index], instanced);
    });
    system.children.forEach((child, index) => {
      if (child.type !== "static") walk(child.system, [...node, index], true);
    });
  };
  walk(particle, [], false);
}

/**
 * 粒子层可能要 `_rt_FullFrameBuffer`（P4b 步骤 5、P4e 步骤 1）：模板树里有材质需要帧缓冲（`pass.framebuffer`，判定同 WPE 基础材质
 * `+0x1fc` bit1）的系统，`renderer: []` 的也算（WPE 在它逐 renderer 画之前照拷）。渲染器据此建快照纹理，每帧在先序里第一个这样的
 * 系统之前拷一次：
 * - 时机和 WPE 相同：`FUN_1402366f0` 在本系统任何 renderer 画之前拷当前场景目标整张，每对象每帧至多一次（rea-p4b-render.md
 *   6.1）；所以快照含按 `objects` 顺序画在它前面的全部内容，不含自己。步骤 0 抓帧（`p4b-refract`）里每个 `REFRACT` 对象前
 *   各有一次拷贝，`CUTOUT` 对象前没有（它不读帧缓冲，`pass.framebuffer` 为假），和这里一致。
 * - WPE 在存活数为 0 时不拷也不画，我们照拷。画面不受影响：本层自己没有粒子可画，而之后读快照的每一层（图像层规则 1–3、
 *   passthrough、其它粒子层）都在本层内自己重拷，泛光也在全部图层之后再拷一次，没有哪一步读到的是这次多拷的内容。同一层里 WPE 由下一个
 *   需要的系统拷，两者之间这层没画任何东西（存活数 0 的系统不画），读到的内容相同。
 * - WPE 的场景目标开了 MSAA，快照是 `ResolveSubresource`，我们是 `copyTextureToTexture`；轴对齐、落在整像素上的四边形
 *   两者相同，差异只可能在边缘。逐像素比较见 P4b 计划步骤 5 的验收。
 */
export function particleTreeWantsFramebuffer(particle: SceneParticle): boolean {
  let wanted = false;
  visitParticleTemplates(particle, (system) => {
    const pass = system.passes[0];
    if (!pass) return false;
    if (pass.framebuffer) wanted = true;
  });
  return wanted;
}

/**
 * 模型层的计划（P5c 步骤 2）：按 `model.order` 每个网格一个 `mesh` 步骤，画到场景目标，没有合成 RT。
 * - 每个网格取 `passes[0]`；多于一个 pass 编译期已报 `mdl:material-passes`，这里同图像层、粒子另记 `render:multi-pass`（渲染器自查）。
 *   没有 pass 的网格（材质读不到）跳过。
 * - 运行时纹理只认 `_rt_FullFrameBuffer`：编译期已报 `mdl:framebuffer`（WPE 的模型绘制不拷快照，读到的是什么没测），所以这里不排快照
 *   步骤，强制渲染时读到的是快照纹理此刻的内容；其余名字照报 `render:texture-rt:<名>`。
 */
export function planModelLayer(layer: Pick<SceneLayer, "model">): LayerPlan {
  const reasons: string[] = [];
  const steps: LayerStep[] = [];
  const model = layer.model;
  if (!model) return { composite: null, steps, reasons };
  for (const m of model.order) {
    const mesh = model.meshes[m];
    const pass = mesh?.passes[0];
    if (!pass) continue;
    if (mesh.passes.length > 1) reasons.push("render:multi-pass");
    const inputs: Record<number, TextureRef> = {};
    for (const [slot, index] of Object.entries(pass.textures)) inputs[Number(slot)] = { kind: "texture", index };
    for (const [slot, name] of Object.entries(pass.runtime)) {
      if (name === FRAMEBUFFER_RT) inputs[Number(slot)] = { kind: "framebuffer" };
      else reasons.push(`render:texture-rt:${name}`);
    }
    steps.push({ kind: "mesh", mesh: m, pass, target: { kind: "scene" }, inputs, blending: pass.blending });
  }
  return { composite: null, steps, reasons };
}

export function planLayer(
  layer: SceneLayer,
  textures: readonly TextureSize[],
  enabled: (effect: number) => boolean = (e) => layer.effects[e].enabled, // 运行时的开关，3c 步骤 2 传入
  /** 文本层（`layer.text` 非空）的排版结果（P6b 1d）；其它图层不看。 */
  text: TextPlanLayout | null = null,
): LayerPlan {
  // 粒子对象没有图像 pass，也不编 effect（`compileScene`）
  if (layer.particle) return planParticleLayer(layer);
  // 模型对象（P5c 步骤 2）同样没有图像 pass、不编 effect
  if (layer.model) return planModelLayer(layer);
  const reasons: string[] = [];
  const steps: LayerStep[] = [];
  // 文本层（P6b 1d）：基础 pass 是字形，effect 链与上屏照图像层，上屏借 `basefont` 的 translucent
  const sceneText = layer.text ?? null;
  const base = sceneText ? sceneText.glyphPass : layer.passes[0];
  if (!base) return { composite: null, steps, reasons };
  // 宿主没交排版结果：画不出来（渲染器自查）；排版为空（空文字、字体都不可用）时 WPE 整层不画（可见性要求有排版结果，rea-p6b-layout 5.5）
  if (sceneText && !text) return { composite: null, steps, reasons: ["render:text-layout"] };
  const mesh = text?.mesh ?? null;
  if (sceneText && !mesh) return { composite: null, steps, reasons };
  if (layer.passes.length > 1) reasons.push("render:multi-pass");
  const baseTexture = sceneText || base.textures[0] === undefined ? undefined : textures[base.textures[0]];
  // 文本层的图层尺寸来自排版（`TextLayout.size`），不来自 JSON 的 `size`（rea-p6b-layout 1.4）
  const size = sceneText ? text!.size : layer.size;
  const uv = textureUvExtent(baseTexture);
  // UV 内缩分两种（P5b 步骤 1，p5-REPORT `p5b-nopad`）：直接上屏（WPE `+0x490`，flags & 0x226）在 fullscreen、nopadding、
  // passthrough、solidlayer 时不内缩；末 pass 与 passthrough 上屏（`+0x2e8`，flags & 0x222）不看 nopadding。
  // 组合层（步骤 2）两块都不内缩（rea-p5-modelflags §2.3，`p5b-cl` 上屏 UV 0–1）；它不会走直接上屏，加进去只为和 WPE 的条件一致。
  // fullscreen（步骤 3）两块也都不内缩（`p5b-fs` 上屏、`p5b-fsmvp` 直接上屏的 UV 都是 0–1）。
  // `solidLayer` 只看模型 solidlayer 这一位（步骤 5）：instanced 也是 solidlayer，两种上屏同样不内缩（`p5b-inst2` 的 J1、J2 末 pass
  // UV 0–1，J3 直接上屏 UV 正好 0–0.75 / 0–0.625）；instanced 只在合成 RT 尺寸上和普通 solidlayer 不同（`compositeSize`）
  const flat = layer.solidLayer || layer.passthroughModel || layer.fullscreen;
  // fullscreen 的直接上屏与上屏都画 2×2 的 NDC 四边形（P5b 步骤 3）
  const screenGeometry: Geometry = layer.fullscreen ? "fullscreen" : "layer";
  // 文本层没有纹理：分母是文字框的整数部分（p6b-fx f1 末 pass 的 UV 内缩 0.15 / 149）
  const directInset = flat || layer.noPadding ? NO_INSET : uvInset(size, baseTexture);
  const finalInset = flat ? NO_INSET : uvInset(size, baseTexture);
  const additive = layer.colorBlendMode === 31;
  const passthrough = isPassthroughBlend(layer.colorBlendMode);
  let snapped = false;
  const snapshot = () => {
    if (snapped) return;
    snapped = true;
    steps.push({ kind: "snapshot" });
  };
  const fboNames = layer.effects.map((effect) => new Set(effect.fbos.map((fbo) => fbo.name)));
  const staticInputs = (pass: ScenePass, effect: number | null): Record<number, TextureRef> => {
    const inputs: Record<number, TextureRef> = {};
    for (const [slot, index] of Object.entries(pass.textures)) inputs[Number(slot)] = { kind: "texture", index };
    for (const [slot, name] of Object.entries(pass.runtime)) {
      if (name === FRAMEBUFFER_RT) inputs[Number(slot)] = { kind: "framebuffer" };
      else if (effect !== null && fboNames[effect].has(name)) inputs[Number(slot)] = { kind: "fbo", effect, name };
      else reasons.push(`render:texture-rt:${name}`);
    }
    return inputs;
  };
  /** 文本层的一次绘制（P6b 1d）：字形的槽 0 是本层的图集。 */
  const textStep = (
    part: TextStep["part"],
    pass: ScenePass,
    space: TextStep["space"],
    target: TargetRef,
    blending: string,
  ): TextStep => ({
    kind: "text",
    part,
    pass,
    space,
    target,
    inputs:
      part === "background"
        ? staticInputs(pass, null)
        : { ...staticInputs(pass, null), 0: { kind: "atlas", color: part === "color" } },
    blending,
  });

  // 组（P5b 步骤 4）：带子层的组合层。没有 effect、colorBlendMode ∈ {0, 31} 时也要画：基础 pass → 子树 → `groupUpload` 上屏
  const group = layer.passthroughModel && layer.subtree.length > 0;
  if (!needsComposite(layer, enabled) && !group) {
    // 组合层（P5b 步骤 2，p5-REPORT `p5b-cl` 的 CL3、CL5）：没有启用的 effect、colorBlendMode ∈ {0, 31}、没有子层时整层不画。
    // WPE 在图层开始时照拷一次快照，没人读，不拷。带子层的是组，走下面的合成路径（步骤 4）。
    // fullscreenlayer 也是组合层，同样不画（P5b 步骤 3，`p5b-fsnofx` 没有 draw）
    if (layer.passthroughModel) return { composite: null, steps, reasons };
    // 规则 1：基础材质需要帧缓冲
    if (base.framebuffer) snapshot();
    if (sceneText && mesh) {
      // 文本层直接上屏（rea-p6b-layout 4、5.1，p6b-fx f4 / f6）：[背景] → 普通字形 → [彩色字形]，三者的混合都是 colorBlendMode 31 时
      // additive、否则 translucent（WPE 每帧把材质的混合覆盖成它，材质本身就是 translucent）
      const blend = (pass: ScenePass) => (additive ? "additive" : pass.blending);
      const scene: TargetRef = { kind: "scene" };
      if (sceneText.fields.opaquebackground) {
        if (sceneText.backgroundPass)
          steps.push(
            textStep("background", sceneText.backgroundPass, "direct", scene, blend(sceneText.backgroundPass)),
          );
        else reasons.push("render:text-background");
      }
      if (mesh.glyphs.length) steps.push(textStep("glyphs", base, "direct", scene, blend(base)));
      if (mesh.colorGlyphs.length)
        steps.push(textStep("color", sceneText.colorPass, "direct", scene, blend(sceneText.colorPass)));
      return { composite: null, steps, reasons };
    }
    // fullscreen（P5b 步骤 3，`p5b-fsmvp` 的 FSBG、FSQ）：NDC 四边形、UV 照常取纹理上界、不内缩；MVP 照常，着色器乘不乘它决定
    // 铺不铺满全屏
    steps.push({
      kind: "draw",
      role: "direct",
      pass: base,
      effect: null,
      target: { kind: "scene" },
      inputs: staticInputs(base, null),
      geometry: screenGeometry,
      uv,
      inset: directInset,
      blending: additive ? "additive" : base.blending,
    });
    return { composite: null, steps, reasons };
  }

  // 规则 1：基础材质需要帧缓冲，或 colorBlendMode 混合
  if (base.framebuffer || passthrough) snapshot();
  let writes = 0;
  let current = 0;
  /** 下一次写合成链的目标；调用方先算完本 pass 的输入（读的是写之前的 current）。 */
  const nextComposite = (): TargetRef => {
    const index = writes % 2;
    writes++;
    current = index;
    return { kind: "composite", index };
  };
  if (sceneText && mesh) {
    // 文本层画进合成 RT（rea-p6b-layout 4、5.2，p6b-fx f1–f3、f5）：RT 初值二选一，再画字形（材质自己的 translucent，矩阵对着 RT 像素），
    // 两者共占合成链的第一次写入。开了 `opaquebackground`：清成 (背景色, 图层 alpha)，没有基础绘制（f5）；没开：`composelayer_clearalpha`
    // 把文字框背后的场景快照铺进来、alpha 清 0（f1 事件 47：图层四边形、图层 MVP、关混合、写 RGBA），即组合层的 `compose` 那条路
    const target = nextComposite();
    if (sceneText.fields.opaquebackground) steps.push({ kind: "clear", target, color: "text-background" });
    else if (!sceneText.clearAlphaPass) reasons.push("render:text-clear-alpha");
    else {
      const pass = sceneText.clearAlphaPass;
      if (pass.framebuffer) snapshot();
      steps.push({
        kind: "draw",
        role: "compose",
        pass,
        effect: null,
        target,
        inputs: staticInputs(pass, null),
        geometry: "layer",
        uv: [1, 1],
        inset: NO_INSET,
        blending: null,
      });
    }
    if (mesh.glyphs.length) steps.push(textStep("glyphs", base, "composite", target, base.blending));
    if (mesh.colorGlyphs.length)
      steps.push(textStep("color", sceneText.colorPass, "composite", target, sceneText.colorPass.blending));
  } else if (layer.fullscreen) {
    // fullscreen（P5b 步骤 3，`p5b-fs` 的 F1：一次 Resolve 拷进合成 RT、没有基础 draw）：不画基础材质，合成 RT 0 拷贝当前画面。
    // 先拍快照（每图层至多一次；fullscreenlayer 的槽 0 是 `_rt_FullFrameBuffer`，上面的规则 1 已经拍过），再把快照整张拷进
    // 合成 RT 0，占合成链的第一次写入。WPE 是直接拷当前目标，快照就是当前目标，内容相同，只多一次整屏拷贝。排在组合层的
    // compose / clear 之前：fullscreenlayer 有 effect 时走这里
    snapshot();
    steps.push({ kind: "copy", effect: null, source: { kind: "framebuffer" }, target: nextComposite() });
  } else if (layer.passthroughModel && !layer.copyBackground) {
    // 组合层 `copybackground: false`（`p5b-cl` 的 CL2）：不画基础材质，合成 RT 0 清成 (0, 0, 0, 0)，同样占合成链的第一次写入
    steps.push({ kind: "clear", target: nextComposite() });
  } else if (layer.passthroughModel) {
    // 组合层的基础 pass（`p5b-cl` 的 CL1、CL4，事件 62 / 132）：基础材质本身（composelayer 着色器），图层四边形配图层 MVP
    // （场景视图投影 · 视差 · W，WPE 的模型 = W、视图投影 = 场景相机）。着色器用 a_TexCoord 铺满合成 RT，所以 UV 取 0–1、不内缩
    // （rea-p5-modelflags §2.3：有 effect 或 colorBlendMode 混合时 UV 上界取 1，走到这里两者必有其一）；关混合、四通道直写
    // （实测写掩码 RGBA、不混合）
    steps.push({
      kind: "draw",
      role: "compose",
      pass: base,
      effect: null,
      target: nextComposite(),
      inputs: staticInputs(base, null),
      geometry: "layer",
      uv: [1, 1],
      inset: NO_INSET,
      blending: null,
    });
  } else
    steps.push({
      kind: "draw",
      role: "base",
      pass: base,
      effect: null,
      target: nextComposite(),
      inputs: staticInputs(base, null),
      geometry: "fill",
      uv,
      inset: NO_INSET,
      blending: null,
    });
  // 组画子树（P5b 步骤 4，`p5b-grp-*`：子层画进基础 pass 写的那张合成 RT）：不占合成链的写入，之后的 effect 读的就是这张
  if (group) steps.push({ kind: "subtree", target: { kind: "composite", index: current } });

  // 上屏的那一步：最后一个启用 effect 的最后一个绘制 pass（passthrough 时没有）
  let finalEffect = -1,
    finalStep = -1;
  if (!passthrough)
    for (let e = layer.effects.length - 1; e >= 0 && finalEffect < 0; e--) {
      if (!enabled(e)) continue;
      for (let s = layer.effects[e].steps.length - 1; s >= 0; s--)
        if (layer.effects[e].steps[s].kind === "draw") {
          finalEffect = e;
          finalStep = s;
          break;
        }
    }
  /** effect 里的名字：本 effect 的 fbo，否则（如 `previous`）是当前合成 RT（B6：找不到记为 −1）。读写两用。 */
  const resolveRef = (
    effect: number,
    name: string,
  ): { kind: "fbo"; effect: number; name: string } | { kind: "composite"; index: number } =>
    fboNames[effect].has(name) ? { kind: "fbo", effect, name } : { kind: "composite", index: current };

  layer.effects.forEach((effect, e) => {
    if (!enabled(e)) return;
    // 规则 2：该 effect 任一 pass 的材质需要帧缓冲
    if (effect.steps.some((step) => step.kind === "draw" && step.pass.framebuffer)) snapshot();
    effect.steps.forEach((step, s) => {
      if (step.kind === "swap") {
        steps.push({ kind: "swap", effect: e, source: step.source, target: step.target });
        return;
      }
      if (step.kind === "copy") {
        // source → target 整张拷贝（B6，D3D CopyResource）；`effect` 是本 effect 的下标（fullscreen 的基础拷贝为 null）
        steps.push({ kind: "copy", effect: e, source: resolveRef(e, step.source), target: resolveRef(e, step.target) });
        return;
      }
      const inputs = staticInputs(step.pass, e);
      // 有 bind 时只按 bind 赋值（找不到的名字，如 previous = 当前合成 RT）；没有 bind 时槽 0 = 上一步输出（B6）
      if (step.binds) for (const bind of step.binds) inputs[bind.index] = resolveRef(e, bind.name);
      else inputs[0] = { kind: "composite", index: current };
      const final = e === finalEffect && s === finalStep;
      let target: TargetRef;
      if (final) {
        // 规则 3：上屏 pass 之前
        if (step.pass.framebuffer) snapshot();
        target = { kind: "scene" };
      } else if (step.target !== null && fboNames[e].has(step.target) && !step.compose)
        target = { kind: "fbo", effect: e, name: step.target };
      else target = nextComposite();
      steps.push({
        kind: "draw",
        role: final ? "final" : "effect",
        pass: step.pass,
        effect: e,
        target,
        inputs,
        // fullscreen 的上屏也是 NDC 四边形（P5b 步骤 3，`p5b-fs` 事件 76 画 ±1 的四边形）
        geometry: final ? screenGeometry : "fullscreen",
        uv: [1, 1],
        inset: final ? finalInset : NO_INSET,
        // 上屏借用基础材质的 blend（B7 `FUN_140209160`），colorBlendMode 31 强制 additive
        blending: final ? (additive ? "additive" : base.blending) : step.pass.blending,
      });
    });
  });

  if (passthrough) {
    const pass = layer.passthrough;
    if (!pass) reasons.push("render:no-passthrough");
    else {
      const inputs = staticInputs(pass, null);
      inputs[0] = { kind: "composite", index: current };
      if (pass.framebuffer) snapshot();
      steps.push({
        kind: "draw",
        role: "passthrough",
        pass,
        effect: null,
        target: { kind: "scene" },
        inputs,
        // fullscreen 同末 pass，画 NDC 四边形（P5b 步骤 3；colorBlendMode 混合的 fullscreen 没有实测，按同一条规则）
        geometry: screenGeometry,
        uv: [1, 1],
        inset: finalInset,
        blending: base.blending,
      });
    }
  } else if (finalEffect < 0 && group) {
    // 没有 effect 的组（P5b 步骤 4，`p5b-grp-nofx` 事件 125、`nofx0` 事件 120）：`effectpassthrough` 把合成 RT 画到图层四边形上，
    // UV 0–1、不内缩（组合层的上屏本来就不内缩）。混合：colorBlendMode 31 改 additive（读码），`copybackground` 为 true 取材质的
    // normal（实测关混合），false 强制 translucent（实测 SrcAlpha / InvSrcAlpha）
    const pass = layer.groupUpload;
    if (!pass) reasons.push("render:no-group-upload");
    else {
      const inputs = staticInputs(pass, null);
      inputs[0] = { kind: "composite", index: current };
      if (pass.framebuffer) snapshot();
      steps.push({
        kind: "draw",
        role: "final",
        pass,
        effect: null,
        target: { kind: "scene" },
        inputs,
        geometry: screenGeometry,
        uv: [1, 1],
        inset: finalInset,
        blending: additive ? "additive" : layer.copyBackground ? pass.blending : "translucent",
      });
    }
  } else if (finalEffect < 0) reasons.push("render:no-final-pass");

  // 文本层的合成 RT 取排版的 `compositeSize`（WPE 截断取整、不套 max(4, ·)，rea-p6b-layout 3.1）
  const [width, height] = sceneText ? textCompositeSize(text!) : compositeSize(layer, baseTexture);
  return { composite: { count: Math.min(2, writes), width, height }, steps, reasons };
}

/**
 * 图层运行时可能用到的计划；没有可变 effect 时为空。管线键只取决于 pass 和角色，不用枚举全部组合（见函数内）。
 * 带不支持项的 effect 打开时整场重编译，不算可变。
 */
export function variantPlans(layer: SceneLayer, textures: readonly TextureSize[]): LayerPlan[] {
  // 文本层（P6b 1d）的 effect 开关会改 `padding` 与文字框，切换走整场重编译（`SceneState.fromBundle` 冻结了它），不预备变体
  if (layer.text) return [];
  // dev 强制渲染时开着的 effect 可以带不支持项，它能就地关掉（`SceneState.needsRecompile`），所以也算可变
  const variable = layer.effects.flatMap((effect, e) =>
    effect.visibleBound && (effect.enabled || !effect.unsupported.length) ? [e] : [],
  );
  if (!variable.length) return [];
  const plan = (open: (e: number) => boolean) =>
    planLayer(layer, textures, (e) => (variable.includes(e) ? open(e) : layer.effects[e].enabled));
  return [
    plan(() => true), // 每个 pass 的普通角色
    plan(() => false), // 基础 pass 直接上屏；组合层（cbm 0 / 31）是空计划，整层不画；组是基础 pass → 子树 → `groupUpload` 上屏
    ...variable.map((v) => plan((e) => e <= v)), // v 的上屏角色
  ];
}

/**
 * 渲染图的签名：步骤序列、角色、目标、合成 RT。相同就不用重建（同 WPE「数值变了才重建」）。pass 只取稳定键；`clear` 等没有 pass 的
 * 步骤原样进签名。
 */
export function planSignature(plan: LayerPlan): string {
  const steps = plan.steps.map((step) =>
    step.kind === "draw" || step.kind === "particles" || step.kind === "text" || step.kind === "mesh"
      ? { ...step, pass: step.pass.key }
      : step,
  );
  return JSON.stringify({ composite: plan.composite, steps });
}

/**
 * 每个 effect 的 fbo 名 → 实体纹理下标。`swap` 不做 GPU 工作，只交换后续 pass（含之后各帧）里这两个名字指向的实体（B6），
 * 所以这张表跨帧保留：例如流体模拟在 effect 末尾 swap，下一帧就读写对调。
 */
export class FboBindings {
  private readonly maps: Map<string, number>[];
  /** 创建时的对应，不随 `swap` 变。 */
  private readonly initials: ReadonlyMap<string, number>[];

  constructor(maps: readonly ReadonlyMap<string, number>[]) {
    this.maps = maps.map((map) => new Map(map));
    this.initials = maps.map((map) => new Map(map));
  }

  resolve(effect: number, name: string): number {
    const id = this.maps[effect]?.get(name);
    if (id === undefined) throw new Error(`fbo ${name} 不在 effect ${effect} 里`);
    return id;
  }

  /** 这个名字的 fbo 对象本身：WPE 的 swap 只改 pass 下标，清屏清的是对象（J6）。 */
  initial(effect: number, name: string): number {
    const id = this.initials[effect]?.get(name);
    if (id === undefined) throw new Error(`fbo ${name} 不在 effect ${effect} 里`);
    return id;
  }

  swap(effect: number, a: string, b: string): void {
    const map = this.maps[effect];
    const x = map?.get(a),
      y = map?.get(b);
    if (!map || x === undefined || y === undefined) return;
    map.set(a, y);
    map.set(b, x);
  }
}
