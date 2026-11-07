import { describe, expect, it, vi } from "vitest";
import { compileScene, type SceneBundle } from "../compile/bundle";
import type { SceneReader } from "../compile/fs";
import type { SceneObject } from "../compile/model";
import type { TranslateResult } from "../wpesl2wgsl";
import { planLayer } from "./graph";
import {
  effectiveVisible,
  eyePosition,
  layerLocalMatrix,
  layerQuad,
  sceneTargetSize,
  sceneViewProjection,
  worldMatrixOf,
  type LayerTransform,
} from "./layout";
import { multiply, rotationZ, scaling, transformPoint, translation, type Mat4 } from "./math";
import { buildableLayers, checkRenderable, visibleObjects } from "./scene";
import { SceneState } from "./state";
import { drawUniformValues, UniformBlock, type UniformEntry } from "./uniforms";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

const ORTHO = { orthogonalprojection: { width: 1920, height: 1080 } };

function memory(files: Record<string, unknown>): SceneReader {
  const reader: SceneReader = {
    async readWhole(path) {
      const value = files[path.replace(/\\/g, "/")];
      if (value === undefined) throw new TypeError("Failed to fetch");
      return new TextEncoder().encode(JSON.stringify(value));
    },
    async readRange(path, start, end) {
      return (await reader.readWhole(path)).slice(start, end);
    },
  };
  return reader;
}

/** 内存里的最小场景：每个 image 是 40×60 的四边形；没有翻译器，程序为空，几何与 uniform 组装照常。 */
function compile(objects: SceneObject[], userProperties: Record<string, unknown> = {}, properties = {}) {
  return compileScene({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    reader: memory({
      "P:/p/project.json": { file: "scene.json", general: { properties } },
      "P:/p/scene.json": { general: ORTHO, objects },
      "P:/p/models/a.json": { material: "materials/a.json", width: 40, height: 60 },
      "P:/p/materials/a.json": { passes: [{ shader: "simple" }] },
    }),
    translator: null,
    postprocess: "disabled",
    exhaustive: true,
    userProperties,
  });
}

const image = (extra: SceneObject): SceneObject => ({ image: "models/a.json", size: "40 60", ...extra });

/**
 * `proj/p4a` 的对象（顺序即 objects 顺序）。`g5` 写死不可见，`h6` 必须不画；`h7` 的父不存在，当根节点。
 * `overrides` 按名字改字段（绑定用户属性的变体用）。
 */
function p4aObjects(overrides: Record<string, Partial<SceneObject>> = {}): SceneObject[] {
  const objects: SceneObject[] = [
    image({ id: 33, name: "h3", origin: "10 0 0", parent: 34 }),
    image({ id: 34, name: "h4", origin: "1200 800 0", angles: "0 0 0.7", scale: "2 3 1", alpha: 0.25 }),
    { id: 30, name: "g0", origin: "400 300 0", angles: "0 0 0.5", scale: "2 1 1" },
    image({ id: 31, name: "h1", origin: "50 20 0", parent: 30, angles: "0 0 0.3", alpha: 0.5 }),
    image({ id: 32, name: "h2", origin: "30 0 0", parent: 31, angles: "0.2 0.3 0.4", scale: "1 2 1" }),
    { id: 35, name: "g5", origin: "800 300 0", visible: false },
    image({ id: 36, name: "h6", origin: "0 0 0", parent: 35 }),
    image({ id: 37, name: "h7", origin: "900 200 0", parent: 9999 }),
  ];
  return objects.map((object) => ({ ...object, ...overrides[object.name ?? ""] }));
}

/** WPE 实测四角（场景坐标，y 向上，`A:\p4a\`，`ana_a.py`）。 */
const WPE_CORNERS: Record<string, [number, number][]> = {
  h3: [
    [1126.7237, 855.9514],
    [1242.6829, 718.2798],
    [1187.9111, 907.4888],
    [1303.8702, 769.8172],
  ],
  h4: [
    [1111.4268, 843.0671],
    [1227.386, 705.3955],
    [1172.6142, 894.6045],
    [1288.5734, 756.9329],
  ],
  h1: [
    [418.1669, 358.6376],
    [476.7689, 325.336],
    [479.5706, 405.6524],
    [538.1726, 372.3508],
  ],
  h2: [
    [420.0626, 383.662],
    [588.8862, 368.2197],
    [459.5588, 433.2908],
    [628.3825, 417.8485],
  ],
  h7: [
    [880, 230],
    [880, 170],
    [920, 230],
    [920, 170],
  ],
};

/** 一个只有变换与颜色组的程序：给内存场景的每个 pass 用，算 uniform 字节。 */
const PROGRAM = {
  ok: true,
  uniforms: [
    { name: "g_ModelViewProjectionMatrix", type: "mat4x4<f32>", declared: "mat4", offset: 0, size: 64 },
    { name: "g_ModelMatrix", type: "mat4x4<f32>", declared: "mat4", offset: 64, size: 64 },
    { name: "g_Color4", type: "vec4<f32>", declared: "vec4", offset: 128, size: 16 },
    { name: "g_Alpha", type: "f32", declared: "float", offset: 144, size: 4 },
  ],
  uniformBlockSize: 160,
} as unknown as TranslateResult;

function withProgram(bundle: SceneBundle): SceneBundle {
  bundle.programs = [PROGRAM];
  for (const layer of bundle.layers) for (const pass of layer.passes) pass.program = 0;
  return bundle;
}

/** 按渲染器的规则算每个要建资源的图层的 uniform 值（同 `GpuScene`：一次状态快照一份世界矩阵缓存）。 */
function drawValues(bundle: SceneBundle, state: SceneState): Map<number, Record<string, number[]>> {
  const out = new Map<number, Record<string, number[]>>();
  const [width, height] = sceneTargetSize(bundle.general.width, bundle.general.height, 8192);
  const worlds = new Map<number, Mat4>();
  for (const layer of buildableLayers(bundle)) {
    const step = planLayer(layer, bundle.textures).steps.find((item) => item.kind === "draw");
    if (step?.kind !== "draw") continue;
    out.set(
      layer.object,
      drawUniformValues({
        step,
        layer: { ...state.layers.get(layer.object)!, size: layer.size },
        world: worldMatrixOf(layer.object, state.layers, worlds),
        constants: state.constants.get(step.pass.key) ?? {},
        viewProjection: sceneViewProjection(bundle.general),
        colorScale: 1,
        screenSize: [width, height],
        textures: [],
        eye: eyePosition(bundle.general),
      }),
    );
  }
  return out;
}

function uniformBytes(bundle: SceneBundle, state: SceneState): Map<number, string> {
  const out = new Map<number, string>();
  for (const [object, values] of drawValues(bundle, state)) {
    const block = new UniformBlock(PROGRAM.uniforms as UniformEntry[], PROGRAM.uniformBlockSize);
    for (const [name, value] of Object.entries(values)) block.set(name, value);
    out.set(object, Buffer.from(block.data).toString("hex"));
  }
  return out;
}

const nameOf = (bundle: SceneBundle) => (object: number) => bundle.layers[object].name;

describe("层级的真值（proj/p4a，WPE 实测）", () => {
  it("5 个图层四角与 WPE 差不超过 0.01 像素，绘制顺序、visible 遮蔽、alpha 不继承", async () => {
    const bundle = await compile(p4aObjects());
    const state = SceneState.fromBundle(bundle);
    const name = nameOf(bundle);
    expect(bundle.unsupported.filter((key) => key.startsWith("object:"))).toEqual([]);
    // 绘制顺序就是 objects 顺序，子在父前（h3 在 h4 前）也一样；h6 的祖先 g5 写死不可见：不画、不建资源
    const built = buildableLayers(bundle);
    expect(built.map((layer) => layer.name)).toEqual(["h3", "h4", "h1", "h2", "h7"]);
    expect(visibleObjects(built, state).map(name)).toEqual(["h3", "h4", "h1", "h2", "h7"]);
    expect(effectiveVisible(6, state.layers)).toBe(false);
    expect(state.layers.get(6)?.visible).toBe(true);

    const values = drawValues(bundle, state);
    let worst = 0;
    for (const layer of built) {
      const model = Float32Array.from(values.get(layer.object)!.g_ModelMatrix);
      const corners = layerQuad(layer.size, [1, 1]).map(({ position }) => transformPoint(model, ...position));
      for (const [x, y] of WPE_CORNERS[layer.name]) {
        const error = Math.min(...corners.map(([cx, cy]) => Math.hypot(cx - x, cy - y)));
        worst = Math.max(worst, error);
        expect(error, `${layer.name} (${x}, ${y})`).toBeLessThanOrEqual(0.01);
      }
    }
    expect(worst).toBeLessThanOrEqual(0.01);
    // alpha 不继承：h4 自己是 0.25，子 h3 是 1；h1 是 0.5，子 h2 是 1
    const alpha = (layerName: string) => values.get(bundle.layers.findIndex((layer) => layer.name === layerName))!;
    expect(alpha("h4").g_Alpha).toEqual([0.25]);
    expect(alpha("h3").g_Alpha).toEqual([1]);
    expect(alpha("h1").g_Alpha).toEqual([0.5]);
    expect(alpha("h2").g_Alpha).toEqual([1]);
    expect(alpha("h2").g_Color4[3]).toBe(1);
  });
});

describe("本地矩阵与世界矩阵", () => {
  /** 改之前的模型矩阵：`T · Rz · S`。 */
  const legacy = (layer: Pick<LayerTransform, "origin" | "angles" | "scale">): Mat4 => {
    const [x = 0, y = 0, z = 0] = layer.origin;
    const [sx = 1, sy = 1, sz = 1] = layer.scale;
    return multiply(
      multiply(translation(x, y, z), rotationZ(layer.angles[2] ?? 0)),
      scaling(sx, sy, sz === 0 ? 1 : sz),
    );
  };

  it("angles 的 x、y 为 0 时与旧矩阵逐位相同", () => {
    const cases: Pick<LayerTransform, "origin" | "angles" | "scale">[] = [
      { origin: [0, 0, 0], angles: [0, 0, 0], scale: [1, 1, 1] },
      { origin: [1082, 550.906, 0], angles: [0, 0, 0], scale: [1.1, 1.1, 1] },
      { origin: [100, 50, 0], angles: [0, 0, Math.PI / 2], scale: [2, 2, 1] },
      { origin: [-3.25, 7.5, 12], angles: [0, 0, -2.7], scale: [-1, 0.5, 0] },
      { origin: [1200, 800, 0], angles: [0, 0, 0.7], scale: [2, 3, 1] },
      { origin: [], angles: [], scale: [] },
      { origin: [5], angles: [0, 0], scale: [3] },
    ];
    for (const layer of cases)
      expect(Buffer.from(layerLocalMatrix(layer).buffer).toString("hex"), JSON.stringify(layer)).toBe(
        Buffer.from(legacy(layer).buffer).toString("hex"),
      );
  });

  it("三轴旋转的顺序是 Rz·Ry·Rx（与显式公式一致）", () => {
    const [ax, ay, az] = [0.2, 0.3, 0.4];
    const m = layerLocalMatrix({ origin: [0, 0, 0], angles: [ax, ay, az], scale: [1, 1, 1] });
    const [sx, cx, sy, cy, sz, cz] = [
      Math.sin(ax),
      Math.cos(ax),
      Math.sin(ay),
      Math.cos(ay),
      Math.sin(az),
      Math.cos(az),
    ];
    const expected = [
      [cy * cz, sx * sy * cz - cx * sz, cx * sy * cz + sx * sz],
      [cy * sz, sx * sy * sz + cx * cz, cx * sy * sz - sx * cz],
      [-sy, sx * cy, cx * cy],
    ];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) expect(m[c * 4 + r]).toBeCloseTo(expected[r][c], 6);
  });

  it("世界矩阵：子在父前、共享缓存与单独算结果相同，根节点就是本地矩阵", () => {
    const layers = new Map<number, LayerTransform>([
      [0, { origin: [10, 0, 0], angles: [0, 0, 0], scale: [1, 1, 1], visible: true, parent: 1 }],
      [1, { origin: [1200, 800, 0], angles: [0, 0, 0.7], scale: [2, 3, 1], visible: true, parent: null }],
    ]);
    const shared = new Map<number, Mat4>();
    const child = worldMatrixOf(0, layers, shared);
    expect(shared.has(1)).toBe(true);
    expect(worldMatrixOf(1, layers, shared)).toBe(shared.get(1));
    expect(Array.from(worldMatrixOf(1, layers, new Map()))).toEqual(Array.from(layerLocalMatrix(layers.get(1)!)));
    expect(Array.from(child)).toEqual(
      Array.from(multiply(layerLocalMatrix(layers.get(1)!), layerLocalMatrix(layers.get(0)!))),
    );
    // 父不在表里：当根节点；自己不在表里：单位阵
    const orphan = new Map([[3, { ...layers.get(0)!, parent: 99 }]]);
    expect(Array.from(worldMatrixOf(3, orphan, new Map()))).toEqual(Array.from(layerLocalMatrix(layers.get(0)!)));
    expect(Array.from(worldMatrixOf(7, orphan, new Map()))).toEqual(
      Array.from(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])),
    );
  });

  it("没断开的环也不会死循环（兜底）", () => {
    const node = (parent: number): LayerTransform => ({
      origin: [1, 0, 0],
      angles: [0, 0, 0],
      scale: [1, 1, 1],
      visible: true,
      parent,
    });
    const cyclic = new Map([
      [0, node(1)],
      [1, node(2)],
      [2, node(0)],
    ]);
    expect(worldMatrixOf(0, cyclic, new Map())[12]).toBe(3);
    expect(effectiveVisible(0, cyclic)).toBe(true);
    cyclic.set(2, { ...node(0), visible: false });
    expect(effectiveVisible(0, cyclic)).toBe(false);
  });
});

describe("SceneState：父子标脏", () => {
  it("写变换与可见性时子孙一起标脏，alpha / color / brightness 只标自己", async () => {
    const bundle = await compile(p4aObjects());
    const state = SceneState.fromBundle(bundle);
    const write = (
      object: number,
      field: "origin" | "angles" | "scale" | "visible" | "alpha" | "color" | "brightness",
      value: string | number | boolean,
    ) => {
      state.write({ property: "p", target: { kind: "layer", object, field } }, value);
      return [...state.takeDirty().layers].sort((a, b) => a - b);
    };
    // h4（1）的子是 h3（0）；g0（2）→ h1（3）→ h2（4）；g5（5）→ h6（6）
    expect(write(1, "origin", "1300 700 0")).toEqual([0, 1]);
    expect(write(2, "angles", "0 0 0.1")).toEqual([2, 3, 4]);
    expect(write(2, "scale", "1 1 1")).toEqual([2, 3, 4]);
    expect(write(3, "origin", "1 2 3")).toEqual([3, 4]);
    expect(write(5, "visible", true)).toEqual([5, 6]);
    expect(write(2, "alpha", 0.5)).toEqual([2]);
    expect(write(2, "color", "1 0 0")).toEqual([2]);
    expect(write(2, "brightness", 2)).toEqual([2]);
    expect(write(4, "origin", "0 0 0")).toEqual([4]);
    expect(write(7, "origin", "0 0 0")).toEqual([7]);
    // 写父的 visible 只改父自己的值，子孙的继承在读的时候算
    write(5, "visible", false);
    expect(state.layers.get(6)?.visible).toBe(true);
    expect(effectiveVisible(6, state.layers)).toBe(false);
  });

  it("就地改父的 origin / angles / scale 后，子孙的 uniform 字节等于用新值整场编译", async () => {
    const properties = {
      g0origin: { type: "text", value: "400 300 0" },
      g0angles: { type: "text", value: "0 0 0.5" },
      h4scale: { type: "text", value: "2 3 1" },
    };
    const bound = p4aObjects({
      g0: { origin: { user: "g0origin", value: "400 300 0" }, angles: { user: "g0angles", value: "0 0 0.5" } },
      h4: { scale: { user: "h4scale", value: "2 3 1" } },
    });
    const updated = { g0origin: "520 180 0", g0angles: "0.1 -0.2 1.3", h4scale: "0.5 4 1" };
    const before = withProgram(await compile(bound, {}, properties));
    const state = SceneState.fromBundle(before);
    const initial = uniformBytes(before, state);
    for (const binding of before.bindings) {
      const value = updated[binding.property as keyof typeof updated];
      if (value !== undefined) expect(state.write(binding, value)).toBe("applied");
    }
    expect([...state.takeDirty().layers].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
    const after = withProgram(await compile(bound, updated, properties));
    const fresh = SceneState.fromBundle(after);
    expect(state.layers).toEqual(fresh.layers);
    const applied = uniformBytes(before, state);
    expect(applied).toEqual(uniformBytes(after, fresh));
    // 子孙确实变了（父自己的写入传了下去），无关的 h7 不变
    for (const object of [0, 3, 4]) expect(applied.get(object)).not.toBe(initial.get(object));
    expect(applied.get(7)).toBe(initial.get(7));
  });
});

describe("可见性沿父链：建不建资源", () => {
  const objects = (visible: SceneObject["visible"]): SceneObject[] => [
    { id: 1, name: "g", origin: "100 100 0", visible },
    image({ id: 2, name: "c", parent: 1 }),
    image({ id: 3, name: "d", parent: 2 }),
  ];

  it("父写死不可见：子孙不建资源、不进 checkRenderable", async () => {
    const bundle = await compile(objects(false));
    expect(buildableLayers(bundle)).toEqual([]);
    // 程序为空（没有翻译器）：要建的图层会报 render:no-program，这里没有
    expect(checkRenderable(bundle, new Set(), { ignoreUnsupported: true })).toEqual([]);
  });

  it("父的 visible 绑了用户属性：子孙要建资源，当前不可见、改属性后可见", async () => {
    const properties = { show: { type: "bool", value: false } };
    const bundle = await compile(objects({ user: "show", value: false }), {}, properties);
    expect(bundle.layers[0].visibleBound).toBe(true);
    expect(buildableLayers(bundle).map((layer) => layer.name)).toEqual(["c", "d"]);
    expect(checkRenderable(bundle, new Set(), { ignoreUnsupported: true })).toEqual(["render:no-program"]);
    const state = SceneState.fromBundle(bundle);
    const built = buildableLayers(bundle);
    expect(visibleObjects(built, state)).toEqual([]);
    for (const binding of bundle.bindings.filter((item) => item.property === "show")) state.write(binding, true);
    expect(visibleObjects(built, state)).toEqual([1, 2]);
    // 子自己写死不可见时，孙也不画
    state.write({ property: "p", target: { kind: "layer", object: 1, field: "visible" } }, false);
    expect(visibleObjects(built, state)).toEqual([]);
  });

  it("场景带脚本时全部建（脚本随时可能改可见性，同 P3a）", async () => {
    const bundle = await compile(objects(false));
    bundle.scripts = { list: [{} as SceneBundle["scripts"]["list"][number]] };
    expect(buildableLayers(bundle).map((layer) => layer.name)).toEqual(["c", "d"]);
  });
});
