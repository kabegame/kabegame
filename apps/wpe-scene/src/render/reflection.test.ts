/**
 * P13b1 的渲染侧单测（`.claude/plans/wpe-import/3-scene/phase13/phase-13b1-reflection-off.md`「点 4」「点 6」）：
 * - `mipLevelCountOf`：`max(1, min(log2(npot(w) / 2), log2(npot(h) / 2)) − 2)`（步骤 0 R7：1920×1080 → 8、1600×900 / 1280×720 → 7）；
 * - `ReflectionTargets`（假设备）：`_rt_Reflection` 场景目标尺寸、rgba8unorm（HDR 下也是）、每帧一次清屏 `(clearcolor, 1)`；
 *   `_rt_MipMappedFrameBuffer` 场景目标格式、各级只在建好时清 `(0, 0, 0, 1)` 一次；没有读者时不建；
 * - 渲染图：运行时名字 → 纹理来源的共用函数，模型、图像层 / 文本（`staticInputs`）、粒子、形状五处都认两张反射 RT，
 *   认不出的名字仍报 `render:texture-rt:<名>`；
 * - `GpuScene`：有读者时建、帧首清屏（`clearenabled: false` 照清、清屏色随 `state.general.clearcolor`），`g_Texture<n>Resolution` 是
 *   RT 尺寸、`g_Texture<n>MipMapInfo` 是 mip 数；没有反射的场景不建这两张、命令轨迹里没有这次清屏。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generalDefaults } from "../compile/bindings";
import {
  MIP_FRAMEBUFFER_RT,
  REFLECTION_RT,
  type SceneBundle,
  type SceneLayer,
  type ScenePass,
} from "../compile/bundle";
import { parseParticle, particleFov, type SceneParticle } from "../compile/particles";
import { BLOOM_DEFAULTS } from "../compile/postprocess";
import type { TranslateResult } from "../wpesl2wgsl";
import { planLayer, planModelLayer, planParticleLayer, planShapeLayer, type DrawStep } from "./graph";
import { mipDownsampleScale, mipLevelCountOf, mipSourceCoord256, ReflectionTargets } from "./reflection";
import { GpuScene } from "./scene";
import { SceneState } from "./state";
import type { FrameInput } from "./uniforms";

vi.mock("./device", () => ({ acquireGpu: vi.fn() }));
vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

// ———— 假设备 ————

interface FakeTexture {
  label: string;
  format: string;
  usage: number;
  size: { width: number; height: number };
  mipLevelCount: number;
  destroyed: boolean;
  destroy(): void;
}
interface FakeView {
  label: string;
  texture: FakeTexture;
  baseMipLevel: number;
}
interface FakeBuffer {
  label: string;
  usage: number;
  bytes: Uint8Array;
  destroy(): void;
}
interface PassRecord {
  label: string;
  view: FakeView;
  loadOp: string;
  clear: { r: number; g: number; b: number; a: number } | null;
  /** `setBindGroup` 依次设的 bind group（假设备的 bind group 就是它的描述）。 */
  bindGroups: { descriptor?: GPUBindGroupDescriptor }[];
  /** `draw` 的顶点数。 */
  draws: number[];
}
interface CopyRecord {
  source: string;
  destination: string;
  mipLevel: number;
  size: GPUExtent3DDict;
}

class FakeGpu {
  readonly textures: FakeTexture[] = [];
  readonly buffers: FakeBuffer[] = [];
  readonly passes: PassRecord[] = [];
  readonly copies: CopyRecord[] = [];
  submits = 0;
  readonly device: GPUDevice;

  constructor() {
    const renderPass = (record: PassRecord) => ({
      setViewport() {},
      setPipeline() {},
      setBindGroup(_index: number, group: { descriptor?: GPUBindGroupDescriptor }) {
        record.bindGroups.push(group);
      },
      setVertexBuffer() {},
      setIndexBuffer() {},
      draw(count: number) {
        record.draws.push(count);
      },
      drawIndexed() {},
      end() {},
    });
    this.device = {
      limits: { maxTextureDimension2D: 8192 },
      lost: new Promise(() => {}),
      destroy() {},
      createTexture: (descriptor: GPUTextureDescriptor) => {
        const size = descriptor.size as GPUExtent3DDict;
        const texture: FakeTexture = {
          label: descriptor.label ?? "",
          format: descriptor.format,
          usage: descriptor.usage,
          size: { width: size.width, height: size.height ?? 1 },
          mipLevelCount: descriptor.mipLevelCount ?? 1,
          destroyed: false,
          destroy() {
            texture.destroyed = true;
          },
        };
        this.textures.push(texture);
        return {
          ...texture,
          destroy: texture.destroy,
          createView: (view?: GPUTextureViewDescriptor): FakeView => ({
            label: texture.label,
            texture,
            baseMipLevel: view?.baseMipLevel ?? 0,
          }),
        };
      },
      createSampler: (descriptor?: GPUSamplerDescriptor) => ({ descriptor }),
      createBuffer: (descriptor: GPUBufferDescriptor) => {
        const buffer: FakeBuffer = {
          label: descriptor.label ?? "",
          usage: descriptor.usage,
          bytes: new Uint8Array(descriptor.size),
          destroy() {},
        };
        this.buffers.push(buffer);
        return buffer;
      },
      createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
      createRenderPipelineAsync: async () => ({}),
      createBindGroup: (descriptor: GPUBindGroupDescriptor) => ({ descriptor }),
      createCommandEncoder: () => ({
        beginRenderPass: (descriptor: GPURenderPassDescriptor) => {
          const color = [...descriptor.colorAttachments][0]!;
          const value = color.clearValue as GPUColorDict | undefined;
          const record: PassRecord = {
            label: descriptor.label ?? "",
            view: color.view as unknown as FakeView,
            loadOp: color.loadOp,
            clear: value ? { r: value.r, g: value.g, b: value.b, a: value.a } : null,
            bindGroups: [],
            draws: [],
          };
          this.passes.push(record);
          return renderPass(record);
        },
        copyTextureToTexture: (
          source: GPUTexelCopyTextureInfo,
          destination: GPUTexelCopyTextureInfo,
          size: GPUExtent3DDict,
        ) => {
          this.copies.push({
            source: (source.texture as unknown as FakeTexture).label,
            destination: (destination.texture as unknown as FakeTexture).label,
            mipLevel: destination.mipLevel ?? 0,
            size,
          });
        },
        copyTextureToBuffer() {},
        finish: () => ({}),
      }),
      queue: {
        writeBuffer: (
          buffer: FakeBuffer,
          offset: number,
          data: ArrayBuffer | ArrayBufferView,
          dataOffset = 0,
          size?: number,
        ) => {
          if (ArrayBuffer.isView(data)) {
            // 类型化数组：偏移与长度按元素计（同 WebGPU）
            const element = "BYTES_PER_ELEMENT" in data ? (data.BYTES_PER_ELEMENT as number) : 1;
            const start = data.byteOffset + dataOffset * element;
            const length = size !== undefined ? size * element : data.byteLength - dataOffset * element;
            buffer.bytes.set(new Uint8Array(data.buffer, start, length), offset);
            return;
          }
          buffer.bytes.set(new Uint8Array(data, dataOffset, size ?? data.byteLength - dataOffset), offset);
        },
        writeTexture() {},
        submit: () => {
          this.submits++;
        },
        onSubmittedWorkDone: async () => {},
      },
      pushErrorScope() {},
      popErrorScope: async () => null,
    } as unknown as GPUDevice;
  }

  /** 编码一帧，返回这一帧的 render pass 记录。 */
  encode(scene: GpuScene, state: SceneState): PassRecord[] {
    this.passes.length = 0;
    this.copies.length = 0;
    scene.encode(this.device.createCommandEncoder(), state);
    return [...this.passes];
  }
  texturesOf(label: string): FakeTexture[] {
    return this.textures.filter((texture) => texture.label === label);
  }
}

beforeEach(() => {
  vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4, COPY_SRC: 1, COPY_DST: 2 });
  vi.stubGlobal("GPUBufferUsage", { VERTEX: 32, UNIFORM: 64, COPY_DST: 8, MAP_READ: 1, INDEX: 16 });
  vi.stubGlobal("GPUMapMode", { READ: 1 });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ———— mip 级数 ————

describe("mipLevelCountOf（步骤 0 R7）", () => {
  it.each([
    [1920, 1080, 8],
    [1600, 900, 7],
    [1280, 720, 7],
    [3840, 2160, 9],
    [1024, 1024, 7],
    // 小尺寸至少 1 级
    [4, 4, 1],
    [8, 8, 1],
    [16, 16, 1],
    [32, 16, 1],
    [1, 1, 1],
  ])("%i × %i → %i 级", (width, height, levels) => {
    expect(mipLevelCountOf(width, height)).toBe(levels);
  });
});

// ———— ReflectionTargets ————

describe("ReflectionTargets", () => {
  it("没有读者（bundle 里没有 reflection / mipFramebuffer）时不建、不提交命令", () => {
    const gpu = new FakeGpu();
    expect(ReflectionTargets.create(gpu.device, {}, 1920, 1080, false)).toBeNull();
    expect(ReflectionTargets.create(gpu.device, { reflection: { planar: false } }, 1920, 1080, false)).toBeNull();
    expect(gpu.textures).toEqual([]);
    expect(gpu.submits).toBe(0);
  });

  it("_rt_Reflection：场景目标尺寸、rgba8unorm、1 级 mip、Clamp + Linear；HDR 下仍是 rgba8unorm；不建 mip 帧缓冲", () => {
    for (const hdr of [false, true]) {
      const gpu = new FakeGpu();
      const targets = ReflectionTargets.create(gpu.device, { reflection: { planar: true } }, 1920, 1080, hdr)!;
      expect(gpu.textures).toHaveLength(1);
      expect(gpu.textures[0]).toMatchObject({
        label: "_rt_Reflection",
        format: "rgba8unorm",
        size: { width: 1920, height: 1080 },
        mipLevelCount: 1,
      });
      expect(gpu.textures[0].usage & GPUTextureUsage.RENDER_ATTACHMENT).toBeTruthy();
      expect(gpu.textures[0].usage & GPUTextureUsage.TEXTURE_BINDING).toBeTruthy();
      expect(targets.reflection).toMatchObject({ width: 1920, height: 1080, format: "rgba8unorm" });
      expect(targets.reflection!.sampler).toEqual({
        descriptor: {
          addressModeU: "clamp-to-edge",
          addressModeV: "clamp-to-edge",
          magFilter: "linear",
          minFilter: "linear",
        },
      });
      expect(targets.mipFramebuffer).toBeNull();
      expect(targets.bytes).toBe(1920 * 1080 * 4);
      // 建的时候不清、不提交：反射图每帧清，只有 mip 帧缓冲建好时清一次
      expect(gpu.submits).toBe(0);
    }
  });

  it("encode：每帧一次清屏 (clearcolor, 1)，只画这张 RT；HDR 的大于 1 的清屏色原样交给 GPU（unorm 上钳）", () => {
    const gpu = new FakeGpu();
    const targets = ReflectionTargets.create(gpu.device, { reflection: { planar: true } }, 64, 32, true)!;
    const encoder = gpu.device.createCommandEncoder();
    targets.encode(encoder, [0.2, 0.4, 0.6]);
    targets.encode(encoder, [2, 0.5, 0.25]);
    expect(gpu.passes).toHaveLength(2);
    expect(gpu.passes[0]).toMatchObject({
      label: "_rt_Reflection clear",
      loadOp: "clear",
      clear: { r: 0.2, g: 0.4, b: 0.6, a: 1 },
    });
    expect(gpu.passes[0].view.texture.label).toBe("_rt_Reflection");
    expect(gpu.passes[1].clear).toEqual({ r: 2, g: 0.5, b: 0.25, a: 1 });
  });

  it("_rt_MipMappedFrameBuffer：场景目标格式（LDR rgba8unorm、HDR rgba16float）、mip 数按公式，建好时各级清成 (0, 0, 0, 1) 一次", () => {
    for (const [hdr, format] of [
      [false, "rgba8unorm"],
      [true, "rgba16float"],
    ] as const) {
      const gpu = new FakeGpu();
      const targets = ReflectionTargets.create(gpu.device, { mipFramebuffer: { update: false } }, 1920, 1080, hdr)!;
      expect(gpu.textures).toHaveLength(1);
      expect(targets.updatesMip).toBe(false);
      expect(gpu.textures[0].usage & GPUTextureUsage.COPY_DST).toBe(0);
      expect(gpu.textures[0]).toMatchObject({
        label: "_rt_MipMappedFrameBuffer",
        format,
        size: { width: 1920, height: 1080 },
        mipLevelCount: 8,
      });
      expect(targets.mipLevelCount).toBe(8);
      expect(targets.reflection).toBeNull();
      expect(targets.mipFramebuffer!.sampler).toEqual({
        descriptor: {
          addressModeU: "clamp-to-edge",
          addressModeV: "clamp-to-edge",
          magFilter: "linear",
          minFilter: "linear",
          mipmapFilter: "linear",
        },
      });
      // 各级各清一次，之后不再碰：提交 1 次，8 个 pass 的基础级依次是 0…7
      expect(gpu.submits).toBe(1);
      expect(gpu.passes.map((pass) => pass.view.baseMipLevel)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      for (const pass of gpu.passes) expect(pass.clear).toEqual({ r: 0, g: 0, b: 0, a: 1 });
      // 每帧的 encode 不碰它；反射关时 encodeMipFramebuffer 什么都不做
      targets.encode(gpu.device.createCommandEncoder(), [1, 1, 1]);
      targets.encodeMipFramebuffer(gpu.device.createCommandEncoder(), gpu.textures[0] as unknown as GPUTexture);
      expect(gpu.passes).toHaveLength(8);
      expect(gpu.copies).toEqual([]);
    }
  });

  it("反射开（P13g）：用途带 COPY_DST、建好不清屏；encodeMipFramebuffer 先把源拷进 0 级，再 1…L−1 级各一个 pass 读上一级", () => {
    for (const [hdr, format] of [
      [false, "rgba8unorm"],
      [true, "rgba16float"],
    ] as const) {
      const gpu = new FakeGpu();
      const targets = ReflectionTargets.create(gpu.device, { mipFramebuffer: { update: true } }, 1920, 1080, hdr)!;
      expect(targets.updatesMip).toBe(true);
      const [texture] = gpu.texturesOf("_rt_MipMappedFrameBuffer");
      expect(texture).toMatchObject({ format, size: { width: 1920, height: 1080 }, mipLevelCount: 8 });
      expect(texture.usage & GPUTextureUsage.COPY_DST).toBeTruthy();
      // WPE 只在反射关时清；开着时建好不清、不提交
      expect(gpu.submits).toBe(0);
      expect(gpu.passes).toEqual([]);
      const source = { label: "scene target" } as unknown as GPUTexture;
      targets.encodeMipFramebuffer(gpu.device.createCommandEncoder(), source);
      expect(gpu.copies).toEqual([
        {
          source: "scene target",
          destination: "_rt_MipMappedFrameBuffer",
          mipLevel: 0,
          size: { width: 1920, height: 1080 },
        },
      ]);
      expect(gpu.passes.map((pass) => pass.label)).toEqual(
        [1, 2, 3, 4, 5, 6, 7].map((k) => `_rt_MipMappedFrameBuffer mip ${k}`),
      );
      gpu.passes.forEach((pass, index) => {
        const level = index + 1;
        expect(pass.view).toMatchObject({ label: "_rt_MipMappedFrameBuffer", baseMipLevel: level });
        expect(pass.loadOp).toBe("clear");
        expect(pass.draws).toEqual([3]);
        // 读的是上一级的单级视图
        const entries = [...(pass.bindGroups[0].descriptor!.entries as Iterable<GPUBindGroupEntry>)];
        expect((entries[0].resource as unknown as FakeView).baseMipLevel).toBe(level - 1);
        expect((entries[1].resource as unknown as { descriptor: GPUSamplerDescriptor }).descriptor).toEqual({
          addressModeU: "clamp-to-edge",
          addressModeV: "clamp-to-edge",
          magFilter: "linear",
          minFilter: "linear",
        });
        // 定点缩放系数：上一级尺寸 / 这一级尺寸（1080 → 540 → 270 → 135 → 67 → 33 → 16 → 8 的高、1920 起的宽）
        const scale = (entries[2].resource as unknown as { buffer: FakeBuffer }).buffer;
        const [sx, sy] = new Uint32Array(scale.bytes.buffer.slice(0, 8));
        const at = (size: number, l: number) => Math.max(1, size >> l);
        expect([sx, sy]).toEqual([
          mipDownsampleScale(at(1920, level - 1), at(1920, level)),
          mipDownsampleScale(at(1080, level - 1), at(1080, level)),
        ]);
      });
    }
  });

  it("缩小的定点坐标（步骤 0：p13g 抓帧反推的 GenerateMips）：同式实现与精确值逐个相同；偶数边是 2j + ½，奇数边的整数点落到下一对纹素", () => {
    const exact = (j: number, c: number) => Number((BigInt(2 * j + 1) * BigInt(c)) >> 17n) - 128;
    for (const [source, target] of [
      [1920, 960],
      [135, 67],
      [67, 33],
      [33, 16],
      [1366, 683],
      [683, 341],
      [16384, 8192],
      [8191, 4095],
      [3, 1],
      [1, 1],
      // 系数的小数部分大于 ½（13 · 2²⁴ / 6 = …​.667）：向下截与就近取不同
      [13, 6],
    ]) {
      const c = mipDownsampleScale(source, target);
      expect(c).toBe(Math.floor((source * 2 ** 24) / target));
      for (let j = 0; j < target; j++) expect(mipSourceCoord256(j, c)).toBe(exact(j, c));
    }
    // 偶数边：系数正好是 2，坐标 2j + ½ 精确（等于 2×2 平均）
    expect(mipDownsampleScale(1920, 960)).toBe(2 * 2 ** 24);
    expect([0, 1, 479].map((j) => mipSourceCoord256(j, 2 * 2 ** 24))).toEqual([128, 640, 958 * 256 + 128]);
    // 135 → 67：第 33 行理论上正好是 67，WPE 落在 66 + 255/256（抓帧逐行反推）；第 0 行 0 + 129/256（理论 129.91，向下截）
    const c4 = mipDownsampleScale(135, 67);
    expect(mipSourceCoord256(33, c4)).toBe(66 * 256 + 255);
    expect(mipSourceCoord256(0, c4)).toBe(129);
    // 尺寸为 1 的轴保持 0，3 → 1 取中间那个纹素
    expect(mipSourceCoord256(0, mipDownsampleScale(1, 1))).toBe(0);
    expect(mipSourceCoord256(0, mipDownsampleScale(3, 1))).toBe(256);
  });

  it("反射开：resize 之后按新的级数缩小（1280×720 → 7 级、6 个 pass）", () => {
    const gpu = new FakeGpu();
    const targets = ReflectionTargets.create(gpu.device, { mipFramebuffer: { update: true } }, 1920, 1080, false)!;
    targets.resize(1280, 720);
    targets.encodeMipFramebuffer(gpu.device.createCommandEncoder(), { label: "scene target" } as unknown as GPUTexture);
    expect(gpu.copies[0].size).toEqual({ width: 1280, height: 720 });
    expect(gpu.passes.map((pass) => pass.view.baseMipLevel)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(gpu.passes.every((pass) => pass.view.texture.size.width === 1280)).toBe(true);
  });

  it("两张都要：各一张纹理；resize 按新尺寸重建（mip 数跟着变）；destroy 销毁全部", () => {
    const gpu = new FakeGpu();
    const targets = ReflectionTargets.create(
      gpu.device,
      { reflection: { planar: true }, mipFramebuffer: { update: false } },
      1920,
      1080,
      false,
    )!;
    expect(gpu.textures.map((texture) => texture.label).sort()).toEqual(["_rt_MipMappedFrameBuffer", "_rt_Reflection"]);
    const first = [...gpu.textures];
    targets.resize(1280, 720);
    expect(first.every((texture) => texture.destroyed)).toBe(true);
    expect(targets.reflection).toMatchObject({ width: 1280, height: 720 });
    expect(targets.mipFramebuffer).toMatchObject({ width: 1280, height: 720 });
    expect(targets.mipLevelCount).toBe(7);
    // 尺寸没变不重建
    const count = gpu.textures.length;
    targets.resize(1280, 720);
    expect(gpu.textures).toHaveLength(count);
    targets.destroy();
    expect(gpu.textures.every((texture) => texture.destroyed)).toBe(true);
  });
});

// ———— 渲染图：运行时名字 → 纹理来源 ————

function pass(partial: Partial<ScenePass> = {}): ScenePass {
  return {
    key: "objects/0/passes/0",
    program: 0,
    blending: "translucent",
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

function layerOf(extra: Partial<SceneLayer> = {}): SceneLayer {
  return {
    id: 11,
    object: 0,
    parent: null,
    name: "l",
    origin: [960, 540, 0],
    scale: [1, 1, 1],
    angles: [0, 0, 0],
    size: [100, 100],
    alpha: 1,
    color: [1, 1, 1],
    brightness: 1,
    visible: true,
    visibleBound: false,
    parallaxDepth: [1, 1],
    solidLayer: true,
    instanced: false,
    noPadding: false,
    perspective: false,
    passthroughModel: false,
    group: null,
    subtree: [],
    groupUpload: null,
    copyBackground: true,
    clampUVs: true,
    noInterpolation: false,
    fullscreen: false,
    fullscreenSize: null,
    passes: [pass()],
    colorBlendMode: 0,
    effects: [],
    passthrough: null,
    particle: null,
    ...extra,
  };
}

/** 同时读两张反射 RT 与一个认不出的名字的运行时表。 */
const RUNTIME = { 0: REFLECTION_RT, 1: MIP_FRAMEBUFFER_RT, 2: "_rt_Unknown" };

describe("渲染图：运行时名字 → 纹理来源（五处共用 runtimeInput）", () => {
  const known = { 0: { kind: "reflection" }, 1: { kind: "mip-framebuffer" } };
  const ONLY = { 0: REFLECTION_RT, 1: MIP_FRAMEBUFFER_RT };

  it("图像层（staticInputs，直接上屏）", () => {
    const plan = planLayer(layerOf({ passes: [pass({ runtime: ONLY })] }), []);
    const [step] = plan.steps as DrawStep[];
    expect(step.inputs).toMatchObject(known);
    expect(plan.reasons).toEqual([]);
  });

  it("图像层的 effect pass 与基础 pass：同样认（staticInputs 的 effect 分支；effect 的槽 0 由渲染图填）", () => {
    const effectRuntime = { 1: REFLECTION_RT, 2: MIP_FRAMEBUFFER_RT };
    const effect = {
      source: 0,
      id: 1,
      name: "",
      file: "effects/x/effect.json",
      fbos: [],
      steps: [{ kind: "draw", pass: pass({ runtime: effectRuntime }), target: null, compose: false, binds: null }],
      enabled: true,
      visibleBound: false,
      unsupported: [],
    };
    const plan = planLayer(layerOf({ passes: [pass({ runtime: ONLY })], effects: [effect as never] }), []);
    const draws = plan.steps.filter((step): step is DrawStep => step.kind === "draw");
    expect(draws).toHaveLength(2);
    expect(draws[0].inputs).toMatchObject(known);
    expect(draws[1].inputs).toMatchObject({ 1: { kind: "reflection" }, 2: { kind: "mip-framebuffer" } });
    expect(plan.reasons).toEqual([]);
  });

  it("模型（planModelLayer）", () => {
    const model = { order: [0], meshes: [{ passes: [pass({ runtime: ONLY })] }] };
    const plan = planModelLayer({ model } as never);
    expect(plan.reasons).toEqual([]);
    expect(plan.steps[0]).toMatchObject({ kind: "mesh", inputs: known });
  });

  it("形状（planShapeLayer）", () => {
    const effect = {
      fbos: [],
      steps: [{ kind: "draw", pass: pass({ runtime: ONLY }), target: null, compose: false, binds: null }],
    };
    const plan = planShapeLayer({ effects: [effect] } as never);
    expect(plan.reasons).toEqual([]);
    const step = plan.steps.find((item): item is DrawStep => item.kind === "draw")!;
    expect(step.inputs).toMatchObject(known);
  });

  it("粒子（planParticleLayer）：reasons 的检查与步骤输入两处", () => {
    const particle: SceneParticle = parseParticle(
      {
        maxcount: 8,
        emitter: [{ name: "sphererandom", rate: 10 }],
        initializer: [{ name: "lifetimerandom", min: 1, max: 1 }],
      },
      { file: "particles/p.json", orthographic: true },
    );
    particle.passes = [pass({ runtime: ONLY })];
    const plan = planParticleLayer({ particle });
    expect(plan.reasons).toEqual([]);
    expect(plan.steps[0]).toMatchObject({ kind: "particles", inputs: known });
  });

  it("认不出的名字五处都仍报 render:texture-rt:<名>", () => {
    const reasons = (plan: { reasons: string[] }) => plan.reasons;
    expect(reasons(planLayer(layerOf({ passes: [pass({ runtime: RUNTIME })] }), []))).toEqual([
      "render:texture-rt:_rt_Unknown",
    ]);
    const meshes = [{ passes: [pass({ runtime: RUNTIME })] }];
    expect(reasons(planModelLayer({ model: { order: [0], meshes } } as never))).toEqual([
      "render:texture-rt:_rt_Unknown",
    ]);
    const effect = { fbos: [], steps: [{ kind: "draw", pass: pass({ runtime: RUNTIME }) }] };
    expect(reasons(planShapeLayer({ effects: [effect] } as never))).toEqual(["render:texture-rt:_rt_Unknown"]);
    const particle = parseParticle(
      {
        maxcount: 8,
        emitter: [{ name: "sphererandom", rate: 10 }],
        initializer: [{ name: "lifetimerandom", min: 1, max: 1 }],
      },
      { file: "particles/p.json", orthographic: true },
    );
    particle.passes = [pass({ runtime: RUNTIME })];
    expect(reasons(planParticleLayer({ particle }))).toEqual(["render:texture-rt:_rt_Unknown"]);
  });
});

// ———— GpuScene ————

/** 图像程序：`g_Texture1Resolution`（偏移 0）与 `g_Texture1MipMapInfo`（偏移 16），纹理槽 0、1。 */
const PROGRAM = {
  ok: true,
  vertex: { wgsl: "// image v", entryPoint: "main" },
  fragment: { wgsl: "// image f", entryPoint: "main" },
  attributes: [
    { name: "a_Position", type: "vec3", location: 0 },
    { name: "a_TexCoord", type: "vec2", location: 1 },
  ],
  uniforms: [
    { name: "g_Texture1Resolution", type: "vec4<f32>", declared: "vec4", offset: 0, size: 16 },
    { name: "g_Texture1MipMapInfo", type: "f32", declared: "float", offset: 16, size: 4 },
  ],
  uniformBlockSize: 32,
  textures: [0, 1].map((slot) => ({ slot, binding: 1 + 2 * slot, samplerBinding: 2 + 2 * slot, kind: "2d" })),
} as unknown as TranslateResult;

function bundleOf(
  runtime: Record<number, string>,
  extra: Partial<SceneBundle> = {},
  general: { hdr?: boolean; clearenabled?: boolean } = {},
): SceneBundle {
  const hdr = general.hdr ?? false;
  const fields = generalDefaults();
  if (general.clearenabled === false) fields.clearenabled = false;
  return {
    general: {
      width: 1920,
      height: 1080,
      fields,
      clearVariable: general.clearenabled === false,
      perspectiveOverrideFov: particleFov(undefined),
      postprocess: { level: hdr ? "ultra" : "disabled", bloomFlag: hdr, hdrFlag: hdr, bloom: false, hdr },
      bloom: { ...BLOOM_DEFAULTS, tint: [1, 1, 1] },
    },
    layers: [layerOf({ passes: [pass({ runtime })] })],
    programs: [PROGRAM],
    textures: [],
    bloom: null,
    unsupported: [],
    bindings: [],
    scripts: { list: [] },
    ...extra,
  } as unknown as SceneBundle;
}

const FRAME: FrameInput = {
  time: 1,
  frametime: 0.05,
  daytime: 0.5,
  pointer: [0.5, 0.5],
  pointerLast: [0.5, 0.5],
  cursor: [0.5, 0.5],
};

async function open(bundle: SceneBundle) {
  const gpu = new FakeGpu();
  const state = SceneState.fromBundle(bundle);
  const scene = await GpuScene.build(gpu.device, bundle, state, new Set(), [], { particles: { seed: 1 } });
  scene.update(FRAME, state);
  return { gpu, scene, state };
}

/** 图层 draw 的 uniform 缓冲（程序里 `g_Texture1Resolution` + `g_Texture1MipMapInfo`）按 f32 读出前 5 个数。 */
function drawUniforms(gpu: FakeGpu): number[] {
  const buffer = gpu.buffers.find((item) => item.usage & GPUBufferUsage.UNIFORM && item.bytes.length >= 32)!;
  return Array.from(new Float32Array(buffer.bytes.buffer, 0, 5));
}

describe("GpuScene：没有反射的场景不经过 reflection.ts", () => {
  it("没有 reflection / mipFramebuffer：不建两张 RT，一帧里没有反射的清屏 pass（命令轨迹只有场景 pass）", async () => {
    const { gpu, scene, state } = await open(bundleOf({}));
    expect(gpu.texturesOf("_rt_Reflection")).toEqual([]);
    expect(gpu.texturesOf("_rt_MipMappedFrameBuffer")).toEqual([]);
    expect(gpu.encode(scene, state).map((pass) => pass.label)).toEqual(["scene"]);
  });
});

describe("GpuScene：_rt_Reflection（反射关）", () => {
  const planar = () => bundleOf({ 1: REFLECTION_RT }, { reflection: { planar: true } });

  it("建一张场景目标尺寸的 rgba8unorm；帧首清成 (clearcolor, 1)，在场景 pass 之前，一帧一次", async () => {
    const { gpu, scene, state } = await open(planar());
    expect(gpu.texturesOf("_rt_Reflection")).toHaveLength(1);
    expect(gpu.texturesOf("_rt_Reflection")[0]).toMatchObject({
      format: "rgba8unorm",
      size: { width: 1920, height: 1080 },
    });
    state.general.clearcolor = [0.2, 0.4, 0.6];
    const passes = gpu.encode(scene, state);
    expect(passes.map((pass) => pass.label)).toEqual(["_rt_Reflection clear", "scene"]);
    expect(passes[0].clear).toEqual({ r: 0.2, g: 0.4, b: 0.6, a: 1 });
    expect(passes[0].view.texture.label).toBe("_rt_Reflection");
    // 清屏色随 state.general.clearcolor（脚本 / 属性写入同帧生效）
    state.general.clearcolor = [0.8, 0.1, 0.3];
    expect(gpu.encode(scene, state)[0].clear).toEqual({ r: 0.8, g: 0.1, b: 0.3, a: 1 });
  });

  it("clearenabled: false：场景 pass 接着上次画（load），反射图仍每帧清（步骤 0 R4）", async () => {
    const { gpu, scene, state } = await open(
      bundleOf({ 1: REFLECTION_RT }, { reflection: { planar: true } }, { clearenabled: false }),
    );
    state.general.clearcolor = [0.2, 0.4, 0.6];
    for (let frame = 0; frame < 2; frame++) {
      const passes = gpu.encode(scene, state);
      expect(passes[0]).toMatchObject({ label: "_rt_Reflection clear", loadOp: "clear" });
      expect(passes[0].clear).toEqual({ r: 0.2, g: 0.4, b: 0.6, a: 1 });
      expect(passes[1]).toMatchObject({ label: "scene", loadOp: "load" });
    }
  });

  it("HDR：场景目标是 rgba16float，反射图仍是 rgba8unorm（步骤 0 R6）", async () => {
    const { gpu } = await open(bundleOf({ 1: REFLECTION_RT }, { reflection: { planar: true } }, { hdr: true }));
    expect(gpu.texturesOf("scene target")[0].format).toBe("rgba16float");
    expect(gpu.texturesOf("_rt_Reflection")[0].format).toBe("rgba8unorm");
  });

  it("g_Texture1Resolution 是 RT 的尺寸 (W, H, W, H)；销毁时释放", async () => {
    const { gpu, scene } = await open(planar());
    expect(drawUniforms(gpu).slice(0, 4)).toEqual([1920, 1080, 1920, 1080]);
    scene.destroy();
    expect(gpu.texturesOf("_rt_Reflection")[0].destroyed).toBe(true);
  });
});

describe("GpuScene：_rt_MipMappedFrameBuffer（〔g1〕）", () => {
  it("建场景时清一次、之后不更新；g_Texture1MipMapInfo 是 mip 数（float），Resolution 是 RT 尺寸", async () => {
    const { gpu, scene, state } = await open(
      bundleOf({ 1: MIP_FRAMEBUFFER_RT }, { mipFramebuffer: { update: false } }),
    );
    const [texture] = gpu.texturesOf("_rt_MipMappedFrameBuffer");
    expect(texture).toMatchObject({ format: "rgba8unorm", size: { width: 1920, height: 1080 }, mipLevelCount: 8 });
    const clears = gpu.passes.filter((pass) => pass.view.texture.label === "_rt_MipMappedFrameBuffer");
    expect(clears).toHaveLength(8);
    expect(drawUniforms(gpu)).toEqual([1920, 1080, 1920, 1080, 8]);
    // 每帧不碰它：没有反射清屏，只有场景 pass，没有拷贝
    expect(gpu.encode(scene, state).map((pass) => pass.label)).toEqual(["scene"]);
    expect(gpu.copies).toEqual([]);
  });

  it("HDR：mip 帧缓冲是 rgba16float", async () => {
    const { gpu } = await open(
      bundleOf({ 1: MIP_FRAMEBUFFER_RT }, { mipFramebuffer: { update: false } }, { hdr: true }),
    );
    expect(gpu.texturesOf("_rt_MipMappedFrameBuffer")[0].format).toBe("rgba16float");
  });

  it("反射开（P13g）：每帧场景 pass 之后把场景目标拷进 0 级、再逐级缩小；建场景时不清；MipMapInfo 照旧是 mip 数", async () => {
    for (const hdr of [false, true]) {
      const { gpu, scene, state } = await open(
        bundleOf({ 1: MIP_FRAMEBUFFER_RT }, { mipFramebuffer: { update: true } }, { hdr }),
      );
      expect(gpu.passes.filter((pass) => pass.view.texture.label === "_rt_MipMappedFrameBuffer")).toEqual([]);
      expect(drawUniforms(gpu)).toEqual([1920, 1080, 1920, 1080, 8]);
      for (let frame = 0; frame < 2; frame++) {
        const passes = gpu.encode(scene, state);
        expect(passes.map((pass) => pass.label)).toEqual([
          "scene",
          ...[1, 2, 3, 4, 5, 6, 7].map((k) => `_rt_MipMappedFrameBuffer mip ${k}`),
        ]);
        expect(gpu.copies).toEqual([
          {
            source: "scene target",
            destination: "_rt_MipMappedFrameBuffer",
            mipLevel: 0,
            size: { width: 1920, height: 1080 },
          },
        ]);
      }
    }
  });

  it("反射开、场景里一个图层都没画：照样先清场景目标再拷（拷的是清屏色）", async () => {
    const bundle = bundleOf({ 1: MIP_FRAMEBUFFER_RT }, { mipFramebuffer: { update: true } });
    const { gpu, scene, state } = await open(bundle);
    state.layers.get(bundle.layers[0].object)!.visible = false;
    const passes = gpu.encode(scene, state);
    expect(passes[0]).toMatchObject({ label: "scene", loadOp: "clear" });
    expect(gpu.copies).toHaveLength(1);
  });

  it("反射开且有泛光：拷贝与缩小在泛光之前（拷的是泛光前的场景，WPE 的 ResolveSubresource 在泛光链之前）", async () => {
    /** LDR 泛光链：四个程序（槽 0，combine 另读槽 1），排在图像程序之后。 */
    const bloomProgram = (slots: number[]) =>
      ({
        ...PROGRAM,
        uniforms: [{ name: "g_RenderVar0", type: "vec4<f32>", declared: "vec4", offset: 0, size: 16 }],
        uniformBlockSize: 16,
        textures: slots.map((slot) => ({ slot, binding: 1 + 2 * slot, samplerBinding: 2 + 2 * slot, kind: "2d" })),
      }) as unknown as TranslateResult;
    const names = ["quarter", "eighth", "blur", "combine"];
    const bundle = bundleOf({ 1: MIP_FRAMEBUFFER_RT }, { mipFramebuffer: { update: true } });
    bundle.programs.push(...names.map((name) => bloomProgram(name === "combine" ? [0, 1] : [0])));
    bundle.bloom = {
      hdr: false,
      passes: Object.fromEntries(
        names.map((name, index) => [name, pass({ key: `bloom/${name}`, program: 1 + index, blending: "normal" })]),
      ),
    } as SceneBundle["bloom"];
    bundle.general.postprocess = { level: "enabled", bloomFlag: true, hdrFlag: false, bloom: true, hdr: false };
    const { gpu, scene, state } = await open(bundle);
    expect(state.bloomEnabled).toBe(true);
    const labels = gpu.encode(scene, state).map((pass) => pass.label);
    const lastMip = labels.indexOf("_rt_MipMappedFrameBuffer mip 7");
    expect(labels.slice(0, lastMip + 1)).toEqual([
      "scene",
      ...[1, 2, 3, 4, 5, 6, 7].map((k) => `_rt_MipMappedFrameBuffer mip ${k}`),
    ]);
    // 后面是泛光链（至少一个 pass），不再碰 mip 帧缓冲
    expect(labels.length).toBeGreaterThan(lastMip + 1);
    expect(labels.slice(lastMip + 1).some((label) => label.includes("_rt_MipMappedFrameBuffer"))).toBe(false);
    // 第一次拷贝是 mip 帧缓冲的 0 级，泛光的整帧快照在它之后
    expect(gpu.copies[0]).toMatchObject({ source: "scene target", destination: "_rt_MipMappedFrameBuffer" });
    expect(gpu.copies.length).toBeGreaterThan(1);
  });

  it("绑 _rt_Reflection 的槽没有 MipMapInfo（只有绑 mip 帧缓冲的槽写）", async () => {
    const { gpu } = await open(bundleOf({ 1: REFLECTION_RT }, { reflection: { planar: true } }));
    expect(drawUniforms(gpu)[4]).toBe(0);
  });
});
