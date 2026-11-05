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
 *   第 n 次写进合成 RT `n % 2`。尺寸取基础材质槽 0 纹理的图像尺寸（没有纹理取图层 size），再取 max(4, ·)。
 * - **`_rt_FullFrameBuffer`**（B8）：场景目标的整帧快照，每图层至多拷一次，时机是三处里最早满足的一处：
 *   图层开始时（基础材质需要帧缓冲，或走 passthrough）、需要帧缓冲的 effect 的第一个 pass 之前、上屏 pass 之前。
 *   合成链不画进场景，所以三处拷到的都是画到本图层之前的场景。WPE 第一处另有「非 fullscreen 或有子层、无 passthrough 父层」
 *   的条件，P2a 的场景没有 fullscreen / 父子层（另报 unsupported），条件恒成立。
 */
import { FRAMEBUFFER_RT, type SceneFbo, type SceneLayer, type ScenePass, type SceneTexture } from "../compile/bundle";
import { textureUvExtent } from "./layout";

export type TextureRef =
  | { kind: "texture"; index: number }
  | { kind: "composite"; index: number }
  | { kind: "fbo"; effect: number; name: string }
  | { kind: "framebuffer" };
export type TargetRef =
  { kind: "scene" } | { kind: "composite"; index: number } | { kind: "fbo"; effect: number; name: string };

/**
 * - `direct`：直接上屏的基础 pass；`base`：画进合成 RT 的基础 pass；`effect`：画全屏四边形到合成 RT / fbo；
 * - `final`：最后一个 effect 的最后一个绘制 pass，上屏；`passthrough`：colorBlendMode 混合的上屏 pass。
 */
export type DrawRole = "direct" | "base" | "effect" | "final" | "passthrough";
/**
 * - `layer`：图层世界四边形（模型空间、未缩放的 size），场景视图投影 × 图层模型矩阵；
 * - `fill`：同一个四边形用正交投影画满目标、单位模型矩阵（基础 pass 画进合成 RT）；
 * - `fullscreen`：NDC 全屏四边形，MVP 为单位阵。
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
  /** 混合模式（`programs.ts` 的 `blendState`）；null = 关闭混合、四通道直写。 */
  blending: string | null;
}
export type LayerStep =
  | DrawStep
  | { kind: "snapshot" }
  | { kind: "copy"; effect: number; source: TextureRef; target: TargetRef }
  | { kind: "swap"; effect: number; source: string; target: string };

export interface LayerPlan {
  /** 合成 RT 的张数与尺寸；直接上屏时为 null。 */
  composite: { count: number; width: number; height: number } | null;
  steps: LayerStep[];
  /** 渲染器还不会画的结构（原因键）。 */
  reasons: string[];
}

type TextureSize = Pick<SceneTexture, "width" | "height" | "textureWidth" | "textureHeight">;

/** 合成 RT 尺寸（B5 `FUN_1402091e0`）：基础材质槽 0 纹理的图像尺寸，没有纹理取图层 size，再取 max(4, ·)。精灵表取单帧留到 P6。 */
export function compositeSize(layer: Pick<SceneLayer, "size">, texture: TextureSize | undefined): [number, number] {
  const [w, h] = texture ? [texture.width, texture.height] : [layer.size[0] ?? 0, layer.size[1] ?? 0];
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

export function planLayer(
  layer: SceneLayer,
  textures: readonly TextureSize[],
  enabled: (effect: number) => boolean = (e) => layer.effects[e].enabled, // 运行时的开关，3c 步骤 2 传入
): LayerPlan {
  const reasons: string[] = [];
  const steps: LayerStep[] = [];
  const base = layer.passes[0];
  if (!base) return { composite: null, steps, reasons };
  if (layer.passes.length > 1) reasons.push("render:multi-pass");
  const baseTexture = base.textures[0] === undefined ? undefined : textures[base.textures[0]];
  const uv = textureUvExtent(baseTexture);
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
    // 规则 1：基础材质需要帧缓冲
    if (base.framebuffer) snapshot();
    steps.push({
      kind: "draw",
      role: "direct",
      pass: base,
      effect: null,
      target: { kind: "scene" },
      inputs: staticInputs(base, null),
      geometry: "layer",
      uv,
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
  steps.push({
    kind: "draw",
    role: "base",
    pass: base,
    effect: null,
    target: nextComposite(),
    inputs: staticInputs(base, null),
    geometry: "fill",
    uv,
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
        // source → target 整张拷贝（B6，D3D CopyResource）
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
        geometry: final ? "layer" : "fullscreen",
        uv: [1, 1],
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
        geometry: "layer",
        uv: [1, 1],
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
    plan(() => false), // 基础 pass 直接上屏
    ...variable.map((v) => plan((e) => e <= v)), // v 的上屏角色
  ];
}

/** 渲染图的签名：步骤序列、角色、目标、合成 RT。相同就不用重建（同 WPE「数值变了才重建」）。pass 只取稳定键。 */
export function planSignature(plan: LayerPlan): string {
  const steps = plan.steps.map((step) => (step.kind === "draw" ? { ...step, pass: step.pass.key } : step));
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
