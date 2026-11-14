/**
 * dev 探针跑场景脚本（kabegame-chromium 第 7 批，`renderFrame` 的 `scripts`）：在探针自己的 `SceneState` 上照宿主搭一套脚本环境，
 * 用同一个 `createIframeRealm`、`ScriptApi`、`ScriptRuntime`，不另写运行时。写回与读取经 `script/stateWrite.ts`（宿主同一份）。
 *
 * 脚本看得到的外部值全部来自请求，两次同样的请求得到同一张图：
 * - `engine.runtime` / `frametime`：回放时间线的这一帧（`frame(dt, time)` 交来的）；`init` 时都是 0（同宿主首次加载，渲染器还没走帧）。
 * - `engine.screenResolution`：调用方给的 `screen`（`renderFrame` 取 `canvas ?? window ?? [1920, 1080]`，WPE 是窗口尺寸）；
 *   `engine.canvasSize` 照旧是场景尺寸（`ScriptApi`）。
 * - `Date`（无参构造、当函数调用、`Date.now`）与 `engine.timeOfDay`：起点 `clock`（毫秒时间戳，缺省 `DEFAULT_PROBE_CLOCK`）加当前
 *   回放时间；`renderFrame` 读回那一帧的 `g_Daytime` 跟着同一个时钟（`probeDaytime`）。本地时间的换算照本机时区。
 * - `Math.random`：按种子（缺省 `DEFAULT_PROBE_SEED`）的 mulberry32 序列。它本来就和 WPE 对不上，只保证我们两次相同。
 * - `localStorage`：只在内存（`createWpeLocalStorage` 不给后端），不碰持久存储。
 * - 音频缓冲全 0（不交频谱），媒体回调不调；声音层、视频纹理、粒子层的脚本方法落点返回 null（方法空操作），每次被问到都计数。
 * `Date` 与 `Math.random` 在 realm 建好之后、模块求值之前换掉（`installProbeClock` / `installProbeRandom`）。
 *
 * 要整场重编译的写入（`recompile` 目标、打开带不支持项的 effect、打开没有链的泛光）探针做不了：状态不变，按宿主同一条「值变了才算」
 * （`recordRecompileWrite`）记进结果的 `recompile`，调用方据此判断这一帧不可信。
 */
import type { SceneAnimations } from "../animation/player";
import { mergeProperties, type UserProperty } from "../compile/bindings";
import type { SceneBundle } from "../compile/bundle";
import { SceneFs, type SceneReader } from "../compile/fs";
import { parseProject, type ProjectJson } from "../compile/model";
import { mulberry32 } from "../particles/random";
import type { SceneState } from "../render/state";
import { daytimeOf } from "../render/uniforms";
import type { SceneReporter } from "../report";
import { createWpeLocalStorage, ScriptApi } from "../script/api";
import { createIframeRealm, getJsModuleIndex } from "../script/realm";
import {
  ScriptRuntime,
  scriptDiagnostics,
  targetKey,
  type ScriptRealm,
  type ScriptTarget,
  type ScriptValue,
} from "../script/runtime";
import { readScriptState, recordRecompileWrite, writeScriptState } from "../script/stateWrite";

/** `renderFrame` 的 `scripts` 给对象时的选项：`clock` 是起点时刻（毫秒时间戳），`seed` 是 `Math.random` 的种子。 */
export interface ProbeScriptsOptions {
  clock?: number;
  seed?: number;
}

/** 不给 `clock` 时的起点：2026-01-01T00:00:00Z（固定值，结果里写明用的是缺省）。 */
export const DEFAULT_PROBE_CLOCK = 1767225600000;
/** 不给 `seed` 时的种子。 */
export const DEFAULT_PROBE_SEED = 1;
/** `clock` 的绝对值上限：`Date` 能表示的范围（±8.64e15 毫秒）。 */
export const MAX_PROBE_CLOCK = 8.64e15;
/** `seed` 的上限：mulberry32 的状态是 32 位。 */
export const MAX_PROBE_SEED = 0xffffffff;
/** 结果里运行时告警（`report.warn` / `error`）最多留这么多条（前面的）。 */
const MAX_MESSAGES = 100;
/** 结果里脚本 `console` 输出最多留这么多条（最后的）。 */
const MAX_CONSOLE_TAIL = 50;

/** 校验并补全后的 `scripts` 选项。 */
export interface ResolvedProbeScripts {
  clock: number;
  clockDefault: boolean;
  seed: number;
  seedDefault: boolean;
}

const shown = (value: unknown) => JSON.stringify(value) ?? String(value);

/**
 * `renderFrame` 的 `scripts`：不给为 null；`true` 用缺省的 `clock` 与 `seed`；对象只收 `clock`（有限数、绝对值不超过 `MAX_PROBE_CLOCK`）与
 * `seed`（0–`MAX_PROBE_SEED` 的整数）。形状不对时抛错（vite 的 `checkScripts` 同样查，探针被直接调用时再查一次）。
 */
export function probeScriptsOptionsOf(value: unknown): ResolvedProbeScripts | null {
  if (value === undefined) return null;
  const resolved = (options: ProbeScriptsOptions): ResolvedProbeScripts => ({
    clock: options.clock ?? DEFAULT_PROBE_CLOCK,
    clockDefault: options.clock === undefined,
    seed: options.seed ?? DEFAULT_PROBE_SEED,
    seedDefault: options.seed === undefined,
  });
  if (value === true) return resolved({});
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`scripts 要是 true，或 { clock?, seed? }，收到 ${shown(value)}`);
  const object = value as Record<string, unknown>;
  const unknown = Object.keys(object).filter((key) => key !== "clock" && key !== "seed");
  if (unknown.length) throw new Error(`scripts.${unknown[0]} 不认识（scripts 只收 clock / seed）`);
  const { clock, seed } = object;
  if (
    clock !== undefined &&
    !(typeof clock === "number" && Number.isFinite(clock) && Math.abs(clock) <= MAX_PROBE_CLOCK)
  )
    throw new Error(`scripts.clock 要是毫秒时间戳（有限数，绝对值不超过 ${MAX_PROBE_CLOCK}），收到 ${shown(clock)}`);
  if (
    seed !== undefined &&
    !(typeof seed === "number" && Number.isInteger(seed) && seed >= 0 && seed <= MAX_PROBE_SEED)
  )
    throw new Error(`scripts.seed 要是 0–${MAX_PROBE_SEED} 的整数，收到 ${shown(seed)}`);
  return resolved({ clock: clock as number | undefined, seed: seed as number | undefined });
}

/** 脚本时钟在回放时间 `time`（秒）的时刻（毫秒时间戳）：起点加回放时间。 */
export function probeClockAt(clock: number, time: number): number {
  return clock + time * 1000;
}

/** 读回那一帧的 `g_Daytime`：跟着脚本的时钟（本机时区的一天中的占比，同渲染器的 `daytimeOf(new Date())`）。 */
export function probeDaytime(clock: number, time: number): number {
  return daytimeOf(new Date(probeClockAt(clock, time)));
}

/**
 * 把 realm 的 `Date` 换成按 `now()` 走的：无参构造与 `Date.now()` 取 `now()`，当函数调用（`Date()`）返回同一时刻的字符串；带参数的构造、
 * `Date.parse`、`Date.UTC` 与原生相同。实例的原型仍是原生的 `Date.prototype`（`instanceof Date` 为真）。
 */
export function installProbeClock(global: Record<string, unknown>, now: () => number): void {
  const Original = global.Date as DateConstructor;
  function ProbeDate(...args: unknown[]): unknown {
    if (!new.target) return new Original(now()).toString();
    return Reflect.construct(Original, args.length ? args : [now()], new.target) as unknown;
  }
  ProbeDate.prototype = Original.prototype;
  Object.defineProperty(ProbeDate, "now", { value: () => now(), writable: true, configurable: true });
  Object.defineProperty(ProbeDate, "parse", { value: Original.parse, writable: true, configurable: true });
  Object.defineProperty(ProbeDate, "UTC", { value: Original.UTC, writable: true, configurable: true });
  global.Date = ProbeDate;
}

/** 把 realm 的 `Math.random` 换成按种子的 mulberry32 序列（[0, 1)，32 位精度）。 */
export function installProbeRandom(global: Record<string, unknown>, seed: number): void {
  const next = mulberry32(seed);
  (global.Math as Record<string, unknown>).random = () => next() / 4294967296;
}

/**
 * 场景的全部用户属性（带类型，同宿主的累计全集）：`project.json` 声明的属性，值取请求给的（`overrides`，裸值或 `{ value }`，同编译期的
 * `currentProperties`）、没给的取工程缺省值；分组、文本与空值跳过（`mergeProperties`，同宿主）。工程里没声明的键不收（宿主也只有声明的）。
 */
export function probeUserProperties(
  project: Pick<ProjectJson, "general"> | null,
  overrides: Record<string, unknown> = {},
): Map<string, UserProperty> {
  const delta: Record<string, UserProperty> = {};
  for (const [key, declared] of Object.entries(project?.general?.properties ?? {})) {
    const type = (declared as { type?: unknown }).type;
    if (typeof type !== "string") continue;
    const raw = Object.hasOwn(overrides, key) ? overrides[key] : declared.value;
    const value = raw && typeof raw === "object" && "value" in raw ? (raw as { value: unknown }).value : raw;
    delta[key] = { type, value };
  }
  const properties = new Map<string, UserProperty>();
  mergeProperties(properties, delta);
  return properties;
}

/** 读 `project.json` 得到 `probeUserProperties`（读不到时没有属性）。 */
export async function readProbeUserProperties(
  reader: SceneReader,
  projectDir: string,
  sceneAssets: readonly string[],
  overrides: Record<string, unknown> | undefined,
): Promise<Map<string, UserProperty>> {
  const text = await new SceneFs(projectDir, sceneAssets, reader).text("project.json");
  return probeUserProperties(text ? parseProject(text) : null, overrides);
}

/** 一条要整场重编译、探针做不了的写入：目标路径、值变了几次、第一次在第几帧（0 是 `init`）、最后写的值。 */
export interface ProbeRecompileWrite {
  path: string;
  count: number;
  firstFrame: number;
  value: ScriptValue;
}

export interface ProbeScriptsResult {
  /** 实际用的起点时刻（毫秒时间戳）；`clockDefault` 为真时是 `DEFAULT_PROBE_CLOCK`。 */
  clock: number;
  clockDefault: boolean;
  /** 实际用的 `Math.random` 种子；`seedDefault` 为真时是 `DEFAULT_PROBE_SEED`。 */
  seed: number;
  seedDefault: boolean;
  /** 脚本看到的 `engine.screenResolution`。 */
  screenResolution: [number, number];
  /** `init` 之后跑了几帧（`frame` 的次数，回放帧加读回帧）。 */
  frames: number;
  /** 每段脚本的诊断（同宿主 `scriptDiagnostics`）；场景没有脚本时为空。 */
  diagnostics: unknown[];
  /** 要整场重编译、探针做不了的写入（按第一次出现的顺序）：有就说明读回那一帧和宿主不同，不可信。 */
  recompile: ProbeRecompileWrite[];
  /** 没接的脚本 API 被问到的次数：声音层、视频纹理、粒子层的方法落点（返回 null，方法空操作）。 */
  unconnected: { sound: number; video: number; particles: number };
  /** 脚本注册过的音频缓冲分辨率（缓冲一直全 0）。 */
  audioResolutions: number[];
  /** 运行时的告警与错误（脚本出错、写回目标不支持……），最多 `MAX_MESSAGES` 条（前面的）。 */
  messages: string[];
  /** 脚本 `console` 输出的条数与最后 `MAX_CONSOLE_TAIL` 条（`console.error` 的带 `error: ` 前缀）。 */
  console: { count: number; tail: string[] };
}

/** 建 realm 用的回调：同 `createIframeRealm` 的 `console` 与 `localStorage`。 */
export interface ProbeRealmSetup {
  console: { log(text: string): void; error(text: string): void };
  localStorage: (global: Record<string, unknown>) => object;
}

export interface ProbeScriptsInput {
  bundle: SceneBundle;
  /** 探针自己的状态：脚本读写的就是建场景用的那一份。 */
  state: SceneState;
  sceneAssets: readonly string[];
  /** 全部用户属性（`readProbeUserProperties`）：`init` 之后整份交给 `applyUserProperties`，同宿主首帧之前。 */
  properties: ReadonlyMap<string, UserProperty>;
  /** 脚本的 `engine.screenResolution`。 */
  screen: readonly [number, number];
  options: ResolvedProbeScripts;
  /**
   * 探针自己的关键帧动画播放器（P10b）：脚本的 `getAnimation()` 落到它上面，`init` 之前就要建好（`init` 里的 `play()` 才有落点，同宿主的
   * 待用播放器）；回放推进的是同一份。不给时 `getAnimation` 的方法空操作。
   */
  animations?: Pick<SceneAnimations, "control">;
  /** 建 realm（缺省 `createIframeRealm`，在当前文档里建隐藏 iframe）：单测换成不碰 DOM 的假 realm。 */
  createRealm?: (setup: ProbeRealmSetup) => Promise<ScriptRealm>;
}

export interface ProbeScripts {
  /** 建 realm、换 `Date` 与 `Math.random`、求值模块、跑 `init`，再整份交一次用户属性。场景没有脚本时什么都不做。 */
  load(): Promise<void>;
  /** 跑一帧（计时器与每段 `update`）：`dt` 是这一帧的 `g_Frametime`，`time` 是 `g_Time`（也是脚本时钟的回放时间）。 */
  frame(dt: number, time: number): void;
  /** 动画事件（P10b）：回放推进动画时越过的事件在这里派发给脚本，同宿主 `runtime.animationEvent`；没有脚本时什么都不做（可选：单测的替身可以不给）。 */
  animationEvent?(object: number | null, json: string): void;
  result(): ProbeScriptsResult;
  /** 调各段的 `destroy`、释放 realm；可以重复调。 */
  dispose(): void;
}

export function createProbeScripts(input: ProbeScriptsInput): ProbeScripts {
  const { bundle, state, options } = input;
  const screen: [number, number] = [input.screen[0], input.screen[1]];
  /** 当前的回放时间与帧时间：`init` 时都是 0。 */
  const clock = { time: 0, frametime: 0 };
  const now = () => probeClockAt(options.clock, clock.time);
  let frames = 0;
  let realm: ScriptRealm | null = null;
  let api: ScriptApi | null = null;
  let runtime: ScriptRuntime | null = null;
  let disposed = false;
  const unconnected = { sound: 0, video: 0, particles: 0 };
  const recompile = new Map<string, ProbeRecompileWrite>();
  const overrides = new Map<string, ScriptValue>();
  const messages: string[] = [];
  const consoleTail: string[] = [];
  let consoleCount = 0;

  const message = (level: string, text: string, detail?: unknown) => {
    if (messages.length >= MAX_MESSAGES) return;
    const full = detail === undefined ? text : `${text} ${Array.isArray(detail) ? detail.join("; ") : String(detail)}`;
    messages.push(level === "warn" ? full : `${level}: ${full}`);
  };
  const report: SceneReporter = {
    ready: () => {},
    fallback: () => {},
    info: () => {},
    debug: () => {},
    warn: (text, detail) => message("warn", text, detail),
    error: (text, detail) => message("error", text, detail),
  };
  const output = (text: string) => {
    consoleCount++;
    consoleTail.push(text);
    if (consoleTail.length > MAX_CONSOLE_TAIL) consoleTail.shift();
  };

  /** 写回：写进状态的规则同宿主（`writeScriptState`）；要整场重编译的值变了才记一条（同宿主的 `overrideAndReload`）。 */
  const write = (target: ScriptTarget, value: ScriptValue): boolean => {
    const result = writeScriptState(state, target, value);
    if (result === "unsupported") return false;
    if (result === "recompile") {
      const path = targetKey(target);
      if (recordRecompileWrite(overrides, bundle.general, path, value)) {
        const item = recompile.get(path);
        if (item) {
          item.count++;
          item.value = value;
        } else recompile.set(path, { path, count: 1, firstFrame: frames, value });
      }
    }
    return true;
  };
  const read = (target: ScriptTarget) => readScriptState(state, target);

  const createRealm =
    input.createRealm ??
    ((setup: ProbeRealmSetup) =>
      createIframeRealm({
        document,
        scripts: bundle.scripts,
        sceneAssets: input.sceneAssets,
        modules: getJsModuleIndex(input.sceneAssets),
        ...setup,
      }));

  return {
    async load() {
      if (!bundle.scripts.list.length || disposed) return;
      const created = await createRealm({
        console: { log: (text) => output(String(text)), error: (text) => output(`error: ${String(text)}`) },
        // 只在内存：不给后端（同宿主没有图片 id 时）
        localStorage: (global) =>
          createWpeLocalStorage({
            global,
            backend: null,
            sceneKey: "probe",
            isEvaluating: () => api?.moduleEvaluating ?? false,
          }),
      });
      if (disposed) {
        created.dispose();
        return;
      }
      realm = created;
      // 模块求值之前换掉：顶层代码里取的时刻与随机数也来自请求
      installProbeClock(created.global, now);
      installProbeRandom(created.global, options.seed);
      const scriptApi = (api = new ScriptApi(created, {
        bundle: () => bundle,
        state: () => state,
        screenResolution: () => screen,
        frametime: () => clock.frametime,
        runtime: () => clock.time,
        timeOfDay: () => daytimeOf(new Date(now())),
        write,
        read,
        // 声音层、视频纹理、粒子层的方法：落点返回 null（方法空操作），只计数
        sound: () => {
          unconnected.sound++;
          return null;
        },
        video: () => {
          unconnected.video++;
          return null;
        },
        particles: () => {
          unconnected.particles++;
          return null;
        },
        // 关键帧动画（P10b）：探针自己的播放器，每次现取
        animation: (id) => input.animations?.control(id) ?? null,
      }));
      runtime = new ScriptRuntime(created, {
        report,
        write,
        read,
        enterScript: (script) => scriptApi.enterScript(script),
        setProperties: (full) => scriptApi.setProperties(full),
        setModuleEvaluating: (evaluating) => scriptApi.setModuleEvaluating(evaluating),
      });
      scriptApi.attachRuntime(runtime);
      await runtime.load(bundle.scripts);
      // 同宿主首帧之前（`beforeFirstFrame`）：整份用户属性交一次，`engine.userProperties` 从这时起读得到
      runtime.applyUserProperties(Object.fromEntries(input.properties), input.properties, bundle.bindings);
    },
    frame(dt, time) {
      if (disposed) return;
      clock.time = time;
      clock.frametime = dt;
      frames++;
      runtime?.frame(dt);
    },
    animationEvent(object, json) {
      if (disposed) return;
      runtime?.animationEvent(object, json);
    },
    result() {
      return {
        clock: options.clock,
        clockDefault: options.clockDefault,
        seed: options.seed,
        seedDefault: options.seedDefault,
        screenResolution: [screen[0], screen[1]],
        frames,
        diagnostics: scriptDiagnostics(runtime, api?.recompileWrites),
        recompile: [...recompile.values()].map((item) => ({ ...item })),
        unconnected: { ...unconnected },
        audioResolutions: api?.audioResolutions ?? [],
        messages: [...messages],
        console: { count: consoleCount, tail: [...consoleTail] },
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      // 运行时的 `destroy` 先调各段的 `destroy` 再释放 realm（同宿主销毁时）；没建成运行时的只释放 realm。引用留着，`result` 之后还能读诊断
      if (runtime) runtime.destroy();
      else realm?.dispose();
    },
  };
}
