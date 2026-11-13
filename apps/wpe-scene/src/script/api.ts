import {
  GENERAL_FIELDS,
  type BindingTarget,
  type GeneralKey,
  type UserProperty,
  type ValueType,
} from "../compile/bindings";
import type { SceneSpectrum } from "../audio/spectrum";
import { alignmentIndex, alignmentName } from "../compile/alignment";
import type { SceneBundle, SceneLayer } from "../compile/bundle";
import { constantTargetFields, materialSlots, type MaterialMember } from "../compile/materialValues";
import { BLOOM_FIELDS } from "../compile/postprocess";
import type { SceneScript } from "../compile/scripts";
import type { SceneState } from "../render/state";
import { scriptToString } from "../text/fields";
import type { VideoTexturePlayer } from "../video/player";
import { layerVideoSource } from "../video/sceneVideos";
import { copySpectrumToBuffers, type AudioBuffers } from "./audio";
import type { ScriptRealm, ScriptRuntime, ScriptValue } from "./runtime";
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
  /** 普通目标由宿主写入 SceneState；重编译目标由宿主合并请求。字符串只在文本目标上（P6b 1e）。 */
  write(target: ApiTarget, value: ScriptValue): boolean;
  read?(target: ApiTarget): ScriptValue | null;
  /** 脚本注册了音频缓冲：宿主据此订阅音频。语料与 `realmCheck` 不传，缓冲保持全零。 */
  audioRegistered?(): void;
  /**
   * 声音对象的排期器（P6a 步骤 2，宿主从 `SceneSounds` 取）：声音层的 `play` / `pause` / `stop` / `isPlaying` 接到它上面。
   * 不传或返回 null（没有播放器、场景已退回）时方法什么都不做，`isPlaying` 为假。
   */
  sound?(object: number): SoundScriptTarget | null;
  /**
   * 视频纹理的播放器（P9b，宿主按图层槽 0 视频的区间从 `SceneVideos` 现取）：`IVideoTexture` 的方法接到它上面。
   * 不传或返回 null（语料诊断、播放器已释放）时方法空操作，`duration` 退回 bundle 里的容器时长。
   */
  video?(object: number): VideoScriptTarget | null;
}

/** `IVideoTexture` 的落点（P9b，`VideoTexturePlayer` 满足它）。 */
export type VideoScriptTarget = Pick<
  VideoTexturePlayer,
  "rate" | "loop" | "currentTime" | "duration" | "play" | "pause" | "stop" | "isPlaying" | "addEndedCallback"
>;

/** 声音层脚本方法的落点（`audio/scheduler.ts` 的 `SoundScheduler` 满足它）：WPE `ISoundLayer` 的四个方法。 */
export interface SoundScriptTarget {
  play(): void;
  pause(): void;
  stop(): void;
  isPlaying(): boolean;
}

const DEGREE = 0.017453292;
const LAYER_FIELDS = ["origin", "scale", "angles", "alpha", "color", "visible", "brightness", "parallaxDepth"] as const;

/**
 * 脚本 realm 里的 WPE API。WPE 有、这里还没实现的成员登记在 `compile/scriptApi.ts` 的 `MISSING_SCRIPT_API`，
 * 编译期据此报 `script:api:*`、整张退回预览图；实现一个就从表里删一个（`api.test.ts` 双向核对）。
 */
export class ScriptApi {
  private current: SceneScript | null = null;
  private evaluating = false;
  private properties: ReadonlyMap<string, UserProperty> = new Map();
  private convertedProperties: Record<string, unknown> | null = null;
  private runtime: Pick<ScriptRuntime, "setTimeout" | "setInterval" | "clearTimeout" | "callFor"> | null = null;
  private readonly layers = new Map<number, ApiObject>();
  /** 图层的 `IVideoTexture`（P9b）：每个图层建一次，之后 `getVideoTexture()` 返回同一个对象（WPE 的 `L+0x4c0`）。 */
  private readonly videoTextures = new Map<number, ApiObject>();
  private readonly materials = new Map<string, ApiObject>();
  private readonly effects = new Map<string, ApiObject>();
  private readonly recompileValues = new Map<string, string>();
  /**
   * `engine.registerAudioBuffers` 的缓冲：同一分辨率返回同一个对象，由这里持有。`applySpectrum` 每帧把场景频谱（归一化后的）
   * 原地写进 `arrays`（P4e 步骤 4）；没有音频时频谱全零，相当于 WPE 里没有声音在放。`api` 是脚本拿到的对象，脚本可以改写
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

  attachRuntime(runtime: Pick<ScriptRuntime, "setTimeout" | "setInterval" | "clearTimeout" | "callFor">): void {
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
  /**
   * 把场景频谱拷进全部已注册分辨率的缓冲（P4e 步骤 4，「决定」5），脚本持有的数组不变。宿主每个实时帧在脚本之前调（渲染器推进频谱之后，
   * `SceneRendererOptions.beforeFrame`），暂停时不调、缓冲保持最后的值（同 WPE 整帧跳过时频谱冻结）。
   */
  applySpectrum(spectrum: Pick<SceneSpectrum, "block">): void {
    for (const [resolution, { arrays }] of this.audioBufferCache)
      copySpectrumToBuffers(spectrum.block(resolution as 16 | 32 | 64), arrays);
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
          // `parallaxDepth` 是 Vec2（P5a 步骤 2，WPE 声明 `parallaxDepth: Vec2`），其余向量是 Vec3
          if (Array.isArray(value))
            return this.vector(
              field === "angles" ? value.map((part) => part / DEGREE) : value,
              field === "parallaxDepth" ? 2 : 3,
            );
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
                  : field === "parallaxDepth"
                    ? "vec2"
                    : "vec3",
          );
        },
      );
    }
    if (this.isSoundLayer(index)) this.installSound(api, index);
    if (this.findLayer(index)?.alignment !== undefined) this.installAlignment(api, index);
    // 视频纹理（P9b，决定 6）：所有图层都有这个方法，不是视频图层时返回 null
    this.method(api, "getVideoTexture", () => this.videoTexture(index));
    this.layers.set(object, api);
    return api;
  }

  /**
   * 图像层的 `alignment`（P8 步骤 3，rea-p8-layer 2.4，p8-REPORT `p8-par` 的 T）：只装在图像层上（`SceneLayer.alignment` 有值；WPE 的描述符
   * 只在图像层的属性表里，`IImageLayer.alignment: String`），别的图层上照旧是普通属性。读返回名字（WPE `0x140212610`）；写字符串查表、
   * 查不到或不是字符串写 `center`（`0x140212530`，`p8-par` 写数字 2 读回 `"center"`），以下标交给宿主（`[下标]`，重放表也存这个形状），
   * `SceneState` 就地重算偏移、标脏，同帧生效。
   */
  private installAlignment(api: ApiObject, object: number): void {
    this.define(
      api,
      "alignment",
      () => alignmentName(this.access.state().layers.get(object)?.alignment),
      (value) => this.write({ kind: "layer", object, field: "alignment" }, alignmentIndex(value), "float"),
    );
  }

  /** 是不是声音对象的图层：声音表里有它（对象类别跨重编译不变，图层代理建一次就定）。 */
  private isSoundLayer(object: number): boolean {
    return this.access.bundle().sounds?.some((sound) => sound.object === object) ?? false;
  }

  /**
   * 声音层的 `ISoundLayer`（P6a 步骤 2，rea-p6a-sound.md 第 7 节）：只登记在声音对象的图层上（WPE 的方法表按对象类型登记），
   * 其它图层上调用照旧是 `TypeError`；粒子层的同名方法是 P4f 的事（编译期另报 `script:api:particle.<名>`）。
   * 四个方法直接接到排期器（`play` = `P`、`stop` = `X`），
   * `volume` 读 `SceneState.sounds`、写落到就地目标 `{ kind: "sound" }`，不钳制（增益在乘积上钳，`audio/scheduler.ts`），
   * 宿主写完当场交给排期器（WPE 的回调 `V`，暂停时也生效）。
   */
  private installSound(api: ApiObject, object: number): void {
    const target = () => this.access.sound?.(object) ?? null;
    this.method(api, "play", () => {
      target()?.play();
    });
    this.method(api, "pause", () => {
      target()?.pause();
    });
    this.method(api, "stop", () => {
      target()?.stop();
    });
    this.method(api, "isPlaying", () => target()?.isPlaying() ?? false);
    this.define(
      api,
      "volume",
      () => this.access.state().sounds.get(object)?.volume,
      (value) => this.write({ kind: "sound", object, field: "volume" }, value, "float"),
    );
  }

  /**
   * 图层的 `IVideoTexture`（P9b，rea-p9-video 第 6 节，类型与顺序照 p9-REPORT「P9b 步骤 0 的补测」）。基础材质槽 0 是视频纹理时
   * 第一次调用建包装对象并缓存，之后返回同一个；不是视频图层时返回 null、不缓存（「是不是视频」只看 bundle，`layerVideoSource`）。
   * 包装对象不持有播放器：每次调用经 `access.video` 按区间现取，没有落点（语料诊断、播放器已释放）时方法空操作。
   * 自有属性按 WPE 的 `Object.keys` 顺序逐个定义，都可枚举：
   * - `duration`：只读访问器（严格模式下写入抛 TypeError），落点时长的 float32；没有落点时取 bundle 里的容器时长，再没有 0。
   * - `loop` / `rate`：包装对象自己的字段（WPE 的 `V+0xec` / `V+0xe8`），读只返回字段、不问播放器；写入转换后存字段并转给落点。
   *   `loop` 读出数字 1 / 0（实测，和 WPE 自带的 `.d.ts` 不同），`rate` 是 float32、写入不是有限数时不写。
   * - `addEndedCallback`：登记时记下当前脚本，触发时经运行时 `callFor` 进入那段脚本的上下文、不带参数调用。
   * - `getAnimation`：返回 undefined（WPE 有这个成员）。
   */
  private videoTexture(object: number): ApiObject | null {
    if (!layerVideoSource(this.access.bundle(), object)) return null;
    let api = this.videoTextures.get(object);
    if (api) return api;
    api = this.object();
    const target = () => this.access.video?.(object) ?? null;
    let loop = true;
    let rate = 1;
    this.define(api, "duration", () => {
      const player = target();
      return Math.fround(player ? player.duration : (layerVideoSource(this.access.bundle(), object)?.duration ?? 0));
    });
    this.define(
      api,
      "loop",
      () => (loop ? 1 : 0),
      (value) => {
        loop = Boolean(value);
        const player = target();
        if (player) player.loop = loop;
      },
    );
    this.define(
      api,
      "rate",
      () => rate,
      (value) => {
        const next = Math.fround(Number(value));
        if (!Number.isFinite(next)) return;
        rate = next;
        // 负数、超出 Chromium 范围由播放器处理（钳到 0 / 保持原速率）；字段照存，同 WPE 读只返回字段
        const player = target();
        if (player) player.rate = next;
      },
    );
    this.method(api, "addEndedCallback", (callback: unknown) => {
      if (typeof callback !== "function") throw new TypeError("addEndedCallback 需要回调函数");
      // 登记到当时取得的落点上（播放器跨重编译按区间复用，登记过的回调跟着它走）；没有落点时没有东西会结束，不登记。
      // 回调经运行时调用：进入登记它的那段脚本的上下文、计时，出错只记诊断、不禁用，同计时器
      const owner = this.current?.id;
      const player = target();
      if (!player || owner === undefined) return;
      player.addEndedCallback(() => this.runtime?.callFor(owner, () => (callback as () => unknown)()));
    });
    this.method(api, "play", () => {
      target()?.play();
    });
    this.method(api, "setCurrentTime", (time: unknown) => {
      const player = target();
      if (player) player.currentTime = Number(time);
    });
    this.method(api, "isPlaying", () => target()?.isPlaying() ?? false);
    this.method(api, "stop", () => {
      target()?.stop();
    });
    this.method(api, "pause", () => {
      target()?.pause();
    });
    this.method(api, "getCurrentTime", () => {
      const player = target();
      return player ? Math.fround(player.currentTime) : 0;
    });
    this.method(api, "getAnimation", () => undefined);
    this.videoTextures.set(object, api);
    return api;
  }

  private object(): ApiObject {
    // 普通对象，不是 `create(null)`：WPE 的 `String(thisObject)` 是 `[object Object]`，没有原型时会抛 TypeError
    return new (this.realm.global.Object as ObjectConstructor)() as ApiObject;
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
  private write(target: ApiTarget, raw: unknown, type: ValueType | "string"): void {
    let value: ScriptValue;
    if (type === "bool") {
      if (typeof raw !== "boolean") return;
      value = raw;
    } else if (type === "string") {
      // 字符串只交给文本目标（P6b 1e，同运行时的 `writeReturn`）：WPE 类型 5 的 `ToString`，`null` / `undefined` 与抛错的不写
      if (target.kind !== "text") return;
      const text = scriptToString(raw);
      if (text === undefined) return;
      value = text;
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
    const names = new Map<string, { uniforms: string[]; type: ValueType; members?: MaterialMember[] }>();
    const bundle = this.access.bundle();
    const passes = bundle.layers.flatMap((layer) => [
      ...layer.passes,
      ...layer.effects.flatMap((effect) => effect.steps.flatMap((step) => (step.kind === "draw" ? [step.pass] : []))),
    ]);
    const current = passes.find((item) => item.key === pass);
    const program =
      current?.program === null || current?.program === undefined ? null : bundle.programs[current.program];
    // 每个材质键一个字段：形状取这个键 setter 的类型，写回按各格的取值方式（`materialValues.ts`）
    for (const slot of materialSlots(program?.uniforms ?? []))
      if (slot.material) names.set(slot.material, constantTargetFields(slot));
    // FakeRealm 单测没有翻译器结果；真实 bundle 以 meta.material 为准。
    if (!program)
      for (const script of bundle.scripts.list)
        if (script.owner.kind === "material" && script.owner.pass === pass && script.target.kind === "constant")
          names.set(script.target.material, {
            uniforms: script.target.uniforms,
            type: script.target.type,
            members: script.target.members,
          });
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
