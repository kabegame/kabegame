import {
  GENERAL_FIELDS,
  TEXT_RUNTIME_FIELDS,
  type BindingTarget,
  type GeneralKey,
  type TextRuntimeField,
  type UserProperty,
  type ValueType,
} from "../compile/bindings";
import { AnimationClock } from "../animation/clock";
import type { AnimationControl } from "../animation/player";
import type { SceneAnimation } from "../animation/types";
import type { SceneSpectrum } from "../audio/spectrum";
import { alignmentIndex, alignmentName } from "../compile/alignment";
import type { SceneBundle, SceneLayer } from "../compile/bundle";
import { constantTargetFields, materialSlots, type MaterialMember } from "../compile/materialValues";
import { FLT_MAX, INSTANCE_CONTROL_POINT_KEYS, INSTANCE_FIELDS, instanceControlPoint } from "../compile/particles";
import { BLOOM_FIELDS } from "../compile/postprocess";
import type { SceneScript } from "../compile/scripts";
import { TEXT_ANCHORS } from "../compile/texts";
import type { SceneState } from "../render/state";
import { scriptToString } from "../text/fields";
import type { VideoTexturePlayer } from "../video/player";
import { layerVideoSource } from "../video/sceneVideos";
import { copySpectrumToBuffers, type AudioBuffers } from "./audio";
import { degreesFromScript, radiansToScript, scriptNumber, scriptNumbers } from "./f32";
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
  /**
   * 粒子对象的根系统（P4f 步骤 3，宿主从渲染器的场景取，`GpuScene.particleScript`）：粒子层的 `play` / `pause` / `stop` / `isPlaying` /
   * `emitParticles` 接到它上面。不传或返回 null（没有场景）时方法什么都不做，`isPlaying` 为假。
   */
  particles?(object: number): ParticleScriptTarget | null;
  /**
   * 关键帧动画的落点（P10b，宿主按脚本当前看到的 bundle 取播放器的那一条，`SceneAnimations.control`）：`IAnimation` 的成员接到它上面。
   * 不传或返回 null（语料诊断、播放器还没建）时方法空操作，只读成员取 bundle 里这一条的定义。
   */
  animation?(id: string): AnimationControl | null;
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

/**
 * 粒子层脚本方法的落点（P4f 步骤 3，`render/scene.ts` 的 `GpuScene.particleScript`）：WPE `IParticleSystem` 的五个方法，落到根
 * `ParticleSystem` 的 `scriptPlay` / `scriptPause` / `scriptStop` / `scriptIsPlaying` / `emitParticles`。`emitParticles` 收脚本的原始
 * 参数，归一化在模拟器里（`scriptEmitCount`）。
 */
export interface ParticleScriptTarget {
  play(): void;
  pause(): void;
  stop(): void;
  isPlaying(): boolean;
  emitParticles(count?: unknown): void;
}

/** `ITextLayer` 运行中字段在 API 写入时的类型（rea-p6b-layout 6.2；p6b-api / p6b-api-enum 实测，步骤 2 的表）。 */
const TEXT_API_TYPES: Record<TextRuntimeField, ValueType | "string"> = {
  text: "string",
  horizontalalign: "string", // 枚举：ToString 后查表，查不到取表里第一项（宿主 `textFieldFromScript`）
  verticalalign: "string",
  pointsize: "float",
  maxwidth: "float",
  maxrows: "float", // 宿主截断取整
  padding: "vec2",
  spacing: "vec2",
  limitwidth: "bool",
  limitrows: "bool",
  limituseellipsis: "bool",
  blockalign: "bool",
};

/** 路径的最后一段（`script.id` / 动画 `id` 的属性名）。 */
const lastSegment = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

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
  /** `IAnimation` 包装对象（P10b）：按动画 `id`（`scene.json` 路径）缓存，同一条每次 `getAnimation` 返回同一个对象。 */
  private readonly animationApis = new Map<string, ApiObject>();
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
    // `getAnimation`（P10b）：general 上的按 general 的属主找；不放进 installGeneral（它也装在 thisScene 上，那边是全场景查找）
    this.installGetAnimation(this.general, () => "general");
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
    // 图层字段与 `size` 的读取按 WPE 取单精度、角度按 f32 算法换成度（`f32.ts`，P3b 补测 `ignore/p3b-f32`）；状态照旧存 double
    this.define(
      api,
      "size",
      () => this.vector(scriptNumbers(this.findLayer(index)?.size ?? [0, 0]), 2),
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
              field === "angles" ? value.map((part) => radiansToScript(part)) : scriptNumbers(value),
              field === "parallaxDepth" ? 2 : 3,
            );
          return scriptNumber(value);
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
    if (this.findLayer(index)?.particle) this.installParticle(api, index);
    if (this.findLayer(index)?.alignment !== undefined) this.installAlignment(api, index);
    if (this.findLayer(index)?.text) this.installText(api, index);
    // 视频纹理（P9b，决定 6）：所有图层都有这个方法，不是视频图层时返回 null
    this.method(api, "getVideoTexture", () => this.videoTexture(index));
    this.installGetAnimation(api, () => `objects/${index}`);
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

  /**
   * 文本层的 `ITextLayer`（P6b 步骤 2）：只装在文本层上（WPE 的描述符只在文本对象的表里），12 个运行中字段。读 `textFields` 的当前值，
   * 按 WPE 读回的形状交出（float 按 f32、`padding` / `spacing` 是 Vec2）；写经 `write()` 落到 `{ kind: "text" }`，宿主规整后当帧重排。
   * 另装非运行中的 `font`、`opaquebackground`、`backgroundbrightness`、`anchor`（整场重编译）与 `backgroundcolor`（同属性绑定的目标，
   * LDR 下就地），见下（点 5）。
   */
  private installText(api: ApiObject, object: number): void {
    for (const field of TEXT_RUNTIME_FIELDS)
      this.define(
        api,
        field,
        () => {
          const value = this.access.state().textFields.get(object)?.[field];
          if (Array.isArray(value)) return this.vector(value, 2);
          return typeof value === "number" ? Math.fround(value) : value;
        },
        (value) => this.write({ kind: "text", object, field }, value, TEXT_API_TYPES[field]),
      );
    // 非运行中字段（点 5）：WPE 里写入当场生效，我们走整场重编译（`backgroundcolor` 就地时除外）。读回先看这个路径待生效的写入值
    const target = (key: string): ApiTarget => ({
      kind: "recompile",
      reason: "layer-structure",
      path: `objects/${object}/${key}`,
    });
    const pending = (path: string): unknown => {
      const encoded = this.recompileValues.get(path);
      return encoded === undefined ? undefined : JSON.parse(encoded);
    };
    const script = () => this.findLayer(object)?.text?.script;
    const recompiled = (key: string, compiled: () => unknown, type: "string" | "bool" | "float") =>
      this.define(
        api,
        key,
        () => {
          const value = pending(`objects/${object}/${key}`);
          if (value === undefined) return compiled();
          return type === "float" ? Math.fround((value as number[])[0]) : value;
        },
        (value) => this.write(target(key), value, type),
      );
    const fields = () => this.access.state().textFields.get(object);
    recompiled("font", () => fields()?.font, "string");
    recompiled("opaquebackground", () => fields()?.opaquebackground, "bool");
    recompiled("backgroundbrightness", () => Math.fround(script()?.backgroundbrightness ?? 1), "float");
    this.define(
      api,
      "anchor",
      () => pending(`objects/${object}/anchor`) ?? script()?.anchor,
      (value) => {
        // 枚举先在这里规整（ToString，查不到取表里第一项 none），重编译读到的就是名字
        const text = scriptToString(value);
        if (text === undefined) return;
        this.write(target("anchor"), (TEXT_ANCHORS as readonly string[]).includes(text) ? text : "none", "string");
      },
    );
    // `backgroundcolor` 的目标同属性绑定（编译期定）：就地的背景常量，或（HDR 下亮度不为 1）重编译
    this.define(
      api,
      "backgroundcolor",
      () => {
        const info = script();
        if (!info) return undefined;
        const goal = info.backgroundTarget;
        let value: unknown;
        if (goal.kind === "recompile") value = pending(goal.path);
        else if (goal.kind === "constant") value = this.access.state().constants.get(goal.pass)?.[goal.uniforms[0]];
        return this.vector((value as number[] | undefined) ?? info.backgroundcolor, 3);
      },
      (value) => {
        const goal = script()?.backgroundTarget;
        if (goal) this.write(goal, value, "vec3");
      },
    );
  }

  /** 是不是声音对象的图层：声音表里有它（对象类别跨重编译不变，图层代理建一次就定）。 */
  private isSoundLayer(object: number): boolean {
    return this.access.bundle().sounds?.some((sound) => sound.object === object) ?? false;
  }

  /**
   * 声音层的 `ISoundLayer`（P6a 步骤 2，rea-p6a-sound.md 第 7 节）：只登记在声音对象的图层上（WPE 的方法表按对象类型登记），
   * 其它图层上调用照旧是 `TypeError`；粒子层的同名方法另由 `installParticle` 登记在粒子对象上（P4f 步骤 3）。
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
    // TODO:[WPE_SCENE] 没实测：`volume` 读回仍是 double；图层字段与材质常量实测是 f32（P3b 补测 `ignore/p3b-f32`），这里大概率同样，
    // 测过再按 `f32.ts` 改
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

  /**
   * 粒子层的 `IParticleSystem`（P4f 步骤 3，rea-p4f-script.md 1.1–1.3）：只登记在粒子对象的图层上（WPE 的反射表 `FUN_14024cb00` 按对象
   * 类型登记，同 `installSound`），其它图层上调用照旧是 `TypeError`。子系统与事件实例脚本拿不到（1.5）。
   * - 五个方法接到宿主给的根系统（`ScriptApiState.particles`）：`play` / `pause` / `stop` / `isPlaying` / `emitParticles(count)`，都当场
   *   生效（语义见 `ParticleSystem.scriptPlay` 等）；`emitParticles` 把脚本的原始参数交过去，归一化在模拟器里（缺参数、0、非整数都是 1，
   *   负数不发）。没有落点时什么都不做，`isPlaying` 为假。
   * - `instance`：只读字段（`+0x60 = 2`；整体赋值忽略，同 `size`），值是一个固定的子对象（`particleInstance`），每次读都是同一个。
   */
  private installParticle(api: ApiObject, object: number): void {
    const target = () => this.access.particles?.(object) ?? null;
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
    this.method(api, "emitParticles", (count?: unknown) => {
      target()?.emitParticles(count);
    });
    const instance = this.particleInstance(object);
    this.define(
      api,
      "instance",
      () => instance,
      () => {},
    );
  }

  /**
   * 粒子层的 `instance` 子对象（P4f 步骤 3，rea-p4f-script.md 1.3、5.1，WPE `io` 的描述符 `0x1404e8860`，24 个字段、没有方法）：
   * - 读：`SceneState.particleInstances` 里的覆盖值（WPE 的 `io`，写完当场就能读回）。系数是数字；`colorn` 没设过是 (−1, −1, −1)；控制点
   *   `controlpointN` / `controlpointangleN` 没设过是 (FLT_MAX, 0, 0)（实测 `a-inst-cp`），读到的是覆盖值、不是控制点的实际位置。`rate`
   *   读到的是状态里的值：单写的原值，或重算 / 加载时钳过的值（5.2、5.4）。
   * - 写：经现有的就地目标 `particle-instance`（和用户属性、字段脚本同一个 setter）：系数按 float、`colorn` 与控制点按 vec3（数字铺满、
   *   `Vec3` / `{x, y, z}`），`controlpointangleN` 是弧度、不换算（`+0x60` 没有角度位，1.3）。除 `rate` 外置脏，下一帧开头重算（5.2、5.3）；
   *   `rate` 只改步进率（5.4，P4f 步骤 1 的单独路径）。同一段脚本里先写的系数对随后 `emitParticles` 的这批不生效（4.4）。
   * 没有这一层的状态时读到 undefined。
   *
   * TODO:[WPE_SCENE] 没实测：系数、`colorn`、控制点的读回仍是 double；图层字段与材质常量实测是 f32（P3b 补测 `ignore/p3b-f32`），
   * 这里大概率同样（`FLT_MAX` 本身是 f32 能表示的值），测过再按 `f32.ts` 改。
   */
  private particleInstance(object: number): ApiObject {
    const api = this.object();
    const values = () => this.access.state().particleInstances.get(object);
    for (const field of INSTANCE_FIELDS)
      this.define(
        api,
        field,
        () => values()?.[field],
        (value) => this.write({ kind: "particle-instance", object, field }, value, "float"),
      );
    this.define(
      api,
      "colorn",
      () => {
        const current = values();
        return current ? this.vector(current.colorn ?? [-1, -1, -1], 3) : undefined;
      },
      (value) => this.write({ kind: "particle-instance", object, field: "colorn" }, value, "vec3"),
    );
    for (const key of INSTANCE_CONTROL_POINT_KEYS) {
      const point = instanceControlPoint(key)!;
      this.define(
        api,
        key,
        () => {
          const current = values();
          if (!current) return undefined;
          const list = point.angle ? current.controlpointAngles : current.controlpoints;
          return this.vector(list[point.index] ?? [FLT_MAX, 0, 0], 3);
        },
        (value) => this.write({ kind: "particle-instance", object, field: key }, value, "vec3"),
      );
    }
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
      // 字符串只交给文本目标与重编译目标（`font`、`anchor`，P6b 步骤 2 点 5；1e 起同运行时的 `writeReturn`）：WPE 类型 5 的 `ToString`，
      // `null` / `undefined` 与抛错的不写
      if (target.kind !== "text" && target.kind !== "recompile") return;
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
      // 角度按 WPE 的 f32 乘法换成弧度（`f32.ts`）；其余数原样交给宿主（下一次读时再取 f32）
      if (type === "angles") value = value.map((part) => degreesFromScript(part));
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

  /** 模块求值期间调 `getAnimation` 抛 realm 的 SyntaxError，消息照 WPE（P10b 步骤 0 Q5）。 */
  private requireAnimationContext(): void {
    if (!this.evaluating) return;
    const Ctor = (this.realm.global.SyntaxError as ErrorConstructor | undefined) ?? SyntaxError;
    throw new Ctor("getAnimation cannot be called from global scope.");
  }

  /**
   * 对象上的 `getAnimation`（P10b，IObject）：装在图层、effect、材质、general 的 API 对象上（`thisScene` 的另见 `installScene`）。
   * 只在这个对象的属主里找（`owner` 是动画的属主路径，同联动：图层 `objects/<i>`、effect `objects/<i>/effects/<e>`、材质
   * `<pass>/constantshadervalues`、`general`；步骤 0 Q1，不是按图层找）。参数是非空字符串时用它，否则（空串、非字符串、不带参数）
   * 取当前脚本所挂属性的名字（`script.id` 的最后一段，Q6），没有当前脚本时是空串；找不到返回 undefined。
   */
  private installGetAnimation(api: ApiObject, owner: () => string): void {
    this.method(api, "getAnimation", (name?: unknown) => {
      this.requireAnimationContext();
      const wanted = typeof name === "string" && name !== "" ? name : this.current ? lastSegment(this.current.id) : "";
      const def = this.findAnimation(owner(), wanted);
      return def ? this.animationApi(def) : undefined;
    });
  }

  /**
   * 在脚本看到的 bundle 里按列表顺序（= WPE 的登记顺序）找第一条：`owner` 不为 null 时属主相同，名字等于 `options.name` 或属性名
   * （`id` 的最后一段）。跳过 WPE 不建绑定的（常量目标在着色器里没有 uniform，`settleConstantAnimation` 已标出）；丢弃的（`inert`）找得到。
   */
  private findAnimation(owner: string | null, name: string): SceneAnimation | undefined {
    for (const def of this.access.bundle().animations ?? []) {
      if (owner !== null && def.owner !== owner) continue;
      if (def.target.kind === "constant" && def.target.uniforms.length === 0) continue;
      if (def.name === name || lastSegment(def.id) === name) return def;
    }
    return undefined;
  }

  /**
   * `IAnimation` 包装对象（P10b，步骤 0 Q4，rea-p10-keyframes 第 11 节）：按 `id` 缓存。不持有播放器：方法每次经 `access.animation` 现取落点
   * （重编译换了播放器也控制同一条、`rate` 保留），没有落点时空操作、`isPlaying()` 假、`getFrame()` 0。12 个自有可枚举成员，顺序
   * `name`、`frameCount`、`duration`、`fps`、`rate`、`play`、`isPlaying`、`stop`、`pause`、`setFrame`、`getFrame`、`getAnimation`：
   * - 前四个是不可写的数据属性，值在建对象时按这一条的时钟取（不会变），严格模式下赋值抛 V8 自己的 TypeError（WPE 同一条消息）；
   * - `rate` 是访问器：只收 number（`NaN` 也收，转 float32），别的忽略；描述符和 WPE 的原生数据属性不同，记为已知差异；
   * - 方法是数据属性（函数对象建一次）；`setFrame(f)` 的 `f` 不是 number 时按 0；`getAnimation()` 返回 undefined（同 IVideoTexture）；
   * - 原型是普通的 `Object.prototype`（WPE 是只有 `constructor` 的原型），记为已知差异。
   */
  private animationApi(def: SceneAnimation): ApiObject {
    const id = def.id;
    let api = this.animationApis.get(id);
    if (api) return api;
    api = this.object();
    const target = () => this.access.animation?.(id) ?? null;
    const info = target();
    const clock = info ? null : def.inert ? AnimationClock.inert(def.clock.length) : new AnimationClock(def.clock);
    const Obj = this.realm.global.Object as typeof Object;
    const constant = (key: string, value: unknown) =>
      Obj.defineProperty(api, key, { value, enumerable: true, writable: false, configurable: false });
    const method = (key: string, run: (...args: unknown[]) => unknown) =>
      Obj.defineProperty(api, key, { value: run, enumerable: true, writable: true, configurable: true });
    constant("name", info?.name ?? def.name);
    constant("frameCount", info?.frameCount ?? clock!.length);
    constant("duration", info?.duration ?? clock!.D);
    constant("fps", info?.fps ?? Math.fround(1 / clock!.spf));
    Obj.defineProperty(api, "rate", {
      enumerable: true,
      configurable: true,
      get: () => target()?.rate ?? 1,
      set: (value: unknown) => {
        const control = target();
        // 只收数字，`NaN` 也收（Q4）：别的类型（字符串、对象、布尔）忽略，不做类型转换
        if (control && typeof value === "number") control.rate = Math.fround(value);
      },
    });
    method("play", () => void target()?.play());
    method("isPlaying", () => target()?.isPlaying() ?? false);
    method("stop", () => void target()?.stop());
    method("pause", () => void target()?.pause());
    method("setFrame", (frame) => void target()?.setFrame(typeof frame === "number" ? frame : 0));
    method("getFrame", () => target()?.getFrame() ?? 0);
    method("getAnimation", () => undefined);
    this.animationApis.set(id, api);
    return api;
  }

  private installScene(): void {
    this.method(
      this.thisScene,
      "getLayer",
      (name: unknown) => {
        // 图层对象（P6b 步骤 2，p6b-api 实测：`getLayer(layer) === layer`）：是本场景发出的图层对象就原样返回，别的对象返回 null
        if (name !== null && typeof name === "object") {
          for (const [object, api] of this.layers) if (api === name && this.findLayer(object)) return api;
          return null;
        }
        const layers = this.access.bundle().layers;
        const layer =
          typeof name === "number"
            ? layers.find((item) => item.object === name)
            : layers.find((item) => item.name === name);
        return layer ? this.layer(layer.object) : null;
      },
      true,
    );
    // 全场景按名字找第一条（P10b，步骤 0 Q6）：参数不是字符串、找不到都是 null；空串照常查（取第一条没写 name 的）
    this.method(this.thisScene, "getAnimation", (name: unknown) => {
      this.requireAnimationContext();
      if (typeof name !== "string") return null;
      const def = this.findAnimation(null, name);
      return def ? this.animationApi(def) : null;
    });
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
          // 同图层字段按 WPE 取单精度（P3b 补测 `ignore/p3b-f32`：`thisObject.alpha` 读出 0.30000001192092896）
          return Array.isArray(values)
            ? values.length === 1
              ? scriptNumber(values[0])
              : this.vector(scriptNumbers(values), values.length as 2 | 3 | 4)
            : values;
        },
        (value) => this.write({ kind: "constant", pass, material: name, ...shape }, value, shape.type),
      );
    this.installGetAnimation(api, () => `${pass}/constantshadervalues`);
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
    this.installGetAnimation(api, () => `objects/${object}/effects/${effect}`);
    this.effects.set(key, api);
    return api;
  }
  private installGeneral(object: ApiObject): void {
    // TODO:[WPE_SCENE] 没实测：泛光参数与 `GENERAL_FIELDS`（清屏色、环境光、相机 `zoom` 等）的读回仍是 double；图层字段与材质常量
    // 实测是 f32（P3b 补测 `ignore/p3b-f32`），这里大概率同样，测过再按 `f32.ts` 改
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
