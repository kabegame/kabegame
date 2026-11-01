import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { compileScene, type SceneBundle, type SceneTexture } from "../compile/bundle";
import type { SceneReader } from "../compile/fs";
import { Wpesl2wgsl, type TranslateResult } from "../wpesl2wgsl";
import { FrameThrottle, PausableClock } from "./clock";
import { reasonsOf, SceneRenderError } from "./errors";
import {
  canvasToScenePointer,
  coverUv,
  layerModelMatrix,
  layerQuad,
  sceneTargetSize,
  sceneViewProjection,
  textureUvExtent,
} from "./layout";
import {
  identity,
  invert,
  multiply,
  normalMatrix,
  orthographic,
  rotationZ,
  scaling,
  transformPoint,
  translation,
} from "./math";
import { bindGroupLayoutEntries, blendState, vertexPacking } from "./programs";
import { planLayer } from "./graph";
import { checkRenderable } from "./scene";
import {
  mipCopyLayout,
  mipSize,
  planBitmapUpload,
  planTextureUpload,
  requiredFeatures,
  samplerDescriptor,
} from "./textures";
import {
  daytimeOf,
  declaredComponents,
  frameBuiltins,
  parseShape,
  staticBuiltins,
  UniformBlock,
  type UniformEntry,
} from "./uniforms";

vi.mock("@/utils/fileUrl", () => ({ fileToUrl: (path: string) => path }));

function close(actual: ArrayLike<number>, expected: number[], digits = 5) {
  expect(Array.from(actual).length).toBe(expected.length);
  expected.forEach((value, i) => expect(actual[i]).toBeCloseTo(value, digits));
}

/** 场景坐标 → NDC。 */
function ndc(m: Float32Array, x: number, y: number, z = 0): [number, number, number] {
  const [cx, cy, cz, w] = transformPoint(m, x, y, z);
  return [cx / w, cy / w, cz / w];
}

function texture(partial: Partial<SceneTexture>): SceneTexture {
  return {
    path: "materials/a.tex",
    source: "project",
    format: 0,
    width: 1,
    height: 1,
    textureWidth: 1,
    textureHeight: 1,
    flags: 0,
    clampUVs: false,
    noInterpolation: false,
    mips: [],
    ...partial,
  };
}

describe("矩阵", () => {
  it("乘法、求逆与列主序", () => {
    const m = multiply(translation(10, 20, 30), multiply(rotationZ(0.3), scaling(2, 3, 4)));
    // 列主序：平移在 12..14
    expect(Array.from(m.slice(12, 15))).toEqual([10, 20, 30]);
    close(multiply(m, invert(m)!), Array.from(identity()));
    expect(invert(scaling(0, 1, 1))).toBeNull();
  });
  it("绕 z 逆时针旋转（y 向上）", () => {
    close(transformPoint(rotationZ(Math.PI / 2), 1, 0, 0), [0, 1, 0, 1]);
  });
  it("正交投影：四角到 NDC、深度 0…1", () => {
    const p = orthographic(0, 1920, 0, 1080, -100, 100);
    close(ndc(p, 0, 0), [-1, -1, 0.5]);
    close(ndc(p, 1920, 1080), [1, 1, 0.5]);
    close(ndc(p, 0, 0, 100), [-1, -1, 0]);
    close(ndc(p, 0, 0, -100), [-1, -1, 1]);
  });
  it("法线矩阵是左上 3×3 的逆转置", () => {
    close(normalMatrix(scaling(2, 4, 1)), [0.5, 0, 0, 0, 0.25, 0, 0, 0, 1]);
    const r = normalMatrix(rotationZ(0.7));
    close(
      r,
      Array.from(rotationZ(0.7)).filter((_, i) => i % 4 < 3 && i < 12),
    );
  });
});

describe("场景几何", () => {
  it("填充纹理的有效区域", () => {
    // 图像尺寸 / 纹理尺寸（FreeImage 形态的纹理尺寸已在编译期改成图像尺寸，UV 为 1）
    expect(textureUvExtent(texture({ width: 1920, height: 1080, textureWidth: 2048, textureHeight: 2048 }))).toEqual([
      1920 / 2048,
      1080 / 2048,
    ]);
    expect(textureUvExtent(texture({ width: 3840, height: 2160, textureWidth: 3840, textureHeight: 2160 }))).toEqual([
      1, 1,
    ]);
    expect(textureUvExtent(undefined)).toEqual([1, 1]);
  });
  it("四边形：三角形带顺序，顶边 v = 0", () => {
    expect(layerQuad([200, 100], [0.75, 0.5])).toEqual([
      { position: [-100, -50, 0], texCoord: [0, 0.5] },
      { position: [100, -50, 0], texCoord: [0.75, 0.5] },
      { position: [-100, 50, 0], texCoord: [0, 0] },
      { position: [100, 50, 0], texCoord: [0.75, 0] },
    ]);
  });
  it("eagleflag 的旗帜盖满 2200×1080 场景（相机 eye 不平移画面）", () => {
    const general = { width: 2200, height: 1080 };
    const layer = { origin: [1082, 550.906, 0], scale: [1.1, 1.1, 1], angles: [0, 0, 0] };
    const mvp = multiply(sceneViewProjection(general), layerModelMatrix(layer));
    const [bl, , , tr] = layerQuad([2048, 1024], [1, 1]).map((v) => ndc(mvp, ...v.position));
    expect(bl[0]).toBeLessThan(-1);
    expect(bl[1]).toBeLessThan(-1);
    expect(tr[0]).toBeGreaterThan(1);
    expect(tr[1]).toBeGreaterThan(1);
    // 中心在场景坐标 (1082, 550.906)
    close(ndc(mvp, 0, 0).slice(0, 2), [1082 / 1100 - 1, 550.906 / 540 - 1]);
  });
  it("旋转图层：角点绕图层中心转", () => {
    const m = layerModelMatrix({ origin: [100, 50, 0], scale: [2, 2, 1], angles: [0, 0, Math.PI / 2] });
    close(transformPoint(m, 10, 0, 0), [100, 70, 0, 1]);
  });
  it("cover：宽场景裁左右、高场景裁上下", () => {
    const wide = coverUv(2200, 1080, 1920, 1080);
    close(wide.scale, [1920 / 2200, 1]);
    close(wide.offset, [(1 - 1920 / 2200) / 2, 0]);
    const square = coverUv(1920, 1080, 1000, 1000);
    close(square.scale, [1080 / 1920, 1]);
    const tall = coverUv(1920, 1080, 1920, 1440);
    close(tall.scale, [0.75, 1]);
    close(coverUv(1920, 1080, 3840, 2160).scale, [1, 1]);
    expect(coverUv(0, 0, 1, 1)).toEqual({ offset: [0, 0], scale: [1, 1] });
  });
  it("画布指针换算到场景（左下原点）", () => {
    const cover = coverUv(2000, 1000, 1000, 1000);
    close(canvasToScenePointer(cover, 0.5, 0.5), [0.5, 0.5]);
    close(canvasToScenePointer(cover, 0, 0), [0.25, 1]);
    close(canvasToScenePointer(cover, 1, 1), [0.75, 0]);
  });
  it("离屏目标不超过设备上限", () => {
    expect(sceneTargetSize(1920, 1080, 8192)).toEqual([1920, 1080]);
    expect(sceneTargetSize(16384, 4096, 8192)).toEqual([8192, 2048]);
  });
});

describe("纹理上传布局", () => {
  it("BC3 按 4×4 块计行跨度，小 mip 补满一块", () => {
    expect(mipCopyLayout(4, 2048, 1024)).toEqual({
      bytesPerRow: 8192,
      rowsPerImage: 256,
      width: 2048,
      height: 1024,
      byteLength: 2097152,
    });
    expect(mipCopyLayout(4, 4, 2)).toEqual({ bytesPerRow: 16, rowsPerImage: 1, width: 4, height: 4, byteLength: 16 });
    expect(mipCopyLayout(4, 2, 2).byteLength).toBe(16);
    expect(mipCopyLayout(4, 1, 1).width).toBe(4);
    expect(mipCopyLayout(0, 3, 2)).toEqual({ bytesPerRow: 12, rowsPerImage: 2, width: 3, height: 2, byteLength: 24 });
    expect(() => mipCopyLayout(9, 1, 1)).toThrow(SceneRenderError);
  });
  it("mip 链校验", () => {
    expect(mipSize(2048, 11)).toBe(1);
    const mips = [
      { width: 8, height: 4, bytes: new Uint8Array(32) },
      { width: 4, height: 2, bytes: new Uint8Array(16) },
      { width: 2, height: 1, bytes: new Uint8Array(16) },
    ];
    expect(planTextureUpload(texture({ format: 4, mips })).map((l) => l.byteLength)).toEqual([32, 16, 16]);
    expect(() => planTextureUpload(texture({ format: 4, mips: [mips[0], mips[2]] }))).toThrow("texture-mip");
    expect(() => planTextureUpload(texture({ format: 4, mips: [{ ...mips[0], bytes: new Uint8Array(8) }] }))).toThrow(
      "texture-data",
    );
    expect(() =>
      planTextureUpload(texture({ format: 4, mips: [{ width: 6, height: 4, bytes: new Uint8Array(64) }] })),
    ).toThrow("texture-size");
    expect(() => planTextureUpload(texture({ format: 4 }))).toThrow("texture-empty");
  });
  it("采样器与所需特性", () => {
    expect(samplerDescriptor({ clampUVs: true, noInterpolation: false }, true)).toMatchObject({
      addressModeU: "clamp-to-edge",
      magFilter: "linear",
      mipmapFilter: "linear",
      maxAnisotropy: 8,
    });
    expect(samplerDescriptor({ clampUVs: false, noInterpolation: true }, true)).toMatchObject({
      addressModeV: "repeat",
      minFilter: "nearest",
      mipmapFilter: "nearest",
      maxAnisotropy: 1,
    });
    expect(samplerDescriptor({ clampUVs: false, noInterpolation: false }, false).maxAnisotropy).toBe(1);
    expect(requiredFeatures([{ format: 0 }, { format: 4 }, { format: 4 }])).toEqual(["texture-compression-bc"]);
  });
});

describe("uniform 打包", () => {
  // eagleflag `flag`（TINT=1）的真实布局
  const flag: UniformEntry[] = [
    { name: "g_ModelViewProjectionMatrix", type: "mat4x4<f32>", declared: "mat4", offset: 0, size: 64 },
    { name: "g_Time", type: "f32", declared: "float", offset: 64, size: 4 },
    { name: "g_WaveSpeed", type: "f32", declared: "float", offset: 68, size: 4 },
    { name: "g_Color1", type: "vec3<f32>", declared: "vec3", offset: 80, size: 12 },
    { name: "g_WaveStrength", type: "f32", declared: "float", offset: 124, size: 4 },
  ];
  it("标量、vec3、mat4 按偏移写", () => {
    const block = new UniformBlock(flag, 128);
    expect(block.data.byteLength).toBe(128);
    const m = Array.from({ length: 16 }, (_, i) => i + 1);
    block.set("g_ModelViewProjectionMatrix", m);
    block.set("g_Time", [2.5]);
    block.set("g_Color1", [0.1, 0.2, 0.3, 9]);
    block.set("g_WaveStrength", [0.3]);
    block.set("missing", [1]);
    const f = new Float32Array(block.data);
    expect(Array.from(f.slice(0, 16))).toEqual(m);
    expect(f[16]).toBe(2.5);
    close(f.slice(20, 24), [0.1, 0.2, 0.3, 0]);
    close([f[31]], [0.3]);
    expect(block.has("g_Time")).toBe(true);
    expect(block.has("missing")).toBe(false);
  });
  it("标量数组补成 vec4，按 16 字节步长", () => {
    const block = new UniformBlock(
      [
        {
          name: "g_AudioSpectrum16Left",
          type: "array<vec4<f32>, 4>",
          declared: "float",
          offset: 16,
          size: 64,
          array: 4,
          stride: 16,
        },
      ],
      80,
    );
    block.set("g_AudioSpectrum16Left", [1, 2, 3, 4]);
    const f = new Float32Array(block.data);
    expect([f[4], f[5], f[8], f[12], f[16]]).toEqual([1, 0, 2, 3, 4]);
  });
  it("mat3 列步长 16、整数写成 i32", () => {
    const block = new UniformBlock([
      { name: "m", type: "mat3x3<f32>", declared: "mat3", offset: 0, size: 48 },
      { name: "n", type: "vec2<i32>", declared: "ivec2", offset: 48, size: 8 },
    ]);
    block.set("m", [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    block.set("n", [-3.7, 5]);
    const f = new Float32Array(block.data);
    expect(Array.from(f.slice(0, 12))).toEqual([1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0]);
    expect(Array.from(new Int32Array(block.data, 48, 2))).toEqual([-3, 5]);
  });
  it("类型解析", () => {
    expect(parseShape("mat4x4<f32>")).toEqual({ scalar: "f32", columns: 4, rows: 4 });
    expect(parseShape("array<vec4<f32>, 16>")).toEqual({ scalar: "f32", columns: 1, rows: 4 });
    expect(parseShape("vec3u")).toEqual({ scalar: "u32", columns: 1, rows: 3 });
    expect(parseShape("i32")).toEqual({ scalar: "i32", columns: 1, rows: 1 });
    expect(declaredComponents("vec3", parseShape("vec3<f32>"))).toBe(3);
    expect(declaredComponents("float", parseShape("vec4<f32>"))).toBe(1);
    expect(declaredComponents("mat4", parseShape("mat4x4<f32>"))).toBe(16);
    expect(declaredComponents(undefined, parseShape("mat3x3<f32>"))).toBe(9);
  });
  it("内置值：纹理分辨率、颜色、帧值", () => {
    const values = staticBuiltins({
      modelViewProjection: identity(),
      modelViewProjectionInverse: identity(),
      model: identity(),
      viewProjection: identity(),
      layer: { alpha: 0.5, color: [1, 0.5, 0.25] },
      textures: [undefined, { width: 1920, height: 1080, textureWidth: 2048, textureHeight: 2048 }],
      screenSize: [1920, 1080],
      eye: [0, 0, 1],
    });
    expect(values.g_Texture1Resolution).toEqual([2048, 2048, 1920, 1080]);
    expect(values.g_Texture1Texel).toEqual([1 / 2048, 1 / 2048, 2048, 2048]);
    // 空槽（WPE `FUN_1400d8300`）
    expect(values.g_Texture0Resolution).toEqual([2, 2, 2, 2]);
    expect(values.g_Texture0Texel).toEqual([0.5, 0.5, 2, 2]);
    expect(values.g_Color4).toEqual([1, 0.5, 0.25, 0.5]);
    expect(values.g_TexelSize).toEqual([1 / 1920, 1 / 1080]);
    expect(values.g_Screen).toEqual([1920, 1080, 1920 / 1080]);
    const frame = frameBuiltins({ time: 3, frametime: 0.016, daytime: 0.5, pointer: [0.1, 0.2], pointerLast: [0, 0] });
    expect(frame.g_Time).toEqual([3]);
    expect(frame.g_Frametime).toEqual([0.016]);
    expect(frame.g_PointerState).toEqual([0, 0, 0, 0]);
    // h/24 + m/1440 + s/86400 + ms/8.64e7
    expect(daytimeOf(new Date(2026, 0, 1, 12, 30, 15, 500))).toBeCloseTo(
      0.5 + 30 / 1440 + 15 / 86400 + 500 / 8.64e7,
      9,
    );
  });
});

describe("程序", () => {
  it("混合状态照 LWE", () => {
    expect(blendState("translucent")?.color).toEqual({
      operation: "add",
      srcFactor: "src-alpha",
      dstFactor: "one-minus-src-alpha",
    });
    expect(blendState("additive")?.alpha).toMatchObject({ srcFactor: "src-alpha", dstFactor: "one" });
    expect(blendState("normal")?.color).toMatchObject({ srcFactor: "one", dstFactor: "zero" });
    expect(blendState("disabled")).toBeUndefined();
  });
  it("顶点布局按 location 交错，未知属性补 0", () => {
    const packing = vertexPacking([
      { name: "a_Position", location: 0, type: "vec3" },
      { name: "a_TexCoord", location: 1, type: "vec2" },
      { name: "a_Bones", location: 2, type: "mat4" },
    ]);
    expect(packing.layout.arrayStride).toBe(20 + 64);
    expect(Array.from(packing.layout.attributes, (a) => [a.shaderLocation, a.offset, a.format])).toEqual([
      [0, 0, "float32x3"],
      [1, 12, "float32x2"],
      [2, 20, "float32x4"],
      [3, 36, "float32x4"],
      [4, 52, "float32x4"],
      [5, 68, "float32x4"],
    ]);
    const data = new Float32Array(packing.pack(layerQuad([2, 2], [0.5, 1])));
    expect(Array.from(data.slice(0, 5))).toEqual([-1, -1, 0, 0, 1]);
    expect(data[21 + 3]).toBe(0.5);
    expect(() => vertexPacking([{ name: "x", location: 0, type: "dvec2" }])).toThrow("render:attribute");
  });
  it("bind group layout 照翻译结果", () => {
    const entries = bindGroupLayoutEntries({
      ok: true,
      uniforms: [{ name: "g_Time", type: "f32", offset: 0, size: 4 }],
      textures: [
        { slot: 0, name: "g_Texture0", kind: "2d", binding: 1, samplerBinding: 2 },
        { slot: 3, name: "g_Texture3", kind: "2d-comparison", binding: 7, samplerBinding: 8 },
      ],
    });
    expect(entries.map((e) => [e.binding, e.buffer?.type ?? e.texture?.sampleType ?? e.sampler?.type])).toEqual([
      [0, "uniform"],
      [1, "float"],
      [2, "filtering"],
      [7, "depth"],
      [8, "comparison"],
    ]);
    expect(bindGroupLayoutEntries({ ok: true, textures: [] })).toEqual([]);
  });
});

describe("时钟与节流", () => {
  it("暂停期间不走时，恢复后接着走", () => {
    let now = 1000;
    const clock = new PausableClock(() => now);
    expect(clock.seconds()).toBe(0);
    clock.resume();
    now += 2000;
    clock.pause();
    now += 5000;
    expect(clock.seconds()).toBe(2);
    clock.resume();
    clock.resume();
    now += 500;
    expect(clock.seconds()).toBe(2.5);
    expect(clock.running).toBe(true);
  });
  it("144 Hz 回调节流到约 60 fps，不节流时每帧都画", () => {
    const throttle = new FrameThrottle(60);
    let frames = 0;
    for (let i = 0; i < 1440; i++) if (throttle.ready(i * (1000 / 144))) frames++;
    expect(frames).toBeGreaterThan(560);
    expect(frames).toBeLessThanOrEqual(601);
    const open = new FrameThrottle(0);
    expect([0, 1, 2].every((t) => open.ready(t))).toBe(true);
    const sixty = new FrameThrottle(60);
    let all = 0;
    for (let i = 0; i < 600; i++) if (sixty.ready(i * (1000 / 60) + (i % 2 ? 0.4 : -0.4))) all++;
    expect(all).toBe(600);
  });
});

describe("可渲染性自查", () => {
  const base: SceneBundle = {
    general: {
      width: 1,
      height: 1,
      clearColor: [0, 0, 0],
      clearEnabled: true,
      camera: { eye: [], center: [], up: [] },
      ambient: [0, 0, 0],
      skylight: [0, 0, 0],
      postprocess: { level: "disabled", bloom: false, hdr: false },
    },
    layers: [],
    programs: [{ ok: true } as TranslateResult],
    textures: [texture({ format: 4, mips: [{ width: 4, height: 4, bytes: new Uint8Array(16) }] })],
    unsupported: [],
  };
  const pass = {
    program: 0,
    blending: "normal",
    cullmode: "nocull",
    depthtest: "disabled",
    depthwrite: "disabled",
    textures: { 0: 0 },
    runtime: {},
    uniforms: {},
    framebuffer: false,
  };
  const layer = {
    id: 1,
    name: "a",
    origin: [0, 0, 0],
    scale: [1, 1, 1],
    angles: [0, 0, 0],
    size: [1, 1],
    alpha: 1,
    color: [1, 1, 1],
    visible: true,
    passes: [pass],
    colorBlendMode: 0,
    effects: [],
    passthrough: null,
  };
  it("缺 BC、多 pass、缺程序、unsupported 原样带上", () => {
    const bc = new Set(["texture-compression-bc"]);
    expect(checkRenderable({ ...base, layers: [layer] }, bc)).toEqual([]);
    expect(checkRenderable({ ...base, layers: [layer] }, new Set())).toEqual(["webgpu:no-bc"]);
    expect(checkRenderable({ ...base, layers: [{ ...layer, passes: [pass, pass] }] }, bc)).toEqual([
      "render:multi-pass",
    ]);
    expect(checkRenderable({ ...base, layers: [{ ...layer, passes: [{ ...pass, program: null }] }] }, bc)).toEqual([
      "render:no-program",
    ]);
    expect(checkRenderable({ ...base, unsupported: ["object:particle"] }, bc)).toEqual(["object:particle"]);
    expect(checkRenderable({ ...base, layers: [{ ...layer, visible: false, passes: [pass, pass] }] }, bc)).toEqual([]);
  });
  it("错误整理成原因键", () => {
    expect(reasonsOf(new SceneRenderError(["a", "b"]), "x")).toEqual(["a", "b"]);
    expect(reasonsOf(new Error("坏了\n  第二行"), "compile")).toEqual(["compile:坏了 第二行"]);
  });
});

// 本机语料：只读编译 P1 三张样本，在 Node 里走一遍渲染器的纯逻辑部分（上传布局、顶点布局、uniform 打包、几何）。
const root = process.env.KABEGAME_WPE_ROOT;
const wasm = join(__dirname, "..", "wpesl2wgsl", "wpesl2wgsl.wasm");
const reader: SceneReader = {
  async readWhole(path) {
    try {
      return new Uint8Array(readFileSync(path));
    } catch {
      throw new TypeError("Failed to fetch");
    }
  },
  async readRange(path, start, end) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch {
      throw new TypeError("Failed to fetch");
    }
    if (start >= bytes.length) throw new TypeError("Failed to fetch");
    return new Uint8Array(bytes.subarray(start, end));
  },
};

describe.skipIf(!root || !existsSync(wasm))("本机 P1 样本的渲染准备", () => {
  it.each(["eagleflag", "deep_space", "beach"])(
    "%s",
    async (sample) => {
      const translator = await Wpesl2wgsl.fromBytes(readFileSync(wasm));
      const bundle = await compileScene({
        projectDir: join(root!, "projects", "defaultprojects", sample),
        sceneAssets: [join(root!, "assets")],
        reader,
        translator,
        userProperties: sample === "eagleflag" ? { flagcolor2: "0 0 1" } : {},
      });
      expect(checkRenderable(bundle, new Set(["texture-compression-bc"]))).toEqual([]);
      for (const tex of bundle.textures) expect(planTextureUpload(tex).length, tex.path).toBe(tex.mips.length);
      const vp = sceneViewProjection(bundle.general);
      for (const layer of bundle.layers) {
        const pass = layer.passes[0];
        const program = bundle.programs[pass.program!];
        const packing = vertexPacking(program.attributes ?? []);
        expect(packing.layout.arrayStride).toBe(20);
        const block = new UniformBlock((program.uniforms ?? []) as UniformEntry[], program.uniformBlockSize);
        for (const [name, values] of Object.entries(pass.uniforms)) block.set(name, values);
        expect(block.data.byteLength % 16).toBe(0);
        expect(block.data.byteLength).toBeGreaterThanOrEqual(program.uniformBlockSize ?? 0);
        expect(block.has("g_ModelViewProjectionMatrix")).toBe(true);
        // 每张纹理都绑在着色器声明过的槽位上
        for (const slot of Object.keys(pass.textures).map(Number))
          expect(program.textures?.some((t) => t.slot === slot && t.kind === "2d")).toBe(true);
        // 图层中心落在场景里
        const center = ndc(multiply(vp, layerModelMatrix(layer)), 0, 0);
        expect(Math.abs(center[0])).toBeLessThan(1);
        expect(Math.abs(center[1])).toBeLessThan(1);
      }
      if (sample === "eagleflag") {
        // 用户属性覆盖 flagcolor2 → g_Color3（材质 usershadervalues）
        expect(bundle.layers[0].passes[0].uniforms.g_Color3).toEqual([0, 0, 1]);
        const block = new UniformBlock(
          bundle.programs[0].uniforms as UniformEntry[],
          bundle.programs[0].uniformBlockSize,
        );
        block.set("g_Color3", bundle.layers[0].passes[0].uniforms.g_Color3);
        const color3 = bundle.programs[0].uniforms!.find((u) => u.name === "g_Color3")!;
        expect(Array.from(new Float32Array(block.data, color3.offset, 3))).toEqual([0, 0, 1]);
      }
      if (sample === "deep_space") {
        // flowmask 480×270 放在 512×512 里：纹理坐标收缩到实际图像
        const flow = bundle.textures.find((t) => t.path === "materials/flowmask.tex")!;
        close(textureUvExtent(flow), [480 / 512, 270 / 512]);
      }
    },
    60000,
  );
});

describe.skipIf(!root || !existsSync(wasm))("本机 P2a 样本的渲染准备", () => {
  it("razer_vortex：每层基础 pass → 合成 RT → tint 上屏，合成 RT 按图像尺寸", async () => {
    const translator = await Wpesl2wgsl.fromBytes(readFileSync(wasm));
    const bundle = await compileScene({
      projectDir: join(root!, "projects", "defaultprojects", "razer_vortex"),
      sceneAssets: [join(root!, "assets")],
      reader,
      translator,
      postprocess: "disabled",
    });
    expect(bundle.unsupported).toEqual([]);
    // 主线程解码的替身：位图尺寸就是 mip 表里的尺寸
    for (const texture of bundle.textures)
      if (texture.encoded)
        texture.mips = texture.encoded.mips.map((_, level) => ({
          width: mipSize(texture.textureWidth, level),
          height: mipSize(texture.textureHeight, level),
          bitmap: {} as ImageBitmap,
        }));
    expect(checkRenderable(bundle, new Set(["texture-compression-bc"]))).toEqual([]);
    const vortex = bundle.textures.find((t) => t.path === "materials/vortex.tex")!;
    expect(planBitmapUpload(vortex)).toBe(7);
    const plans = bundle.layers.map((layer) => planLayer(layer, bundle.textures));
    expect(plans.map((plan) => plan.composite)).toEqual([
      { count: 1, width: 3840, height: 2160 },
      { count: 1, width: 219, height: 216 },
      { count: 1, width: 64, height: 32 },
    ]);
    for (const [index, plan] of plans.entries()) {
      const steps = plan.steps.filter((step) => step.kind === "draw");
      expect(steps.map((step) => step.role)).toEqual(["base", "final"]);
      // 上屏借基础材质的 blend：vortex 是 normal，THS / led 是 translucent
      expect(steps[1].blending).toBe(bundle.layers[index].passes[0].blending);
      expect(steps[0].blending).toBeNull();
      const program = bundle.programs[steps[1].pass.program!];
      const block = new UniformBlock((program.uniforms ?? []) as UniformEntry[], program.uniformBlockSize);
      expect(block.has("g_Texture0Resolution")).toBe(true);
      expect(program.textures?.map((t) => t.slot)).toEqual([0, 1]);
    }
    // THS：219×216 放在 256×256 里，基础 pass 只采样有效区域
    const ths = plans[1].steps.find((step) => step.kind === "draw" && step.role === "base");
    if (ths?.kind === "draw") close(ths.uv, [219 / 256, 216 / 256]);
  }, 60000);
});
