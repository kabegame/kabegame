import { describe, expect, it, vi } from "vitest";
import type { SceneEffect, SceneEffectStep, SceneFbo, SceneLayer, ScenePass, SceneTexture } from "../compile/bundle";
import {
  compositeSize,
  FboBindings,
  fboSize,
  needsComposite,
  planLayer,
  planSignature,
  variantPlans,
  type DrawStep,
  type LayerPlan,
  type LayerStep,
} from "./graph";
import { layerLocalMatrix, uvInset } from "./layout";
import { transformPoint } from "./math";
import { drawMatrices, pipelineKey, stepPipeline, uploadableTextures } from "./scene";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

function pass(partial: Partial<ScenePass> = {}): ScenePass {
  return {
    key: "objects/0/passes/0",
    program: 0,
    blending: "normal",
    cullmode: "nocull",
    depthtest: "disabled",
    depthwrite: "disabled",
    textures: {},
    runtime: {},
    uniforms: {},
    framebuffer: false,
    ...partial,
  };
}
function draw(partial: Partial<Extract<SceneEffectStep, { kind: "draw" }>> = {}): SceneEffectStep {
  return { kind: "draw", pass: pass(), target: null, compose: false, binds: null, ...partial };
}
function fbo(name: string, partial: Partial<SceneFbo> = {}): SceneFbo {
  return { name, format: "rgba8888", scale: 1, unique: false, repeat: false, ...partial };
}
function effect(steps: SceneEffectStep[], fbos: SceneFbo[] = []): SceneEffect {
  return {
    source: 0,
    id: 1,
    name: "",
    file: "effects/x/effect.json",
    fbos,
    steps,
    enabled: true,
    visibleBound: false,
    unsupported: [],
  };
}
function layer(partial: Partial<SceneLayer> = {}): SceneLayer {
  return {
    id: 7,
    object: 0,
    parent: null,
    name: "l",
    origin: [100, 50, 0],
    scale: [1, 1, 1],
    angles: [0, 0, 0],
    size: [200, 100],
    alpha: 1,
    color: [1, 1, 1],
    brightness: 1,
    visible: true,
    visibleBound: false,
    solidLayer: false,
    passes: [pass({ blending: "translucent", textures: { 0: 0 } })],
    colorBlendMode: 0,
    effects: [],
    passthrough: null,
    particle: null,
    ...partial,
  };
}
const textures: Pick<SceneTexture, "width" | "height" | "textureWidth" | "textureHeight">[] = [
  { width: 219, height: 216, textureWidth: 256, textureHeight: 256 },
];
const draws = (steps: LayerStep[]) => steps.filter((step): step is DrawStep => step.kind === "draw");
const kinds = (steps: LayerStep[]) =>
  steps.map((step) =>
    step.kind === "draw"
      ? `${step.role}→${step.target.kind === "composite" ? `c${step.target.index}` : step.target.kind === "fbo" ? step.target.name : "scene"}`
      : step.kind,
  );

describe("图层渲染图：合成 RT 计数与上屏 pass", () => {
  it("没有 effect、colorBlendMode 0：直接上屏（P1 路径），不分配合成 RT", () => {
    const plan = planLayer(layer(), textures);
    expect(plan.composite).toBeNull();
    expect(kinds(plan.steps)).toEqual(["direct→scene"]);
    expect(draws(plan.steps)[0]).toMatchObject({
      geometry: "layer",
      uv: [219 / 256, 216 / 256],
      blending: "translucent",
    });
  });
  it("colorBlendMode 31：仍直接上屏，混合改 additive", () => {
    expect(draws(planLayer(layer({ colorBlendMode: 31 }), textures).steps)[0].blending).toBe("additive");
  });
  it("一个 effect：1 张合成 RT；基础 pass 关混合画满，effect 借基础材质的 blend 上屏", () => {
    const plan = planLayer(layer({ effects: [effect([draw({ pass: pass({ blending: "normal" }) })])] }), textures);
    expect(plan.composite).toEqual({ count: 1, width: 219, height: 216 });
    expect(kinds(plan.steps)).toEqual(["base→c0", "final→scene"]);
    const [base, final] = draws(plan.steps);
    expect(base).toMatchObject({ geometry: "fill", blending: null, uv: [219 / 256, 216 / 256] });
    expect(final).toMatchObject({ geometry: "layer", blending: "translucent", uv: [1, 1] });
    // 没有 bind：槽 0 = 上一步输出
    expect(final.inputs[0]).toEqual({ kind: "composite", index: 0 });
  });
  it("两个 effect：2 张 ping-pong，只有最后一个上屏；三个也只用 2 张", () => {
    const two = planLayer(layer({ effects: [effect([draw()]), effect([draw()])] }), textures);
    expect(two.composite?.count).toBe(2);
    expect(kinds(two.steps)).toEqual(["base→c0", "effect→c1", "final→scene"]);
    expect(draws(two.steps)[2].inputs[0]).toEqual({ kind: "composite", index: 1 });
    const three = planLayer(layer({ effects: [effect([draw()]), effect([draw()]), effect([draw()])] }), textures);
    expect(three.composite?.count).toBe(2);
    expect(kinds(three.steps)).toEqual(["base→c0", "effect→c1", "effect→c0", "final→scene"]);
    expect(draws(three.steps)[2].inputs[0]).toEqual({ kind: "composite", index: 1 });
  });
  it("colorBlendMode 混合：合成 RT +1，effect 都留在合成链，passthrough 上屏", () => {
    const passthrough = pass({ blending: "normal", runtime: { 4: "_rt_FullFrameBuffer" }, framebuffer: true });
    const none = planLayer(layer({ colorBlendMode: 12, passthrough }), textures);
    expect(none.composite?.count).toBe(1);
    expect(kinds(none.steps)).toEqual(["snapshot", "base→c0", "passthrough→scene"]);
    const final = draws(none.steps)[1];
    expect(final).toMatchObject({ geometry: "layer", blending: "translucent" });
    expect(final.inputs).toEqual({ 0: { kind: "composite", index: 0 }, 4: { kind: "framebuffer" } });
    const one = planLayer(layer({ colorBlendMode: 11, passthrough, effects: [effect([draw()])] }), textures);
    expect(one.composite?.count).toBe(2);
    expect(kinds(one.steps)).toEqual(["snapshot", "base→c0", "effect→c1", "passthrough→scene"]);
    expect(planLayer(layer({ colorBlendMode: 11 }), textures).reasons).toContain("render:no-passthrough");
  });
  it("compose pass 写进合成链并计数，fbo 目标不计", () => {
    const plan = planLayer(
      layer({
        effects: [
          effect(
            [
              draw({ target: "_rt_A", binds: [{ name: "previous", index: 0 }] }),
              draw({ compose: true }),
              draw({
                binds: [
                  { name: "_rt_A", index: 0 },
                  { name: "previous", index: 2 },
                ],
              }),
            ],
            [fbo("_rt_A", { scale: 4 })],
          ),
        ],
      }),
      textures,
    );
    expect(plan.composite?.count).toBe(2);
    expect(kinds(plan.steps)).toEqual(["base→c0", "effect→_rt_A", "effect→c1", "final→scene"]);
    const [, toFbo, , final] = draws(plan.steps);
    // previous / 找不到的名字 = 当前合成 RT；有 bind 时不自动填槽 0 以外的空槽
    expect(toFbo.inputs).toEqual({ 0: { kind: "composite", index: 0 } });
    expect(final.inputs).toEqual({
      0: { kind: "fbo", effect: 0, name: "_rt_A" },
      2: { kind: "composite", index: 1 },
    });
  });
  it("未启用的 effect 不进 bundle：最后一个启用的才上屏（编译期已过滤，这里只看剩下的）", () => {
    const plan = planLayer(layer({ effects: [effect([draw(), draw({ target: "_rt_B" })], [fbo("_rt_B")])] }), textures);
    // 最后一个绘制 pass 即使写了 fbo 目标，也用图层几何上屏
    expect(kinds(plan.steps)).toEqual(["base→c0", "effect→c1", "final→scene"]);
  });
  it("没有纹理时合成 RT 取图层 size，至少 4", () => {
    expect(compositeSize({ size: [2, 300], solidLayer: false }, undefined)).toEqual([4, 300]);
    expect(compositeSize({ size: [2, 300], solidLayer: false }, textures[0])).toEqual([219, 216]);
  });
  it("UV 内缩：上屏的四边形才有，分母是基础纹理的纹理尺寸", () => {
    const e = [Math.fround(0.15) / 256, Math.fround(0.15) / 256].map(Math.fround);
    const insets = (plan: ReturnType<typeof planLayer>) =>
      Object.fromEntries(draws(plan.steps).map((step) => [step.role, [...step.inset]]));
    expect(insets(planLayer(layer(), textures))).toEqual({ direct: e });
    expect(insets(planLayer(layer({ effects: [effect([draw(), draw()])] }), textures))).toEqual({
      base: [0, 0],
      effect: [0, 0],
      final: e,
    });
    const passthrough = pass({ key: "pt" });
    expect(insets(planLayer(layer({ colorBlendMode: 12, passthrough }), textures))).toEqual({
      base: [0, 0],
      passthrough: e,
    });
  });
  it("UV 内缩：分母按轴取纹理尺寸，不是图像尺寸", () => {
    const texture = { width: 100, height: 50, textureWidth: 128, textureHeight: 64 };
    expect(uvInset([600, 200], texture)).toEqual([
      Math.fround(Math.fround(0.15) / 128),
      Math.fround(Math.fround(0.15) / 64),
    ]);
  });
  it("UV 内缩：solidlayer 没有，没有纹理时分母是图层 size 的整数部分", () => {
    const solid = planLayer(layer({ solidLayer: true, effects: [effect([draw()])] }), textures);
    for (const step of draws(solid.steps)) expect(step.inset).toEqual([0, 0]);
    expect(uvInset([300.9, 2.5], undefined)).toEqual([
      Math.fround(Math.fround(0.15) / 300),
      Math.fround(Math.fround(0.15) / 2),
    ]);
    expect(uvInset([0, 0], undefined)).toEqual([0, 0]);
  });
  it("solidlayer 带纹理时合成 RT 也取图层 size", () => {
    expect(compositeSize({ size: [2, 300], solidLayer: true }, textures[0])).toEqual([4, 300]);
    const plan = planLayer(layer({ solidLayer: true, effects: [effect([draw()])] }), textures);
    expect(plan.composite).toMatchObject({ width: 200, height: 100 });
  });
});

describe("图层渲染图：copy、swap 与 fbo", () => {
  it("copy：source 整张拷到 target，名字照 bind 的规则解析", () => {
    const plan = planLayer(
      layer({
        effects: [
          effect(
            [
              draw({
                target: "_rt_FullCompoBuffer2",
                binds: [
                  { name: "previous", index: 0 },
                  { name: "_rt_FullCompoBuffer1", index: 1 },
                ],
              }),
              { kind: "copy", source: "_rt_FullCompoBuffer2", target: "_rt_FullCompoBuffer1" },
              draw({ binds: [{ name: "_rt_FullCompoBuffer2", index: 0 }] }),
            ],
            [fbo("_rt_FullCompoBuffer1", { unique: true }), fbo("_rt_FullCompoBuffer2")],
          ),
        ],
      }),
      textures,
    );
    const copy = plan.steps.find((step) => step.kind === "copy");
    expect(copy).toEqual({
      kind: "copy",
      effect: 0,
      source: { kind: "fbo", effect: 0, name: "_rt_FullCompoBuffer2" },
      target: { kind: "fbo", effect: 0, name: "_rt_FullCompoBuffer1" },
    });
    expect(plan.composite?.count).toBe(1);
  });
  it("swap 只交换后续（含之后各帧）引用的实体，不做 GPU 工作", () => {
    const plan = planLayer(
      layer({
        effects: [
          effect(
            [
              draw({ target: "_rt_V2", binds: [{ name: "_rt_V1", index: 0 }] }),
              { kind: "swap", source: "_rt_V1", target: "_rt_V2" },
              draw({ binds: [{ name: "_rt_V1", index: 0 }] }),
            ],
            [fbo("_rt_V1", { unique: true }), fbo("_rt_V2", { unique: true })],
          ),
        ],
      }),
      textures,
    );
    expect(plan.steps.map((step) => step.kind)).toEqual(["draw", "draw", "swap", "draw"]);
    // 照步骤模拟两帧：写 V2 → swap → 读 V1（= 刚写的那张）；下一帧对调
    const bindings = new FboBindings([
      new Map([
        ["_rt_V1", 10],
        ["_rt_V2", 11],
      ]),
    ]);
    const frame = () => {
      const log: string[] = [];
      for (const step of plan.steps) {
        if (step.kind === "swap") bindings.swap(step.effect, step.source, step.target);
        else if (step.kind === "draw" && step.role !== "base") {
          const read = step.inputs[0];
          const reads = read?.kind === "fbo" ? bindings.resolve(read.effect, read.name) : -1;
          const writes = step.target.kind === "fbo" ? bindings.resolve(step.target.effect, step.target.name) : -1;
          log.push(`${reads}→${writes}`);
        }
      }
      return log;
    };
    expect(frame()).toEqual(["10→11", "11→-1"]);
    expect(frame()).toEqual(["11→10", "10→-1"]);
    expect(frame()).toEqual(["10→11", "11→-1"]);
  });
  it("fbo 尺寸：scale 整除、width / height 覆盖、fit 按长边等比，最小 2", () => {
    expect(fboSize(fbo("a", { scale: 4 }), [219, 216])).toEqual([54, 54]);
    expect(fboSize(fbo("a", { width: 100, height: 30 }), [219, 216])).toEqual([100, 30]);
    // W' ≥ H'：w = min(fit, W')，h = H'/W'·w，截断后再除以 scale
    expect(fboSize(fbo("a", { fit: 256 }), [3840, 2160])).toEqual([256, 144]);
    expect(fboSize(fbo("a", { fit: 256, scale: 2 }), [3840, 2160])).toEqual([128, 72]);
    // W' < H'：h = min(fit, H')
    expect(fboSize(fbo("a", { fit: 512 }), [1080, 1920])).toEqual([288, 512]);
    // fit 比原尺寸大时不放大
    expect(fboSize(fbo("a", { fit: 4096 }), [300, 200])).toEqual([300, 200]);
    expect(fboSize(fbo("a", { scale: 8 }), [8, 8])).toEqual([2, 2]);
  });
});

describe("图层渲染图：_rt_FullFrameBuffer 快照时机（每图层至多一次）", () => {
  it("图层开始时：基础材质需要帧缓冲", () => {
    const plan = planLayer(
      layer({ passes: [pass({ framebuffer: true, runtime: { 4: "_rt_FullFrameBuffer" } })] }),
      textures,
    );
    expect(kinds(plan.steps)).toEqual(["snapshot", "direct→scene"]);
    expect(draws(plan.steps)[0].inputs[4]).toEqual({ kind: "framebuffer" });
  });
  it("需要帧缓冲的 effect 的第一个 pass 之前（不是基础 pass 之前）", () => {
    const plan = planLayer(
      layer({
        effects: [
          effect([draw()]),
          effect([draw({ target: "_rt_A" }), draw({ pass: pass({ framebuffer: true }) })], [fbo("_rt_A")]),
        ],
      }),
      textures,
    );
    expect(kinds(plan.steps)).toEqual(["base→c0", "effect→c1", "snapshot", "effect→_rt_A", "final→scene"]);
  });
  it("上屏 pass 之前；已经拷过就不再拷", () => {
    const final = planLayer(layer({ effects: [effect([draw({ pass: pass({ framebuffer: true }) })])] }), textures);
    // 上屏 pass 所在的 effect 也需要帧缓冲，所以规则 2 先命中：都在基础 pass 之后、上屏之前，内容相同
    expect(kinds(final.steps)).toEqual(["base→c0", "snapshot", "final→scene"]);
    const once = planLayer(
      layer({
        passes: [pass({ framebuffer: true })],
        effects: [
          effect([draw({ pass: pass({ framebuffer: true }) })]),
          effect([draw({ pass: pass({ framebuffer: true }) })]),
        ],
      }),
      textures,
    );
    expect(once.steps.filter((step) => step.kind === "snapshot")).toHaveLength(1);
    expect(once.steps[0].kind).toBe("snapshot");
  });
  it("不需要帧缓冲时不拷", () => {
    expect(planLayer(layer({ effects: [effect([draw()])] }), textures).steps.some((s) => s.kind === "snapshot")).toBe(
      false,
    );
  });
});

describe("渲染图按开关重排（3c）", () => {
  const off = (partial: SceneEffect): SceneEffect => ({ ...partial, enabled: false, visibleBound: true });
  it("两个 effect 关掉后一个：前一个的最后绘制 pass 上屏，合成 RT 由 2 张变 1 张", () => {
    const first = effect([draw({ pass: pass({ key: "e0" }) })]);
    const second = effect([draw({ pass: pass({ key: "e1" }) })]);
    const both = planLayer(layer({ effects: [first, second] }), textures);
    expect(both.composite?.count).toBe(2);
    expect(kinds(both.steps)).toEqual(["base→c0", "effect→c1", "final→scene"]);
    const closed = planLayer(layer({ effects: [first, off(second)] }), textures);
    expect(closed.composite?.count).toBe(1);
    expect(kinds(closed.steps)).toEqual(["base→c0", "final→scene"]);
    expect(draws(closed.steps)[1]).toMatchObject({
      effect: 0,
      geometry: "layer",
      blending: "translucent",
      pass: { key: "e0" },
    });
  });
  it("全关时基础 pass 直接上屏，不分配合成 RT", () => {
    const effects = [off(effect([draw()])), off(effect([draw()]))];
    const plan = planLayer(layer({ effects }), textures);
    expect(plan.composite).toBeNull();
    expect(plan.reasons).toEqual([]);
    expect(kinds(plan.steps)).toEqual(["direct→scene"]);
    expect(draws(plan.steps)[0]).toMatchObject({ blending: "translucent", uv: [219 / 256, 216 / 256] });
    expect(needsComposite({ effects, colorBlendMode: 0 })).toBe(false);
    expect(needsComposite({ effects, colorBlendMode: 11 })).toBe(true);
  });
  it("passthrough 图层开关 effect 时上屏仍是 passthrough", () => {
    const base = { colorBlendMode: 11, passthrough: pass({ key: "pt" }) };
    const open = planLayer(layer({ ...base, effects: [effect([draw()])] }), textures);
    const closed = planLayer(layer({ ...base, effects: [off(effect([draw()]))] }), textures);
    expect(kinds(open.steps)).toEqual(["snapshot", "base→c0", "effect→c1", "passthrough→scene"]);
    expect(kinds(closed.steps)).toEqual(["snapshot", "base→c0", "passthrough→scene"]);
    expect(open.composite?.count).toBe(2);
    expect(closed.composite?.count).toBe(1);
    // 关掉之后 passthrough 读基础 pass 写的那张合成 RT
    expect(draws(closed.steps).at(-1)?.inputs[0]).toEqual({ kind: "composite", index: 0 });
  });
  it("关掉的 effect 里的 fbo 引用不进步骤，后面 effect 的下标不移位", () => {
    const first = off(effect([draw({ target: "_rt_A" })], [fbo("_rt_A")]));
    const second = effect([draw({ target: "_rt_B" }), draw({ binds: [{ name: "_rt_B", index: 1 }] })], [fbo("_rt_B")]);
    const plan = planLayer(layer({ effects: [first, second] }), textures);
    expect(kinds(plan.steps)).toEqual(["base→c0", "effect→_rt_B", "final→scene"]);
    const steps = draws(plan.steps);
    expect(steps.slice(1).map((step) => step.effect)).toEqual([1, 1]);
    expect(steps[1].target).toEqual({ kind: "fbo", effect: 1, name: "_rt_B" });
    expect(steps[2].inputs[1]).toEqual({ kind: "fbo", effect: 1, name: "_rt_B" });
    expect(JSON.stringify(plan.steps)).not.toContain("_rt_A");
  });
  it("关掉的 effect 的 copy / swap 与快照需求一起消失", () => {
    const closed = off(
      effect(
        [
          { kind: "copy", source: "previous", target: "_rt_A" },
          { kind: "swap", source: "_rt_A", target: "_rt_B" },
          draw({ pass: pass({ framebuffer: true }) }),
        ],
        [fbo("_rt_A"), fbo("_rt_B")],
      ),
    );
    expect(kinds(planLayer(layer({ effects: [closed, effect([draw()])] }), textures).steps)).toEqual([
      "base→c0",
      "final→scene",
    ]);
  });
  it("显式传 enabled 能覆盖 layer.effects[e].enabled", () => {
    const effects = [off(effect([draw()])), effect([draw()])];
    const opened = planLayer(layer({ effects }), textures, () => true);
    expect(kinds(opened.steps)).toEqual(["base→c0", "effect→c1", "final→scene"]);
    const closed = planLayer(layer({ effects }), textures, () => false);
    expect(kinds(closed.steps)).toEqual(["direct→scene"]);
    expect(needsComposite({ effects: [off(effect([]))], colorBlendMode: 0 }, () => true)).toBe(true);
  });
  it("planSignature：步骤或合成 RT 数变化时变，关掉一个没有步骤的 effect 时不变", () => {
    const signature = (effects: SceneEffect[]) => planSignature(planLayer(layer({ effects }), textures));
    const a = effect([draw({ pass: pass({ key: "e0" }) })]);
    const b = effect([draw({ pass: pass({ key: "e1" }) })]);
    expect(signature([a, b])).toBe(signature([a, b]));
    // 合成 RT 2 → 1
    expect(signature([a, off(b)])).not.toBe(signature([a, b]));
    // 张数相同（都是 1）、上屏的 pass 不同
    expect(signature([a, off(b)])).not.toBe(signature([off(a), b]));
    // 全关 → 直接上屏
    expect(signature([off(a), off(b)])).not.toBe(signature([a, off(b)]));
    const empty = effect([]);
    expect(signature([a, off(empty)])).toBe(signature([a, empty]));
  });
});

describe("可变 effect 的计划枚举（3c）", () => {
  /** 每个 pass 一个程序，键才分得开；`source` 故意和 `layer.effects` 下标不同。 */
  const step = (program: number, partial: Partial<Extract<SceneEffectStep, { kind: "draw" }>> = {}) =>
    draw({ pass: pass({ key: `p${program}`, program, blending: program % 2 ? "additive" : "normal" }), ...partial });
  const open = (steps: SceneEffectStep[], fbos: SceneFbo[] = []): SceneEffect => ({
    ...effect(steps, fbos),
    source: 7,
    enabled: false,
    visibleBound: true,
  });
  const fixed = (steps: SceneEffectStep[]): SceneEffect => effect(steps);
  const blocked = (enabled: boolean, steps: SceneEffectStep[]): SceneEffect => ({
    ...open(steps),
    enabled,
    unsupported: ["effect:custom:custom"],
  });
  const passthrough = pass({ key: "pt", program: 90, blending: "translucent" });

  const keyOf = (item: DrawStep) =>
    pipelineKey(stepPipeline(item, "rgba8unorm", (_e, name) => (name.endsWith("_float") ? "rgba16float" : "r8unorm")));
  const keysOf = (plans: LayerPlan[]) => new Set(plans.flatMap((plan) => draws(plan.steps).map(keyOf)));
  const isVariable = (item: SceneEffect) => item.visibleBound && (item.enabled || !item.unsupported.length);

  /** 全部开关组合：可变的逐位枚举，其余取 bundle 里的 `enabled`。 */
  function combos(target: SceneLayer): ((e: number) => boolean)[] {
    const variable = target.effects.flatMap((item, e) => (isVariable(item) ? [e] : []));
    return Array.from({ length: 1 << variable.length }, (_, bits) => (e: number) => {
      const at = variable.indexOf(e);
      return at < 0 ? target.effects[e].enabled : ((bits >> at) & 1) === 1;
    });
  }

  const cases: [string, Partial<SceneLayer>, number][] = [
    ["两个可变", { effects: [open([step(1)]), open([step(2)])] }, 2],
    ["三个可变、多 pass", { effects: [open([step(1), step(2)]), open([step(3)]), open([step(4), step(5)])] }, 3],
    ["固定开着的夹在中间", { effects: [open([step(1)]), fixed([step(2)]), open([step(3)])] }, 2],
    ["固定开着的在最后：可变的都不上屏", { effects: [open([step(1)]), open([step(2)]), fixed([step(3)])] }, 2],
    ["固定开着的在最前", { effects: [fixed([step(1)]), open([step(2)]), open([step(3)])] }, 2],
    ["没有绘制 pass 的 effect", { effects: [open([step(1)]), open([]), open([step(2)])] }, 3],
    [
      "只有 copy / swap 的 effect",
      {
        effects: [
          open([step(1)]),
          open(
            [
              { kind: "copy", source: "previous", target: "x" },
              { kind: "swap", source: "x", target: "y" },
            ],
            [fbo("x"), fbo("y")],
          ),
          open([step(2)]),
        ],
      },
      3,
    ],
    [
      "fbo 目标：格式不同，compose 不写 fbo",
      {
        effects: [
          open([step(1, { target: "a_float" }), step(2, { binds: [{ name: "a_float", index: 0 }] })], [fbo("a_float")]),
          open([step(3, { target: "b" }), step(4, { target: "b", compose: true })], [fbo("b")]),
          open([step(5, { target: "c" })], [fbo("c")]),
        ],
      },
      3,
    ],
    ["colorBlendMode 31", { colorBlendMode: 31, effects: [open([step(1)]), open([step(2)])] }, 2],
    [
      "passthrough",
      { colorBlendMode: 11, passthrough, effects: [open([step(1)]), open([step(2)]), open([step(3)])] },
      3,
    ],
    [
      "带不支持项：关着的不算可变，开着的（dev 强制渲染）能就地关，算可变",
      { effects: [open([step(1)]), blocked(false, [step(2)]), blocked(true, [step(3)]), open([step(4)])] },
      3,
    ],
    [
      "四个可变，混固定、fbo 与空 effect",
      {
        effects: [
          open([step(1)]),
          fixed([step(2)]),
          open([step(3, { target: "a" }), step(4)], [fbo("a")]),
          open([]),
          open([step(5)]),
        ],
      },
      4,
    ],
  ];

  it.each(cases)("%s：全部组合的管线键都在并集里，共 n + 2 份计划", (_name, partial, variable) => {
    const target = layer(partial);
    const plans = variantPlans(target, textures);
    expect(plans).toHaveLength(variable + 2);
    const union = keysOf(plans);
    let checked = 0;
    for (const enabled of combos(target)) {
      const plan = planLayer(target, textures, enabled);
      // 全部开着的 effect 都没有绘制 pass：整场加载同样画不了
      if (plan.reasons.includes("render:no-final-pass")) continue;
      expect(plan.reasons).toEqual([]);
      for (const key of keysOf([plan])) expect(union).toContain(key);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(1 << (variable - 1));
  });

  it("全开加全关不够：缺「某个可变 effect 开、后面全关」就漏掉它的上屏角色", () => {
    const target = layer({ effects: [open([step(1)]), open([step(2)])] });
    const [allOn, allOff] = variantPlans(target, textures);
    const middle = planLayer(target, textures, (e) => e === 0);
    expect(draws(middle.steps).at(-1)).toMatchObject({ role: "final", effect: 0 });
    const partial = keysOf([allOn, allOff]);
    expect([...keysOf([middle])].some((key) => !partial.has(key))).toBe(true);
  });

  it("没有可变 effect 时为空", () => {
    expect(variantPlans(layer(), textures)).toEqual([]);
    expect(variantPlans(layer({ effects: [fixed([step(1)])] }), textures)).toEqual([]);
    expect(variantPlans(layer({ effects: [blocked(false, [step(1)])] }), textures)).toEqual([]);
  });

  it("带不支持项且关着的 effect 不进任何一份计划", () => {
    const target = layer({ effects: [open([step(1)]), blocked(false, [step(2)])] });
    const plans = variantPlans(target, textures);
    expect(plans.flatMap((plan) => draws(plan.steps).map((item) => item.pass.program))).not.toContain(2);
  });

  it("FboBindings.initial 不随 swap 变", () => {
    const bindings = new FboBindings([
      new Map([
        ["a", 10],
        ["b", 11],
      ]),
    ]);
    bindings.swap(0, "a", "b");
    expect(bindings.resolve(0, "a")).toBe(11);
    expect(bindings.initial(0, "a")).toBe(10);
    expect(bindings.initial(0, "b")).toBe(11);
    expect(() => bindings.initial(0, "c")).toThrow();
  });
});

describe("上传的纹理（3c）", () => {
  const textured = (index: number) => draw({ pass: pass({ textures: { 1: index } }) });
  const sorted = (values: Set<number>) => [...values].sort((a, b) => a - b);
  it("只被关着且带不支持项的 effect 用到的不上传；关着但没有不支持项的上传（打开时要用）", () => {
    const blocked = { ...effect([textured(2)]), enabled: false, unsupported: ["tex:video"] };
    const closed = { ...effect([textured(3)]), enabled: false };
    const open = effect([textured(4)]);
    const passthrough = pass({ textures: { 0: 5 } });
    const bundle = { layers: [layer({ effects: [blocked, closed, open], passthrough })] };
    expect(sorted(uploadableTextures(bundle))).toEqual([0, 3, 4, 5]);
  });
  it("同时被启用的 effect 用到时照常上传", () => {
    const blocked = { ...effect([textured(2)]), enabled: false, unsupported: ["tex:video"] };
    expect(sorted(uploadableTextures({ layers: [layer({ effects: [blocked, effect([textured(2)])] })] }))).toEqual([
      0, 2,
    ]);
  });
  it("没有 effect 用到的（如关着的 effect 编译到一半出错留下的）不上传", () => {
    expect(sorted(uploadableTextures({ layers: [layer()] }))).toEqual([0]);
  });
});

describe("效果矩阵", () => {
  const vp = new Float32Array([2 / 400, 0, 0, 0, 0, 2 / 200, 0, 0, 0, 0, -1, 0, -1, -1, 0, 1]);
  /** 根图层：世界矩阵就是本地矩阵。 */
  const matrices = (role: DrawStep["role"]) => drawMatrices({ role }, layerLocalMatrix(layer()), layer().size, vp);
  it("effect pass：MVP 单位阵，效果 MVP 把 NDC 四边形摆回图层在场景里的位置", () => {
    const m = matrices("effect");
    expect(Array.from(m.modelViewProjection)).toEqual(
      Array.from(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])),
    );
    // NDC 右上角 (1, 1) → 图层右上角 (200, 100) → 场景 400×200 里的 NDC (0, 0)
    const [x, y] = transformPoint(m.effectModelViewProjection!, 1, 1, 0);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(0);
    expect(m.effectTextureProjection).toEqual(m.effectModelViewProjection);
  });
  it("上屏 pass：效果矩阵不缩放，纹理投影 = MVP × scale(w/2, h/2)", () => {
    const m = matrices("final");
    expect(m.effectModelViewProjection).toEqual(m.modelViewProjection);
    const [x, y] = transformPoint(m.effectTextureProjection!, 1, 1, 0);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(0);
  });
  it("基础 pass：正交投影把图层四边形画满目标", () => {
    const m = matrices("base");
    const [x, y] = transformPoint(m.modelViewProjection, 100, -50, 0);
    expect(x).toBeCloseTo(1, 6);
    expect(y).toBeCloseTo(-1, 6);
  });
});
