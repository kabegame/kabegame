/**
 * P6b 1d 的编译侧单测：文本对象进 `SceneLayer.text`（`compile/texts.ts`）与能力表（`features.ts` 的文本部分）。
 * - 字段规整（rea-p6b-layout 1.2、1.3：缺省值、`text` 只收字符串、枚举查不到取表里第一项、vec2 数字铺满）、主字体的位置；
 * - 四个宿主材质的 pass（键、渲染图填的槽 0、背景与 clearalpha 什么时候编）、背景色、`padding` 看启用的 effect；
 * - 绑定：运行中可改的排版键（`TEXT_RUNTIME_FIELDS`）登记成文本目标（P6b 1e），`font` / `opaquebackground` 等照旧重编译，
 *   `backgroundcolor` 在 LDR 下是背景常量的就地目标；
 * - 能力表：不再报 `object:text` / `object:font` 等，`text:script:<键>`、`text:msdf:<键>`、`text:anchor:<值>` 照规则报；运行中字段
 *   （`TEXT_RUNTIME_FIELDS`）挂脚本不报，`text:script` 键去掉（P6b 1e-3）；
 * - `SceneState`：文本 pass 的常量、背景常量、effect 开关走重编译；
 * - 有 WPE 时用真翻译器编 WPE 自带的四个材质（`font`、`flat`、`composelayer` 着色器），程序检查不报。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TEXT_RUNTIME_FIELDS } from "./bindings";
import { compileScene, type SceneBundle } from "./bundle";
import { checkObjectFeatures, checkTextOptions, isTextObject } from "./features";
import type { SceneReader } from "./fs";
import type { SceneObject } from "./model";
import { TEXT_MATERIALS, textFloat, textVec2 } from "./texts";
import { SceneState } from "../render/state";
import { Wpesl2wgsl, type TranslateRequest, type TranslateResult } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

const ORTHO = { orthogonalprojection: { width: 1920, height: 1080 } };
const ASSETS = "A:/assets";

/** WPE 自带的四个材质（`assets/materials/...` 原文的 pass 字段）。 */
const MATERIALS: Record<string, unknown> = {
  [`${ASSETS}/${TEXT_MATERIALS.glyphs}`]: {
    passes: [
      { shader: "font", blending: "translucent", depthtest: "disabled", depthwrite: "disabled", cullmode: "nocull" },
    ],
  },
  [`${ASSETS}/${TEXT_MATERIALS.color}`]: {
    passes: [
      {
        shader: "font",
        blending: "translucent",
        depthtest: "disabled",
        depthwrite: "disabled",
        cullmode: "nocull",
        combos: { COLORFONT: 1 },
      },
    ],
  },
  [`${ASSETS}/${TEXT_MATERIALS.background}`]: {
    passes: [
      { shader: "flat", blending: "translucent", depthtest: "disabled", depthwrite: "disabled", cullmode: "nocull" },
    ],
  },
  [`${ASSETS}/${TEXT_MATERIALS.clearAlpha}`]: {
    passes: [
      {
        shader: "composelayer",
        depthtest: "disabled",
        depthwrite: "disabled",
        blending: "normal",
        cullmode: "nocull",
        textures: ["_rt_FullFrameBuffer"],
        combos: { CLEARALPHA: 1 },
      },
    ],
  },
};
const SHADERS: Record<string, string> = Object.fromEntries(
  ["font", "flat", "composelayer", "kbfx"].flatMap((name) => [
    [`${ASSETS}/shaders/${name}.vert`, "void main(){}"],
    [`${ASSETS}/shaders/${name}.frag`, "void main(){}"],
  ]),
);

function memoryReader(files: Record<string, unknown>): SceneReader {
  const reader: SceneReader = {
    async readWhole(path) {
      const value = files[path.replace(/\\/g, "/")];
      if (value === undefined) throw new TypeError("Failed to fetch");
      if (value instanceof Uint8Array) return value;
      return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
    },
    async readRange(path, start, end) {
      return (await reader.readWhole(path)).slice(start, end);
    },
  };
  return reader;
}

/** 假翻译器：每次请求都记下来，回一个空程序。 */
function fakeTranslator() {
  const requests: TranslateRequest[] = [];
  const translator = {
    async translate(request: TranslateRequest): Promise<TranslateResult> {
      requests.push(request);
      return { ok: true, uniforms: [], textures: [], combos: [], attributes: [] } as unknown as TranslateResult;
    },
  } as unknown as Wpesl2wgsl;
  return { translator, requests };
}

/** 一个 effect（一个绘制 pass，着色器 kbfx）。 */
const KBFX: Record<string, unknown> = {
  "P:/p/effects/kbfx/effect.json": { passes: [{ material: "materials/kbfx.json" }] },
  "P:/p/materials/kbfx.json": { passes: [{ shader: "kbfx", textures: [null] }] },
};

interface CompileOptions {
  properties?: Record<string, { type?: string; value: unknown }>;
  extra?: Record<string, unknown>;
  general?: Record<string, unknown>;
  postprocess?: "disabled" | "ultra";
}

async function compile(objects: unknown[], options: CompileOptions = {}) {
  const { translator, requests } = fakeTranslator();
  const bundle = await compileScene({
    projectDir: "P:/p",
    sceneAssets: [ASSETS],
    reader: memoryReader({
      "P:/p/project.json": { file: "scene.json", general: { properties: options.properties ?? {} } },
      "P:/p/scene.json": { general: { ...ORTHO, ...options.general }, objects },
      ...MATERIALS,
      ...SHADERS,
      ...KBFX,
      ...options.extra,
    }),
    translator,
    postprocess: options.postprocess ?? "disabled",
    exhaustive: true,
  });
  return { bundle, requests };
}

const layerOf = (bundle: SceneBundle, object = 0) => bundle.layers.find((layer) => layer.object === object)!;

describe("能力表：文本对象", () => {
  const check = (object: SceneObject) => {
    const keys = new Set<string>();
    checkObjectFeatures(object, keys);
    return [...keys].sort();
  };

  it("文本对象：`text` 成员在就算（空串、对象值也算）；排版、背景、depthtest、装饰参数与 alignment 都不报", () => {
    expect(isTextObject({ text: "" })).toBe(true);
    expect(isTextObject({ text: { user: "t", value: "a" } })).toBe(true);
    expect(isTextObject({ image: "models/a.json", text: "x" })).toBe(false);
    expect(isTextObject({})).toBe(false);
    expect(
      check({
        text: "Ag",
        font: "fonts/RobotoMono-Regular.ttf",
        pointsize: 32,
        padding: "10 20",
        spacing: "1 2",
        maxwidth: 300,
        maxrows: 2,
        limitwidth: true,
        limitrows: true,
        limituseellipsis: true,
        blockalign: true,
        opaquebackground: true,
        horizontalalign: "left",
        verticalalign: "top",
        anchor: "none",
        depthtest: "enabled",
        backgroundcolor: "1 0 0",
        backgroundbrightness: 2,
        outlinethickness: 4,
        outlinecolor: "0 0 0",
        blursize: 6,
        dropshadowsize: 6,
        dropshadowopacity: 1,
        dropshadowoffset: "4 4",
        dropshadowcolor: "0 0 0",
        alignment: "topleft",
        size: "100 50",
        copybackground: false,
      }),
    ).toEqual([]);
  });

  it("运行中字段挂脚本不报（P6b 1e-3：12 个逐个）；其余文本键挂脚本报 text:script:<键>；图层字段的脚本照旧不报", () => {
    const script = (value: unknown) => ({ script: "export function update(value) { return value; }", value });
    const values: Record<(typeof TEXT_RUNTIME_FIELDS)[number], unknown> = {
      text: "x",
      pointsize: 3,
      padding: "1 1",
      spacing: "0 0",
      maxwidth: 300,
      maxrows: 2,
      limitwidth: true,
      limitrows: true,
      limituseellipsis: true,
      blockalign: true,
      horizontalalign: "left",
      verticalalign: "top",
    };
    for (const key of TEXT_RUNTIME_FIELDS) {
      expect(check({ text: "a", [key]: script(values[key]) }), key).toEqual([]);
    }
    // 全挂上也不报，不会冒出旧的 text:script
    expect(check(Object.fromEntries(TEXT_RUNTIME_FIELDS.map((key) => [key, script(values[key])])))).toEqual([]);
    // font / opaquebackground 运行中改要整场重编译（1e 已定 3），backgroundcolor 等没有脚本写回目标
    expect(check({ text: "a", font: script("fonts/a.ttf") })).toEqual(["text:script:font"]);
    expect(check({ text: "a", opaquebackground: script(true) })).toEqual(["text:script:opaquebackground"]);
    expect(check({ text: "a", backgroundcolor: script("1 0 0") })).toEqual(["text:script:backgroundcolor"]);
    expect(check({ text: script("a"), font: script("fonts/a.ttf"), outlinecolor: script("0 0 0") })).toEqual([
      "text:script:font",
      "text:script:outlinecolor",
    ]);
    expect(check({ text: "a", alpha: { script: "export function update() { return 1; }", value: 1 } })).toEqual([]);
  });

  it("生效值的开关与 anchor：MSDF 四个开关报 text:msdf:<键>，anchor 只放行 none / center", () => {
    const keys = (values: Partial<Parameters<typeof checkTextOptions>[0]>) => {
      const out = new Set<string>();
      checkTextOptions({ msdf: false, outline: false, blur: false, dropshadow: false, anchor: "none", ...values }, out);
      return [...out].sort();
    };
    expect(keys({})).toEqual([]);
    expect(keys({ anchor: "center" })).toEqual([]);
    expect(keys({ anchor: "topleft" })).toEqual(["text:anchor:topleft"]);
    expect(keys({ outline: true, dropshadow: true })).toEqual(["text:msdf:dropshadow", "text:msdf:outline"]);
  });

  it("取值规则：float 收数字与数字串，vec2 一个分量铺满", () => {
    expect(textFloat("12.5", 32)).toBe(12.5);
    expect(textFloat("abc", 32)).toBe(32);
    expect(textFloat(true, 32)).toBe(1);
    expect(textVec2(10, [32, 32])).toEqual([10, 10]);
    expect(textVec2("10 20", [32, 32])).toEqual([10, 20]);
    expect(textVec2("7", [32, 32])).toEqual([7, 7]);
    expect(textVec2(null, [32, 32])).toEqual([32, 32]);
  });
});

describe("compileScene：文本表", () => {
  it("缺省对象：字段取 WPE 缺省值，主字体 systemfont_arial（位置为空，宿主读系统字体），不报 object:*", async () => {
    const { bundle } = await compile([{ id: 3, name: "clock", text: "12:34", origin: "960 540 0" }]);
    expect(bundle.unsupported).toEqual([]);
    const layer = layerOf(bundle);
    expect(layer.passes).toEqual([]);
    expect(layer.text?.fields).toEqual({
      text: "12:34",
      font: "systemfont_arial",
      pointsize: 32,
      padding: [32, 32],
      spacing: [0, 0],
      maxwidth: 500,
      maxrows: 1,
      limitwidth: false,
      limitrows: false,
      limituseellipsis: false,
      blockalign: false,
      opaquebackground: false,
      horizontalalign: "center",
      verticalalign: "center",
      visibleEffects: 0,
      colorBlendMode: 0,
    });
    expect(layer.text?.font).toEqual({ path: "system:arial.ttf", location: null, size: null });
  });

  it("字段规整：非字符串的 text 当空串、font 保持缺省；枚举查不到取第一项（left / center）；对象值取 value", async () => {
    const { bundle } = await compile([
      {
        text: 5,
        font: 7,
        pointsize: "20",
        padding: 8,
        spacing: "2 3",
        maxwidth: { value: 300 },
        maxrows: 2.7,
        limitwidth: true,
        limitrows: { value: true },
        horizontalalign: "foo",
        verticalalign: 3,
      },
      { text: { value: "abc" }, horizontalalign: "right", verticalalign: "top" },
    ]);
    expect(layerOf(bundle, 0).text?.fields).toMatchObject({
      text: "",
      font: "systemfont_arial",
      pointsize: 20,
      padding: [8, 8],
      spacing: [2, 3],
      maxwidth: 300,
      maxrows: 2,
      limitwidth: true,
      limitrows: true,
      horizontalalign: "left",
      verticalalign: "center",
    });
    expect(layerOf(bundle, 1).text?.fields).toMatchObject({
      text: "abc",
      horizontalalign: "right",
      verticalalign: "top",
    });
  });

  it("主字体：工程散文件定位到文件本身；WPE assets 里的也一样；找不到的位置为空（排版换 arial）", async () => {
    const { bundle } = await compile(
      [
        { text: "a", font: "fonts/mine.ttf" },
        { text: "b", font: "fonts/RobotoMono-Regular.ttf" },
        { text: "c", font: "fonts/missing.ttf" },
        { text: "d", font: "systemfont_cambria" },
      ],
      { extra: { "P:/p/fonts/mine.ttf": "ttf", [`${ASSETS}/fonts/RobotoMono-Regular.ttf`]: "ttf" } },
    );
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.layers.map((layer) => layer.text?.font)).toEqual([
      { path: "fonts/mine.ttf", location: { path: "P:/p\\fonts\\mine.ttf", offset: 0 }, size: null },
      {
        path: "fonts/RobotoMono-Regular.ttf",
        location: { path: "A:/assets\\fonts\\RobotoMono-Regular.ttf", offset: 0 },
        size: null,
      },
      { path: "fonts/missing.ttf", location: null, size: null },
      { path: "system:cambria.ttc", location: null, size: null },
    ]);
  });

  it("宿主材质：字形与彩色字形总编，槽 0 由渲染图填（R8 图集格式 9）；没 effect、没背景时不编背景与 clearalpha", async () => {
    const { bundle, requests } = await compile([{ text: "a" }]);
    const text = layerOf(bundle).text!;
    expect([text.glyphPass.key, text.colorPass.key]).toEqual(["objects/0/text/glyphs", "objects/0/text/color"]);
    expect([text.backgroundPass, text.clearAlphaPass]).toEqual([null, null]);
    expect(text.glyphPass).toMatchObject({ blending: "translucent", textures: {}, runtime: {}, framebuffer: false });
    // 着色器请求：字形带槽 0 的 R8 格式，彩色字形带 COLORFONT
    const fonts = requests.filter((request) => request.vertex === "void main(){}");
    expect(fonts.map((request) => [request.combos, request.textures])).toEqual([
      [{}, [{ slot: 0, format: 9 }]],
      [{ COLORFONT: 1 }, [{ slot: 0 }]],
    ]);
  });

  it("开背景：编 fontbackground，g_Color 是背景色（材质值）；带 effect 没开背景：编 clearalpha（槽 0 是快照），padding 计数 1", async () => {
    const { bundle } = await compile([
      { text: "a", opaquebackground: true, backgroundcolor: "1 0.5 0", backgroundbrightness: 3 },
      { text: "b", effects: [{ file: "effects/kbfx/effect.json" }] },
      { text: "c", effects: [{ file: "effects/kbfx/effect.json", visible: false }] },
    ]);
    expect(bundle.unsupported).toEqual([]);
    const bg = layerOf(bundle, 0).text!;
    // LDR：backgroundbrightness 不乘（rea-p6b-layout 4）
    expect(bg.background).toEqual({ key: "objects/0/text/background", color: [1, 0.5, 0] });
    expect(bg.backgroundPass).toMatchObject({ key: "objects/0/text/background", uniforms: { g_Color: [1, 0.5, 0] } });
    expect(bg.clearAlphaPass).toBeNull();
    const fx = layerOf(bundle, 1);
    expect(fx.effects.map((effect) => effect.enabled)).toEqual([true]);
    expect(fx.text!.fields.visibleEffects).toBe(1);
    expect(fx.text!.clearAlphaPass).toMatchObject({
      key: "objects/1/text/clearalpha",
      runtime: { 0: "_rt_FullFrameBuffer" },
      framebuffer: true,
      blending: "normal",
    });
    // 写死关闭的 effect 不进 bundle（B11），不算可见、也不可能合成
    expect(layerOf(bundle, 2).text!.fields.visibleEffects).toBe(0);
    expect(layerOf(bundle, 2).text!.clearAlphaPass).toBeNull();
  });

  it("colorBlendMode 2：passthrough 照图层编，文本走合成（clearalpha），colorBlendMode 进字段", async () => {
    const { bundle } = await compile([{ text: "a", colorBlendMode: 2 }], {
      extra: {
        [`${ASSETS}/materials/util/effectpassthrough.json`]: { passes: [{ shader: "kbfx" }] },
      },
    });
    const layer = layerOf(bundle);
    expect(layer.passthrough?.key).toBe("objects/0/passthrough");
    expect(layer.text?.fields.colorBlendMode).toBe(2);
    expect(layer.text?.clearAlphaPass?.key).toBe("objects/0/text/clearalpha");
  });

  it("绑定：运行中可改的排版键绑属性登记成文本目标（P6b 1e）；backgroundcolor 在 LDR 下是背景常量 g_Color 的就地目标", async () => {
    const { bundle } = await compile(
      [
        {
          text: { user: "label", value: "x" },
          pointsize: { user: "size", value: 10 },
          backgroundcolor: { user: "bg", value: "0 0 0" },
          opaquebackground: true,
        },
      ],
      { properties: { label: { value: "hello" }, size: { value: 48 }, bg: { value: "0 1 0" } } },
    );
    const text = layerOf(bundle).text!;
    expect(text.fields.text).toBe("hello");
    expect(text.fields.pointsize).toBe(48);
    expect(text.background.color).toEqual([0, 1, 0]);
    expect(bundle.bindings.map((binding) => [binding.property, binding.target])).toEqual([
      // 1d 是 recompile（layer-structure）；1e-2 起就地重排
      ["label", { kind: "text", object: 0, field: "text" }],
      ["size", { kind: "text", object: 0, field: "pointsize" }],
      [
        "bg",
        {
          kind: "constant",
          pass: "objects/0/text/background",
          material: "backgroundcolor",
          uniforms: ["g_Color"],
          type: "vec3",
        },
      ],
    ]);
  });

  it("绑定：14 个字段逐个绑属性——TEXT_RUNTIME_FIELDS 的 12 个是文本目标，font、opaquebackground 与 MSDF、anchor、HDR 背景亮度照旧重编译（P6b 1e）", async () => {
    const keys = [
      "text",
      "font",
      "pointsize",
      "padding",
      "spacing",
      "maxwidth",
      "maxrows",
      "limitwidth",
      "limitrows",
      "limituseellipsis",
      "blockalign",
      "opaquebackground",
      "horizontalalign",
      "verticalalign",
      "msdf",
      "anchor",
    ];
    const object = Object.fromEntries(keys.map((key) => [key, { user: `p_${key}`, value: undefined }]));
    const { bundle } = await compile([{ ...object, text: { user: "p_text", value: "x" } }], { properties: {} });
    const targets = Object.fromEntries(bundle.bindings.map((binding) => [binding.property, binding.target]));
    for (const key of keys) {
      const runtime = (TEXT_RUNTIME_FIELDS as readonly string[]).includes(key);
      expect(targets[`p_${key}`], key).toEqual(
        runtime
          ? { kind: "text", object: 0, field: key }
          : { kind: "recompile", reason: "layer-structure", path: `objects/0/${key}` },
      );
    }
    expect(TEXT_RUNTIME_FIELDS).toHaveLength(12);
  });

  it("能力：MSDF 开关与 anchor 按当前属性值报；text 挂脚本不报（P6b 1e-3），font 挂脚本报 text:script:font", async () => {
    const { bundle } = await compile(
      [
        { text: "a", outline: { user: "edge", value: false } },
        { text: "b", anchor: "topleft" },
        { text: "c", anchor: "nowhere", msdf: true },
        { text: { script: "export function update() { return 'x'; }", value: "x" } },
        { text: "d", font: { script: "export function update() { return 'fonts/a.ttf'; }", value: "fonts/a.ttf" } },
      ],
      { properties: { edge: { value: true } } },
    );
    expect(bundle.unsupported).toEqual([
      "text:anchor:topleft",
      "text:msdf:msdf",
      "text:msdf:outline",
      "text:script:font",
    ]);
    expect(bundle.bindings.map((binding) => binding.target)).toContainEqual({
      kind: "recompile",
      reason: "layer-structure",
      path: "objects/0/outline",
    });
  });

  it("SceneState：文本 pass 与背景常量登记进常量表；文本层的 effect 开关走重编译", async () => {
    const { bundle } = await compile([
      { text: "a", effects: [{ file: "effects/kbfx/effect.json", visible: { user: "fx", value: true } }] },
      { text: "b", opaquebackground: true, backgroundcolor: "0 0 1" },
    ]);
    const state = SceneState.fromBundle(bundle);
    expect(state.constants.has("objects/0/text/glyphs")).toBe(true);
    expect(state.constants.has("objects/0/text/clearalpha")).toBe(true);
    // 没开背景的层也有一份背景常量（合成路径清屏读它）
    expect(state.constants.get("objects/0/text/background")).toEqual({ g_Color: [0, 0, 0] });
    expect(state.constants.get("objects/1/text/background")).toEqual({ g_Color: [0, 0, 1] });
    const effect = { property: "fx", target: { kind: "effect", object: 0, effect: 0 } } as const;
    expect(state.needsRecompile(effect, false)).toBe(true);
    expect(state.write(effect, false)).toBe("recompile");
  });
});

// ———— 有 WPE：真翻译器编 WPE 自带的四个材质 ————

const root = process.env.KABEGAME_WPE_ROOT;
const wasm = join(__dirname, "..", "wpesl2wgsl", "wpesl2wgsl.wasm");

describe.skipIf(!root || !existsSync(wasm))("真翻译器：WPE 自带的字体、背景与 clearalpha 材质", () => {
  it("四个 pass 都翻译成功、程序检查不报；字形程序有 a_Position / a_TexCoord 与槽 0，背景程序有 g_Color / g_Alpha", async () => {
    const translator = await Wpesl2wgsl.fromBytes(readFileSync(wasm));
    const files: Record<string, unknown> = {
      "P:/p/project.json": { file: "scene.json" },
      "P:/p/scene.json": {
        general: ORTHO,
        objects: [
          { text: "a", opaquebackground: true },
          { text: "b", effects: [{ file: "effects/tint/effect.json" }] },
        ],
      },
    };
    const reader: SceneReader = {
      async readWhole(path) {
        const key = path.replace(/\\/g, "/");
        if (key in files) return new TextEncoder().encode(JSON.stringify(files[key]));
        try {
          return new Uint8Array(readFileSync(path));
        } catch {
          throw new TypeError("Failed to fetch");
        }
      },
      async readRange(path, start, end) {
        return (await reader.readWhole(path)).slice(start, end);
      },
    };
    const bundle = await compileScene({
      projectDir: "P:/p",
      sceneAssets: [join(root!, "assets")],
      reader,
      translator,
      postprocess: "disabled",
      exhaustive: true,
    });
    expect(bundle.unsupported).toEqual([]);
    const plain = bundle.layers[0].text!;
    const fx = bundle.layers[1].text!;
    const programOf = (index: number | null) => bundle.programs[index!];
    for (const pass of [plain.glyphPass, plain.colorPass, plain.backgroundPass!, fx.clearAlphaPass!])
      expect(pass.program, pass.key).not.toBeNull();
    const font = programOf(plain.glyphPass.program);
    expect(font.attributes?.map((attribute) => attribute.name).sort()).toEqual(["a_Position", "a_TexCoord"]);
    expect(font.textures?.find((texture) => texture.slot === 0)).toBeTruthy();
    const used = (index: number | null) =>
      (programOf(index).uniforms ?? []).filter((uniform) => !uniform.unused).map((uniform) => uniform.name);
    expect(used(plain.glyphPass.program)).toEqual(expect.arrayContaining(["g_ModelViewProjectionMatrix", "g_Color4"]));
    expect(used(plain.backgroundPass!.program)).toEqual(
      expect.arrayContaining(["g_ModelViewProjectionMatrix", "g_Color", "g_Alpha"]),
    );
    // 同一个 font 着色器、两组 COMBO：两个程序；两层的字形共用一个
    expect(fx.glyphPass.program).toBe(plain.glyphPass.program);
    expect(plain.colorPass.program).not.toBe(plain.glyphPass.program);
  }, 60000);
});
