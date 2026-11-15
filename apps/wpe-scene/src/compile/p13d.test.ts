/**
 * P13d 的编译侧单测（`.claude/plans/wpe-import/3-scene/phase13/phase-13d-shadows.md`，rea-p13-shadows R5）：模型网格的投射变体
 * （`SceneMesh.shadow`）与对象的 `castShadow`。
 * - 只有不透明（normal / alphatocoverage）且 `castshadow` 不为 false 的模型投射；档位 disabled 或 `lightconfig` 没有点光 / 平行光阴影时不编；
 * - 投射着色器取基础片元的 `// [PASS] shadow <名>`，没有用 `shadowcaster`；
 * - COMBO 只取投射着色器自己声明的，值取基础程序的；基础 blending 为 alphatocoverage 时加 `ALPHATOCOVERAGE = 1`、变体也是 A2C；
 * - 纹理按注解的 `material` 键对槽；材质常量按名字从基础 pass 拷（投射着色器的注解没有缺省）。
 */
import { describe, expect, it, vi } from "vitest";
import { compileScene, type SceneBundle } from "./bundle";
import type { SceneReader } from "./fs";
import { mdlStride } from "./mdl";
import type { SceneShadowSetting } from "./postprocess";
import type { TextureBinding, TranslateRequest, TranslateResult, Wpesl2wgsl } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

function parts(...buffers: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(buffers.reduce((sum, bytes) => sum + bytes.length, 0));
  let at = 0;
  for (const bytes of buffers) {
    out.set(bytes, at);
    at += bytes.length;
  }
  return out;
}
const u32 = (value: number) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
};
const magic = (text: string) => parts(new TextEncoder().encode(text), new Uint8Array([0]));
/** RGBA8 单 mip 的 `.tex`。 */
function tex(size = 4): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  return parts(
    magic("TEXV0005"),
    magic("TEXI0001"),
    u32(0),
    u32(0),
    u32(size),
    u32(size),
    u32(size),
    u32(size),
    u32(0),
    magic("TEXB0002"),
    u32(1),
    u32(1),
    u32(size),
    u32(size),
    u32(0),
    u32(data.length),
    u32(data.length),
    data,
  );
}

/** 一个网格的 mdl（v23，位置 + uv），同 `p13b2.test.ts`。 */
function mdl(material: string): Uint8Array {
  const out: number[] = [];
  const word = (value: number) => out.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
  const cstr = (text: string) => out.push(...new TextEncoder().encode(text), 0);
  const block = (bytes: Uint8Array) => {
    word(bytes.length);
    out.push(...bytes);
  };
  cstr("MDLV0023");
  word(0x9);
  word(1);
  word(1);
  cstr(material);
  word(0);
  out.push(...new Uint8Array(new Float32Array([-1, -1, 0, 1, 1, 0]).buffer));
  word(0x9);
  block(new Uint8Array(4 * mdlStride(0x9)));
  block(new Uint8Array(new Uint16Array([0, 1, 2, 0, 2, 3]).buffer));
  out.push(0, 0);
  word(0);
  out.push(0);
  return new Uint8Array(out);
}

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

const slot = (n: number, material: string): TextureBinding => ({
  slot: n,
  name: `g_Texture${n}`,
  kind: "2d",
  binding: 1 + 2 * n,
  samplerBinding: 2 + 2 * n,
  meta: { material },
});
const strength = (meta: Record<string, unknown>) => ({ name: "u_Strength", type: "f32", offset: 0, size: 4, meta });

/**
 * 替身翻译器：片元里有 `CASTER` 的是投射着色器（声明 `LEAVES`、`ALPHATOCOVERAGE`，A2C 时才声明 albedo 纹理，常量注解没有缺省），
 * 其余是基础着色器（声明 `LIGHTING`、`LEAVES`、`OTHER`，albedo / normal 两个纹理，常量注解缺省 0.3）。
 */
function translator(): Wpesl2wgsl & { casters: { shader: string; combos: Record<string, unknown> }[] } {
  const casters: { shader: string; combos: Record<string, unknown> }[] = [];
  return {
    casters,
    async translate(request: TranslateRequest): Promise<TranslateResult> {
      const combos = request.combos ?? {};
      const value = (name: string) => Number(combos[name] ?? 0);
      if (request.fragment.includes("CASTER")) {
        casters.push({ shader: request.fragment.includes("mycaster") ? "mycaster" : "shadowcaster", combos });
        return {
          ok: true,
          uniforms: [strength({ material: "strength" })],
          textures: value("ALPHATOCOVERAGE") ? [slot(0, "albedo")] : [],
          combos: [
            { name: "LEAVES", value: value("LEAVES"), source: "request" },
            { name: "ALPHATOCOVERAGE", value: value("ALPHATOCOVERAGE"), source: "request" },
          ],
        } as unknown as TranslateResult;
      }
      return {
        ok: true,
        uniforms: [strength({ material: "strength", default: 0.3 })],
        textures: [slot(0, "albedo"), slot(1, "normal")],
        combos: [
          { name: "LIGHTING", value: 1, source: "request" },
          { name: "LEAVES", value: value("LEAVES"), source: "request" },
          { name: "OTHER", value: 1, source: "request" },
        ],
      } as unknown as TranslateResult;
    },
  } as unknown as Wpesl2wgsl & { casters: { shader: string; combos: Record<string, unknown> }[] };
}

const material = (pass: Record<string, unknown>) =>
  JSON.stringify({ passes: [{ shader: "s", cullmode: "nocull", textures: ["kbt/a", "kbt/n"], ...pass }] });

/** 工程：一盏带阴影的点光；模型 a 不透明（LEAVES 1、strength 0.7）、b 半透明、c 不透明但 castshadow false、d A2C 且着色器注解 mycaster。 */
async function compile(
  options: { shadows?: SceneShadowSetting; lightconfig?: Record<string, number> } = {},
): Promise<{ bundle: SceneBundle; casters: { shader: string; combos: Record<string, unknown> }[] }> {
  const files: Record<string, Uint8Array | string> = {
    "P:/p/project.json": JSON.stringify({ file: "scene.json" }),
    "P:/p/models/a.mdl": mdl("materials/a.json"),
    "P:/p/models/b.mdl": mdl("materials/b.json"),
    "P:/p/models/c.mdl": mdl("materials/c.json"),
    "P:/p/models/d.mdl": mdl("materials/d.json"),
    "P:/p/materials/a.json": material({ combos: { LEAVES: 1, LIGHTING: 1 }, constantshadervalues: { strength: 0.7 } }),
    "P:/p/materials/b.json": material({ blending: "translucent", combos: { LIGHTING: 1 } }),
    "P:/p/materials/c.json": material({ combos: { LIGHTING: 1 } }),
    "P:/p/materials/d.json": material({ shader: "sa", blending: "alphatocoverage", combos: { LIGHTING: 1 } }),
    "P:/p/materials/kbt/a.tex": tex(),
    "P:/p/materials/kbt/n.tex": tex(),
    "P:/p/shaders/s.vert": "// s",
    "P:/p/shaders/s.frag": "// s",
    "P:/p/shaders/sa.vert": "// sa",
    "P:/p/shaders/sa.frag": "// [PASS] shadow mycaster\n// sa",
    "P:/p/shaders/shadowcaster.vert": "// CASTER",
    "P:/p/shaders/shadowcaster.frag": "// CASTER",
    "P:/p/shaders/mycaster.vert": "// CASTER mycaster",
    "P:/p/shaders/mycaster.frag": "// CASTER mycaster",
  };
  const model = (id: number, name: string, extra: Record<string, unknown> = {}) => ({
    id,
    name,
    model: `models/${name}.mdl`,
    origin: "0 0 0",
    ...extra,
  });
  files["P:/p/scene.json"] = JSON.stringify({
    general: {
      orthogonalprojection: { width: 64, height: 32 },
      lightconfig: options.lightconfig ?? { point: 1, pointshadow: 1 },
    },
    objects: [
      model(10, "a"),
      model(11, "b"),
      model(12, "c", { castshadow: false }),
      model(13, "d"),
      {
        id: 20,
        name: "L",
        light: "lpoint",
        origin: "0 8 0",
        color: "1 1 1",
        intensity: 1,
        radius: 10,
        castshadow: true,
      },
    ],
  });
  const t = translator();
  const bundle = await compileScene({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    reader: memoryReader(files),
    translator: t,
    postprocess: "disabled",
    shadows: options.shadows ?? "low",
    exhaustive: true,
  });
  return { bundle, casters: t.casters };
}

const layer = (bundle: SceneBundle, name: string) => bundle.layers.find((item) => item.name === name)!;

describe("投射变体（compileScene，R5）", () => {
  it("不透明且 castshadow 不为 false 的模型投射；半透明、castshadow false 不投", async () => {
    const { bundle } = await compile();
    expect(bundle.unsupported).toEqual([]);
    expect(layer(bundle, "a").model?.castShadow).toBe(true);
    expect(layer(bundle, "d").model?.castShadow).toBe(true);
    expect(layer(bundle, "b").model?.castShadow).toBeUndefined();
    expect(layer(bundle, "c").model?.castShadow).toBeUndefined();
    expect(bundle.lights?.quality).toBe(1);
  });

  it("COMBO 只取投射着色器声明的、值取基础程序的；材质常量按名字从基础 pass 拷", async () => {
    const { bundle, casters } = await compile();
    const shadow = layer(bundle, "a").model!.meshes[0].shadow!;
    expect(shadow.blending).toBe("normal");
    // 先不带 COMBO 译一次取声明，再按最终的 COMBO 译：LEAVES 取基础的 1，基础的 LIGHTING / OTHER 投射着色器没声明、不带
    expect(casters.map((call) => call.combos)).toContainEqual({ LEAVES: 1, ALPHATOCOVERAGE: 0 });
    expect(casters.every((call) => !("OTHER" in call.combos) && !("LIGHTING" in call.combos))).toBe(true);
    // 基础 pass 的 strength 是材质写的 0.7（不是基础注解的缺省 0.3），投射那边按名字拷
    expect(layer(bundle, "a").model!.meshes[0].passes[0].uniforms.u_Strength).toEqual([0.7]);
    expect(shadow.uniforms.u_Strength).toEqual([0.7]);
    // 不是 A2C：投射着色器不声明纹理，不配对
    expect(shadow.textures).toEqual({});
  });

  it("注解选着色器；基础 A2C 时加 ALPHATOCOVERAGE = 1、变体也是 A2C，albedo 纹理按 material 键对槽", async () => {
    const { bundle, casters } = await compile();
    expect(casters.some((call) => call.shader === "mycaster")).toBe(true);
    const shadow = layer(bundle, "d").model!.meshes[0].shadow!;
    expect(shadow.blending).toBe("alphatocoverage");
    expect(casters.filter((call) => call.shader === "mycaster").at(-1)?.combos).toEqual({
      LEAVES: 0,
      ALPHATOCOVERAGE: 1,
    });
    expect(bundle.textures[shadow.textures[0]].path).toMatch(/kbt\/a\.tex$/);
    // 材质没写 strength：基础 pass 取自己注解的缺省 0.3，投射着色器的注解没有缺省，按名字从基础拷过来才是 0.3
    expect(layer(bundle, "d").model!.meshes[0].passes[0].uniforms.u_Strength).toEqual([0.3]);
    expect(shadow.uniforms.u_Strength).toEqual([0.3]);
    // 没有注解的用 shadowcaster
    expect(casters.some((call) => call.shader === "shadowcaster")).toBe(true);
  });

  it("档位 disabled 或 lightconfig 没有阴影计数：不编投射变体、不投射", async () => {
    for (const options of [{ shadows: "disabled" as const }, { lightconfig: { point: 1 } }]) {
      const { bundle, casters } = await compile(options);
      expect(casters).toEqual([]);
      for (const name of ["a", "b", "c", "d"]) {
        expect(layer(bundle, name).model?.castShadow).toBeUndefined();
        expect(layer(bundle, name).model?.meshes[0].shadow).toBeUndefined();
      }
    }
  });
});
