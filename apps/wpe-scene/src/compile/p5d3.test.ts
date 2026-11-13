/**
 * P5d 步骤 3 的编译侧单测（`.claude/plans/wpe-import/3-scene/phase5/phase-5d-camera-depth.md`「步骤 3」点 1、5）：
 * - `isCameraObject`：WPE 的工厂只看 `camera` 是不是字符串（rea-p5-camera 4.1）；
 * - 能力表：相机对象的 `camera`、`fov`、`zoom`、`path`、`queuemode` 不再报，另带内容报 `object:camera:mixed`；
 * - `compileScene`：`SceneLayer.camera`（缺省 50 / 1，取值同 general 的 float）、`fov` / `zoom` 的属性绑定与字段脚本目标
 *   `{ kind: "camera" }`，`path` 文件读出非空 `paths` 或读不到报 `camera:path`。
 */
import { describe, expect, it, vi } from "vitest";
import { cameraValue, planApply, type SceneBinding } from "./bindings";
import { compileScene } from "./bundle";
import { checkCameraObjectPath } from "./camera";
import { checkObjectFeatures, isCameraObject, isMixedCameraObject } from "./features";
import type { SceneReader } from "./fs";
import type { JsonObject, SceneObject } from "./model";
import type { TranslateResult, Wpesl2wgsl } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

describe("isCameraObject：`camera` 是字符串（rea-p5-camera 4.1，工厂 `0x140190654`）", () => {
  it.each([
    [{ camera: "default" }, true],
    [{ camera: "" }, true],
    [{ camera: "x", image: "models/a.json" }, true],
    [{ camera: 1 }, false],
    [{ camera: true }, false],
    [{ camera: null }, false],
    [{ camera: { user: "c", value: "default" } }, false],
    [{}, false],
  ] as [SceneObject, boolean][])("%j → %s", (object, expected) => {
    expect(isCameraObject(object)).toBe(expected);
  });

  it("另带内容（图像、模型、粒子、声音、文本、灯、形状）是 mixed；纯相机、不是相机都不是", () => {
    const camera = { camera: "default" };
    for (const extra of [
      { image: "models/a.json" },
      { model: "models/m.json" },
      { particle: "particles/p.json" },
      { sound: "" },
      { sound: ["s.mp3"] },
      { text: "" },
      { light: "point" },
      { shape: "quad" },
    ])
      expect(isMixedCameraObject({ ...camera, ...extra }), JSON.stringify(extra)).toBe(true);
    expect(isMixedCameraObject(camera)).toBe(false);
    // `active()` 认不出的空内容不算（同分组节点）
    expect(isMixedCameraObject({ ...camera, image: "", light: null, sound: null, text: null })).toBe(false);
    expect(isMixedCameraObject({ image: "models/a.json" })).toBe(false);
  });
});

describe("checkObjectFeatures：相机对象的键（P5d 步骤 3 点 1）", () => {
  const check = (object: SceneObject) => {
    const unsupported = new Set<string>();
    checkObjectFeatures(object, unsupported);
    return [...unsupported].sort();
  };

  it("camera、fov、zoom、path、queuemode 不再报；绑属性、挂脚本也不报（关键帧由 collectAnimations 报）", () => {
    expect(
      check({
        id: 1,
        camera: "default",
        fov: 40,
        zoom: { user: "z", value: 1 },
        path: "models/camera.json",
        queuemode: "sequential",
        origin: "960 540 500",
        angles: "0 0 0.3",
        visible: true,
      }),
    ).toEqual([]);
    expect(check({ camera: "default", fov: { script: "export function update(v) { return v; }", value: 50 } })).toEqual(
      [],
    );
  });

  it("不是相机的对象上这几个键照未知键报", () => {
    expect(check({ fov: 40, zoom: 2, path: "p.json", queuemode: "random" })).toEqual([
      "object:fov",
      "object:path",
      "object:queuemode",
      "object:zoom",
    ]);
    expect(check({ camera: 1 })).toEqual(["object:camera"]);
  });

  it("同时带别的内容报 object:camera:mixed，相机自己的键仍不报", () => {
    expect(check({ camera: "default", image: "models/a.json", fov: 40 })).toEqual(["object:camera:mixed"]);
    expect(check({ camera: "default", shape: "quad" })).toEqual(["object:camera:mixed"]);
    expect(check({ camera: "default", sound: "" })).toEqual(["object:camera:mixed"]);
  });
});

describe("cameraValue：同 general 的 float（`generalValue`）", () => {
  it("一个有限数字（字符串也解析）；布尔、多分量、解析不出返回 undefined", () => {
    expect(cameraValue(40)).toBe(40);
    expect(cameraValue("2.5")).toBe(2.5);
    expect(cameraValue(true)).toBeUndefined();
    expect(cameraValue("1 2")).toBeUndefined();
    expect(cameraValue("x")).toBeUndefined();
    expect(cameraValue(null)).toBeUndefined();
    expect(cameraValue(undefined)).toBeUndefined();
  });
});

describe("checkCameraObjectPath：条目动画没做（rea-p5-camera 4.4）", () => {
  const files: Record<string, string> = {
    "empty.json": '{"paths": []}',
    "full.json": '{"paths": [{"eye": "1 2 3"}]}',
    "bad.json": "{",
    "nopaths.json": "{}",
    "notarray.json": '{"paths": {}}',
    "array.json": "[]",
    "comment.json": '{"paths": []} // 注释',
  };
  const fs = { text: async (path: string) => files[path] ?? null };
  const check = async (path: unknown) => {
    const unsupported = new Set<string>();
    await checkCameraObjectPath(path, fs, unsupported);
    return [...unsupported];
  };

  it("空 paths、没有 paths、paths 不是数组、带注释的空表：不报", async () => {
    for (const path of ["empty.json", "nopaths.json", "notarray.json", "comment.json"])
      expect(await check(path), path).toEqual([]);
  });

  it("非空 paths、读不到、不是 JSON、根不是对象、空串、不是字符串：报 camera:path", async () => {
    for (const path of ["full.json", "none.json", "bad.json", "array.json", "", 5, { user: "p", value: "x" }])
      expect(await check(path), JSON.stringify(path)).toEqual(["camera:path"]);
  });

  it("缺键不读", async () => {
    expect(await check(undefined)).toEqual([]);
    expect(await check(null)).toEqual([]);
  });
});

// ———— compileScene ————

function memoryReader(files: Record<string, unknown>, reads: string[] = []): SceneReader {
  const reader: SceneReader = {
    async readWhole(path) {
      const key = path.replace(/\\/g, "/");
      reads.push(key);
      const value = files[key];
      if (value === undefined) throw new TypeError("Failed to fetch");
      return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
    },
    async readRange(path, start, end) {
      return (await reader.readWhole(path)).slice(start, end);
    },
  };
  return reader;
}

const translator = {
  async translate(): Promise<TranslateResult> {
    return { ok: true };
  },
} as unknown as Wpesl2wgsl;

const ORTHO = { orthogonalprojection: { width: 1920, height: 1080 } };
const EMPTY_PATH = "models/camera.json";

async function compile(
  objects: JsonObject[],
  options: { extra?: Record<string, unknown>; properties?: Record<string, unknown>; general?: JsonObject } = {},
) {
  const reads: string[] = [];
  const bundle = await compileScene({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    reader: memoryReader(
      {
        "P:/p/project.json": {
          file: "scene.json",
          general: { properties: options.properties ?? {} },
        },
        "P:/p/scene.json": { general: options.general ?? ORTHO, objects },
        "P:/p/models/a.json": { material: "materials/a.json" },
        "P:/p/materials/a.json": { passes: [{ shader: "s" }] },
        "P:/p/shaders/s.vert": "void main(){}",
        "P:/p/shaders/s.frag": "void main(){}",
        [`P:/p/${EMPTY_PATH}`]: { paths: [] },
        ...options.extra,
      },
      reads,
    ),
    translator,
    postprocess: "disabled",
    exhaustive: true,
  });
  return { bundle, reads };
}

/** 模板场景的相机对象（rea-p5-camera 4.3、`p5d-camo-*`）：`camera: "default"`、空条目表。 */
const cameraObject = (extra: JsonObject = {}): JsonObject => ({
  id: 9,
  name: "Camera",
  camera: "default",
  path: EMPTY_PATH,
  queuemode: "random",
  origin: "960 540 500",
  ...extra,
});

describe("compileScene：相机对象（P5d 步骤 3 点 1）", () => {
  it("作为没有 pass 的图层进 layers，fov / zoom 缺省 50 / 1；别的图层 camera 为 null；不报键", async () => {
    const { bundle, reads } = await compile([{ id: 1, image: "models/a.json" }, cameraObject()]);
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.layers.map((layer) => layer.camera)).toEqual([null, { fov: 50, zoom: 1 }]);
    const layer = bundle.layers[1];
    expect(layer.object).toBe(1);
    expect(layer.passes).toEqual([]);
    expect(layer.origin).toEqual([960, 540, 500]);
    // `path` 文件按项目查找读、计进请求
    expect(reads).toContain(`P:/p/${EMPTY_PATH}`);
  });

  it("fov / zoom 的常量取值同 general 的 float：数字、数字串；不合法的取缺省", async () => {
    const { bundle } = await compile([
      cameraObject({ fov: 40, zoom: "2" }),
      cameraObject({ fov: true, zoom: "1 2" }),
      cameraObject({ fov: "x", zoom: null }),
    ]);
    expect(bundle.layers.map((layer) => layer.camera)).toEqual([
      { fov: 40, zoom: 2 },
      { fov: 50, zoom: 1 },
      { fov: 50, zoom: 1 },
    ]);
    expect(bundle.unsupported).toEqual([]);
  });

  it("绑用户属性：取当前值并登记就地目标 { kind: camera }；带 condition 的按条件换成布尔（float 不收，取缺省）", async () => {
    const { bundle } = await compile(
      [
        cameraObject({ fov: { user: "f", value: 30 }, zoom: { user: { name: "z", condition: "big" }, value: 1 } }),
        cameraObject({ visible: { user: "v", value: true } }),
      ],
      { properties: { f: { value: 35 }, z: { value: "big" }, v: { value: false } } },
    );
    expect(bundle.layers[0].camera).toEqual({ fov: 35, zoom: 1 });
    expect(bundle.layers[1].visible).toBe(false);
    expect(bundle.layers[1].visibleBound).toBe(true);
    const camera = bundle.bindings.filter((binding) => binding.target.kind === "camera");
    expect(camera).toEqual([
      { property: "f", target: { kind: "camera", object: 0, field: "fov" } },
      { property: "z", condition: "big", target: { kind: "camera", object: 0, field: "zoom" } },
    ]);
    // 改值走就地写，不重编译
    const plan = planApply(bundle.bindings, new Map([["f", 60]]));
    expect(plan.recompile).toEqual([]);
    expect(plan.writes.map((write) => write.binding.target)).toEqual([{ kind: "camera", object: 0, field: "fov" }]);
  });

  it("fov / zoom 挂 {script}：字段脚本写回到 { kind: camera }、按 float 收发；初值进图层", async () => {
    const script = "export function update(value) { return value; }";
    const { bundle } = await compile([
      cameraObject({ fov: { script, value: 45 }, zoom: { script, value: 2 }, origin: { script, value: "1 2 3" } }),
    ]);
    expect(bundle.layers[0].camera).toEqual({ fov: 45, zoom: 2 });
    const targets = Object.fromEntries(
      bundle.scripts.list.map((item) => [item.id, { target: item.target, valueType: item.valueType }]),
    );
    expect(targets).toEqual({
      "objects/0/fov": { target: { kind: "camera", object: 0, field: "fov" }, valueType: "float" },
      "objects/0/zoom": { target: { kind: "camera", object: 0, field: "zoom" }, valueType: "float" },
      "objects/0/origin": { target: { kind: "layer", object: 0, field: "origin" }, valueType: "vec3" },
    });
    expect(bundle.unsupported).toEqual([]);
  });

  it("不是相机的对象上 fov / zoom 的字段脚本没有目标；mixed 的同样没有，也不进图层", async () => {
    const script = "export function update(value) { return value; }";
    const { bundle } = await compile([
      { id: 1, fov: { script, value: 45 } },
      cameraObject({ image: "models/a.json", zoom: { script, value: 2 } }),
    ]);
    expect(bundle.scripts.list.map((item) => item.target)).toEqual([
      { kind: "unsupported", path: "objects/0/fov" },
      { kind: "unsupported", path: "objects/1/zoom" },
    ]);
    expect(bundle.layers.map((layer) => layer.camera)).toEqual([null, null]);
    // mixed 的按内容编（图像层有 pass）
    expect(bundle.layers[1].passes).toHaveLength(1);
    expect(bundle.unsupported).toEqual(expect.arrayContaining(["object:camera:mixed", "object:fov"]));
  });

  it("path：非空 paths、读不到、不是 JSON 报 camera:path；缺键不读不报", async () => {
    const full = { "P:/p/models/full.json": { paths: [{ eye: "1 2 3" }] }, "P:/p/models/bad.json": "{" };
    for (const path of ["models/full.json", "models/none.json", "models/bad.json"]) {
      const { bundle } = await compile([cameraObject({ path })], { extra: full });
      expect(bundle.unsupported, path).toEqual(["camera:path"]);
    }
    const { bundle, reads } = await compile([cameraObject({ path: undefined })]);
    expect(bundle.unsupported).toEqual([]);
    expect(reads.some((read) => read.includes("camera"))).toBe(false);
    expect(bundle.layers[0].camera).toEqual({ fov: 50, zoom: 1 });
  });

  it("透视场景同样（`p5d-camp-*`）：相机对象进 layers、fov 进图层", async () => {
    const { bundle } = await compile([cameraObject({ fov: 40, origin: "0 0 8" }), cameraObject({ fov: 60 })], {
      general: {},
    });
    expect(bundle.general.perspective).toBe(true);
    expect(bundle.layers.map((layer) => layer.camera)).toEqual([
      { fov: 40, zoom: 1 },
      { fov: 60, zoom: 1 },
    ]);
    expect(bundle.unsupported).toEqual([]);
  });
});

describe("planApply：相机目标进就地写（不进 script-property 那一侧）", () => {
  it("camera 目标的变化进 writes", () => {
    const bindings: SceneBinding[] = [{ property: "z", target: { kind: "camera", object: 3, field: "zoom" } }];
    const plan = planApply(bindings, new Map([["z", 2]]));
    expect(plan).toEqual({ writes: [{ binding: bindings[0], value: 2 }], recompile: [] });
  });
});
