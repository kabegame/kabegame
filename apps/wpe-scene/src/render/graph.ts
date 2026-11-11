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
 *   第 n 次写进合成 RT `n % 2`。尺寸取基础材质槽 0 纹理的图像尺寸（没有纹理、`solidLayer` 或组合层取图层 size，fullscreen 取
 *   `fullscreenSize`），再取 max(4, ·)。
 * - **`_rt_FullFrameBuffer`**（B8）：场景目标的整帧快照，每图层至多拷一次，时机是三处里最早满足的一处：
 *   图层开始时（基础材质需要帧缓冲，或走 passthrough）、需要帧缓冲的 effect 的第一个 pass 之前、上屏 pass 之前。
 *   合成链不画进场景，所以三处拷到的都是画到本图层之前的场景。WPE 第一处另有「非 fullscreen 或有子层、无 passthrough 父层」
 *   的条件。带子层的组合层照报（`model:passthrough:children`），所以没有哪个图层的父层是组合层，后半恒成立；前半只差在 fullscreen
 *   走合成路径时：WPE 在图层开始时不拷快照，而是把当前目标直接拷进合成 RT 0，我们为了这次拷贝先拍一次快照（见下「fullscreen」），
 *   内容相同（都是画到本图层之前的场景），之后规则 2、3 不再重拷。fullscreen 直接上屏时照规则 1。
 * - **组合层**（P5b 步骤 2，`SceneLayer.passthroughModel`，p5-REPORT `p5b-cl`）：不带子层时就是基础 pass 换了写法的合成路径。
 *   没有启用的 effect、colorBlendMode ∈ {0, 31} 时整层不画（空计划；WPE 照拷一次快照，看不出来，不拷）。否则基础 pass 按
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
 * - **粒子层**（P4a 步骤 4，`planParticleLayer`）：`particles` 步骤直接画到场景目标，和图像步骤同样按 `objects` 顺序；有子系统时
 *   按系统树先序展开成若干次（P4e 步骤 1）。
 */
import { FRAMEBUFFER_RT, type SceneFbo, type SceneLayer, type ScenePass, type SceneTexture } from "../compile/bundle";
import { MAX_CHILD_DEPTH, type SceneParticle } from "../compile/particles";
import { NO_INSET, textureUvExtent, uvInset } from "./layout";

export type TextureRef =
  | { kind: "texture"; index: number }
  | { kind: "composite"; index: number }
  | { kind: "fbo"; effect: number; name: string }
  | { kind: "framebuffer" };
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
   * 这次绘制的系统在树里的路径（P4e 步骤 1）：顶层 `[]`，static 子系统 `[n]`、`[n, m]`…，每层是 `SceneParticle.children` 的下标。
   * 渲染器只为 `[]` 建模拟器（整棵树），子系统的绘制取树里对应的节点（`ParticleSystem.node`）。
   */
  node: number[];
  /** 这个系统 `flags & 1`（世界空间）：绘制的模型矩阵是单位阵（`particles/system.ts` 的 `particleDrawModel`）。 */
  world: boolean;
}
export type LayerStep =
  | DrawStep
  | ParticleStep
  | { kind: "snapshot" }
  /**
   * 整张拷贝（B6，D3D CopyResource）。`effect` 同 `DrawStep.effect`：effect 的 `copy` 命令是它的下标；fullscreen 的基础 pass
   * （快照 → 合成 RT 0，P5b 步骤 3）不属于任何 effect，为 null。来源与目标的 fbo 引用各带自己的 effect 下标，解析不读这个字段。
   */
  | { kind: "copy"; effect: number | null; source: TextureRef; target: TargetRef }
  | { kind: "swap"; effect: number; source: string; target: string }
  /** 把目标清成 (0, 0, 0, 0)：组合层 `copyBackground` 为 false 时代替基础 pass（P5b 步骤 2，WPE 只清颜色、不清深度）。 */
  | { kind: "clear"; target: TargetRef };

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
 * 或没有纹理时取场景尺寸），排在最前；否则基础材质槽 0 纹理的图像尺寸，没有纹理、`solidLayer` 或组合层（取 `round(size)`，
 * rea-p5-modelflags §2.3，`p5b-cl` 实测 600×300）取图层 size；最后取 max(4, ·)。精灵表取单帧留到 P6。
 */
export function compositeSize(
  layer: Pick<SceneLayer, "size" | "solidLayer" | "passthroughModel" | "fullscreenSize">,
  texture: TextureSize | undefined,
): [number, number] {
  const [w, h] = layer.fullscreenSize
    ? layer.fullscreenSize
    : texture && !layer.solidLayer && !layer.passthroughModel
      ? [texture.width, texture.height]
      : [layer.size[0] ?? 0, layer.size[1] ?? 0];
  return [Math.max(4, Math.round(w)), Math.max(4, Math.round(h))];
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
 * 粒子层的计划（P4a 步骤 4）：一个 `particles` 步骤，直接画到场景目标。其余运行时纹理（fbo 名）粒子没有，报不支持。
 * 没有 pass（粒子 JSON 读不到、材质缺失）时为空计划。
 *
 * 快照（P4b 步骤 5，`genericparticle` 的 `REFRACT` 从 `g_Texture3` 读 `_rt_FullFrameBuffer`）：材质需要帧缓冲
 * （`pass.framebuffer`，判定同 WPE 基础材质 `+0x1fc` bit1）时，照图像层直接上屏的规则 1 在本层开始前拷一次。
 * - 时机和 WPE 相同：`FUN_1402366f0` 在本系统任何 renderer 画之前拷当前场景目标整张，每对象每帧至多一次（rea-p4b-render.md
 *   6.1）；所以快照含按 `objects` 顺序画在它前面的全部内容，不含自己。步骤 0 抓帧（`p4b-refract`）里每个 `REFRACT` 对象前
 *   各有一次拷贝，`CUTOUT` 对象前没有（它不读帧缓冲，`pass.framebuffer` 为假），和这里一致。
 * - WPE 在存活数为 0 时不拷也不画，我们照拷。画面不受影响：本层自己没有粒子可画，而之后读快照的每一层（图像层规则 1–3、
 *   passthrough、其它粒子层）都在本层内自己重拷，泛光也在全部图层之后再拷一次，没有哪一步读到的是这次多拷的内容。
 * - WPE 的场景目标开了 MSAA，快照是 `ResolveSubresource`，我们是 `copyTextureToTexture`；轴对齐、落在整像素上的四边形
 *   两者相同，差异只可能在边缘。逐像素比较见 P4b 计划步骤 5 的验收。
 *
 * 子系统（P4e 步骤 1，rea-p4e-children 第 6 节，`FUN_1402366f0` 的先序递归）：一个粒子层按系统树的先序展开成若干次绘制——父自己 →
 * static 子系统（条目顺序、深度优先）；事件实例在 P4e 步骤 2 接在 static 之后。每次绘制用自己系统的 pass、混合、透视位，`node` 是它在
 * 树里的路径。
 * - 基础材质为空（没有 pass）的系统整棵子树都不画（`sys+0x358 == 0` 直接返回）。
 * - `renderer: []`（`renderers` 为空）的系统自己不画，照常递归子系统（语料里只靠子系统出图的发射器）；它的材质要帧缓冲时快照照拷
 *   （WPE 在存活数 > 0 时、逐 renderer 画之前拷）。
 * - 快照（折射位在对象上，父子共用）：先序里第一个需要帧缓冲的系统之前拷一次，同一个粒子层只拷一次。WPE 在存活数为 0 时不拷、由下一个
 *   需要的系统拷，两者之间这层没画任何东西（存活数 0 的系统不画），读到的内容相同。
 */
export function planParticleLayer(layer: Pick<SceneLayer, "particle">): LayerPlan {
  const reasons: string[] = [];
  const steps: LayerStep[] = [];
  const particle = layer.particle;
  if (!particle) return { composite: null, steps, reasons };
  let snapped = false;
  const visit = (system: SceneParticle, node: number[]): void => {
    const pass = system.passes[0];
    if (!pass) return;
    // 编译期已报 `particle:material:passes`；渲染器只画第一个
    if (system.passes.length > 1) reasons.push("render:multi-pass");
    const inputs: Record<number, TextureRef> = {};
    for (const [slot, index] of Object.entries(pass.textures)) inputs[Number(slot)] = { kind: "texture", index };
    for (const [slot, name] of Object.entries(pass.runtime)) {
      if (name === FRAMEBUFFER_RT) inputs[Number(slot)] = { kind: "framebuffer" };
      else reasons.push(`render:texture-rt:${name}`);
    }
    if (pass.framebuffer && !snapped) {
      snapped = true;
      steps.push({ kind: "snapshot" });
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
      });
    // 深度上限同模拟器（`MAX_CHILD_DEPTH`，编译期已按它截断；这里防手写的环）
    if (node.length < MAX_CHILD_DEPTH)
      system.children.forEach((child, index) => {
        if (child.type === "static") visit(child.system, [...node, index]);
      });
  };
  visit(particle, []);
  return { composite: null, steps, reasons };
}

export function planLayer(
  layer: SceneLayer,
  textures: readonly TextureSize[],
  enabled: (effect: number) => boolean = (e) => layer.effects[e].enabled, // 运行时的开关，3c 步骤 2 传入
): LayerPlan {
  // 粒子对象没有图像 pass，也不编 effect（`compileScene`）
  if (layer.particle) return planParticleLayer(layer);
  const reasons: string[] = [];
  const steps: LayerStep[] = [];
  const base = layer.passes[0];
  if (!base) return { composite: null, steps, reasons };
  if (layer.passes.length > 1) reasons.push("render:multi-pass");
  const baseTexture = base.textures[0] === undefined ? undefined : textures[base.textures[0]];
  const uv = textureUvExtent(baseTexture);
  // UV 内缩分两种（P5b 步骤 1，p5-REPORT `p5b-nopad`）：直接上屏（WPE `+0x490`，flags & 0x226）在 fullscreen、nopadding、
  // passthrough、solidlayer 时不内缩；末 pass 与 passthrough 上屏（`+0x2e8`，flags & 0x222）不看 nopadding。
  // 组合层（步骤 2）两块都不内缩（rea-p5-modelflags §2.3，`p5b-cl` 上屏 UV 0–1）；它不会走直接上屏，加进去只为和 WPE 的条件一致。
  // fullscreen（步骤 3）两块也都不内缩（`p5b-fs` 上屏、`p5b-fsmvp` 直接上屏的 UV 都是 0–1）
  const flat = layer.solidLayer || layer.passthroughModel || layer.fullscreen;
  // fullscreen 的直接上屏与上屏都画 2×2 的 NDC 四边形（P5b 步骤 3）
  const screenGeometry: Geometry = layer.fullscreen ? "fullscreen" : "layer";
  const directInset = flat || layer.noPadding ? NO_INSET : uvInset(layer.size, baseTexture);
  const finalInset = flat ? NO_INSET : uvInset(layer.size, baseTexture);
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

  if (!needsComposite(layer, enabled)) {
    // 组合层（P5b 步骤 2，p5-REPORT `p5b-cl` 的 CL3、CL5）：没有启用的 effect、colorBlendMode ∈ {0, 31}、没有子层时整层不画。
    // WPE 在图层开始时照拷一次快照，没人读，不拷。带子层的照报（`model:passthrough:children`），步骤 4 再画子树。
    // fullscreenlayer 也是组合层，同样不画（P5b 步骤 3，`p5b-fsnofx` 没有 draw）
    if (layer.passthroughModel) return { composite: null, steps, reasons };
    // 规则 1：基础材质需要帧缓冲
    if (base.framebuffer) snapshot();
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
  if (layer.fullscreen) {
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
  } else if (finalEffect < 0) reasons.push("render:no-final-pass");

  const [width, height] = compositeSize(layer, baseTexture);
  return { composite: { count: Math.min(2, writes), width, height }, steps, reasons };
}

/**
 * 图层运行时可能用到的计划；没有可变 effect 时为空。管线键只取决于 pass 和角色，不用枚举全部组合（见函数内）。
 * 带不支持项的 effect 打开时整场重编译，不算可变。
 */
export function variantPlans(layer: SceneLayer, textures: readonly TextureSize[]): LayerPlan[] {
  // dev 强制渲染时开着的 effect 可以带不支持项，它能就地关掉（`SceneState.needsRecompile`），所以也算可变
  const variable = layer.effects.flatMap((effect, e) =>
    effect.visibleBound && (effect.enabled || !effect.unsupported.length) ? [e] : [],
  );
  if (!variable.length) return [];
  const plan = (open: (e: number) => boolean) =>
    planLayer(layer, textures, (e) => (variable.includes(e) ? open(e) : layer.effects[e].enabled));
  return [
    plan(() => true), // 每个 pass 的普通角色
    plan(() => false), // 基础 pass 直接上屏；组合层（cbm 0 / 31）是空计划，整层不画
    ...variable.map((v) => plan((e) => e <= v)), // v 的上屏角色
  ];
}

/**
 * 渲染图的签名：步骤序列、角色、目标、合成 RT。相同就不用重建（同 WPE「数值变了才重建」）。pass 只取稳定键；`clear` 等没有 pass 的
 * 步骤原样进签名。
 */
export function planSignature(plan: LayerPlan): string {
  const steps = plan.steps.map((step) =>
    step.kind === "draw" || step.kind === "particles" ? { ...step, pass: step.pass.key } : step,
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
