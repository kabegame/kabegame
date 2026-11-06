import {
  GENERAL_FIELDS,
  valueTypeOf,
  type BindingTarget,
  type GeneralKey,
  type UserProperty,
  type ValueType,
} from "../compile/bindings";
import type { SceneBundle, SceneLayer } from "../compile/bundle";
import { BLOOM_FIELDS } from "../compile/postprocess";
import type { SceneScript } from "../compile/scripts";
import type { SceneState } from "../render/state";
import { fillAudioBuffers, type AudioBuffers } from "./audio";
import type { ScriptRealm, ScriptRuntime } from "./runtime";
import { createMemoryStorage, LOCATION_GLOBAL, LOCATION_SCREEN, SceneScriptStorage } from "./storage";

type ApiObject = Record<string, unknown>;
type ApiTarget = BindingTarget | { kind: "unsupported"; path: string };

/** 模块求值期间调用 scoped 方法 / 访问 scoped 属性时抛错（`ScriptApi` 与 WPE `localStorage` 共用）。 */
export function requireCallbackContext(name: string, evaluating: boolean): void {
  if (evaluating) throw new Error(`${name} 不能在模块求值期间访问`);
}

/**
 * 造挂在场景子 frame 全局上的 WPE `localStorage`：成员只有 `get` / `set` / `delete` / `clear` 与两个位置常量，
 * 没有 `remove`（报告 A；样本调 `remove` 照样报 `TypeError`）。四个方法在模块求值期间调用抛错（报告 D）。
 * `get` 用子 frame 的 `JSON.parse` 造值，脚本里 `instanceof Array` 才为真。
 */
export function createWpeLocalStorage(input: {
  global: Record<string, unknown>;
  /** 宿主的 `Storage`；null = 只存在内存里（宿主没有图片 id，或读不到浏览器存储）。 */
  backend: Storage | null;
  sceneKey: string;
  isEvaluating: () => boolean;
  debug?: (message: string) => void;
}): object {
  const object = input.global.Object as ObjectConstructor;
  const storage = new SceneScriptStorage(input.backend ?? createMemoryStorage(), input.sceneKey, {
    parse: (text) => (input.global.JSON as JSON).parse(text),
    debug: input.debug,
  });
  const api = object.create(null) as Record<string, unknown>;
  const define = (name: string, value: unknown) =>
    object.defineProperty(api, name, { value, enumerable: true, writable: false, configurable: false });
  const method = (name: string, run: (...args: unknown[]) => unknown) =>
    define(name, (...args: unknown[]) => {
      requireCallbackContext(`localStorage.${name}`, input.isEvaluating());
      return run(...args);
    });
  const locationOf = (value: unknown) => (typeof value === "number" ? value : LOCATION_SCREEN);
  method("get", (key, location) => storage.get(String(key), locationOf(location)));
  method("set", (key, value, location) => storage.set(String(key), value, locationOf(location)));
  method("delete", (key, location) => storage.delete(String(key), locationOf(location)));
  method("clear", (location) => storage.clear(locationOf(location)));
  define("LOCATION_GLOBAL", LOCATION_GLOBAL);
  define("LOCATION_SCREEN", LOCATION_SCREEN);
  return api;
}

export interface ScriptApiState {
  bundle(): SceneBundle;
  state(): SceneState;
  screenResolution(): readonly [number, number];
  frametime(): number;
  runtime(): number;
  timeOfDay(): number;
  /** 普通目标由宿主写入 SceneState；重编译目标由宿主合并请求。 */
  write(target: ApiTarget, value: number[] | boolean): boolean;
  read?(target: ApiTarget): number[] | boolean | null;
  /** 脚本注册了音频缓冲：宿主据此订阅音频。语料与 `realmCheck` 不传，缓冲保持全零。 */
  audioRegistered?(): void;
}

const DEGREE = 0.017453292;
const LAYER_FIELDS = ["origin", "scale", "angles", "alpha", "color", "visible", "brightness"] as const;

export class ScriptApi {
  private current: SceneScript | null = null;
  private evaluating = false;
  private properties: ReadonlyMap<string, UserProperty> = new Map();
  private convertedProperties: Record<string, unknown> | null = null;
  private runtime: Pick<ScriptRuntime, "setTimeout" | "setInterval" | "clearTimeout"> | null = null;
  private readonly layers = new Map<number, ApiObject>();
  private readonly materials = new Map<string, ApiObject>();
  private readonly effects = new Map<string, ApiObject>();
  private readonly recompileValues = new Map<string, string>();
  /**
   * `engine.registerAudioBuffers` 的缓冲：同一分辨率返回同一个对象，由这里持有。`applyAudioFrame` 把宿主收到的
   * 音频原地写进 `arrays`；没有音频时保持全零，相当于 WPE 里没有声音在放。`api` 是脚本拿到的对象，脚本可以改写
   * 它的字段，所以写入只认 `arrays`。
   */
  private readonly audioBufferCache = new Map<number, { api: ApiObject; arrays: AudioBuffers }>();
  /** 每段脚本写到重编译目标的次数（dev 探针诊断用）。 */
  readonly recompileWrites = new Map<string, number>();
  readonly engine: ApiObject;
  readonly thisScene: ApiObject;
  readonly general: ApiObject;

  constructor(
    private readonly realm: ScriptRealm,
    private readonly access: ScriptApiState,
  ) {
    this.engine = this.object();
    this.thisScene = this.object();
    this.general = this.object();
    this.installEngine();
    this.installScene();
    // general 字段在 `thisScene` 上也有（K5），和挂在 general 上的脚本的 `thisObject` 读写同一份
    this.installGeneral(this.general);
    this.installGeneral(this.thisScene);
    this.realm.global.engine = this.engine;
    this.realm.global.thisScene = this.thisScene;
    this.define(this.realm.global, "thisLayer", () => {
      if (!this.current) return null;
      // 挂在 general 上的脚本没有图层，`thisLayer` 就是 `thisObject`（L14）
      return this.current.layer === null ? this.owner() : this.layer(this.current.layer);
    });
    this.define(this.realm.global, "thisObject", () => this.owner());
  }

  attachRuntime(runtime: Pick<ScriptRuntime, "setTimeout" | "setInterval" | "clearTimeout">): void {
    this.runtime = runtime;
  }
  enterScript(script: SceneScript | null): void {
    this.current = script;
  }
  setModuleEvaluating(evaluating: boolean): void {
    this.evaluating = evaluating;
  }
  /** 是否正在求值模块：realm 里挂的 WPE `localStorage` 用它做作用域检查。 */
  get moduleEvaluating(): boolean {
    return this.evaluating;
  }
  setProperties(full: ReadonlyMap<string, UserProperty>): void {
    this.properties = full;
    this.convertedProperties = null;
  }
  /** 用户绑定改变重编译目标后，下一次脚本写同一值仍需重新提交。 */
  forgetRecompile(path: string): void {
    this.recompileValues.delete(path);
  }
  /** 把 Hub 的一帧写进全部已注册分辨率的缓冲，脚本持有的数组不变。 */
  applyAudioFrame(frame: ArrayLike<number>): void {
    for (const { arrays } of this.audioBufferCache.values()) fillAudioBuffers(frame, arrays);
  }
  /** 已注册的音频分辨率，从小到大（dev 探针 `host.audio()` 用）。 */
  get audioResolutions(): number[] {
    return [...this.audioBufferCache.keys()].sort((a, b) => a - b);
  }
  /** 同一 objects 下标对应同一 API 对象，重编译只替换访问层里的 bundle 与 state。 */
  layer(object: number): ApiObject | null {
    if (!this.findLayer(object)) return null;
    let api = this.layers.get(object);
    if (api) return api;
    api = this.object();
    const index = object;
    this.define(api, "name", () => this.findLayer(index)?.name ?? "");
    this.define(api, "id", () => this.findLayer(index)?.id ?? -1);
    this.define(
      api,
      "size",
      () => this.vector(this.findLayer(index)?.size ?? [0, 0], 2),
      () => {},
    );
    for (const field of LAYER_FIELDS) {
      this.define(
        api,
        field,
        () => {
          const value = this.access.state().layers.get(index)?.[field];
          if (Array.isArray(value))
            return this.vector(field === "angles" ? value.map((part) => part / DEGREE) : value, 3);
          return value;
        },
        (value) => {
          const target: ApiTarget = { kind: "layer", object: index, field };
          this.write(
            target,
            value,
            field === "angles"
              ? "angles"
              : field === "visible"
                ? "bool"
                : field === "alpha" || field === "brightness"
                  ? "float"
                  : "vec3",
          );
        },
      );
    }
    this.layers.set(object, api);
    return api;
  }

  private object(): ApiObject {
    const object = this.realm.global.Object as typeof Object;
    return object.create(null) as ApiObject;
  }
  private define(object: ApiObject, name: string, get: () => unknown, set?: (value: unknown) => void): void {
    (this.realm.global.Object as typeof Object).defineProperty(object, name, {
      enumerable: true,
      get,
      ...(set ? { set } : {}),
    });
  }
  private method(object: ApiObject, name: string, fn: (...args: never[]) => unknown, scoped = false): void {
    this.define(object, name, () => (...args: never[]) => {
      if (scoped) this.requireCallback(name);
      return fn(...args);
    });
  }
  private requireCallback(name: string): void {
    requireCallbackContext(name, this.evaluating);
  }
  /** 与 `requireCallback` 相反：只能模块顶层调用的 API（报告 D）。 */
  private requireEvaluating(name: string): void {
    if (!this.evaluating) throw new Error(`${name} 只能在模块求值期间调用`);
  }
  private vector(values: readonly number[], size: 2 | 3 | 4): unknown {
    const prototype = this.realm.prototypes[`Vec${size}`];
    const ctor = (prototype as { constructor: new (...values: number[]) => unknown }).constructor;
    return new ctor(...values.slice(0, size));
  }
  private array(values: unknown[]): unknown[] {
    const ctor = this.realm.global.Array as ArrayConstructor;
    return ctor.from(values);
  }
  /** 初始全零的 `{ left, right, average }`，元素是 realm 的 `Float32Array`；同一分辨率返回同一个对象。 */
  private audioBuffer(resolution: unknown): ApiObject {
    if (resolution !== 16 && resolution !== 32 && resolution !== 64)
      throw new TypeError(`registerAudioBuffers 只接受 16、32、64，收到 ${String(resolution)}`);
    const size = resolution as 16 | 32 | 64;
    const cached = this.audioBufferCache.get(size);
    if (cached) return cached.api;
    const ctor = this.realm.global.Float32Array as Float32ArrayConstructor;
    const arrays: AudioBuffers = { left: new ctor(size), right: new ctor(size), average: new ctor(size) };
    const api = this.object();
    api.left = arrays.left;
    api.right = arrays.right;
    api.average = arrays.average;
    this.audioBufferCache.set(size, { api, arrays });
    return api;
  }
  private findLayer(object: number): SceneLayer | undefined {
    return this.access.bundle().layers.find((layer) => layer.object === object);
  }
  private write(target: ApiTarget, raw: unknown, type: ValueType): void {
    let value: number[] | boolean;
    if (type === "bool") {
      if (typeof raw !== "boolean") return;
      value = raw;
    } else {
      const size = type === "float" ? 1 : type === "vec2" ? 2 : type === "vec4" ? 4 : 3;
      if (typeof raw === "number") value = Array(size).fill(raw);
      else if (raw && typeof raw === "object") {
        const parts = ["x", "y", "z", "w"].slice(0, size).map((key) => (raw as ApiObject)[key]);
        if (!parts.every((part) => typeof part === "number")) return;
        value = parts as number[];
      } else return;
      if (type === "angles") value = value.map((part) => part * DEGREE);
    }
    if (target.kind === "recompile") {
      const id = this.current?.id ?? "<module>";
      this.recompileWrites.set(id, (this.recompileWrites.get(id) ?? 0) + 1);
      const encoded = JSON.stringify(value);
      if (this.recompileValues.get(target.path) === encoded) return;
      if (this.access.write(target, value)) this.recompileValues.set(target.path, encoded);
      return;
    }
    this.access.write(target, value);
  }
  private owner(): ApiObject | null {
    const owner = this.current?.owner;
    if (!owner) return null;
    if (owner.kind === "layer") return this.layer(owner.object);
    if (owner.kind === "general") return this.general;
    if (owner.kind === "effect") return this.effect(owner.object, owner.effect);
    return this.material(owner.pass);
  }

  private installEngine(): void {
    const scoped = (name: string, get: () => unknown) =>
      this.define(this.engine, name, () => {
        this.requireCallback(name);
        return get();
      });
    scoped("frametime", () => this.access.frametime());
    scoped("runtime", () => this.access.runtime());
    scoped("timeOfDay", () => this.access.timeOfDay());
    scoped("canvasSize", () =>
      this.vector([this.access.bundle().general.width, this.access.bundle().general.height], 2),
    );
    scoped("screenResolution", () => this.vector(this.access.screenResolution(), 2));
    scoped("userProperties", () => {
      if (!this.convertedProperties)
        this.convertedProperties = this.realm.internal.convertUserProperties(
          JSON.stringify(Object.fromEntries(this.properties)),
        );
      return this.convertedProperties;
    });
    this.method(this.engine, "isRunningInEditor", () => false);
    this.method(this.engine, "isMobileDevice", () => false);
    this.method(this.engine, "isDesktopDevice", () => true);
    this.method(this.engine, "isWallpaper", () => true);
    this.method(this.engine, "isScreensaver", () => false);
    this.method(
      this.engine,
      "isPortrait",
      () => {
        const [width, height] = this.access.screenResolution();
        return height > width;
      },
      true,
    );
    this.method(
      this.engine,
      "isLandscape",
      () => {
        const [width, height] = this.access.screenResolution();
        return width >= height;
      },
      true,
    );
    this.method(
      this.engine,
      "isObjectValid",
      (value: unknown) =>
        [...this.layers.entries()].some(([index, layer]) => layer === value && !!this.findLayer(index)) ||
        value === this.general ||
        [...this.materials.entries()].some(
          ([pass, object]) => object === value && this.access.state().constants.has(pass),
        ) ||
        [...this.effects.entries()].some(([key, object]) => {
          if (object !== value) return false;
          const [layer, effect] = key.split("/").map(Number);
          return this.findLayer(layer)?.effects.some((item) => item.source === effect) ?? false;
        }),
    );
    this.engine.AUDIO_RESOLUTION_16 = 16;
    this.engine.AUDIO_RESOLUTION_32 = 32;
    this.engine.AUDIO_RESOLUTION_64 = 64;
    // 只能在模块顶层调（报告 D），回调里调用抛错；只收 16 / 32 / 64，其它值抛 TypeError
    this.method(this.engine, "registerAudioBuffers", (resolution: unknown) => {
      this.requireEvaluating("registerAudioBuffers");
      const buffers = this.audioBuffer(resolution);
      this.access.audioRegistered?.();
      return buffers;
    });
    this.method(
      this.engine,
      "setTimeout",
      (callback: unknown, delay = 0) => {
        if (typeof callback !== "function") throw new TypeError("setTimeout 需要回调函数");
        if (!this.runtime) throw new Error("脚本运行时尚未连接");
        return this.runtime.setTimeout(callback as () => void, Number(delay));
      },
      true,
    );
    this.method(
      this.engine,
      "setInterval",
      (callback: unknown, delay = 0) => {
        if (typeof callback !== "function") throw new TypeError("setInterval 需要回调函数");
        if (!this.runtime) throw new Error("脚本运行时尚未连接");
        return this.runtime.setInterval(callback as () => void, Number(delay));
      },
      true,
    );
    this.method(
      this.engine,
      "clearTimeout",
      (cancel: unknown) => {
        if (typeof cancel !== "function") throw new TypeError("clearTimeout 需要取消函数");
        this.runtime?.clearTimeout(cancel as () => void);
      },
      true,
    );
  }

  private installScene(): void {
    this.method(
      this.thisScene,
      "getLayer",
      (name: unknown) => {
        const layers = this.access.bundle().layers;
        const layer =
          typeof name === "number"
            ? layers.find((item) => item.object === name)
            : layers.find((item) => item.name === name);
        return layer ? this.layer(layer.object) : null;
      },
      true,
    );
    this.method(this.thisScene, "getLayerCount", () => this.access.bundle().layers.length, true);
    this.method(
      this.thisScene,
      "enumerateLayers",
      () => this.array(this.access.bundle().layers.map((layer) => this.layer(layer.object))),
      true,
    );
    this.method(
      this.thisScene,
      "getLayerIndex",
      (value: unknown) =>
        this.access.bundle().layers.find((layer) => this.layer(layer.object) === value || layer.name === value)
          ?.object ?? -1,
      true,
    );
  }

  private material(pass: string): ApiObject {
    let api = this.materials.get(pass);
    if (api) return api;
    api = this.object();
    const names = new Map<string, { uniforms: string[]; type: ValueType }>();
    const bundle = this.access.bundle();
    const passes = bundle.layers.flatMap((layer) => [
      ...layer.passes,
      ...layer.effects.flatMap((effect) => effect.steps.flatMap((step) => (step.kind === "draw" ? [step.pass] : []))),
    ]);
    const current = passes.find((item) => item.key === pass);
    const program =
      current?.program === null || current?.program === undefined ? null : bundle.programs[current.program];
    for (const uniform of program?.uniforms ?? []) {
      const name = uniform.meta?.material;
      if (typeof name !== "string" || !name) continue;
      const shape = names.get(name) ?? { uniforms: [], type: valueTypeOf(uniform) };
      shape.uniforms.push(uniform.name);
      names.set(name, shape);
    }
    // FakeRealm 单测没有翻译器结果；真实 bundle 以 meta.material 为准。
    if (!program)
      for (const script of bundle.scripts.list)
        if (script.owner.kind === "material" && script.owner.pass === pass && script.target.kind === "constant")
          names.set(script.target.material, { uniforms: script.target.uniforms, type: script.target.type });
    for (const [name, shape] of names)
      this.define(
        api,
        name,
        () => {
          const target: ApiTarget = { kind: "constant", pass, material: name, ...shape };
          const values = this.access.read?.(target) ?? this.access.state().constants.get(pass)?.[shape.uniforms[0]];
          return Array.isArray(values)
            ? values.length === 1
              ? values[0]
              : this.vector(values, values.length as 2 | 3 | 4)
            : values;
        },
        (value) => this.write({ kind: "constant", pass, material: name, ...shape }, value, shape.type),
      );
    this.materials.set(pass, api);
    return api;
  }
  private effect(object: number, effect: number): ApiObject {
    const key = `${object}/${effect}`;
    let api = this.effects.get(key);
    if (api) return api;
    api = this.object();
    this.define(
      api,
      "visible",
      () => this.access.state().effectEnabled(object, effect),
      (value) => this.write({ kind: "effect", object, effect }, value, "bool"),
    );
    this.effects.set(key, api);
    return api;
  }
  private installGeneral(object: ApiObject): void {
    // `bloom` 是运行时状态，不走重编译
    this.define(
      object,
      "bloom",
      () => this.access.state().bloomEnabled,
      (value) => this.write({ kind: "bloom-enabled" }, value, "bool"),
    );
    for (const [name, field] of Object.entries(BLOOM_FIELDS))
      this.define(
        object,
        name,
        () => {
          const value = this.access.state().bloom[field as keyof SceneState["bloom"]];
          return Array.isArray(value) ? this.vector(value, 3) : value;
        },
        (value) =>
          this.write(
            { kind: "bloom", field: field as keyof SceneState["bloom"] },
            value,
            name.endsWith("tint") ? "vec3" : "float",
          ),
      );
    // WPE 里只改字段的属性（L1）：不走重编译。vec3 每次读都是新的 `Vec3`，改它不影响字段（L14）
    for (const key of Object.keys(GENERAL_FIELDS) as GeneralKey[])
      this.define(
        object,
        key,
        () => {
          const value = this.access.state().general[key];
          return Array.isArray(value) ? this.vector(value, 3) : value;
        },
        (value) => this.write({ kind: "general", key }, value, GENERAL_FIELDS[key].type),
      );
    // 只有 `hdr` 保留整场重编译（已定 12），读场景位
    this.define(
      object,
      "hdr",
      () => this.access.bundle().general.postprocess.hdrFlag,
      (value) => this.write({ kind: "recompile", reason: "postprocess-hdr", path: "general/hdr" }, value, "bool"),
    );
  }
}
