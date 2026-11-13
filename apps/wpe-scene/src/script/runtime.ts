import { type TargetKey, type UserProperty } from "../compile/bindings";
import { scriptToString } from "../text/fields";
import { type SceneScript, type SceneScripts } from "../compile/scripts";
import { type SceneReporter } from "../report";

export interface ScriptRealm {
  readonly global: Record<string, unknown>;
  readonly prototypes: { Vec2: object; Vec3: object; Vec4: object; Mat3: object; Mat4: object };
  readonly internal: {
    updateScriptProperties(script: Record<string, unknown>, vars: string): void;
    convertUserProperties(json: string): Record<string, unknown>;
  };
  importModule(source: string, label: string): Promise<Record<string, unknown>>;
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
export const RUNTIME_CALLBACKS = ["init", "update", "applyUserProperties", "destroy"] as const;
type Callback = (typeof RUNTIME_CALLBACKS)[number];
/**
 * 宿主代为调用的回调类别（不是导出回调）：`timer` 是 `engine.setTimeout` / `setInterval`，`ended` 是视频纹理的结束回调（P9b，
 * `callFor`）。出错只记诊断、不禁用所属脚本的任何导出回调；统计照常记在 `calls[类别]` 下。
 */
type HostCallback = "timer" | "ended";
interface ScriptRecord {
  script: SceneScript;
  exports: Record<string, unknown> | null;
  state: "pending" | "loaded" | "inited" | "failed";
  disabled: Set<Callback>;
  errors: string[];
  calls: Record<string, { count: number; maxMs: number }>;
  /** 回调返回值写到重编译目标的次数（API 直接写入由 `ScriptApi` 另计，探针合并）。 */
  recompileWrites: number;
}
interface Timer {
  owner: ScriptRecord;
  callback: () => void;
  remaining: number;
  period: number | null;
  cancelled: boolean;
}

/** 写回目标的路径（重放表的键，同宿主的 `targetPath`）；dev 探针跑脚本时用它记重编译类写入（`dev/probeScripts.ts`）。 */
export function targetKey(target: ScriptTarget): string {
  switch (target.kind) {
    case "layer":
      return `objects/${target.object}/${target.field}`;
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
  const location = /blob:[^\s)]+:(\d+):(\d+)/.exec(stack);
  return location ? `${message} (line ${location[1]}, col ${location[2]})` : message;
}

export class ScriptRuntime {
  private records: ScriptRecord[] = [];
  private byId = new Map<string, ScriptRecord>();
  private timers: Timer[] = [];
  private writes = new Map<string, { target: ScriptTarget; value: ScriptValue }>();
  private unsupported = new Set<string>();
  private halted = false;
  private active: ScriptRecord | null = null;

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
  get stopped(): boolean {
    return this.halted;
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
    this.active = record;
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
      this.options.enterScript?.(previous?.script ?? null);
      if (elapsed > 15_000 && !this.halted) {
        this.halted = true;
        this.options.report.error("脚本执行超过 15 秒，已停止本场景全部脚本");
      }
    }
    return result;
  }

  private call(record: ScriptRecord, callback: Callback, argument?: unknown): unknown {
    if (record.disabled.has(callback) || !record.exports || typeof record.exports[callback] !== "function")
      return undefined;
    return this.invoke(record, callback, () => (record.exports![callback] as (arg?: unknown) => unknown)(argument));
  }

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
    if (type === "float") return values[0];
    const size = type === "vec2" ? 2 : type === "vec4" ? 4 : 3;
    const prototype = this.realm.prototypes[`Vec${size}` as "Vec2" | "Vec3" | "Vec4"];
    const ctor = (prototype as { constructor: new (...args: number[]) => unknown }).constructor;
    const parts = values.map(Number);
    if (type === "angles") for (let i = 0; i < parts.length; i++) parts[i] /= 0.017453292;
    return new ctor(...parts);
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
      if (type === "angles") value = value.map((part) => part * 0.017453292);
    }
    if (record.script.target.kind === "recompile") record.recompileWrites++;
    if (this.options.write(record.script.target, value, record.script.id))
      this.writes.set(targetKey(record.script.target), { target: record.script.target, value });
    else if (!this.unsupported.has(record.script.id)) {
      this.unsupported.add(record.script.id);
      this.options.report.warn(`场景脚本 ${record.script.id} 的写回目标暂不支持`);
    }
  }

  async load(scripts: SceneScripts): Promise<void> {
    this.records = scripts.list.map((script) => ({
      script,
      exports: null,
      state: "pending",
      disabled: new Set(),
      errors: [],
      calls: {},
      recompileWrites: 0,
    }));
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
        record.exports = await this.realm.importModule(record.script.source, record.script.id);
        record.state = "loaded";
        this.options.report.debug(`场景脚本 ${record.script.id} 导出：${Object.keys(record.exports).join(",")}`);
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
    for (const record of this.records) {
      if (record.state !== "loaded") continue;
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
      if (this.halted) break;
    }
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
    for (const [key, property] of Object.entries(delta))
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
      if (typeof record.exports?.applyUserProperties === "function")
        this.call(record, "applyUserProperties", this.realm.internal.convertUserProperties(json));
    }
  }

  /**
   * 以某段脚本的身份调用宿主登记的回调（P9b：视频纹理的结束回调，WPE `addEndedCallback`）：进入那段脚本的上下文（`thisLayer` /
   * `thisObject` 是它的），计时、出错记进它的诊断（类别 `ended`），不禁用任何回调，同计时器。记录不在（脚本表已换、`owner` 不认识）
   * 或运行时已停止时不调。
   */
  callFor(owner: string, fn: () => unknown): void {
    const record = this.byId.get(owner);
    if (!record || this.halted) return;
    this.invoke(record, "ended", fn);
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

  replayWrites(): void {
    for (const { target, value } of this.writes.values()) this.options.write(target, value, "script-replay");
  }
  rememberWrite(target: ScriptTarget, value: ScriptValue): void {
    this.writes.set(targetKey(target), { target, value });
  }
  forgetWrite(target: TargetKey): void {
    this.writes.delete(target);
  }
  destroy(): void {
    for (const record of this.records) if (record.state === "inited" && !this.halted) this.call(record, "destroy");
    this.timers = [];
    // 加载中被销毁时（清空存储重启），还没跑的 init 不再跑：它们会把值写回刚清空的存储
    this.halted = true;
    this.realm.dispose();
  }
}
