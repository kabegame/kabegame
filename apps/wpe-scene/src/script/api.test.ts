import { describe, expect, it, vi } from "vitest";
import { SceneSpectrum } from "../audio/spectrum";
import { GENERAL_FIELDS, generalDefaults, type GeneralKey } from "../compile/bindings";
import type { SceneBundle, SceneEffect, SceneLayer, ScenePass, SceneTexture } from "../compile/bundle";
import { parseParticleInstance, type SceneParticle } from "../compile/particles";
import { BLOOM_FIELDS } from "../compile/postprocess";
import {
  MISSING_SCRIPT_API,
  MISSING_SCRIPT_CALLBACKS,
  WPE_SCRIPT_CALLBACKS,
  type ScriptApiGroup,
} from "../compile/scriptApi";
import { collectScripts, type SceneScript } from "../compile/scripts";
import type { CursorInputSnapshot } from "../render/cursor";
import { SceneState, scriptWriteValue } from "../render/state";
import { TEXT_DEFAULTS } from "../text/fields";
import {
  createWpeLocalStorage,
  ScriptApi,
  type ParticleScriptTarget,
  type SoundScriptTarget,
  type VideoScriptTarget,
} from "./api";
import { writeScriptState } from "./stateWrite";
import { alignScriptEnvironment } from "./environment";
import { RUNTIME_CALLBACKS, ScriptRuntime, type ScriptRealm } from "./runtime";
import { createMemoryStorage } from "./storage";

class Vec2 {
  constructor(
    public x: number,
    public y: number,
  ) {}
}
class Vec3 {
  constructor(
    public x: number,
    public y: number,
    public z: number,
  ) {}
}
class Vec4 {
  constructor(
    public x: number,
    public y: number,
    public z: number,
    public w: number,
  ) {}
}

class FakeRealm implements ScriptRealm {
  global: Record<string, unknown> = { Object, Array, JSON, Float32Array };
  prototypes = { Vec2: Vec2.prototype, Vec3: Vec3.prototype, Vec4: Vec4.prototype, Mat3: {}, Mat4: {} };
  internal = {
    updateScriptProperties() {},
    convertUserProperties: (json: string) =>
      Object.fromEntries(
        Object.entries(JSON.parse(json) as Record<string, { type: string; value: unknown }>).map(([key, item]) => [
          key,
          item.type === "color"
            ? new Vec3(...(String(item.value).split(" ").map(Number) as [number, number, number]))
            : item.value,
        ]),
      ),
  };
  modules = new Map<string, Record<string, unknown>>();
  async importModule(_source: string, label: string): Promise<Record<string, unknown>> {
    return this.modules.get(label) ?? {};
  }
  dispose() {}
}

/**
 * `sound`：多一个声音对象的图层（objects 下标 2，名字 Music，声音表里 volume 0.5）。`particle`：多一个粒子对象的图层（objects 下标 3，
 * 名字 Sparks，P4f 步骤 3），实例覆盖是缺省值（控制点都没设）。`text`：多一个文本层（objects 下标 4，名字 Label，P6b 步骤 2），
 * 文字 "abc"、`pointsize` 32、`padding` 32（同 WPE 实测 p6b-api 的 s3）。
 */
function scene(sound = false, particle = false, text: boolean | "hdr" = false): SceneBundle {
  const layer = (object: number, name: string): SceneLayer => ({
    id: object + 10,
    object,
    parent: null,
    name,
    origin: [1, 2, 3],
    scale: [1, 1, 1],
    angles: [Math.PI, 0, 0],
    size: [100, 200],
    alpha: 1,
    color: [1, 1, 1],
    brightness: 1,
    visible: true,
    visibleBound: false,
    parallaxDepth: [1, 1],
    solidLayer: false,
    instanced: false,
    noPadding: false,
    perspective: false,
    passthroughModel: false,
    group: null,
    subtree: [],
    groupUpload: null,
    copyBackground: true,
    clampUVs: true,
    noInterpolation: false,
    fullscreen: false,
    fullscreenSize: null,
    passes: [],
    colorBlendMode: 0,
    effects: [],
    passthrough: null,
    particle: null,
  });
  return {
    general: {
      width: 1920,
      height: 1080,
      fields: generalDefaults(),
      clearVariable: false,
      perspectiveOverrideFov: (95 * Math.PI) / 180,
      postprocess: { level: "enabled", bloomFlag: true, hdrFlag: false, bloom: true, hdr: false },
      bloom: {
        strength: 1,
        threshold: 0.5,
        tint: [1, 1, 1],
        hdrStrength: 1,
        hdrThreshold: 0.5,
        hdrFeather: 1,
        hdrScatter: 1,
        hdrIterations: 4,
      },
    },
    layers: [
      layer(0, "First"),
      layer(1, "Second"),
      ...(sound ? [layer(2, "Music")] : []),
      ...(particle
        ? [
            {
              ...layer(3, "Sparks"),
              particle: {
                instance: parseParticleInstance(undefined),
                passes: [],
                children: [],
              } as unknown as SceneParticle,
            },
          ]
        : []),
      ...(text
        ? [
            {
              ...layer(4, "Label"),
              text: {
                fields: { ...TEXT_DEFAULTS, text: "abc", pointsize: 32, padding: [32, 32], spacing: [0, 0] },
                glyphPass: { key: "objects/4/text/glyphs", program: null, uniforms: {} },
                colorPass: { key: "objects/4/text/color", program: null, uniforms: {} },
                backgroundPass: null,
                clearAlphaPass: null,
                background: { key: "objects/4/text/background", color: [0, 0, 0] },
                // 非运行中字段（点 5）：LDR 下 backgroundcolor 就地写背景常量；"hdr"（亮度不为 1）时重编译
                script: {
                  anchor: "none",
                  backgroundcolor: [0, 0, 0],
                  backgroundbrightness: 1,
                  backgroundTarget:
                    text === "hdr"
                      ? { kind: "recompile", reason: "layer-structure", path: "objects/4/backgroundcolor" }
                      : {
                          kind: "constant",
                          pass: "objects/4/text/background",
                          material: "backgroundcolor",
                          uniforms: ["g_Color"],
                          type: "vec3",
                        },
                },
              } as unknown as SceneLayer["text"],
            },
          ]
        : []),
    ],
    programs: [],
    textures: [],
    bloom: null,
    unsupported: [],
    bindings: [],
    scripts: { list: [] },
    ...(sound
      ? {
          sounds: [{ object: 2, files: [], mode: "loop", mintime: 1, maxtime: 5, startSilent: false, volume: 0.5 }],
        }
      : {}),
  } as SceneBundle;
}

function script(id: string, owner: SceneScript["owner"], layer: number | null): SceneScript {
  return {
    id,
    source: "",
    target: { kind: "layer", object: 0, field: "alpha" },
    valueType: "float",
    initial: 1,
    owner,
    layer,
    scriptProperties: null,
    imports: [],
    errors: [],
  };
}

/**
 * `sound`：场景带声音层（`scene(true)`），`target` 是宿主交给声音层方法的排期器（null = 没有播放器）。`particle`：场景带粒子层
 * （objects 下标 3，P4f 步骤 3），`target` 是宿主交给粒子层方法的根系统落点（null = 没有场景）。
 */
function setup(
  audioRegistered?: () => void,
  sound?: { target: SoundScriptTarget | null },
  particle?: { target: ParticleScriptTarget | null },
  text: boolean | "hdr" = false,
) {
  const realm = new FakeRealm();
  let bundle = scene(!!sound, !!particle, text);
  let state = SceneState.fromBundle(bundle);
  let resolution: [number, number] = [800, 600];
  /** 全局 `input` 读到的光标快照（P6c）：测试里直接改它。 */
  const cursor: CursorInputSnapshot = { world: [0, 0, 0], screen: [0, 0], leftDown: false };
  const recompiles: { path: string; value: number[] | boolean | string }[] = [];
  const api = new ScriptApi(realm, {
    bundle: () => bundle,
    state: () => state,
    screenResolution: () => resolution,
    frametime: () => 0.016,
    runtime: () => 12,
    timeOfDay: () => 0.25,
    write(target, value) {
      if (target.kind === "recompile") {
        recompiles.push({ path: target.path, value });
        return true;
      }
      if (target.kind === "unsupported" || target.kind === "script-property") return false;
      // 文本字段走宿主同一条路径（`writeScriptState`：脚本侧规整，不是属性侧）
      if (target.kind === "text") return writeScriptState(state, target, value) === "applied";
      state.write({ property: "test", target }, scriptWriteValue(value));
      return true;
    },
    audioRegistered,
    cursorInput: () => cursor,
    ...(sound ? { sound: (object: number) => (object === 2 ? sound.target : null) } : {}),
    ...(particle ? { particles: (object: number) => (object === 3 ? particle.target : null) } : {}),
  });
  return {
    realm,
    api,
    recompiles,
    cursor,
    get bundle() {
      return bundle;
    },
    get state() {
      return state;
    },
    recompile() {
      bundle = scene(!!sound, !!particle, text);
      state = SceneState.fromBundle(bundle);
    },
    resetState() {
      state = SceneState.fromBundle(bundle);
    },
    setResolution(value: [number, number]) {
      resolution = value;
    },
  };
}

/** `ITextLayer` 的 12 个运行中字段（非文本层上都没有）。 */
const TEXT_FIELD_NAMES = [
  "text",
  "pointsize",
  "padding",
  "spacing",
  "maxwidth",
  "maxrows",
  "limitwidth",
  "limitrows",
  "limituseellipsis",
  "blockalign",
  "horizontalalign",
  "verticalalign",
  "font",
  "opaquebackground",
  "backgroundcolor",
  "backgroundbrightness",
  "anchor",
];

describe("SceneScript API（FakeRealm）", () => {
  it("engine 取值、作用域和用户属性全集缓存", () => {
    const h = setup();
    const engine = h.api.engine;
    h.api.setModuleEvaluating(true);
    for (const key of ["frametime", "runtime", "timeOfDay", "canvasSize", "screenResolution", "userProperties"])
      expect(() => engine[key]).toThrow("模块求值期间");
    for (const name of ["setTimeout", "setInterval", "clearTimeout", "isPortrait", "isLandscape"])
      expect(() => (engine[name] as () => unknown)()).toThrow("模块求值期间");
    for (const name of ["getLayer", "getLayerCount", "enumerateLayers", "getLayerIndex"])
      expect(() => (h.api.thisScene[name] as () => unknown)()).toThrow("模块求值期间");
    h.api.setModuleEvaluating(false);
    expect(engine.frametime).toBe(0.016);
    expect(engine.runtime).toBe(12);
    expect(engine.timeOfDay).toBe(0.25);
    expect(engine.canvasSize).toEqual(new Vec2(1920, 1080));
    expect(engine.screenResolution).toEqual(new Vec2(800, 600));
    expect((engine.isLandscape as () => boolean)()).toBe(true);
    h.setResolution([600, 800]);
    expect((engine.isPortrait as () => boolean)()).toBe(true);
    expect((engine.isLandscape as () => boolean)()).toBe(false);
    expect((engine.isRunningInEditor as () => boolean)()).toBe(false);
    expect((engine.isDesktopDevice as () => boolean)()).toBe(true);
    expect((engine.isMobileDevice as () => boolean)()).toBe(false);
    expect((engine.isWallpaper as () => boolean)()).toBe(true);
    expect((engine.isScreensaver as () => boolean)()).toBe(false);
    h.api.setProperties(
      new Map([
        ["tint", { type: "color", value: "1 0 0" }],
        ["speed", { type: "slider", value: 2 }],
      ]),
    );
    const first = engine.userProperties as Record<string, unknown>;
    expect(first).toEqual({ tint: new Vec3(1, 0, 0), speed: 2 });
    expect(engine.userProperties).toBe(first);
    h.api.setProperties(
      new Map([
        ["tint", { type: "color", value: "0 1 0" }],
        ["speed", { type: "slider", value: 2 }],
      ]),
    );
    expect(engine.userProperties).not.toBe(first);
    expect(engine.userProperties).toEqual({ tint: new Vec3(0, 1, 0), speed: 2 });
    for (const name of ["registerAsset", "openUserShortcut", "requestFeatures"])
      expect(() => (engine[name] as () => void)()).toThrow(TypeError);
    // `input`（P6c）已装上：成员见下面的「光标交互」一节
    expect(h.realm.global.input).toBeDefined();
  });

  it("图层查询、对象身份、向量复制、角度和只读 size", () => {
    const h = setup();
    const scene = h.api.thisScene;
    const getLayer = scene.getLayer as (name: string | number) => Record<string, unknown> | null;
    const first = getLayer(0)!;
    expect(getLayer("First")).toBe(first);
    expect(getLayer(2)).toBeNull();
    expect(getLayer("missing")).toBeNull();
    expect((scene.getLayerCount as () => number)()).toBe(2);
    expect((scene.enumerateLayers as () => unknown[])()).toEqual([first, getLayer(1)]);
    expect((scene.getLayerIndex as (value: unknown) => number)(first)).toBe(0);
    expect((scene.getLayerIndex as (value: unknown) => number)("Second")).toBe(1);
    expect((scene.getLayerIndex as (value: unknown) => number)({})).toBe(-1);
    expect((h.api.engine.isObjectValid as (value: unknown) => boolean)(first)).toBe(true);
    expect((h.api.engine.isObjectValid as (value: unknown) => boolean)({})).toBe(false);
    expect(first.name).toBe("First");
    expect(first.id).toBe(10);
    expect(first.origin).toBeInstanceOf(Vec3);
    (first.origin as Vec3).x = 9;
    expect(h.state.layers.get(0)?.origin).toEqual([1, 2, 3]);
    first.origin = new Vec3(4, 5, 6);
    expect(h.state.layers.get(0)?.origin).toEqual([4, 5, 6]);
    expect((first.angles as Vec3).x).toBeCloseTo(180);
    first.angles = new Vec3(90, 0, 0);
    expect(h.state.layers.get(0)?.angles[0]).toBeCloseTo(Math.PI / 2);
    first.size = new Vec2(3, 4);
    expect(first.size).toEqual(new Vec2(100, 200));
    first.alpha = 0.4;
    first.color = new Vec3(0, 0.5, 1);
    first.visible = false;
    first.brightness = 2;
    expect(h.state.layers.get(0)).toMatchObject({ alpha: 0.4, color: [0, 0.5, 1], visible: false, brightness: 2 });
    h.recompile();
    expect(getLayer(0)).toBe(first);
    expect((h.api.engine.isObjectValid as (value: unknown) => boolean)(first)).toBe(true);
  });

  describe("图层字段、size、材质常量按 WPE 取单精度（P3b 补测，期望值照 WPE 实测 ignore/p3b-f32）", () => {
    it("每类字段读出 f32、状态照旧存 double；从别的图层读也一样", () => {
      const h = setup();
      const getLayer = h.api.thisScene.getLayer as (name: string) => Record<string, unknown>;
      const first = getLayer("First");
      first.origin = new Vec3(100.1, 200.2, 300.3);
      first.scale = new Vec3(1.7, 0.3, 2.9);
      first.color = new Vec3(0.3, 0.7, 0.1);
      first.alpha = 0.3;
      first.brightness = 1.7;
      first.parallaxDepth = new Vec2(0.3, 1.7);
      h.state.layers.get(0)!.angles = [0.0501731, 0.0513848, 0.0555392];
      h.bundle.layers[0].size = [80.3, 60.7];
      // 存储不动：状态里仍是 double
      expect(h.state.layers.get(0)).toMatchObject({
        origin: [100.1, 200.2, 300.3],
        scale: [1.7, 0.3, 2.9],
        color: [0.3, 0.7, 0.1],
        alpha: 0.3,
        brightness: 1.7,
        parallaxDepth: [0.3, 1.7],
      });
      // `P.read` 一行：thisLayer 与 getLayer('A') 读到的都是这些（同一个图层对象，读取不看当前是哪段脚本）
      h.api.enterScript(script("other", { kind: "layer", object: 1 }, 1));
      expect(first.origin).toEqual(new Vec3(100.0999984741211, 200.1999969482422, 300.29998779296875));
      expect(first.scale).toEqual(new Vec3(1.7000000476837158, 0.30000001192092896, 2.9000000953674316));
      expect(first.color).toEqual(new Vec3(0.30000001192092896, 0.699999988079071, 0.10000000149011612));
      expect(first.alpha).toBe(0.30000001192092896);
      expect(first.brightness).toBe(1.7000000476837158);
      expect(first.parallaxDepth).toEqual(new Vec2(0.30000001192092896, 1.7000000476837158));
      expect(first.size).toEqual(new Vec2(80.30000305175781, 60.70000076293945));
      // 角度：f32(f32(弧度) × f32(57.29578))；double 的「弧度 / 0.017453292」是 2.8747069607269506 2.944132258831171 3.1821618523313537
      expect(first.angles).toEqual(new Vec3(2.874706983566284, 2.944132089614868, 3.182161808013916));
      expect(first.visible).toBe(true);
      h.api.enterScript(script("self", { kind: "layer", object: 0 }, 0));
      expect(h.realm.global.thisLayer).toBe(first);
      expect((h.realm.global.thisLayer as Record<string, unknown>).origin).toEqual(
        new Vec3(100.0999984741211, 200.1999969482422, 300.29998779296875),
      );
    });

    it("角度写回按 f32 乘法换成弧度，同帧读回与 WPE 相同（E / G / F 三组）", () => {
      const h = setup();
      const first = (h.api.thisScene.getLayer as (name: string) => Record<string, unknown>)("First");
      const cases: [number[], number[]][] = [
        [
          [60.1939, 115.6584, 236.4931],
          [60.193904876708984, 115.65840911865234, 236.4931182861328],
        ],
        [
          [6.4317, 112.9374, 0.8652],
          [6.431700229644775, 112.93740844726562, 0.8651999831199646],
        ],
        [
          [125.5641, 237.1609, 246.6956],
          [125.5641098022461, 237.16091918945312, 246.69561767578125],
        ],
      ];
      for (const [write, read] of cases) {
        first.angles = new Vec3(write[0], write[1], write[2]);
        // 交给宿主的弧度是 f32 能精确表示的值
        for (const part of h.state.layers.get(0)!.angles) expect(Math.fround(part)).toBe(part);
        expect(first.angles).toEqual(new Vec3(read[0], read[1], read[2]));
      }
    });

    it("经 thisLayer 读 → 改 → 写回累加 12 帧，逐帧值与 WPE 相同（C.api）", () => {
      const h = setup();
      const first = (h.api.thisScene.getLayer as (name: string) => Record<string, unknown>)("First");
      first.origin = new Vec3(900.1, 300.3, 0);
      h.state.layers.get(0)!.angles = [0, 0, 0.0555392];
      const xs: number[] = [];
      const zs: number[] = [];
      for (let frame = 0; frame < 12; frame++) {
        const origin = first.origin as Vec3;
        const angles = first.angles as Vec3;
        xs.push(origin.x);
        zs.push(angles.z);
        origin.x += 0.1;
        first.origin = origin;
        angles.z += 0.7;
        first.angles = angles;
      }
      expect(xs).toEqual([
        900.0999755859375, 900.199951171875, 900.2999267578125, 900.39990234375, 900.4998779296875, 900.599853515625,
        900.6998291015625, 900.7998046875, 900.8997802734375, 900.999755859375, 901.0997314453125, 901.19970703125,
      ]);
      expect(zs).toEqual([
        3.182161808013916, 3.882161855697632, 4.582161903381348, 5.282161712646484, 5.982161521911621,
        6.682161331176758, 7.382160663604736, 8.082160949707031, 8.782160758972168, 9.482160568237305,
        10.182160377502441, 10.882160186767578,
      ]);
    });

    it("材质对象 thisObject.<键> 读出 f32（A.mat）", () => {
      const h = setup();
      h.bundle.layers[0].passes.push({
        key: "objects/0/passes/0",
        program: 0,
        blending: "normal",
        cullmode: "none",
        depthtest: "disabled",
        depthwrite: "disabled",
        textures: {},
        runtime: {},
        uniforms: {},
        framebuffer: false,
      });
      h.bundle.programs.push({
        uniforms: [
          { name: "g_TintColor", type: "vec3<f32>", meta: { material: "color" } },
          { name: "g_BlendAlpha", type: "f32", meta: { material: "alpha" } },
        ],
      } as unknown as SceneBundle["programs"][number]);
      h.state.constants.set("objects/0/passes/0", { g_TintColor: [0.3, 0.7, 0.1], g_BlendAlpha: [0.3] });
      h.api.enterScript(script("mat", { kind: "material", pass: "objects/0/passes/0", layer: 0 }, 0));
      const owner = h.realm.global.thisObject as Record<string, unknown>;
      expect(owner.alpha).toBe(0.30000001192092896);
      expect(owner.color).toEqual(new Vec3(0.30000001192092896, 0.699999988079071, 0.10000000149011612));
      expect(h.state.constants.get("objects/0/passes/0")).toEqual({
        g_TintColor: [0.3, 0.7, 0.1],
        g_BlendAlpha: [0.3],
      });
    });
  });

  describe("文本层（P6b 步骤 2，ITextLayer；期望值照 WPE 实测 p6b-api / p6b-api-enum）", () => {
    type TextLayer = Record<string, unknown>;
    const open = (initial: Partial<Record<string, unknown>> = {}, text: boolean | "hdr" = true) => {
      const h = setup(undefined, undefined, undefined, text);
      Object.assign(h.state.textFields.get(4)!, initial);
      const layer = (h.api.thisScene.getLayer as (name: string) => TextLayer)("Label");
      return { h, layer };
    };
    /** 在新状态上写一次 `field = value`，返回读回的值。 */
    const written = (field: string, value: unknown, initial: Partial<Record<string, unknown>> = {}) => {
      const { layer } = open(initial);
      layer[field] = value;
      return layer[field];
    };

    it("读：字符串 / f32 数字 / Vec2 / 布尔 / 枚举名", () => {
      const { layer } = open();
      expect(layer.text).toBe("abc");
      expect(layer.pointsize).toBe(32);
      expect(layer.padding).toEqual(new Vec2(32, 32));
      expect(layer.padding).toBeInstanceOf(Vec2);
      expect(layer.spacing).toEqual(new Vec2(0, 0));
      expect(layer.maxwidth).toBe(500);
      expect(layer.maxrows).toBe(1);
      for (const field of ["limitwidth", "limitrows", "limituseellipsis", "blockalign"])
        expect(layer[field], field).toBe(false);
      expect(layer.horizontalalign).toBe("center");
      expect(layer.verticalalign).toBe("center");
    });

    it("读回的向量是拷贝：改它不动状态", () => {
      const { h, layer } = open();
      (layer.padding as Vec2).x = 9;
      expect(h.state.textFields.get(4)!.padding).toEqual([32, 32]);
    });

    it("读回的 float 按 f32", () => {
      const { h, layer } = open();
      h.state.textFields.get(4)!.pointsize = 0.1;
      expect(layer.pointsize).toBe(Math.fround(0.1));
    });

    it("text：数字转字符串、数组转 'a,b'，null / undefined 不变", () => {
      expect(written("text", 12)).toBe("12");
      expect(written("text", ["a", "b"])).toBe("a,b");
      expect(written("text", null)).toBe("abc");
      expect(written("text", undefined)).toBe("abc");
      expect(written("text", "xyz")).toBe("xyz");
    });

    it("maxrows：小数截断取整（2.7 → 2、3.99 → 3、−1 → −1），字符串与布尔不变", () => {
      expect(written("maxrows", 2.7)).toBe(2);
      expect(written("maxrows", 3.99)).toBe(3);
      expect(written("maxrows", -1)).toBe(-1);
      expect(written("maxrows", "3")).toBe(1);
      expect(written("maxrows", true)).toBe(1);
    });

    it("pointsize / maxwidth：数字原样（含 0、负数），数字串不变", () => {
      expect(written("pointsize", 20.5)).toBe(20.5);
      expect(written("pointsize", 0)).toBe(0);
      expect(written("pointsize", "40")).toBe(32);
      expect(written("maxwidth", -5)).toBe(-5);
      expect(written("maxwidth", "300")).toBe(500);
    });

    it("padding / spacing：数字铺满，带齐分量的对象照写，字符串、数组、缺分量的对象不变", () => {
      expect(written("padding", 10)).toEqual(new Vec2(10, 10));
      expect(written("padding", "5 6")).toEqual(new Vec2(32, 32));
      expect(written("padding", [1, 2])).toEqual(new Vec2(32, 32));
      expect(written("padding", { x: 7 })).toEqual(new Vec2(32, 32));
      expect(written("spacing", 2)).toEqual(new Vec2(2, 2));
      expect(written("spacing", { x: 3, y: 4 })).toEqual(new Vec2(3, 4));
      expect(written("padding", new Vec2(1, 2))).toEqual(new Vec2(1, 2));
    });

    it("布尔位只收布尔：limitwidth = 1 不变，limitrows = true 写入", () => {
      expect(written("limitwidth", 1)).toBe(false);
      expect(written("limitrows", true)).toBe(true);
      expect(written("limituseellipsis", true)).toBe(true);
      expect(written("blockalign", "true")).toBe(false);
    });

    it("verticalalign：查不到取表里第一项 center（大小写敏感），top 照写", () => {
      // 起始值取表里非第一项，才分得出「写成第一项」与「没写」
      const start = { verticalalign: "bottom" };
      for (const value of [2, 0, -1, "TOP"])
        expect(written("verticalalign", value, start), String(value)).toBe("center");
      expect(written("verticalalign", "top", start)).toBe("top");
    });

    it("horizontalalign：查不到取表里第一项 left，right 照写", () => {
      const start = { horizontalalign: "center" };
      for (const value of [2, true, "1", "nope"])
        expect(written("horizontalalign", value, start), String(value)).toBe("left");
      expect(written("horizontalalign", "right", start)).toBe("right");
    });

    it("font（点 5）：ToString 后写重编译目标，写完立刻读回；同值不重复", () => {
      const { h, layer } = open();
      expect(layer.font).toBe(TEXT_DEFAULTS.font);
      layer.font = 12;
      expect(layer.font).toBe("12");
      expect(h.recompiles).toEqual([{ path: "objects/4/font", value: "12" }]);
      layer.font = 12;
      layer.font = "fonts/a.ttf";
      expect(layer.font).toBe("fonts/a.ttf");
      expect(h.recompiles.map((item) => item.value)).toEqual(["12", "fonts/a.ttf"]);
      layer.font = null;
      expect(layer.font).toBe("fonts/a.ttf");
    });

    it("opaquebackground（点 5）：只收布尔，'true' 与 1 不变；写 true 重编译并读回", () => {
      const { h, layer } = open();
      layer.opaquebackground = "true";
      layer.opaquebackground = 1;
      expect(layer.opaquebackground).toBe(false);
      expect(h.recompiles).toEqual([]);
      layer.opaquebackground = true;
      expect(layer.opaquebackground).toBe(true);
      expect(h.recompiles).toEqual([{ path: "objects/4/opaquebackground", value: true }]);
    });

    it("backgroundbrightness（点 5）：float，只收数字；读回按 f32", () => {
      const { h, layer } = open();
      expect(layer.backgroundbrightness).toBe(1);
      layer.backgroundbrightness = "2";
      expect(layer.backgroundbrightness).toBe(1);
      layer.backgroundbrightness = 0.1;
      expect(layer.backgroundbrightness).toBe(Math.fround(0.1));
      expect(h.recompiles).toEqual([{ path: "objects/4/backgroundbrightness", value: [0.1] }]);
    });

    it("anchor（点 5）：数字 3 → none，'topleft' 照写，查不到取 none；写重编译目标", () => {
      const { h, layer } = open();
      expect(layer.anchor).toBe("none");
      layer.anchor = 3;
      expect(layer.anchor).toBe("none");
      layer.anchor = "topleft";
      expect(layer.anchor).toBe("topleft");
      expect(h.recompiles).toEqual([
        { path: "objects/4/anchor", value: "none" },
        { path: "objects/4/anchor", value: "topleft" },
      ]);
      layer.anchor = "nope";
      expect(layer.anchor).toBe("none");
    });

    it("backgroundcolor（点 5，LDR）：就地写背景常量、不重编译；0.5 铺满，字符串不变", () => {
      const { h, layer } = open();
      expect(layer.backgroundcolor).toEqual(new Vec3(0, 0, 0));
      layer.backgroundcolor = 0.5;
      expect(layer.backgroundcolor).toEqual(new Vec3(0.5, 0.5, 0.5));
      expect(h.state.constants.get("objects/4/text/background")!.g_Color).toEqual([0.5, 0.5, 0.5]);
      layer.backgroundcolor = "0.1 0.2 0.3";
      expect(layer.backgroundcolor).toEqual(new Vec3(0.5, 0.5, 0.5));
      layer.backgroundcolor = new Vec3(0.1, 0.2, 0.3);
      expect(layer.backgroundcolor).toEqual(new Vec3(0.1, 0.2, 0.3));
      expect(h.recompiles).toEqual([]);
    });

    it("backgroundcolor（点 5，HDR 且亮度不为 1）：重编译，写完立刻读回", () => {
      const { h, layer } = open({}, "hdr");
      layer.backgroundcolor = 0.5;
      expect(h.recompiles).toEqual([{ path: "objects/4/backgroundcolor", value: [0.5, 0.5, 0.5] }]);
      expect(layer.backgroundcolor).toEqual(new Vec3(0.5, 0.5, 0.5));
      layer.backgroundcolor = 0.5;
      expect(h.recompiles).toHaveLength(1);
    });

    it("写进 textFields 并标脏重排；值没变不标脏", () => {
      const { h, layer } = open();
      layer.text = "new";
      expect(h.state.textFields.get(4)!.text).toBe("new");
      expect(h.state.takeDirty().texts).toEqual(new Set([4]));
      layer.text = "new";
      layer.padding = new Vec2(32, 32);
      expect(h.state.takeDirty().texts).toEqual(new Set());
    });

    it("非文本层没有这些访问器，赋值是普通属性", () => {
      const h = setup(undefined, undefined, undefined, true);
      const first = (h.api.thisScene.getLayer as (name: string) => TextLayer)("First");
      for (const field of TEXT_FIELD_NAMES) expect(field in first, field).toBe(false);
      first.text = "x";
      first.pointsize = 9;
      expect(first.text).toBe("x");
      expect(first.pointsize).toBe(9);
      expect(h.state.textFields.has(0)).toBe(false);
      expect(h.state.textFields.get(4)!.text).toBe("abc");
    });

    it("重编译后同一个文本层对象读新状态", () => {
      const { h, layer } = open();
      layer.text = "changed";
      h.recompile();
      expect(layer.text).toBe("abc");
      expect((h.api.thisScene.getLayer as (name: string) => unknown)("Label")).toBe(layer);
    });
  });

  it("getLayer 认图层对象（P6b 步骤 2，p6b-api 实测）：同一个对象返回自己，别的对象与没有的名字返回 null，重编译后仍认", () => {
    const h = setup();
    const getLayer = h.api.thisScene.getLayer as (name: unknown) => Record<string, unknown> | null;
    const first = getLayer("First")!;
    expect(getLayer(first)).toBe(first);
    expect(getLayer({})).toBeNull();
    expect(getLayer("nope")).toBeNull();
    expect(getLayer(null)).toBeNull();
    // 不是图层对象的 API 对象（general、thisScene）也不认
    expect(getLayer(h.api.general)).toBeNull();
    expect(getLayer(h.api.thisScene)).toBeNull();
    h.recompile();
    expect(getLayer(first)).toBe(first);
  });

  describe("声音层（P6a 步骤 2，ISoundLayer）", () => {
    function scheduler(playing = true) {
      const calls: string[] = [];
      const target: SoundScriptTarget = {
        play: () => void calls.push("play"),
        pause: () => void calls.push("pause"),
        stop: () => void calls.push("stop"),
        isPlaying: () => {
          calls.push("isPlaying");
          return playing;
        },
      };
      return { calls, target };
    }

    it("只有声音层有 play / pause / stop / isPlaying / volume；其它图层上调用是 TypeError", () => {
      const h = setup(undefined, scheduler());
      const plain = h.api.layer(0)!;
      const music = h.api.layer(2)!;
      for (const name of ["play", "pause", "stop", "isPlaying", "volume"]) {
        expect(name in music, name).toBe(true);
        expect(name in plain, name).toBe(false);
      }
      expect(() => (plain.play as () => void)()).toThrow(TypeError);
      // 没有声音的场景：所有图层都没有
      const quiet = setup();
      expect("play" in quiet.api.layer(0)!).toBe(false);
    });

    it("四个方法接到宿主给的排期器，返回值照排期器（play / pause / stop 无返回值）", () => {
      const sound = scheduler(true);
      const h = setup(undefined, sound);
      const music = (h.api.thisScene.getLayer as (name: string) => Record<string, () => unknown>)("Music");
      expect(music.play()).toBeUndefined();
      expect(music.pause()).toBeUndefined();
      expect(music.stop()).toBeUndefined();
      expect(music.isPlaying()).toBe(true);
      expect(sound.calls).toEqual(["play", "pause", "stop", "isPlaying"]);
      // 重编译后同一个代理照样接得上
      h.recompile();
      (h.api.layer(2)!.play as () => void)();
      expect(sound.calls.at(-1)).toBe("play");
    });

    it("没有播放器（宿主给 null）时方法什么都不做，isPlaying 为假", () => {
      const h = setup(undefined, { target: null });
      const music = h.api.layer(2)! as Record<string, () => unknown>;
      expect(() => music.play()).not.toThrow();
      expect(() => music.stop()).not.toThrow();
      expect(music.isPlaying()).toBe(false);
    });

    it("volume 读 SceneState.sounds；写落到就地目标 sound，不钳制，数字与 { x } 都收，错类型不改", () => {
      const h = setup(undefined, scheduler());
      const music = h.api.layer(2)!;
      expect(music.volume).toBe(0.5);
      music.volume = 2;
      expect(h.state.sounds.get(2)?.volume).toBe(2);
      expect(music.volume).toBe(2);
      music.volume = -0.5;
      expect(music.volume).toBe(-0.5);
      music.volume = { x: 0.25 };
      expect(music.volume).toBe(0.25);
      music.volume = "loud";
      music.volume = true;
      expect(music.volume).toBe(0.25);
      // 写入走的是 sound 目标：重编译后状态回到编译期的值（宿主重放写入，不留在 API 层）
      h.recompile();
      expect(music.volume).toBe(0.5);
    });
  });

  it("parallaxDepth（P5a 步骤 2）：读到 Vec2，写 Vec2 / 普通对象 / 数字（铺满）进 SceneState 并标脏整棵子树，错类型不改", () => {
    const h = setup();
    const first = (h.api.thisScene.getLayer as (name: number) => Record<string, unknown>)(0);
    // 缺键 (1, 1)，是拷贝
    expect(first.parallaxDepth).toEqual(new Vec2(1, 1));
    (first.parallaxDepth as Vec2).x = 9;
    expect(h.state.layers.get(0)?.parallaxDepth).toEqual([1, 1]);
    h.state.takeDirty();
    first.parallaxDepth = new Vec2(0, 2);
    expect(h.state.layers.get(0)?.parallaxDepth).toEqual([0, 2]);
    expect(first.parallaxDepth).toEqual(new Vec2(0, 2));
    expect([...h.state.takeDirty().layers]).toEqual([0]);
    first.parallaxDepth = { x: -0.7, y: 0.5 };
    expect(h.state.layers.get(0)?.parallaxDepth).toEqual([-0.7, 0.5]);
    first.parallaxDepth = 0.01;
    expect(h.state.layers.get(0)?.parallaxDepth).toEqual([0.01, 0.01]);
    first.parallaxDepth = "1 1";
    expect(h.state.layers.get(0)?.parallaxDepth).toEqual([0.01, 0.01]);
  });

  it("{script} 挂在图层的 parallaxDepth 上（P5a 步骤 2）：目标是图层字段，形状 vec2", async () => {
    const source = "export function update(v) { return v; }";
    const { list } = await collectScripts(
      { objects: [{ id: 1, image: "models/a.json", parallaxDepth: { script: source, value: "0.5 0.5" } }] },
      {},
      [],
    );
    expect(list).toHaveLength(1);
    expect(list[0].target).toEqual({ kind: "layer", object: 0, field: "parallaxDepth" });
    expect(list[0].valueType).toBe("vec2");
    expect(list[0].initial).toBe("0.5 0.5");
  });

  it("图层数字下标保持 scene.json 坐标；材质对象暴露同 pass 的全部常量", () => {
    const h = setup();
    h.bundle.layers.splice(0, 1);
    const getLayer = h.api.thisScene.getLayer as (index: number) => Record<string, unknown> | null;
    expect(getLayer(0)).toBeNull();
    expect(getLayer(1)?.name).toBe("Second");
    expect((h.api.thisScene.getLayerIndex as (value: unknown) => number)(getLayer(1))).toBe(1);
    h.bundle.layers[0].passes.push({
      key: "objects/1/passes/0",
      program: 0,
      blending: "normal",
      cullmode: "none",
      depthtest: "disabled",
      depthwrite: "disabled",
      textures: {},
      runtime: {},
      uniforms: {},
      framebuffer: false,
    });
    h.bundle.programs.push({
      uniforms: [
        { name: "g_Tint", type: "vec3<f32>", meta: { material: "tint" } },
        { name: "g_Amount", type: "f32", meta: { material: "amount" } },
      ],
    } as unknown as SceneBundle["programs"][number]);
    h.state.constants.set("objects/1/passes/0", { g_Tint: [1, 0, 0], g_Amount: [2] });
    h.api.enterScript(script("tint", { kind: "material", pass: "objects/1/passes/0", layer: 1 }, 1));
    const owner = h.realm.global.thisObject as Record<string, unknown>;
    expect(owner.tint).toEqual(new Vec3(1, 0, 0));
    expect(owner.amount).toBe(2);
  });

  it("thisLayer / thisObject 随脚本及计时器归属切换", async () => {
    const h = setup();
    const report = { ready() {}, fallback() {}, debug() {}, info() {}, warn() {}, error() {} };
    const runtime = new ScriptRuntime(h.realm, {
      report,
      read: () => [1],
      write: () => true,
      enterScript: (script) => h.api.enterScript(script),
      setModuleEvaluating: (value) => h.api.setModuleEvaluating(value),
      setProperties: (properties) => h.api.setProperties(properties),
    });
    h.api.attachRuntime(runtime);
    const one = script("one", { kind: "layer", object: 0 }, 0);
    const two = script("two", { kind: "general" }, null);
    const seen: unknown[] = [];
    h.realm.modules.set("one", {
      init: () => {
        seen.push(h.realm.global.thisLayer, h.realm.global.thisObject);
        (h.api.engine.setTimeout as (fn: () => void, ms: number) => void)(
          () => seen.push(h.realm.global.thisLayer),
          100,
        );
        const cancel = (h.api.engine.setInterval as (fn: () => void, ms: number) => () => void)(
          () => seen.push("cancelled"),
          100,
        );
        (h.api.engine.clearTimeout as (cancel: () => void) => void)(cancel);
      },
    });
    h.realm.modules.set("two", { init: () => seen.push(h.realm.global.thisLayer, h.realm.global.thisObject) });
    await runtime.load({ list: [one, two] });
    runtime.frame(0.1);
    expect(seen).toEqual([h.api.layer(0), h.api.layer(0), h.api.general, h.api.general, h.api.layer(0)]);
    expect(h.realm.global.thisLayer).toBeNull();
    expect(h.realm.global.thisObject).toBeNull();
  });

  it("材质 uniform、general 泛光与重编译目标", () => {
    const h = setup();
    const material = script("mat", { kind: "material", pass: "objects/0/passes/0", layer: 0 }, 0);
    material.target = {
      kind: "constant",
      pass: "objects/0/passes/0",
      material: "tint",
      uniforms: ["g_Tint"],
      type: "vec3",
    };
    h.bundle.scripts.list.push(material);
    const scalar = script("scalar", { kind: "material", pass: "objects/0/passes/0", layer: 0 }, 0);
    scalar.target = {
      kind: "constant",
      pass: "objects/0/passes/0",
      material: "amount",
      uniforms: ["g_Amount"],
      type: "float",
    };
    h.bundle.scripts.list.push(scalar);
    h.state.constants.set("objects/0/passes/0", { g_Tint: [1, 0, 0], g_Amount: [1] });
    h.api.enterScript(material);
    const owner = h.realm.global.thisObject as Record<string, unknown>;
    expect(owner.tint).toEqual(new Vec3(1, 0, 0));
    owner.tint = new Vec3(0, 1, 0);
    expect(h.state.constants.get("objects/0/passes/0")?.g_Tint).toEqual([0, 1, 0]);
    expect(owner.amount).toBe(1);
    owner.amount = 2;
    expect(h.state.constants.get("objects/0/passes/0")?.g_Amount).toEqual([2]);
    h.api.enterScript(script("general", { kind: "general" }, null));
    const general = h.realm.global.thisObject as Record<string, unknown>;
    general.bloomstrength = 1.5;
    general.bloomtint = new Vec3(0.2, 0.3, 0.4);
    expect(h.state.bloom.strength).toBe(1.5);
    expect(h.state.bloom.tint).toEqual([0.2, 0.3, 0.4]);
    general.hdr = true;
    general.hdr = true;
    expect(h.recompiles).toEqual([{ path: "general/hdr", value: true }]);
    h.api.forgetRecompile("general/hdr");
    general.hdr = true;
    expect(h.recompiles).toHaveLength(2);
    // 探针统计写到重编译目标的次数：每一次赋值都算，被去重的也算（哪段每帧都在写）
    expect(h.api.recompileWrites.get("general")).toBe(3);
  });

  it("thisScene.bloom 读写 SceneState 的场景位，不算重编译写入；与 thisObject 是同一个位", () => {
    const h = setup();
    h.bundle.bloom = { hdr: false, passes: {} };
    h.resetState();
    const scene = h.api.thisScene;
    expect(scene.bloom).toBe(true);
    scene.bloom = false;
    expect(h.state.bloomEnabled).toBe(false);
    expect(scene.bloom).toBe(false);
    h.api.enterScript(script("general", { kind: "general" }, null));
    const general = h.realm.global.thisObject as Record<string, unknown>;
    expect(general.bloom).toBe(false);
    general.bloom = true;
    expect(scene.bloom).toBe(true);
    // 只认布尔，同图层 visible
    scene.bloom = 0;
    expect(h.state.bloomEnabled).toBe(true);
    expect(h.recompiles).toEqual([]);
    expect(h.api.recompileWrites.size).toBe(0);
    // 读的是场景位，不含档位：档位关闭时也如实读到
    h.bundle.general.postprocess = { level: "disabled", bloomFlag: true, hdrFlag: false, bloom: false, hdr: false };
    h.resetState();
    expect(scene.bloom).toBe(true);
  });

  it("hdr 写入仍是重编译目标，读场景位", () => {
    const h = setup();
    h.api.enterScript(script("general", { kind: "general" }, null));
    const general = h.realm.global.thisObject as Record<string, unknown>;
    expect(general.hdr).toBe(false);
    general.hdr = true;
    expect(h.recompiles).toEqual([{ path: "general/hdr", value: true }]);
    expect(h.api.recompileWrites.get("general")).toBe(1);
  });

  it("thisScene.hdr 读场景位：`bloom: false`、`hdr: true` 读 true，而渲染是 LDR（K5）", () => {
    const h = setup();
    h.bundle.general.postprocess = { level: "ultra", bloomFlag: false, hdrFlag: true, bloom: false, hdr: false };
    expect(h.api.thisScene.hdr).toBe(true);
    h.bundle.general.postprocess = { level: "disabled", bloomFlag: true, hdrFlag: true, bloom: false, hdr: false };
    expect(h.api.thisScene.hdr).toBe(true);
    h.bundle.general.postprocess = { level: "ultra", bloomFlag: true, hdrFlag: false, bloom: true, hdr: false };
    expect(h.api.thisScene.hdr).toBe(false);
  });

  it("thisScene 带全部 general 字段，和挂在 general 上的脚本读写同一份（K5）", () => {
    const h = setup();
    h.bundle.bloom = { hdr: false, passes: {} };
    h.resetState();
    const { thisScene: scene, general } = h.api;
    // 成员就是 general 的全部字段加四个查询方法：fog*、wind* 这轮不加（zoom 在 P5a 步骤 4 进了 general 字段表）
    const methods = ["enumerateLayers", "getLayer", "getLayerCount", "getLayerIndex"];
    expect(Object.keys(scene).sort()).toEqual([...Object.keys(general), ...methods].sort());
    expect(Object.keys(general)).toEqual(
      expect.arrayContaining(["bloom", "hdr", "clearenabled", "clearcolor", ...Object.keys(BLOOM_FIELDS)]),
    );
    expect(scene.bloomhdriterations).toBe(4);
    expect(scene.bloomtint).toEqual(new Vec3(1, 1, 1));
    expect(scene.clearenabled).toBe(true);
    expect(scene.clearcolor).toEqual(new Vec3(0, 0, 0));
    scene.bloomhdriterations = 3;
    expect(h.state.bloom.hdrIterations).toBe(3);
    expect(general.bloomhdriterations).toBe(3);
    general.bloomstrength = 1.5;
    expect(scene.bloomstrength).toBe(1.5);
    scene.bloomtint = new Vec3(0.2, 0.3, 0.4);
    expect(general.bloomtint).toEqual(new Vec3(0.2, 0.3, 0.4));
    expect(h.recompiles).toEqual([]);
    // 重编译类字段写到 thisScene 上同样重编译，和写 general 共用去重
    scene.hdr = true;
    general.hdr = true;
    expect(h.recompiles).toEqual([{ path: "general/hdr", value: true }]);
  });

  it("general 字段：读到 Vec3 / bool / number，缺省值同 L14", () => {
    const { thisScene: scene } = setup().api;
    expect(scene.clearcolor).toEqual(new Vec3(0, 0, 0));
    expect(scene.ambientcolor).toEqual(new Vec3(0, 0, 0));
    expect(scene.skylightcolor).toEqual(new Vec3(0, 0, 0));
    expect(scene.clearenabled).toBe(true);
    expect(scene.camerafade).toBe(true);
    expect(scene.camerashake).toBe(false);
    expect(scene.fov).toBe(50);
    expect(scene.nearz).toBe(0.1);
    expect(scene.camerashakespeed).toBe(3);
    expect(scene.cameraparallaxdelay).toBe(0.1);
    expect(scene.cameraparallaxmouseinfluence).toBe(0.5);
    expect(scene.zoom).toBe(1);
  });

  it("general 字段：全部字段写入不重编译，当场读回，thisScene 与 general 同一份", () => {
    const h = setup();
    h.api.enterScript(script("s", { kind: "general" }, null));
    const { thisScene: scene, general } = h.api;
    const written: Record<GeneralKey, unknown> = {
      clearcolor: new Vec3(0.1, 0.2, 0.3),
      clearenabled: false,
      ambientcolor: new Vec3(0.2, 0.3, 0.4),
      skylightcolor: new Vec3(0.5, 0.6, 0.7),
      fov: 33,
      nearz: 0.5,
      farz: 5000,
      camerafade: false,
      camerashake: true,
      camerashakespeed: 1.5,
      camerashakeamplitude: 0.25,
      camerashakeroughness: 0.75,
      cameraparallax: true,
      cameraparallaxamount: 0.4,
      cameraparallaxdelay: 0.2,
      cameraparallaxmouseinfluence: 0.6,
      zoom: 1.5,
    };
    expect(Object.keys(written).sort()).toEqual(Object.keys(GENERAL_FIELDS).sort());
    for (const [key, value] of Object.entries(written)) {
      scene[key] = value;
      expect(scene[key]).toEqual(value);
      expect(general[key]).toEqual(value);
    }
    expect(h.state.general.clearcolor).toEqual([0.1, 0.2, 0.3]);
    expect(h.state.general.fov).toBe(33);
    expect(h.state.general.camerashake).toBe(true);
    // P5a 步骤 4：脚本写 `thisScene.zoom` 落在状态上，渲染器下一帧开头读
    expect(h.state.general.zoom).toBe(1.5);
    expect(h.recompiles).toEqual([]);
    expect(h.api.recompileWrites.size).toBe(0);
  });

  it("general 字段写入的形状：数字铺满、普通对象能写，读到的是拷贝，错类型不改（L14、G4）", () => {
    const h = setup();
    const scene = h.api.thisScene;
    scene.clearcolor = 0.5;
    expect(scene.clearcolor).toEqual(new Vec3(0.5, 0.5, 0.5));
    scene.ambientcolor = { x: 0.1, y: 0.2, z: 0.3 };
    expect(scene.ambientcolor).toEqual(new Vec3(0.1, 0.2, 0.3));
    expect(scene.ambientcolor).toBeInstanceOf(Vec3);
    (scene.clearcolor as Vec3).x = 0;
    expect((scene.clearcolor as Vec3).x).toBe(0.5);
    scene.clearcolor = "1 0 0";
    scene.clearenabled = 0;
    scene.fov = "x";
    expect(scene.clearcolor).toEqual(new Vec3(0.5, 0.5, 0.5));
    expect(scene.clearenabled).toBe(true);
    expect(scene.fov).toBe(50);
  });

  it("重编译后 general 字段读新状态：写入由宿主重放，不留在 API 层", () => {
    const h = setup();
    const scene = h.api.thisScene;
    scene.fov = 33;
    h.recompile();
    expect(scene.fov).toBe(50);
  });

  it("API 对象是普通对象：能转成字符串（WPE 是 [object Object]）", () => {
    const h = setup();
    for (const object of [h.api.general, h.api.thisScene, h.api.layer(0)])
      expect(String(object)).toBe("[object Object]");
  });

  it("挂在 general 上的脚本：thisLayer === thisObject，经它写字段进场景（L14）", () => {
    const h = setup();
    h.api.enterScript(script("general", { kind: "general" }, null));
    const { thisLayer, thisObject } = h.realm.global as Record<string, Record<string, unknown>>;
    expect(thisLayer).toBe(thisObject);
    expect(thisObject).toBe(h.api.general);
    expect(thisObject).not.toBe(h.api.thisScene);
    thisLayer.skylightcolor = new Vec3(0.9, 0.1, 0.1);
    expect(h.api.thisScene.skylightcolor).toEqual(new Vec3(0.9, 0.1, 0.1));
    h.api.enterScript(null);
    expect(h.realm.global.thisLayer).toBeNull();
  });

  it("{script} 挂在 general 字段上：目标是字段本身，形状取字段表", async () => {
    const source = "export function update(v) { return v; }";
    const fields = Object.keys(GENERAL_FIELDS) as GeneralKey[];
    const general = Object.fromEntries(fields.map((key) => [key, { script: source }]));
    const { list } = await collectScripts({ general, objects: [] }, {}, []);
    expect(list).toHaveLength(fields.length);
    for (const item of list) {
      const key = item.id.split("/").at(-1) as GeneralKey;
      expect(item.target).toEqual({ kind: "general", key });
      expect(item.valueType).toBe(GENERAL_FIELDS[key].type);
    }
  });

  it("{script} 挂在 8 个泛光字段上是就地目标，挂在 bloom 上是场景位，hdr 暂不支持", async () => {
    const keys = Object.keys(BLOOM_FIELDS);
    expect(keys).toHaveLength(8);
    const general = Object.fromEntries(
      [...keys, "bloom", "hdr"].map((key) => [key, { script: "export function update(v) { return v; }", value: 1 }]),
    );
    const { list } = await collectScripts({ general, objects: [] }, {}, []);
    const targets = Object.fromEntries(list.map((item) => [item.id.split("/").at(-1), item.target]));
    expect(targets).toEqual({
      bloomstrength: { kind: "bloom", field: "strength" },
      bloomthreshold: { kind: "bloom", field: "threshold" },
      bloomtint: { kind: "bloom", field: "tint" },
      bloomhdrstrength: { kind: "bloom", field: "hdrStrength" },
      bloomhdrthreshold: { kind: "bloom", field: "hdrThreshold" },
      bloomhdrfeather: { kind: "bloom", field: "hdrFeather" },
      bloomhdrscatter: { kind: "bloom", field: "hdrScatter" },
      bloomhdriterations: { kind: "bloom", field: "hdrIterations" },
      bloom: { kind: "bloom-enabled" },
      hdr: { kind: "unsupported", path: "general/hdr" },
    });
  });

  it("effect 的 visible 读写走状态，不算重编译写入（3c）", () => {
    const h = setup();
    const entry: SceneEffect = {
      source: 2, // JSON 下标，bundle 下标是 0
      id: 1,
      name: "",
      file: "effects/x/effect.json",
      fbos: [],
      steps: [],
      enabled: false,
      visibleBound: true,
      unsupported: [],
    };
    h.bundle.layers[1].effects.push(entry);
    h.resetState();
    h.api.enterScript(script("closed", { kind: "effect", object: 1, effect: 2 }, 1));
    const closed = h.realm.global.thisObject as Record<string, unknown>;
    // 关着的可变 effect 在 bundle 里，visible 读到 false；它的对象仍然有效
    expect(closed.visible).toBe(false);
    expect((h.api.engine.isObjectValid as (value: unknown) => boolean)(closed)).toBe(true);
    closed.visible = true;
    expect(h.state.effectEnabled(1, 2)).toBe(true);
    expect(closed.visible).toBe(true);
    expect(h.state.takeDirty().structures).toEqual(new Set([1]));
    closed.visible = false;
    expect(closed.visible).toBe(false);
    // 不是布尔值的写入忽略（同图层 visible）
    closed.visible = 1;
    expect(closed.visible).toBe(false);
    expect(h.recompiles).toEqual([]);
    expect(h.api.recompileWrites.size).toBe(0);
  });

  it("registerAudioBuffers 只在模块求值期间可调用，同一分辨率返回同一组全零 realm 缓冲", () => {
    const h = setup();
    // 换成 realm 自己的构造器，验证缓冲是用 realm 的 Float32Array 造的
    class RealmFloat32Array extends Float32Array {}
    h.realm.global.Float32Array = RealmFloat32Array;
    const engine = h.api.engine;
    const register = engine.registerAudioBuffers as (resolution: unknown) => Record<string, Float32Array>;
    expect(engine.AUDIO_RESOLUTION_16).toBe(16);
    expect(engine.AUDIO_RESOLUTION_32).toBe(32);
    expect(engine.AUDIO_RESOLUTION_64).toBe(64);
    // init / update 等回调里调用抛错（报告 D：只能在模块顶层调）
    expect(() => register(32)).toThrow("只能在模块求值期间调用");
    h.api.setModuleEvaluating(true);
    for (const size of [16, 32, 64]) {
      const buffer = register(engine[`AUDIO_RESOLUTION_${size}`]);
      for (const name of ["left", "right", "average"]) {
        expect(buffer[name]).toBeInstanceOf(RealmFloat32Array);
        expect(buffer[name].length).toBe(size);
        expect([...buffer[name]].every((value) => value === 0)).toBe(true);
      }
      expect(register(size)).toBe(buffer);
    }
    expect(() => register(8)).toThrow(TypeError);
    expect(() => register("32")).toThrow(TypeError);
    expect(() => register(32.5)).toThrow(TypeError);
    h.api.setModuleEvaluating(false);
  });

  /**
   * 场景频谱（P4e 步骤 4）：每个分辨率的 left / right / average 填不同的常数（64 段 0.5 / 0.25 / 0.125，32 段 ×2，16 段 ×4），
   * 拷错块或声道一眼能看出来；average 故意不等于 (left + right) / 2，核对取的是 A 段。
   */
  function filledSpectrum(): SceneSpectrum {
    const spectrum = new SceneSpectrum();
    for (const [resolution, scale] of [
      [64, 1],
      [32, 2],
      [16, 4],
    ] as const) {
      const block = spectrum.block(resolution);
      block.left.fill(0.5 * scale);
      block.right.fill(0.25 * scale);
      block.average.fill(0.125 * scale);
    }
    return spectrum;
  }

  it("applySpectrum 把场景频谱同分辨率的块拷进脚本持有的同一组数组（average 是 A 段），全部已注册分辨率都更新", () => {
    const h = setup();
    const register = h.api.engine.registerAudioBuffers as (resolution: number) => Record<string, Float32Array>;
    h.api.setModuleEvaluating(true);
    const low = register(16);
    const high = register(64);
    h.api.setModuleEvaluating(false);
    // 脚本持有的是数组本身：先取出来，写入之后看这些引用里的值
    const held = [low, high].map(({ left, right, average }) => ({ left, right, average }));
    const spectrum = filledSpectrum();
    h.api.applySpectrum(spectrum);
    for (const [index, scale] of [
      [0, 4],
      [1, 1],
    ] as const) {
      const { left, right, average } = held[index];
      expect([...left].every((value) => value === 0.5 * scale)).toBe(true);
      expect([...right].every((value) => value === 0.25 * scale)).toBe(true);
      expect([...average].every((value) => value === 0.125 * scale)).toBe(true);
    }
    expect(h.api.audioResolutions).toEqual([16, 64]);
    // 拷的是值，不是引用：频谱之后变了，缓冲要等下一次拷
    spectrum.L16.fill(0);
    expect(held[0].left[0]).toBe(2);
    expect(low.left).toBe(held[0].left);
  });

  it("还没注册就拷什么都不做；脚本改写缓冲对象的字段不影响写入", () => {
    const h = setup();
    h.api.applySpectrum(filledSpectrum());
    expect(h.api.audioResolutions).toEqual([]);
    const register = h.api.engine.registerAudioBuffers as (resolution: number) => Record<string, unknown>;
    h.api.setModuleEvaluating(true);
    const buffer = register(16);
    h.api.setModuleEvaluating(false);
    const { left } = buffer;
    buffer.left = "脚本写的";
    h.api.applySpectrum(filledSpectrum());
    expect(buffer.left).toBe("脚本写的");
    expect((left as Float32Array)[0]).toBe(2);
  });

  it("registerAudioBuffers 成功才通知宿主，不成功的调用不通知", () => {
    const registered = vi.fn();
    const h = setup(registered);
    const register = h.api.engine.registerAudioBuffers as (resolution: unknown) => unknown;
    expect(() => register(16)).toThrow("只能在模块求值期间调用");
    h.api.setModuleEvaluating(true);
    expect(() => register(8)).toThrow(TypeError);
    expect(registered).not.toHaveBeenCalled();
    register(16);
    expect(registered).toHaveBeenCalledTimes(1);
    h.api.setModuleEvaluating(false);
  });
});

/** P9b 用例的视频：容器时长 2.55（float32 不是它本身）。 */
const VIDEO = { path: "P:/p/scene.pkg", start: 100, end: 164, duration: 2.55 };

/**
 * 视频纹理的场景：图层 0（First）的基础材质槽 0 是视频纹理 0；图层 1（Second）槽 0 是普通纹理 1、槽 1 才是视频（不算视频图层），
 * `secondIsVideo` 时图层 1 的槽 0 也是视频。`duration: false` 时视频没有容器时长。
 */
function videoScene(options: { duration?: boolean; secondIsVideo?: boolean } = {}): SceneBundle {
  const bundle = scene();
  const pass = (object: number, textures: Record<number, number>) =>
    ({
      key: `objects/${object}/passes/0`,
      program: null,
      blending: "normal",
      cullmode: "nocull",
      depthtest: "disabled",
      depthwrite: "disabled",
      textures,
      runtime: {},
      uniforms: {},
      framebuffer: false,
    }) as ScenePass;
  bundle.layers[0].passes = [pass(0, { 0: 0 })];
  bundle.layers[1].passes = [pass(1, options.secondIsVideo ? { 0: 0 } : { 0: 1, 1: 0 })];
  const video = options.duration === false ? { path: VIDEO.path, start: VIDEO.start, end: VIDEO.end } : { ...VIDEO };
  bundle.textures = [
    { path: "materials/clip.tex", video } as SceneTexture,
    { path: "materials/still.tex" } as SceneTexture,
  ];
  return bundle;
}

/** 记调用的落点：字段可读写，`end()` 照播放器的 `fireEnded` 依次调结束回调（不 catch：出错要由运行时吞掉）。 */
class FakeVideoTarget implements VideoScriptTarget {
  calls: string[] = [];
  rate = 1;
  loop = true;
  currentTime = 0;
  duration = 2.517;
  playing = true;
  callbacks: (() => void)[] = [];
  play() {
    this.calls.push("play");
  }
  pause() {
    this.calls.push("pause");
  }
  stop() {
    this.calls.push("stop");
  }
  isPlaying() {
    return this.playing;
  }
  addEndedCallback(callback: () => void) {
    this.callbacks.push(callback);
  }
  end() {
    for (const callback of [...this.callbacks]) callback();
  }
}

/** `target` 是宿主给图层 0 的落点（可换、可为 null）；`noVideo` 时不传 `video`，模拟语料诊断与 `realmProbe`。 */
function videoSetup(options: { target?: FakeVideoTarget | null; noVideo?: boolean; bundle?: SceneBundle } = {}) {
  const realm = new FakeRealm();
  let bundle = options.bundle ?? videoScene();
  const state = SceneState.fromBundle(scene());
  const h = {
    realm,
    target: options.target ?? null,
    /** 每次查落点的图层。 */
    lookups: [] as number[],
    setBundle(next: SceneBundle) {
      bundle = next;
    },
    api: null as unknown as ScriptApi,
  };
  h.api = new ScriptApi(realm, {
    bundle: () => bundle,
    state: () => state,
    screenResolution: () => [800, 600],
    frametime: () => 0.016,
    runtime: () => 0,
    timeOfDay: () => 0,
    write: () => true,
    ...(options.noVideo
      ? {}
      : {
          video: (object: number) => {
            h.lookups.push(object);
            return object === 0 ? h.target : null;
          },
        }),
  });
  return h;
}

type VideoApi = Record<string, unknown> & {
  play(): unknown;
  pause(): unknown;
  stop(): unknown;
  setCurrentTime(time: unknown): unknown;
  isPlaying(): unknown;
  getCurrentTime(): unknown;
  getAnimation(): unknown;
  addEndedCallback(callback: unknown): unknown;
};
const videoOf = (api: ScriptApi, object: number) => (api.layer(object)!.getVideoTexture as () => VideoApi | null)();

describe("视频纹理（P9b，IVideoTexture）", () => {
  it("所有图层都有 getVideoTexture：非视频图层返回 null（不缓存），视频图层每次返回同一个对象", () => {
    const h = videoSetup({ target: new FakeVideoTarget() });
    for (const object of [0, 1]) expect("getVideoTexture" in h.api.layer(object)!).toBe(true);
    const video = videoOf(h.api, 0)!;
    expect(video).not.toBeNull();
    expect(videoOf(h.api, 0)).toBe(video);
    const getLayer = h.api.thisScene.getLayer as (name: string) => Record<string, () => unknown>;
    expect(getLayer("First").getVideoTexture()).toBe(video);
    // 视频只在槽 1：不是视频图层
    expect(videoOf(h.api, 1)).toBeNull();
    // 不缓存 null：重编译后图层 1 的槽 0 成了视频，就拿到对象，之后同一个
    h.setBundle(videoScene({ secondIsVideo: true }));
    const second = videoOf(h.api, 1)!;
    expect(second).not.toBeNull();
    expect(second).not.toBe(video);
    expect(videoOf(h.api, 1)).toBe(second);
    // 每次都按当前 bundle 判：图层 1 又不是视频了就是 null，再成为视频时还是原来那个对象
    h.setBundle(videoScene());
    expect(videoOf(h.api, 1)).toBeNull();
    h.setBundle(videoScene({ secondIsVideo: true }));
    expect(videoOf(h.api, 1)).toBe(second);
    // 没有视频的场景
    expect(videoOf(setup().api, 0)).toBeNull();
  });

  it("「是不是视频图层」只看 bundle：没有落点也建对象；落点每次调用现取", () => {
    const h = videoSetup({ target: null });
    const video = videoOf(h.api, 0)!;
    expect(video).not.toBeNull();
    expect(h.lookups).toEqual([]);
    video.play();
    video.isPlaying();
    expect(h.lookups).toEqual([0, 0]);
    // 落点换了（重编译、播放器重建）：下一次调用就落到新的上
    const first = new FakeVideoTarget();
    const second = new FakeVideoTarget();
    h.target = first;
    video.play();
    h.target = second;
    video.pause();
    expect([first.calls, second.calls]).toEqual([["play"], ["pause"]]);
  });

  it("自有属性按 WPE 的 Object.keys 顺序、都可枚举；普通对象；没有 currentTime / getDuration", () => {
    const video = videoOf(videoSetup({ target: new FakeVideoTarget() }).api, 0)!;
    expect(Object.keys(video)).toEqual([
      "duration",
      "loop",
      "rate",
      "addEndedCallback",
      "play",
      "setCurrentTime",
      "isPlaying",
      "stop",
      "pause",
      "getCurrentTime",
      "getAnimation",
    ]);
    expect(String(video)).toBe("[object Object]");
    expect(Object.getPrototypeOf(video)).toBe(Object.prototype);
    expect("currentTime" in video).toBe(false);
    expect("getDuration" in video).toBe(false);
    expect((video.play as () => void).length).toBe(0);
  });

  it("成员类型：isPlaying 是布尔，loop 是数字，rate / duration / getCurrentTime 是 float32；方法返回 undefined、转给落点", () => {
    const target = new FakeVideoTarget();
    target.currentTime = 1.8;
    const video = videoOf(videoSetup({ target }).api, 0)!;
    expect(typeof video.isPlaying()).toBe("boolean");
    expect(video.isPlaying()).toBe(true);
    target.playing = false;
    expect(video.isPlaying()).toBe(false);
    expect(video.loop).toBe(1);
    expect(typeof video.loop).toBe("number");
    expect(video.rate).toBe(1);
    expect(video.duration).toBe(Math.fround(2.517));
    expect(video.duration).not.toBe(2.517);
    expect(video.getCurrentTime()).toBe(Math.fround(1.8));
    expect(video.getCurrentTime()).not.toBe(1.8);
    expect(video.play()).toBeUndefined();
    expect(video.pause()).toBeUndefined();
    expect(video.stop()).toBeUndefined();
    expect(video.setCurrentTime("1.25")).toBeUndefined();
    expect(target.currentTime).toBe(1.25);
    expect(target.calls).toEqual(["play", "pause", "stop"]);
    expect(video.getAnimation()).toBeUndefined();
    // 元数据之前、读不出容器时长的播放器：NaN 照报（WPE 探测失败同样是 NaN）
    target.duration = Number.NaN;
    expect(video.duration).toBeNaN();
  });

  it("duration 只读：严格模式下写入抛 TypeError，值不变", () => {
    const target = new FakeVideoTarget();
    const video = videoOf(videoSetup({ target }).api, 0)!;
    expect(() => {
      video.duration = 1;
    }).toThrow(TypeError);
    expect(video.duration).toBe(Math.fround(2.517));
    expect(target.duration).toBe(2.517);
  });

  it("rate / loop：写入转换后存字段并转给落点，读只返回字段", () => {
    const target = new FakeVideoTarget();
    const video = videoOf(videoSetup({ target }).api, 0)!;
    video.rate = 2.5;
    expect([video.rate, target.rate]).toEqual([2.5, 2.5]);
    video.rate = "1";
    expect([video.rate, target.rate]).toEqual([1, 1]);
    video.rate = 0.1;
    expect([video.rate, target.rate]).toEqual([Math.fround(0.1), Math.fround(0.1)]);
    for (const bad of [Number.NaN, "abc", Number.POSITIVE_INFINITY, undefined]) video.rate = bad;
    expect([video.rate, target.rate]).toEqual([Math.fround(0.1), Math.fround(0.1)]);
    // 负数照存照转：钳制在播放器里（WPE 读只返回字段）
    video.rate = -1;
    expect([video.rate, target.rate]).toEqual([-1, -1]);
    target.rate = 0;
    expect(video.rate).toBe(-1);
    video.loop = 0;
    expect([video.loop, target.loop]).toEqual([0, false]);
    video.loop = true;
    expect([video.loop, target.loop]).toEqual([1, true]);
    video.loop = "";
    expect([video.loop, target.loop]).toEqual([0, false]);
    video.loop = 1;
    expect([video.loop, target.loop]).toEqual([1, true]);
    target.loop = false;
    expect(video.loop).toBe(1);
  });

  it("没有落点（宿主给 null、不传 video）：方法空操作，duration 取 bundle 的容器时长（float32），没有时 0；字段照存", () => {
    for (const options of [{ target: null }, { noVideo: true }]) {
      const h = videoSetup(options);
      const video = videoOf(h.api, 0)!;
      for (const name of ["play", "pause", "stop", "getAnimation"] as const) expect(video[name]()).toBeUndefined();
      expect(video.setCurrentTime(1)).toBeUndefined();
      expect(video.isPlaying()).toBe(false);
      expect(video.getCurrentTime()).toBe(0);
      expect(video.duration).toBe(Math.fround(2.55));
      video.rate = 2;
      video.loop = false;
      expect([video.rate, video.loop]).toEqual([2, 0]);
      expect(video.addEndedCallback(() => {})).toBeUndefined();
      expect(() => video.addEndedCallback("no")).toThrow(TypeError);
    }
    const bare = videoSetup({ target: null, bundle: videoScene({ duration: false }) });
    expect(videoOf(bare.api, 0)!.duration).toBe(0);
  });

  it("结束回调：在登记它的脚本上下文里调、不带参数、不去重；抛错不中断其他回调、不禁用；运行时停止后不调", async () => {
    const target = new FakeVideoTarget();
    const h = videoSetup({ target });
    const warnings: string[] = [];
    const report = {
      ready() {},
      fallback() {},
      debug() {},
      info() {},
      warn: (message: string) => void warnings.push(message),
      error() {},
    };
    const runtime = new ScriptRuntime(h.realm, {
      report,
      read: () => [1],
      write: () => true,
      enterScript: (script) => h.api.enterScript(script),
      setModuleEvaluating: (value) => h.api.setModuleEvaluating(value),
    });
    h.api.attachRuntime(runtime);
    const seen: unknown[] = [];
    let updates = 0;
    const thisLayer = () => h.realm.global.thisLayer;
    // 脚本 one 挂在视频图层上；two 挂在图层 1 上、经 getLayer 拿图层 0 的视频
    h.realm.modules.set("one", {
      init() {
        const video = (thisLayer() as Record<string, () => VideoApi>).getVideoTexture();
        const named = function () {
          // 不带参数调用（WPE 实测 arguments.length 0）
          // eslint-disable-next-line prefer-rest-params
          seen.push(["one", arguments.length, thisLayer()]);
        };
        video.addEndedCallback(named);
        video.addEndedCallback(() => {
          throw new Error("boom");
        });
        video.addEndedCallback(named);
      },
      update() {
        updates++;
      },
    });
    h.realm.modules.set("two", {
      init() {
        const getLayer = h.api.thisScene.getLayer as (name: number) => Record<string, () => VideoApi>;
        getLayer(0)
          .getVideoTexture()
          .addEndedCallback(() => seen.push(["two", thisLayer()]));
      },
    });
    await runtime.load({
      list: [script("one", { kind: "layer", object: 0 }, 0), script("two", { kind: "layer", object: 1 }, 1)],
    });
    expect(target.callbacks).toHaveLength(4);
    target.end();
    const first = h.api.layer(0);
    const second = h.api.layer(1);
    expect(seen).toEqual([
      ["one", 0, first],
      ["one", 0, first],
      ["two", second],
    ]);
    expect(thisLayer()).toBeNull();
    expect(warnings).toEqual(["场景脚本 one ended 出错：boom"]);
    // 不禁用：update 照跑，再结束一次全部照调
    runtime.frame(0.016);
    expect(updates).toBe(1);
    target.end();
    expect(seen).toHaveLength(6);
    const diagnostics = runtime.diagnostics as {
      id: string;
      disabled: string[];
      calls: Record<string, { count: number }>;
    }[];
    expect(diagnostics[0].disabled).toEqual([]);
    expect(diagnostics[0].calls.ended.count).toBe(6);
    expect(diagnostics[1].calls.ended.count).toBe(2);
    runtime.destroy();
    target.end();
    expect(seen).toHaveLength(6);
  });
});

describe("未实现 API 表（compile/scriptApi.ts）与 ScriptApi 一致", () => {
  /** 各分组在 realm 里对应的真实对象：表项必须不在上面，上面已有的成员必须不在表里。 */
  function objects(): Record<ScriptApiGroup, Record<string, unknown>[]> {
    const h = setup(undefined, { target: null }, { target: null }, true);
    h.api.enterScript(script("e", { kind: "effect", object: 0, effect: 0 }, 0));
    const effect = h.realm.global.thisObject as Record<string, unknown>;
    h.api.enterScript(script("m", { kind: "material", pass: "objects/0/passes/0", layer: 0 }, 0));
    const material = h.realm.global.thisObject as Record<string, unknown>;
    h.api.enterScript(null);
    const localStorage = createWpeLocalStorage({
      global: { Object, JSON } as unknown as Record<string, unknown>,
      backend: createMemoryStorage(),
      sceneKey: "1",
      isEvaluating: () => false,
    }) as Record<string, unknown>;
    const frame = {} as Window;
    alignScriptEnvironment(frame, { log() {}, error() {} }, localStorage);
    const layer = h.api.layer(0)!;
    // 声音层（P6a 步骤 2）多 play / pause / stop / isPlaying / volume：同样逐成员核对
    const sound = h.api.layer(2)!;
    // 粒子层（P4f 步骤 3）多 play / pause / stop / isPlaying / emitParticles / instance：同样逐成员核对
    const particle = h.api.layer(3)!;
    // 文本层（P6b 步骤 2）多 12 个运行中字段：逐成员核对，缺口表里留着的 `font` 等四项不在上面
    const text = h.api.layer(4)!;
    return {
      thisScene: [h.api.thisScene, h.api.general],
      engine: [h.api.engine],
      // 整个 input 都没有；装上之后逐成员核对
      input: [(h.realm.global.input as Record<string, unknown> | undefined) ?? {}],
      localStorage: [localStorage],
      console: [(frame as unknown as Record<string, Record<string, unknown>>).console],
      layer: [layer, sound, particle, text],
      effect: [effect],
      object: [layer, sound, particle, effect, material, h.api.general, h.api.thisScene, text],
    };
  }

  it("表里的成员都还没实现", () => {
    const groups = objects();
    const table = Object.entries(MISSING_SCRIPT_API) as [ScriptApiGroup, readonly { name: string }[]][];
    for (const [group, entries] of table)
      for (const { name } of entries)
        for (const object of groups[group]) expect(name in object, `${group}.${name} 已经实现，从表里删掉`).toBe(false);
  });

  it("已实现的成员不在表里", () => {
    const groups = objects();
    for (const group of ["thisScene", "engine", "input", "localStorage", "console", "layer", "effect"] as const) {
      const missing = new Set(MISSING_SCRIPT_API[group].map((entry) => entry.name));
      for (const object of groups[group])
        for (const name of Object.keys(object))
          expect(missing.has(name), `${group}.${name} 已实现却在表里`).toBe(false);
    }
  });

  it("play / pause / stop / isPlaying 只在声音层与粒子层上有，emitParticles 与 instance 只在粒子层上有（P6a 步骤 2、P4f 步骤 3）", () => {
    const groups = objects();
    const [plain, sound, particle] = groups.layer;
    for (const name of ["play", "pause", "stop", "isPlaying"]) {
      expect(name in sound, `声音层没有 ${name}`).toBe(true);
      expect(name in particle, `粒子层没有 ${name}`).toBe(true);
      for (const object of [plain, ...groups.effect, ...groups.object.slice(3), ...groups.engine])
        expect(name in object, `${name} 出现在声音层、粒子层之外`).toBe(false);
    }
    for (const name of ["emitParticles", "instance"]) {
      expect(name in particle, `粒子层没有 ${name}`).toBe(true);
      for (const object of [plain, sound, ...groups.effect, ...groups.object.slice(3), ...groups.engine])
        expect(name in object, `${name} 出现在粒子层之外`).toBe(false);
    }
  });

  it("未实现回调表与运行时调用的回调互补，合起来是 WPE 的回调表", () => {
    const wpe = new Set<string>(WPE_SCRIPT_CALLBACKS);
    const runtime = new Set<string>(RUNTIME_CALLBACKS);
    for (const name of MISSING_SCRIPT_CALLBACKS) {
      expect(wpe.has(name), `${name} 不是 WPE 的回调`).toBe(true);
      expect(runtime.has(name), `${name} 运行时已经调用，从 MISSING_SCRIPT_CALLBACKS 删掉`).toBe(false);
    }
    const missing = new Set(MISSING_SCRIPT_CALLBACKS);
    expect(MISSING_SCRIPT_CALLBACKS).toHaveLength(missing.size);
    expect(new Set([...wpe].filter((name) => !missing.has(name)))).toEqual(runtime);
  });
});

describe("光标交互：input 与 solid（P6c）", () => {
  it("input 的三个成员每次读都现取：cursorWorldPosition 是 Vec3、cursorScreenPosition 是 Vec2（float32）、cursorLeftDown 是布尔，每次都是新对象", () => {
    const h = setup();
    const input = h.realm.global.input as Record<string, unknown>;
    expect(Object.keys(input)).toEqual(["cursorWorldPosition", "cursorScreenPosition", "cursorLeftDown"]);
    h.cursor.world = [450, 799.5001220703125, 0];
    h.cursor.screen = [300, 187];
    h.cursor.leftDown = true;
    const world = input.cursorWorldPosition as Vec3;
    expect(world).toBeInstanceOf(Vec3);
    expect(world).toEqual(new Vec3(450, 799.5001220703125, 0));
    expect(input.cursorWorldPosition).not.toBe(world);
    expect(input.cursorScreenPosition).toEqual(new Vec2(300, 187));
    expect(input.cursorScreenPosition).toBeInstanceOf(Vec2);
    expect(input.cursorLeftDown).toBe(true);
    // 现取：快照变了下一次读就变
    h.cursor.world = [1, 2, 0];
    h.cursor.leftDown = false;
    expect(input.cursorWorldPosition).toEqual(new Vec3(1, 2, 0));
    expect(input.cursorLeftDown).toBe(false);
  });

  it("世界坐标取单精度（脚本看到的和 WPE 一样是 f32 展开的值）", () => {
    const h = setup();
    h.cursor.world = [100.1, 0, 0];
    const world = (h.realm.global.input as Record<string, unknown>).cursorWorldPosition as Vec3;
    expect(world.x).toBe(Math.fround(100.1));
  });

  it("模块顶层（求值期间）读抛 realm 的 SyntaxError，消息同 WPE：<成员名> cannot be accessed from global scope.；init、回调里能读", () => {
    const h = setup();
    const input = h.realm.global.input as Record<string, unknown>;
    h.api.setModuleEvaluating(true);
    for (const name of ["cursorWorldPosition", "cursorScreenPosition", "cursorLeftDown"])
      expect(() => input[name], name).toThrow(new SyntaxError(`${name} cannot be accessed from global scope.`));
    // 抛的是 realm 的 SyntaxError（FakeRealm 的全局没有 SyntaxError，退回宿主的）
    try {
      void input.cursorLeftDown;
    } catch (error) {
      expect(error).toBeInstanceOf(SyntaxError);
    }
    h.api.setModuleEvaluating(false);
    expect(() => input.cursorLeftDown).not.toThrow();
  });

  it("成员只读：严格模式赋值抛 TypeError，读回的值不变", () => {
    const h = setup();
    const input = h.realm.global.input as Record<string, unknown>;
    h.cursor.leftDown = true;
    expect(() => {
      "use strict";
      input.cursorLeftDown = false;
    }).toThrow(TypeError);
    expect(input.cursorLeftDown).toBe(true);
  });

  it("thisLayer.solid：所有图层都有，缺省读回 true；写入只收布尔（别的类型不写、不报错），写 false 后读回 false", () => {
    const h = setup();
    const layer = h.api.layer(0)!;
    expect(layer.solid).toBe(true);
    layer.solid = false;
    expect(layer.solid).toBe(false);
    expect(h.state.layers.get(0)!.solid).toBe(false);
    for (const ignored of [1, 0, "true", null, undefined, {}, new Vec3(1, 1, 1)]) {
      layer.solid = ignored;
      expect(layer.solid, String(ignored)).toBe(false);
    }
    layer.solid = true;
    expect(layer.solid).toBe(true);
    // 别的图层不受影响
    expect(h.api.layer(1)!.solid).toBe(true);
  });

  it("solid 在声音层、粒子层、文本层上同样能读写（拾取只对图像层与文本层起作用）", () => {
    const h = setup(undefined, { target: null }, { target: null }, true);
    for (const object of [2, 3, 4]) {
      const layer = h.api.layer(object)!;
      expect(layer.solid, `对象 ${object}`).toBe(true);
      layer.solid = false;
      expect(layer.solid, `对象 ${object}`).toBe(false);
    }
  });

  it("solid 的写入不标脏（不影响绘制），也不触发重编译", () => {
    const h = setup();
    h.state.takeDirty();
    h.api.layer(0)!.solid = false;
    const dirty = h.state.takeDirty();
    expect(dirty.layers.size).toBe(0);
    expect(h.recompiles).toEqual([]);
  });
});
