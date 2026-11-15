import { scriptPropertyEntries, type TargetKey, type UserProperty } from "../compile/bindings";
import { scriptToString } from "../text/fields";
import { type SceneScript, type SceneScripts, type ScriptOwner } from "../compile/scripts";
import { type CursorCallback } from "../render/cursor";
import { type SceneReporter } from "../report";
import type { ModuleInstance, ScriptModule } from "./moduleFactory";
import { FACTORY_LINE_OFFSET } from "./moduleRewrite";
import { degreesFromScript, radiansToScript, scriptNumber, scriptNumbers } from "./f32";

export interface ScriptRealm {
  readonly global: Record<string, unknown>;
  readonly prototypes: { Vec2: object; Vec3: object; Vec4: object; Mat3: object; Mat4: object };
  readonly internal: {
    updateScriptProperties(script: Record<string, unknown>, vars: string): void;
    convertUserProperties(json: string): Record<string, unknown>;
    /** WPE 的 `JSON.stringify(obj, stringifyAdapter)`（`Vec` → "x y z"，P6d3b `createLayer` 的对象分支）；`this` 是 `_Internal`。可选：假 realm 没有。 */
    stringifyConfig?(value: unknown): string;
  };
  /**
   * 加载期：每种源码一次（按源码文本缓存 Promise，同一源码的两段脚本共用一个 ScriptModule、各自 instantiate）。
   * 失败时 reject，错误要和以前 importModule 同一份源码给出的错误一样（文字与行列）。
   */
  prepareModule(source: string, label: string): Promise<ScriptModule>;
  /**
   * 已经备好的模块（`prepareModule` 落定过的同源码，P6d3b）；没有返回 null。`createLayer` 克隆带脚本的对象时要同步实例化，不能等 Promise。
   * 可选：没有就当都没备过（脚本晚一段才 `init`）。
   */
  preparedModule?(source: string): ScriptModule | null;
  dispose(): void;
}

export type ScriptTarget = SceneScript["target"];
/**
 * 脚本写回链上的值（运行时 / API 按目标形状换好、交给宿主的）：数字目标铺成分量数组、布尔目标是布尔，字符串只在文本目标上
 * （P6b 1e，`scriptToString` 之后）。重放表、覆盖表与编译协议都存这个形状。
 */
export type ScriptValue = number[] | boolean | string;
/**
 * 运行时会调用的导出回调。WPE 的其余回调（`compile/scriptApi.ts` 的 `MISSING_SCRIPT_CALLBACKS`）编译期报
 * `script:callback:*`；实现一个就加到这里、从那张表删掉（`api.test.ts` 核对两者）。
 */
export const RUNTIME_CALLBACKS = [
  "init",
  "update",
  "applyUserProperties",
  "destroy",
  "animationEvent",
  // 光标回调（P6c）：`cursorHitTest` 只登记在这里，从不调用（WPE 的 exe 里没有调用点，导出它只打开拾取，p6-REPORT 0b）
  "cursorHitTest",
  "cursorEnter",
  "cursorLeave",
  "cursorMove",
  "cursorClick",
  "cursorDown",
  "cursorUp",
  // 系统媒体集成（P11c）：宿主按 WPE 的固定顺序派发（`media/scene.ts`），返回值丢弃
  "mediaStatusChanged",
  "mediaPlaybackChanged",
  "mediaPropertiesChanged",
  "mediaThumbnailChanged",
  "mediaTimelineChanged",
] as const;
type Callback = (typeof RUNTIME_CALLBACKS)[number];
/** 五个系统媒体回调的名字（`ScriptRuntime.mediaEvent`）。 */
export type MediaCallback = Extract<
  Callback,
  | "mediaStatusChanged"
  | "mediaPlaybackChanged"
  | "mediaPropertiesChanged"
  | "mediaThumbnailChanged"
  | "mediaTimelineChanged"
>;
/** 打开拾取的导出：六个光标回调加 `cursorHitTest`（WPE 绑定时 `mask & 0x3f80`，rea-p6c-dispatch 3.1）。 */
const CURSOR_EXPORTS = [
  "cursorHitTest",
  "cursorEnter",
  "cursorLeave",
  "cursorMove",
  "cursorClick",
  "cursorDown",
  "cursorUp",
] as const;
/**
 * 宿主代为调用的回调类别（不是导出回调）：`timer` 是 `engine.setTimeout` / `setInterval`，`ended` 是视频纹理的结束回调（P9b，
 * `callFor`）。出错只记诊断、不禁用所属脚本的任何导出回调；统计照常记在 `calls[类别]` 下。
 */
type HostCallback = "timer" | "ended";
interface ScriptRecord {
  script: SceneScript;
  /** 加载期编好的模块（同源码的脚本共用）；P6d3 要用，现在只存不用 */
  module: ScriptModule | null;
  /** 这段脚本自己的模块状态 */
  instance: ModuleInstance | null;
  /** = `instance.namespace`：回调的 this、诊断的导出名、updateScriptProperties 的参数 */
  exports: Record<string, unknown> | null;
  state: "pending" | "loaded" | "inited" | "failed";
  disabled: Set<Callback>;
  errors: string[];
  calls: Record<string, { count: number; maxMs: number }>;
  /** 回调返回值写到重编译目标的次数（API 直接写入由 `ScriptApi` 另计，探针合并）。 */
  recompileWrites: number;
  /**
   * 模块求值完（`instantiate` 之后）读一次的导出 `__workshopId`（P6d3b）：只认字符串，之后再改导出变量不生效。`createLayer` 的路径改写用
   * 当前脚本的这个值（rea-p6d-script 2.2）。
   */
  workshopId: string | null;
}
interface Timer {
  owner: ScriptRecord;
  callback: () => void;
  remaining: number;
  period: number | null;
  cancelled: boolean;
}

/**
 * 脚本的接收范围（P10b，读码第 8 节）：图层字段、effect、材质常量（`owner.layer`）归图层，`general` 的归场景（null），同动画的 `object`。
 */
export function scriptObject(owner: ScriptOwner): number | null {
  if (owner.kind === "general") return null;
  return owner.kind === "material" ? owner.layer : owner.object;
}

/** 写回目标的路径（重放表的键，同宿主的 `targetPath`）；dev 探针跑脚本时用它记重编译类写入（`dev/probeScripts.ts`）。 */
export function targetKey(target: ScriptTarget): string {
  switch (target.kind) {
    case "layer":
      return `objects/${target.object}/${target.field}`;
    // `rotateObjectSpace`（P6d1a）：与 `angles` 同一个键，后写的覆盖先写的
    case "rotation":
      return `objects/${target.object}/angles`;
    case "effect":
      return `objects/${target.object}/effects/${target.effect}/visible`;
    case "constant":
      return `${target.pass}/constantshadervalues/${target.material}`;
    case "bloom":
      return `general/bloom/${target.field}`;
    case "bloom-enabled":
      return "general/bloom";
    case "general":
      return `general/${target.key}`;
    case "script-property":
      return `${target.script}/scriptproperties/${target.key}`;
    case "particle-instance":
      return `objects/${target.object}/instanceoverride/${target.field}`;
    case "sound":
      return `objects/${target.object}/${target.field}`;
    // 文本字段（P6b 1e）：同宿主 `targetPath`，属性就地写时据此忘掉脚本的旧写入
    case "text":
      return `objects/${target.object}/${target.field}`;
    // 相机对象的 `fov` / `zoom`（P5d 步骤 3）：同宿主 `targetPath`
    case "camera":
      return `objects/${target.object}/${target.field}`;
    // 用户纹理（P11b）：属性来源，脚本写不到它；同宿主 `targetPath`
    case "user-texture":
      return `usertextures/${target.name}`;
    // puppet 动画层字段（P12a 步骤 3 点 3）：只有用户属性写它，脚本写不到（`puppet:layer-script`）；同宿主 `targetPath`
    case "animation-layer":
      return `objects/${target.object}/animationlayers/${target.layer}/${target.field}`;
    // 材质状态字段（P6d1b）：同宿主 `targetPath`，重编译后按它重放
    case "pass-state":
      return `${target.pass}/state/${target.field}`;
    default:
      return target.path;
  }
}

/**
 * 每段脚本的诊断（宿主 `scriptDiagnostics` 与 dev 探针跑脚本共用）：运行时的记录，`recompileWrites` 合并回调返回值与 API 直接写入
 * （`ScriptApi.recompileWrites`）两路。没有运行时时为空。
 */
export function scriptDiagnostics(
  runtime: Pick<ScriptRuntime, "diagnostics"> | null,
  direct: ReadonlyMap<string, number> | undefined,
): unknown[] {
  return (runtime?.diagnostics ?? []).map((item) => {
    const record = item as { id: string; recompileWrites?: number };
    return { ...record, recompileWrites: (record.recompileWrites ?? 0) + (direct?.get(record.id) ?? 0) };
  });
}

export function messageOf(error: unknown): string {
  const object = error as { message?: unknown; stack?: unknown } | null;
  const message = typeof object?.message === "string" ? object.message : String(error);
  const stack = typeof object?.stack === "string" ? object.stack : "";
  // 栈里第一处 blob 行列或工厂脚本（`kabegame-script:<序号>`）行列；工厂源码在原文前有包装头与前言，行要减掉
  const location = /(?:blob:[^\s)]+|(kabegame-script):\d+):(\d+):(\d+)/.exec(stack);
  if (!location) return message;
  const line = location[1] ? Number(location[2]) - FACTORY_LINE_OFFSET : Number(location[2]);
  return `${message} (line ${line}, col ${location[3]})`;
}

export class ScriptRuntime {
  private records: ScriptRecord[] = [];
  private byId = new Map<string, ScriptRecord>();
  private timers: Timer[] = [];
  private writes = new Map<string, { target: ScriptTarget; value: ScriptValue }>();
  private unsupported = new Set<string>();
  private halted = false;
  private active: ScriptRecord | null = null;
  /**
   * 正在跑的回调名（P11d，WPE 的 `G+0x62c`）：`invoke` 进入时记下、结束时恢复成进入前的（嵌套时还原上一个，如光标回调里的 `callFor`）。
   * 只有 API 读（`engine.openUserShortcut` 只许在光标回调里调）；不在任何回调里（模块求值、宿主直接调）为 null。
   */
  private activeCallbackName: string | null = null;

  constructor(
    private readonly realm: ScriptRealm,
    private readonly options: {
      report: SceneReporter;
      write(target: ScriptTarget, values: ScriptValue, source: string): boolean;
      read(target: ScriptTarget): ScriptValue | null;
      now?: () => number;
      /** API 层据此切换 thisLayer / thisObject。 */
      enterScript?(script: SceneScript | null): void;
      /** API 层让 engine.userProperties 读到新全集。 */
      setProperties?(full: ReadonlyMap<string, UserProperty>): void;
      /** 模块求值期间的 API 访问限制。 */
      setModuleEvaluating?(evaluating: boolean): void;
    },
  ) {}

  get currentScript(): SceneScript | null {
    return this.active?.script ?? null;
  }
  /** 当前正在调用的脚本的 `__workshopId`（P6d3b）；没有当前脚本、或它的导出不是字符串时为 null。 */
  currentWorkshopId(): string | null {
    return this.active?.workshopId ?? null;
  }
  get stopped(): boolean {
    return this.halted;
  }
  /** 正在跑的回调名（P11d）；不在回调里为 null。 */
  get activeCallback(): string | null {
    return this.activeCallbackName;
  }
  get diagnostics(): unknown[] {
    return this.records.map((record) => ({
      id: record.script.id,
      state: record.state,
      exports: Object.keys(record.exports ?? {}),
      disabled: [...record.disabled],
      errors: [...record.errors],
      calls: { ...record.calls },
      targetKind: record.script.target.kind,
      recompileWrites: record.recompileWrites,
    }));
  }
  get timerCount(): number {
    return this.timers.filter((timer) => !timer.cancelled).length;
  }
  /** 未取消的计时器：所属段 id、剩余秒数、周期（`null` 表示一次性）。dev 探针 `host.clock()` 用。 */
  get timerInfo(): { script: string; remaining: number; period: number | null }[] {
    return this.timers
      .filter((timer) => !timer.cancelled)
      .map((timer) => ({
        script: timer.owner.script.id,
        remaining: timer.remaining,
        period: timer.period,
      }));
  }

  private invoke(record: ScriptRecord, callback: Callback | HostCallback, fn: () => unknown): unknown {
    if (this.halted) return undefined;
    const previous = this.active;
    const previousCallback = this.activeCallbackName;
    this.active = record;
    this.activeCallbackName = callback;
    this.options.enterScript?.(record.script);
    const now = this.options.now ?? performance.now.bind(performance);
    const start = now();
    let result: unknown;
    try {
      result = fn();
    } catch (error) {
      if (callback !== "timer" && callback !== "ended") record.disabled.add(callback);
      record.errors.push(`${callback}: ${messageOf(error)}`);
      this.options.report.warn(`场景脚本 ${record.script.id} ${callback} 出错：${messageOf(error)}`);
    } finally {
      const elapsed = now() - start;
      const stats = (record.calls[callback] ??= { count: 0, maxMs: 0 });
      stats.count++;
      stats.maxMs = Math.max(stats.maxMs, elapsed);
      this.active = previous;
      this.activeCallbackName = previousCallback;
      this.options.enterScript?.(previous?.script ?? null);
      if (elapsed > 15_000 && !this.halted) {
        this.halted = true;
        this.options.report.error("脚本执行超过 15 秒，已停止本场景全部脚本");
      }
    }
    return result;
  }

  /** 取一段脚本导出的函数（经 `instance.read`，不经命名空间 Proxy）；不是函数返回 undefined。 */
  private exported(record: ScriptRecord, name: string): ((...args: unknown[]) => unknown) | undefined {
    const value = record.instance?.read(name);
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown) : undefined;
  }

  private call(record: ScriptRecord, callback: Callback, ...args: unknown[]): unknown {
    if (record.disabled.has(callback)) return undefined;
    const fn = this.exported(record, callback);
    if (!fn) return undefined;
    return this.invoke(record, callback, () => fn.call(record.exports, ...args));
  }

  /**
   * `init` / `update` 的入参：状态里的当前值（没有时取编译期初值）。数取单精度、角度按 WPE 的 f32 算法换成度（`f32.ts`，
   * P3b 补测 `ignore/p3b-f32`）；存储不动，每次读都取一次。布尔、字符串原样。
   *
   * TODO:[WPE_SCENE] 没逐个实测：入参取单精度不分目标，实测只覆盖图层字段与材质常量；general、泛光、声音 `volume`、相机、文本、
   * 粒子实例覆盖的字段脚本入参是照同一规则推的，vec4 目标语料里没有样本（P3b 补测「没测到的项」）。
   */
  private value(record: ScriptRecord): unknown {
    const raw = this.options.read(record.script.target);
    const input = raw ?? record.script.initial;
    const type = record.script.valueType;
    if (type === "bool" || type === "string") return input;
    const values = Array.isArray(input)
      ? input
      : typeof input === "string"
        ? input.trim().split(/\s+/).map(Number)
        : [input];
    if (type === "float") {
      // rad2deg 的材质常量：状态存弧度、脚本读度（与材质对象字段读同一个换算）
      if (record.script.target.kind === "constant" && record.script.target.rad2deg && typeof values[0] === "number")
        return radiansToScript(values[0]);
      return scriptNumber(values[0]);
    }
    const size = type === "vec2" ? 2 : type === "vec4" ? 4 : 3;
    const prototype = this.realm.prototypes[`Vec${size}` as "Vec2" | "Vec3" | "Vec4"];
    const ctor = (prototype as { constructor: new (...args: number[]) => unknown }).constructor;
    const parts = values.map(Number);
    return new ctor(...(type === "angles" ? parts.map((part) => radiansToScript(part)) : scriptNumbers(parts)));
  }

  private writeReturn(record: ScriptRecord, result: unknown): void {
    const type = record.script.valueType;
    if (result === undefined || result === null) return;
    if (record.script.target.kind === "unsupported") {
      if (!this.unsupported.has(record.script.id)) {
        this.unsupported.add(record.script.id);
        this.options.report.warn(`场景脚本 ${record.script.id} 的写回目标暂不支持`);
      }
      return;
    }
    let value: ScriptValue;
    if (type === "bool") {
      if (typeof result !== "boolean") return;
      value = result;
    } else if (type === "string") {
      // 字符串只交给文本目标（P6b 1e）：WPE 类型 5 的 `ToString`（`12` → "12"，抛错的不写），枚举由宿主再查表。别的目标初值猜成
      // "string" 的（没有 `value`、材质常量写成一个词）照旧丢掉
      if (record.script.target.kind !== "text") return;
      const text = scriptToString(result);
      if (text === undefined) return;
      value = text;
    } else {
      const size = type === "float" ? 1 : type === "vec2" ? 2 : type === "vec4" ? 4 : 3;
      if (typeof result === "number") value = Array(size).fill(result);
      else if (typeof result === "object") {
        const vector = result as Record<string, unknown>;
        const parts = ["x", "y", "z", "w"].slice(0, size).map((key) => vector[key]);
        if (!parts.every((part) => typeof part === "number")) return;
        value = parts as number[];
      } else return;
      // 角度按 WPE 的 f32 乘法换成弧度（`f32.ts`）；其余数原样交给宿主（下一次读时再取 f32，同 WPE 存下的值）
      if (type === "angles" || (record.script.target.kind === "constant" && record.script.target.rad2deg))
        value = value.map((part) => degreesFromScript(part));
    }
    if (record.script.target.kind === "recompile") record.recompileWrites++;
    if (this.options.write(record.script.target, value, record.script.id))
      this.writes.set(targetKey(record.script.target), { target: record.script.target, value });
    else if (!this.unsupported.has(record.script.id)) {
      this.unsupported.add(record.script.id);
      this.options.report.warn(`场景脚本 ${record.script.id} 的写回目标暂不支持`);
    }
  }

  private makeRecord(script: SceneScript): ScriptRecord {
    return {
      script,
      module: null,
      instance: null,
      exports: null,
      state: "pending",
      disabled: new Set(),
      errors: [],
      calls: {},
      recompileWrites: 0,
      workshopId: null,
    };
  }

  /** 求值完一份模块状态：记下实例、导出、`__workshopId`（只认字符串；暂时性死区等读不出来当没有）。 */
  private adoptInstance(record: ScriptRecord, instance: ModuleInstance): void {
    record.instance = instance;
    record.exports = instance.namespace;
    record.state = "loaded";
    let id: unknown;
    try {
      id = instance.read("__workshopId");
    } catch {
      id = undefined;
    }
    record.workshopId = typeof id === "string" ? id : null;
    this.options.report.debug(`场景脚本 ${record.script.id} 导出：${Object.keys(record.exports).join(",")}`);
  }

  /** 第二轮：脚本属性初始化、`init`、写回返回值（`load` 与 `addScripts` 共用）。 */
  private initRecord(record: ScriptRecord): void {
    if (record.state !== "loaded") return;
    if (record.script.scriptProperties && record.exports) {
      try {
        this.realm.internal.updateScriptProperties(record.exports, JSON.stringify(record.script.scriptProperties));
      } catch (error) {
        this.options.report.warn(`场景脚本 ${record.script.id} 属性初始化失败：${messageOf(error)}`);
      }
    }
    const result = this.call(record, "init", this.value(record));
    this.writeReturn(record, result);
    record.state = "inited";
  }

  /**
   * 运行中追加脚本（P6d3b 点 11，`createLayer` 建出的对象上的脚本）：在 `createLayer` 返回前按条目顺序同步做完，效果是 WPE 的
   * `before` → 新层各段 `init` → `after`（步骤 0 实测 `wpe-clone.log`）。条目追加在 `records` 尾，所以同一轮 `update` 遍历得到它。
   * 模块已备好（realm 的 `preparedModule`，克隆的源码都是加载时备过的）就同步求值；没备过的异步 `prepareModule`，备好后补求值与 `init`
   * （已知差异：晚一段；语料 0 处）。async 模块（顶层 await）同样等 Promise 落定后再 `init`。
   */
  addScripts(scripts: readonly SceneScript[]): void {
    if (this.halted || scripts.length === 0) return;
    const fresh = scripts.map((script) => this.makeRecord(script));
    for (const record of fresh) {
      this.records.push(record);
      this.byId.set(record.script.id, record);
    }
    // 第一轮：求值
    for (const record of fresh) {
      if (record.script.errors.length) {
        record.state = "failed";
        record.errors.push(...record.script.errors);
        this.options.report.warn(`场景脚本 ${record.script.id} 导入说明符无效：${record.script.errors.join("；")}`);
        continue;
      }
      const module = this.realm.preparedModule?.(record.script.source) ?? null;
      if (module) this.evaluateRecord(record, module);
      else {
        this.options.report.debug(`场景脚本 ${record.script.id} 的源码没备过，晚一段 init`);
        this.realm.prepareModule(record.script.source, record.script.id).then(
          (prepared) => {
            if (this.halted) return;
            this.evaluateRecord(record, prepared);
            this.initRecord(record);
          },
          (error) => {
            record.state = "failed";
            record.errors.push(messageOf(error));
            this.options.report.warn(`场景脚本 ${record.script.id} 求值失败：${messageOf(error)}`);
          },
        );
      }
    }
    // 第二轮：属性初始化 + init + 写回（还没求值完的在 then 里补）
    for (const record of fresh) {
      this.initRecord(record);
      if (this.halted) break;
    }
  }

  /** 同步求值一份备好的模块；async 模块在 Promise 落定后接上并补 `init`。出错记失败。当前脚本 / 求值标志还原成调用前的（不是 null）。 */
  private evaluateRecord(record: ScriptRecord, module: ScriptModule): void {
    const previous = this.active;
    try {
      this.active = record;
      this.options.enterScript?.(record.script);
      this.options.setModuleEvaluating?.(true);
      record.module = module;
      const made = module.instantiate();
      if (typeof (made as { then?: unknown }).then === "function") {
        (made as Promise<ModuleInstance>).then(
          (instance) => {
            this.adoptInstance(record, instance);
            this.initRecord(record);
          },
          (error) => {
            record.state = "failed";
            record.errors.push(messageOf(error));
            this.options.report.warn(`场景脚本 ${record.script.id} 求值失败：${messageOf(error)}`);
          },
        );
      } else this.adoptInstance(record, made as ModuleInstance);
    } catch (error) {
      record.state = "failed";
      record.errors.push(messageOf(error));
      this.options.report.warn(`场景脚本 ${record.script.id} 求值失败：${messageOf(error)}`);
    } finally {
      this.active = previous;
      this.options.enterScript?.(previous?.script ?? null);
      this.options.setModuleEvaluating?.(false);
    }
  }

  /**
   * 新 bundle 换上时（P6d3b）：按 id 把条目的 `script` 换成新 bundle 里的同 id 项（`createLayer` 建出的对象编译后，常量目标的 uniform 信息等
   * 由编译填好）；运行时里没有的 id 不加、新 bundle 里没有的不删。
   */
  refreshScripts(list: readonly SceneScript[]): void {
    for (const script of list) {
      const record = this.byId.get(script.id);
      if (record) record.script = script;
    }
  }

  /**
   * @param afterInit 全部脚本跑完 `init` 之后调一次（P11c：WPE 在这一步按场景媒体状态给刚 `init` 的脚本补发一轮媒体回调，
   *   `media/scene.ts` 的 `replayAfterInit`，经 `mediaEvent`；在首次 `applyUserProperties` 之前）。
   */
  async load(scripts: SceneScripts, afterInit?: () => void): Promise<void> {
    this.records = scripts.list.map((script) => this.makeRecord(script));
    this.byId = new Map(this.records.map((record) => [record.script.id, record]));
    const start = (this.options.now ?? performance.now.bind(performance))();
    for (const record of this.records) {
      if (record.script.errors.length) {
        record.state = "failed";
        record.errors.push(...record.script.errors);
        this.options.report.warn(`场景脚本 ${record.script.id} 导入说明符无效：${record.script.errors.join("；")}`);
        continue;
      }
      try {
        this.active = record;
        this.options.enterScript?.(record.script);
        this.options.setModuleEvaluating?.(true);
        record.module = await this.realm.prepareModule(record.script.source, record.script.id);
        const made = record.module.instantiate();
        record.instance =
          typeof (made as { then?: unknown }).then === "function"
            ? await (made as Promise<ModuleInstance>)
            : (made as ModuleInstance);
        this.adoptInstance(record, record.instance);
      } catch (error) {
        record.state = "failed";
        record.errors.push(messageOf(error));
        this.options.report.warn(`场景脚本 ${record.script.id} 求值失败：${messageOf(error)}`);
      } finally {
        this.active = null;
        this.options.enterScript?.(null);
        this.options.setModuleEvaluating?.(false);
      }
    }
    // 迭代器每步重看长度：`init` 里 `createLayer` 追加的条目已由 `addScripts` 自己 init 过（状态 inited），这里跳过
    for (const record of this.records) {
      if (record.state !== "loaded") continue;
      this.initRecord(record);
      if (this.halted) break;
    }
    if (!this.halted) afterInit?.();
    this.options.report.info(
      `场景脚本加载完成：${this.records.length} 段，成功 ${this.records.filter((r) => r.state === "inited").length} 段，失败 ${this.records.filter((r) => r.state === "failed").length} 段，用时 ${Math.round((this.options.now ?? performance.now.bind(performance))() - start)} ms`,
    );
  }

  applyUserProperties(
    delta: Record<string, UserProperty>,
    full: ReadonlyMap<string, UserProperty>,
    bindings: readonly { property: string; condition?: string; target: ScriptTarget }[] = [],
  ): void {
    if (this.halted) return;
    this.options.setProperties?.(full);
    const converted: Record<string, UserProperty> = {};
    // 键按 WPE 的字节序（`scriptPropertyEntries`）：宿主首包是内置项在前、工程属性在后
    for (const [key, property] of scriptPropertyEntries(Object.entries(delta)))
      if (property && typeof property.type === "string" && "value" in property) converted[key] = property;
    const json = JSON.stringify(converted);
    for (const record of this.records) {
      if (record.state !== "inited") continue;
      const vars: Record<string, unknown> = {};
      for (const binding of bindings) {
        if (binding.target.kind !== "script-property" || binding.target.script !== record.script.id) continue;
        if (!(binding.property in delta)) continue;
        const raw = delta[binding.property]?.value;
        vars[binding.target.key] = binding.condition === undefined ? raw : String(raw) === binding.condition;
      }
      if (Object.keys(vars).length && record.exports) {
        try {
          this.realm.internal.updateScriptProperties(record.exports, JSON.stringify(vars));
        } catch (error) {
          this.options.report.warn(`场景脚本 ${record.script.id} 属性更新失败：${messageOf(error)}`);
        }
      }
      if (this.halted) break;
    }
    for (const record of this.records) {
      if (record.state !== "inited" || this.halted) continue;
      if (this.exported(record, "applyUserProperties"))
        this.call(record, "applyUserProperties", this.realm.internal.convertUserProperties(json));
    }
  }

  /**
   * 以某段脚本的身份调用宿主登记的回调（P9b：视频纹理的结束回调，WPE `addEndedCallback`）：进入那段脚本的上下文（`thisLayer` /
   * `thisObject` 是它的），计时、出错记进它的诊断（类别 `ended`），不禁用任何回调，同计时器。记录不在（脚本表已换、`owner` 不认识）
   * 或运行时已停止时不调。
   */
  callFor(owner: string, fn: (exports: Record<string, unknown>) => unknown): void {
    const record = this.byId.get(owner);
    if (!record || this.halted) return;
    // `fn` 多收一个参数：那段脚本的模块命名空间（P12c，动画层播完回调的 `this`，读码 3.2）
    this.invoke(record, "ended", () => fn(record.exports ?? {}));
  }

  setTimeout(callback: () => void, ms: number, owner = this.active?.script.id): () => void {
    return this.addTimer(callback, ms, null, owner);
  }
  setInterval(callback: () => void, ms: number, owner = this.active?.script.id): () => void {
    return this.addTimer(callback, ms, ms / 1000, owner);
  }
  clearTimeout(cancel: () => void): void {
    cancel();
  }
  private addTimer(callback: () => void, ms: number, period: number | null, owner?: string): () => void {
    const record = owner && this.byId.get(owner);
    if (!record) throw new Error("计时器必须归属于已加载的脚本");
    const timer: Timer = { owner: record, callback, remaining: Math.max(0, ms / 1000), period, cancelled: false };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  }

  frame(dt: number): void {
    if (this.halted) return;
    for (const timer of [...this.timers]) {
      if (timer.cancelled) continue;
      timer.remaining -= Math.max(0, dt);
      if (timer.remaining > 0) continue;
      this.invoke(timer.owner, "timer", () => {
        try {
          timer.callback();
        } catch (error) {
          timer.cancelled = true;
          throw error;
        }
      });
      if (timer.period === null || timer.period <= 0) timer.cancelled = true;
      // 补到下一个周期点：超出不足一个周期加 1 个周期；一帧跨过多个周期只触发一次、对齐到下一周期（待定 9）
      else timer.remaining += (Math.floor(-timer.remaining / timer.period) + 1) * timer.period;
      if (this.halted) break;
    }
    this.timers = this.timers.filter((timer) => !timer.cancelled);
    for (const record of this.records) {
      if (record.state !== "inited" || this.halted) continue;
      const result = this.call(record, "update", this.value(record));
      this.writeReturn(record, result);
    }
  }

  /**
   * 关键帧动画的事件（P10b，读码第 8 节）：交给同一对象（`object`，`general` 的为 null）上导出了 `animationEvent` 的全部脚本，按记录顺序
   * （= WPE 的登记顺序）。只发给已跑完 `init`、没被禁用这个回调的脚本；`event` 是 realm 的 `JSON.parse` 出的作者事件对象（每个接收者各解析
   * 一次，改它不影响别人），`value` 同 `update` 现读接收者自己的属性，返回值经 `writeReturn` 写回。出错只禁用这个回调（`invoke`）。
   * 在播放器循环中间同步调用，所以回调里可以对别的动画 `play` / `stop`，排在后面的那条本帧就生效。
   */
  animationEvent(object: number | null, json: string): void {
    if (this.halted) return;
    for (const record of this.records) {
      if (record.state !== "inited" || scriptObject(record.script.owner) !== object) continue;
      if (record.disabled.has("animationEvent") || !this.exported(record, "animationEvent")) continue;
      const parse = (this.realm.global.JSON as JSON).parse;
      const result = this.call(record, "animationEvent", parse(json), this.value(record));
      this.writeReturn(record, result);
      if (this.halted) break;
    }
  }

  /**
   * 光标回调（P6c，rea-p6c-dispatch 4.1、rea-p6c-script 1、2）：交给同一对象（`object`）上导出了 `callback` 的全部脚本，按记录顺序
   * （= WPE 的登记顺序：该对象各字段上的脚本各一段）。只发给已跑完 `init`、没被禁用这个回调的脚本；`world` / `local` 是 float32 展开的
   * 三个分量，每个接收者各建一个事件对象 `{ button: 0, worldPosition, localPosition }`（向量原型是 realm 的 `Vec3`，值是单精度，没有
   * `hitBox`：木偶命中框是 P12，没有 `screenPosition`），改它不影响同一次派发里别的脚本。回调的返回值丢弃（WPE 只写回 `init` /
   * `update` / `animationEvent`）；出错只禁用这个回调（`invoke`）。同 `animationEvent`，在渲染器帧内同步调用，回调里写的字段当帧画出。
   */
  cursorEvent(object: number, callback: CursorCallback, world: readonly number[], local: readonly number[]): void {
    if (this.halted) return;
    for (const record of this.records) {
      if (record.state !== "inited" || scriptObject(record.script.owner) !== object) continue;
      if (record.disabled.has(callback) || !this.exported(record, callback)) continue;
      this.call(record, callback, this.cursorEventObject(world, local));
      if (this.halted) break;
    }
  }

  /** 光标事件对象（见 `cursorEvent`）：普通对象，成员顺序 `button`、`worldPosition`、`localPosition`，两个向量是 realm 的 `Vec3`。 */
  private cursorEventObject(world: readonly number[], local: readonly number[]): unknown {
    const prototype = this.realm.prototypes.Vec3;
    const Vec3 = (prototype as { constructor: new (...values: number[]) => unknown }).constructor;
    const vector = (values: readonly number[]) => new Vec3(...scriptNumbers(values.slice(0, 3)));
    const event = new (this.realm.global.Object as ObjectConstructor)() as Record<string, unknown>;
    event.button = 0;
    event.worldPosition = vector(world);
    event.localPosition = vector(local);
    return event;
  }

  /**
   * 系统媒体回调（P11c，rea-p11-media 2.3）：发给全部已跑完 `init`、导出了该回调且没被禁用的脚本，按记录顺序（= WPE 的登记顺序，全场景广播、
   * 不分对象）。`makeEvent` 每个接收者各调一次（事件对象是普通对象，改它不影响别人），参数是脚本所在的 realm（对象与 `Vec3` 要在里面建）。
   * 回调只有一个参数、返回值丢弃（WPE 只写回 `init` / `update` / `animationEvent`）；出错只禁用这个回调（`invoke`）。
   */
  mediaEvent(callback: MediaCallback, makeEvent: (realm: ScriptRealm) => unknown): void {
    if (this.halted) return;
    for (const record of this.records) {
      if (record.state !== "inited" || record.disabled.has(callback) || !this.exported(record, callback)) continue;
      this.call(record, callback, makeEvent(this.realm));
      if (this.halted) break;
    }
  }

  /** 某个对象上有没有脚本导出了光标回调（`cursorHitTest` 也算：它只打开拾取）：渲染器据此决定每帧要不要做命中测试。 */
  get hasCursorCallbacks(): boolean {
    return this.records.some(
      (record) => record.state === "inited" && CURSOR_EXPORTS.some((name) => this.exported(record, name)),
    );
  }

  replayWrites(): void {
    for (const { target, value } of this.writes.values()) this.options.write(target, value, "script-replay");
  }
  rememberWrite(target: ScriptTarget, value: ScriptValue): void {
    this.writes.set(targetKey(target), { target, value });
  }
  /** 脚本对这个目标有没有写入记录（重放表里）；加载时据此判断要不要补属性值（`initialApply.ts`）。 */
  hasWrite(target: TargetKey): boolean {
    return this.writes.has(target);
  }
  forgetWrite(target: TargetKey): void {
    this.writes.delete(target);
  }
  /**
   * `destroyLayer` 生效（P6d3a，rea-p6d-layers 6.3 第 4 条）：属主是这些对象的条目（`scriptObject(owner)` 在集合里：图层字段、effect、
   * 材质常量、动画层）按条目顺序先收 `destroy`（导出了、已 `init` 才调），再从 `records` / `byId` 摘掉；它们的计时器去掉；
   * 写入重放表里以 `objects/<i>/` 开头的项去掉（重编译后不重放到不存在的对象上）。只在脚本阶段之后调：`records` 换成新数组，
   * 不影响正在进行的遍历。
   */
  destroyObjects(objects: ReadonlySet<number>): void {
    if (objects.size === 0) return;
    const owned = (record: ScriptRecord): boolean => {
      const object = scriptObject(record.script.owner);
      return object !== null && objects.has(object);
    };
    for (const record of this.records) {
      if (!owned(record)) continue;
      if (record.state === "inited" && !this.halted) this.call(record, "destroy");
    }
    const gone = new Set(this.records.filter(owned));
    if (gone.size > 0) {
      this.records = this.records.filter((record) => !gone.has(record));
      for (const record of gone) this.byId.delete(record.script.id);
      for (const timer of this.timers) if (gone.has(timer.owner)) timer.cancelled = true;
      this.timers = this.timers.filter((timer) => !timer.cancelled);
    }
    for (const key of [...this.writes.keys()]) {
      const match = /^objects\/(\d+)\//.exec(key);
      if (match && objects.has(Number(match[1]))) this.writes.delete(key);
    }
  }

  destroy(): void {
    for (const record of this.records) if (record.state === "inited" && !this.halted) this.call(record, "destroy");
    this.timers = [];
    // 加载中被销毁时（清空存储重启），还没跑的 init 不再跑：它们会把值写回刚清空的存储
    this.halted = true;
    this.realm.dispose();
  }
}
