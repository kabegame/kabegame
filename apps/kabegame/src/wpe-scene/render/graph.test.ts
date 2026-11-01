import { describe, expect, it, vi } from "vitest";
import type { SceneEffect, SceneEffectStep, SceneFbo, SceneLayer, ScenePass, SceneTexture } from "../compile/bundle";
import { compositeSize, FboBindings, fboSize, planLayer, type DrawStep, type LayerStep } from "./graph";
import { transformPoint } from "./math";
import { drawMatrices } from "./scene";

vi.mock("@/utils/fileUrl", () => ({ fileToUrl: (path: string) => path }));

function pass(partial: Partial<ScenePass> = {}): ScenePass {
  return {
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
  return { id: 1, name: "", file: "effects/x/effect.json", fbos, steps };
}
function layer(partial: Partial<SceneLayer> = {}): SceneLayer {
  return {
    id: 7,
    name: "l",
    origin: [100, 50, 0],
    scale: [1, 1, 1],
    angles: [0, 0, 0],
    size: [200, 100],
    alpha: 1,
    color: [1, 1, 1],
    visible: true,
    passes: [pass({ blending: "translucent", textures: { 0: 0 } })],
    colorBlendMode: 0,
    effects: [],
    passthrough: null,
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
    expect(compositeSize({ size: [2, 300] }, undefined)).toEqual([4, 300]);
    expect(compositeSize({ size: [2, 300] }, textures[0])).toEqual([219, 216]);
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

describe("效果矩阵", () => {
  const vp = new Float32Array([2 / 400, 0, 0, 0, 0, 2 / 200, 0, 0, 0, 0, -1, 0, -1, -1, 0, 1]);
  it("effect pass：MVP 单位阵，效果 MVP 把 NDC 四边形摆回图层在场景里的位置", () => {
    const m = drawMatrices({ role: "effect" }, layer(), vp);
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
    const m = drawMatrices({ role: "final" }, layer(), vp);
    expect(m.effectModelViewProjection).toEqual(m.modelViewProjection);
    const [x, y] = transformPoint(m.effectTextureProjection!, 1, 1, 0);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(0);
  });
  it("基础 pass：正交投影把图层四边形画满目标", () => {
    const m = drawMatrices({ role: "base" }, layer(), vp);
    const [x, y] = transformPoint(m.modelViewProjection, 100, -50, 0);
    expect(x).toBeCloseTo(1, 6);
    expect(y).toBeCloseTo(-1, 6);
  });
});
