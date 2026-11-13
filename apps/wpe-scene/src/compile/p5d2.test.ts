/**
 * P5d 步骤 2 的编译侧单测（`.claude/plans/wpe-import/3-scene/phase5/phase-5d-camera-depth.md`「步骤 2」点 1、2、7、9）：
 * - `compile/camera.ts`：基准相机与路径文件的容错（rea-p5-camera 3.1）；
 * - `compileScene`：投影类型一处判定（`SceneGeneral.perspective`），透视场景的 W、H 是 0、`fullscreenSize` 记 `"scene"`、
 *   `SCENE_ORTHO` 跟着它；
 * - 能力表：不再报 `camera:perspective` 与透视的 `general:camerashake`，透视场景里没测过的用法报 `camera:perspective:<用法>`，
 *   正交场景的路径报 `camera:paths:orthographic`，读不到的路径文件报 `camera:paths:unreadable`。
 */
import { describe, expect, it, vi } from "vitest";
import { compileScene } from "./bundle";
import { cameraVector, compileCamera, DEFAULT_CAMERA, parseCameraPaths, type CameraPath } from "./camera";
import { checkSceneFeatures, perspectiveObjectIssues } from "./features";
import type { SceneReader } from "./fs";
import type { JsonObject, SceneJson, SceneObject } from "./model";
import type { TranslateRequest, TranslateResult, Wpesl2wgsl } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

const f32 = Math.fround;

describe("cameraVector：字符串 atof 三次（rea-p5-camera 3.1、L2）", () => {
  it("空格分隔、缺分量为 0、解析不出的分量为 0；不是字符串返回 null", () => {
    expect(cameraVector("1 2 3")).toEqual([1, 2, 3]);
    expect(cameraVector("  6   4 10 ")).toEqual([6, 4, 10]);
    expect(cameraVector("1 2")).toEqual([1, 2, 0]);
    expect(cameraVector("")).toEqual([0, 0, 0]);
    expect(cameraVector("x 2abc 0.1")).toEqual([0, 2, f32(0.1)]);
    expect(cameraVector("1 2 3 4")).toEqual([1, 2, 3]);
    expect(cameraVector(5)).toBeNull();
    expect(cameraVector(null)).toBeNull();
    expect(cameraVector(["1", "2", "3"])).toBeNull();
  });
});

describe("parseCameraPaths：路径文件的容错（rea-p5-camera 3.1【确】）", () => {
  const key = (t: number, x: number, extra: JsonObject = {}) => ({
    eye: `${x} 0 10`,
    center: `${x} 0 0`,
    up: "0 1 0",
    timestamp: t,
    ...extra,
  });
  const parse = (json: unknown): CameraPath[] => {
    const out: CameraPath[] = [];
    parseCameraPaths(json, out);
    return out;
  };

  it("`p5d-path` 的 KBCAM（`ignore/p5/d0/gen_d.py`）：两条路径按文件顺序", () => {
    const paths = parse({
      paths: [
        { duration: 4, name: "", transforms: [key(0, 0), key(2, 2), key(4, 6)] },
        { duration: 2, name: "", transforms: [{ eye: "0 3 10", center: "0 3 0", up: "0 1 0", timestamp: 0 }] },
      ],
    });
    expect(paths).toEqual([
      {
        duration: 4,
        keys: [
          { t: 0, eye: [0, 0, 10], center: [0, 0, 0], up: [0, 1, 0], zoom: 1 },
          { t: 2, eye: [2, 0, 10], center: [2, 0, 0], up: [0, 1, 0], zoom: 1 },
          { t: 4, eye: [6, 0, 10], center: [6, 0, 0], up: [0, 1, 0], zoom: 1 },
        ],
      },
      { duration: 2, keys: [{ t: 0, eye: [0, 3, 10], center: [0, 3, 0], up: [0, 1, 0], zoom: 1 }] },
    ]);
  });

  it("根不是对象、没有 paths 数组：什么都不加", () => {
    expect(parse(null)).toEqual([]);
    expect(parse([])).toEqual([]);
    expect(parse({})).toEqual([]);
    expect(parse({ paths: {} })).toEqual([]);
  });

  it("路径不是对象、transforms 不是非空数组：break，同一文件后面的路径都不读", () => {
    const good = { duration: 1, transforms: [key(0, 1)] };
    expect(parse({ paths: [good, "x", good] })).toHaveLength(1);
    expect(parse({ paths: [good, { duration: 1, transforms: [] }, good] })).toHaveLength(1);
    expect(parse({ paths: [good, { duration: 1 }, good] })).toHaveLength(1);
    expect(parse({ paths: [{ duration: 1, transforms: {} }, good] })).toHaveLength(0);
  });

  it("disabled: true 的路径跳过（不 break），只认 JSON true", () => {
    const paths = parse({
      paths: [
        { duration: 1, disabled: true, transforms: [key(0, 1)] },
        { duration: 2, disabled: 1, transforms: [key(0, 2)] },
        { duration: 3, transforms: [key(0, 3)] },
      ],
    });
    expect(paths.map((path) => path.duration)).toEqual([2, 3]);
  });

  it("关键帧不是对象、disabled: true 的跳过", () => {
    const [path] = parse({
      paths: [{ duration: 4, transforms: [key(0, 1), 5, key(2, 2, { disabled: true }), key(4, 3)] }],
    });
    expect(path.keys.map((k) => k.eye[0])).toEqual([1, 3]);
  });

  it("缺 timestamp：第 i 项（transforms 里的下标）取 i/(n − 1)·duration，第 0 项是 0；只有一项时也是 0", () => {
    const [path] = parse({
      paths: [{ duration: 6, transforms: [{ eye: "0 0 1" }, { eye: "1 0 1" }, { eye: "2 0 1", timestamp: 5 }, {}] }],
    });
    expect(path.keys.map((k) => k.t)).toEqual([0, 2, 5, 6]);
    const [single] = parse({ paths: [{ duration: 6, transforms: [{ eye: "0 0 1" }] }] });
    expect(single.keys[0].t).toBe(0);
    // 字符串的 timestamp 不是数字：照下标铺开
    const [text] = parse({ paths: [{ duration: 3, transforms: [{}, { timestamp: "7" }] }] });
    expect(text.keys.map((k) => k.t)).toEqual([0, 3]);
  });

  it("缺向量是 (0, 0, 0)（up 也是）；缺 zoom 是 1、写了读数字；缺 duration 是 0", () => {
    const [path] = parse({ paths: [{ transforms: [{ timestamp: 0 }, { timestamp: 1, zoom: 2.5, eye: 3 }] }] });
    expect(path.duration).toBe(0);
    expect(path.keys).toEqual([
      { t: 0, eye: [0, 0, 0], center: [0, 0, 0], up: [0, 0, 0], zoom: 1 },
      { t: 1, eye: [0, 0, 0], center: [0, 0, 0], up: [0, 0, 0], zoom: 2.5 },
    ]);
  });

  it("数值存 float32", () => {
    const [path] = parse({
      paths: [{ duration: 0.1, transforms: [{ timestamp: 0.3, eye: "0.1 0.2 0.3", zoom: 0.7 }] }],
    });
    expect(path.duration).toBe(f32(0.1));
    expect(path.keys[0]).toMatchObject({ t: f32(0.3), eye: [f32(0.1), f32(0.2), f32(0.3)], zoom: f32(0.7) });
  });
});

describe("compileCamera：基准与路径文件", () => {
  const fs = (files: Record<string, string>) => ({
    async text(path: string) {
      return files[path] ?? null;
    },
  });

  it("基准：字符串照 atof，不是字符串或缺键时保留构造值 (2, 2, 2) / (0, 0, 0) / (0, 1, 0)", async () => {
    const issues = new Set<string>();
    expect(await compileCamera({}, fs({}), issues)).toEqual({ ...DEFAULT_CAMERA, paths: [] });
    expect(await compileCamera({ camera: { eye: "6 4 10", center: 1, up: "0 0 1" } }, fs({}), issues)).toEqual({
      eye: [6, 4, 10],
      center: [0, 0, 0],
      up: [0, 0, 1],
      paths: [],
    });
    expect(issues.size).toBe(0);
  });

  it("paths 按顺序读多个文件、追加；不是字符串的项跳过", async () => {
    const one = JSON.stringify({ paths: [{ duration: 1, transforms: [{ eye: "1 0 0", timestamp: 0 }] }] });
    const two = JSON.stringify({ paths: [{ duration: 2, transforms: [{ eye: "2 0 0", timestamp: 0 }] }] });
    const issues = new Set<string>();
    const camera = await compileCamera(
      { camera: { paths: ["b.json", 3, "a.json"] } },
      fs({ "a.json": one, "b.json": two }),
      issues,
    );
    expect(camera.paths.map((path) => path.duration)).toEqual([2, 1]);
    expect(issues.size).toBe(0);
  });

  it("读不到或不是 JSON 报 camera:paths:unreadable，别的文件照读；带注释的 JSON 照 WPE 宽松读", async () => {
    const good = '{ "paths": [ { "duration": 1, "transforms": [ { "timestamp": 0 } ] } ] } // 注释';
    const issues = new Set<string>();
    const camera = await compileCamera(
      { camera: { paths: ["none.json", "bad.json", "good.json"] } },
      fs({ "bad.json": "{", "good.json": good }),
      issues,
    );
    expect([...issues]).toEqual(["camera:paths:unreadable"]);
    expect(camera.paths).toHaveLength(1);
  });

  it("第 0 条路径没有关键帧：WPE 不走路径（只看第 0 条），整张表清空；别的没有关键帧的路径去掉", async () => {
    const empty = { duration: 1, transforms: [5] };
    const full = { duration: 2, transforms: [{ timestamp: 0 }] };
    const first = await compileCamera(
      { camera: { paths: ["p.json"] } },
      fs({ "p.json": JSON.stringify({ paths: [empty, full] }) }),
      new Set(),
    );
    expect(first.paths).toEqual([]);
    const later = await compileCamera(
      { camera: { paths: ["p.json"] } },
      fs({ "p.json": JSON.stringify({ paths: [full, empty, full] }) }),
      new Set(),
    );
    expect(later.paths.map((path) => path.keys.length)).toEqual([1, 1]);
  });
});

// ———— compileScene ————

function memoryReader(files: Record<string, unknown>): SceneReader {
  const reader: SceneReader = {
    async readWhole(path) {
      const value = files[path.replace(/\\/g, "/")];
      if (value === undefined) throw new TypeError("Failed to fetch");
      return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
    },
    async readRange(path, start, end) {
      return (await reader.readWhole(path)).slice(start, end);
    },
  };
  return reader;
}

/** 记下每次翻译请求的假翻译器。 */
function fakeTranslator() {
  const requests: TranslateRequest[] = [];
  const translator = {
    async translate(request: TranslateRequest): Promise<TranslateResult> {
      requests.push(request);
      return { ok: true };
    },
  } as unknown as Wpesl2wgsl;
  return { translator, requests };
}

const ORTHO = { orthogonalprojection: { width: 1920, height: 1080 } };
const COMPOSE_MATERIAL = { passes: [{ shader: "s", textures: ["_rt_FullFrameBuffer"] }] };

async function compile(scene: JsonObject, extra: Record<string, unknown> = {}) {
  const { translator, requests } = fakeTranslator();
  const bundle = await compileScene({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    reader: memoryReader({
      "P:/p/project.json": { file: "scene.json" },
      "P:/p/scene.json": { objects: [], ...scene },
      "P:/p/models/a.json": { material: "materials/a.json" },
      "P:/p/materials/a.json": { passes: [{ shader: "s" }] },
      "P:/p/models/compose.json": { material: "materials/compose.json", passthrough: true },
      "P:/p/models/project.json": {
        material: "materials/compose.json",
        passthrough: true,
        autosize: true,
        projectlayer: true,
      },
      "P:/p/models/full.json": { material: "materials/compose.json", passthrough: true, fullscreen: true },
      "P:/p/materials/compose.json": COMPOSE_MATERIAL,
      "P:/p/particles/p.json": { material: "materials/pm.json", maxcount: 4, emitter: [{ name: "sphererandom" }] },
      "P:/p/particles/persp.json": {
        material: "materials/pm.json",
        maxcount: 4,
        flags: 4,
        emitter: [{ name: "sphererandom" }],
      },
      "P:/p/particles/tree.json": {
        material: "materials/pm.json",
        maxcount: 4,
        emitter: [{ name: "sphererandom" }],
        children: [{ name: "particles/persp.json", type: "static" }],
      },
      "P:/p/materials/pm.json": { passes: [{ shader: "genericparticle", blending: "additive" }] },
      "P:/p/shaders/s.vert": "void main(){}",
      "P:/p/shaders/s.frag": "void main(){}",
      "P:/p/shaders/genericparticle.vert": "void main(){}",
      "P:/p/shaders/genericparticle.frag": "void main(){}",
      ...extra,
    }),
    translator,
    postprocess: "disabled",
    exhaustive: true,
  });
  return { bundle, requests };
}

describe("compileScene：投影类型一处判定（P5d 步骤 2 点 1）", () => {
  it.each([
    ["正交 1920×1080", ORTHO, false, [1920, 1080]],
    ["auto: true（没写宽高，占位 1920×1080 不变）", { orthogonalprojection: { auto: true } }, false, [1920, 1080]],
    ["auto: true 带宽高", { orthogonalprojection: { auto: true, width: 800, height: 600 } }, false, [800, 600]],
    ["width: 0（不是正交）", { orthogonalprojection: { width: 0, height: 1080 } }, true, [0, 0]],
    ["null", { orthogonalprojection: null }, true, [0, 0]],
    ["缺键", {}, true, [0, 0]],
    ["general 缺省", undefined, true, [0, 0]],
  ] as const)("%s", async (_, general, perspective, size) => {
    const { bundle, requests } = await compile({
      ...(general ? { general } : {}),
      objects: [{ id: 1, image: "models/a.json" }],
    });
    expect(bundle.general.perspective).toBe(perspective);
    expect([bundle.general.width, bundle.general.height]).toEqual(size);
    expect(bundle.general.camera === null).toBe(!perspective);
    // `SCENE_ORTHO` 跟着同一个判定（以前按 `orthogonalprojection` 真假）
    expect(requests.map((request) => request.defines?.SCENE_ORTHO)).toEqual([perspective ? undefined : "1"]);
    // 不再整张退回
    expect(bundle.unsupported).toEqual([]);
  });

  it("透视场景的基准相机进 SceneGeneral.camera；正交场景不解析（null）", async () => {
    const camera = { eye: "6 4 10", center: "0 0 0", up: "0 1 0", paths: ["scripts/c.json"] };
    const file = { paths: [{ duration: 2, transforms: [{ eye: "1 2 3", timestamp: 0 }] }] };
    const { bundle } = await compile({ camera }, { "P:/p/scripts/c.json": file });
    expect(bundle.general.camera).toEqual({
      eye: [6, 4, 10],
      center: [0, 0, 0],
      up: [0, 1, 0],
      paths: [{ duration: 2, keys: [{ t: 0, eye: [1, 2, 3], center: [0, 0, 0], up: [0, 0, 0], zoom: 1 }] }],
    });
    const ortho = await compile({ general: ORTHO, camera }, { "P:/p/scripts/c.json": file });
    expect(ortho.bundle.general.camera).toBeNull();
    expect(ortho.bundle.unsupported).toEqual(["camera:paths:orthographic"]);
  });

  it("透视粒子的缺省值按透视（粒子读同一个判定）", async () => {
    const { bundle } = await compile({ objects: [{ id: 1, particle: "particles/p.json" }] });
    expect(bundle.layers[0].particle!.orthographic).toBe(false);
    const ortho = await compile({ general: ORTHO, objects: [{ id: 1, particle: "particles/p.json" }] });
    expect(ortho.bundle.layers[0].particle!.orthographic).toBe(true);
  });

  it('fullscreenlayer：两种投影的 fullscreenSize 都记 "scene"，渲染时取场景目标尺寸', async () => {
    for (const general of [ORTHO, {}]) {
      const { bundle } = await compile({ general, objects: [{ id: 1, image: "models/full.json" }] });
      expect(bundle.layers[0]).toMatchObject({ fullscreen: true, size: [2, 2], fullscreenSize: "scene" });
    }
  });
});

describe("能力表：透视相机（P5d 步骤 2 点 7）", () => {
  const keys = (scene: Partial<SceneJson>) => {
    const out = new Set<string>();
    checkSceneFeatures({ objects: [], ...scene } as SceneJson, out);
    return [...out].sort();
  };

  it("透视场景不报 camera:perspective；透视开抖动、写 fov / nearz / farz / zoom 都不报", () => {
    expect(keys({})).toEqual([]);
    expect(
      keys({
        general: {
          camerashake: true,
          camerashakeamplitude: 2,
          fov: 30,
          nearz: 1,
          farz: 100,
          zoom: 0,
          cameraparallax: true,
        },
      }),
    ).toEqual([]);
    // 正交的 zoom ≤ 0 照报
    expect(keys({ general: { ...ORTHO, zoom: 0 } })).toEqual(["general:zoom"]);
  });

  it("正交场景的 camera.paths 非空报 camera:paths:orthographic；空数组、透视场景不报", () => {
    expect(keys({ general: ORTHO, camera: { paths: ["a.json"] } })).toEqual(["camera:paths:orthographic"]);
    expect(keys({ general: { orthogonalprojection: { auto: true } }, camera: { paths: ["a.json"] } })).toEqual([
      "camera:paths:orthographic",
    ]);
    expect(keys({ general: ORTHO, camera: { paths: [] } })).toEqual([]);
    expect(keys({ camera: { paths: ["a.json"] } })).toEqual([]);
  });

  it("perspectiveObjectIssues：文本、形状、图像层 / 模型 perspective: true", () => {
    const issues = (object: Partial<SceneObject>) => perspectiveObjectIssues(object as SceneObject);
    expect(issues({ text: "hi" })).toEqual(["camera:perspective:text"]);
    expect(issues({ text: "" })).toEqual(["camera:perspective:text"]);
    expect(issues({ shape: "quad" })).toEqual(["camera:perspective:shape"]);
    expect(issues({ image: "models/a.json", perspective: true })).toEqual(["camera:perspective:image"]);
    expect(issues({ model: "models/m.mdl", perspective: true })).toEqual(["camera:perspective:image"]);
    // 只认 JSON true；非图像对象上的由 `object:perspective` 报
    expect(issues({ image: "models/a.json", perspective: 1 })).toEqual([]);
    expect(issues({ particle: "particles/p.json", perspective: true })).toEqual([]);
    expect(issues({ image: "models/a.json" })).toEqual([]);
  });

  it("这些键只在透视场景报（checkSceneFeatures）", () => {
    const objects = [
      { id: 1, text: "hi" },
      { id: 2, shape: "quad" },
      { id: 3, image: "models/a.json", perspective: true },
    ] as SceneObject[];
    const perspective = keys({ objects });
    expect(perspective).toEqual(
      expect.arrayContaining(["camera:perspective:text", "camera:perspective:shape", "camera:perspective:image"]),
    );
    expect(keys({ general: ORTHO, objects }).filter((key) => key.startsWith("camera:"))).toEqual([]);
  });

  it("要编完才知道的三个：projectlayer（autosize + projectlayer）、组、透视粒子（含子系统）", async () => {
    const issues = async (objects: JsonObject[], general: JsonObject = {}) =>
      (await compile({ general, objects })).bundle.unsupported.filter((key) => key.startsWith("camera:"));
    expect(await issues([{ id: 1, image: "models/project.json" }])).toEqual(["camera:perspective:projectlayer"]);
    expect(await issues([{ id: 1, image: "models/compose.json" }])).toEqual([]);
    expect(
      await issues([
        { id: 1, image: "models/compose.json" },
        { id: 2, image: "models/a.json", parent: 1 },
      ]),
    ).toEqual(["camera:perspective:group"]);
    expect(await issues([{ id: 1, particle: "particles/persp.json" }])).toEqual(["camera:perspective:particle"]);
    expect(await issues([{ id: 1, particle: "particles/tree.json" }])).toEqual(["camera:perspective:particle"]);
    expect(await issues([{ id: 1, particle: "particles/p.json" }])).toEqual([]);
    // 正交场景都不报
    for (const objects of [
      [{ id: 1, image: "models/project.json" }],
      [
        { id: 1, image: "models/compose.json" },
        { id: 2, image: "models/a.json", parent: 1 },
      ],
      [{ id: 1, particle: "particles/persp.json" }],
    ])
      expect(await issues(objects, ORTHO)).toEqual([]);
  });

  it("透视场景读不到路径文件报 camera:paths:unreadable", async () => {
    const { bundle } = await compile({ camera: { paths: ["scripts/none.json"] } });
    expect(bundle.unsupported).toEqual(["camera:paths:unreadable"]);
    expect(bundle.general.camera?.paths).toEqual([]);
  });
});
