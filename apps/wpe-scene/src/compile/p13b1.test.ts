/**
 * P13b1 的编译侧单测（`.claude/plans/wpe-import/3-scene/phase13/phase-13b1-reflection-off.md`「点 2」「点 3」「点 6」）：
 * - `resolveReflection` 的表（三种设置 × WPE 值 true / false / 缺键 / 读不到 / 非布尔）、`config.json` 多用户与 BOM；
 * - 模型的网格读 `_rt_Reflection`（材质 `textures`、着色器注解缺省两种来源）：反射关时 `bundle.reflection.planar`、不报；反射开时报
 *   `reflection:planar`；跟随时读 WPE 的 `general.user.reflection`；
 * - 只有图像层读：不报、那一槽绑棋盘格、`runtime` 里没有它、没有 `bundle.reflection`（步骤 0 R3）；
 * - 读 `_rt_MipMappedFrameBuffer` 与 `g_Texture<n>MipMapInfo`：关时不报、开时报 `reflection:screen`；别的槽的 `MipMapInfo` 照报。
 */
import { describe, expect, it, vi } from "vitest";
import { compileScene, MIP_FRAMEBUFFER_RT, REFLECTION_RT, type SceneBundle } from "./bundle";
import type { SceneReader } from "./fs";
import { mdlStride } from "./mdl";
import { resolveReflection, wpeUserValueOf, type SceneReflectionSetting } from "./postprocess";
import type { TextureBinding, TranslateRequest, TranslateResult, Wpesl2wgsl } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

// ———— resolveReflection 与 config.json ————

describe("resolveReflection（rea-p13-passes 1.2）", () => {
  const cases: [string | undefined | null, unknown, boolean][] = [
    // 跟随：WPE 的布尔原样，缺键 / 读不到 / 非布尔都按开
    ["follow", true, true],
    ["follow", false, false],
    ["follow", undefined, true],
    ["follow", null, true],
    ["follow", "false", true],
    ["follow", 0, true],
    // 固定：不看 WPE
    ["disabled", true, false],
    ["disabled", undefined, false],
    ["enabled", false, true],
    ["enabled", undefined, true],
    // 不认识的设置值、缺省按跟随
    ["ultra", false, false],
    ["ultra", undefined, true],
    [undefined, false, false],
    [null, true, true],
    ["", false, false],
  ];
  it.each(cases)("设置 %s、WPE 值 %j → %s", (setting, wpe, expected) => {
    expect(resolveReflection(setting, wpe)).toBe(expected);
  });
});

describe("wpeUserValueOf：config.json 的 general.user.<键>", () => {
  const config = (users: Record<string, unknown>) => JSON.stringify(users);
  it("取第一个有该键的用户；`?` 开头的键与没有该键的用户跳过", () => {
    const text = config({
      "?installdir": { general: { user: { reflection: false } } },
      alice: { general: { user: { postprocessing: "ultra" } } },
      bob: { general: { user: { reflection: false, postprocessing: "disabled" } } },
      carol: { general: { user: { reflection: true } } },
    });
    expect(wpeUserValueOf(text, "reflection")).toBe(false);
    expect(wpeUserValueOf(text, "postprocessing")).toBe("ultra");
    expect(wpeUserValueOf(text, "nothing")).toBeUndefined();
  });
  it("带 BOM 的文本照常读；不是 JSON、不是对象时返回 undefined", () => {
    expect(wpeUserValueOf("﻿" + config({ a: { general: { user: { reflection: false } } } }), "reflection")).toBe(false);
    expect(wpeUserValueOf("不是 JSON", "reflection")).toBeUndefined();
    expect(wpeUserValueOf("[1]", "reflection")).toBeUndefined();
    expect(wpeUserValueOf("null", "reflection")).toBeUndefined();
  });
  it("`accept` 不认的值跳到下一个用户；值是 null 也算「有该键」", () => {
    const text = config({
      a: { general: { user: { postprocessing: 3 } } },
      b: { general: { user: { postprocessing: "ultra" } } },
    });
    expect(wpeUserValueOf(text, "postprocessing", (value) => typeof value === "string")).toBe("ultra");
    expect(wpeUserValueOf(config({ a: { general: { user: { reflection: null } } } }), "reflection")).toBeNull();
  });
});

// ———— 内存工程 ————

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

/** 一个网格的 mdl（v23，位置 + uv），材质路径由参数给。 */
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

const textureSlot = (slot: number, meta?: Record<string, unknown>): TextureBinding => ({
  slot,
  name: `g_Texture${slot}`,
  kind: "2d",
  binding: 1 + 2 * slot,
  samplerBinding: 2 + 2 * slot,
  ...(meta ? { meta } : {}),
});
const mipInfoUniform = (slot: number) => ({
  name: `g_Texture${slot}MipMapInfo`,
  type: "f32",
  declared: "float",
  offset: 16 * slot,
  size: 4,
});

/** 着色器（顶点源码 `// <名字>`）→ 翻译结果。 */
const SHADERS: Record<string, Partial<TranslateResult>> = {
  s: { textures: [textureSlot(0)] },
  // 槽 1 只有注解缺省 `_rt_Reflection`
  refl: { textures: [textureSlot(0), textureSlot(1, { default: REFLECTION_RT })] },
  // 读 mip 帧缓冲与它的 MipMapInfo（槽 1 由材质 `textures` 绑 `_rt_MipMappedFrameBuffer`）
  mip: { textures: [textureSlot(0), textureSlot(1)], uniforms: [mipInfoUniform(1)] as never },
  // 槽 1 只有注解缺省 mip 帧缓冲
  mipdef: {
    textures: [textureSlot(0), textureSlot(1, { default: MIP_FRAMEBUFFER_RT })],
    uniforms: [mipInfoUniform(1)] as never,
  },
  // 读的是别的槽的 MipMapInfo：槽 0 绑的不是 mip 帧缓冲
  mipother: { textures: [textureSlot(0), textureSlot(1)], uniforms: [mipInfoUniform(0)] as never },
};

const translator = {
  async translate(request: TranslateRequest): Promise<TranslateResult> {
    const name = /^\/\/ (\S+)/.exec(request.vertex)?.[1] ?? "";
    return { ok: true, uniforms: [], textures: [], combos: [], ...SHADERS[name] };
  },
} as unknown as Wpesl2wgsl;

interface Scene {
  /** 模型网格的材质 pass（`undefined` 没有模型）。 */
  model?: Record<string, unknown>;
  /** 图像层的材质 pass（`undefined` 没有图像层）。 */
  image?: Record<string, unknown>;
}

async function compile(
  scene: Scene,
  options: { reflection?: SceneReflectionSetting; config?: string; hdr?: boolean } = {},
): Promise<SceneBundle> {
  const objects: Record<string, unknown>[] = [];
  const files: Record<string, Uint8Array | string> = {
    "P:/p/project.json": JSON.stringify({ file: "scene.json" }),
    "P:/p/models/a.json": JSON.stringify({ material: "materials/img.json" }),
  };
  if (scene.model) {
    objects.push({ id: 1, name: "m", model: "models/a.mdl", origin: "960 540 0" });
    files["P:/p/models/a.mdl"] = mdl("materials/mesh.json");
    files["P:/p/materials/mesh.json"] = JSON.stringify({ passes: [{ blending: "translucent", ...scene.model }] });
  }
  if (scene.image) {
    objects.push({ id: 2, name: "i", image: "models/a.json", origin: "960 540 0" });
    files["P:/p/materials/img.json"] = JSON.stringify({ passes: [{ blending: "translucent", ...scene.image }] });
  }
  files["P:/p/scene.json"] = JSON.stringify({
    general: { orthogonalprojection: { width: 1920, height: 1080 } },
    objects,
  });
  for (const name of Object.keys(SHADERS)) {
    files[`P:/p/shaders/${name}.vert`] = `// ${name}`;
    files[`P:/p/shaders/${name}.frag`] = `// ${name}`;
  }
  if (options.config !== undefined) files["A:/config.json"] = options.config;
  return compileScene({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    reader: memoryReader(files),
    translator,
    postprocess: "disabled",
    reflection: options.reflection,
    exhaustive: true,
  });
}

const userConfig = (reflection?: unknown) =>
  JSON.stringify({ user: { general: { user: reflection === undefined ? {} : { reflection } } } });

describe("平面反射：模型读 _rt_Reflection（点 3）", () => {
  it("材质 textures 绑：反射关时记 bundle.reflection.planar、不报；runtime 保留、不再报 texture:rendertarget", async () => {
    const bundle = await compile({ model: { shader: "s", textures: ["", REFLECTION_RT] } }, { reflection: "disabled" });
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.reflection).toEqual({ planar: true });
    expect(bundle.layers[0].model!.meshes[0].passes[0].runtime).toEqual({ 1: REFLECTION_RT });
    expect(bundle.mipFramebuffer).toBeUndefined();
  });

  it("着色器注解缺省绑（generic2 的 g_Texture2 就是这种）：同样 planar", async () => {
    const bundle = await compile({ model: { shader: "refl" } }, { reflection: "disabled" });
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.reflection).toEqual({ planar: true });
    expect(bundle.layers[0].model!.meshes[0].passes[0].runtime).toEqual({ 1: REFLECTION_RT });
  });

  it("反射开（P13b2 起实现）：不再报，bundle.reflection 带 enabled 与名单（读反射图的模型自己不在名单里）", async () => {
    for (const model of [{ shader: "s", textures: ["", REFLECTION_RT] }, { shader: "refl" }]) {
      const bundle = await compile({ model }, { reflection: "enabled" });
      expect(bundle.unsupported).toEqual([]);
      expect(bundle.reflection).toEqual({ planar: true, enabled: true, list: [] });
    }
  });

  it("跟随 WPE：config.json 的 reflection 为 false 时关，true / 缺键 / 没有 config.json / 非布尔都按开", async () => {
    const model = { shader: "refl" };
    const enabled = async (options: Parameters<typeof compile>[1]) =>
      (await compile({ model }, options)).reflection?.enabled === true;
    expect(await enabled({ config: userConfig(false) })).toBe(false);
    for (const config of [userConfig(true), userConfig(), userConfig("no"), undefined, "不是 JSON"])
      expect(await enabled({ config })).toBe(true);
    // 默认设置就是跟随
    expect(await enabled({ config: userConfig(false), reflection: "follow" })).toBe(false);
    // 固定的设置不看 config.json
    expect(await enabled({ config: userConfig(true), reflection: "disabled" })).toBe(false);
    expect(await enabled({ config: userConfig(false), reflection: "enabled" })).toBe(true);
  });

  it("模型与图像层都读：图像层那一槽保持运行时 RT（planar 为真，RT 是建了的）", async () => {
    const bundle = await compile(
      { model: { shader: "s", textures: ["", REFLECTION_RT] }, image: { shader: "s", textures: ["", REFLECTION_RT] } },
      { reflection: "disabled" },
    );
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.reflection).toEqual({ planar: true });
    const image = bundle.layers.find((layer) => layer.object === 1)!;
    expect(image.passes[0].runtime).toEqual({ 1: REFLECTION_RT });
    expect(image.passes[0].textures[1]).toBeUndefined();
  });
});

describe("只有图像层读 _rt_Reflection：WPE 不建 RT，绑棋盘格（步骤 0 R3）", () => {
  for (const [label, image] of [
    ["材质 textures", { shader: "s", textures: ["", REFLECTION_RT] }],
    ["注解缺省", { shader: "refl" }],
  ] as const)
    it(`${label}：不报、runtime 里没有它、那一槽是棋盘格、没有 bundle.reflection（开 / 关都一样）`, async () => {
      for (const reflection of ["disabled", "enabled"] as const) {
        const bundle = await compile({ image }, { reflection });
        expect(bundle.unsupported).toEqual([]);
        expect(bundle.reflection).toBeUndefined();
        const pass = bundle.layers[0].passes[0];
        expect(pass.runtime).toEqual({});
        const checker = bundle.textures[pass.textures[1]];
        expect(checker).toMatchObject({ path: "<checker>", source: "placeholder", width: 6, height: 6 });
      }
    });

  it("没有任何读者：不读 config.json、没有 reflection / mipFramebuffer 键", async () => {
    const bundle = await compile({ image: { shader: "s" } });
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.reflection).toBeUndefined();
    expect(bundle.mipFramebuffer).toBeUndefined();
  });
});

describe("_rt_MipMappedFrameBuffer 与 g_Texture<n>MipMapInfo（〔g1〕）", () => {
  it("图像层材质 textures 绑它：反射关时不报（MipMapInfo 是引擎 uniform），记 mipFramebuffer；开时报 reflection:screen", async () => {
    const image = { shader: "mip", textures: ["", MIP_FRAMEBUFFER_RT] };
    const off = await compile({ image }, { reflection: "disabled" });
    expect(off.unsupported).toEqual([]);
    expect(off.mipFramebuffer).toBe(true);
    expect(off.reflection).toBeUndefined();
    expect(off.layers[0].passes[0].runtime).toEqual({ 1: MIP_FRAMEBUFFER_RT });
    const on = await compile({ image }, { reflection: "enabled" });
    expect(on.unsupported).toEqual(["reflection:screen"]);
    expect(on.mipFramebuffer).toBe(true);
  });

  it("注解缺省绑它：同样不报 MipMapInfo", async () => {
    const off = await compile({ image: { shader: "mipdef" } }, { reflection: "disabled" });
    expect(off.unsupported).toEqual([]);
    expect(off.mipFramebuffer).toBe(true);
  });

  it("别的槽的 MipMapInfo 照旧报 uniform:*（槽 0 绑的不是 mip 帧缓冲）", async () => {
    const bundle = await compile(
      { image: { shader: "mipother", textures: ["", MIP_FRAMEBUFFER_RT] } },
      { reflection: "disabled" },
    );
    expect(bundle.unsupported).toEqual(["uniform:g_Texture0MipMapInfo"]);
  });

  it("没有绑 mip 帧缓冲的 pass 读 MipMapInfo：照报", async () => {
    const bundle = await compile({ image: { shader: "mip" } }, { reflection: "disabled" });
    expect(bundle.unsupported).toEqual(["uniform:g_Texture1MipMapInfo"]);
    expect(bundle.mipFramebuffer).toBeUndefined();
  });

  it("读 mip 帧缓冲的格式：LDR 是 RGBA8（TEX<n>FORMAT 为 0）", async () => {
    const requests: TranslateRequest[] = [];
    const spy = {
      async translate(request: TranslateRequest) {
        requests.push(request);
        return translator.translate(request);
      },
    } as unknown as Wpesl2wgsl;
    await compileScene({
      projectDir: "P:/p",
      sceneAssets: ["A:/assets"],
      reader: memoryReader({
        "P:/p/project.json": JSON.stringify({ file: "scene.json" }),
        "P:/p/scene.json": JSON.stringify({
          general: { orthogonalprojection: { width: 1920, height: 1080 } },
          objects: [{ id: 2, name: "i", image: "models/a.json", origin: "960 540 0" }],
        }),
        "P:/p/models/a.json": JSON.stringify({ material: "materials/img.json" }),
        "P:/p/materials/img.json": JSON.stringify({
          passes: [{ shader: "mip", blending: "translucent", textures: ["", MIP_FRAMEBUFFER_RT] }],
        }),
        "P:/p/shaders/mip.vert": "// mip",
        "P:/p/shaders/mip.frag": "// mip",
      }),
      translator: spy,
      postprocess: "disabled",
      reflection: "disabled",
      exhaustive: true,
    });
    expect(requests[0].textures?.find((item) => item.slot === 1)?.format).toBe(0);
  });
});
