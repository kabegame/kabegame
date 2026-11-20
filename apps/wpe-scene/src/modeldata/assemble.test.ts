/**
 * P14 步骤 3a 的核心验收：主线程同步拼出的片段（`assembleModelDataFragment`）与 Worker 里编译会话 `compileFragment` 对同一份配置、同一份描述编出的
 * 片段逐字段相同（`canon` 深比较）。会话用内存文件系统与假翻译器，场景带 `general.precache`（所以有模型材质模板）。
 * 覆盖 3834692798（Karin）的几种部件配置、多形状、无索引形状、透明 / 不透明排序、格式缺着色器属性、场景有阴影时的投射变体；
 * 反例：白名单外的键、绑定 / 脚本值、材质没模板 / 模板不可用、透视场景、描述与配置的 token 对不上都返回 null。
 */
import { describe, expect, it, vi } from "vitest";
import { openCompileSession, type SceneBundle, type SceneCompileSession } from "../compile/bundle";
import type { SceneReader } from "../compile/fs";
import type { ObjectFragment } from "../compile/fragment";
import type { Wpesl2wgsl } from "../wpesl2wgsl";
import { assembleModelDataFragment, ASSEMBLE_KEYS, modelTokenOf } from "./assemble";
import type { ModelDataDesc } from "./types";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

const ORTHO = { orthogonalprojection: { width: 1920, height: 1080 } };
const PBR = 0x1 | 0x2 | 0x8 | 0x8000; // POSITION + NORMAL + UV + COLOR
const CLIP = 0x1 | 0x2 | 0x4 | 0x8 | 0x8000; // + TANGENT_SIGNED

const MATERIALS: Record<string, unknown> = {
  "materials/mesh_0.json": { passes: [{ shader: "mesh", blending: "normal" }] },
  "materials/mesh_t.json": { passes: [{ shader: "mesh", blending: "translucent" }] },
  "materials/clip_1.json": { passes: [{ shader: "clip", blending: "translucent", combos: { MASK_COUNT: 2 } }] },
  "materials/fx.json": { passes: [{ shader: "mesh", blending: "additive" }] },
  // 没进 precache：没有模板
  "materials/plain.json": { passes: [{ shader: "mesh", blending: "normal" }] },
  // 进了 precache 但模板不可用（A2C）
  "materials/a2c.json": { passes: [{ shader: "mesh", blending: "alphatocoverage" }] },
};

const PRECACHE = [
  "materials/mesh_0.json",
  "materials/mesh_t.json",
  "materials/clip_1.json",
  "materials/fx.json",
  "materials/a2c.json",
];

function files(objects: unknown[], general: Record<string, unknown>): Record<string, unknown> {
  const shader = (name: string) => ({
    [`P:/p/shaders/${name}.vert`]: `// ${name}`,
    [`P:/p/shaders/${name}.frag`]: `// ${name}`,
  });
  return {
    "P:/p/project.json": { file: "scene.json", general: { properties: { p: { type: "slider", value: 1 } } } },
    "P:/p/scene.json": { general: { ...ORTHO, ...general }, objects },
    ...Object.fromEntries(Object.entries(MATERIALS).map(([path, value]) => [`P:/p/${path}`, value])),
    ...shader("mesh"),
    ...shader("clip"),
    ...shader("shadowcaster"),
  };
}

/** 假翻译器：`mesh` 读位置与 uv；`clip` 多读法线与切线。 */
const translator = {
  async translate(input: { fragment: string }) {
    const name = input.fragment.slice(3).trim();
    const attributes =
      name === "mesh"
        ? [
            { name: "a_Position", type: "vec3", location: 0 },
            { name: "a_TexCoord", type: "vec2", location: 1 },
          ]
        : name === "clip"
          ? [
              { name: "a_Position", type: "vec3", location: 0 },
              { name: "a_Normal", type: "vec3", location: 1 },
              { name: "a_Tangent4", type: "vec4", location: 2 },
              { name: "a_TexCoord", type: "vec2", location: 3 },
            ]
          : [];
    const combos = name === "clip" ? [{ name: "MASK_COUNT", value: 0 }] : [];
    return { ok: true, uniforms: [], textures: [], combos, attributes };
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

/** 开会话并 finalize；`next` 是下一个能用的对象下标（场景里有一个占位对象 0）。 */
async function open(general: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const session: SceneCompileSession = await openCompileSession({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    reader: reader(files([{ id: 1, name: "bg" }], { precache: PRECACHE, ...general })),
    translator,
    postprocess: "disabled",
    reflection: "disabled",
    exhaustive: true,
    ...extra,
  } as never);
  for (let i = 0; i < session.objectCount; i++) await session.compileObject(i);
  const bundle = await session.finalize();
  return { session, bundle, next: 1 };
}

/** 归一成可比较的普通值（类型化数组转数组；undefined 的键丢掉）。 */
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

const shape = (material: string, format = PBR, indexFormat: "uint16" | "uint32" | null = "uint16") => ({
  format,
  vertexCount: 4,
  indexFormat,
  indexCount: indexFormat ? 6 : 0,
  material,
});
const desc = (shapes: ModelDataDesc["shapes"], token = 7): ModelDataDesc => ({
  token,
  shapes,
  bounds: [-960, -540, -1, 960, 540, 1],
});

interface Pair {
  worker: ObjectFragment;
  assembled: ObjectFragment | null;
}

/** 两条路各出一份片段：Worker 用会话，同步用 `assembleModelDataFragment`（同一份 bundle 与描述）。 */
async function both(
  ctx: Awaited<ReturnType<typeof open>>,
  config: Record<string, unknown>,
  modelDesc: ModelDataDesc,
  parent: number | null = null,
): Promise<Pair> {
  const object = ctx.next++;
  const text = JSON.stringify({ id: 1000 + object, ...config });
  const delta = await ctx.session.compileFragment({
    object,
    config: text,
    parent,
    bone: null,
    properties: {},
    modelData: { [modelDesc.token]: modelDesc },
  });
  const assembled = assembleModelDataFragment({
    object,
    id: 0,
    parent,
    config: text,
    desc: modelDesc,
    bundle: ctx.bundle,
  });
  return { worker: delta.fragment, assembled };
}

function expectSame(pair: Pair): void {
  expect(pair.assembled).not.toBeNull();
  expect(canon(pair.assembled)).toEqual(canon(pair.worker));
}

describe("拼装 = Worker 编（Karin 的部件配置）", () => {
  it("普通部件：id / name / model / origin / scale / perspective:false", async () => {
    const ctx = await open();
    const pair = await both(
      ctx,
      { name: "part_0", model: 7, origin: "1920 1080 -10", scale: "1 1 1", perspective: false },
      desc([shape("materials/mesh_0.json")]),
    );
    expectSame(pair);
    const layer = pair.assembled!.layer;
    expect(layer.origin).toEqual([1920, 1080, -10]);
    expect(layer.perspective).toBe(false);
    expect(layer.model!.meshes[0].source).toEqual({ token: 7, shape: 0 });
    expect(layer.model!.meshes[0].passes[0].key).toBe(`objects/${pair.assembled!.object}/meshes/0/passes/0`);
    expect(layer.sortClass).toBe("opaque");
    expect(pair.assembled!.unsupported).toEqual([]);
  });

  it("遮罩部件：再加 alpha / color，带切线的格式与 clip 材质", async () => {
    const ctx = await open();
    const pair = await both(
      ctx,
      {
        name: "clip_1",
        model: 7,
        origin: "1920 1080 -10",
        scale: "1 1 1",
        perspective: false,
        alpha: 1,
        color: "1 1 1",
      },
      desc([shape("materials/clip_1.json", CLIP, "uint32")]),
    );
    expectSame(pair);
    expect(pair.assembled!.layer.sortClass).toBe("translucent");
  });

  it("合批部件：visible:false", async () => {
    const ctx = await open();
    expectSame(
      await both(
        ctx,
        { name: "batch", model: 7, origin: "1920 1080 -10", scale: "1 1 1", perspective: false, visible: false },
        desc([shape("materials/mesh_t.json")]),
      ),
    );
  });

  it("游戏特效：solid:false、origin z = -5、additive 材质", async () => {
    const ctx = await open();
    const pair = await both(
      ctx,
      { name: "fx", model: 7, origin: "960 540 -5", scale: "1 1 1", perspective: false, solid: false },
      desc([shape("materials/fx.json", 0x1 | 0x8 | 0x8000)]),
    );
    expectSame(pair);
    expect(pair.assembled!.layer.solid).toBe(false);
  });

  it("多形状（不透明 uint16、半透明 uint32、无索引）：绘制顺序、sortClass", async () => {
    const ctx = await open();
    const pair = await both(
      ctx,
      { name: "multi", model: 7, origin: "0 0 0" },
      desc([
        shape("materials/mesh_0.json"),
        shape("materials/mesh_t.json", PBR, "uint32"),
        { format: 0x9, vertexCount: 6, indexFormat: null, indexCount: 0, material: "materials/mesh_0.json" },
      ]),
    );
    expectSame(pair);
    expect(pair.assembled!.layer.model!.order).toEqual([0, 2, 1]);
    // 无索引形状：indexCount 0、indexFormat 占位
    expect(pair.assembled!.layer.model!.meshes[2]).toMatchObject({ indexCount: 0, indexFormat: "uint16" });
  });

  it("全是半透明：sortClass translucent", async () => {
    const ctx = await open();
    const pair = await both(ctx, { name: "t", model: 7 }, desc([shape("materials/mesh_t.json")]));
    expectSame(pair);
    expect(pair.assembled!.layer.sortClass).toBe("translucent");
  });

  it("格式缺着色器属性：两边都报 mdl:missing-attribute", async () => {
    const ctx = await open();
    const pair = await both(ctx, { name: "bad", model: 7 }, desc([shape("materials/mesh_0.json", 0x1)]));
    expectSame(pair);
    expect(pair.assembled!.unsupported).toEqual(["mdl:missing-attribute:a_TexCoord"]);
    expect(pair.worker.unsupported).toEqual(["mdl:missing-attribute:a_TexCoord"]);
  });

  it("材质路径写法不同于 precache（前缀 ./、反斜杠）：仍命中模板，pass.material 取形状自己的", async () => {
    const ctx = await open();
    const pair = await both(ctx, { name: "case", model: 7 }, desc([shape(".\\materials\\mesh_0.json")]));
    expectSame(pair);
    expect(pair.assembled!.layer.model!.meshes[0].passes[0].material).toBe(".\\materials\\mesh_0.json");
  });

  it("平常字段：parent、parallaxDepth、colorBlendMode、castshadow、brightness、angles", async () => {
    const ctx = await open();
    expectSame(
      await both(
        ctx,
        {
          name: "misc",
          model: 7,
          parent: 1,
          parallaxDepth: "0.5 0.5",
          colorBlendMode: 3,
          castshadow: false,
          brightness: 2,
          angles: "0 0 90",
        },
        desc([shape("materials/mesh_0.json")]),
        0,
      ),
    );
  });

  it("非整数 token 取整", async () => {
    const ctx = await open();
    expectSame(await both(ctx, { name: "f", model: 7.9 }, desc([shape("materials/mesh_0.json")])));
  });

  it("场景有阴影：投射变体与 castShadow 两条路相同", async () => {
    const ctx = await open({ lightconfig: { point: 1, pointshadow: 1 } }, { shadows: "high" });
    expect(Object.values(ctx.bundle.modelMaterials!).some((template) => template.shadow)).toBe(true);
    const opaque = await both(ctx, { name: "s", model: 7 }, desc([shape("materials/mesh_0.json")]));
    expectSame(opaque);
    expect(opaque.assembled!.layer.model!.castShadow).toBe(true);
    expect(opaque.assembled!.layer.model!.meshes[0].shadow!.key).toBe(
      `objects/${opaque.assembled!.object}/meshes/0/shadow`,
    );
    // castshadow:false 关闭；全半透明的模型也不投射
    expectSame(await both(ctx, { name: "s2", model: 7, castshadow: false }, desc([shape("materials/mesh_0.json")])));
    const translucent = await both(ctx, { name: "s3", model: 7 }, desc([shape("materials/mesh_t.json")]));
    expectSame(translucent);
    expect(translucent.assembled!.layer.model!.castShadow).toBeUndefined();
  });
});

describe("反例：不满足同步条件返回 null（走 Worker 路）", () => {
  const assemble = (
    ctx: Awaited<ReturnType<typeof open>>,
    config: Record<string, unknown>,
    modelDesc: ModelDataDesc,
    bundle: Pick<SceneBundle, "modelMaterials" | "programs" | "general" | "reflection" | "audio"> = ctx.bundle,
  ) =>
    assembleModelDataFragment({
      object: 5,
      id: 0,
      parent: null,
      config: JSON.stringify({ id: 1005, ...config }),
      desc: modelDesc,
      bundle,
    });

  it("白名单外的键（effects、attachment、disablepropagation、clampuvs）", async () => {
    const ctx = await open();
    const d = desc([shape("materials/mesh_0.json")]);
    expect(assemble(ctx, { model: 7 }, d)).not.toBeNull();
    for (const extra of [
      { effects: [] },
      { attachment: "bone" },
      { disablepropagation: true },
      { clampuvs: false },
      { image: "models/x.json" },
    ])
      expect(assemble(ctx, { model: 7, ...extra }, d), JSON.stringify(extra)).toBeNull();
  });

  it("绑定 / 脚本 / 关键帧值、非平常值", async () => {
    const ctx = await open();
    const d = desc([shape("materials/mesh_0.json")]);
    for (const extra of [
      { alpha: { user: "p", value: 1 } },
      { origin: { script: "export function update(v) { return v; }", value: "0 0 0" } },
      { visible: { animation: { c0: [] }, value: true } },
      { color: ["1", "1", "1"] },
      { name: null },
    ])
      expect(assemble(ctx, { model: 7, ...extra }, d), JSON.stringify(extra)).toBeNull();
  });

  it("材质没模板、模板不可用", async () => {
    const ctx = await open();
    expect(assemble(ctx, { model: 7 }, desc([shape("materials/plain.json")]))).toBeNull();
    expect(ctx.bundle.modelMaterials!["materials/a2c.json"].usable).toBe(false);
    expect(assemble(ctx, { model: 7 }, desc([shape("materials/a2c.json")]))).toBeNull();
    // 多个形状里有一个不行就整体 null
    expect(
      assemble(ctx, { model: 7 }, desc([shape("materials/mesh_0.json"), shape("materials/plain.json")])),
    ).toBeNull();
  });

  it("场景没有 precache 模板 / 透视场景 / 平面反射", async () => {
    const ctx = await open();
    const d = desc([shape("materials/mesh_0.json")]);
    expect(assemble(ctx, { model: 7 }, d, { ...ctx.bundle, modelMaterials: undefined })).toBeNull();
    expect(
      assemble(ctx, { model: 7 }, d, { ...ctx.bundle, general: { ...ctx.bundle.general, perspective: true } }),
    ).toBeNull();
    expect(assemble(ctx, { model: 7 }, d, { ...ctx.bundle, reflection: { planar: true, enabled: true } })).toBeNull();
  });

  it("配置不是对象 / model 不是数字或和描述的 token 不符", async () => {
    const ctx = await open();
    const d = desc([shape("materials/mesh_0.json")]);
    expect(assemble(ctx, { model: "materials/x.mdl" }, d)).toBeNull();
    expect(assemble(ctx, { model: 8 }, d)).toBeNull();
    expect(
      assembleModelDataFragment({ object: 5, id: 0, parent: null, config: "[]", desc: d, bundle: ctx.bundle }),
    ).toBeNull();
    expect(
      assembleModelDataFragment({ object: 5, id: 0, parent: null, config: "{not json", desc: d, bundle: ctx.bundle }),
    ).toBeNull();
  });
});

describe("辅助", () => {
  it("modelTokenOf：数字 model 取整，别的 null", () => {
    expect(modelTokenOf('{"model":7}')).toBe(7);
    expect(modelTokenOf('{"model":7.9}')).toBe(7);
    expect(modelTokenOf('{"model":"a.mdl"}')).toBeNull();
    expect(modelTokenOf('{"image":"a"}')).toBeNull();
    expect(modelTokenOf("[]")).toBeNull();
    expect(modelTokenOf("{")).toBeNull();
  });

  it("白名单的最终内容", () => {
    expect([...ASSEMBLE_KEYS].sort()).toEqual(
      [
        "id",
        "name",
        "model",
        "origin",
        "angles",
        "scale",
        "visible",
        "alpha",
        "color",
        "brightness",
        "perspective",
        "parent",
        "solid",
        "parallaxDepth",
        "colorBlendMode",
        "castshadow",
      ].sort(),
    );
  });
});
