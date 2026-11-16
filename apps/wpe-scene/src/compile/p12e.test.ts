/**
 * P12e-1 的编译侧单测（`.claude/plans/wpe-import/3-scene/phase12/phase-12e-createlayer.md` 点 1、点 3 与对照表 29）：
 * - 动画全编：`ScenePuppet.animations` / `ModelSkeleton.animations` 是 MDLA 的每一条，`PuppetLayerDef.animation` 是 MDLA 下标；
 * - 被引用的动画的问题照旧报进 `issues`；没被引用又不支持的只留 stub（`unsupported`，不转帧数据）、不报；
 * - 层 id = `entry`：`{user}` 绑定目标按 `entry`（前面的项被丢时与层表位置错开）；
 * - 取值改严：float 只收 JSON 数、位只收 JSON 布尔（编译期与运行时建层共用 `floatField` / `boolField`）。
 */
import { gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { compileScene } from "./bundle";
import type { SceneReader } from "./fs";
import { parseMdl, type MdlAnimation, type MdlBone, type MdlFile, type MdlMesh, type MdlSkeleton } from "./mdl";
import { boolField, buildModelSkeleton, buildPuppet, floatField } from "./puppet";
import { SceneState } from "../render/state";
import modes from "../puppet/fixtures/p12-modes.json";
import type { TranslateRequest, TranslateResult, Wpesl2wgsl } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

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

function bone(parent: number): MdlBone {
  return { name: "b", flags: 1, parent, local: Float32Array.from(IDENTITY), json: "" };
}

function skeleton(bones: MdlBone[]): MdlSkeleton {
  return {
    version: 4,
    count: bones.length,
    bones,
    restMatrices: null,
    drawOrder: null,
    extras: { records: 0, constraints: 0, keyMaps: 0, chains: 0 },
  };
}

/** 一条 loop 动画：`bones` 条轨道（默认与骨骼数相同），每帧 9 个数。 */
function animation(id: number, bones: number, extra: Partial<MdlAnimation> = {}): MdlAnimation {
  return {
    id,
    name: `a${id}`,
    mode: "loop",
    fps: 10,
    length: 2,
    flags: 0,
    tracks: Array.from({ length: bones }, () => ({
      flags: 0,
      frames: Float32Array.from({ length: 3 * 9 }, (_, i) => (i % 9 === 6 || i % 9 === 7 || i % 9 === 8 ? 1 : i)),
    })),
    boneAlpha: null,
    morphWeights: null,
    drawOrderTrack: false,
    events: [{ time: 0.1, json: '{"e":1}' }],
    unsupported: false,
    ...extra,
  };
}

function file(animations: MdlAnimation[], extra: Partial<MdlFile> = {}): MdlFile {
  return {
    version: 23,
    skins: 1,
    meshes: [mesh()],
    bounds: [],
    sections: [],
    truncated: false,
    skeleton: skeleton([bone(-1), bone(0)]),
    animations,
    attachments: [],
    sectionIssues: [],
    ...extra,
  };
}

/** 三条动画：7 正常；9 轨道数不等于骨骼数（`mdl:animation:tracks`）；11 引用块（`puppet:animation-ref`）。 */
const mixed = () => [animation(7, 2), animation(9, 1), animation(11, 2, { unsupported: true })];

describe("buildPuppet：动画全编（P12e 点 1）", () => {
  it("没被引用的动画也转：animations 是 MDLA 的每一条，layer.animation 是 MDLA 下标", () => {
    const { puppet, issues } = buildPuppet(
      file([animation(7, 2), animation(8, 2), animation(9, 2)]),
      [{ animation: 9 }],
      "p",
    );
    expect([...issues]).toEqual([]);
    expect(puppet!.animations.map((item) => item.id)).toEqual([7, 8, 9]);
    expect(puppet!.layers.map((layer) => layer.animation)).toEqual([2]);
    // 没被引用的动画是完整转换：帧数据在、没有 unsupported 键
    for (const item of puppet!.animations) {
      expect(item.frames.length).toBe(3 * 2 * 10);
      expect("unsupported" in item).toBe(false);
    }
  });

  it("没被引用又不支持的动画只记在动画上、不报进 issues，也不转帧数据（stub）", () => {
    const { puppet, issues } = buildPuppet(file(mixed()), [{ animation: 7 }], "p");
    expect([...issues]).toEqual([]);
    const [ok, tracks, ref] = puppet!.animations;
    expect("unsupported" in ok).toBe(false);
    expect(ok.frames.length).toBeGreaterThan(0);
    for (const stub of [tracks, ref]) {
      expect(stub.frames.length).toBe(0);
      expect(stub.mask.length).toBe(0);
      expect(stub.alpha).toBeNull();
      expect(stub.morph).toBeNull();
      expect(stub.events).toEqual([{ time: 0.1, json: '{"e":1}' }]);
    }
    expect(tracks).toMatchObject({
      id: 9,
      name: "a9",
      mode: 0,
      fps: 10,
      length: 2,
      unsupported: ["mdl:animation:tracks"],
    });
    expect(ref.unsupported).toEqual(["puppet:animation-ref"]);
  });

  it("被引用的不支持动画照旧报进 issues，而且是完整转换（不是 stub）", () => {
    const tracks = buildPuppet(file(mixed()), [{ animation: 9 }], "p");
    expect([...tracks.issues]).toEqual(["mdl:animation:tracks"]);
    expect("unsupported" in tracks.puppet!.animations[1]).toBe(false);
    const ref = buildPuppet(file(mixed()), [{ animation: 11 }], "p");
    expect([...ref.issues]).toEqual(["puppet:animation-ref"]);
  });

  it("图像层：骨骼透明度轨道没有网格 bit2 / 绘制顺序轨道，被引用报键、没被引用只记 stub", () => {
    const alpha = animation(5, 2, { boneAlpha: Float32Array.from({ length: 6 }, () => 1) });
    const order = animation(6, 2, { drawOrderTrack: true });
    const source = file([animation(7, 2), alpha, order]);
    const free = buildPuppet(source, [{ animation: 7 }], "p");
    expect([...free.issues]).toEqual([]);
    expect(free.puppet!.animations[1].unsupported).toEqual(["puppet:alpha-track"]);
    expect(free.puppet!.animations[2].unsupported).toEqual(["puppet:order-track"]);
    expect([...buildPuppet(source, [{ animation: 5 }], "p").issues]).toEqual(["puppet:alpha-track"]);
    expect([...buildPuppet(source, [{ animation: 6 }], "p").issues]).toEqual(["puppet:order-track"]);
    // 网格 0 标志 bit3：绘制顺序轨道报 draw-order
    const withDraw = file([order], { meshes: [mesh({ flags: 8 })] });
    expect([...buildPuppet(withDraw, [{ animation: 6 }], "p").issues]).toEqual(["puppet:draw-order"]);
  });

  it("静态 puppet：动画也按 MDLA 全部列出，但不转帧数据、不查问题", () => {
    const { puppet, issues } = buildPuppet(
      file(mixed(), { meshes: [mesh({ format: 0xf })] }),
      [{ animation: 9 }, { animation: 11 }],
      "p",
    );
    expect([...issues]).toEqual([]);
    expect(puppet!.skeleton).toBeNull();
    expect(puppet!.animations.map((item) => [item.id, item.frames.length, "unsupported" in item])).toEqual([
      [7, 0, false],
      [9, 0, false],
      [11, 0, false],
    ]);
    expect(puppet!.layers.map((layer) => layer.animation)).toEqual([1, 2]);
  });

  it("mdl:animation-id 仍对全部动画查（含没被引用的）", () => {
    const { issues } = buildPuppet(file([animation(7, 2), animation(2 ** 32 + 1, 2)]), [{ animation: 7 }], "p");
    expect([...issues]).toEqual(["mdl:animation-id"]);
  });
});

describe("buildModelSkeleton：动画全编（P12e 点 1）", () => {
  it("没被引用又不支持的只记 stub（带 bounds），被引用的照旧报；rootmotion 同理", () => {
    const rootmotion = animation(13, 2, { flags: 0x800 });
    const source = file([animation(7, 2), animation(9, 1), rootmotion]);
    const free = buildModelSkeleton(source, [{ animation: 7 }], { rootmotion: true });
    expect([...free.issues]).toEqual([]);
    const rig = free.skeleton!;
    expect(rig.animations.map((item) => item.id)).toEqual([7, 9, 13]);
    expect(rig.animations[1].unsupported).toEqual(["mdl:animation:tracks"]);
    expect(rig.animations[2].unsupported).toEqual(["model:rootmotion"]);
    expect(rig.animations[1].frames.length).toBe(0);
    expect(rig.animations[1].bounds).toEqual([0, 0, 0, 0, 0, 0]);
    expect("unsupported" in rig.animations[0]).toBe(false);
    expect(rig.layers.map((layer) => layer.animation)).toEqual([0]);
    expect([...buildModelSkeleton(source, [{ animation: 9 }], { rootmotion: true }).issues]).toEqual([
      "mdl:animation:tracks",
    ]);
    expect([...buildModelSkeleton(source, [{ animation: 13 }], { rootmotion: true }).issues]).toEqual([
      "model:rootmotion",
    ]);
    // 对象 rootmotion 为假时不查
    const off = buildModelSkeleton(source, [{ animation: 13 }], { rootmotion: false });
    expect([...off.issues]).toEqual([]);
    expect("unsupported" in off.skeleton!.animations[2]).toBe(false);
  });

  it("模型不查骨骼透明度 / 绘制顺序轨道（同图像层之前的规则）", () => {
    const alpha = animation(5, 2, { boneAlpha: Float32Array.from({ length: 6 }, () => 1), drawOrderTrack: true });
    const built = buildModelSkeleton(file([alpha]), [{ animation: 5 }], {});
    expect([...built.issues]).toEqual([]);
    expect("unsupported" in built.skeleton!.animations[0]).toBe(false);
  });
});

describe("取值改严（P12e 待定 4：编译期与运行时建层共用）", () => {
  it("floatField 只收 JSON 数（存 float32）；布尔、字符串、null 取缺省", () => {
    expect(floatField(0.3, 1)).toBe(Math.fround(0.3));
    expect(floatField(0, 1)).toBe(0);
    expect(floatField("0.3", 1)).toBe(1);
    expect(floatField(true, 1)).toBe(1);
    expect(floatField(null, 1)).toBe(1);
    expect(floatField(undefined, 0.5)).toBe(0.5);
    expect(floatField(Number.NaN, 2)).toBe(2);
  });

  it("boolField 只收 JSON 布尔；数字、字符串取缺省", () => {
    expect(boolField(false, true)).toBe(false);
    expect(boolField(true, false)).toBe(true);
    expect(boolField(0, true)).toBe(true);
    expect(boolField(1, false)).toBe(false);
    expect(boolField("true", false)).toBe(false);
    expect(boolField(null, true)).toBe(true);
  });
});

// ———— 整张场景：层 id 与 `{user}` 绑定 ————

const loop10 = modes.puppets.find((item) => item.name === "loop10")!;
const mdl = new Uint8Array(gunzipSync(Buffer.from(loop10.mdlGzip, "base64")));
const animationId = (loop10.layers[0] as { animation: number }).animation;

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

function fakeTranslator(): Wpesl2wgsl {
  return {
    async translate(request: TranslateRequest): Promise<TranslateResult> {
      const combos = Object.entries(request.combos ?? {}).map(([name, value]) => ({
        name,
        value: Number(value),
        source: "request" as const,
      }));
      const bones = Number(request.combos?.BONECOUNT ?? 0);
      return {
        ok: true,
        uniforms: request.combos?.SKINNING
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
          : [],
        uniformBlockSize: request.combos?.SKINNING ? 64 * bones : 0,
        textures: [],
        combos,
      } as unknown as TranslateResult;
    },
  } as unknown as Wpesl2wgsl;
}

async function compile(objects: Record<string, unknown>[]) {
  return compileScene({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    reader: memoryReader({
      "P:/p/project.json": JSON.stringify({ file: "scene.json" }),
      "P:/p/scene.json": JSON.stringify({ general: { orthogonalprojection: { width: 1920, height: 1080 } }, objects }),
      "P:/p/models/pup.json": JSON.stringify({ material: "materials/a.json", puppet: "models/pup.mdl" }),
      "P:/p/models/pup.mdl": mdl,
      "P:/p/materials/a.json": JSON.stringify({ passes: [{ shader: "s", blending: "translucent" }] }),
      "P:/p/shaders/s.vert": "void main() {}",
      "P:/p/shaders/s.frag": "void main() {}",
    }),
    translator: fakeTranslator(),
    postprocess: "disabled",
    exhaustive: true,
  });
}

describe("compileScene：层 id = entry（P12e 点 1）", () => {
  const object = () => ({
    id: 1,
    name: "P",
    image: "models/pup.json",
    origin: "960 540 0",
    animationlayers: [
      { animation: 424242 }, // 动画找不到：整层丢掉，entry 0 不进层表
      {
        animation: animationId,
        name: "walk",
        rate: { user: "speed", value: 2 },
        visible: { user: "show", value: true },
      },
    ],
  });

  it("{user} 绑定目标的 layer 是 entry（1），不是层表位置（0）；状态键同样按 entry", async () => {
    const bundle = await compile([object()]);
    expect(bundle.unsupported).toEqual([]);
    const puppet = bundle.layers[0].puppet!;
    expect(puppet.layers.map((layer) => layer.entry)).toEqual([1]);
    expect(
      bundle.bindings
        .filter((item) => item.target.kind === "animation-layer")
        .map((item) => [item.property, item.target]),
    ).toEqual([
      ["speed", { kind: "animation-layer", object: 0, layer: 1, field: "rate" }],
      ["show", { kind: "animation-layer", object: 0, layer: 1, field: "visible" }],
    ]);
    const state = SceneState.fromBundle(bundle);
    expect([...state.animationLayers.keys()]).toEqual(["0:1"]);
    // 用户属性按绑定目标写进同一个键
    const speed = bundle.bindings.find((item) => item.property === "speed")!;
    state.write(speed, 3);
    expect(state.animationLayers.get("0:1")!.rate).toBe(3);
  });

  it("动画全编：bundle 里的动画就是 mdl 的每一条", async () => {
    const bundle = await compile([object()]);
    const all = parseMdl(mdl).animations;
    expect(bundle.layers[0].puppet!.animations.map((item) => item.id)).toEqual(all.map((item) => item.id));
    expect(bundle.layers[0].puppet!.layers[0].animation).toBe(all.findIndex((item) => item.id === animationId));
  });
});

describe("SceneState：运行时建删层的状态项（P12e 点 3）", () => {
  const scene = () => [
    {
      id: 1,
      name: "P",
      image: "models/pup.json",
      origin: "960 540 0",
      animationlayers: [
        { animation: animationId, name: "a", rate: 2 },
        { animation: animationId, name: "b", blend: 0.5 },
      ],
    },
  ];

  it("addAnimationLayer 写一份拷贝；removeAnimationLayer 之后写入、重放都是空操作", async () => {
    const bundle = await compile(scene());
    const state = SceneState.fromBundle(bundle);
    expect([...state.animationLayers.keys()]).toEqual(["0:0", "0:1"]);
    const fields = { rate: 3, blend: 0.25, visible: false };
    state.addAnimationLayer(0, -1, fields);
    fields.rate = 99; // 拷贝，不共享引用
    expect(state.animationLayers.get("0:-1")).toEqual({ rate: 3, blend: 0.25, visible: false });
    // 三方共写：目标按层 id（负数）找到这一项
    state.write({ property: "x", target: { kind: "animation-layer", object: 0, layer: -1, field: "rate" } }, 7);
    expect(state.animationLayers.get("0:-1")!.rate).toBe(7);
    state.removeAnimationLayer(0, -1);
    expect(state.animationLayers.has("0:-1")).toBe(false);
    expect(
      state.write({ property: "x", target: { kind: "animation-layer", object: 0, layer: -1, field: "rate" } }, 8),
    ).toBe("applied");
    expect(state.animationLayers.has("0:-1")).toBe(false);
  });

  it("syncAnimationLayers：运行时有、状态没有的取上一份状态（没有就取层定义）；状态有、运行时没有的删掉", async () => {
    const bundle = await compile(scene());
    const previous = SceneState.fromBundle(bundle);
    previous.addAnimationLayer(0, -1, { rate: 4, blend: 1, visible: true });
    const next = SceneState.fromBundle(bundle);
    const def = (rate: number) => ({ rate, blend: 1, visible: true });
    next.syncAnimationLayers(
      [
        { object: 0, id: 1, def: def(1) }, // 编译期层 b：已在状态里，不动
        { object: 0, id: -1, def: def(9) }, // 运行时层：取 previous 里的 rate 4
        { object: 0, id: -2, def: def(5) }, // previous 也没有：取层定义
      ],
      previous,
    );
    // 编译期层 a（id 0）运行时已删：状态里的项也删掉
    expect([...next.animationLayers.keys()].sort()).toEqual(["0:-1", "0:-2", "0:1"]);
    expect(next.animationLayers.get("0:-1")!.rate).toBe(4);
    expect(next.animationLayers.get("0:-2")!.rate).toBe(5);
    expect(next.animationLayers.get("0:1")).toEqual({ rate: 1, blend: 0.5, visible: true });
  });

  it("syncAnimationLayers 给了 objects 时只删这些对象的项（没有运行时的静态 puppet 的状态项要留）", async () => {
    const bundle = await compile(scene());
    const state = SceneState.fromBundle(bundle);
    state.animationLayers.set("5:0", { rate: 1, blend: 1, visible: true });
    state.syncAnimationLayers([], null, new Set([0]));
    expect([...state.animationLayers.keys()]).toEqual(["5:0"]);
  });
});
