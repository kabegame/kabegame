/**
 * P14 步骤 2 的编译侧单测（`.claude/plans/wpe-import/3-scene/phase14/phase-14-model-data.md` 点 3–5）：
 * - 数字 `model`（脚本 `createModelData` 的 token）按描述编出 `SceneModel` / `SceneMesh`：格式、stride、计数、无索引的表示（`indexCount: 0`）、
 *   `source`、包围盒、绘制顺序、pass 键、`checkMeshAttributes`；查不到的 token 编出 `model: null` 且不报不支持项（S16）；其它类型仍报 `model:id`；
 * - 片段请求（`compileFragment`）带描述也能编，与整场编的片段逐字段相同；描述按 token 覆盖；
 * - `general.precache` 编出模型材质模板：键规整、去重、只收 `materials` 开头，`usable` 的各条判定，私有的不支持项不污染整场，
 *   程序排在程序表尾，不登记绑定；没有 precache 的场景 bundle 不出现 `modelMaterials`。
 */
import { describe, expect, it, vi } from "vitest";
import { compileScene, openCompileSession, type SceneBundle } from "./bundle";
import type { SceneReader } from "./fs";
import { fragmentOf, rekeyFragment } from "./fragment";
import { mdlStride } from "./mdl";
import { modelMaterialKey } from "../modeldata/layer";
import type { ModelDataDesc } from "../modeldata/types";
import type { Wpesl2wgsl } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

const ORTHO = { orthogonalprojection: { width: 1920, height: 1080 } };
const PBR = 0x1 | 0x2 | 0x8 | 0x8000; // POSITION + NORMAL + UV + COLOR

const MATERIALS: Record<string, unknown> = {
  "materials/obj.json": { passes: [{ shader: "mesh", blending: "normal" }] },
  "materials/obj_t.json": { passes: [{ shader: "mesh", blending: "translucent" }] },
  // 模板用的材质：着色器 `tmpl` 与对象材质的不同，所以程序排在表尾
  "materials/tmpl.json": { passes: [{ shader: "tmpl", blending: "translucent" }] },
  "materials/a2c.json": { passes: [{ shader: "tmpl", blending: "alphatocoverage" }] },
  "materials/bound.json": {
    passes: [{ shader: "tmpl", blending: "translucent", constantshadervalues: { multiply: { user: "p", value: 1 } } }],
  },
  "materials/two.json": { passes: [{ shader: "tmpl" }, { shader: "tmpl" }] },
  // 开了光照的材质（假翻译器给 `lit` 一个 LIGHTING = 1 的组合键）
  "materials/lit.json": { passes: [{ shader: "lit", blending: "translucent" }] },
};

function files(objects: unknown[], general: Record<string, unknown> = {}): Record<string, unknown> {
  const shader = (name: string) => ({
    [`P:/p/shaders/${name}.vert`]: `// ${name}`,
    [`P:/p/shaders/${name}.frag`]: `// ${name}`,
  });
  return {
    "P:/p/project.json": { file: "scene.json", general: { properties: { p: { type: "slider", value: 1 } } } },
    "P:/p/scene.json": { general: { ...ORTHO, ...general }, objects },
    ...Object.fromEntries(Object.entries(MATERIALS).map(([path, value]) => [`P:/p/${path}`, value])),
    ...shader("mesh"),
    ...shader("tmpl"),
    ...shader("lit"),
  };
}

/** 假翻译器：`mesh` 读位置与 uv；`tmpl` 有一个 float 常量 `multiply`。 */
const translator = {
  async translate(input: { fragment: string }) {
    const name = input.fragment.slice(3).trim();
    const attributes =
      name === "mesh"
        ? [
            { name: "a_Position", type: "vec3", location: 0 },
            { name: "a_TexCoord", type: "vec2", location: 1 },
          ]
        : [];
    const uniforms =
      name === "tmpl"
        ? [{ name: "g_Multiply", type: "f32", declared: "float", offset: 0, size: 4, meta: { material: "multiply" } }]
        : [];
    const combos = name === "lit" ? [{ name: "LIGHTING", value: 1 }] : [];
    return { ok: true, uniforms, textures: [], combos, attributes };
  },
} as unknown as Wpesl2wgsl;

function reader(map: Record<string, unknown>): SceneReader {
  const bytes = (path: string) => {
    const value = map[path.replace(/\\/g, "/")];
    if (value === undefined) throw new TypeError("Failed to fetch");
    return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
  };
  return {
    readWhole: async (path) => bytes(path),
    readRange: async (path, start, end) => bytes(path).slice(start, end),
  };
}

const input = (
  objects: unknown[],
  general: Record<string, unknown> = {},
  modelData?: Record<number, ModelDataDesc>,
) => ({
  projectDir: "P:/p",
  sceneAssets: ["A:/assets"],
  reader: reader(files(objects, general)),
  translator,
  postprocess: "disabled" as const,
  reflection: "disabled" as const,
  exhaustive: true,
  ...(modelData ? { modelData } : {}),
});

const compile = (
  objects: unknown[],
  general: Record<string, unknown> = {},
  modelData?: Record<number, ModelDataDesc>,
) => compileScene(input(objects, general, modelData));

/** 7 号：三个形状（uint16 索引不透明、uint32 索引半透明、无索引不透明），包围盒给定。 */
const DESC: ModelDataDesc = {
  token: 7,
  bounds: [-2, -2, -1, 2, 2, 1],
  shapes: [
    { format: PBR, vertexCount: 4, indexFormat: "uint16", indexCount: 6, material: "materials/obj.json" },
    { format: PBR, vertexCount: 3, indexFormat: "uint32", indexCount: 3, material: "materials/obj_t.json" },
    { format: 0x9, vertexCount: 6, indexFormat: null, indexCount: 0, material: "materials/obj.json" },
  ],
};

const modelObject = (extra: Record<string, unknown> = {}) => ({
  id: 5,
  name: "karin part",
  model: 7,
  origin: "100 200 0",
  ...extra,
});

/** 归一成可比较的普通值（类型化数组转数组）。 */
function canon(value: unknown): unknown {
  if (ArrayBuffer.isView(value))
    return { $view: value.constructor.name, $data: Array.from(value as unknown as number[]) };
  if (Array.isArray(value)) return value.map(canon);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = canon((value as Record<string, unknown>)[key]);
      if (item !== undefined) out[key] = item;
    }
    return out;
  }
  return value;
}

describe("数字 model：按描述编模型对象（点 3、4）", () => {
  it("每个形状一个网格：格式、stride、计数、source、材质 pass 与键、空视图", async () => {
    const bundle = await compile([modelObject()], {}, { 7: DESC });
    expect(bundle.unsupported).toEqual([]);
    const model = bundle.layers[0].model!;
    expect(model.path).toBe("");
    expect(model.version).toBe(0);
    expect(model.skeleton).toBeUndefined();
    expect(model.bounds).toEqual([-2, -2, -1, 2, 2, 1]);
    expect(model.meshes).toHaveLength(3);
    const [a, b, c] = model.meshes;
    expect(a).toMatchObject({
      format: PBR,
      stride: mdlStride(PBR),
      vertexCount: 4,
      indexFormat: "uint16",
      indexCount: 6,
    });
    expect(a.source).toEqual({ token: 7, shape: 0 });
    expect(a.vertices.byteLength).toBe(0);
    expect(a.indices.byteLength).toBe(0);
    expect(a.material).toBe("materials/obj.json");
    expect(a.passes.map((pass) => pass.key)).toEqual(["objects/0/meshes/0/passes/0"]);
    expect(b).toMatchObject({ indexFormat: "uint32", indexCount: 3, source: { token: 7, shape: 1 } });
    expect(b.passes[0].key).toBe("objects/0/meshes/1/passes/0");
    // 无索引：indexCount 0（indexFormat 占位 uint16），顶点数照给
    expect(c).toMatchObject({
      format: 0x9,
      stride: mdlStride(0x9),
      vertexCount: 6,
      indexFormat: "uint16",
      indexCount: 0,
    });
    expect(c.source).toEqual({ token: 7, shape: 2 });
    // 缓冲彼此独立（转移时不牵连）
    expect(new Set(model.meshes.flatMap((mesh) => [mesh.vertices.buffer, mesh.indices.buffer])).size).toBe(6);
  });

  it("绘制顺序：不透明的在前；透明排序类别 opaque；对象字段照常", async () => {
    const bundle = await compile([modelObject({ perspective: true })], {}, { 7: DESC });
    const layer = bundle.layers[0];
    expect(layer.model!.order).toEqual([0, 2, 1]);
    expect(layer.sortClass).toBe("opaque");
    expect(layer.perspective).toBe(true);
    expect(layer.origin).toEqual([100, 200, 0]);
    expect(layer.id).toBe(5);
  });

  it("全是半透明的模型：sortClass translucent", async () => {
    const desc: ModelDataDesc = { ...DESC, shapes: [DESC.shapes[1]] };
    const bundle = await compile([modelObject()], {}, { 7: desc });
    expect(bundle.layers[0].sortClass).toBe("translucent");
  });

  it("格式缺着色器读的属性：checkMeshAttributes 报 mdl:missing-attribute", async () => {
    const desc: ModelDataDesc = { ...DESC, shapes: [{ ...DESC.shapes[0], format: 0x1 }] };
    const bundle = await compile([modelObject()], {}, { 7: desc });
    expect(bundle.unsupported).toEqual(["mdl:missing-attribute:a_TexCoord"]);
  });

  it("查不到的 token：model 为 null、不报不支持项（S16）", async () => {
    const bundle = await compile([modelObject({ model: 99 })], {}, { 7: DESC });
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.layers[0].model).toBeNull();
    const none = await compile([modelObject()]);
    expect(none.unsupported).toEqual([]);
    expect(none.layers[0].model).toBeNull();
  });

  it("非整数 token 取整；model 是对象仍报 model:id", async () => {
    const bundle = await compile([modelObject({ model: 7.9 })], {}, { 7: DESC });
    expect(bundle.layers[0].model!.meshes).toHaveLength(3);
    const id = await compile([modelObject({ model: { token: 7 } })], {}, { 7: DESC });
    expect(id.unsupported).toEqual(["model:id"]);
  });

  it("castshadow：场景没有阴影时不投射；字段不带 castShadow", async () => {
    const bundle = await compile([modelObject()], {}, { 7: DESC });
    expect(bundle.layers[0].model!.castShadow).toBeUndefined();
  });
});

describe("片段请求带描述（点 3）", () => {
  const sceneObjects = [{ id: 1, name: "bg", model: 7, origin: "0 0 0" }];

  it("compileFragment 带 modelData 编出的片段，等于整场编的 fragmentOf 改键", async () => {
    const whole = await compile(sceneObjects, {}, { 7: DESC });
    const template = fragmentOf(whole, 0);
    expect(template).not.toBeNull();
    const b = rekeyFragment(template!, { object: 1, id: 21, parent: null });
    const session = await openCompileSession(input(sceneObjects));
    for (let i = 0; i < session.objectCount; i++) await session.compileObject(i);
    await session.finalize();
    // 会话开着的时候没有描述：开会话编的对象 0 是不画的层
    const delta = await session.compileFragment({
      object: 1,
      config: JSON.stringify({ id: 21, name: "bg", model: 7, origin: "0 0 0" }),
      parent: null,
      bone: null,
      properties: {},
      modelData: { 7: DESC },
    });
    const { unsupported: _u, sceneFlips: _f, ...a } = delta.fragment;
    const { unsupported: _u2, sceneFlips: _f2, ...rest } = b;
    expect(canon(a)).toEqual(canon(rest));
    expect(delta.fragment.unsupported).toEqual([]);
    expect(delta.fragment.layer.model!.meshes[0].source).toEqual({ token: 7, shape: 0 });
    expect(delta.fragment.layer.model!.meshes[0].passes[0].key).toBe("objects/1/meshes/0/passes/0");
  });

  it("描述按 token 覆盖：后一次请求的描述替换会话里的", async () => {
    const session = await openCompileSession(input([{ id: 1, name: "x", model: "none.mdl" }]));
    await session.finalize();
    const request = (object: number, desc: ModelDataDesc) => ({
      object,
      config: JSON.stringify({ id: object + 10, model: 7 }),
      parent: null,
      bone: null,
      properties: {},
      modelData: { 7: desc },
    });
    const first = await session.compileFragment(request(5, DESC));
    expect(first.fragment.layer.model!.meshes).toHaveLength(3);
    const second = await session.compileFragment(request(6, { ...DESC, shapes: [DESC.shapes[0]] }));
    expect(second.fragment.layer.model!.meshes).toHaveLength(1);
    // 不带描述的请求沿用会话里最后一份
    const third = await session.compileFragment({ ...request(7, DESC), modelData: undefined });
    expect(third.fragment.layer.model!.meshes).toHaveLength(1);
  });

  it("查不到的 token：片段 model 为 null、没有不支持项", async () => {
    const session = await openCompileSession(input(sceneObjects));
    for (let i = 0; i < session.objectCount; i++) await session.compileObject(i);
    await session.finalize();
    const delta = await session.compileFragment({
      object: 1,
      config: JSON.stringify({ id: 21, model: 42 }),
      parent: null,
      bone: null,
      properties: {},
    });
    expect(delta.fragment.layer.model).toBeNull();
    expect(delta.fragment.unsupported).toEqual([]);
  });
});

describe("general.precache：模型材质模板（点 5）", () => {
  const precache = [
    "materials/tmpl.json",
    "Materials/TMPL.json", // 同一个材质（规整后小写相同）：去重
    "textures/x.tex", // 不是 materials 开头
    5, // 不是字符串
    "materials/a2c.json",
    "materials/bound.json",
    "materials/none.json",
    "materials/two.json",
  ];

  it("modelMaterialKey：反斜杠与前缀规整并转小写，越界路径为 null", () => {
    expect(modelMaterialKey("Materials\\Karin/Mesh_0.JSON")).toBe("materials/karin/mesh_0.json");
    expect(modelMaterialKey("./materials/a.json")).toBe("materials/a.json");
    expect(modelMaterialKey("../x")).toBeNull();
  });

  it("按 precache 编模板：键、去重、只收 materials 开头", async () => {
    const bundle = await compile([modelObject()], { precache }, { 7: DESC });
    const templates = bundle.modelMaterials!;
    expect(Object.keys(templates)).toEqual([
      "materials/tmpl.json",
      "materials/a2c.json",
      "materials/bound.json",
      "materials/none.json",
      "materials/two.json",
    ]);
    expect(templates["materials/tmpl.json"].passes.map((pass) => pass.key)).toEqual(["modeldata/0/passes/0"]);
    expect(templates["materials/tmpl.json"].passes[0].material).toBe("materials/tmpl.json");
    // 整场的不支持项不被模板的私有集合污染（none.json 读不到、two.json 多 pass）
    expect(bundle.unsupported).toEqual([]);
  });

  it("usable：普通材质可用；A2C、登记绑定、材质读不到、多 pass 不可用", async () => {
    const bundle = await compile([modelObject()], { precache }, { 7: DESC });
    const templates = bundle.modelMaterials!;
    expect(templates["materials/tmpl.json"].usable).toBe(true);
    expect(templates["materials/a2c.json"].usable).toBe(false);
    expect(templates["materials/bound.json"].usable).toBe(false);
    expect(templates["materials/none.json"].usable).toBe(false);
    expect(templates["materials/none.json"].passes).toEqual([]);
    expect(templates["materials/two.json"].usable).toBe(false);
  });

  it("precache 的 materials 前缀不分大小写（同 WPE）", async () => {
    const bundle = await compile([modelObject()], { precache: ["MATERIALS/tmpl.json"] }, { 7: DESC });
    expect(Object.keys(bundle.modelMaterials!)).toEqual(["materials/tmpl.json"]);
  });

  it("开了光照的材质：模板不可用，场景的灯光位回滚（没有对象用它时不翻转）", async () => {
    const bundle = await compile([modelObject()], { precache: ["materials/lit.json"] }, { 7: DESC });
    expect(bundle.modelMaterials!["materials/lit.json"].usable).toBe(false);
    expect(bundle.lights).toBeUndefined();
  });

  it("模板不登记绑定（回滚），程序排在表尾，已有下标不动", async () => {
    const plain = await compile([modelObject()], {}, { 7: DESC });
    const bundle = await compile([modelObject()], { precache }, { 7: DESC });
    expect(bundle.bindings.some((binding) => JSON.stringify(binding.target).includes("modeldata/"))).toBe(false);
    expect(bundle.bindings).toEqual(plain.bindings);
    // 对象自己的程序下标与没有 precache 时相同；模板的程序在它们之后
    const own = bundle.layers[0].model!.meshes.flatMap((mesh) => mesh.passes.map((pass) => pass.program));
    expect(own).toEqual(plain.layers[0].model!.meshes.flatMap((mesh) => mesh.passes.map((pass) => pass.program)));
    const tail = bundle.modelMaterials!["materials/tmpl.json"].passes[0].program!;
    expect(tail).toBeGreaterThanOrEqual(Math.max(...(own as number[])) + 1);
    expect(bundle.programs.length).toBeGreaterThan(plain.programs.length);
  });

  it("场景已退回（settled）时不编模板", async () => {
    const bundle = await compileScene({
      ...input(
        [
          { id: 1, model: 3 },
          { id: 2, model: { a: 1 } },
        ],
        { precache },
      ),
      exhaustive: false,
    });
    expect(bundle.unsupported).toEqual(["model:id"]);
    expect(bundle.modelMaterials).toBeUndefined();
  });

  it("没有 precache 材质 / 没有数字 model 的场景：bundle 不出现新字段", async () => {
    const empty: SceneBundle = await compile([{ id: 1, name: "n" }], { precache: [] });
    expect("modelMaterials" in empty).toBe(false);
    const nonMaterial = await compile([{ id: 1, name: "n" }], { precache: ["textures/x.tex"] });
    expect("modelMaterials" in nonMaterial).toBe(false);
    expect(nonMaterial.unsupported).toEqual([]);
    for (const layer of nonMaterial.layers) expect(layer.model).toBeNull();
  });
});
