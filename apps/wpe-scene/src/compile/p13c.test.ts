/**
 * P13c 的编译侧单测（`.claude/plans/wpe-import/3-scene/phase13/phase-13c-sprite.md`「点 1」「点 3」；p13-REPORT「P13c 的实测」）：
 * - sprite 对象编成两网格的常量模型（网格 0 光斑、1 遮挡方块，顶点位置都是 (−1, 0, 1)、uv 四角、索引 0,1,2, 0,2,3，格式 `0x9`），顺序固定、
 *   不进半透明名单；
 * - 分派：`sprite` 是字符串才建（`"sprite": null` 不建、不报），非字符串照报 `object:sprite`；`effects` 照报 `sprite:effects`；
 * - 对象的 `origin` / `angles` / `scale` 中性（S5）；拼错的 `depthtesting` / `depthwriting` 中性（S4），深度按缺省规整；
 * - 反射开时 sprite 照报 `reflection:planar:sprite`。
 */
import { describe, expect, it, vi } from "vitest";
import { compileScene, REFLECTION_RT, type SceneBundle } from "./bundle";
import type { SceneReader } from "./fs";
import { mdlStride } from "./mdl";
import { reflectionKind } from "./reflection";
import { OCCLUSION_MATERIAL, SPRITE_BODY, SPRITE_FORMAT, SPRITE_OCCLUSION, spriteModel } from "./sprite";
import type { TranslateRequest, TranslateResult, Wpesl2wgsl } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

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

/** 一个网格的 mdl（v23，位置 + uv），材质读 `_rt_Reflection`（让反射名单生效）。 */
function mdl(material: string): Uint8Array {
  const out: number[] = [];
  const u32 = (value: number) => out.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
  const cstr = (text: string) => out.push(...new TextEncoder().encode(text), 0);
  const block = (bytes: Uint8Array) => {
    u32(bytes.length);
    out.push(...bytes);
  };
  cstr("MDLV0023");
  u32(0x9);
  u32(1);
  u32(1);
  cstr(material);
  u32(0);
  out.push(...new Uint8Array(new Float32Array([-1, -1, 0, 1, 1, 0]).buffer));
  u32(0x9);
  block(new Uint8Array(4 * mdlStride(0x9)));
  block(new Uint8Array(new Uint16Array([0, 1, 2, 0, 2, 3]).buffer));
  out.push(0, 0);
  u32(0);
  out.push(0);
  return new Uint8Array(out);
}

const translator = {
  async translate(_request: TranslateRequest): Promise<TranslateResult> {
    return { ok: true, uniforms: [], textures: [], combos: [] };
  },
} as unknown as Wpesl2wgsl;

/** 透视工程：对象 0 是 sprite（`sun.json`，拼错的深度键），之后接 `extra`。WPE 的 occlusiontest 放在 `A:/assets`。 */
async function compile(
  sprite: Record<string, unknown>,
  options: { extra?: Record<string, unknown>[]; reflection?: "enabled" | "disabled" } = {},
): Promise<SceneBundle> {
  const files: Record<string, Uint8Array | string> = {
    "P:/p/project.json": JSON.stringify({ file: "scene.json" }),
    "P:/p/materials/sun.json": JSON.stringify({
      passes: [
        { shader: "sprite", blending: "additive", depthtesting: "disabled", depthwriting: "disabled", textures: ["x"] },
      ],
    }),
    "P:/p/shaders/sprite.vert": "// sprite",
    "P:/p/shaders/sprite.frag": "// sprite",
    [`A:/assets/${OCCLUSION_MATERIAL}`]: JSON.stringify({
      passes: [{ shader: "occlusiontest", cullmode: "nocull", depthwrite: "disabled" }],
    }),
    "A:/assets/shaders/occlusiontest.vert": "// o",
    "A:/assets/shaders/occlusiontest.frag": "// o",
    "P:/p/models/ground.mdl": mdl("materials/ground.json"),
    "P:/p/materials/ground.json": JSON.stringify({ passes: [{ shader: "sprite", textures: [REFLECTION_RT] }] }),
  };
  files["P:/p/scene.json"] = JSON.stringify({
    camera: { eye: "0 0 0", center: "-1 0 1", up: "0 1 0" },
    general: {},
    objects: [{ id: 30, name: "sun", ...sprite }, ...(options.extra ?? [])],
  });
  return compileScene({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    reader: memoryReader(files),
    translator,
    postprocess: "disabled",
    reflection: options.reflection ?? "disabled",
    exhaustive: true,
  });
}

/** 纹理 `x` 在内存工程里读不到（与本节无关）。 */
const relevant = (keys: readonly string[]) => keys.filter((key) => !key.startsWith("tex"));

describe("sprite 对象（P13c 点 1）", () => {
  it("编成两网格的常量模型：光斑、遮挡方块，顺序固定、不剔除；不进半透明名单；拼错的深度键中性", async () => {
    const bundle = await compile({
      sprite: "materials/sun.json",
      origin: "5 5 5",
      scale: "3 3 3",
      angles: "0.5 0.2 0",
    });
    expect(relevant(bundle.unsupported)).toEqual([]);
    const layer = bundle.layers.find((item) => item.object === 0)!;
    expect(layer.sprite).toEqual({ material: "materials/sun.json" });
    expect(layer.sortClass).toBe("opaque");
    const model = layer.model!;
    expect(model.order).toEqual([SPRITE_BODY, SPRITE_OCCLUSION]);
    expect(model.bounds).toEqual([]);
    expect(model.meshes.map((mesh) => mesh.material)).toEqual(["materials/sun.json", OCCLUSION_MATERIAL]);
    for (const mesh of model.meshes) {
      expect(mesh.format).toBe(SPRITE_FORMAT);
      expect(mesh.stride).toBe(mdlStride(SPRITE_FORMAT));
      expect(Array.from(new Float32Array(mesh.vertices.slice().buffer))).toEqual([
        -1, 0, 1, 0, 0, -1, 0, 1, 1, 0, -1, 0, 1, 1, 1, -1, 0, 1, 0, 1,
      ]);
      expect(Array.from(new Uint16Array(mesh.indices.slice().buffer))).toEqual([0, 1, 2, 0, 2, 3]);
    }
    expect(model.meshes[SPRITE_BODY].passes[0]).toMatchObject({
      key: "objects/0/sprite/passes/0",
      blending: "additive",
      // 拼错的键不读，按缺省：测深度（S4），additive 不写深度
      depthtest: "enabled",
    });
    expect(model.meshes[SPRITE_OCCLUSION].passes[0]).toMatchObject({
      key: "objects/0/occlusion/passes/0",
      cullmode: "nocull",
      depthtest: "enabled",
      depthwrite: "disabled",
    });
  });

  it("每次编译新建网格的字节（bundle 交给主线程时会转移缓冲）", () => {
    const a = spriteModel("m", [], []);
    const b = spriteModel("m", [], []);
    expect(a.meshes[0].vertices.buffer).not.toBe(b.meshes[0].vertices.buffer);
  });

  it("分派：`sprite: null` 不建、不报；非字符串照报 object:sprite；effects 照报 sprite:effects", async () => {
    const empty = await compile({ sprite: null, origin: "0 0 0" });
    expect(empty.layers.find((item) => item.object === 0)?.sprite ?? null).toBeNull();
    expect(relevant(empty.unsupported)).toEqual([]);
    const bound = await compile({ sprite: { user: "p", value: "materials/sun.json" } });
    expect(bound.unsupported).toContain("object:sprite");
    const effects = await compile({ sprite: "materials/sun.json", effects: [{ file: "effects/x/effect.json" }] });
    expect(effects.unsupported).toContain("sprite:effects");
  });

  it("反射开：sprite 进名单时照报 reflection:planar:sprite", async () => {
    const bundle = await compile(
      { sprite: "materials/sun.json" },
      { reflection: "enabled", extra: [{ id: 40, name: "ground", model: "models/ground.mdl", origin: "0 0 0" }] },
    );
    expect(bundle.unsupported).toContain("reflection:planar:sprite");
    expect(reflectionKind({ ...bundle.layers.find((item) => item.object === 0)! })).toBe("sprite");
  });
});
