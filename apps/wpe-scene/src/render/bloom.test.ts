import { describe, expect, it } from "vitest";
import { HDR_BLOOM_MATERIALS } from "../compile/bloom";
import type { SceneBundle, ScenePass } from "../compile/bundle";
import { BLOOM_DEFAULTS, type BloomParams } from "../compile/postprocess";
import type { TranslateResult } from "../wpesl2wgsl";
import { bloomIterations, bloomLevels, bloomTargetSize, hdrBloomConstants, planBloom } from "./bloom";
import { checkRenderable } from "./scene";

const f = Math.fround;
const params = (partial: Partial<BloomParams> = {}): BloomParams => ({
  ...BLOOM_DEFAULTS,
  tint: [...BLOOM_DEFAULTS.tint],
  ...partial,
});

describe("HDR 金字塔", () => {
  it("可用级数：min(w, h) 逐次减半仍 ≥ 1 的次数，最多 8", () => {
    expect(bloomLevels(3840, 2160)).toBe(8);
    expect(bloomLevels(1920, 1080)).toBe(8);
    expect(bloomLevels(5760, 1080)).toBe(8);
    expect(bloomLevels(100, 100)).toBe(6); // 50 25 12 6 3 1
    expect(bloomLevels(256, 255)).toBe(7); // 127 63 31 15 7 3 1 0
    expect(bloomLevels(3, 5)).toBe(1);
    expect(bloomLevels(1, 1)).toBe(0);
  });
  it("级数 N = min(iterations, 可用级数)，至少 1", () => {
    expect(bloomIterations(8, 8)).toBe(8);
    expect(bloomIterations(3, 8)).toBe(3);
    expect(bloomIterations(10, 5)).toBe(5);
    expect(bloomIterations(0, 8)).toBe(1);
    expect(bloomIterations(-2, 8)).toBe(1);
  });
  it("RT 尺寸向下取整、至少 2（L7 在 4K 上是 15×8）", () => {
    expect(bloomTargetSize(3840, 2160, 2)).toEqual([1920, 1080]);
    expect(bloomTargetSize(3840, 2160, 64)).toEqual([60, 33]);
    expect(bloomTargetSize(3840, 2160, 256)).toEqual([15, 8]);
    expect(bloomTargetSize(100, 3, 8)).toEqual([12, 2]);
  });
});

describe("HDR 参数换算（与 RenderDoc 抓帧的常量逐位比较）", () => {
  it("bedroom：strength 2.5、scatter 1.62、threshold 1、feather 0.1，N = 8", () => {
    const c = hdrBloomConstants(
      params({ hdrStrength: 2.5, hdrScatter: f(1.62), hdrThreshold: 1, hdrFeather: f(0.1) }),
      8,
    );
    expect(c.bloomstrength[0]).toBe(0.1310582309961319);
    expect(c.bloomstrength[1]).toBe(f(1.62));
    expect(c.blend).toEqual([1, 0.8999999761581421, 0.20000000298023224, 2.4997501373291016]);
    expect(c.scatter).toEqual([f(1.62)]);
    expect(c.bloomtint).toEqual([1, 1, 1]);
  });
  it("shimmering_particles：feather 0 时 knee 为 0，blend.w = 0.25 / 1e−5", () => {
    const c = hdrBloomConstants(
      params({ hdrStrength: 2, hdrScatter: f(1.13), hdrThreshold: f(0.7), hdrFeather: 0 }),
      8,
    );
    expect(c.bloomstrength[0]).toBe(0.6489394307136536);
    expect(c.blend).toEqual([0.699999988079071, 0.699999988079071, 0, 25000]);
  });
  it("工坊 3286859278：strength 5、scatter 1.6", () => {
    const c = hdrBloomConstants(params({ hdrStrength: 5, hdrScatter: f(1.6), hdrThreshold: 1, hdrFeather: f(0.1) }), 8);
    expect(c.bloomstrength[0]).toBe(0.28125885128974915);
  });
  it("iterations 少于可用级数：归一化用 N；N ≤ 2 时 scatter 的指数为 0", () => {
    const p = params({ hdrStrength: 3, hdrScatter: 2 });
    expect(hdrBloomConstants(p, 3).bloomstrength[0]).toBe(f(3 / (1 + 2)));
    expect(hdrBloomConstants(p, 2).bloomstrength[0]).toBe(f(3 / 2));
    expect(hdrBloomConstants(p, 1).bloomstrength[0]).toBe(f(3 / 2));
  });
});

describe("泛光渲染图", () => {
  it("LDR：快照 → 1/4 → 1/8 → _rt_Bloom → combine，参数原值写进第一个下采样材质", () => {
    const plan = planBloom(false, params({ strength: 0.5, threshold: 0.36, tint: [1, 0.5, 0] }), 3840, 2160);
    expect(plan.targets).toEqual([
      { name: "_rt_4FrameBuffer", width: 960, height: 540 },
      { name: "_rt_8FrameBuffer", width: 480, height: 270 },
      { name: "_rt_Bloom", width: 480, height: 270 },
    ]);
    expect(plan.steps.map((s) => s.pass)).toEqual(["quarter", "eighth", "blur", "combine"]);
    expect(plan.steps.map((s) => s.inputs)).toEqual([
      [{ kind: "framebuffer" }],
      [{ kind: "target", index: 0 }],
      [{ kind: "target", index: 1 }],
      [{ kind: "framebuffer" }, { kind: "target", index: 2 }],
    ]);
    expect(plan.steps.map((s) => s.target)).toEqual([
      { kind: "target", index: 0 },
      { kind: "target", index: 1 },
      { kind: "target", index: 2 },
      { kind: "scene" },
    ]);
    expect(plan.steps[0].constants).toEqual({
      bloomstrength: [0.5],
      bloomthreshold: [0.36],
      bloomtint: [1, 0.5, 0],
    });
    expect(plan.steps.every((s) => !s.additive && s.renderVar0 === null)).toBe(true);
    expect(plan.result).toBe(2);
  });
  it("LDR：小场景的 RT 至少 2", () => {
    expect(planBloom(false, params(), 6, 6).targets.map((t) => [t.width, t.height])).toEqual([
      [2, 2],
      [2, 2],
      [2, 2],
    ]);
  });
  it("HDR 4K、默认 8 级：下采样 8 次、上采样 7 次（最粗两级 bicubic），RV0 用名义纹素", () => {
    const plan = planBloom(true, params(), 3840, 2160);
    expect(plan.levels).toBe(8);
    expect(plan.targets.map((t) => `${t.name} ${t.width}x${t.height}`)).toEqual([
      "_rt_2FrameBuffer 1920x1080",
      "_rt_4FrameBuffer 960x540",
      "_rt_8FrameBuffer 480x270",
      "_rt_16FrameBuffer 240x135",
      "_rt_32FrameBuffer 120x67",
      "_rt_64FrameBuffer 60x33",
      "_rt_128FrameBuffer 30x16",
      "_rt_256FrameBuffer 15x8",
    ]);
    expect(plan.steps.map((s) => s.pass)).toEqual([
      "downsampleBloom",
      ...Array(7).fill("downsample"),
      "upsampleCubic",
      "upsampleCubic",
      ...Array(5).fill("upsample"),
      "combine",
    ]);
    const [first] = plan.steps;
    expect(first.renderVar0).toEqual([f(1 / 3840), f(1 / 2160), -f(1 / 3840), -f(1 / 2160)]);
    // 第 i 步下采样读 L(i−1)，偏移是源的名义纹素 2^i / W
    expect(plan.steps[7]).toMatchObject({
      inputs: [{ kind: "target", index: 6 }],
      target: { kind: "target", index: 7 },
    });
    expect(plan.steps[7].renderVar0![0]).toBe(f(128 / 3840));
    // 第一个上采样：L7（15×8）→ L6，偏移是目标 L6 的名义纹素 128 / W（抓帧 event 910：128/3840、128/2160）
    const up = plan.steps[8];
    expect(up).toMatchObject({
      inputs: [{ kind: "target", index: 7 }],
      target: { kind: "target", index: 6 },
      additive: true,
    });
    expect(up.renderVar0).toEqual([f(128 / 3840), f(128 / 2160), -f(128 / 3840), -f(128 / 2160)]);
    // 第 3 个上采样（u = 5，不是 bicubic）：32 / W（抓帧 event 942）
    expect(plan.steps[10].pass).toBe("upsample");
    expect(plan.steps[10].renderVar0!.slice(0, 2)).toEqual([f(32 / 3840), f(32 / 2160)]);
    expect(plan.steps.filter((s) => s.pass.startsWith("upsample")).every((s) => s.constants.scatter)).toBe(true);
    const combine = plan.steps.at(-1)!;
    expect(combine).toMatchObject({
      inputs: [{ kind: "framebuffer" }, { kind: "target", index: 0 }],
      target: { kind: "scene" },
      additive: false,
    });
    expect(combine.renderVar0!.slice(0, 2)).toEqual([1, 1]);
    expect(plan.result).toBe(0);
  });
  it("HDR：iterations 3 时两次上采样都是 bicubic；iterations 1 只有阈值下采样与 combine", () => {
    expect(planBloom(true, params({ hdrIterations: 3 }), 3840, 2160).steps.map((s) => s.pass)).toEqual([
      "downsampleBloom",
      "downsample",
      "downsample",
      "upsampleCubic",
      "upsampleCubic",
      "combine",
    ]);
    const one = planBloom(true, params({ hdrIterations: 1 }), 3840, 2160);
    expect(one.steps.map((s) => s.pass)).toEqual(["downsampleBloom", "combine"]);
    expect(one.targets).toHaveLength(1);
  });
  it("HDR：级数受场景尺寸限制，强度按实际级数归一化", () => {
    const plan = planBloom(true, params({ hdrStrength: 2, hdrScatter: 2 }), 100, 60);
    expect(plan.levels).toBe(5); // 30 15 7 3 1
    expect(plan.targets.at(-1)).toMatchObject({ width: 3, height: 2 });
    expect(plan.steps[0].constants.bloomstrength[0]).toBe(f(2 / (1 + 2 ** 3)));
  });
});

describe("渲染器自查：泛光 pass", () => {
  const pass = (program: number | null): ScenePass => ({
    key: "bloom/test",
    program,
    blending: "normal",
    cullmode: "nocull",
    depthtest: "disabled",
    depthwrite: "disabled",
    textures: {},
    runtime: {},
    uniforms: {},
    framebuffer: false,
  });
  const bundle = (bloom: SceneBundle["bloom"]): SceneBundle => ({
    general: {
      width: 4,
      height: 4,
      clearColor: [0, 0, 0],
      clearEnabled: true,
      camera: { eye: [], center: [], up: [] },
      ambient: [0, 0, 0],
      skylight: [0, 0, 0],
      postprocess: { level: "ultra", bloom: true, hdr: true },
      bloom: params(),
    },
    layers: [],
    programs: [{ ok: true } as TranslateResult],
    textures: [],
    bloom,
    unsupported: [],
    bindings: [],
    scripts: { list: [] },
  });
  it("链上每个 pass 都要有程序，缺了报 render:bloom:<名字>", () => {
    const all = Object.fromEntries(Object.keys(HDR_BLOOM_MATERIALS).map((name) => [name, pass(0)]));
    expect(checkRenderable(bundle({ hdr: true, passes: all }), new Set())).toEqual([]);
    expect(checkRenderable(bundle({ hdr: true, passes: { ...all, upsampleCubic: pass(null) } }), new Set())).toEqual([
      "render:bloom:upsampleCubic",
    ]);
    const { combine: _, ...noCombine } = all;
    expect(checkRenderable(bundle({ hdr: true, passes: noCombine }), new Set())).toEqual(["render:bloom:combine"]);
    expect(checkRenderable(bundle(null), new Set())).toEqual([]);
  });
});
