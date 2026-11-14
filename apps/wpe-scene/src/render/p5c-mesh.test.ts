/**
 * P5c 步骤 2 的渲染侧单测（`.claude/plans/wpe-import/3-scene/phase5/phase-5c-mesh.md`「步骤 2」点 5），依据 p5-REPORT「P5c 语义的实测核对」：
 * - 渲染图（`planModelLayer`）：步骤顺序同 `model.order`、混合、输入、没有 pass 的网格跳过、没有合成 RT；
 * - 顶点布局（`meshVertexLayout`）：`p5c-layout` 两种格式与 0x8009 的偏移、格式、`shaderLocation` 按语义配对（`ignore/p5/c0/out/ana_c.txt`），
 *   同语义不同宽度（M1、M4）、占位属性（M3）、类型不符进 `problems`；
 * - 法线矩阵（`normalMatrix`）：`p5c-matrix` 三个模型和 WPE 抓帧（`ignore/p5/c0/out/dump_c.json`）逐位相同；
 * - 视锥剔除（`frustumCulled`）：`p5c-frustum` 的 F1–F10（`ignore/p5/c0/gen_c.py` 的 `p_frustum`）逐个得到 WPE 的结果；
 * - 管线键：已有规格的键逐字不变，`mesh` / `cull` 各加后缀；
 * - GpuScene 假设备：op、管线（三角形列表、顶点布局、剔除）、共用的网格缓冲与补齐的索引、占位缓冲、编码轨迹、视锥剔除、uniform
 *   （颜色组固定 1、MVP、透视、视差、法线矩阵、材质常量）；
 * - 本机有 WPE 时：retro 编译后渲染器自查通过。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generalDefaults } from "../compile/bindings";
import { compileScene, type SceneBundle, type SceneLayer, type SceneMesh, type ScenePass } from "../compile/bundle";
import type { SceneReader } from "../compile/fs";
import { mdlStride } from "../compile/mdl";
import { particleFov } from "../compile/particles";
import { BLOOM_DEFAULTS } from "../compile/postprocess";
import { Wpesl2wgsl, type InterfaceVariable, type TranslateResult } from "../wpesl2wgsl";
import { planLayer, planModelLayer, planSignature } from "./graph";
import { particleViewProjection, sceneViewProjection, worldMatrixOf, type LayerTransform } from "./layout";
import { multiply, normalMatrix, translation, type Mat4 } from "./math";
import { alignedBytes, frustumCulled, frustumPlanes, meshVertexLayout } from "./mesh";
import { parallaxOffset } from "./parallax";
import { checkRenderable, GpuScene, pipelineKey, stepPipeline } from "./scene";
import { SceneState } from "./state";
import type { FrameInput } from "./uniforms";

vi.mock("./device", () => ({ acquireGpu: vi.fn() }));
vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

// ———— 手写的模型图层 ————

function pass(key: string, extra: Partial<ScenePass> = {}): ScenePass {
  return {
    key,
    program: 0,
    blending: "translucent",
    cullmode: "nocull",
    depthtest: "enabled",
    depthwrite: "disabled",
    textures: {},
    runtime: {},
    uniforms: {},
    framebuffer: false,
    ...extra,
  };
}

/** 一块 mdl 文件缓冲上的网格视图：顶点 `vertexCount` 个、索引 `indices`（u16）。几个网格可以共用 `buffer`。 */
function meshOf(
  buffer: ArrayBuffer,
  at: number,
  format: number,
  vertexCount: number,
  indices: number[],
  passes: ScenePass[],
): { mesh: SceneMesh; end: number } {
  const stride = mdlStride(format);
  const vertices = new Uint8Array(buffer, at, stride * vertexCount);
  // 顶点字节填上可辨认的内容（上传后逐字节比）
  vertices.forEach((_, i) => (vertices[i] = (at + i) & 0xff));
  const indexBytes = new Uint8Array(buffer, at + vertices.byteLength, indices.length * 2);
  const view = new DataView(buffer);
  indices.forEach((value, i) => view.setUint16(indexBytes.byteOffset + 2 * i, value, true));
  return {
    mesh: {
      format,
      stride,
      vertices,
      indices: indexBytes,
      vertexCount,
      indexFormat: "uint16",
      indexCount: indices.length,
      material: "materials/m.json",
      passes,
    },
    end: indexBytes.byteOffset + indexBytes.byteLength,
  };
}

interface ModelDef {
  meshes: SceneMesh[];
  order?: number[];
  bounds?: number[];
  origin?: number[];
  scale?: number[];
  angles?: number[];
  color?: number[];
  alpha?: number;
  brightness?: number;
  perspective?: boolean;
  parent?: number | null;
}

function modelLayer(object: number, name: string, def: ModelDef): SceneLayer {
  return {
    id: object + 10,
    object,
    parent: def.parent ?? null,
    name,
    origin: def.origin ?? [960, 540, 0],
    scale: def.scale ?? [1, 1, 1],
    angles: def.angles ?? [0, 0, 0],
    size: [0, 0],
    alpha: def.alpha ?? 1,
    color: def.color ?? [1, 1, 1],
    brightness: def.brightness ?? 1,
    visible: true,
    visibleBound: false,
    parallaxDepth: [1, 1],
    solidLayer: false,
    instanced: false,
    noPadding: false,
    perspective: def.perspective ?? false,
    passthroughModel: false,
    group: null,
    subtree: [],
    groupUpload: null,
    copyBackground: true,
    fullscreen: false,
    fullscreenSize: null,
    clampUVs: false,
    noInterpolation: false,
    passes: [],
    colorBlendMode: 0,
    effects: [],
    passthrough: null,
    particle: null,
    model: {
      path: `models/${name}.mdl`,
      version: 23,
      meshes: def.meshes,
      order: def.order ?? def.meshes.map((_, i) => i),
      bounds: def.bounds ?? [-131072, -131072, -131072, 131072, 131072, 131072],
    },
  };
}

// ———— 渲染图 ————

describe("planModelLayer：每个网格一个 mesh 步骤（P5c 步骤 2 点 1）", () => {
  const buffer = new ArrayBuffer(4096);
  const a = meshOf(buffer, 0, 0x9, 4, [0, 1, 2], [pass("objects/0/meshes/0/passes/0")]);
  const b = meshOf(
    buffer,
    128,
    0x9,
    4,
    [0, 1, 2],
    [
      pass("objects/0/meshes/1/passes/0", {
        blending: "normal",
        textures: { 0: 3 },
        runtime: { 1: "_rt_FullFrameBuffer" },
      }),
    ],
  );
  const empty = meshOf(buffer, 256, 0x9, 4, [0, 1, 2], []);
  const layer = modelLayer(0, "m", { meshes: [a.mesh, b.mesh, empty.mesh], order: [1, 2, 0] });

  it("顺序取 model.order、跳过没有 pass 的网格；直接画到场景、没有合成 RT；混合与输入取 pass 的", () => {
    const plan = planModelLayer(layer);
    expect(plan.composite).toBeNull();
    expect(plan.reasons).toEqual([]);
    expect(plan.steps).toEqual([
      {
        kind: "mesh",
        mesh: 1,
        pass: b.mesh.passes[0],
        target: { kind: "scene" },
        inputs: { 0: { kind: "texture", index: 3 }, 1: { kind: "framebuffer" } },
        blending: "normal",
        // P5d 步骤 1：两项都取自己的 pass（depthtest enabled、depthwrite disabled、nocull）
        raster: { test: true, write: false, cull: false },
      },
      {
        kind: "mesh",
        mesh: 0,
        pass: a.mesh.passes[0],
        target: { kind: "scene" },
        inputs: {},
        blending: "translucent",
        raster: { test: true, write: false, cull: false },
      },
    ]);
    // `planLayer` 对模型层走这里；签名带 pass 键
    expect(planLayer(layer, [])).toEqual(plan);
    expect(planSignature(plan)).toContain('"pass":"objects/0/meshes/1/passes/0"');
  });

  it("没有快照步骤（WPE 的模型绘制不拷快照，编译期报 mdl:framebuffer）；别的运行时纹理、多 pass 进 reasons", () => {
    expect(planModelLayer(layer).steps.some((step) => step.kind === "snapshot")).toBe(false);
    const odd = meshOf(
      buffer,
      384,
      0x9,
      4,
      [0, 1, 2],
      [pass("objects/0/meshes/0/passes/0", { runtime: { 0: "_rt_Unknown" } }), pass("objects/0/meshes/0/passes/1")],
    );
    expect(planModelLayer(modelLayer(0, "m", { meshes: [odd.mesh] })).reasons).toEqual([
      "render:multi-pass",
      "render:texture-rt:_rt_Unknown",
    ]);
    expect(planModelLayer({ model: null })).toEqual({ composite: null, steps: [], reasons: [] });
  });
});

// ———— 顶点布局 ————

const attribute = (name: string, type: string, location: number, extra: Partial<InterfaceVariable> = {}) => ({
  name,
  type,
  location,
  ...extra,
});
/** `[location, offset, format]`，按顶点缓冲里的顺序。 */
const attributesOf = (layout: GPUVertexBufferLayout) =>
  [...layout.attributes].map((item) => [item.shaderLocation, item.offset, item.format]);

describe("meshVertexLayout：按网格格式建顶点布局（P5c 步骤 2 点 2）", () => {
  it("p5c-layout 的格式 0x344988f：12 个属性的偏移与 stride 156 照表序（ana_c.txt），location 照程序", () => {
    // 程序按和表序不同的顺序声明，location 照程序
    const names: [string, string][] = [
      ["a_Color", "vec4"],
      ["a_TexCoordVec4C5", "vec4"],
      ["a_TexCoordVec3C4", "vec3"],
      ["a_TexCoordC3", "vec2"],
      ["a_TexCoordVec4C2", "vec4"],
      ["a_TexCoordVec3C1", "vec3"],
      ["a_TexCoord", "vec2"],
      ["a_BlendWeights", "vec4"],
      ["a_Tangent4", "vec4"],
      ["a_Normal", "vec3"],
      ["a_PositionC1", "vec3"],
      ["a_Position", "vec3"],
    ];
    const layout = meshVertexLayout(
      names.map(([name, type], location) => attribute(name, type, location)),
      0x344988f,
    );
    expect(layout.problems).toEqual([]);
    expect(layout.placeholders).toBe(0);
    expect(layout.buffers).toHaveLength(1);
    expect(layout.buffers[0].arrayStride).toBe(156);
    const byName = new Map(attributesOf(layout.buffers[0]).map((item) => [names[item[0] as number][0], item.slice(1)]));
    expect(Object.fromEntries(byName)).toEqual({
      a_Position: [0, "float32x3"],
      a_PositionC1: [12, "float32x3"],
      a_Normal: [24, "float32x3"],
      a_Tangent4: [36, "float32x4"],
      a_BlendWeights: [52, "float32x4"],
      a_TexCoord: [68, "float32x2"],
      a_TexCoordVec3C1: [76, "float32x3"],
      a_TexCoordVec4C2: [88, "float32x4"],
      a_TexCoordC3: [104, "float32x2"],
      a_TexCoordVec3C4: [112, "float32x3"],
      a_TexCoordVec4C5: [124, "float32x4"],
      a_Color: [140, "float32x4"],
    });
  });

  it("p5c-layout 的格式 0xa34460（stride 104，BlendIndices 是 uint32x4）与 0x8009（stride 36）", () => {
    const layout = meshVertexLayout(
      [
        attribute("a_PositionVec4", "vec4", 0),
        attribute("a_BlendIndices", "uvec4", 1),
        attribute("a_TexCoordVec4", "vec4", 2),
        attribute("a_TexCoordC1", "vec2", 3),
        attribute("a_TexCoordVec3C2", "vec3", 4),
        attribute("a_TexCoordVec4C3", "vec4", 5),
        attribute("a_TexCoordC4", "vec2", 6),
        attribute("a_TexCoordVec3C5", "vec3", 7),
      ],
      0xa34460,
    );
    expect(layout.buffers[0].arrayStride).toBe(104);
    expect(attributesOf(layout.buffers[0])).toEqual([
      [0, 0, "float32x4"],
      [1, 16, "uint32x4"],
      [2, 32, "float32x4"],
      [3, 48, "float32x2"],
      [4, 56, "float32x3"],
      [5, 68, "float32x4"],
      [6, 84, "float32x2"],
      [7, 92, "float32x3"],
    ]);
    const c = meshVertexLayout(
      [attribute("a_Position", "vec3", 0), attribute("a_TexCoord", "vec2", 1), attribute("a_Color", "vec4", 2)],
      0x8009,
    );
    expect(c.buffers[0].arrayStride).toBe(36);
    expect(attributesOf(c.buffers[0])).toEqual([
      [0, 0, "float32x3"],
      [1, 12, "float32x2"],
      [2, 20, "float32x4"],
    ]);
  });

  it("同语义不同宽度共用一个槽：M1（网格 TexCoordVec4、着色器 vec2）读 xy，M4（网格 vec2、着色器 vec4）由 WebGPU 补 (0, 1)", () => {
    // M1：格式 0x21 = 位置 + a_TexCoordVec4；格式按数据（float32x4），WebGPU 截断成着色器的 vec2
    const m1 = meshVertexLayout([attribute("a_Position", "vec3", 0), attribute("a_TexCoord", "vec2", 1)], 0x21);
    expect(attributesOf(m1.buffers[0])).toEqual([
      [0, 0, "float32x3"],
      [1, 12, "float32x4"],
    ]);
    // M4：格式 0x9，着色器 vec4 a_TexCoordVec4 读 vec2 数据
    const m4 = meshVertexLayout([attribute("a_Position", "vec3", 0), attribute("a_TexCoordVec4", "vec4", 1)], 0x9);
    expect(attributesOf(m4.buffers[0])).toEqual([
      [0, 0, "float32x3"],
      [1, 12, "float32x2"],
    ]);
    // POSITION0 的两种宽度同样共用
    expect(attributesOf(meshVertexLayout([attribute("a_PositionVec4", "vec4", 0)], 0x9).buffers[0])).toEqual([
      [0, 0, "float32x3"],
    ]);
  });

  it("网格没有的属性接占位缓冲（槽 1，arrayStride 0，按着色器类型、每个 16 字节）：M3 的 a_Normal 没读；读了的强制渲染时也接（编译期已报）", () => {
    const m3 = meshVertexLayout(
      [
        attribute("a_Position", "vec3", 0),
        attribute("a_TexCoord", "vec2", 1),
        attribute("a_Normal", "vec3", 2, { unused: true }),
        attribute("a_Color", "vec4", 3),
        attribute("a_Custom", "mat2", 4, { unused: true }),
      ],
      0x9,
    );
    expect(m3.problems).toEqual([]);
    expect(m3.placeholders).toBe(4);
    expect(m3.buffers).toHaveLength(2);
    expect(m3.buffers[1].arrayStride).toBe(0);
    expect(m3.buffers[1].stepMode).toBe("vertex");
    // 矩阵按列展开成连续 location
    expect(attributesOf(m3.buffers[1])).toEqual([
      [2, 0, "float32x3"],
      [3, 16, "float32x4"],
      [4, 32, "float32x2"],
      [5, 48, "float32x2"],
    ]);
    expect(m3.key).toBe("20:0@0:float32x3,1@12:float32x2|0:2@0:float32x3,3@16:float32x4,4@32:float32x2,5@48:float32x2");
  });

  it("分量类型对不上：读了的进 problems（编译期报 mdl:attribute-type），没读的接占位；不认识的类型照 vertexPacking 报", () => {
    const used = meshVertexLayout([attribute("a_BlendIndices", "vec4", 0)], 0x800009);
    expect(used.problems).toEqual(["render:mesh-attribute-type:a_BlendIndices"]);
    const unused = meshVertexLayout([attribute("a_BlendIndices", "vec4", 0, { unused: true })], 0x800009);
    expect(unused.problems).toEqual([]);
    expect(attributesOf(unused.buffers[1])).toEqual([[0, 0, "float32x4"]]);
    expect(meshVertexLayout([attribute("a_Position", "dvec3", 0)], 0x9).problems).toEqual([
      "render:attribute:a_Position:dvec3",
    ]);
  });

  it("布局键：同一个程序、同一个格式相同，格式不同则不同", () => {
    const attributes = [attribute("a_Position", "vec3", 0), attribute("a_TexCoord", "vec2", 1)];
    expect(meshVertexLayout(attributes, 0x9).key).toBe(meshVertexLayout(attributes, 0x9).key);
    expect(meshVertexLayout(attributes, 0x9).key).toBe("20:0@0:float32x3,1@12:float32x2");
    expect(meshVertexLayout(attributes, 0xb).key).toBe("32:0@0:float32x3,1@24:float32x2");
  });

  it("alignedBytes：u16 索引奇数个时拷一份补到 4 字节，对齐的原样返回（不拷贝）", () => {
    const buffer = new ArrayBuffer(16);
    const odd = new Uint8Array(buffer, 2, 6);
    odd.set([1, 2, 3, 4, 5, 6]);
    expect(Array.from(alignedBytes(odd))).toEqual([1, 2, 3, 4, 5, 6, 0, 0]);
    const even = new Uint8Array(buffer, 2, 8);
    expect(alignedBytes(even)).toBe(even);
    expect(alignedBytes(new Uint8Array(0)).byteLength).toBe(4);
  });
});

// ———— 法线矩阵 ————

/** `p5c-matrix` 三个模型（`ignore/p5/proj/p5c-matrix/scene.json`）在 WPE 抓帧里的 `g_ModelMatrix` 与 `g_NormalModelMatrix`（列主序，float32）。 */
const WPE_MATRIX = {
  X1: {
    model: [
      1.1472632884979248, 0.9663265943527222, 0.0, 0.0, -3.6926681995391846, 4.384089946746826, 1.182080864906311, 0.0,
      0.28556904196739197, -0.33903950452804565, 0.9553365111351013, 0.0, 915.848388671875, 937.0419921875, 0.0, 1.0,
    ],
    normal: [
      0.7639689445495605, 0.6434822082519531, 0.0, -0.6304712891578674, 0.7485218644142151, 0.20182372629642487,
      0.27110177278518677, -0.3218633532524109, 0.9069380164146423,
    ],
  },
  X2: {
    model: [
      0.9362934231758118, 0.1897960603237152, -0.29552021622657776, 0.0, -0.0008635222911834717, 1.6840689182281494,
      1.0788471698760986, 0.0, 0.35121867060661316, -0.5049310922622681, 0.7884732484817505, 0.0, 1300.0, 500.0, 0.0,
      1.0,
    ],
    normal: [
      0.9347093105316162, 0.189474955201149, -0.2950202226638794, -0.0004310306685511023, 0.8406098484992981,
      0.5385109186172485, 0.3506244421005249, -0.5040768384933472, 0.7871392369270325,
    ],
  },
  X3: {
    model: [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 1, 0, 1500, 850, 0, 1],
    normal: [0.9983081221580505, 0, 0, 0, 0.9988583326339722, 0, 0, 0, 0.9983081221580505],
  },
} as const;

describe("normalMatrix：WPE 的三个轴各自归一化（快速倒数平方根，P5c 步骤 2 点 3）", () => {
  it("输入 WPE 的 g_ModelMatrix：三个模型 27 个值逐位相同（ana_c.txt：精确归一化差 0.9e-3–1.7e-3，逆转置差 0.4–0.67）", () => {
    for (const [name, { model, normal }] of Object.entries(WPE_MATRIX))
      expect(normalMatrix(new Float32Array(model)), name).toEqual([...normal]);
  });

  it("按 scene.json 的变换走 worldMatrixOf（X1 挂在带变换的分组 G 下）：和 WPE 逐项差 ≤ 2e-7", () => {
    // `p5c-matrix` 的对象：G（20）、X1（21，父 G）、X2（22，perspective）、X3（23）
    const layers = new Map<number, LayerTransform>([
      [20, { origin: [300, 200, 0], scale: [1.5, 1.5, 1], angles: [0, 0, 0.2], visible: true, parent: null }],
      [21, { origin: [500, 400, 0], scale: [1, 4, 1], angles: [0.3, 0, 0.5], visible: true, parent: 20 }],
      [22, { origin: [1300, 500, 0], scale: [1, 2, 1], angles: [0.6, 0.3, 0.2], visible: true, parent: null }],
      [23, { origin: [1500, 850, 0], scale: [2, 3, 1], angles: [0, 0, 0], visible: true, parent: null }],
    ]);
    const worlds = new Map<number, Mat4>();
    for (const [object, name] of [
      [21, "X1"],
      [22, "X2"],
      [23, "X3"],
    ] as const) {
      const actual = normalMatrix(worldMatrixOf(object, layers, worlds));
      actual.forEach((value, i) =>
        expect(Math.abs(value - WPE_MATRIX[name].normal[i]), `${name}[${i}]`).toBeLessThanOrEqual(2e-7),
      );
    }
  });

  it("长度为 0 的轴得到 0、不出 NaN", () => {
    const m = new Float32Array([0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const out = normalMatrix(m);
    expect(out.slice(0, 3)).toEqual([0, 0, 0]);
    expect(out.every(Number.isFinite)).toBe(true);
  });
});

// ———— 视锥剔除 ————

/**
 * `p5c-frustum`（`ignore/p5/c0/gen_c.py` 的 `p_frustum`）：场景正交 1920×1080，每个对象一个 v23 网格（F2 是 v14、没有包围盒），包围盒
 * 中心 `(cx, cy, cz)`、xy 半边长 50、z 半厚 `hz`（缺省同 50）；对象原点见 `origin`。WPE 画了 F2、F3、F4、F6、F8、F9，没画 F1、F5、F7、F10。
 */
const FRUSTUM_CASES: [name: string, box: [number, number, number, number?] | null, origin: number, drawn: boolean][] = [
  ["F1", [100000, 500, 0], 0, false], // 包围盒在场景外
  ["F2", null, 0, true], // 同几何、v14 没有包围盒（±131072）
  ["F3", [950, 550, 0], 0, true], // 包围盒在场景内
  ["F4", [0, 540, 0], 0, true], // 跨左边缘
  ["F5", [950, 550, 5000], 0, false], // xy 在内、z 远在 ±2000 外
  ["F6", [100000, 500, 0], -99000, true], // 包围盒在外、对象平移回场景内
  ["F7", [-160, 540, 0], 0, false], // 左边缘外 110–210，外接球也在外
  ["F8", [-70, 540, 0], 0, true], // 立方体 −120…−20，球半径 86.6 伸到 +16.6
  ["F9", [-60, 540, 0, 0], 0, true], // 扁盒 −110…−10，球半径 70.7 伸到 +10.7
  ["F10", [-75, 540, 0, 0], 0, false], // 扁盒 −125…−25，球半径 70.7 只到 −4.3
];

describe("frustumCulled：外接球对六个平面（P5c 步骤 2 点 3，p5c-frustum 的 F1–F10）", () => {
  const vp = sceneViewProjection({ width: 1920, height: 1080 });
  it.each(FRUSTUM_CASES)("%s", (_name, box, origin, drawn) => {
    const bounds = box
      ? [box[0] - 50, box[1] - 50, box[2] - (box[3] ?? 50), box[0] + 50, box[1] + 50, box[2] + (box[3] ?? 50)]
      : [-131072, -131072, -131072, 131072, 131072, 131072];
    expect(frustumCulled(bounds, translation(origin, 0, 0), vp)).toBe(!drawn);
  });

  it("平面：正交场景的左、右、下、上、近、远归一化后就是 x、1920 − x、y、1080 − y、z + 2000、2000 − z", () => {
    const normalized = frustumPlanes(vp).map(([a, b, c, d]) => {
      const length = Math.hypot(a, b, c);
      return [a, b, c, d].map((value) => Math.round((value / length) * 1e3) / 1e3);
    });
    expect(normalized).toEqual([
      [1, 0, 0, 0],
      [-1, 0, 0, 1920],
      [0, 1, 0, 0],
      [0, -1, 0, 1080],
      [0, 0, 1, 2000],
      [0, 0, -1, 2000],
    ]);
  });

  it("包围盒经世界矩阵变换（放大后再取两个角的外接球）", () => {
    // 原点在场景外 200 像素、盒子半边 50：不缩放时被剔，放大 5 倍后半径伸进场景
    const bounds = [-50, -50, -50, 50, 50, 50];
    expect(frustumCulled(bounds, translation(-200, 540, 0), vp)).toBe(true);
    expect(
      frustumCulled(
        bounds,
        multiply(translation(-200, 540, 0), new Float32Array([5, 0, 0, 0, 0, 5, 0, 0, 0, 0, 5, 0, 0, 0, 0, 1])),
        vp,
      ),
    ).toBe(false);
  });
});

// ———— 管线 ————

describe("pipelineKey / stepPipeline：网格多两项（P5c 步骤 2 点 2）", () => {
  it("已有规格的键逐字不变", () => {
    const base = { program: 3, blending: "translucent", format: "rgba8unorm" as const, alpha: false };
    expect(pipelineKey({ ...base, topology: "triangle-strip" })).toBe("3|translucent|rgba8unorm|false");
    expect(pipelineKey({ ...base, topology: "triangle-list" })).toBe("3|translucent|rgba8unorm|false|list");
    expect(pipelineKey({ ...base, topology: "triangle-strip", alphaMax: true })).toBe(
      "3|translucent|rgba8unorm|false|max",
    );
  });

  it("网格：三角形列表、画到场景不写 alpha、带布局键；cullmode normal 时剔背面，nocull 不剔", () => {
    const step = (cullmode: string) => ({
      kind: "mesh" as const,
      mesh: 0,
      pass: pass("objects/0/meshes/0/passes/0", { cullmode }),
      target: { kind: "scene" as const },
      inputs: {},
      blending: "translucent",
      raster: { test: true, write: false, cull: cullmode !== "nocull" },
    });
    const normal = stepPipeline(step("normal"), "rgba8unorm", () => "rgba8unorm", false, null, "20:0@0:float32x3");
    expect(normal).toEqual({
      program: 0,
      blending: "translucent",
      format: "rgba8unorm",
      alpha: false,
      topology: "triangle-list",
      mesh: "20:0@0:float32x3",
      cull: "back",
    });
    expect(pipelineKey(normal)).toBe("0|translucent|rgba8unorm|false|list|mesh:20:0@0:float32x3|cull:back");
    const nocull = stepPipeline(step("nocull"), "rgba8unorm", () => "rgba8unorm", false, null, "20:0@0:float32x3");
    expect(nocull.cull).toBeUndefined();
    expect(pipelineKey(nocull)).toBe("0|translucent|rgba8unorm|false|list|mesh:20:0@0:float32x3");
  });
});

// ———— GpuScene：假设备 ————

interface FakeBuffer {
  label: string;
  bytes: Uint8Array;
  usage: number;
  destroy(): void;
}

/** 假设备：缓冲字节、建管线的描述，以及一帧的编码轨迹（目标、管线、顶点 / 索引缓冲、绘制）。 */
class FakeGpu {
  readonly trace: string[] = [];
  readonly pipelines: GPURenderPipelineDescriptor[] = [];
  readonly buffers: FakeBuffer[] = [];
  readonly device: GPUDevice;

  constructor() {
    const trace = this.trace;
    const renderPass = () => ({
      setViewport() {},
      setPipeline(pipeline: { label: string }) {
        trace.push(`  pipeline ${pipeline.label}`);
      },
      setBindGroup() {},
      setVertexBuffer(slot: number, buffer: FakeBuffer) {
        trace.push(`  vertices#${slot} ${buffer.label} ${buffer.bytes.byteLength}`);
      },
      setIndexBuffer(buffer: FakeBuffer, format: string) {
        trace.push(`  indices ${buffer.label} ${format} ${buffer.bytes.byteLength}`);
      },
      draw(count: number) {
        trace.push(`  draw ${count}`);
      },
      drawIndexed(count: number) {
        trace.push(`  drawIndexed ${count}`);
      },
      end() {},
    });
    this.device = {
      limits: { maxTextureDimension2D: 8192 },
      lost: new Promise(() => {}),
      destroy() {},
      createTexture: (descriptor: GPUTextureDescriptor) => ({
        label: descriptor.label ?? "",
        format: descriptor.format,
        createView: () => ({ label: descriptor.label ?? "" }),
        destroy() {},
      }),
      createSampler: () => ({}),
      createBuffer: (descriptor: GPUBufferDescriptor) => {
        const buffer = {
          label: descriptor.label ?? "",
          bytes: new Uint8Array(descriptor.size),
          usage: descriptor.usage,
          destroy() {},
        };
        this.buffers.push(buffer);
        return buffer;
      },
      createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
      createRenderPipelineAsync: async (descriptor: GPURenderPipelineDescriptor) => {
        this.pipelines.push(descriptor);
        return { label: `${descriptor.label} mask ${[...descriptor.fragment!.targets][0]?.writeMask}` };
      },
      createBindGroup: () => ({}),
      createCommandEncoder: () => ({
        beginRenderPass: (descriptor: GPURenderPassDescriptor) => {
          const attachment = [...descriptor.colorAttachments][0]!;
          const { label } = attachment.view as unknown as { label: string };
          trace.push(`pass ${label} ${attachment.loadOp}`);
          return renderPass();
        },
        copyTextureToTexture: (source: { texture: { label: string } }, target: { texture: { label: string } }) => {
          trace.push(`copy ${source.texture.label} -> ${target.texture.label}`);
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
          const bytes = ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : new Uint8Array(data);
          const chunk = bytes.subarray(dataOffset, size === undefined ? undefined : dataOffset + size);
          if (chunk.byteLength % 4) throw new Error(`writeBuffer 长度 ${chunk.byteLength} 不是 4 的倍数`);
          buffer.bytes.set(chunk, offset);
        },
        writeTexture() {},
        submit() {},
        onSubmittedWorkDone: async () => {},
      },
      pushErrorScope() {},
      popErrorScope: async () => null,
    } as unknown as GPUDevice;
  }
}

/** 网格程序：MVP（0）、g_Color4（64）、g_NormalModelMatrix（80，mat3 每列 16 字节）、g_Tint（128）；属性 `attributes`。 */
function meshProgram(name: string, attributes: InterfaceVariable[]): TranslateResult {
  return {
    ok: true,
    vertex: { wgsl: `// ${name} v`, entryPoint: "main" },
    fragment: { wgsl: `// ${name} f`, entryPoint: "main" },
    attributes,
    uniforms: [
      { name: "g_ModelViewProjectionMatrix", type: "mat4x4<f32>", declared: "mat4", offset: 0, size: 64 },
      { name: "g_Color4", type: "vec4<f32>", declared: "vec4", offset: 64, size: 16 },
      { name: "g_NormalModelMatrix", type: "mat3x3<f32>", declared: "mat3", offset: 80, size: 48 },
      { name: "g_Tint", type: "vec3<f32>", declared: "vec3", offset: 128, size: 12, meta: { material: "tint" } },
    ],
    uniformBlockSize: 144,
    textures: [],
  } as unknown as TranslateResult;
}

const PROGRAM = { plain: 0, normal: 1 } as const;

function bundleOf(layers: SceneLayer[], hdr = false): SceneBundle {
  return {
    general: {
      width: 1920,
      height: 1080,
      fields: generalDefaults(),
      clearVariable: false,
      perspectiveOverrideFov: particleFov(undefined),
      postprocess: { level: "disabled", bloomFlag: false, hdrFlag: hdr, bloom: false, hdr },
      bloom: { ...BLOOM_DEFAULTS, tint: [1, 1, 1] },
    },
    layers,
    programs: [
      meshProgram("plain", [attribute("a_Position", "vec3", 0), attribute("a_TexCoord", "vec2", 1)]),
      // M3 那样声明了 a_Normal 却没读：网格（0x9）没有法线，接占位
      meshProgram("normal", [
        attribute("a_Position", "vec3", 0),
        attribute("a_TexCoord", "vec2", 1),
        attribute("a_Normal", "vec3", 2, { unused: true }),
      ]),
    ],
    textures: [],
    bloom: null,
    unsupported: [],
    bindings: [],
    scripts: { list: [] },
  };
}

interface DrawView {
  object: number;
  label: string;
  step: { kind: string; mesh?: number };
  vertexBuffer: FakeBuffer;
  uniformBuffer: FakeBuffer | null;
  pipeline: { label: string };
  mesh: { indexBuffer: FakeBuffer; indexFormat: string; count: number; placeholder: FakeBuffer | null } | null;
}
interface RuntimeView {
  object: number;
  ops: { kind: string; draws?: DrawView[] }[];
}
const internals = (scene: GpuScene) => scene as unknown as { layers: RuntimeView[]; draws: Set<DrawView> };
function meshDraw(scene: GpuScene, object: number, mesh: number): DrawView {
  const draw = [...internals(scene).draws].find((item) => item.object === object && item.step.mesh === mesh);
  if (!draw) throw new Error(`图层 ${object} 没有网格 ${mesh} 的 draw`);
  return draw;
}
const floatsOf = (draw: DrawView, offset: number, count: number) =>
  Array.from(new Float32Array(draw.uniformBuffer!.bytes.buffer.slice(offset, offset + 4 * count)));
/** mat3 的 uniform（每列 16 字节）读回列主序 9 个数。 */
const mat3Of = (draw: DrawView, offset: number) => [0, 1, 2].flatMap((c) => floatsOf(draw, offset + 16 * c, 3));

const FRAME: FrameInput = {
  time: 1,
  frametime: 0.05,
  daytime: 0.5,
  pointer: [0.5, 0.5],
  pointerLast: [0.5, 0.5],
  cursor: [0.5, 0.5],
};

beforeEach(() => {
  vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_SRC: 4, COPY_DST: 8 });
  vi.stubGlobal("GPUBufferUsage", { VERTEX: 1, UNIFORM: 2, COPY_DST: 4, MAP_READ: 8, INDEX: 16 });
  vi.stubGlobal("GPUMapMode", { READ: 1 });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GpuScene：模型层（P5c 步骤 2 点 3）", () => {
  /**
   * 四层：A、B 用同一个 mdl（同一块文件缓冲上的同一组视图，3354366708 的两个圆环那样），A 两个网格（网格 0 translucent / normal 剔背面，
   * 网格 1 normal，顺序 [1, 0]、索引 3 个是奇数），B 写了 `color 1 0 0`、`alpha 0.5`、`brightness 3`；P 是 `perspective: true`；C 的
   * 包围盒在场景外（被视锥剔除）；N 的程序声明了没读的 a_Normal（占位）。
   */
  function scene(hdr = false) {
    const file = new ArrayBuffer(1024);
    const tint = { g_Tint: [0.72, 0.64, 0.42] };
    const m0 = meshOf(
      file,
      0,
      0x9,
      4,
      [0, 1, 2],
      [pass("objects/0/meshes/0/passes/0", { cullmode: "normal", uniforms: tint })],
    );
    const m1 = meshOf(
      file,
      m0.end,
      0x9,
      4,
      [0, 2, 3, 0, 1, 2],
      [pass("objects/0/meshes/1/passes/0", { blending: "normal", depthwrite: "disabled" })],
    );
    // B 的 pass 键各自一份（材质按对象各编一份），网格视图与 A 相同
    const shared = (object: number) => [
      { ...m0.mesh, passes: [pass(`objects/${object}/meshes/0/passes/0`, { cullmode: "normal", uniforms: tint })] },
      {
        ...m1.mesh,
        passes: [pass(`objects/${object}/meshes/1/passes/0`, { blending: "normal", depthwrite: "disabled" })],
      },
    ];
    const other = new ArrayBuffer(512);
    const perspective = meshOf(other, 0, 0x9, 4, [0, 1, 2, 0, 2, 3], [pass("objects/2/meshes/0/passes/0")]);
    const outside = meshOf(other, 128, 0x9, 4, [0, 1, 2, 0, 2, 3], [pass("objects/3/meshes/0/passes/0")]);
    const placeholder = meshOf(
      other,
      256,
      0x9,
      4,
      [0, 1, 2, 0, 2, 3],
      [pass("objects/4/meshes/0/passes/0", { program: PROGRAM.normal })],
    );
    const layers = [
      modelLayer(0, "A", { meshes: shared(0), order: [1, 0], origin: [400, 300, 0] }),
      modelLayer(1, "B", {
        meshes: shared(1),
        order: [1, 0],
        origin: [800, 300, 0],
        angles: [0.3, 0, 0.5],
        scale: [1, 4, 1],
        color: [1, 0, 0],
        alpha: 0.5,
        brightness: 3,
      }),
      modelLayer(2, "P", { meshes: [perspective.mesh], perspective: true }),
      modelLayer(3, "C", { meshes: [outside.mesh], bounds: [-50, -50, -50, 50, 50, 50], origin: [-500, 540, 0] }),
      modelLayer(4, "N", { meshes: [placeholder.mesh] }),
    ];
    return { bundle: bundleOf(layers, hdr), file, m0, m1 };
  }

  async function open(hdr = false) {
    const built = scene(hdr);
    const gpu = new FakeGpu();
    const state = SceneState.fromBundle(built.bundle);
    const gpuScene = await GpuScene.build(gpu.device, built.bundle, state, new Set(), [], { particles: { seed: 1 } });
    return { ...built, gpu, scene: gpuScene, state };
  }

  it("每个模型层一个 model op，draw 按 model.order；管线是三角形列表、带布局与剔除、不写 alpha；测深度（P5d 步骤 1）", async () => {
    const { scene, gpu } = await open();
    const runtime = internals(scene).layers.find((item) => item.object === 0)!;
    expect(runtime.ops.map((op) => op.kind)).toEqual(["model"]);
    expect(runtime.ops[0].draws!.map((draw) => draw.label)).toEqual(["layer 10 A mesh 1", "layer 10 A mesh 0"]);
    // 网格的 pass 都测深度（depthtest enabled）：场景有深度附件，管线带深度状态（P5d 步骤 1），标签多 ` depth:<t|-><w|->`
    expect(meshDraw(scene, 0, 0).pipeline.label).toBe(
      "scene program 0 translucent rgba8unorm list mesh cull depth:t- mask 7",
    );
    expect(meshDraw(scene, 0, 1).pipeline.label).toBe("scene program 0 normal rgba8unorm list mesh depth:t- mask 7");
    const descriptor = gpu.pipelines.find(
      (item) => item.label === "scene program 0 translucent rgba8unorm list mesh cull depth:t-",
    )!;
    expect(descriptor.primitive).toEqual({ topology: "triangle-list", cullMode: "back", frontFace: "ccw" });
    expect(descriptor.depthStencil).toEqual({
      format: "depth32float",
      depthCompare: "greater",
      depthWriteEnabled: false,
    });
    expect([...descriptor.vertex.buffers!]).toEqual([
      {
        arrayStride: 20,
        stepMode: "vertex",
        attributes: [
          { shaderLocation: 0, offset: 0, format: "float32x3" },
          { shaderLocation: 1, offset: 12, format: "float32x2" },
        ],
      },
    ]);
    // 占位：槽 1 arrayStride 0
    const withPlaceholder = gpu.pipelines.find((item) => item.label?.startsWith("scene program 1"))!;
    expect([...withPlaceholder.vertex.buffers!][1]).toEqual({
      arrayStride: 0,
      stepMode: "vertex",
      attributes: [{ shaderLocation: 2, offset: 0, format: "float32x3" }],
    });
    expect(withPlaceholder.primitive).toEqual({ topology: "triangle-list", cullMode: "none" });
  });

  it("网格缓冲按视图共用：A、B 同一个顶点 / 索引缓冲，字节是 mdl 原样；奇数个 u16 索引补到 4 字节；占位缓冲全场一份、全零", async () => {
    const { scene, gpu, m0 } = await open();
    expect(meshDraw(scene, 0, 0).vertexBuffer).toBe(meshDraw(scene, 1, 0).vertexBuffer);
    expect(meshDraw(scene, 0, 0).mesh!.indexBuffer).toBe(meshDraw(scene, 1, 0).mesh!.indexBuffer);
    expect(meshDraw(scene, 0, 0).vertexBuffer).not.toBe(meshDraw(scene, 0, 1).vertexBuffer);
    expect(meshDraw(scene, 0, 0).vertexBuffer.bytes).toEqual(m0.mesh.vertices);
    const indices = meshDraw(scene, 0, 0).mesh!.indexBuffer;
    expect(indices.bytes.byteLength).toBe(8);
    expect(Array.from(new Uint16Array(indices.bytes.buffer.slice(0)))).toEqual([0, 1, 2, 0]);
    expect(meshDraw(scene, 0, 0).mesh).toMatchObject({ indexFormat: "uint16", count: 3, placeholder: null });
    const placeholder = meshDraw(scene, 4, 0).mesh!.placeholder!;
    expect(placeholder.label).toBe("mesh placeholder");
    expect(placeholder.bytes.every((byte) => byte === 0)).toBe(true);
    // 顶点缓冲只建了 5 份（A、B 共用的两个网格，P、C、N 各一个），索引同样
    expect(gpu.buffers.filter((buffer) => buffer.label.endsWith(" vertices"))).toHaveLength(5);
    expect(gpu.buffers.filter((buffer) => buffer.label.endsWith(" indices"))).toHaveLength(5);
    expect(gpu.buffers.filter((buffer) => buffer.label === "mesh placeholder")).toHaveLength(1);
  });

  it("一帧的编码：A、B 各两个网格（order [1, 0]）；P 画；C 的外接球在场景外，整个模型不画；N 绑占位到槽 1", async () => {
    const { scene, gpu, state } = await open();
    scene.update(FRAME, state);
    gpu.trace.length = 0;
    scene.encode(gpu.device.createCommandEncoder(), state);
    const lines = gpu.trace.filter((line) => !line.startsWith("  pipeline"));
    expect(lines).toEqual([
      "pass scene target clear",
      "  vertices#0 models/A.mdl#1 vertices 80",
      "  indices models/A.mdl#1 indices uint16 12",
      "  drawIndexed 6",
      "  vertices#0 models/A.mdl#0 vertices 80",
      "  indices models/A.mdl#0 indices uint16 8",
      "  drawIndexed 3",
      // B 与 A 共用缓冲（标签是第一个建它的 A 的）
      "  vertices#0 models/A.mdl#1 vertices 80",
      "  indices models/A.mdl#1 indices uint16 12",
      "  drawIndexed 6",
      "  vertices#0 models/A.mdl#0 vertices 80",
      "  indices models/A.mdl#0 indices uint16 8",
      "  drawIndexed 3",
      "  vertices#0 models/P.mdl#0 vertices 80",
      "  indices models/P.mdl#0 indices uint16 12",
      "  drawIndexed 6",
      "  vertices#0 models/N.mdl#0 vertices 80",
      "  vertices#1 mesh placeholder 256",
      "  indices models/N.mdl#0 indices uint16 12",
      "  drawIndexed 6",
    ]);
    // C 挪回场景里（脚本 / 属性改了 origin）：下一帧就画（每帧判一次）
    state.layers.get(3)!.origin = [960, 540, 0];
    gpu.trace.length = 0;
    scene.encode(gpu.device.createCommandEncoder(), state);
    expect(gpu.trace.filter((line) => line.includes("models/C.mdl")).length).toBeGreaterThan(0);
  });

  it("uniform：MVP = VP · W；颜色组固定为 1（B 写了 color、alpha、brightness，HDR 也一样）；材质常量照写；法线矩阵是 normalMatrix(W)", async () => {
    for (const hdr of [false, true]) {
      const { scene, state } = await open(hdr);
      scene.update(FRAME, state);
      const vp = sceneViewProjection({ width: 1920, height: 1080 });
      const worlds = new Map<number, Mat4>();
      for (const object of [0, 1]) {
        const world = worldMatrixOf(object, state.layers, worlds);
        const draw = meshDraw(scene, object, 0);
        expect(floatsOf(draw, 0, 16), `${object}`).toEqual(Array.from(multiply(vp, world)));
        expect(floatsOf(draw, 64, 4), `${object} g_Color4`).toEqual([1, 1, 1, 1]);
        expect(mat3Of(draw, 80), `${object} 法线`).toEqual(normalMatrix(world).map(Math.fround));
        expect(floatsOf(draw, 128, 3).map((v) => Math.round(v * 100) / 100)).toEqual([0.72, 0.64, 0.42]);
      }
    }
  });

  it("perspective: true 换透视那一份视图投影（同 P5b 透视图层）；视差同图像层按根对象平移", async () => {
    const { scene, state } = await open();
    const worlds = new Map<number, Mat4>();
    const world = worldMatrixOf(2, state.layers, worlds);
    const persp = particleViewProjection({ width: 1920, height: 1080, perspectiveOverrideFov: particleFov(undefined) });
    expect(floatsOf(meshDraw(scene, 2, 0), 0, 16)).toEqual(Array.from(multiply(persp, world)));
    // 视差：VP · T(o) · W
    const parallax = { point: [700, 400] as [number, number], amount: 0.5 };
    scene.setParallax(parallax, state);
    scene.update(FRAME, state);
    const vp = sceneViewProjection({ width: 1920, height: 1080 });
    const root = state.layers.get(0)!;
    const [x, y] = parallaxOffset(parallax.amount, root.parallaxDepth, root.origin, parallax.point);
    expect(floatsOf(meshDraw(scene, 0, 0), 0, 16)).toEqual(
      Array.from(multiply(multiply(vp, translation(x, y, 0)), worldMatrixOf(0, state.layers, new Map()))),
    );
  });
});

// ———— 本机语料：retro ————

const root = process.env.KABEGAME_WPE_ROOT;
const retro = root ? join(root, "projects", "defaultprojects", "retro") : "";
const wasm = join(__dirname, "..", "wpesl2wgsl", "wpesl2wgsl.wasm");
const diskReader: SceneReader = {
  async readWhole(path) {
    try {
      return new Uint8Array(readFileSync(path));
    } catch {
      throw new TypeError("Failed to fetch");
    }
  },
  async readRange(path, start, end) {
    try {
      return new Uint8Array(readFileSync(path).subarray(start, end));
    } catch {
      throw new TypeError("Failed to fetch");
    }
  },
};

describe.skipIf(!root || !existsSync(retro) || !existsSync(wasm))("本机语料：retro（P5c 步骤 2 解锁）", () => {
  it("渲染器自查通过；bgfade 的布局：a_Position 声明了没读、照样接网格数据（网格有），a_TexCoord 在 12；不剔除；v14 不剔", async () => {
    const bundle = await compileScene({
      projectDir: retro,
      sceneAssets: [join(root!, "assets")],
      reader: diskReader,
      translator: await Wpesl2wgsl.fromBytes(readFileSync(wasm)),
      postprocess: "disabled",
      exhaustive: true,
    });
    expect(checkRenderable(bundle, new Set(["texture-compression-bc"]))).toEqual([]);
    const layer = bundle.layers.find((item) => item.model)!;
    const [step] = planLayer(layer, bundle.textures).steps;
    expect(step).toMatchObject({ kind: "mesh", mesh: 0, blending: "translucent" });
    if (step.kind !== "mesh") return;
    const program = bundle.programs[step.pass.program!];
    const layout = meshVertexLayout(program.attributes ?? [], layer.model!.meshes[0].format);
    expect(layout.problems).toEqual([]);
    expect(layout.placeholders).toBe(0);
    expect(layout.buffers[0].arrayStride).toBe(20);
    expect(stepPipeline(step, "rgba8unorm", () => "rgba8unorm", false, null, layout.key).cull).toBeUndefined();
    expect(layer.model!.bounds).toEqual([-131072, -131072, -131072, 131072, 131072, 131072]);
    expect(frustumCulled(layer.model!.bounds, translation(0, 0, 0), sceneViewProjection(bundle.general))).toBe(false);
  }, 60000);
});
