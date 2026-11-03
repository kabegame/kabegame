import { valueTypeOf, type BindingTarget, type UserProperty, type ValueType } from "../compile/bindings";
import type { SceneBundle, SceneLayer } from "../compile/bundle";
import type { SceneScript } from "../compile/scripts";
import type { SceneState } from "../render/state";
import type { ScriptRealm, ScriptRuntime } from "./runtime";

type ApiObject = Record<string, unknown>;
type ApiTarget = BindingTarget | { kind: "unsupported"; path: string };

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
}

const DEGREE = 0.017453292;
const LAYER_FIELDS = ["origin", "scale", "angles", "alpha", "color", "visible", "brightness"] as const;
const BLOOM_FIELDS = {
  bloomstrength: "strength",
  bloomthreshold: "threshold",
  bloomtint: "tint",
  bloomhdrstrength: "hdrStrength",
  bloomhdrthreshold: "hdrThreshold",
  bloomhdrfeather: "hdrFeather",
  bloomhdrscatter: "hdrScatter",
  bloomhdriterations: "hdrIterations",
} as const;
const GENERAL_RECOMPILE = new Set([
  "bloom",
  "hdr",
  "clearenabled",
  "clearcolor",
  "ambientcolor",
  "skylightcolor",
  "fov",
  "nearz",
  "farz",
  "camerafade",
  "camerashake",
  "camerashakespeed",
  "camerashakeamplitude",
  "camerashakeroughness",
  "cameraparallax",
  "cameraparallaxamount",
  "cameraparallaxdelay",
  "cameraparallaxmouseinfluence",
]);

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
    this.installGeneral();
    this.realm.global.engine = this.engine;
    this.realm.global.thisScene = this.thisScene;
    this.define(this.realm.global, "thisLayer", () =>
      this.current?.layer === null || !this.current ? null : this.layer(this.current.layer),
    );
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
  setProperties(full: ReadonlyMap<string, UserProperty>): void {
    this.properties = full;
    this.convertedProperties = null;
  }
  /** 用户绑定改变重编译目标后，下一次脚本写同一值仍需重新提交。 */
  forgetRecompile(path: string): void {
    this.recompileValues.delete(path);
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
    if (this.evaluating) throw new Error(`${name} 不能在模块求值期间访问`);
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
      () =>
        this.access
          .bundle()
          .layers.find((layer) => layer.object === object)
          ?.effects.some((item) => item.source === effect) ?? false,
      (value) =>
        this.write(
          { kind: "recompile", reason: "effect-visible", path: `objects/${object}/effects/${effect}/visible` },
          value,
          "bool",
        ),
    );
    this.effects.set(key, api);
    return api;
  }
  private installGeneral(): void {
    for (const [name, field] of Object.entries(BLOOM_FIELDS))
      this.define(
        this.general,
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
    for (const name of GENERAL_RECOMPILE)
      this.define(
        this.general,
        name,
        () => {
          const general = this.access.bundle().general;
          const value =
            name === "clearcolor"
              ? general.clearColor
              : name === "ambientcolor"
                ? general.ambient
                : name === "skylightcolor"
                  ? general.skylight
                  : name === "clearenabled"
                    ? general.clearEnabled
                    : name === "bloom"
                      ? general.postprocess.bloom
                      : name === "hdr"
                        ? general.postprocess.hdr
                        : undefined;
          return Array.isArray(value) ? this.vector(value, 3) : value;
        },
        (value) =>
          this.write(
            { kind: "recompile", reason: "general", path: `general/${name}` },
            value,
            name.endsWith("color")
              ? "vec3"
              : name === "bloom" || name === "hdr" || name === "clearenabled"
                ? "bool"
                : "float",
          ),
      );
  }
}
