import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HDR_BLOOM_MATERIALS, type BloomPassName, type SceneBloom } from "../compile/bloom";
import type { SceneBundle, ScenePass } from "../compile/bundle";
import { BLOOM_DEFAULTS, type BloomParams } from "../compile/postprocess";
import type { TranslateResult } from "../wpesl2wgsl";
import {
  BloomChain,
  bloomIterations,
  bloomLevels,
  bloomTargetSize,
  hdrBloomConstants,
  planBloom,
  type BloomPlan,
  type BloomSource,
  type BloomStep,
} from "./bloom";
import type { GpuProgram } from "./programs";
import { checkRenderable } from "./scene";
import type { UniformEntry } from "./uniforms";

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

describe("BloomChain：建满金字塔、绘制按步骤身份去重", () => {
  const HDR_PASSES: BloomPassName[] = ["downsampleBloom", "downsample", "upsample", "upsampleCubic", "combine"];
  const LDR_PASSES: BloomPassName[] = ["quarter", "eighth", "blur", "combine"];
  const UNIFORMS: UniformEntry[] = [
    { name: "g_RenderVar0", type: "vec4<f32>", offset: 0, size: 16 },
    { name: "g_Strength", type: "vec2<f32>", offset: 16, size: 8, meta: { material: "bloomstrength" } },
    { name: "g_Blend", type: "vec4<f32>", offset: 32, size: 16, meta: { material: "blend" } },
    { name: "g_Tint", type: "vec3<f32>", offset: 48, size: 12, meta: { material: "bloomtint" } },
    { name: "g_Scatter", type: "f32", offset: 60, size: 4, meta: { material: "scatter" } },
  ];
  interface FakeBuffer {
    usage: number;
    bytes: Uint8Array;
  }
  interface FakeGroup {
    entries: { binding: number; resource: { buffer?: FakeBuffer; label?: string } }[];
  }

  function chainInput(
    names: BloomPassName[],
    hdr: boolean,
    partial: Partial<BloomParams>,
    width: number,
    height: number,
  ) {
    const textures: string[] = [];
    const groups: FakeGroup[] = [];
    const device = {
      createTexture: (descriptor: GPUTextureDescriptor) => {
        textures.push(descriptor.label!);
        return { createView: () => ({ label: descriptor.label }) };
      },
      createSampler: () => ({}),
      createBuffer: (descriptor: GPUBufferDescriptor) => ({
        usage: descriptor.usage,
        bytes: new Uint8Array(descriptor.size),
      }),
      createBindGroup: (descriptor: FakeGroup) => {
        groups.push(descriptor);
        return descriptor;
      },
      queue: {
        writeBuffer: (buffer: FakeBuffer, _offset: number, data: ArrayBuffer) => {
          buffer.bytes = new Uint8Array(data.slice(0));
        },
      },
    } as unknown as GPUDevice;
    const pass = (name: BloomPassName, program: number): ScenePass => ({
      key: `bloom/${name}`,
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
    const bloom: SceneBloom = {
      hdr,
      passes: Object.fromEntries(names.map((name, index) => [name, pass(name, index)])),
    };
    const program = (name: BloomPassName, index: number) =>
      ({
        index,
        result: { ok: true, uniforms: UNIFORMS, uniformBlockSize: 64 },
        vertexPacking: { pack: () => new ArrayBuffer(0) },
        textures: (name === "combine" ? [0, 1] : [0]).map((slot) => ({
          slot,
          binding: 1 + 2 * slot,
          samplerBinding: 2 + 2 * slot,
          kind: "2d",
        })),
        uniformSize: 64,
      }) as unknown as GpuProgram;
    return {
      textures,
      groups,
      input: {
        device,
        bloom,
        params: params(partial),
        programs: new Map(names.map((name, index) => [index, program(name, index)])),
        format: "rgba16float" as GPUTextureFormat,
        width,
        height,
        source: { label: "snapshot" } as unknown as GPUTextureView,
        pipelineFor: async (item: GpuProgram, blending: string | null) =>
          ({ label: `${names[item.index]} ${blending}` }) as unknown as GPURenderPipeline,
        own: <T>(resource: T) => resource,
      },
    };
  }

  /** 一步里 uniform 块的内容：不写的字段保持 0（同一身份的步骤写的字段相同，不会留下别的级数的值）。 */
  const uniformOf = ({ renderVar0, constants }: BloomStep) => ({
    renderVar0: renderVar0 ?? [0, 0, 0, 0],
    // LDR 的 bloomstrength 是一个分量，假布局按 vec2 排
    strength: [...(constants.bloomstrength ?? []), 0, 0].slice(0, 2),
    blend: constants.blend ?? [0, 0, 0, 0],
    tint: constants.bloomtint ?? [0, 0, 0],
    scatter: constants.scatter ?? [0],
  });
  const readUniform = (buffer: FakeBuffer) => {
    const values = [...new Float32Array(buffer.bytes.slice().buffer)];
    return {
      renderVar0: values.slice(0, 4),
      strength: values.slice(4, 6),
      blend: values.slice(8, 12),
      tint: values.slice(12, 15),
      scatter: values.slice(15, 16),
    };
  };

  /** 编码一遍，返回轨迹：每步一个 render pass 的目标、管线、输入与 uniform，外加 `after` 收到的步骤。 */
  function encode(chain: BloomChain) {
    const trace: unknown[] = [];
    const bytes: Uint8Array[] = [];
    const steps: BloomStep[] = [];
    const encoder = {
      beginRenderPass: (descriptor: GPURenderPassDescriptor) => {
        const attachment = [...descriptor.colorAttachments][0]!;
        const entry = {
          target: (attachment.view as unknown as { label: string }).label,
          load: attachment.loadOp,
          pipeline: "",
          inputs: [] as string[],
          uniform: null as ReturnType<typeof readUniform> | null,
          draws: 0,
        };
        trace.push(entry);
        return {
          setPipeline: (pipeline: { label: string }) => (entry.pipeline = pipeline.label),
          setBindGroup(_index: number, group: FakeGroup) {
            for (const { binding, resource } of group.entries) {
              if (resource.buffer) {
                entry.uniform = readUniform(resource.buffer);
                bytes.push(resource.buffer.bytes);
              } else if (binding % 2 === 1) entry.inputs.push(resource.label!);
            }
          },
          setVertexBuffer() {},
          draw: () => entry.draws++,
          end() {},
        };
      },
    } as unknown as GPUCommandEncoder;
    chain.encode(encoder, { label: "scene" } as unknown as GPUTextureView, (_index, step) => steps.push(step));
    return { trace, bytes, steps };
  }

  /** 按计划独立推出的编码轨迹，不经过 `BloomChain`。 */
  function expectedTrace(plan: BloomPlan) {
    const label = (source: BloomSource) =>
      source.kind === "framebuffer" ? "snapshot" : plan.targets[source.index].name;
    return plan.steps.map((step) => ({
      target: step.target.kind === "scene" ? "scene" : plan.targets[step.target.index].name,
      load: "load",
      pipeline: `${step.pass} ${step.additive ? "additive" : null}`,
      inputs: step.inputs.map(label),
      uniform: uniformOf(step),
      draws: 1,
    }));
  }

  const hdrChain = (partial: Partial<BloomParams> = {}, width = 3840, height = 2160) => {
    const setup = chainInput(HDR_PASSES, true, partial, width, height);
    return BloomChain.create(setup.input).then((chain) => ({ ...setup, chain }));
  };

  beforeEach(() => {
    vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_SRC: 4 });
    vi.stubGlobal("GPUBufferUsage", { VERTEX: 1, UNIFORM: 2, COPY_DST: 4 });
  });
  afterEach(() => vi.unstubAllGlobals());

  const TUNED: Partial<BloomParams> = { hdrStrength: 3, hdrThreshold: 0.7, hdrScatter: 1.3, tint: [1, 0.5, 0.25] };
  const LEVELS = [1, 2, 3, 4, 5, 6, 7, 8];

  it.each(LEVELS)("建好后改到 N = %i：步骤序列、常量、编码轨迹和按 N 规划的逐项相同", async (levels) => {
    const { chain } = await hdrChain();
    const partial = { ...TUNED, hdrIterations: levels };
    chain.setParams(params(partial));
    const plan = planBloom(true, params(partial), 3840, 2160);
    expect(chain.plan).toEqual(plan);
    const { trace, steps } = encode(chain);
    expect(steps).toEqual(plan.steps);
    expect(trace).toEqual(expectedTrace(plan));
  });

  it.each(LEVELS)("建链时就是 N = %i：编码轨迹同样按 N", async (levels) => {
    const { chain } = await hdrChain({ ...TUNED, hdrIterations: levels });
    const plan = planBloom(true, params({ ...TUNED, hdrIterations: levels }), 3840, 2160);
    expect(chain.plan).toEqual(plan);
    expect(encode(chain).trace).toEqual(expectedTrace(plan));
  });

  it("8 → 5 → 8 回到原字节", async () => {
    const { chain } = await hdrChain(TUNED);
    const before = encode(chain).bytes.map((bytes) => [...bytes]);
    chain.setParams(params({ ...TUNED, hdrIterations: 5 }));
    expect(encode(chain).bytes.map((bytes) => [...bytes])).not.toEqual(before);
    chain.setParams(params(TUNED));
    expect(encode(chain).bytes.map((bytes) => [...bytes])).toEqual(before);
  });

  it.each([8, 3])("绘制 21 个、RT 8 张，不随当前级数变（hdrIterations %i）", async (hdrIterations) => {
    const { chain, textures, groups } = await hdrChain({ hdrIterations });
    expect(groups).toHaveLength(21);
    expect(textures).toHaveLength(8);
    expect(chain.targets).toHaveLength(8);
    expect(chain.plan.levels).toBe(hdrIterations);
    expect(chain.plan.targets).toHaveLength(hdrIterations);
    // RT 下标与按 N 规划的相同，显存按全部级算
    expect(chain.targets.map((target) => target.name)).toEqual(
      planBloom(true, params(), 3840, 2160).targets.map((target) => target.name),
    );
    expect(chain.bytes).toBe(chain.targets.reduce((sum, { width, height }) => sum + width * height * 8, 0));
  });

  it("LDR：4 个绘制、3 张 RT，编码轨迹同 planBloom", async () => {
    const setup = chainInput(LDR_PASSES, false, {}, 1920, 1080);
    const chain = await BloomChain.create(setup.input);
    expect(setup.groups).toHaveLength(4);
    expect(setup.textures).toHaveLength(3);
    const plan = planBloom(false, params(), 1920, 1080);
    expect(chain.plan).toEqual(plan);
    expect(encode(chain).trace).toEqual(expectedTrace(plan));
  });

  it.each([
    [16, 8, 3, 6],
    [2, 2, 1, 2],
    [1, 1, 1, 2],
  ])("可用级数不足（%i×%i）：RT 只建 %i 张，超范围的级数不越界", async (width, height, levels, draws) => {
    const { chain, textures, groups } = await hdrChain({}, width, height);
    expect(textures).toHaveLength(levels);
    expect(groups).toHaveLength(draws);
    expect(chain.plan.levels).toBe(levels);
    for (const hdrIterations of [1, 2, 3, 8, 100, 0, -3]) {
      const partial = { hdrIterations };
      chain.setParams(params(partial));
      const plan = planBloom(true, params(partial), width, height);
      expect(encode(chain).trace).toEqual(expectedTrace(plan));
    }
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
      postprocess: { level: "ultra", bloomFlag: true, hdrFlag: true, bloom: true, hdr: true },
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
