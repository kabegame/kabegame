/**
 * kbp-tools 回放库（点 4）：在 Node 里直接用产品源码按 WPE 的时间线回放模拟器，和 RenderDoc 轨迹逐粒子比。
 *
 * 由 `b3`、`b4`、`b6`、`c1`–`c4`、`d1` 的回放脚本（`ignore/p4/<步骤>/replay.test.ts`，`c5/` 下是它们的最新拷贝）的公共部分收成：
 * - 编译：`compileScene`，读盘用 `nodeReader`，场景资源加 WPE `assets/`（`KABEGAME_WPE_ROOT`），`fileUrl` 换成恒等；
 * - 时间线：`apps/kabegame-dev-mcp/src/timeline.ts`（唯一实现，不另写）；
 * - 模拟：产品的 `ParticleSystem`，第 i 个粒子层种子 `1 + i`，加载时预热、再按 dt 步进；出生序号、出生帧、出生以来的最大坐标照原脚本记；
 * - 包络：近似运算包络照原脚本 `vi.doMock` 产品的 `particles/f32`（`rcp`、`rsqrt` 乘 1 ± 3.7e-4，四种组合各跑一遍，逐粒子逐分量取
 *   |偏置 − 精确|）；输入精度包络（b4）把日志来的 dt、T 各加 ±5e-7 的扰动跑 N 遍；
 * - 比较：同一系统按槽序配对，限值 = 基础限值（位置 1e-3，坐标过 1000 取 2e-3；size 1e-3；color / alpha 2e-3；rot 1e-3）+ 包络；
 *   另有 `color`（b6：逐粒子 rgb，按线段拟合）与 `rope`（d1：绳的段顶点）两种模式；
 * - 报告：`<out>/<案例>.txt`、`.json`（不含路径与耗时，两份源码上跑出的结果可以逐字节比较），`<out>/<案例>.meta.json`（源码、耗时、错误）。
 *
 * 个案逻辑（定符号、注入 R、反推缺帧 dt、脚本驱动的对象、额外核对）放在案例的钩子模块里（`<data>/cases/<名字>.hook.ts`），
 * 钩子拿到 `CaseContext`，用这里的积木（`simulate`、`withApprox`、`withInput`、`compare`、`addSystem`、`check`…）。
 */
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import path from "node:path";
import { vi } from "vitest";
import { buildTimeline, type Timeline } from "../../../../apps/kabegame-dev-mcp/src/timeline";

// ==================== 类型 ====================

export type Point = [number, number];
export type Mode = "position" | "color" | "rope";

export interface Limits {
  pos: number;
  /** 坐标超过 farCoord 时的位置限值。 */
  posFar: number;
  farCoord: number;
  size: number;
  color: number;
  alpha: number;
  rot: number;
  /** 绳：段数据里的 TL、TP（不加包络）。 */
  tl: number;
  tp: number;
}

export const DEFAULT_LIMITS: Limits = {
  pos: 1e-3,
  posFar: 2e-3,
  farCoord: 1000,
  size: 1e-3,
  color: 2e-3,
  alpha: 2e-3,
  rot: 1e-3,
  tl: 1e-4,
  tp: 1e-4,
};

/** 案例里的一组回放（一个工程 × 若干抓帧标签）；案例顶层是这些字段的缺省值，`runs` 逐项覆盖。 */
export interface RunSpec {
  /** 报告里的段名前缀（缺省就用标签）。 */
  label?: string;
  /** `<data>/proj/<project>`；缺省取轨迹的 `project`，再缺省从标签的 `<工程>-fps<N>` 推。 */
  project?: string;
  /** 抓帧标签：轨迹 `<data>/tracks/rd-<tag>.json`，日志 `<data>/out/<tag>-log.txt`。 */
  tags: string[];
  /** 缺省按标签里的 fps 推（timeline.ts 的 passesFromTag）。 */
  passes?: 1 | 2;
  /** 绳：`writeRopeSegments` 读的 fps，缺省取标签里的 fps。 */
  fps?: number;
  systems?: {
    /** 只比这些（按这个顺序）。 */
    only?: string[];
    skip?: string[];
    /** 名字匹配这个正则的不比。 */
    skipPattern?: string;
    /** 系统表取轨迹第一帧（first）还是全部帧的并集（union，缺省）。 */
    source?: "first" | "union";
    /** 照比、照报，但不算进「是否全部通过」。 */
    informational?: string[];
  };
  mode?: Mode;
  /** 编译用的场景后处理档位（P4f 步骤 2：超高档 HDR 下的 `brightness`），缺省 disabled。 */
  postprocess?: "disabled" | "enabled" | "ultra";
  inputs?: {
    /** 控制点输入的对象世界矩阵：none（不传控制点输入，P4b 及以前）、static（编译期变换）、hook（钩子的 world）。 */
    world?: "none" | "static" | "hook";
    /**
     * 跟随点：none（不传）、zero（pointer [0, 0]）、track（轨迹指针，窗口之前取窗口第一帧的）、log（每帧取日志的屏幕光标 ÷ 窗口尺寸，
     * 要 cursor=True 生成的工程，P5a 收尾）；track、log 在标签带 -宽x高 时按 fill 反算。
     */
    cursors?: "none" | "zero" | "track" | "log";
    /** 传给 step 的场景时间：none（不传，模拟器自己累加）、cur（本帧 g_Time）、prev（上一帧的，第 1 帧为 0）。 */
    time?: "none" | "cur" | "prev";
    /** 运行中改属性的文件（相对数据目录，`{tag}` 换成标签），格式 [{ frame, properties }]（b6）。 */
    changes?: string;
  };
  /** 日志与轨迹都缺的帧：error（缺省）或 split（平分）。 */
  gap?: "error" | "split";
  envelope?: { approx?: boolean; input?: number };
  limits?: Partial<Limits>;
  compare?: {
    /** 坐标分档用粒子出生以来的最大坐标（缺省 true）。 */
    history?: boolean;
    /** 预热时出生（没有出生序号）的粒子怎么记历史坐标：ignore（b3 起的写法，查不到）或 pool（c3 起，合成一份）。 */
    historyUnborn?: "ignore" | "pool";
    /** 这些系统只比窗口内出生的粒子（出生帧 ≥ 第一个抓帧）。 */
    windowOnly?: string[];
    /** 通过要求比过至少一个粒子（缺省 true；c3 不要求）。 */
    requireParticles?: boolean;
  };
  /** 编译的不支持项：expect 精确相等（缺省 []）；allow 是正则，只许出现匹配的；report 只报不判。 */
  unsupported?: { expect?: string[]; allow?: string; report?: boolean };
  /** 给钩子的自由参数。 */
  options?: Record<string, unknown>;
}

export interface ReplayCase extends Partial<RunSpec> {
  name: string;
  description?: string;
  /** 钩子模块，相对 `<data>/cases/`（缺省 `<名字>.hook.ts` 存在就用）。 */
  hook?: string;
  runs?: Partial<RunSpec>[];
}

export interface Particle {
  pos: number[];
  size: number;
  color: number[];
  alpha: number;
  rot: number[];
  [key: string]: unknown;
}
export interface SimParticle extends Particle {
  birth: number;
  born: number;
  age: number;
  life: number;
  vel?: number[];
}
export type SimFrames = Map<number, Record<string, SimParticle[]>>;
export interface TrackFrame {
  frame: number;
  dt: number;
  time?: number;
  pointer?: Point | null;
  systems: Record<string, any>;
}
export interface Track {
  project?: string;
  tag?: string;
  frames: TrackFrame[];
}

export interface FieldStat {
  diff: number;
  envelope: number;
  over: number;
  ratio: number;
}
export interface Stats {
  frames: number;
  particles: number;
  skipped: number;
  countMismatch: string[];
  counts: string[];
  coord: number;
  fields: Record<string, FieldStat>;
  /** 年龄 < 1 s 的粒子的位置最大差（b4）。 */
  youngPos: number;
  /** 位置逐轴最大差（c2 起）。 */
  posAxis: number[];
  worst?: Record<string, unknown>;
}

export interface SystemResult {
  mode: Mode | "custom";
  ok: boolean;
  /** false：只报告，不算进「是否全部通过」。 */
  judged: boolean;
  stats: Record<string, unknown>;
}

export interface Check {
  name: string;
  ok: boolean;
  judged: boolean;
  detail?: string;
}

export interface SectionReport {
  label: string;
  project: string;
  tag: string;
  passes: 1 | 2;
  mode: Mode;
  frames: number[];
  unsupported: string[];
  systems: Record<string, SystemResult>;
  checks: Check[];
  notes: string[];
  /** 钩子另外记的数据（照原脚本的 summary 写法）。 */
  extra: Record<string, unknown>;
}

export interface CaseReport {
  case: string;
  description?: string;
  ok: boolean;
  sections: SectionReport[];
  checks: Check[];
  notes: string[];
}

/** 一段回放（run × 标签）的输入。钩子可以改 dts、times、cursors、follows、world。 */
export interface Section {
  index: number;
  run: RunSpec;
  label: string;
  project: string;
  tag: string;
  passes: 1 | 2;
  fps: number | null;
  mode: Mode;
  bundle: any;
  /** 全部图层（建变换表）；粒子层是 `particle` 非空的。 */
  layers: any[];
  truth: Track;
  frames: number[];
  timeline: Timeline;
  dts: number[];
  times: number[];
  /** 每帧来源：log（日志，6 位小数）、shot（抓帧，float32 原值）、split（平分或钩子补的）。 */
  sources: ("log" | "shot" | "split")[];
  scene: Point;
  window: Point;
  cursors?: Point[];
  follows?: Point[];
  world?: (layer: any, frame: number) => unknown;
  limits: Limits;
  report: SectionReport;
  /** 钩子的私有状态。 */
  state: Record<string, unknown>;
}

export interface SimOptions {
  dts: number[];
  times: number[];
  /** 传给 step 的场景时间取法（缺省按 run.inputs.time）。 */
  timeMode: "none" | "cur" | "prev";
  frames: number[];
  passes: 1 | 2;
  /** 传不传控制点输入（world、pointer）。 */
  controls: boolean;
  world?: (layer: any, frame: number) => unknown;
  follows?: Point[];
  /** 按系统名包一层随机源。 */
  random?: Record<string, (base: RandomLike) => RandomLike>;
  /** 按系统名、出生序号注入 R（`injectedR`）。 */
  r?: Record<string, number[]>;
  /**
   * 逐帧的 16 段频谱（P4e 步骤 4，下标 = 帧号 − 1）：抓到的帧取 CLK 读到的 `g_AudioSpectrum16Left/Right`，其余为 null（沿用前一帧；第一个
   * 有值的帧之前是 0，同加载时）。原样写进粒子共用的频谱（`particles/audio` 的 `writeParticleAudio`），不经归一化。轨迹没有 `audio` 时不给。
   */
  audio?: ({ left: number[]; right: number[] } | null)[];
  /** 建好系统后改模块（k 换 h、改字段…）。 */
  patch?: (system: any, layer: any) => void;
  /** 记录速度（b4）。 */
  vel?: boolean;
  /**
   * 每个系统步进完调一次：(系统名, 系统, 帧号, 步进前的存活数, 出生表, 这一帧传给 step 的控制点输入)。最后一个参数 P4f 步骤 3 起：
   * 钩子在「脚本阶段」调 `emitParticles(n, inputs)` 时用（对象 `W` 等和 step 的一致）。
   */
  observe?: (
    name: string,
    system: any,
    frame: number,
    before: number,
    births: Map<number, [number, number]>,
    inputs?: unknown,
  ) => void;
  /** 只步进这些图层（缺省全部粒子层）。 */
  layers?: any[];
}
export interface RandomLike {
  a(): number;
  b(): number;
}
export interface SimResult {
  out: SimFrames;
  history: Map<string, number>;
  births: Record<string, number>;
}
export interface Reference {
  exact: SimFrames;
  envelopes: SimFrames[];
  history: Map<string, number>;
  births: Record<string, number>;
}

export interface CompareOptions {
  /** 拿来比的模拟，缺省 ref.exact（包络始终相对 ref.exact）。 */
  sim?: SimFrames;
  /** 换成比较用的形状（b3 的 box：|x − 900|）。 */
  map?: (p: Particle) => Particle;
  /** 坐标分档用出生以来的最大坐标（缺省按 run.compare.history）。 */
  history?: boolean;
  /** 不比（只计数）的粒子。 */
  skip?: (p: SimParticle) => boolean;
  /** 包络（缺省 ref.envelopes）。 */
  envelopes?: SimFrames[];
  requireParticles?: boolean;
}

/** 钩子模块的接口（全部可选）。 */
export interface CaseHook {
  /** 改时间线（b4 用定好的拆分、d1 用 R9 反推缺帧 dt）：直接改 sec.dts / sec.times / sec.sources。 */
  timeline?(ctx: CaseContext, sec: Section): void | Promise<void>;
  /** 对象的世界矩阵（inputs.world 为 hook 时）：frame 0 是预热。 */
  world?(
    ctx: CaseContext,
    sec: Section,
  ): ((layer: any, frame: number) => unknown) | Promise<(layer: any, frame: number) => unknown>;
  /** 完全接管一段（不跑标准流程）；可以调 ctx.standard(sec, …)。 */
  section?(ctx: CaseContext, sec: Section): void | Promise<void>;
  /** 标准流程里模拟的额外选项（注入 R、随机源包装、模块补丁）。 */
  prepare?(ctx: CaseContext, sec: Section): Partial<SimOptions> | Promise<Partial<SimOptions>>;
  /** 标准流程里每个系统的比较选项。 */
  compareOptions?(ctx: CaseContext, sec: Section, name: string, ref: Reference): CompareOptions;
  /** 标准流程比完之后：额外核对、变体。 */
  after?(ctx: CaseContext, sec: Section, ref: Reference): void | Promise<void>;
  /** 整个案例跑完。 */
  finish?(ctx: CaseContext): void | Promise<void>;
}

// ==================== 读盘与公共 ====================

export const FIELDS = ["pos", "size", "color", "alpha", "rot"] as const;
export const EPS = 3.7e-4;
const LOG_EPS = 5e-7;
const SPLIT_EPS = 1e-5;

export const slash = (p: string) => p.replace(/\\/g, "/");

/** WPE 安装目录：KABEGAME_WPE_ROOT，缺省同 kbp.py。 */
export function wpeRoot(): string {
  return slash(process.env.KABEGAME_WPE_ROOT || "D:/Applications/Steam/steamapps/common/wallpaper_engine");
}

export const nodeReader = {
  async readWhole(file: string): Promise<Uint8Array> {
    if (!existsSync(file)) throw new TypeError("Failed to fetch");
    return new Uint8Array(readFileSync(file));
  },
  async readRange(file: string, start: number, end: number): Promise<Uint8Array> {
    if (!existsSync(file)) throw new TypeError("Failed to fetch");
    const fd = openSync(file, "r");
    try {
      const size = fstatSync(fd).size;
      if (start >= size) throw new TypeError("Failed to fetch");
      const bytes = new Uint8Array(Math.max(0, Math.min(end, size) - start));
      readSync(fd, bytes, 0, bytes.length, start);
      return bytes;
    } finally {
      closeSync(fd);
    }
  },
};

/** 轨迹是 Python 写的 JSON，可能带 NaN / Infinity（按 null 读，同 timeline.ts）。 */
export function readTrack(file: string): Track {
  if (!existsSync(file)) throw new KbpReplayError("data", `找不到轨迹 ${file}`);
  return JSON.parse(readFileSync(file, "utf8").replace(/([[,:]\s*)-?(?:NaN|Infinity)(?=\s*[,\]}])/g, "$1null"));
}

/**
 * 逐帧频谱（P4e 步骤 4，`SimOptions.audio`）：轨迹帧带 `audio`（`kbp rdc track` 记下的 CLK 读数）时取 `g_AudioSpectrum16Left/Right`，
 * 其余帧为 null。一帧都没有时返回 undefined（不给模拟器设频谱，旧源码照常能跑）。
 */
export function audioTimeline(sec: Pick<Section, "truth" | "dts">): SimOptions["audio"] {
  const out: NonNullable<SimOptions["audio"]> = sec.dts.map(() => null);
  let any = false;
  for (const frame of sec.truth.frames as any[]) {
    const left = frame.audio?.g_AudioSpectrum16Left;
    const right = frame.audio?.g_AudioSpectrum16Right;
    if (!Array.isArray(left) || !Array.isArray(right) || frame.frame < 1 || frame.frame > out.length) continue;
    out[frame.frame - 1] = { left, right };
    any = true;
  }
  return any ? out : undefined;
}

export class KbpReplayError extends Error {
  constructor(
    public layer: string,
    message: string,
  ) {
    super(`[${layer}] ${message}`);
  }
}

export function loadCase(data: string, name: string): ReplayCase {
  const file = path.join(data, "cases", `${name}.json`);
  if (!existsSync(file)) throw new KbpReplayError("data", `找不到案例 ${file}`);
  const value = JSON.parse(readFileSync(file, "utf8")) as ReplayCase;
  if (value.name !== name)
    throw new KbpReplayError("data", `${file} 的 name 是 ${JSON.stringify(value.name)}，应为 ${name}`);
  return value;
}

/** 案例展开成若干 run：顶层是缺省值，runs 逐项覆盖（inputs、systems、compare、envelope、limits、unsupported、options 浅合并）。 */
export function expandRuns(c: ReplayCase): RunSpec[] {
  const base: Partial<RunSpec> = { ...c };
  delete (base as any).runs;
  const list = c.runs?.length ? c.runs : [{}];
  return list.map((run) => {
    const merged: any = { ...base, ...run };
    for (const key of ["inputs", "systems", "compare", "envelope", "limits", "unsupported", "options"])
      merged[key] = { ...((base as any)[key] ?? {}), ...((run as any)[key] ?? {}) };
    if (!merged.tags?.length) throw new KbpReplayError("data", `${c.name}：run 没有 tags`);
    return merged as RunSpec;
  });
}

const fpsOf = (tag: string) => {
  const m = /(?:^|[-_])fps(\d+)(?=$|[-_])/i.exec(tag);
  return m ? Number(m[1]) : null;
};

// ==================== 近似运算的偏置开关 ====================

/** 偏置：产品 `particles/f32` 的 rcp、rsqrt 乘 (1 + 偏置)。偏置为 0 时和原函数逐位相同。 */
export const bias = { rcp: 0, rsqrt: 0 };

/** 案例要不要近似运算包络（要的才挂 f32 的 mock：mock 让热循环里的 rcp / rsqrt 多一层调用，b4 慢 3 倍多）。 */
export const needsApprox = (c: ReplayCase) => expandRuns(c).some((run) => run.envelope?.approx);

export function registerMocks(src: string, approx = true): void {
  vi.doMock(`${src}/fileUrl`, () => ({ fileToUrl: (file: string) => file }));
  if (!approx) {
    vi.doUnmock(`${src}/particles/f32`);
    return;
  }
  vi.doMock(`${src}/particles/f32`, async (importOriginal) => {
    const original = await importOriginal<{
      f32: (x: number) => number;
      rcp: (x: number) => number;
      rsqrt: (x: number) => number;
    }>();
    return {
      ...original,
      rcp: (x: number) => original.f32(original.rcp(x) * (1 + bias.rcp)),
      rsqrt: (x: number) => original.f32(original.rsqrt(x) * (1 + bias.rsqrt)),
    };
  });
}

// ==================== 比较 ====================

function baseLimit(limits: Limits, field: string, coord: number): number {
  if (field === "pos") return coord > limits.farCoord ? limits.posFar : limits.pos;
  return (limits as any)[field];
}

const components = (p: Particle, field: string): number[] => {
  const value = (p as any)[field];
  return Array.isArray(value) ? value : [value];
};

/**
 * 逐粒子比（各回放脚本 `compare` 的并集，数值逐位相同）：同一系统按槽序配对；包络 = |包络模拟 − ref.exact|；限值 = 基础限值 + 包络；
 * 坐标分档用 WPE 粒子的当前坐标与我们这个粒子出生以来的最大坐标中较大的一个（history 关掉时只看 WPE 的）。
 */
export function compareParticles(
  truth: Track,
  name: string,
  ref: Pick<Reference, "exact" | "envelopes" | "history">,
  limits: Limits,
  options: CompareOptions = {},
): Stats {
  const sim = options.sim ?? ref.exact;
  const map = options.map ?? ((p: Particle) => p);
  const envelopes = options.envelopes ?? ref.envelopes;
  const history = options.history === false ? undefined : ref.history;
  const s: Stats = {
    frames: 0,
    particles: 0,
    skipped: 0,
    countMismatch: [],
    counts: [],
    coord: 0,
    fields: {},
    youngPos: 0,
    posAxis: [0, 0, 0],
  };
  for (const field of FIELDS) s.fields[field] = { diff: 0, envelope: 0, over: 0, ratio: 0 };
  let worstRatio = 0;
  for (const frame of truth.frames) {
    const a: Particle[] = frame.systems[name] ?? [];
    const b = sim.get(frame.frame)?.[name] ?? [];
    const base = ref.exact.get(frame.frame)?.[name] ?? [];
    s.counts.push(`${a.length}/${b.length}`);
    if (a.length !== b.length || a.length !== base.length) {
      s.countMismatch.push(`${frame.frame}:${a.length}/${b.length}`);
      continue;
    }
    s.frames++;
    for (let i = 0; i < a.length; i++) {
      if (options.skip?.(b[i])) {
        s.skipped++;
        continue;
      }
      s.particles++;
      const wpe = map(a[i]);
      const ours = map(b[i]);
      const exact = map(base[i]);
      const coord = Math.max(...a[i].pos.map(Math.abs), history?.get(`${name}:${b[i].birth}`) ?? 0);
      s.coord = Math.max(s.coord, coord);
      for (const field of FIELDS) {
        const w = components(wpe, field);
        const o = components(ours, field);
        const x = components(exact, field);
        w.forEach((value, k) => {
          const diff = Math.abs(value - o[k]);
          if (field === "pos") s.posAxis[k] = Math.max(s.posAxis[k], diff);
          let envelope = 0;
          for (const other of envelopes) {
            const e = other.get(frame.frame)?.[name]?.[i];
            if (e) envelope = Math.max(envelope, Math.abs(components(map(e), field)[k] - x[k]));
          }
          const limit = baseLimit(limits, field, coord) + envelope;
          const f = s.fields[field];
          f.diff = Math.max(f.diff, diff);
          f.envelope = Math.max(f.envelope, envelope);
          f.ratio = Math.max(f.ratio, diff / limit);
          if (!(diff <= limit)) f.over++;
          if (field === "pos" && b[i].age < 1) s.youngPos = Math.max(s.youngPos, diff);
          if (diff / limit > worstRatio) {
            worstRatio = diff / limit;
            s.worst = {
              frame: frame.frame,
              index: i,
              field,
              component: k,
              wpe: value,
              ours: o[k],
              diff,
              limit,
              envelope,
              coord,
              birth: b[i].birth,
              born: b[i].born,
              age: b[i].age,
            };
          }
        });
      }
    }
  }
  return s;
}

export const statsOk = (s: Stats, requireParticles = true) =>
  s.frames > 0 &&
  (!requireParticles || s.particles > 0) &&
  !s.countMismatch.length &&
  Object.values(s.fields).every((f) => f.over === 0);

const e2 = (v: number) => v.toExponential(2);

/** 一行文字（报告用，各模式通用）。 */
export function statsRow(name: string, s: Stats, ok: boolean, judged: boolean): string {
  const p = s.fields.pos;
  return (
    `  ${name.padEnd(15)} 比 ${String(s.particles).padStart(4)} 个${s.skipped ? `（不比 ${s.skipped}）` : ""}` +
    ` 坐标 ${s.coord.toFixed(0).padStart(5)} pos ${e2(p.diff)}（包络 ${e2(p.envelope)}，差/限 ${p.ratio.toFixed(3)}）；` +
    FIELDS.filter((f) => f !== "pos")
      .map((f) => `${f} ${s.fields[f].diff.toExponential(1)}`)
      .join(" ") +
    `；逐帧 WPE/我们 ${s.counts.join(" ")}` +
    `${s.countMismatch.length ? ` 粒子数不同 ${s.countMismatch.join(",")}` : ""} ${ok ? "ok" : "超限"}${judged ? "" : "（只报告）"}`
  );
}

// ==================== 输入精度包络（b4） ====================

/** 可复现的 [−1, 1) 均匀数（b4 的 `uniform`）。 */
function uniform(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 2 ** 32) * 2 - 1;
  };
}

/** 按来源扰动：日志帧 dt、T 各加 ±5e-7；拆分帧 dt 反号各加 ±1e-5（和不变），T 跟着累加（b4 的 `perturb`）。 */
export function perturb(dts: number[], times: number[], sources: Section["sources"], seed: number) {
  const u = uniform(seed);
  const d = [...dts];
  const t = [...times];
  const e = u() * SPLIT_EPS;
  let k = 0;
  for (let i = 0; i < d.length; i++) {
    if (sources[i] === "log") {
      d[i] += u() * LOG_EPS;
      t[i] += u() * LOG_EPS;
    } else if (sources[i] === "split") {
      d[i] += k++ === 0 ? e : -e;
      t[i] = t[i - 1] + d[i];
    }
  }
  return { dts: d, times: t };
}

// ==================== 案例上下文 ====================

export class CaseContext {
  readonly report: CaseReport;
  readonly lines: string[] = [];
  /** 段的开头（准备阶段）写的行先攒着，等段标题打出来再放（钩子的 timeline 在准备阶段跑）。 */
  private deferred: string[] | null = null;
  private readonly bundles = new Map<string, any>();
  private readonly modules = new Map<string, any>();
  private translator: any;
  /**
   * 库里的纯函数，给钩子用。钩子不要自己 import replayLib：每个案例前 vi.resetModules，再 import 会得到另一份模块实例（偏置开关不是同一个）。
   */
  readonly lib = { compareParticles, statsOk, statsRow, perturb, readTrack, FIELDS, DEFAULT_LIMITS, EPS, bias };

  constructor(
    readonly src: string,
    readonly data: string,
    readonly spec: ReplayCase,
    readonly hook: CaseHook,
  ) {
    this.report = { case: spec.name, description: spec.description, ok: true, sections: [], checks: [], notes: [] };
  }

  /** 产品模块（相对 src，如 `particles/system`）。经 vi.doMock 的 f32 偏置开关生效。 */
  async mod(rel: string): Promise<any> {
    if (!this.modules.has(rel)) this.modules.set(rel, await import(/* @vite-ignore */ `${this.src}/${rel}`));
    return this.modules.get(rel);
  }

  async compile(project: string, postprocess: "disabled" | "enabled" | "ultra" = "disabled"): Promise<any> {
    const key = postprocess === "disabled" ? project : `${project}|${postprocess}`;
    if (!this.bundles.has(key)) {
      const { compileScene } = await this.mod("compile/bundle");
      if (!this.translator) {
        const { Wpesl2wgsl } = await this.mod("wpesl2wgsl/index");
        const wasm = `${this.src}/wpesl2wgsl/wpesl2wgsl.wasm`;
        if (!existsSync(wasm)) throw new KbpReplayError("src", `源码里没有翻译器 wasm：${wasm}`);
        this.translator = await Wpesl2wgsl.fromBytes(readFileSync(wasm));
      }
      const projectDir = path.join(this.data, "proj", project);
      if (!existsSync(projectDir)) throw new KbpReplayError("data", `找不到工程 ${projectDir}`);
      this.bundles.set(
        key,
        await compileScene({
          projectDir,
          sceneAssets: [`${wpeRoot()}/assets`],
          reader: nodeReader,
          translator: this.translator,
          postprocess,
          exhaustive: true,
        }),
      );
    }
    return this.bundles.get(key);
  }

  // ---------- 报告 ----------

  line(text: string): void {
    (this.deferred ?? this.lines).push(text);
  }

  /** 取走准备阶段攒下的行（之后 line() 直接写）。 */
  takeDeferred(): string[] {
    const pending = this.deferred ?? [];
    this.deferred = null;
    return pending;
  }

  /** 核对一项；judged 为 false 时只报告。sec 为 null 时记在案例层。 */
  check(sec: Section | null, name: string, ok: boolean, detail?: string, judged = true): void {
    (sec ? sec.report.checks : this.report.checks).push({
      name,
      ok,
      judged,
      ...(detail !== undefined ? { detail } : {}),
    });
    if (judged && !ok) this.report.ok = false;
    this.line(`  ${ok ? "✓" : judged ? "✗" : "·"} ${name}${detail !== undefined ? `：${detail}` : ""}`);
  }

  note(sec: Section | null, text: string): void {
    (sec ? sec.report.notes : this.report.notes).push(text);
    this.line(`  注：${text}`);
  }

  addSystem(sec: Section, name: string, result: SystemResult, row?: string): void {
    sec.report.systems[name] = result;
    if (result.judged && !result.ok) this.report.ok = false;
    if (row !== undefined) this.line(row);
    if (!result.ok && (result.stats as any).worst)
      this.line(`    最差：${JSON.stringify((result.stats as any).worst)}`);
  }

  /** 位置模式的一个系统：比较并记进报告。 */
  addParticles(sec: Section, name: string, ref: Reference, options: CompareOptions = {}, judged?: boolean): Stats {
    const stats = compareParticles(sec.truth, name, ref, sec.limits, {
      history: sec.run.compare?.history,
      ...options,
    });
    const requireParticles = options.requireParticles ?? sec.run.compare?.requireParticles ?? true;
    const ok = statsOk(stats, requireParticles);
    const isJudged = judged ?? !(sec.run.systems?.informational ?? []).includes(name);
    this.addSystem(
      sec,
      name,
      { mode: "position", ok, judged: isJudged, stats: stats as any },
      statsRow(name, stats, ok, isJudged),
    );
    return stats;
  }

  /** 工程 kbp-meta.json 的 children（P4e 起，`ignore/p4/defs/p4e0.py` 写）：系统名 → 条目顺序的子系统名；没有时为空表。 */
  metaChildren(project: string): Record<string, string[]> {
    const file = path.join(this.data, "proj", project, "kbp-meta.json");
    if (!existsSync(file)) return {};
    return JSON.parse(readFileSync(file, "utf8")).children ?? {};
  }

  // ---------- 段 ----------

  async prepareSection(run: RunSpec, tag: string, index: number): Promise<Section> {
    const trackFile = path.join(this.data, "tracks", `rd-${tag}.json`);
    const logFile = path.join(this.data, "out", `${tag}-log.txt`);
    const truth = readTrack(trackFile);
    const project = run.project ?? truth.project ?? /^(.+?)-fps\d+/.exec(tag)?.[1];
    if (!project) throw new KbpReplayError("data", `${tag}：推不出工程，案例里给 project`);
    const bundle = await this.compile(project, run.postprocess ?? "disabled");
    const frames = truth.frames.map((f) => f.frame);
    const first = Math.min(...frames);
    const firstPointer = truth.frames.find((f) => f.frame === first)?.pointer;
    const cursorsMode = run.inputs?.cursors ?? "none";
    const scene: Point = [bundle.general?.width ?? 1920, bundle.general?.height ?? 1080];
    const m = /-(\d+)x(\d+)$/.exec(tag);
    const window: Point = m ? [Number(m[1]), Number(m[2])] : scene;
    const timeline = buildTimeline({
      log: logFile,
      track: trackFile,
      gap: run.gap ?? "error",
      ...(cursorsMode === "track"
        ? { cursors: "track" as const, ...(firstPointer ? { cursor: firstPointer } : {}) }
        : {}),
      // log：窗口尺寸取这里的 window（标签没带 -宽x高 时当作和场景同尺寸，同 track），时间线不再自己推
      ...(cursorsMode === "log" ? { cursors: "log" as const, window } : {}),
    });
    const fromTag = timeline.passes?.passes;
    const passes = run.passes ?? fromTag;
    if (!passes) throw new KbpReplayError("data", `${tag}：标签里没有 fps，案例里给 passes`);
    const mode = run.mode ?? "position";
    const captured = new Set(timeline.captured);
    const split = new Set(timeline.split);
    const sources = timeline.dts.map((_, i) =>
      captured.has(i + 1) ? "shot" : split.has(i + 1) ? "split" : "log",
    ) as Section["sources"];
    const label = run.label ? `${run.label} ${tag}` : tag;
    const sec: Section = {
      index,
      run,
      label,
      project,
      tag,
      passes,
      fps: run.fps ?? fpsOf(tag),
      mode,
      bundle,
      layers: bundle.layers,
      truth,
      frames,
      timeline,
      dts: [...timeline.dts],
      times: [...timeline.times],
      sources,
      scene,
      window,
      limits: { ...DEFAULT_LIMITS, ...(run.limits ?? {}) },
      report: {
        label,
        project,
        tag,
        passes,
        mode,
        frames,
        unsupported: [...(bundle.unsupported ?? [])],
        systems: {},
        checks: [],
        notes: [],
        extra: {},
      },
      state: {},
    };
    this.deferred = [];
    if (timeline.gaps.length)
      this.note(
        sec,
        `日志与轨迹都缺第 ${timeline.gaps.map((g) => `${g.from}–${g.to}`).join("、")} 帧，按 gap: split 平分（每帧 ${timeline.gaps.map((g) => g.dt).join("、")}）`,
      );
    if (this.hook.timeline) await this.hook.timeline(this, sec);
    if (cursorsMode === "log") {
      const check = timeline.cursorCheck;
      this.note(
        sec,
        `跟随点取日志的逐帧光标（窗口 ${window[0]}×${window[1]}）` +
          (timeline.cursorsFilled.length
            ? `，日志缺光标、沿用相邻帧的第 ${timeline.cursorsFilled.join("、")} 帧`
            : "") +
          (check?.frames.length
            ? `；抓到的帧上和轨迹 pointer 核对 ${check.frames.length} 帧，最大差 ${check.maxDiff}` +
              (check.mismatched.length ? `，第 ${check.mismatched.join("、")} 帧不同` : "")
            : ""),
      );
    }
    // 控制点输入：track 与 log 的光标都是 g_PointerPosition（窗口归一化），同一段换到场景上
    if (cursorsMode === "track" || cursorsMode === "log") {
      const { scenePlacement, sceneCursor, sceneViewProjection } = await this.mod("render/layout");
      const { pointerScenePoint } = await this.mod("particles/controlpoints");
      const same = window[0] === scene[0] && window[1] === scene[1];
      const placement = same ? null : scenePlacement("fill", scene[0], scene[1], window[0], window[1]);
      sec.cursors = (timeline.cursors ?? []).map(([x, y]) =>
        same ? ([x, y] as Point) : (sceneCursor("fill", placement, window[0], window[1], x, y) as Point),
      );
      const viewProjection = sceneViewProjection({ width: scene[0], height: scene[1] });
      sec.follows = sec.cursors.map((c) => pointerScenePoint(viewProjection, c) as Point);
    } else if (cursorsMode === "zero") {
      sec.follows = sec.dts.map(() => [0, 0] as Point);
    }
    const worldMode = run.inputs?.world ?? "none";
    if (worldMode === "static") {
      const { worldMatrixOf } = await this.mod("render/layout");
      const transforms = new Map(bundle.layers.map((layer: any) => [layer.object, layer]));
      const cache = new Map<number, unknown>();
      sec.world = (layer: any) => {
        if (!cache.has(layer.object)) cache.set(layer.object, worldMatrixOf(layer.object, transforms, new Map()));
        return cache.get(layer.object);
      };
    } else if (worldMode === "hook") {
      if (!this.hook.world) throw new KbpReplayError("data", `${this.spec.name}：inputs.world 是 hook，钩子没有 world`);
      sec.world = await this.hook.world(this, sec);
    }
    return sec;
  }

  /**
   * 同一段的输入再比一轮（b3 的 fps10：先按平分比、再按反推的拆分比）：报告里另起一段，标签 label，其余输入照旧（钩子可以再改 dts 等）。
   */
  fork(sec: Section, label: string): Section {
    const report: SectionReport = { ...sec.report, label, systems: {}, checks: [], notes: [], extra: {} };
    this.report.sections.push(report);
    this.line("");
    this.line(`== ${label}`);
    return { ...sec, label, dts: [...sec.dts], times: [...sec.times], report, state: {} };
  }

  /** 编译的不支持项核对。 */
  checkUnsupported(sec: Section): void {
    const rule = sec.run.unsupported ?? {};
    const got = [...sec.report.unsupported].sort();
    if (rule.report) {
      this.check(sec, `${sec.project} 编译不支持项`, true, JSON.stringify(got), false);
    } else if (rule.allow) {
      const re = new RegExp(rule.allow);
      const bad = got.filter((key) => !re.test(key));
      this.check(sec, `${sec.project} 编译不支持项只许 /${rule.allow}/`, !bad.length, JSON.stringify(got));
    } else {
      const want = [...(rule.expect ?? [])].sort();
      this.check(
        sec,
        `${sec.project} 编译不支持项应为 ${JSON.stringify(want)}`,
        JSON.stringify(got) === JSON.stringify(want),
        JSON.stringify(got),
      );
    }
  }

  /** 段的模拟缺省选项。 */
  simDefaults(sec: Section): SimOptions {
    const controls = (sec.run.inputs?.world ?? "none") !== "none" || (sec.run.inputs?.cursors ?? "none") !== "none";
    return {
      dts: sec.dts,
      times: sec.times,
      timeMode: sec.run.inputs?.time ?? "none",
      frames: sec.frames,
      passes: sec.passes,
      controls,
      world: sec.world,
      follows: sec.follows,
      audio: audioTimeline(sec),
    };
  }

  /**
   * 照 particleTrack：第 i 个粒子层种子 1 + i、加载时预热，再按 dts 步进；输出带出生序号、出生帧、年龄（按槽序，同 RenderDoc 轨迹）。
   * 出生以来的最大坐标按原脚本记（键 `<系统>:<出生序号>`，预热出生的粒子按 run.compare.historyUnborn）。
   */
  async simulate(sec: Section, overrides: Partial<SimOptions> = {}): Promise<SimResult> {
    const o: SimOptions = { ...this.simDefaults(sec), ...overrides };
    const { ParticleSystem } = await this.mod("particles/system");
    const { SeededRandom, injectedR } = await this.mod("particles/random");
    const { particleSnapshot } = await this.mod("particles/track");
    const pool = sec.run.compare?.historyUnborn === "pool";
    const wanted = new Set(o.frames);
    const last = Math.max(...o.frames);
    const timeArg = (f: number) =>
      o.timeMode === "cur" ? o.times[f - 1] : o.timeMode === "prev" ? (f > 1 ? o.times[f - 2] : 0) : undefined;
    const inputs = (layer: any, f: number) =>
      o.controls ? { world: o.world?.(layer, f), pointer: o.follows?.[Math.max(0, f - 1)] ?? [0, 0] } : undefined;
    const entries: { name: string; layer: any; system: any; births: Map<number, [number, number]>; count: number }[] =
      [];
    // 子系统（P4e 起）：由根系统的 step 带着走，回放只步进根；每帧沿 forEachDrawn（系统、模板路径、模型矩阵）现列子孙。
    // 名字：模板路径（每层 def.children 下标）经 children[i].index 换成 JSON 条目下标，再按 kbp-meta.json 的 children 换成系统名
    // （基础名）；同一基础名按先序出现先后记 名字、名字#2…，只数有存活粒子的（WPE 存活数为 0 的系统不画，提取器看不到），根自己占第 1 个
    // （自引用）；一个都没有时记一个空的基础名。出生序号按基础名全局编号（事件实例会换 #n），历史坐标先记在「基础名:序号」下，出记录时
    // 抄到当帧的名字下。
    const metaChildren = this.metaChildren(sec.project);
    const childState = new Map<unknown, Map<number, [number, number]>>();
    const childCount = new Map<string, number>();
    const childName = (layer: any, template: readonly number[]): string => {
      let name: string | undefined = layer.name;
      let def = layer.particle;
      for (const index of template) {
        const link = def?.children?.[index];
        name = name === undefined ? undefined : metaChildren[name]?.[link?.index ?? index];
        def = link?.system;
      }
      if (name === undefined)
        throw new KbpReplayError(
          "data",
          `${sec.project}：kbp-meta.json 的 children 里找不到 ${layer.name} 的子系统 ${template}`,
        );
      return name;
    };
    /** 一个根下面本帧被画的子孙（先序）：[基础名, 系统]。 */
    const descendants = (entry: (typeof entries)[number]): [string, any][] => {
      const list: [string, any][] = [];
      // 步骤 1 的旧签名 forEachDrawn(callback(系统, 路径)) 第二个参数同样是路径，两版都能用；P4e 之前的源码没有它
      if (typeof entry.system.forEachDrawn !== "function") return list;
      entry.system.forEachDrawn((system: any, template: readonly number[]) => {
        if (template.length) list.push([childName(entry.layer, template), system]);
      });
      return list;
    };
    // 频谱（P4e 步骤 4）：全场景一份，各根系统共用（子系统与实例由 setAudio 递归带上）；预热时是 0（同 WPE 加载期）
    const audioMod = o.audio ? await this.mod("particles/audio") : null;
    const sharedAudio = audioMod ? audioMod.silentParticleAudio() : null;
    for (const layer of o.layers ?? sec.layers) {
      if (!layer.particle) continue;
      let random: RandomLike = new SeededRandom(1 + entries.length);
      if (o.random?.[layer.name]) random = o.random[layer.name](random);
      const injected = o.r?.[layer.name];
      const system = new ParticleSystem(layer.particle, random, o.passes, injected ? injectedR(injected) : undefined);
      o.patch?.(system, layer);
      if (sharedAudio) {
        if (typeof system.setAudio !== "function")
          throw new KbpReplayError(
            "src",
            `${sec.project}：轨迹带频谱，但这份源码的 ParticleSystem 没有 setAudio（P4e 步骤 4 之前）`,
          );
        system.setAudio(sharedAudio);
      }
      system.prewarm(inputs(layer, 0) as never);
      entries.push({ name: layer.name, layer, system, births: new Map(), count: 0 });
    }
    const out: SimFrames = new Map();
    const history = new Map<string, number>();
    const remember = (key: string, c: any, slot: number) => {
      const coord = Math.max(
        Math.abs(c.position[0][slot]),
        Math.abs(c.position[1][slot]),
        Math.abs(c.position[2][slot]),
      );
      if (coord > (history.get(key) ?? 0)) history.set(key, coord);
    };
    const snapshot = (system: any, births: Map<number, [number, number]>): SimParticle[] => {
      const c = system.columns;
      const alive: number[] = [];
      for (let slot = 0; slot < system.highWater; slot++) if (c.life[slot] !== 0) alive.push(slot);
      return particleSnapshot(system).map((p: Particle, i: number) => {
        const slot = alive[i];
        const row: SimParticle = {
          ...p,
          birth: births.get(slot)?.[0] ?? -1,
          born: births.get(slot)?.[1] ?? -1,
          age: c.age[slot],
          life: c.life[slot],
        };
        if (o.vel) row.vel = [0, 1, 2].map((k) => c.velocity[k][slot]);
        return row;
      });
    };
    for (let frame = 1; frame <= last; frame++) {
      // 这一帧的频谱：WPE 在帧函数之前算好，粒子一帧里读同一份（rea-p4e-audio 3.5）；没有值的帧沿用前一帧
      const spectrum = o.audio?.[frame - 1];
      if (spectrum && sharedAudio) audioMod.writeParticleAudio(sharedAudio, spectrum);
      for (const entry of entries) {
        const before = entry.system.alive;
        const stepInputs = inputs(entry.layer, frame);
        entry.system.step(o.dts[frame - 1], timeArg(frame), stepInputs as never);
        const c = entry.system.columns;
        for (let slot = 0; slot < entry.system.highWater; slot++) {
          if (c.life[slot] === 0) continue;
          if (c.age[slot] === 0) entry.births.set(slot, [entry.count++, frame]);
          const birth = entry.births.get(slot)?.[0];
          remember(`${entry.name}:${pool ? (birth ?? -1) : birth}`, c, slot);
        }
        o.observe?.(entry.name, entry.system, frame, before, entry.births, stepInputs);
        for (const [base, system] of descendants(entry)) {
          let births = childState.get(system);
          if (!births) childState.set(system, (births = new Map()));
          const cc = system.columns;
          for (let slot = 0; slot < system.highWater; slot++) {
            if (cc.life[slot] === 0) continue;
            if (cc.age[slot] === 0) {
              const n = childCount.get(base) ?? 0;
              births.set(slot, [n, frame]);
              childCount.set(base, n + 1);
            }
            const birth = births.get(slot)?.[0];
            remember(`${base}:${pool ? (birth ?? -1) : birth}`, cc, slot);
          }
        }
      }
      if (!wanted.has(frame)) continue;
      const record: Record<string, SimParticle[]> = {};
      for (const entry of entries) {
        record[entry.name] = snapshot(entry.system, entry.births);
        const seen = new Map<string, number>([[entry.name, 1]]);
        const empty = new Set<string>();
        for (const [base, system] of descendants(entry)) {
          if (system.alive === 0) {
            empty.add(base);
            continue;
          }
          const k = (seen.get(base) ?? 0) + 1;
          seen.set(base, k);
          const name = k === 1 ? base : `${base}#${k}`;
          const rows = snapshot(system, childState.get(system) ?? new Map());
          record[name] = rows;
          for (const row of rows) {
            const value = history.get(`${base}:${row.birth}`);
            if (value !== undefined && name !== base) history.set(`${name}:${row.birth}`, value);
          }
        }
        for (const base of empty) if (!(base in record)) record[base] = [];
      }
      out.set(frame, record);
    }
    return {
      out,
      history,
      births: {
        ...Object.fromEntries(entries.map(({ name, count }) => [name, count])),
        ...Object.fromEntries(childCount),
      },
    };
  }

  /** 精确一遍，再按 rcp / rsqrt 的四种偏置组合各跑一遍（近似运算包络）。 */
  async withApprox<T>(run: () => Promise<T>): Promise<{ exact: T; envelopes: T[] }> {
    if (!needsApprox(this.spec))
      throw new KbpReplayError("data", `${this.spec.name}：要近似运算包络的 run 得在案例里写 envelope.approx`);
    const exact = await run();
    const envelopes: T[] = [];
    try {
      for (const rcpSign of [1, -1])
        for (const rsqrtSign of [1, -1]) {
          bias.rcp = rcpSign * EPS;
          bias.rsqrt = rsqrtSign * EPS;
          envelopes.push(await run());
        }
    } finally {
      bias.rcp = 0;
      bias.rsqrt = 0;
    }
    return { exact, envelopes };
  }

  /** 输入精度包络：按来源扰动 dt、T 跑 n 遍（种子 7919·k，同 b4）。 */
  async withInput(sec: Section, n: number, overrides: Partial<SimOptions> = {}): Promise<SimFrames[]> {
    const envelopes: SimFrames[] = [];
    for (let seed = 1; seed <= n; seed++) {
      const p = perturb(overrides.dts ?? sec.dts, overrides.times ?? sec.times, sec.sources, seed * 7919);
      envelopes.push((await this.simulate(sec, { ...overrides, dts: p.dts, times: p.times })).out);
    }
    return envelopes;
  }

  /** 段的参照：精确模拟加包络（按 run.envelope）。 */
  async reference(sec: Section, overrides: Partial<SimOptions> = {}): Promise<Reference> {
    const env = sec.run.envelope ?? {};
    if (env.approx) {
      const { exact, envelopes } = await this.withApprox(() => this.simulate(sec, overrides));
      return { exact: exact.out, envelopes: envelopes.map((e) => e.out), history: exact.history, births: exact.births };
    }
    const exact = await this.simulate(sec, overrides);
    const envelopes = env.input ? await this.withInput(sec, env.input, overrides) : [];
    return { exact: exact.out, envelopes, history: exact.history, births: exact.births };
  }

  /** 偏置开关确实生效（mock 换掉了产品代码的 rcp / rsqrt）。 */
  async checkBias(): Promise<void> {
    const { rsqrt, rcp } = await this.mod("particles/f32");
    bias.rsqrt = 0.5;
    bias.rcp = 0.5;
    const changed = rsqrt(4) === Math.fround(0.75) && rcp(4) === Math.fround(0.375);
    bias.rsqrt = 0;
    bias.rcp = 0;
    this.check(null, "偏置开关生效", changed);
  }

  /**
   * 产品的 particleTrack（cursors + size，按段的遍数）和手写循环（精确那一遍）逐位相同（c2–c4 的核对）。names 给了时只看这些系统；
   * strict 时我们有粒子而 particleTrack 没有这个系统也算不同（c3）；skipped 时另核对 particleTrack 没有跳过的模块（c3、c4）。
   */
  async checkParticleTrack(
    sec: Section,
    exact: SimFrames,
    opts: { names?: string[]; strict?: boolean; skipped?: boolean } = {},
  ): Promise<void> {
    const { particleTrack } = await this.mod("particles/track");
    const track = particleTrack({
      layers: sec.layers,
      dts: sec.dts,
      frames: sec.frames,
      passes: sec.passes,
      cursors: sec.cursors,
      size: sec.scene,
    });
    const strip = (p: SimParticle | undefined) =>
      JSON.stringify({ ...p, birth: undefined, born: undefined, age: undefined, life: undefined, vel: undefined });
    let mismatch = 0;
    let checked = 0;
    for (const frame of track.frames) {
      const ours = exact.get(frame.frame)!;
      const names = opts.names ?? Object.keys(frame.systems);
      for (const name of names) {
        const theirs: Particle[] = frame.systems[name] ?? [];
        const mine = ours[name] ?? [];
        if (mine.length !== theirs.length) mismatch++;
        theirs.forEach((p, i) => {
          checked++;
          if (JSON.stringify(p) !== strip(mine[i])) mismatch++;
        });
      }
      if (opts.strict)
        for (const name of Object.keys(ours)) if ((ours[name]?.length ?? 0) > 0 && !frame.systems[name]) mismatch++;
    }
    this.check(
      sec,
      `particleTrack（cursors + size，${sec.passes} 遍）和手写循环逐位相同${opts.names ? `（${opts.names.length} 个系统）` : ""}`,
      !!checked && !mismatch,
      `${checked} 个粒子，${mismatch ? `${mismatch} 处不同` : "逐位相同"}`,
    );
    if (opts.skipped)
      this.check(
        sec,
        "particleTrack 没有跳过的模块",
        !Object.keys(track.skipped).length,
        JSON.stringify(track.skipped),
      );
  }

  /** 要比的系统：only；否则轨迹里的系统（第一帧或全部帧的并集）去掉 skip / skipPattern。 */
  systemsOf(sec: Section): string[] {
    const s = sec.run.systems ?? {};
    if (s.only?.length) return [...s.only];
    const names =
      s.source === "first"
        ? Object.keys(sec.truth.frames[0]?.systems ?? {})
        : [...new Set(sec.truth.frames.flatMap((f) => Object.keys(f.systems)))];
    const pattern = s.skipPattern ? new RegExp(s.skipPattern) : null;
    return names.filter((name) => !(s.skip ?? []).includes(name) && !(pattern && pattern.test(name)));
  }

  /** 标准流程：按模式跑一段。 */
  async standard(sec: Section): Promise<void> {
    if (sec.mode === "color") return this.colorSection(sec);
    if (sec.mode === "rope") return this.ropeSection(sec);
    const extra = this.hook.prepare ? await this.hook.prepare(this, sec) : {};
    const ref = await this.reference(sec, extra);
    const first = Math.min(...sec.frames);
    const windowOnly = new Set(sec.run.compare?.windowOnly ?? []);
    for (const name of this.systemsOf(sec)) {
      const options: CompareOptions = this.hook.compareOptions?.(this, sec, name, ref) ?? {};
      if (windowOnly.has(name) && !options.skip) options.skip = (p) => p.born < first;
      this.addParticles(sec, name, ref, options);
    }
    const skipped = new Set([...(sec.run.systems?.skip ?? [])]);
    if (skipped.size) this.line(`  不比：${[...skipped].join(" ")}`);
    if (this.hook.after) await this.hook.after(this, sec, ref);
  }

  // ---------- color 模式（b6） ----------

  /**
   * `instanceoverride.colorn` 和 WPE 顶点颜色逐粒子比（b6）。每个系统自动选：没有两端不同的颜色模块 → 直接比；一个 → 按产品同一串 float32
   * 运算的线段拟合 t，残差 ≤ 限值；两个以上 → 不比。运行中改属性走产品的同一条路（planApply → SceneState.write → setInstance）。
   */
  async colorSection(sec: Section): Promise<void> {
    const f32 = Math.fround;
    const { planApply } = await this.mod("compile/bindings");
    const { ParticleSystem } = await this.mod("particles/system");
    const { SeededRandom } = await this.mod("particles/random");
    const { SceneState } = await this.mod("render/state");
    const { lerp, rcp } = await this.mod("particles/f32");
    const LIMIT = sec.limits.color;
    type Vec = number[];
    interface Factor {
      kind: "colorrandom" | "colorchange";
      min: Vec;
      range: Vec;
    }
    const factorsOf = (system: any): { instance: Vec; factors: Factor[] } => {
      const factors: Factor[] = [];
      for (const m of system.initializers)
        if (m.name === "colorrandom") {
          const min = m.fields.min as Vec;
          const max = m.fields.max as Vec;
          factors.push({ kind: "colorrandom", min, range: min.map((v, i) => f32(max[i] - v)) });
        }
      for (const m of system.operators)
        if (m.name === "colorchange") {
          const start = m.fields.startvalue as Vec;
          const end = m.fields.endvalue as Vec;
          factors.push({ kind: "colorchange", min: start, range: start.map((v, i) => f32(end[i] - v)) });
        }
      return { instance: [...system.instanceColor], factors };
    };
    const evaluate = (instance: Vec, factors: Factor[], ts: number[]): Vec => {
      const c = [...instance];
      factors.forEach((factor, k) => {
        for (let i = 0; i < 3; i++) c[i] = f32(c[i] * lerp(factor.min[i], factor.range[i], f32(ts[k])));
      });
      return c;
    };
    const changeT = (
      fields: Record<string, unknown>,
      age: number,
      life: number,
      inverse: (x: number) => number = rcp,
    ) => {
      const start = fields.starttime as number;
      const rcpEnd = inverse(f32((fields.endtime as number) - start));
      const t = f32(f32(f32(age * inverse(life)) - start) * rcpEnd);
      return t < 1 ? (0 > t ? 0 : t) : 1;
    };
    const RCPPS_ONE = 0.999755859375;
    const rcpps = (x: number) => (Number.isInteger(Math.log2(Math.abs(x))) ? f32(RCPPS_ONE / x) : rcp(x));

    const scene = JSON.parse(readFileSync(path.join(this.data, "proj", sec.project, "scene.json"), "utf8"));
    this.line(`  scene.json version ${JSON.stringify(scene.version)}`);
    const changesRel = sec.run.inputs?.changes?.replace("{tag}", sec.tag);
    const changesPath = changesRel ? path.join(this.data, changesRel) : null;
    const changes: { frame: number; properties: Record<string, unknown> }[] =
      changesPath && existsSync(changesPath) ? JSON.parse(readFileSync(changesPath, "utf8")) : [];
    if (changes.length) this.note(sec, `运行中改属性：${JSON.stringify(changes)}`);

    const bundle = sec.bundle;
    const state = SceneState.fromBundle(bundle);
    const systems: { name: string; object: number; system: any }[] = [];
    for (const layer of bundle.layers) {
      if (!layer.particle) continue;
      const system = new ParticleSystem(layer.particle, new SeededRandom(1 + systems.length), sec.passes);
      system.prewarm();
      systems.push({ name: layer.name, object: layer.object, system });
    }
    const wanted = new Set(sec.frames);
    const last = Math.max(...sec.frames);
    const timeMode = sec.run.inputs?.time ?? "cur";
    const snapshots = new Map<number, Record<string, any>>();
    for (let frame = 1; frame <= last; frame++) {
      for (const change of changes.filter((c) => c.frame === frame)) {
        const plan = planApply(bundle.bindings, new Map(Object.entries(change.properties)));
        if (plan.recompile.length)
          this.note(sec, `第 ${frame} 帧改属性要重编译：${JSON.stringify(plan.recompile)}（回放不处理）`);
        for (const { binding, value } of plan.writes) state.write(binding, value);
        for (const object of state.takeDirty().particles) {
          const values = state.particleInstances.get(object);
          for (const entry of systems) if (entry.object === object && values) entry.system.setInstance(values);
        }
      }
      const time =
        timeMode === "cur"
          ? sec.times[frame - 1]
          : timeMode === "prev"
            ? frame > 1
              ? sec.times[frame - 2]
              : 0
            : undefined;
      for (const { system } of systems) system.step(sec.dts[frame - 1], time);
      if (!wanted.has(frame)) continue;
      const record: Record<string, any> = {};
      for (const { name, system } of systems) {
        const c = system.columns;
        const particles: { color: Vec; age: number; life: number }[] = [];
        for (let slot = 0; slot < system.highWater; slot++)
          if (c.life[slot] !== 0)
            particles.push({
              color: [c.color[0][slot], c.color[1][slot], c.color[2][slot]],
              age: c.age[slot],
              life: c.life[slot],
            });
        const { instance, factors } = factorsOf(system);
        const change = system.operators.find((m: any) => m.name === "colorchange");
        record[name] = { particles, instance, factors, fields: change ? { ...change.fields } : null };
      }
      snapshots.set(frame, record);
    }

    for (const { name, object } of systems) {
      const layer = bundle.layers.find((l: any) => l.object === object);
      const first = snapshots.get(sec.truth.frames[0].frame)![name];
      const varying = first.factors.filter((f: Factor) => f.range.some((r) => r !== 0));
      const stats: any = {
        name,
        mode: varying.length === 0 ? "direct" : varying.length === 1 ? "fit" : "skip",
        colorn: state.particleInstances.get(object)?.colorn ?? layer.particle.instance.colorn,
        colorSystem: layer.particle.colorSystem,
        instanceColor: first.instance,
        factors: first.factors.map((f: Factor) => ({
          kind: f.kind,
          min: f.min,
          max: f.min.map((v, i) => f32(v + f.range[i])),
        })),
        frames: 0,
        particles: 0,
        countMismatch: [],
        maxDiff: 0,
        ok: true,
      };
      let tMin = Infinity;
      let tMax = -Infinity;
      let dAbs = 0;
      let dRel = 0;
      let dRcpps = 0;
      for (const frame of sec.truth.frames) {
        const wpe = frame.systems[name] ?? [];
        const ours = snapshots.get(frame.frame)![name];
        if (wpe.length !== ours.particles.length) {
          stats.countMismatch.push(`${frame.frame}:${wpe.length}/${ours.particles.length}`);
          if (stats.mode === "direct") continue;
        }
        stats.frames++;
        if (stats.mode === "skip") continue;
        const index =
          stats.mode === "fit"
            ? ours.factors.indexOf(ours.factors.find((f: Factor) => f.range.some((r) => r !== 0))!)
            : -1;
        for (let p = 0; p < wpe.length; p++) {
          stats.particles++;
          const w = wpe[p].color as Vec;
          if (stats.mode === "direct") {
            const o = ours.particles[p].color;
            w.forEach((value, i) => {
              const diff = Math.abs(value - o[i]);
              if (diff > stats.maxDiff) {
                stats.maxDiff = diff;
                stats.worst = { frame: frame.frame, particle: p, channel: i, wpe: value, ours: o[i] };
              }
            });
            continue;
          }
          // 线段拟合：color_i = P_i·(m_i + t·r_i)，P 是其余因子在 t = 0 处的乘积（它们的两端相同）
          const ts = ours.factors.map(() => 0);
          const base = evaluate(
            ours.instance,
            ours.factors.filter((_: Factor, k: number) => k !== index),
            ts.slice(1),
          );
          const f = ours.factors[index];
          let num = 0;
          let den = 0;
          for (let i = 0; i < 3; i++) {
            const slope = base[i] * f.range[i];
            if (Math.abs(slope) < 1e-9) continue;
            num += (w[i] - base[i] * f.min[i]) * slope;
            den += slope * slope;
          }
          const t = den > 0 ? num / den : 0;
          tMin = Math.min(tMin, t);
          tMax = Math.max(tMax, t);
          const tsFit = ours.factors.map((_: Factor, k: number) => (k === index ? t : 0));
          const model = evaluate(ours.instance, ours.factors, tsFit);
          w.forEach((value, i) => {
            const diff = Math.abs(value - model[i]);
            if (diff > stats.maxDiff) {
              stats.maxDiff = diff;
              stats.worst = { frame: frame.frame, particle: p, channel: i, wpe: value, model: model[i], t };
            }
          });
          if (f.kind === "colorchange" && ours.fields && p < ours.particles.length) {
            const mine = changeT(ours.fields, ours.particles[p].age, ours.particles[p].life);
            dAbs = Math.max(dAbs, Math.abs(t - mine));
            if (mine > 0) dRel = Math.max(dRel, Math.abs(t - mine) / mine);
            dRcpps = Math.max(
              dRcpps,
              Math.abs(t - changeT(ours.fields, ours.particles[p].age, ours.particles[p].life, rcpps)),
            );
          }
        }
      }
      if (stats.mode === "fit") {
        stats.tRange = [tMin, tMax];
        if (first.factors[varying.length ? first.factors.indexOf(varying[0]) : 0]?.kind === "colorchange")
          stats.tDelta = { abs: dAbs, rel: dRel, rcpps: dRcpps };
        if (!(tMin >= -1e-6 && tMax <= 1 + 1e-6)) {
          stats.ok = false;
          stats.note = "WPE 的 t 落在 [0, 1] 之外";
        }
      }
      if (stats.mode === "skip") stats.note = "两个以上颜色模块的两端不同，不比";
      if (stats.mode === "direct" && stats.countMismatch.length) stats.ok = false;
      if (!(stats.maxDiff <= LIMIT)) stats.ok = false;
      if (!stats.particles && stats.mode !== "skip") stats.ok = false;
      const fmt = (v: Vec) => `(${v.map((x) => Number(x.toFixed(6))).join(", ")})`;
      const row =
        `  ${name.padEnd(13)} ${stats.mode.padEnd(6)} 粒子 ${String(stats.particles).padStart(3)} 最大差 ${e2(stats.maxDiff)}` +
        ` I ${fmt(stats.instanceColor)} 因子 ${stats.factors.map((f: any) => `${f.kind} ${fmt(f.min)}→${fmt(f.max)}`).join("；") || "无"}` +
        (stats.tRange ? ` t∈[${stats.tRange[0].toFixed(4)}, ${stats.tRange[1].toFixed(4)}]` : "") +
        (stats.tDelta
          ? ` t 差 ${e2(stats.tDelta.abs)}（相对 ${e2(stats.tDelta.rel)}；倒数换成 rcpps 后 ${e2(stats.tDelta.rcpps)}）`
          : "") +
        (stats.countMismatch.length ? ` 粒子数不同 ${stats.countMismatch.join(",")}` : "") +
        ` ${stats.ok ? "ok" : "失败"}${stats.note ? `（${stats.note}）` : ""}`;
      const judged = !(sec.run.systems?.informational ?? []).includes(name);
      this.addSystem(sec, name, { mode: "color", ok: stats.ok, judged, stats }, row);
    }
    for (const name of new Set(sec.truth.frames.flatMap((f) => Object.keys(f.systems))))
      if (!systems.some((s) => s.name === name)) this.check(sec, `WPE 有系统 ${name}，我们没有`, false);
    if (this.hook.after)
      await this.hook.after(this, sec, { exact: new Map(), envelopes: [], history: new Map(), births: {} });
  }

  // ---------- rope 模式（d1） ----------

  /**
   * 绳的段顶点（d1）：每个抓到的帧用产品的 writeRopeSegments 写段顶点，和轨迹（draws 认法）的 vs_in 逐段比。限值：位置（段的四个点）
   * 1e-3，坐标过 1000 取 2e-3；尺寸 1e-3；颜色 / alpha 2e-3；各加近似运算包络；TL、TP ≤ 1e-4（不加包络）。段数必须相同；WPE 没有这次
   * 绘制时我们的段数必须是 0。
   */
  async ropeSection(sec: Section): Promise<void> {
    const { ParticleSystem } = await this.mod("particles/system");
    const { SeededRandom } = await this.mod("particles/random");
    const { ropeVertexLayout, writeRopeSegments } = await this.mod("particles/rope");
    const { programVertexPacking } = await this.mod("render/programs");
    const COLUMNS = ["POSITION", "TEXCOORD0", "TEXCOORD1", "TEXCOORD2", "TEXCOORD3", "COLOR"] as const;
    const L = sec.limits;
    const fps = sec.fps;
    if (!fps) throw new KbpReplayError("data", `${sec.tag}：绳要 fps（标签里没有，案例里给 fps）`);
    const bundle = sec.bundle;
    const layers = bundle.layers.filter((layer: any) => layer.particle);
    const layouts = new Map<string, any>();
    for (const layer of layers) {
      const program = bundle.programs[layer.particle.passes[0].program];
      if (!program.geometry) throw new KbpReplayError("src", `${layer.name}：程序没有 geometry`);
      const { layout, problems } = ropeVertexLayout(programVertexPacking(program));
      if (problems.length) throw new KbpReplayError("src", `${layer.name}：${problems.join(",")}`);
      layouts.set(layer.name, layout);
    }
    this.line(
      `  粒子层 ${layers.length} 个：${layers.map((l: any) => l.name).join(" ")}；段步长 ${layouts.get(layers[0].name).stride} 个 float`,
    );
    const o = this.simDefaults(sec);
    const timeArg = (f: number) =>
      o.timeMode === "cur" ? sec.times[f - 1] : o.timeMode === "prev" ? (f > 1 ? sec.times[f - 2] : 0) : undefined;
    const replay = async () => {
      const wanted = new Set(sec.frames);
      const last = Math.max(...sec.frames);
      const systems = layers.map((layer: any, i: number) => {
        const system = new ParticleSystem(layer.particle, new SeededRandom(1 + i), sec.passes);
        system.prewarm(
          o.controls ? ({ world: sec.world?.(layer, 0), pointer: sec.follows?.[0] ?? [0, 0] } as never) : undefined,
        );
        return { layer, system };
      });
      const out = new Map<number, Record<string, number[][][]>>();
      for (let frame = 1; frame <= last; frame++) {
        for (const { layer, system } of systems)
          system.step(
            sec.dts[frame - 1],
            timeArg(frame),
            o.controls
              ? ({ world: sec.world?.(layer, frame), pointer: sec.follows?.[frame - 1] ?? [0, 0] } as never)
              : undefined,
          );
        if (!wanted.has(frame)) continue;
        const record: Record<string, number[][][]> = {};
        for (const { layer, system } of systems) {
          const layout = layouts.get(layer.name);
          const buffer = new Float32Array(Math.max(1, system.columns.capacity) * layout.stride);
          const count = writeRopeSegments(system, layout, buffer, fps);
          const at = (k: number, offset: number) =>
            Array.from(buffer.subarray(k * layout.stride + offset, k * layout.stride + offset + 4));
          record[layer.name] = Array.from({ length: count }, (_, k) => [
            at(k, layout.start),
            at(k, layout.end),
            at(k, layout.cp0),
            at(k, layout.cp1),
            at(k, layout.endColor),
            at(k, layout.color),
          ]);
        }
        out.set(frame, record);
      }
      return out;
    };
    const env = sec.run.envelope ?? {};
    const { exact, envelopes } = env.approx ? await this.withApprox(replay) : { exact: await replay(), envelopes: [] };
    for (const layer of layers) {
      const name = layer.name;
      const stat = {
        frames: 0,
        segments: 0,
        counts: [] as string[],
        mismatch: [] as string[],
        diff: { pos: 0, size: 0, color: 0, alpha: 0, tl: 0, tp: 0 },
        ratio: { pos: 0, size: 0, color: 0, alpha: 0, tl: 0, tp: 0 },
        over: 0,
        envelope: 0,
        tl: [] as number[],
        tp0: [] as number[],
        worst: null as unknown,
      };
      let worstRatio = 0;
      for (const frame of sec.truth.frames) {
        const draw = frame.systems[name];
        const ours = exact.get(frame.frame)![name];
        const wpeCount = draw ? draw.vs_count : 0;
        stat.counts.push(`${draw ? wpeCount : "无"}/${ours.length}`);
        if (wpeCount !== ours.length) {
          stat.mismatch.push(`${frame.frame}:${draw ? wpeCount : "无绘制"}/${ours.length}`);
          continue;
        }
        if (!draw) continue;
        stat.frames++;
        if (ours.length) {
          stat.tl.push(ours[0][1][3]);
          stat.tp0.push(ours[0][2][3]);
        }
        for (let k = 0; k < ours.length; k++) {
          stat.segments++;
          COLUMNS.forEach((column, c) => {
            const wpe = draw.vs_in[column][k];
            for (let j = 0; j < 4; j++) {
              const value = ours[k][c][j];
              const diff = Math.abs(value - wpe[j]);
              let envelope = 0;
              for (const other of envelopes) {
                const e = other.get(frame.frame)?.[name]?.[k]?.[c]?.[j];
                if (e !== undefined) envelope = Math.max(envelope, Math.abs(e - value));
              }
              let field: keyof typeof stat.diff;
              let limit: number;
              if (c <= 3 && j < 3) {
                field = "pos";
                const coord = Math.max(...wpe.slice(0, 3).map(Math.abs));
                limit = (coord > L.farCoord ? L.posFar : L.pos) + envelope;
              } else if (c === 1 && j === 3) {
                field = "tl";
                limit = L.tl;
              } else if (c === 2 && j === 3) {
                field = "tp";
                limit = L.tp;
              } else if (c === 0 || c === 3) {
                field = "size";
                limit = L.size + envelope;
              } else if (j === 3) {
                field = "alpha";
                limit = L.alpha + envelope;
              } else {
                field = "color";
                limit = L.color + envelope;
              }
              stat.envelope = Math.max(stat.envelope, envelope);
              stat.diff[field] = Math.max(stat.diff[field], diff);
              stat.ratio[field] = Math.max(stat.ratio[field], diff / limit);
              if (diff / limit > worstRatio) {
                worstRatio = diff / limit;
                stat.worst = { frame: frame.frame, segment: k, column, component: j, wpe: wpe[j], ours: value, limit };
              }
              if (!(diff <= limit)) stat.over++;
            }
          });
        }
      }
      const ok = !stat.mismatch.length && stat.over === 0;
      const d = stat.diff;
      const judged = !(sec.run.systems?.informational ?? []).includes(name);
      const row =
        `  ${name.padEnd(6)} ${String(stat.frames).padStart(1)} 帧 ${String(stat.segments).padStart(3)} 段（逐帧 WPE/我们 ${stat.counts.join(" ")}）` +
        ` 位置 ${e2(d.pos)} 尺寸 ${e2(d.size)} 颜色 ${e2(d.color)} alpha ${e2(d.alpha)}` +
        ` TL ${e2(d.tl)} TP ${e2(d.tp)}（包络 ${stat.envelope.toExponential(1)}）` +
        `；TL ${[...new Set(stat.tl.map((v) => Number(v.toFixed(5))))].join("/")} TP0 ${[...new Set(stat.tp0.map((v) => Number(v.toFixed(4))))].join("/")}` +
        `${stat.mismatch.length ? ` 段数不同 ${stat.mismatch.join(",")}` : ""} ${ok ? "ok" : "超限"}${judged ? "" : "（只报告）"}`;
      this.addSystem(sec, name, { mode: "rope", ok, judged, stats: stat as any }, row);
    }
    if (this.hook.after)
      await this.hook.after(this, sec, { exact: new Map(), envelopes: [], history: new Map(), births: {} });
  }
}

// ==================== 入口 ====================

/** 报告文字与 JSON（不含路径与耗时：两份源码上的结果可以逐字节比较）。 */
function writeReport(out: string, ctx: CaseContext): void {
  mkdirSync(out, { recursive: true });
  const c = ctx.report;
  const failedChecks = [...c.checks, ...c.sections.flatMap((s) => s.checks)].filter((k) => k.judged && !k.ok);
  const failedSystems = c.sections.flatMap((s) =>
    Object.entries(s.systems)
      .filter(([, r]) => r.judged && !r.ok)
      .map(([name]) => `${s.label}/${name}`),
  );
  const lines = [`# 案例 ${c.case}${c.description ? `：${c.description}` : ""}`, ...ctx.lines, ""];
  lines.push(c.ok ? "全部通过" : `有失败：${[...failedSystems, ...failedChecks.map((k) => k.name)].join("；")}`);
  writeFileSync(path.join(out, `${c.case}.txt`), lines.join("\n") + "\n");
  writeFileSync(path.join(out, `${c.case}.json`), JSON.stringify(c, null, 1) + "\n");
}

/**
 * 跑一个案例：编译、时间线、模拟、包络、比较，写 `<out>/<名字>.txt`、`.json`。src 是产品源码目录（快照的 src/），data 是数据目录。
 * 调用前要 `registerMocks(src)`（replay.test.ts 做）。
 */
export async function runCase(src: string, data: string, c: ReplayCase, out: string): Promise<CaseReport> {
  src = slash(path.resolve(src));
  const hookName =
    c.hook ?? (existsSync(path.join(data, "cases", `${c.name}.hook.ts`)) ? `${c.name}.hook.ts` : undefined);
  const hook: CaseHook = hookName ? await import(/* @vite-ignore */ slash(path.join(data, "cases", hookName))) : {};
  const ctx = new CaseContext(src, data, c, hook);
  const runs = expandRuns(c);
  if (runs.some((r) => r.envelope?.approx)) await ctx.checkBias();
  let index = 0;
  for (const run of runs) {
    for (const tag of run.tags) {
      const sec = await ctx.prepareSection(run, tag, index++);
      const pending = ctx.takeDeferred();
      ctx.line("");
      ctx.line(
        `== ${sec.label}（工程 ${sec.project}，${sec.passes} 遍，帧 ${sec.frames.join(",")}；` +
          `窗口内 dt ${sec.truth.frames.map((f) => f.dt.toFixed(4)).join(" ")}）`,
      );
      ctx.report.sections.push(sec.report);
      for (const text of pending) ctx.line(text);
      ctx.checkUnsupported(sec);
      if (hook.section) await hook.section(ctx, sec);
      else await ctx.standard(sec);
    }
  }
  if (hook.finish) await hook.finish(ctx);
  writeReport(out, ctx);
  return ctx.report;
}
