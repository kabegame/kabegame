import { describe, expect, it, vi } from "vitest";
import { SceneSpectrum } from "../audio/spectrum";
import { GENERAL_FIELDS, generalDefaults, type GeneralKey } from "../compile/bindings";
import type { SceneBundle, SceneEffect, SceneLayer } from "../compile/bundle";
import { BLOOM_FIELDS } from "../compile/postprocess";
import {
  MISSING_SCRIPT_API,
  MISSING_SCRIPT_CALLBACKS,
  PARTICLE_LAYER_METHODS,
  WPE_SCRIPT_CALLBACKS,
  type ScriptApiGroup,
} from "../compile/scriptApi";
import { collectScripts, type SceneScript } from "../compile/scripts";
import { SceneState, scriptWriteValue } from "../render/state";
import { createWpeLocalStorage, ScriptApi, type SoundScriptTarget } from "./api";
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

/** `sound`：多一个声音对象的图层（objects 下标 2，名字 Music，声音表里 volume 0.5）。 */
function scene(sound = false): SceneBundle {
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
    layers: [layer(0, "First"), layer(1, "Second"), ...(sound ? [layer(2, "Music")] : [])],
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

/** `sound`：场景带声音层（`scene(true)`），`target` 是宿主交给声音层方法的排期器（null = 没有播放器）。 */
function setup(audioRegistered?: () => void, sound?: { target: SoundScriptTarget | null }) {
  const realm = new FakeRealm();
  let bundle = scene(!!sound);
  let state = SceneState.fromBundle(bundle);
  let resolution: [number, number] = [800, 600];
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
      state.write({ property: "test", target }, scriptWriteValue(value));
      return true;
    },
    audioRegistered,
    ...(sound ? { sound: (object: number) => (object === 2 ? sound.target : null) } : {}),
  });
  return {
    realm,
    api,
    recompiles,
    get bundle() {
      return bundle;
    },
    get state() {
      return state;
    },
    recompile() {
      bundle = scene(!!sound);
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
    expect(h.realm.global.input).toBeUndefined();
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

describe("未实现 API 表（compile/scriptApi.ts）与 ScriptApi 一致", () => {
  /** 各分组在 realm 里对应的真实对象：表项必须不在上面，上面已有的成员必须不在表里。 */
  function objects(): Record<ScriptApiGroup, Record<string, unknown>[]> {
    const h = setup(undefined, { target: null });
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
    return {
      thisScene: [h.api.thisScene, h.api.general],
      engine: [h.api.engine],
      // 整个 input 都没有；装上之后逐成员核对
      input: [(h.realm.global.input as Record<string, unknown> | undefined) ?? {}],
      localStorage: [localStorage],
      console: [(frame as unknown as Record<string, Record<string, unknown>>).console],
      layer: [layer, sound],
      effect: [effect],
      object: [layer, sound, effect, material, h.api.general, h.api.thisScene],
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

  it("粒子层的播放控制（PARTICLE_LAYER_METHODS）只在声音层上有，不在别的对象上（P6a 步骤 2）", () => {
    const groups = objects();
    const [plain, sound] = groups.layer;
    for (const name of PARTICLE_LAYER_METHODS) {
      expect(name in sound, `声音层没有 ${name}`).toBe(true);
      for (const object of [plain, ...groups.effect, ...groups.object.slice(2), ...groups.engine])
        expect(name in object, `${name} 出现在声音层之外`).toBe(false);
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
