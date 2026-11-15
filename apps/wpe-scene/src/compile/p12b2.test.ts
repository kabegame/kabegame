/**
 * P12b2-1 点 4：模型对象的骨骼——编译侧（`.claude/plans/wpe-import/3-scene/phase12/phase-12b2-texchan-model.md`「P12b2-1」）。
 * - 组合键（`modelMeshCombos`）：`SKINNING`、`BONECOUNT` 取 2 的幂（16 / 32 / 64 / 128）、`MORPHING`、`MORPHING_NORMALS`；
 * - 变形纹理逐分量对 WPE 抓帧（`p12b2-morph` 的 `mo_ovr`、`mo_nrm`，RenderDoc 读回的 i16）；边长、每网格各一张；
 * - `buildModelSkeleton`：静止姿势只用 `MDLS` 局部矩阵、动画层规则、变形轨道按网格、动画包围盒，和不再报的 / 新报的键；
 * - 整张场景：`SceneModel.skeleton`、网格 pass 的组合键、`animation-layer` 绑定、挂点、`transferableBuffers`、渲染图槽 5 的变形纹理；
 * - 本机语料 `3706286085` 编译后的不支持项只剩 P13 的键、`puppet:layer-script`、`object:parent`（没有语料时跳过）。
 * 样本：`../puppet/fixtures/p12b2-*.json`（`ignore/p12/b2/impl/mkfix_model.py`）。
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { planModelLayer } from "../render/graph";
import att from "../puppet/fixtures/p12b2-att.json";
import mdl from "../puppet/fixtures/p12b2-mdl.json";
import morph from "../puppet/fixtures/p12b2-morph.json";
import rest from "../puppet/fixtures/p12b2-rest.json";
import { Wpesl2wgsl as RealTranslator, type TranslateRequest, type TranslateResult } from "../wpesl2wgsl";
import { compileScene, transferableBuffers } from "./bundle";
import { checkObjectFeatures } from "./features";
import { FetchSceneReader, type SceneReader } from "./fs";
import { parseMdl, type MdlAnimation, type MdlBone, type MdlFile, type MdlMesh, type MdlSkeleton } from "./mdl";
import { buildModelSkeleton, buildPuppet, modelBoneCount, modelMeshCombos } from "./puppet";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

const mdlBytes = (text: string) => new Uint8Array(gunzipSync(Buffer.from(text, "base64")));

interface FixtureObject {
  name: string;
  object: number;
  path: string;
  layers: unknown[];
  texels?: number[];
}
interface Fixture {
  mdls: Record<string, string>;
  objects: FixtureObject[];
}
const objectOf = (fixture: Fixture, name: string) => fixture.objects.find((item) => item.name === name)!;
const fileOf = (fixture: Fixture, object: FixtureObject) => parseMdl(mdlBytes(fixture.mdls[object.path]));

// ———— 组合键 ————

describe("modelBoneCount：min(128, 向上取 2 的幂(max(16, 骨骼数)))（rea-texchan-model 5，p12b2-mdl 实测 3 / 4 根 → 16、17 根 → 32）", () => {
  it.each<[number, number]>([
    [1, 16],
    [3, 16],
    [4, 16],
    [16, 16],
    [17, 32],
    [32, 32],
    [33, 64],
    [64, 64],
    [65, 128],
    [79, 128],
    [128, 128],
  ])("%i 根 → %i", (bones, expected) => {
    expect(modelBoneCount(bones)).toBe(expected);
  });
});

describe("modelMeshCombos：SKINNING 总写（0 也写）、MORPHING 看目标、MORPHING_NORMALS 看网格标志 bit10", () => {
  const plain = parseMdl(mdlBytes(mdl.mdls["models/rig4.mdl"])).meshes[0];
  const nrm = fileOf(morph as Fixture, objectOf(morph as Fixture, "mo_nrm")).meshes[0];
  const ovr = fileOf(morph as Fixture, objectOf(morph as Fixture, "mo_ovr")).meshes[0];

  it("带 a_BlendIndices 的网格：SKINNING 1、BONECOUNT 16；没有变形不写 MORPHING*", () => {
    expect(modelMeshCombos(plain, 4)).toEqual({ SKINNING: 1, BONECOUNT: 16 });
  });

  it("有变形目标：MORPHING 1；bit10 再加 MORPHING_NORMALS 1（BoostModel：p12b2-morph 的 mo_nrm 同一个着色器 64e9b3f4）", () => {
    expect(modelMeshCombos(ovr, 1)).toEqual({ SKINNING: 1, BONECOUNT: 16, MORPHING: 1 });
    expect(modelMeshCombos(nrm, 1)).toEqual({ SKINNING: 1, BONECOUNT: 16, MORPHING: 1, MORPHING_NORMALS: 1 });
  });

  it("格式不带 a_BlendIndices：SKINNING 0 照写（画在模型空间，不跟骨骼）；bit10 不看有没有目标", () => {
    const flat: MdlMesh = { ...plain, format: plain.format & ~0x800000, morph: null, flags: 0x400 };
    expect(modelMeshCombos(flat, 79)).toEqual({ SKINNING: 0, BONECOUNT: 128, MORPHING_NORMALS: 1 });
  });
});

// ———— 变形纹理 ————

describe("变形纹理：i16 分量流按「目标 → 顶点 → 位置（bit10 时再接法线）」紧排，逐分量对 WPE 读回的纹理", () => {
  const fixture = morph as Fixture;
  const skeletonOf = (name: string) => {
    const object = objectOf(fixture, name);
    const built = buildModelSkeleton(fileOf(fixture, object), object.layers, {}, {});
    expect([...built.issues], name).toEqual([]);
    return { built: built.skeleton!, object };
  };

  it("mo_ovr（3 目标 × 8 顶点，没有法线）：5×5 纹素，100 个 i16 与 WPE 逐个相同", () => {
    const { built, object } = skeletonOf("mo_ovr");
    const [first] = built.morphs;
    expect(first).toMatchObject({ scale: 40, vertices: 8, targets: 3, side: 5 });
    expect(Array.from(first!.texels)).toEqual(object.texels);
  });

  it("mo_nrm（bit10：每顶点 6 个 i16，位置差与法线差交错）：6×6 纹素，144 个 i16 与 WPE 逐个相同", () => {
    const { built, object } = skeletonOf("mo_nrm");
    const [first] = built.morphs;
    expect(first).toMatchObject({ vertices: 8, targets: 3, side: 6 });
    expect(Array.from(first!.texels)).toEqual(object.texels);
  });

  it("每网格一张：mo_two 两个网格（8 顶点 3 目标 / 4 顶点 2 目标）边长 5 / 3，缩放 40 / 25，顶点数是各自的（决定 1）", () => {
    const { built } = skeletonOf("mo_two");
    expect(built.morphs.map((item) => [item!.side, item!.scale, item!.vertices, item!.targets])).toEqual([
      [5, 40, 8, 3],
      [3, 25, 4, 2],
    ]);
  });

  it("没有目标的网格为 null；没有 MDMP 的模型 morphs 全 null", () => {
    const rig = buildModelSkeleton(fileOf(mdl as Fixture, objectOf(mdl as Fixture, "M_ovr")), [], {}, {}).skeleton!;
    expect(rig.morphs).toEqual([null]);
  });
});

// ———— buildModelSkeleton ————

describe("buildModelSkeleton：骨骼、动画、动画层、挂点", () => {
  it("静止姿势只用 MDLS 局部矩阵：mdl 带可选骨骼矩阵时图像层读它、模型不读（p12b2-rest 实测）", () => {
    const fixture = rest as Fixture;
    const object = objectOf(fixture, "M_miss");
    const file = fileOf(fixture, object);
    expect(file.skeleton!.restMatrices).not.toBeNull();
    const model = buildModelSkeleton(file, object.layers, {}, {}).skeleton!;
    const image = buildPuppet(file, object.layers, object.path).puppet!;
    const local = Float32Array.from(file.skeleton!.bones.flatMap((bone) => Array.from(bone.local)));
    expect(Array.from(model.skeleton.restMatrices)).toEqual(Array.from(local));
    expect(Array.from(image.skeleton!.restMatrices)).not.toEqual(Array.from(local));
    expect(Array.from(model.skeleton.rest)).not.toEqual(Array.from(image.skeleton!.rest));
  });

  it("动画层：找不到的动画整层丢掉、同一动画共用一份；每条动画带动画包围盒与按网格的变形轨道（没有变形为 null）", () => {
    const fixture = mdl as Fixture;
    const object = objectOf(fixture, "M_mix");
    const built = buildModelSkeleton(fileOf(fixture, object), [...object.layers, { animation: 99999 }], {}, {});
    expect([...built.issues]).toEqual([]);
    const rig = built.skeleton!;
    expect(rig.layers.map((layer) => [layer.name, layer.blend])).toEqual([
      ["A", 1],
      ["B", 0.5],
    ]);
    expect(rig.animations).toHaveLength(2);
    for (const animation of rig.animations) {
      expect(animation.bounds).toEqual([0, 0, 0, 0, 0, 0]);
      expect(animation.meshMorph).toEqual([null]);
      expect(animation.alpha).toBeNull();
    }
  });

  it("p12b2-cull：MDLA v5 的动画包围盒（min xyz、max xyz）读进来", () => {
    const fixture = JSON.parse(
      readFileSync(new URL("../puppet/fixtures/p12b2-cull.json", import.meta.url), "utf8"),
    ) as Fixture;
    const object = objectOf(fixture, "cull_a");
    const rig = buildModelSkeleton(fileOf(fixture, object), object.layers, {}, {}).skeleton!;
    expect(rig.animations[0].bounds).toEqual([10, -10, -10, 50, 10, 10]);
  });

  it("挂点：MDAT 的三项（名字、骨骼、矩阵）", () => {
    const fixture = att as Fixture;
    const object = objectOf(fixture, "M_anim");
    const rig = buildModelSkeleton(fileOf(fixture, object), object.layers, {}, {}).skeleton!;
    expect(rig.attachments.map((item) => [item.name, item.bone, item.matrix.length])).toEqual([
      ["tipA", 1, 16],
      ["tipB", 2, 16],
      ["tipC", 3, 16],
    ]);
  });

  it("没有 MDLS 的静态网格为 null；骨骼数 0 为 null；mdl 里的动画 / 变形 / 挂点段不读", () => {
    const none = buildModelSkeleton(file({ skeleton: null, animations: [animation(1, 1)] }), [], {}, {});
    expect(none).toEqual({ skeleton: null, issues: new Set() });
    expect(buildModelSkeleton(file({ skeleton: skeleton([]) }), [], {}, {}).skeleton).toBeNull();
  });
});

// ———— 报的键 ————

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const FMT_SKIN = 0x180000f;

function mesh(extra: Partial<MdlMesh> = {}): MdlMesh {
  return {
    materials: ["materials/a.json"],
    flags: 0,
    format: FMT_SKIN,
    stride: 80,
    vertices: new Uint8Array(320),
    indices: new Uint8Array(new Uint16Array([0, 1, 2, 0, 2, 3]).buffer),
    vertexCount: 4,
    indexFormat: "uint16",
    indexCount: 6,
    bounds: null,
    puppet: false,
    blendRowCount: 0,
    drawGroups: [],
    records: [],
    morph: null,
    ...extra,
  };
}
function bone(parent: number, extra: Partial<MdlBone> = {}): MdlBone {
  return { name: "b", flags: 1, parent, local: Float32Array.from(IDENTITY), json: "", ...extra };
}
function skeleton(bones: MdlBone[], extra: Partial<MdlSkeleton> = {}): MdlSkeleton {
  return {
    version: 4,
    count: bones.length,
    bones,
    restMatrices: null,
    drawOrder: null,
    extras: { records: 0, constraints: 0, keyMaps: 0, chains: 0 },
    ...extra,
  };
}
function animation(id: number, bones: number, extra: Partial<MdlAnimation> = {}): MdlAnimation {
  return {
    id,
    name: `a${id}`,
    mode: "loop",
    fps: 10,
    length: 2,
    flags: 0,
    tracks: Array.from({ length: bones }, () => ({ flags: 0, frames: new Float32Array(27) })),
    boneAlpha: null,
    morphWeights: null,
    drawOrderTrack: false,
    events: [],
    unsupported: false,
    ...extra,
  };
}
function file(extra: Partial<MdlFile> = {}): MdlFile {
  return {
    version: 23,
    skins: 1,
    meshes: [mesh()],
    bounds: [],
    sections: [],
    truncated: false,
    skeleton: skeleton([bone(-1)]),
    animations: [],
    attachments: [],
    sectionIssues: [],
    ...extra,
  };
}
const issues = (source: MdlFile, layers: unknown = [], object: Record<string, unknown> = {}) => [
  ...buildModelSkeleton(source, layers, object, {}).issues,
];
const layerOf = (id: number, extra: Record<string, unknown> = {}) => ({ animation: id, ...extra });

describe("buildModelSkeleton 的键（语料 0 处的写法照报，WPE 不处理的轨道不报）", () => {
  it("骨骼数 > 128 报 mdl:skeleton:bones 且没有骨骼；动画 id ≥ 2³² 报 mdl:animation-id", () => {
    const big = buildModelSkeleton(file({ skeleton: skeleton([], { count: 129 }) }), [], {}, {});
    expect([...big.issues]).toEqual(["mdl:skeleton:bones"]);
    expect(big.skeleton).toBeNull();
    expect(issues(file({ animations: [animation(2 ** 32 + 1, 1)] }))).toEqual(["mdl:animation-id"]);
  });

  it("动画层字段挂 {script}：rate / blend / visible 不报（P12c 接 animation-layer 目标），其余五个可写字段报 puppet:layer-script；{user} 绑定不报，登记在层上", () => {
    const withAnimation = file({ animations: [animation(1, 1)] });
    expect(issues(withAnimation, [layerOf(1, { rate: { script: "x", value: 1 } })])).toEqual([]);
    expect(issues(withAnimation, [layerOf(1, { blendtime: { script: "x", value: 1 } })])).toEqual([
      "puppet:layer-script",
    ]);
    const built = buildModelSkeleton(
      withAnimation,
      [layerOf(1, { rate: { user: "speed", value: 2 } })],
      {},
      { speed: 3 },
    );
    expect([...built.issues]).toEqual([]);
    expect(built.skeleton!.layers[0]).toMatchObject({ rate: 3, bindings: [{ field: "rate", property: "speed" }] });
  });

  it("骨骼物理、IK、引用块、轨道数不等于骨骼数：同图像层", () => {
    expect(issues(file({ skeleton: skeleton([bone(-1, { flags: 3 })]) }))).toEqual(["puppet:physics"]);
    expect(
      issues(
        file({ skeleton: skeleton([bone(-1)], { extras: { records: 0, constraints: 1, keyMaps: 0, chains: 0 } }) }),
      ),
    ).toEqual(["puppet:ik"]);
    const used = file({ animations: [animation(1, 1, { unsupported: true }), animation(2, 2)] });
    expect(issues(used, [layerOf(1), layerOf(2)]).sort()).toEqual(["mdl:animation:tracks", "puppet:animation-ref"]);
  });

  it("骨骼透明度 / 绘制顺序轨道模型不处理（WPE 的模型更新没有它们），不报 puppet:alpha-track / draw-order；组合键也没有 SKINNING_ALPHA", () => {
    const tracks = animation(1, 1, { boneAlpha: new Float32Array(3), drawOrderTrack: true });
    const source = file({ animations: [tracks] });
    expect(issues(source, [layerOf(1)])).toEqual([]);
    expect(modelMeshCombos(source.meshes[0], 1)).toEqual({ SKINNING: 1, BONECOUNT: 16 });
  });

  it("变形：bit11 切线差 mdl:morph:tangent、MDMP 的 nv ≠ 顶点数 mdl:morph:vertices（WPE 的 memcpy 读出界）；纹理仍按网格顶点数排", () => {
    const target = { id: 1, name: "t", position: new Int16Array(12), alpha: null, normal: null };
    const base = { scale: 1, count: 4, targets: [target] };
    expect(issues(file({ meshes: [mesh({ flags: 0x800, morph: base })] }))).toEqual(["mdl:morph:tangent"]);
    expect(issues(file({ meshes: [mesh({ morph: { ...base, count: 3 } })] }))).toEqual(["mdl:morph:vertices"]);
    expect(issues(file({ meshes: [mesh({ flags: 0x400, morph: base })] }))).toEqual([]);
    // 没有目标时 bit11 中性
    expect(issues(file({ meshes: [mesh({ flags: 0x800 })] }))).toEqual([]);
  });

  it("rootmotion：对象 rootmotion 不为假且用到的动画 flags & 0x1f800 才报 model:rootmotion（WPE 调 FUN_140225900，内容没读）", () => {
    const rooted = file({ animations: [animation(1, 1, { flags: 0x800 }), animation(2, 1)] });
    expect(issues(rooted, [layerOf(1)], { rootmotion: true })).toEqual(["model:rootmotion"]);
    expect(issues(rooted, [layerOf(1)], { rootmotion: false })).toEqual([]);
    expect(issues(rooted, [layerOf(1)], {})).toEqual([]);
    expect(issues(rooted, [layerOf(2)], { rootmotion: true })).toEqual([]);
  });

  it("对象键：animationlayers 与 rootmotion 在模型对象上放行（由 buildModelSkeleton 报），在别的对象上照报", () => {
    const keys = (object: Record<string, unknown>) => {
      const out = new Set<string>();
      checkObjectFeatures(object as never, out);
      return [...out];
    };
    expect(keys({ id: 1, model: "models/a.mdl", animationlayers: [{ animation: 1 }], rootmotion: true })).toEqual([]);
    expect(keys({ id: 1, particle: "particles/a.json", rootmotion: true })).toContain("object:rootmotion");
  });
});

// ———— 整张场景 ————

function memoryReader(files: Record<string, Uint8Array | string>): SceneReader {
  const bytes = (path: string) => {
    const value = files[path.replace(/\\/g, "/")];
    if (value === undefined) throw new TypeError("Failed to fetch");
    return typeof value === "string" ? new TextEncoder().encode(value) : value.slice();
  };
  return {
    async readWhole(path) {
      return bytes(path);
    },
    async readRange(path, start, end) {
      return bytes(path).slice(start, end);
    },
  };
}

/** 假翻译器：组合键原样回给 `combos`，带 `SKINNING` 时多一个 `g_Bones`（`array<mat4x3<f32>, BONECOUNT>`），带 `MORPHING` 时多 `g_MorphOffsets` / `g_MorphWeights`。 */
function fakeTranslator(requests: TranslateRequest[]): RealTranslator {
  return {
    async translate(request: TranslateRequest): Promise<TranslateResult> {
      requests.push(request);
      const combos = Object.entries(request.combos ?? {}).map(([name, value]) => ({
        name,
        value: Number(value),
        source: "request" as const,
      }));
      const bones = Number(request.combos?.BONECOUNT ?? 0);
      const uniforms = [
        ...(request.combos?.SKINNING
          ? [
              {
                name: "g_Bones",
                type: `array<mat4x3<f32>, ${bones}>`,
                declared: "mat4x3",
                offset: 0,
                size: 64 * bones,
                array: bones,
                stride: 64,
              },
            ]
          : []),
        ...(request.combos?.MORPHING
          ? [
              {
                name: "g_MorphOffsets",
                type: "array<vec4<u32>, 12>",
                declared: "uint",
                offset: 0,
                size: 192,
                array: 12,
                stride: 16,
              },
              {
                name: "g_MorphWeights",
                type: "array<vec4<f32>, 12>",
                declared: "float",
                offset: 192,
                size: 192,
                array: 12,
                stride: 16,
              },
            ]
          : []),
      ];
      return { ok: true, uniforms, uniformBlockSize: 0, textures: [], combos } as unknown as TranslateResult;
    },
  } as unknown as RealTranslator;
}

async function compile(objects: Record<string, unknown>[], mdls: Record<string, Uint8Array>) {
  const requests: TranslateRequest[] = [];
  const material = JSON.stringify({ passes: [{ shader: "generic4", blending: "normal", cullmode: "nocull" }] });
  const bundle = await compileScene({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    reader: memoryReader({
      "P:/p/project.json": JSON.stringify({ file: "scene.json" }),
      "P:/p/scene.json": JSON.stringify({ general: { orthogonalprojection: { width: 1920, height: 1080 } }, objects }),
      "P:/p/models/plain.json": JSON.stringify({ material: "materials/a.json" }),
      "P:/p/materials/a.json": JSON.stringify({ passes: [{ shader: "s", blending: "translucent" }] }),
      "P:/p/materials/kbmodel/white.json": material,
      "P:/p/materials/kbmodel/white_tr.json": JSON.stringify({
        passes: [{ shader: "generic4", blending: "translucent" }],
      }),
      "P:/p/shaders/s.vert": "void main() {}",
      "P:/p/shaders/s.frag": "void main() {}",
      "P:/p/shaders/generic4.vert": "void main() {}",
      "P:/p/shaders/generic4.frag": "void main() {}",
      ...Object.fromEntries(Object.entries(mdls).map(([path, bytes]) => [`P:/p/${path}`, bytes])),
    }),
    translator: fakeTranslator(requests),
    postprocess: "disabled",
    exhaustive: true,
  });
  return { bundle, requests };
}

describe("compileScene：模型对象的骨骼（P12b2-1 点 1、3）", () => {
  const rig = mdl as Fixture;
  const rigObject = objectOf(rig, "M_mix");
  const rigBytes = mdlBytes(rig.mdls[rigObject.path]);
  const modelObject = (extra: Record<string, unknown> = {}) => ({
    id: 1,
    name: "M",
    model: "models/rig4.mdl",
    origin: "300 700 0",
    animationlayers: rigObject.layers,
    ...extra,
  });

  it("有骨骼的模型：skeleton 挂在 layer.model 上，网格材质带 SKINNING / BONECOUNT，不报任何键", async () => {
    const { bundle, requests } = await compile([modelObject()], { "models/rig4.mdl": rigBytes });
    expect(bundle.unsupported).toEqual([]);
    const model = bundle.layers[0].model!;
    expect(model.skeleton!.layers).toHaveLength(2);
    expect(model.skeleton!.skeleton.parents.length).toBe(4);
    expect(requests.map((request) => request.combos ?? {})).toContainEqual({ SKINNING: 1, BONECOUNT: 16 });
    expect(model.meshes[0].passes[0]).toMatchObject({ key: "objects/0/meshes/0/passes/0" });
  });

  it("没有 animationlayers：保持绑定姿势，仍有 skeleton（没有骨骼的静态模型不写 skeleton 键，见 p5c.test.ts）", async () => {
    const { bundle } = await compile([modelObject({ animationlayers: undefined })], { "models/rig4.mdl": rigBytes });
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.layers[0].model!.skeleton!.layers).toEqual([]);
  });

  it("动画层的 {user} 绑定登记成 animation-layer 目标（同图像层）", async () => {
    const layers = [{ ...(rigObject.layers[0] as object), rate: { user: "speed", value: 2 } }];
    const { bundle } = await compile([modelObject({ animationlayers: layers })], { "models/rig4.mdl": rigBytes });
    expect(bundle.bindings).toContainEqual(
      expect.objectContaining({
        property: "speed",
        target: { kind: "animation-layer", object: 0, layer: 0, field: "rate" },
      }),
    );
  });

  it("变形网格：MORPHING / MORPHING_NORMALS 进组合键，程序检查放行 g_MorphOffsets / g_MorphWeights；planModelLayer 给槽 5 绑该网格的变形纹理", async () => {
    const fixture = morph as Fixture;
    const object = objectOf(fixture, "mo_two");
    const bytes = mdlBytes(fixture.mdls[object.path]);
    const { bundle, requests } = await compile(
      [{ id: 1, name: "M", model: "models/two.mdl", origin: "0 0 0", animationlayers: object.layers }],
      { "models/two.mdl": bytes },
    );
    expect(bundle.unsupported).toEqual([]);
    expect(requests.map((request) => request.combos ?? {})).toContainEqual({ SKINNING: 1, BONECOUNT: 16, MORPHING: 1 });
    const layer = bundle.layers[0];
    const plan = planModelLayer({ model: layer.model, sprite: null, object: 7 });
    expect(plan.steps.map((step) => (step.kind === "mesh" ? [step.mesh, step.inputs[5]] : null))).toEqual([
      [0, { kind: "morph", object: 7, mesh: 0 }],
      [1, { kind: "morph", object: 7, mesh: 1 }],
    ]);
    const plain = planModelLayer({ model: { ...layer.model!, skeleton: undefined }, sprite: null, object: 7 });
    expect(plain.steps.map((step) => (step.kind === "mesh" ? step.inputs[5] : 0))).toEqual([undefined, undefined]);
  });

  it("挂点：子对象的 attachment 在带骨骼的模型父上解析（骨骼下标、Att 矩阵）；找不到名字按普通父子", async () => {
    const fixture = att as Fixture;
    const object = objectOf(fixture, "M_anim");
    const bytes = mdlBytes(fixture.mdls[object.path]);
    const child = (extra: Record<string, unknown>) => ({
      id: 2,
      name: "C",
      image: "models/plain.json",
      parent: 1,
      ...extra,
    });
    const { bundle } = await compile(
      [
        { id: 1, name: "M", model: "models/rigatt.mdl", origin: "0 0 0", animationlayers: object.layers },
        child({ attachment: "tipB" }),
        child({ id: 3, attachment: "nope" }),
      ],
      { "models/rigatt.mdl": bytes },
    );
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.layers[1].attachment).toMatchObject({ parent: 0, bone: 2 });
    expect(bundle.layers[1].attachment!.matrix.length).toBe(16);
    expect(bundle.layers[2].attachment).toBeUndefined();
  });

  it("transferableBuffers 带上模型骨骼的动画帧数据与变形纹理", async () => {
    const fixture = morph as Fixture;
    const object = objectOf(fixture, "mo_ovr");
    const bytes = mdlBytes(fixture.mdls[object.path]);
    const { bundle } = await compile(
      [{ id: 1, name: "M", model: "models/ovr.mdl", origin: "0 0 0", animationlayers: object.layers }],
      { "models/ovr.mdl": bytes },
    );
    const skeleton = bundle.layers[0].model!.skeleton!;
    const buffers = transferableBuffers(bundle);
    expect(buffers).toContain(skeleton.animations[0].frames.buffer);
    expect(buffers).toContain(skeleton.morphs[0]!.texels.buffer);
    expect(buffers).toContain(skeleton.animations[0].meshMorph![0]![0]!.buffer);
  });
});

// ———— 本机语料 ————

const wpeRoot = process.env.KABEGAME_WPE_ROOT ?? "D:/Applications/Steam/steamapps/common/wallpaper_engine";
const workshop = join(wpeRoot, "..", "..", "workshop", "content", "431960");
const wasm = new URL("../wpesl2wgsl/wpesl2wgsl.wasm", import.meta.url);

describe.skipIf(!existsSync(join(workshop, "3706286085")) || !existsSync(wasm))(
  "本机语料：3706286085 的带骨骼模型（P12b2-1）",
  () => {
    const nodeFetch: typeof fetch = async (input, init) => {
      const path = String(input);
      let size: number;
      try {
        size = statSync(path).size;
      } catch {
        throw new TypeError("Failed to fetch");
      }
      const range = new Headers(init?.headers).get("Range")?.match(/^bytes=(\d+)-(\d+)$/);
      const start = range ? Number(range[1]) : 0;
      const end = range ? Number(range[2]) + 1 : size;
      if (range && start >= size) throw new TypeError("Failed to fetch");
      const fd = openSync(path, "r");
      try {
        const bytes = new Uint8Array(Math.max(0, Math.min(end, size) - start));
        readSync(fd, bytes, 0, bytes.length, start);
        return new Response(bytes.buffer, { status: 200 });
      } finally {
        closeSync(fd);
      }
    };

    it("编译后的不支持项只剩 P13 的键（雾、方向光阴影）、puppet:layer-script 与 object:parent；带骨骼的模型都有 skeleton", async () => {
      vi.stubGlobal("fetch", nodeFetch);
      try {
        const translator = await RealTranslator.fromBytes(readFileSync(wasm));
        const bundle = await compileScene({
          projectDir: join(workshop, "3706286085"),
          sceneAssets: [join(wpeRoot, "assets")],
          reader: new FetchSceneReader(),
          translator,
          postprocess: "disabled",
          reflection: "disabled",
          exhaustive: true,
        });
        // 模型骨骼本身的键都不在：mdl:skeleton / mdl:animation / mdl:morph / mdl:flags:0x400 / object:animationlayers
        const gone = bundle.unsupported.filter((key) =>
          /^(mdl:(skeleton|animation|morph|attachment|flags|section)|object:animationlayers|model:rootmotion|combo:(SKINNING|MORPHING)|uniform:g_(Bones|Morph))/.test(
            key,
          ),
        );
        expect(gone).toEqual([]);
        // 剩下的：P13 的雾（general:fog*）与方向光阴影（lightconfig:directionalshadow）、挂在模型下的点光（object:parent，P13f）；动画层字段脚本 P12c 起不再报
        const rest = bundle.unsupported.filter((key) => !/^(general:fog|lightconfig:)/.test(key));
        expect(rest.sort()).toEqual(["object:parent"]);
        const skeletons = bundle.layers.filter((layer) => layer.model?.skeleton);
        // FBX_Stage、RioSonic、BoostModel1/2/3
        expect(skeletons.length).toBe(5);
        const bones = skeletons.map((layer) => layer.model!.skeleton!.skeleton.parents.length).sort((a, b) => a - b);
        expect(bones).toEqual([2, 3, 3, 3, 79]);
      } finally {
        vi.unstubAllGlobals();
      }
    }, 120000);
  },
);
