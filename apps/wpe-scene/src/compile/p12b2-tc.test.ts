/**
 * P12b2-2 点 1、3、4：图像层 puppet 的纹理通道——编译与渲染图（`.claude/plans/wpe-import/3-scene/phase12/phase-12b2-texchan-model.md`「P12b2-2」）。
 * - `buildPuppet`：skinned 且有 bit1 网格时 `textureChannels`（网格视图、材质路径、行数 = 网格多读的 u32 的低字节）、`PuppetAnimation.channels`（MDLA v ≥ 3 的 n3 条轨道），
 *   不再报 `puppet:texture-channels`；不是 skinned 仍报；只认第一个 bit1 网格；
 * - 整张场景：通道材质 pass（键 `objects/<i>/texchan`，`BLENDROWCOUNT` = 行数）、强制合成路径、预光照照报 `puppet:texture-channels:prelighting`、材质缺失、`transferableBuffers`；
 * - 渲染图：基础 pass 之后同一个合成 RT 里多一步 `texchan`（几何 `texchan`、角色 `base`、混合按材质），MVP 是合成 RT 的 `ortho(0, W, 0, H)`，逐位对 WPE 抓帧（p12b2-tc）；
 * - 真翻译器（本机有 wasm 与 WPE 的 `assets` 才跑）：`p12b2-tc` 的 `DOUBLEBUFFERED` / `BLENDROWCOUNT`、`g_BlendMap` 的反射；语料 `3811424158` 在 P6e 之后不剩不支持项。
 * 样本：`../puppet/fixtures/p12b2-tc.json`（`ignore/p12/b2/impl/mkfix_texchan.py`）。
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import mdlFixture from "../puppet/fixtures/p12b2-mdl.json";
import tc from "../puppet/fixtures/p12b2-tc.json";
import { planLayer } from "../render/graph";
import { drawMatrices } from "../render/uniforms";
import { Wpesl2wgsl as RealTranslator, type TranslateRequest, type TranslateResult } from "../wpesl2wgsl";
import { compileScene, transferableBuffers, type SceneLayer, type ScenePass } from "./bundle";
import { FetchSceneReader, type SceneReader } from "./fs";
import { parseMdl, type MdlFile, type MdlMesh } from "./mdl";
import { buildPuppet } from "./puppet";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

interface FixtureObject {
  name: string;
  object: number;
  path: string;
  layers: unknown[];
  rows: number;
  draws: Record<string, { blendMap: number[]; mvp: number[]; texture1Resolution: number[]; color4: number[] }>;
}
interface Fixture {
  frames: number[];
  mdls: Record<string, string>;
  objects: FixtureObject[];
}
const fixture = tc as Fixture;
const byName = (name: string) => fixture.objects.find((item) => item.name === name)!;
const mdlBytes = (text: string) => new Uint8Array(gunzipSync(Buffer.from(text, "base64")));
const fileOf = (object: FixtureObject) => parseMdl(mdlBytes(fixture.mdls[object.path]));

// ———— buildPuppet ————

describe("buildPuppet：纹理通道（P12b2-2 点 1）", () => {
  it("p12b2-tc 的 10 个 puppet：不再报 puppet:texture-channels；textureChannels 取第一个 bit1 网格（网格 1）、网格自己的材质、行数", () => {
    for (const object of fixture.objects) {
      const file = fileOf(object);
      const built = buildPuppet(file, object.layers, object.path);
      expect([...built.issues], object.name).toEqual([]);
      const channels = built.puppet!.textureChannels!;
      expect(channels, object.name).not.toBeNull();
      expect(channels.rows, object.name).toBe(object.rows);
      expect(channels.material, object.name).toBe(file.meshes[1].materials[0]);
      // 通道网格自己的格式与视图（a_Position、a_BlendIndices、a_TexCoordVec4），不是网格 0 的
      expect(channels.mesh.format).toBe(0x800021);
      expect(channels.mesh.vertices).toBe(file.meshes[1].vertices);
      expect(channels.mesh.indices).toBe(file.meshes[1].indices);
      expect(channels.mesh.indexCount).toBe(file.meshes[1].indices.length >> 1);
      expect(channels.mesh.vertexCount).toBe(file.meshes[1].vertexCount);
    }
  });

  it("行数 = 网格多读的 u32 的低字节（高字节不看）；材质路径是 mesh.materials[0]", () => {
    const file = fileOf(byName("tc_ovr"));
    const widened: MdlFile = {
      ...file,
      meshes: file.meshes.map((mesh, i) => (i === 1 ? { ...mesh, blendRowCount: 0x1203 } : mesh)),
    };
    const built = buildPuppet(widened, [], "m.mdl");
    expect(built.puppet!.textureChannels!.rows).toBe(3);
  });

  it("PuppetAnimation.channels：MDLA v ≥ 3 的 n3 条轨道（自有缓冲，每条 length + 1 个 f32）；没有纹理通道的 puppet 不填", () => {
    const object = byName("tc_r4");
    const built = buildPuppet(fileOf(object), object.layers, object.path);
    const [animation] = built.puppet!.animations;
    expect(animation.channels!.length).toBe(16);
    for (const track of animation.channels!) expect(track.length).toBe(animation.length + 1);
    // 自有缓冲：不是 mdl 文件缓冲上的视图
    const file = fileOf(object);
    expect(animation.channels![0].buffer).not.toBe(file.meshes[0].vertices.buffer);
    // 第 k 条轨道恒 (k + 1) / 16（p12b2-tc 的定义）
    expect(animation.channels![5][0]).toBe(Math.fround(6 / 16));
    // 去掉通道网格（flags 清 bit1）就不填
    const plain: MdlFile = { ...file, meshes: file.meshes.map((mesh) => ({ ...mesh, flags: 0 })) };
    expect(buildPuppet(plain, object.layers, object.path).puppet!.animations[0].channels).toBeUndefined();
  });

  it("只认第一个 bit1 网格；不是 skinned（网格 0 没有 a_BlendIndices 或没有骨骼）时 WPE 怎么画没查清，仍报 puppet:texture-channels", () => {
    const file = fileOf(byName("tc_ovr"));
    const extra: MdlMesh = { ...file.meshes[1], materials: ["materials/other.json"], blendRowCount: 2 };
    const two: MdlFile = { ...file, meshes: [...file.meshes, extra] };
    const built = buildPuppet(two, [], "m.mdl");
    expect([...built.issues]).toEqual([]);
    expect(built.puppet!.textureChannels).toMatchObject({ material: file.meshes[1].materials[0], rows: 1 });
    const noBlend: MdlFile = {
      ...file,
      meshes: file.meshes.map((mesh, i) => (i === 0 ? { ...mesh, format: mesh.format & ~0x800000 } : mesh)),
    };
    const unskinned = buildPuppet(noBlend, [], "m.mdl");
    expect([...unskinned.issues]).toEqual(["puppet:texture-channels"]);
    expect(unskinned.puppet!.textureChannels).toBeNull();
    const noBones: MdlFile = { ...file, skeleton: null };
    expect([...buildPuppet(noBones, [], "m.mdl").issues]).toEqual(["puppet:texture-channels"]);
  });
});

// ———— 整张场景（假翻译器） ————

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

/** 假翻译器：组合键原样回给 `combos`；带 `SKINNING` 时有 `g_Bones`，带 `BLENDROWCOUNT` 时有 `g_BlendMap`（`array<vec4<f32>, BLENDROWCOUNT>`）。 */
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
      const rows = Number(request.combos?.BLENDROWCOUNT ?? 0);
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
        ...(rows
          ? [
              {
                name: "g_BlendMap",
                type: `array<vec4<f32>, ${rows}>`,
                declared: "vec4",
                offset: 0,
                size: 16 * rows,
                array: rows,
                stride: 16,
              },
            ]
          : []),
      ];
      return { ok: true, uniforms, uniformBlockSize: 0, textures: [], combos } as unknown as TranslateResult;
    },
  } as unknown as RealTranslator;
}

async function compile(
  objects: Record<string, unknown>[],
  mdls: Record<string, Uint8Array>,
  baseCombos: Record<string, number> = {},
  extra: Record<string, string> = {},
) {
  const requests: TranslateRequest[] = [];
  const bundle = await compileScene({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    reader: memoryReader({
      "P:/p/project.json": JSON.stringify({ file: "scene.json" }),
      "P:/p/scene.json": JSON.stringify({ general: { orthogonalprojection: { width: 1920, height: 1080 } }, objects }),
      "P:/p/models/pup.json": JSON.stringify({ material: "materials/base.json", puppet: "models/tc.mdl" }),
      "P:/p/materials/base.json": JSON.stringify({
        passes: [{ shader: "genericimage4", blending: "translucent", combos: baseCombos }],
      }),
      "P:/p/materials/kbtc/ch1.json": JSON.stringify({
        passes: [{ shader: "puppettexturechannels", blending: "normal", combos: { BLENDROWCOUNT: 1 } }],
      }),
      "P:/p/shaders/genericimage4.vert": "void main() {}",
      "P:/p/shaders/genericimage4.frag": "void main() {}",
      "P:/p/shaders/puppettexturechannels.vert": "void main() {}",
      "P:/p/shaders/puppettexturechannels.frag": "void main() {}",
      "P:/p/materials/util/effectpassthrough.json": JSON.stringify({ passes: [{ shader: "genericimage4" }] }),
      ...extra,
      ...Object.fromEntries(Object.entries(mdls).map(([path, bytes]) => [`P:/p/${path}`, bytes])),
    }),
    translator: fakeTranslator(requests),
    postprocess: "disabled",
    exhaustive: true,
  });
  return { bundle, requests };
}

describe("compileScene：纹理通道（P12b2-2 点 1）", () => {
  const object = byName("tc_ovr");
  const bytes = mdlBytes(fixture.mdls[object.path]);
  const puppetObject = (extra: Record<string, unknown> = {}) => ({
    id: 1,
    name: "P",
    image: "models/pup.json",
    origin: "300 700 0",
    size: "256 128",
    animationlayers: object.layers,
    ...extra,
  });
  const layerOf = (bundle: { layers: SceneLayer[] }) => bundle.layers[0];

  it("通道网格的材质：网格自己的材质 + BLENDROWCOUNT（低字节），键 objects/<i>/texchan，放行 g_BlendMap；不带 puppet 的 SKINNING 组合键", async () => {
    const { bundle, requests } = await compile([puppetObject()], { "models/tc.mdl": bytes });
    expect(bundle.unsupported).toEqual([]);
    const channels = layerOf(bundle).puppet!.textureChannels!;
    expect(channels.pass).toMatchObject({ key: "objects/0/texchan" });
    const request = requests.find((item) => "BLENDROWCOUNT" in (item.combos ?? {}));
    expect(request?.combos).toEqual({ BLENDROWCOUNT: 1 });
  });

  it("强制合成路径：没有 effect、没有混合、没被依赖也一样（composite、upload 都有，直接上屏的 passes 为空）", async () => {
    const { bundle } = await compile([puppetObject()], { "models/tc.mdl": bytes });
    const puppet = layerOf(bundle).puppet!;
    expect(puppet.composite).toBe(true);
    expect(puppet.upload).not.toBeNull();
    expect(puppet.passes).toEqual([]);
  });

  it("没有纹理通道的 puppet（p12b2-mdl 的 rig4）：没有 effect 时仍直接上屏（composite 假、passes 一个、没有 textureChannels pass），不进 g_BlendMap", async () => {
    const rig = mdlBytes(mdlFixture.mdls["models/rig4.mdl"]);
    const { bundle } = await compile([puppetObject({ animationlayers: [] })], { "models/tc.mdl": rig });
    const puppet = layerOf(bundle).puppet!;
    expect(puppet.textureChannels ?? null).toBeNull();
    expect(puppet.composite).toBe(false);
    expect(puppet.passes).toHaveLength(1);
    expect(puppet.upload).toBeNull();
  });

  it("基础材质带 LIGHTING（或 REFLECTION）：WPE 要另建 RT 预光照，照报 puppet:texture-channels:prelighting；没有就不报", async () => {
    const lit = await compile([puppetObject()], { "models/tc.mdl": bytes }, { LIGHTING: 1 });
    expect(lit.bundle.unsupported).toContain("puppet:texture-channels:prelighting");
    const reflective = await compile([puppetObject()], { "models/tc.mdl": bytes }, { REFLECTION: 1 });
    expect(reflective.bundle.unsupported).toContain("puppet:texture-channels:prelighting");
    const plain = await compile([puppetObject()], { "models/tc.mdl": bytes });
    expect(plain.bundle.unsupported).not.toContain("puppet:texture-channels:prelighting");
  });

  it("通道网格的材质读不到：报 material:missing:<路径>，pass 为 null（渲染图不画通道）", async () => {
    const { bundle } = await compile(
      [puppetObject()],
      { "models/tc.mdl": bytes },
      {},
      { "P:/p/materials/kbtc/ch1.json": "" },
    );
    expect(bundle.unsupported).toContain(`material:missing:${fileOf(object).meshes[1].materials[0]}`);
    expect(layerOf(bundle).puppet!.textureChannels!.pass).toBeNull();
  });

  it("transferableBuffers 带上纹理通道轨道（自有缓冲）", async () => {
    const { bundle } = await compile([puppetObject()], { "models/tc.mdl": bytes });
    const [animation] = layerOf(bundle).puppet!.animations;
    const buffers = transferableBuffers(bundle);
    expect(animation.channels!.length).toBe(4);
    for (const track of animation.channels!) expect(buffers).toContain(track.buffer);
  });
});

// ———— 渲染图与矩阵 ————

describe("planLayer：基础 pass 之后同一个合成 RT 里多一步纹理通道（P12b2-2 点 3）", () => {
  const pass = (key: string, partial: Partial<ScenePass> = {}): ScenePass => ({
    key,
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
  });
  const object = byName("tc_ovr");
  const channels = () => {
    const built = buildPuppet(fileOf(object), object.layers, object.path).puppet!;
    return { ...built.textureChannels!, pass: pass("objects/0/texchan", { program: 2, blending: "normal" }) };
  };
  const layerOf = (partial: Partial<SceneLayer> = {}): SceneLayer =>
    ({
      id: 10,
      object: 0,
      parent: null,
      name: "L",
      origin: [0, 0, 0],
      scale: [1, 1, 1],
      angles: [0, 0, 0],
      size: [256, 128],
      alpha: 1,
      color: [1, 1, 1],
      brightness: 1,
      visible: true,
      visibleBound: false,
      parallaxDepth: [0, 0],
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
      passes: [pass("objects/0/passes/0", { program: 0, textures: { 0: 0 } })],
      colorBlendMode: 0,
      effects: [],
      passthrough: null,
      particle: null,
      puppet: {
        ...buildPuppet(fileOf(object), object.layers, object.path).puppet!,
        composite: true,
        passes: [],
        upload: pass("objects/0/puppetupload", { program: 1, blending: "normal" }),
        textureChannels: channels(),
      },
      ...partial,
    }) as SceneLayer;
  const textures = [{ width: 256, height: 128, textureWidth: 256, textureHeight: 128 }];

  it("步骤序列：基础四边形 → 纹理通道（base 角色、texchan 几何、同一个合成 RT）→ puppet 网格上屏", () => {
    const plan = planLayer(layerOf(), textures);
    expect(plan.reasons).toEqual([]);
    const steps = plan.steps.flatMap((step) =>
      step.kind === "draw" ? [`${step.role}:${step.geometry}→${step.target.kind}`] : [step.kind],
    );
    expect(steps).toEqual(["base:fill→composite", "base:texchan→composite", "passthrough:puppet→scene"]);
    const [base, texchan] = plan.steps.filter((step) => step.kind === "draw");
    expect(texchan).toMatchObject({
      target: { kind: "composite", index: 0 },
      blending: "normal",
      effect: null,
      rtSize: [256, 128],
    });
    expect(texchan.target).toEqual(base.target);
    expect(plan.composite).toEqual({ count: 1, width: 256, height: 128 });
  });

  it("混合按材质（translucent 的通道材质就是 translucent）；没有 pass（材质读不到）时不画通道", () => {
    const layer = layerOf();
    layer.puppet!.textureChannels!.pass = pass("objects/0/texchan", { program: 2, blending: "translucent" });
    const plan = planLayer(layer, textures);
    expect(plan.steps.find((step) => step.kind === "draw" && step.geometry === "texchan")).toMatchObject({
      blending: "translucent",
    });
    const missing = layerOf();
    missing.puppet!.textureChannels!.pass = null;
    expect(planLayer(missing, textures).steps.filter((step) => step.kind === "draw")).toHaveLength(2);
  });

  it("没有纹理通道的 puppet：步骤序列与以前相同（没有 texchan 步骤，也没有 rtSize 字段）", () => {
    const layer = layerOf();
    layer.puppet!.textureChannels = null;
    const plan = planLayer(layer, textures);
    expect(plan.steps.map((step) => (step.kind === "draw" ? step.geometry : step.kind))).toEqual(["fill", "puppet"]);
    for (const step of plan.steps) expect("rtSize" in step).toBe(false);
  });

  it("被依赖（合成 RT 对调）时通道那一步跟着换合成 RT（同基础 pass）", () => {
    const plan = planLayer(layerOf({ dependedOn: true } as Partial<SceneLayer>), textures);
    const draws = plan.steps.filter((step) => step.kind === "draw");
    const texchan = draws.find((step) => step.geometry === "texchan")!;
    expect(texchan.target).toEqual(draws[0].target);
  });

  it("MVP 逐位对 WPE 抓帧：ortho(0, W, 0, H)（z 系数 1/2000、平移 0.5），模型矩阵单位阵；W、H 是合成 RT 的宽高（rtSize）", () => {
    const want = object.draws[String(fixture.frames[0])].mvp;
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const matrices = drawMatrices(
      { role: "base", geometry: "texchan" },
      Float32Array.from(identity),
      [256, 128],
      Float32Array.from(identity),
    );
    expect(Array.from(matrices.modelViewProjection).map(Math.fround)).toEqual(want.map(Math.fround));
    expect(Array.from(matrices.model)).toEqual(identity);
    // 基础四边形的 fill 是居中的正交（不同于通道网格的左下原点）
    const fill = drawMatrices({ role: "base" }, Float32Array.from(identity), [256, 128], Float32Array.from(identity));
    expect(Array.from(fill.modelViewProjection)).not.toEqual(want);
  });
});

// ———— 真翻译器与本机语料 ————

const wpeRoot = process.env.KABEGAME_WPE_ROOT ?? "D:/Applications/Steam/steamapps/common/wallpaper_engine";
const workshop = join(wpeRoot, "..", "..", "workshop", "content", "431960");
const wasm = new URL("../wpesl2wgsl/wpesl2wgsl.wasm", import.meta.url);
const genProject = "D:/Codes/kabegame/ignore/p12/b2/gen/proj/p12b2-tc";
const haveTranslator = existsSync(wasm) && existsSync(join(wpeRoot, "assets"));

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

async function compileReal(projectDir: string) {
  vi.stubGlobal("fetch", nodeFetch);
  try {
    const translator = await RealTranslator.fromBytes(readFileSync(wasm));
    return await compileScene({
      projectDir,
      sceneAssets: [join(wpeRoot, "assets")],
      reader: new FetchSceneReader(),
      translator,
      postprocess: "disabled",
      reflection: "disabled",
      exhaustive: true,
    });
  } finally {
    vi.unstubAllGlobals();
  }
}

describe.skipIf(!haveTranslator || !existsSync(genProject))("真翻译器：p12b2-tc 生成工程（P12b2-2 点 1）", () => {
  it("每个 puppet 的通道材质：BLENDROWCOUNT = 行数、DOUBLEBUFFERED 按槽 1 有无纹理（tc_db0 只给通道图 → 0，其余 1）；g_BlendMap 是 array<vec4<f32>, 行数>", async () => {
    const bundle = await compileReal(genProject);
    const comboOf = (program: number, name: string) =>
      bundle.programs[program].combos?.find((combo) => combo.name === name)?.value;
    const layers = bundle.layers.filter((layer) => layer.puppet?.textureChannels);
    expect(layers.map((layer) => layer.name)).toEqual(fixture.objects.map((item) => item.name));
    for (const layer of layers) {
      const object = byName(layer.name);
      const channels = layer.puppet!.textureChannels!;
      expect(channels.pass, layer.name).toBeTruthy();
      const program = channels.pass!.program!;
      expect(comboOf(program, "BLENDROWCOUNT"), layer.name).toBe(object.rows);
      // 槽 1 没有纹理时 DOUBLEBUFFERED 不出现在翻译结果的 combos 里（着色器缺省 0）
      expect(comboOf(program, "DOUBLEBUFFERED") ?? 0, layer.name).toBe(layer.name === "tc_db0" ? 0 : 1);
      const map = bundle.programs[program].uniforms?.find((uniform) => uniform.name === "g_BlendMap");
      expect(map, layer.name).toMatchObject({ type: `array<vec4<f32>, ${object.rows}>` });
    }
    // 纹理通道本身不报键（其余键来自生成工程里的时钟文字层，和 P12b2 无关）
    expect(bundle.unsupported.filter((key) => key.startsWith("puppet:texture-channels"))).toEqual([]);
  }, 120000);
});

describe.skipIf(!haveTranslator || !existsSync(join(workshop, "3811424158")))(
  "本机语料：3811424158 的纹理通道（P12b2-2）",
  () => {
    it("P6e 起精灵表帧动画不再报（combo:SPRITESHEET、tex:animation 都没有了）；01_z 有纹理通道（4 条通道轨道、BLENDROWCOUNT 1、DOUBLEBUFFERED 1）", async () => {
      const bundle = await compileReal(join(workshop, "3811424158"));
      expect([...bundle.unsupported].sort()).toEqual([]);
      const layer = bundle.layers.find((item) => item.puppet?.textureChannels)!;
      expect(layer.name).toBe("01_z");
      const channels = layer.puppet!.textureChannels!;
      expect(channels.rows).toBe(1);
      expect(channels.mesh.vertexCount).toBe(44);
      const program = bundle.programs[channels.pass!.program!];
      expect(program.combos?.find((combo) => combo.name === "BLENDROWCOUNT")?.value).toBe(1);
      expect(program.combos?.find((combo) => combo.name === "DOUBLEBUFFERED")?.value).toBe(1);
      // 动画 231 有 4 条通道轨道，但对象没有 animationlayers：没有层引用它，g_BlendMap 恒为 0
      expect(layer.puppet!.layers).toEqual([]);
      expect(layer.puppet!.composite).toBe(true);
    }, 120000);
  },
);
