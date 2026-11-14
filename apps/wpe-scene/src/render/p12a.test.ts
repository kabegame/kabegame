/**
 * P12a 步骤 4 的渲染侧单测（无 GPU，`.claude/plans/wpe-import/3-scene/phase12/phase-12a-mesh-animation.md`「步骤 4」点 6）：
 * - `planLayer` 的 puppet 三种情形（rea-p12-mdl 9.2–9.5，p12-REPORT 用例 8）：直接上屏（基础材质 + puppet 组合键、几何 `puppet`、UV 取图像 / GPU
 *   纹理、不内缩）、合成（有 effect：基础 pass 照旧画四边形、全部 effect 留在合成链、`puppet.upload` 以 puppet 网格采样合成 RT 上屏，UV 0–1）、
 *   静态 puppet（没有组合键，路径同上）；运行时 effect 全关的合成 puppet 仍走合成；colorBlendMode 31 直接上屏改 additive；
 * - `stepPipeline`：puppet 的上屏绘制是三角形列表、管线键带网格布局，四边形照旧是三角形带；
 * - `scaledPuppetVertices`：只把 `a_TexCoord`（表序 7）乘 `uv`（float32），位置与别的属性原样；
 * - `g_Bones`：`skinMatrices` 的输出原样交给 `UniformBlock.set`，按翻译器反射（`array<mat4x3<f32>, N>`，每项 64 字节、列步长 16）写出的字节，
 *   按 WGSL 的 `mat4x3 * vec4` 读回，等于 WPE 的公式 `p.x·row0 + p.y·row1 + p.z·row2 + row3`（风险 1）；有 WPE 时用真翻译器核对反射与生成的
 *   WGSL 形状。
 */
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import type { ScenePass, ScenePuppetLayer, SceneLayer, SceneTexture } from "../compile/bundle";
import { parseMdl } from "../compile/mdl";
import { buildPuppet, type ScenePuppet } from "../compile/puppet";
import corpus3203 from "../puppet/fixtures/3203778110.json";
import { ScenePuppets } from "../puppet/player";
import { Wpesl2wgsl, translateWithIncludes } from "../wpesl2wgsl";
import { planLayer, type DrawStep, type LayerPlan } from "./graph";
import { NO_INSET, textureUvExtent } from "./layout";
import { needsScaledVertices, scaledPuppetVertices } from "./puppet";
import { pipelineKey, stepPipeline } from "./scene";
import { UniformBlock, type UniformEntry } from "./uniforms";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

const pass = (key: string, partial: Partial<ScenePass> = {}): ScenePass => ({
  key,
  program: 0,
  blending: "translucent",
  cullmode: "nocull",
  depthtest: "disabled",
  depthwrite: "disabled",
  textures: { 0: 0 },
  runtime: {},
  uniforms: {},
  framebuffer: false,
  ...partial,
});
const textures: Pick<SceneTexture, "width" | "height" | "textureWidth" | "textureHeight">[] = [
  { width: 100, height: 60, textureWidth: 128, textureHeight: 64 },
];

function puppetOf(partial: Partial<ScenePuppetLayer> = {}): ScenePuppetLayer {
  return {
    path: "models/p.mdl",
    mesh: {
      format: 0x9,
      stride: 20,
      vertices: new Uint8Array(80),
      indices: new Uint8Array(12),
      vertexCount: 4,
      indexCount: 6,
    },
    combos: { SKINNING: 1, BONECOUNT: 2 },
    skeleton: null,
    animations: [],
    layers: [],
    composite: false,
    passes: [pass("objects/0/passes/0", { program: 1 })],
    upload: null,
    ...partial,
  };
}
function layerOf(partial: Partial<SceneLayer> = {}): SceneLayer {
  return {
    id: 7,
    object: 0,
    parent: null,
    name: "puppet",
    origin: [100, 50, 0],
    scale: [1, 1, 1],
    angles: [0, 0, 0],
    size: [200, 100],
    alpha: 1,
    color: [1, 1, 1],
    brightness: 1,
    visible: true,
    visibleBound: false,
    parallaxDepth: [1, 1],
    solidLayer: false,
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
    passes: [pass("objects/0/passes/0", { program: 0 })],
    colorBlendMode: 0,
    effects: [],
    passthrough: null,
    particle: null,
    ...partial,
  };
}
const effectOf = (enabled = true) => ({
  source: 0,
  id: 1,
  name: "",
  file: "effects/x/effect.json",
  fbos: [],
  steps: [
    {
      kind: "draw" as const,
      pass: pass("objects/0/effects/0/passes/0", { program: 2, textures: {}, blending: "normal" }),
      target: null,
      compose: false,
      binds: null,
    },
  ],
  enabled,
  visibleBound: false,
  unsupported: [],
});
const draws = (plan: LayerPlan) => plan.steps.filter((step): step is DrawStep => step.kind === "draw");
const roles = (plan: LayerPlan) =>
  plan.steps.map((step) =>
    step.kind === "draw"
      ? `${step.role}:${step.geometry}→${step.target.kind === "composite" ? `c${step.target.index}` : step.target.kind}`
      : step.kind,
  );

describe("planLayer：puppet 直接上屏（rea-p12-mdl 9.2、9.4）", () => {
  it("一步 direct：puppet 变体的 pass、几何 puppet、UV = 图像 / GPU 纹理、不内缩；没有合成 RT", () => {
    const plan = planLayer(layerOf({ puppet: puppetOf() }), textures);
    expect(plan.composite).toBeNull();
    expect(plan.reasons).toEqual([]);
    expect(roles(plan)).toEqual(["direct:puppet→scene"]);
    const [step] = draws(plan);
    expect(step.pass.key).toBe("objects/0/passes/0");
    expect(step.pass.program).toBe(1);
    expect(step.uv).toEqual(textureUvExtent(textures[0]));
    expect(step.uv).toEqual([100 / 128, 60 / 64]);
    expect(step.inset).toBe(NO_INSET);
    expect(step.blending).toBe("translucent");
  });

  it("colorBlendMode 31：仍直接上屏，混合改 additive；没有 puppet 的同一图层照旧画四边形", () => {
    const plan = planLayer(layerOf({ puppet: puppetOf(), colorBlendMode: 31 }), textures);
    expect(roles(plan)).toEqual(["direct:puppet→scene"]);
    expect(draws(plan)[0].blending).toBe("additive");
    expect(roles(planLayer(layerOf(), textures))).toEqual(["direct:layer→scene"]);
    // puppet 为 null（mdl 读不到）同没有 puppet
    expect(roles(planLayer(layerOf({ puppet: null }), textures))).toEqual(["direct:layer→scene"]);
  });

  it("静态 puppet（没有组合键、没有骨骼）：同一条路径，pass 是不带组合键的材质", () => {
    const plan = planLayer(
      layerOf({ puppet: puppetOf({ combos: {}, passes: [pass("objects/0/passes/0", { program: 0 })] }) }),
      textures,
    );
    expect(roles(plan)).toEqual(["direct:puppet→scene"]);
    expect(draws(plan)[0].pass.program).toBe(0);
  });

  it("puppet.passes 为空（材质没有 pass）：退回四边形，不崩", () => {
    const plan = planLayer(layerOf({ puppet: puppetOf({ passes: [] }) }), textures);
    expect(roles(plan)).toEqual(["direct:layer→scene"]);
  });
});

describe("planLayer：puppet 合成路径（rea-p12-mdl 9.4，p12-REPORT 用例 8）", () => {
  const upload = pass("objects/0/puppetupload", { program: 3, blending: "normal", textures: {} });
  const composite = (partial: Partial<SceneLayer> = {}) =>
    layerOf({ puppet: puppetOf({ composite: true, passes: [], upload }), ...partial });

  it("有 effect：基础 pass 照旧画四边形进合成 RT，effect 留在合成链，最后 passthrough 角色用 upload、几何 puppet、UV 0–1、不内缩", () => {
    const plan = planLayer(composite({ effects: [effectOf()] }), textures);
    expect(roles(plan)).toEqual(["base:fill→c0", "effect:fullscreen→c1", "passthrough:puppet→scene"]);
    expect(plan.composite).toEqual({ count: 2, width: 100, height: 60 });
    const last = draws(plan).at(-1)!;
    expect(last.pass).toBe(upload);
    expect(last.uv).toEqual([1, 1]);
    expect(last.inset).toBe(NO_INSET);
    // 采样的是最后一次写入的合成 RT；混合取基础材质的
    expect(last.inputs[0]).toEqual({ kind: "composite", index: 1 });
    expect(last.blending).toBe("translucent");
    // 基础 pass 用 layer.passes 的（不带组合键），不是 puppet 的变体
    expect(draws(plan)[0].pass.program).toBe(0);
    // 没有一个 `final` 角色：最后一个 effect 也留在合成链
    expect(draws(plan).some((step) => step.role === "final")).toBe(false);
  });

  it("运行时 effect 全关：仍是合成路径（WPE 加载时就置了 0x10）：base → passthrough", () => {
    const plan = planLayer(composite({ effects: [effectOf(false)] }), textures, () => false);
    expect(roles(plan)).toEqual(["base:fill→c0", "passthrough:puppet→scene"]);
    expect(plan.composite).toEqual({ count: 1, width: 100, height: 60 });
  });

  it("colorBlendMode 混合（没有 effect）与 cbm 31：都走合成；31 时上屏混合 additive", () => {
    expect(roles(planLayer(composite({ colorBlendMode: 7 }), textures))).toEqual([
      "snapshot",
      "base:fill→c0",
      "passthrough:puppet→scene",
    ]);
    const additive = planLayer(composite({ colorBlendMode: 31 }), textures);
    expect(draws(additive).at(-1)!.blending).toBe("additive");
  });

  it("没有 upload（编译失败）：报 render:no-passthrough", () => {
    const plan = planLayer(
      layerOf({ puppet: puppetOf({ composite: true, passes: [], upload: null }), effects: [effectOf()] }),
      textures,
    );
    expect(plan.reasons).toContain("render:no-passthrough");
  });

  it("被依赖的 puppet：合成 RT 0 独占（最后一次写入落在 0）", () => {
    const plan = planLayer(composite({ dependedOn: true, effects: [effectOf()] }), textures);
    expect(roles(plan)).toEqual(["base:fill→c1", "effect:fullscreen→c0", "passthrough:puppet→scene"]);
  });
});

describe("stepPipeline：puppet 的上屏绘制按网格画（P12a 步骤 4 点 2）", () => {
  const rgba = () => "rgba8unorm" as GPUTextureFormat;
  it("几何 puppet：三角形列表、管线键带网格布局；四边形是三角形带、没有网格键", () => {
    const [step] = draws(planLayer(layerOf({ puppet: puppetOf() }), textures));
    const spec = stepPipeline(step, "rgba8unorm", rgba, false, null, "20:0@0:float32x3,1@12:float32x2");
    expect(spec.topology).toBe("triangle-list");
    expect(spec.mesh).toBe("20:0@0:float32x3,1@12:float32x2");
    expect(pipelineKey(spec)).toContain("|list|mesh:20:0@0:float32x3,1@12:float32x2");
    const [quad] = draws(planLayer(layerOf(), textures));
    const plain = stepPipeline(quad, "rgba8unorm", rgba);
    expect(plain.topology).toBe("triangle-strip");
    expect(plain.mesh).toBeUndefined();
    expect(pipelineKey(plain)).not.toContain("mesh:");
  });
});

describe("scaledPuppetVertices：a_TexCoord 乘 UV 比例（rea-p12-mdl 9.2 `FUN_14020ae00`）", () => {
  /** 格式 0xf：位置 12、法线 12、切线 16、uv 8（stride 48），a_TexCoord 的偏移 40。 */
  const FORMAT = 0xf;
  const stride = 48;
  function mesh(count: number, format = FORMAT, size = stride) {
    const bytes = new Uint8Array(count * size);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < count; i++)
      for (let k = 0; k < size / 4; k++) view.setFloat32(i * size + k * 4, i * 10 + k + 0.123, true);
    return { format, stride: size, vertices: bytes, vertexCount: count };
  }

  it("只乘 a_TexCoord 两个分量（float32 逐个舍入），位置、法线、切线原样；输入不被改写", () => {
    const input = mesh(3);
    const before = input.vertices.slice();
    const out = scaledPuppetVertices(input, [100 / 128, 60 / 64]);
    expect(input.vertices).toEqual(before);
    expect(out).not.toBe(input.vertices);
    const read = new DataView(out.buffer, out.byteOffset, out.byteLength);
    const source = new DataView(before.buffer);
    for (let i = 0; i < 3; i++) {
      for (let k = 0; k < 10; k++)
        expect(read.getFloat32(i * stride + k * 4, true)).toBe(source.getFloat32(i * stride + k * 4, true));
      expect(read.getFloat32(i * stride + 40, true)).toBe(
        Math.fround(source.getFloat32(i * stride + 40, true) * (100 / 128)),
      );
      expect(read.getFloat32(i * stride + 44, true)).toBe(
        Math.fround(source.getFloat32(i * stride + 44, true) * (60 / 64)),
      );
    }
  });

  it("uv 为 (1, 1)、没有 a_TexCoord（只有 a_TexCoordVec3）时不另传一份：返回 mdl 视图（需要时补到 4 字节对齐）", () => {
    const input = mesh(2);
    expect(scaledPuppetVertices(input, [1, 1])).toBe(input.vertices);
    expect(needsScaledVertices(input, [1, 1])).toBe(false);
    expect(needsScaledVertices(input, [0.5, 1])).toBe(true);
    // 0x10 = a_TexCoordVec3：WPE 只乘 a_TexCoord（表序 7）
    const vec3 = mesh(2, 0x1 | 0x10, 24);
    expect(needsScaledVertices(vec3, [0.5, 0.5])).toBe(false);
    expect(scaledPuppetVertices(vec3, [0.5, 0.5])).toBe(vec3.vertices);
  });
});

// ———— g_Bones ————

/** `UniformBlock` 的字节里第 `bone` 项、第 `column` 列（vec3，列步长 16）。 */
function column(block: UniformBlock, offset: number, bone: number, c: number): number[] {
  const f32 = new Float32Array(block.data);
  const at = (offset + bone * 64 + c * 16) / 4;
  return [f32[at], f32[at + 1], f32[at + 2]];
}
/** WGSL 的 `mat4x3 * vec4(p, 1)`：Σ v_c · 列 c（`global.g_Bones[i] * vec4<f32>(x, y, z, 1f)`，翻译器的生成形状）。 */
function wgslMul(block: UniformBlock, offset: number, bone: number, p: readonly number[]): number[] {
  const v = [p[0], p[1], p[2], 1];
  const out = [0, 0, 0];
  for (let c = 0; c < 4; c++) {
    const col = column(block, offset, bone, c);
    for (let r = 0; r < 3; r++) out[r] += v[c] * col[r];
  }
  return out;
}
/** WPE 的公式（rea-p12-mdl 9.6）：`p.x·row0 + p.y·row1 + p.z·row2 + row3`，row 取 K 的行的 xyz；skin 每骨骼 12 个数 = 4 行 × 3。 */
function wpeMul(skin: Float32Array, bone: number, p: readonly number[]): number[] {
  const row = (r: number) => [0, 1, 2].map((k) => skin[bone * 12 + r * 3 + k]);
  const out = [0, 0, 0];
  [p[0], p[1], p[2], 1].forEach((weight, r) => {
    const values = row(r);
    for (let k = 0; k < 3; k++) out[k] += weight * values[k];
  });
  return out;
}

const mdlBytes = (text: string) => new Uint8Array(gunzipSync(Buffer.from(text, "base64")));

function skinnedPuppet() {
  // 骨骼最多的那个（`3203778110` 的三个 puppet 里取骨骼数 > 1 的第一个）
  for (const item of corpus3203.puppets) {
    const { puppet } = buildPuppet(parseMdl(mdlBytes(item.mdlGzip)), item.layers, item.path);
    const bones = puppet?.skeleton?.parents.length ?? 0;
    if (bones > 1) return run(item.object, puppet!, bones);
  }
  throw new Error("语料样本里没有多骨骼的 puppet");
}
function run(object: number, puppet: ScenePuppet, bones: number) {
  const puppets = new ScenePuppets([{ object, puppet }]);
  for (let k = 0; k < 20; k++) puppets.frame(1 / 60);
  return { skin: puppets.skin(object)!, bones };
}

/** 翻译器反射里 `g_Bones` 的一格（`array<mat4x3<f32>, N>`：每项 4 列、每列 vec3 占 16 字节，项步长 64）。 */
function bonesEntry(bones: number): UniformEntry {
  return {
    name: "g_Bones",
    type: `array<mat4x3<f32>, ${bones}>`,
    declared: "mat4x3",
    offset: 160,
    size: 64 * bones,
    array: bones,
    stride: 64,
  };
}

describe("g_Bones 的写法（风险 1）：skinMatrices 的 12 个数原样写进 array<mat4x3<f32>, N>", () => {
  it("字节布局：第 i 项第 c 列 = skin[i·12 + c·3 …]（K 的第 c 行的 xyz），列步长 16、项步长 64；第 4 个分量（填充）保持 0", () => {
    const { skin, bones } = skinnedPuppet();
    expect(bones).toBeGreaterThan(1);
    const block = new UniformBlock([bonesEntry(bones)]);
    block.set("g_Bones", skin);
    const f32 = new Float32Array(block.data);
    for (let i = 0; i < bones; i++)
      for (let c = 0; c < 4; c++) {
        expect(column(block, 160, i, c)).toEqual([0, 1, 2].map((k) => skin[i * 12 + c * 3 + k]));
        expect(f32[(160 + i * 64 + c * 16 + 12) / 4]).toBe(0);
      }
  });

  it("按 WGSL 的 mat4x3 * vec4(p, 1) 读回，等于 WPE 的 p.x·row0 + p.y·row1 + p.z·row2 + row3（逐位）", () => {
    const { skin, bones } = skinnedPuppet();
    const block = new UniformBlock([bonesEntry(bones)]);
    block.set("g_Bones", skin);
    const points = [
      [0, 0, 0],
      [10, -20, 0],
      [-345.5, 120.25, 0],
      [3, 4, 5],
    ];
    for (let i = 0; i < bones; i++)
      for (const p of points) {
        const got = wgslMul(block, 160, i, p).map((value) => Math.fround(value));
        const want = wpeMul(skin, i, p).map((value) => Math.fround(value));
        got.forEach((value, k) => expect(value).toBeCloseTo(want[k], 3));
      }
  });

  it("没有蒙皮矩阵（null）时 g_Bones 保持 0，不影响块里别的成员", () => {
    const block = new UniformBlock([bonesEntry(2)]);
    expect(Array.from(new Float32Array(block.data)).every((value) => value === 0)).toBe(true);
  });
});

// ———— 真翻译器（有 WPE 时） ————

const wasm = new URL("../wpesl2wgsl/wpesl2wgsl.wasm", import.meta.url);
const root = process.env.KABEGAME_WPE_ROOT;
const shaders = root ? `${root.replace(/\\/g, "/")}/assets/shaders/` : "";

describe.skipIf(!existsSync(wasm) || !root || !existsSync(`${shaders}genericimage4.vert`))(
  "真翻译器：genericimage4 的 SKINNING 变体（本机 WPE）",
  () => {
    it("反射里 g_Bones 是 array<mat4x3<f32>, BONECOUNT>（项步长 64），生成的 WGSL 是 `Σ g_Bones[idx] * 权重` 再 `* vec4<f32>(p, 1f)`；写进块的字节与读法一致", async () => {
      const translator = await Wpesl2wgsl.fromBytes(readFileSync(wasm));
      const { skin, bones } = skinnedPuppet();
      const result = await translateWithIncludes(
        translator,
        {
          vertex: readFileSync(`${shaders}genericimage4.vert`, "utf8"),
          fragment: readFileSync(`${shaders}genericimage4.frag`, "utf8"),
          combos: { SKINNING: 1, BONECOUNT: bones },
          textures: [{ slot: 0, format: 0 }],
        },
        async (name) => (existsSync(shaders + name) ? readFileSync(shaders + name, "utf8") : null),
      );
      expect(result.ok).toBe(true);
      const entry = result.uniforms!.find((item) => item.name === "g_Bones")!;
      expect(entry).toMatchObject({
        type: `array<mat4x3<f32>, ${bones}>`,
        declared: "mat4x3",
        array: bones,
        stride: 64,
        size: 64 * bones,
      });
      const wgsl = result.vertex!.wgsl!;
      expect(wgsl).toContain(`g_Bones: array<mat4x3<f32>, ${bones}>`);
      // 列向量乘法：矩阵在左、vec4(x, y, z, 1) 在右 → 结果 = Σ v_c · 列 c，列 c 就是 WPE 的行 c
      expect(wgsl).toMatch(/\* vec4<f32>\(\w+\.x, \w+\.y, \w+\.z, 1f\)\);/);
      expect(wgsl).toMatch(/global\.g_Bones\[\w+\.x\]/);
      // 用反射的偏移 / 步长写块
      const block = new UniformBlock(result.uniforms as UniformEntry[], result.uniformBlockSize);
      block.set("g_Bones", skin);
      for (let i = 0; i < bones; i++)
        for (let c = 0; c < 4; c++)
          expect(column(block, entry.offset, i, c)).toEqual([0, 1, 2].map((k) => skin[i * 12 + c * 3 + k]));
    });
  },
);
