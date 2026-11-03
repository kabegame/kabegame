import { describe, expect, it } from "vitest";
import type { SceneBundle, SceneLayer } from "../compile/bundle";
import type { SceneScript } from "../compile/scripts";
import { SceneState } from "../render/state";
import { ScriptApi } from "./api";
import { ScriptRuntime, type ScriptRealm } from "./runtime";

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
  global: Record<string, unknown> = { Object, Array };
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

function scene(): SceneBundle {
  const layer = (object: number, name: string): SceneLayer => ({
    id: object + 10,
    object,
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
    passes: [],
    colorBlendMode: 0,
    effects: [],
    passthrough: null,
  });
  return {
    general: {
      width: 1920,
      height: 1080,
      clearColor: [0, 0, 0],
      clearEnabled: true,
      camera: { eye: [0, 0, 1], center: [0, 0, 0], up: [0, 1, 0] },
      ambient: [0, 0, 0],
      skylight: [0, 0, 0],
      postprocess: { level: "enabled", bloom: true, hdr: false },
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
    layers: [layer(0, "First"), layer(1, "Second")],
    programs: [],
    textures: [],
    bloom: null,
    unsupported: [],
    bindings: [],
    scripts: { list: [] },
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

function setup() {
  const realm = new FakeRealm();
  let bundle = scene();
  let state = SceneState.fromBundle(bundle);
  let resolution: [number, number] = [800, 600];
  const recompiles: { path: string; value: number[] | boolean }[] = [];
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
      state.write({ property: "test", target }, Array.isArray(value) ? value.join(" ") : value);
      return true;
    },
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
      bundle = scene();
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
    for (const name of ["registerAudioBuffers", "registerAsset", "openUserShortcut", "requestFeatures"])
      expect(() => (engine[name] as () => void)()).toThrow(TypeError);
    expect(engine.AUDIO_RESOLUTION_16).toBeUndefined();
    expect(h.realm.global.input).toBeUndefined();
    expect(h.realm.global.localStorage).toBeUndefined();
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
    expect(seen).toEqual([h.api.layer(0), h.api.layer(0), null, h.api.general, h.api.layer(0)]);
    expect(h.realm.global.thisLayer).toBeNull();
    expect(h.realm.global.thisObject).toBeNull();
  });

  it("材质 uniform、effect 重编译、general 泛光与重编译目标", () => {
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
    h.api.enterScript(script("effect", { kind: "effect", object: 0, effect: 0 }, 0));
    const effect = h.realm.global.thisObject as Record<string, unknown>;
    effect.visible = false;
    effect.visible = false;
    expect(h.recompiles).toEqual([{ path: "objects/0/effects/0/visible", value: false }]);
    h.api.forgetRecompile("objects/0/effects/0/visible");
    effect.visible = false;
    expect(h.recompiles).toHaveLength(2);
    h.api.enterScript(script("general", { kind: "general" }, null));
    expect(h.realm.global.thisLayer).toBeNull();
    const general = h.realm.global.thisObject as Record<string, unknown>;
    general.bloomstrength = 1.5;
    general.bloomtint = new Vec3(0.2, 0.3, 0.4);
    expect(h.state.bloom.strength).toBe(1.5);
    expect(h.state.bloom.tint).toEqual([0.2, 0.3, 0.4]);
    general.clearcolor = new Vec3(1, 0, 0);
    expect(h.recompiles.at(-1)).toEqual({ path: "general/clearcolor", value: [1, 0, 0] });
  });
});
