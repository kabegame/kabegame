/**
 * P4j 步骤 2a 的编译期单测（`.claude/plans/wpe-import/3-scene/phase4/phase-4j-layerimage.md`「点 3」）：发射图候选表的降采样材质。
 * 依据 `rea-p4j-layerimage.md` 2.2：`materials/util/downsample_quarter.json` 的组合键 `WRITEALPHA = 1`，有 `mask` 再加 `OPACITYMASK = 1`。
 * - 有绑定时 bundle 带 `emitterImagePasses.plain`（`WRITEALPHA`）；任何依赖带 `mask` 时另带 `masked`（`WRITEALPHA` + `OPACITYMASK`）；
 * - 子系统的绑定也算；没有绑定（含绑定为 null）时不带这一项；
 * - 原件材质槽 0 写的 `_rt_FullFrameBuffer` 不报不支持项；WPE assets 缺了这份材质照报 `material:missing:…`；
 * - 运行中新建的粒子对象若是场景里第一个用发射图的（片段编译，场景级 pass 已定稿）：照报 `particle:layerimage:runtime`。
 */
import { describe, expect, it, vi } from "vitest";
import { compileScene, openCompileSession, type SceneBundle } from "./bundle";
import { EMITTER_IMAGE_MATERIAL } from "./emitterImages";
import type { SceneReader } from "./fs";
import type { TranslateRequest, TranslateResult, Wpesl2wgsl } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

const ASSETS = "A:/assets";
const PARTICLE = { material: "materials/pm.json", maxcount: 4, emitter: [{ name: "layerimage", rate: 5 }] };
const dep = (extra: Record<string, unknown> = {}) => ({ id: 2, type: "emitterimage", index: 0, mask: "", ...extra });

const FILES: Record<string, unknown> = {
  "P:/p/project.json": { file: "scene.json" },
  "P:/p/models/a.json": { material: "materials/a.json" },
  "P:/p/materials/a.json": { passes: [{ shader: "s", blending: "translucent" }] },
  "P:/p/materials/pm.json": { passes: [{ shader: "genericparticle" }] },
  "P:/p/shaders/s.vert": "void main(){}",
  "P:/p/shaders/s.frag": "void main(){}",
  "P:/p/shaders/genericparticle.vert": "void main(){}",
  "P:/p/shaders/genericparticle.frag": "void main(){}",
  // WPE 原件：槽 0 写 `_rt_FullFrameBuffer`，我们在渲染时换成被依赖图层的合成 RT
  [`${ASSETS}/${EMITTER_IMAGE_MATERIAL}`]: {
    passes: [
      {
        blending: "disabled",
        cullmode: "nocull",
        depthtest: "disabled",
        depthwrite: "disabled",
        shader: "downsample_quarter",
        textures: ["_rt_FullFrameBuffer"],
      },
    ],
  },
  [`${ASSETS}/shaders/downsample_quarter.vert`]: "// downsample_quarter\nvoid main(){}",
  [`${ASSETS}/shaders/downsample_quarter.frag`]: "void main(){}",
};

function reader(files: Record<string, unknown>): SceneReader {
  const bytes = (path: string): Uint8Array => {
    const value = files[path.replace(/\\/g, "/")];
    if (value === undefined) throw new TypeError("Failed to fetch");
    return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
  };
  return {
    readWhole: async (path) => bytes(path),
    readRange: async (path, start, end) => bytes(path).slice(start, end),
  };
}

/** 记下每次编译的请求（COMBO 原样回成 `source: "request"`）。 */
function translator() {
  const requests: TranslateRequest[] = [];
  const fake = {
    async translate(request: TranslateRequest): Promise<TranslateResult> {
      requests.push(request);
      const combos = Object.entries(request.combos ?? {}).map(([name, value]) => ({
        name,
        value: Number(value),
        source: "request" as const,
      }));
      return { ok: true, uniforms: [], textures: [], combos, attributes: [] } as unknown as TranslateResult;
    },
  } as unknown as Wpesl2wgsl;
  return { fake, requests };
}

const image = (id: number) => ({ id, name: `img${id}`, image: "models/a.json", origin: "960 540 0" });
const particleObject = (dependencies: unknown[], particle = "particles/p.json") => ({
  id: 10,
  name: "P",
  particle,
  origin: "960 540 0",
  dependencies,
});

function project(objects: unknown[], particles: Record<string, unknown> = { "particles/p.json": PARTICLE }) {
  const files: Record<string, unknown> = {
    ...FILES,
    "P:/p/scene.json": { general: { orthogonalprojection: { width: 1920, height: 1080 } }, objects },
  };
  for (const [name, json] of Object.entries(particles)) files[`P:/p/${name}`] = json;
  return files;
}

async function compile(files: Record<string, unknown>) {
  const { fake, requests } = translator();
  const bundle: SceneBundle = await compileScene({
    projectDir: "P:/p",
    sceneAssets: [ASSETS],
    reader: reader(files),
    translator: fake,
    postprocess: "disabled",
    exhaustive: true,
  });
  const quarter = requests.filter((request) => request.vertex.includes("downsample_quarter"));
  return { bundle, quarter, keys: [...bundle.unsupported] };
}

describe("compileScene：发射图的降采样材质（P4j 步骤 2a）", () => {
  it("有绑定、没有 mask：只带 plain（WRITEALPHA = 1，槽 0 一个纹理），不报原件的 _rt_FullFrameBuffer", async () => {
    const { bundle, quarter, keys } = await compile(project([image(2), particleObject([dep()])]));
    const passes = bundle.emitterImagePasses!;
    expect(Object.keys(passes)).toEqual(["plain"]);
    expect(passes.plain!.key).toBe("emitterimage/plain");
    expect(passes.plain!.program).not.toBeNull();
    expect(bundle.programs[passes.plain!.program!]).toBeDefined();
    expect(quarter).toHaveLength(1);
    expect(quarter[0].combos).toMatchObject({ WRITEALPHA: 1 });
    expect(quarter[0].combos).not.toHaveProperty("OPACITYMASK");
    expect(keys.filter((key) => key.includes("FullFrameBuffer") || key.includes("downsample_quarter"))).toEqual([]);
  });

  it("有 mask：另带 masked（WRITEALPHA + OPACITYMASK，槽 0 与槽 1）", async () => {
    const files = {
      ...project([image(2), particleObject([dep({ mask: "masks/m" })])]),
      "P:/p/materials/masks/m.json": {},
    };
    const { bundle, quarter } = await compile(files);
    const passes = bundle.emitterImagePasses!;
    expect(Object.keys(passes).sort()).toEqual(["masked", "plain"]);
    expect(passes.masked!.key).toBe("emitterimage/masked");
    expect(quarter.map((request) => request.combos)).toEqual([
      expect.objectContaining({ WRITEALPHA: 1 }),
      expect.objectContaining({ WRITEALPHA: 1, OPACITYMASK: 1 }),
    ]);
    expect(quarter[1].textures?.map((slot) => slot.slot)).toEqual([0, 1]);
  });

  it("子系统的绑定也算；有 mask 的依赖在子系统里同样触发 masked", async () => {
    const files = project([image(2), particleObject([dep({ mask: "masks/m" })])], {
      "particles/p.json": {
        material: "materials/pm.json",
        maxcount: 4,
        emitter: [{ name: "sphererandom" }],
        children: [{ name: "particles/c.json", type: "static" }],
      },
      "particles/c.json": PARTICLE,
    });
    const { bundle } = await compile(files);
    expect(Object.keys(bundle.emitterImagePasses ?? {}).sort()).toEqual(["masked", "plain"]);
  });

  it("没有绑定（没有依赖 / 绑定为 null）：不带这一项，也不编降采样材质", async () => {
    const none = await compile(project([image(2), particleObject([])]));
    expect(none.bundle.emitterImagePasses).toBeUndefined();
    expect(none.quarter).toHaveLength(0);
    const plain = await compile(
      project([image(2), { id: 10, name: "P", particle: "particles/p.json", origin: "0 0 0" }], {
        "particles/p.json": { material: "materials/pm.json", maxcount: 4, emitter: [{ name: "sphererandom" }] },
      }),
    );
    expect(plain.bundle.emitterImagePasses).toBeUndefined();
  });

  it("WPE assets 缺这份材质：照报 material:missing，不带 pass", async () => {
    const files = project([image(2), particleObject([dep()])]);
    delete files[`${ASSETS}/${EMITTER_IMAGE_MATERIAL}`];
    const { bundle, keys } = await compile(files);
    expect(keys).toContain(`material:missing:${EMITTER_IMAGE_MATERIAL}`);
    expect(bundle.emitterImagePasses).toEqual({});
  });
});

describe("片段编译：运行中新建的发射图粒子对象", () => {
  const open = async (objects: unknown[]) => {
    const { fake } = translator();
    const session = await openCompileSession({
      projectDir: "P:/p",
      sceneAssets: [ASSETS],
      reader: reader(project(objects)),
      translator: fake,
      postprocess: "disabled",
      reflection: "disabled",
      exhaustive: true,
    });
    for (let index = 0; index < session.objectCount; index++) await session.compileObject(index);
    await session.finalize();
    return session;
  };
  const request = (object: number) => ({
    object,
    config: JSON.stringify(particleObject([dep()])),
    parent: null,
    bone: null,
    properties: {},
  });

  it("场景里没有发射图（没有场景级 pass）：新对象报 particle:layerimage:runtime", async () => {
    const session = await open([image(2)]);
    const delta = await session.compileFragment(request(session.objectCount));
    expect(delta.fragment.unsupported).toContain("particle:layerimage:runtime");
  });

  it("场景里已有发射图（pass 已编好）：不报", async () => {
    const session = await open([image(2), particleObject([dep()])]);
    const delta = await session.compileFragment({
      ...request(session.objectCount),
      config: JSON.stringify({ ...particleObject([dep()]), id: 11 }),
    });
    expect(delta.fragment.unsupported).not.toContain("particle:layerimage:runtime");
  });
});
