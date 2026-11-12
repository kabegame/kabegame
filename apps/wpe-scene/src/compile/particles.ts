/**
 * 粒子 JSON → 纯数据（P4a 步骤 2）。不碰 GPU：bundle 里只放解析后的值，模拟在 `src/particles/`（步骤 3），绘制在渲染层（步骤 4）。
 *
 * 模块的字段、缺省值都从模块表（`particles/modules.ts`）读，这里只管系统级的键、`instanceoverride` 与 renderer 的补全。
 * 能力检查在 `features.ts` 的 `checkParticleFeatures`，与这里读同一张表。
 *
 * 依据：`.claude/plans/wpe-import/3-scene/phase4/rea-p4a.md`（「基础」、B、C1 / C3 / C5），顶层键的读取顺序与缺省值按
 * `ignore/p4/rea/parser.asm`（`FUN_1401c5490`，`0x1401c5543` 起）核对：数值键用 `isNumeric`（`0x140088880`：int / uint / real，
 * null 为假）取值，否则取缺省；`animationmode` 用 `isString`（`0x140088890`）后与 `"randomframe"` 比。
 */
import type { ScenePass } from "./bundle";
import { isScriptValue, isUserBinding } from "./bindings";
import type { JsonObject, SceneScalar } from "./model";
import { roundTrip5 } from "../particles/colorn";
import { eulerBasis } from "../particles/controlpoints";
import { f32 } from "../particles/f32";
import { asUInt32, readParticleModule, type ParticleCategory, type ParticleModule } from "../particles/modules";
import { readOrientation, type ParticleOrientation } from "../particles/orientation";

/**
 * `instanceoverride` 里就地更新的标量键（P4a 步骤 5，`rea-p4a.md` C5）：编译期每处 `{user}` 登记成 `particle-instance`
 * 绑定，运行时改值由 `ParticleSystem.setInstance` 从基值重新乘。`brightness` 只在场景 HDR 且系统 `flags` 没有 bit3 时生效，
 * 这时它改走重编译（`bundle.ts`），取非默认值由能力表报。
 */
export const INSTANCE_FIELDS = ["alpha", "size", "count", "speed", "lifetime", "rate", "brightness"] as const;
export type InstanceField = (typeof INSTANCE_FIELDS)[number];
/**
 * 就地更新的全部键：标量键加 `colorn`（P4b 步骤 6）。`colorn` 也登记成 `particle-instance` 绑定，改值时模拟器从基值重算平移
 * 与实例颜色（`ParticleSystem.setInstance` → `colornState`）。
 */
export type InstanceKey = InstanceField | "colorn";
/** `instanceoverride` 就地更新的部分（`SceneState` 存的就是这一份）：标量键加 `colorn`（未设为 null）。 */
export type ParticleInstanceValues = Record<InstanceField, number> & { colorn: readonly number[] | null };

/**
 * 一个标量键的取值，编译与就地写共用（「就地 = 重编译」靠它）：数字原样；非空字符串整串解析成有限数；布尔按 1 / 0
 * （条件绑定 `{user: {name, condition}}` 的值是布尔，同图层字段的 `asNumber`）；其余（含解析不出来）取缺省 1。
 */
export function instanceScalar(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 1;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 1;
}

/**
 * `instanceoverride` 的值（`rea-p4a.md` C5，基址 `obj+0x778`）。标量键与 `colorn` 经 `InstanceResolver` 取值（编译期登记绑定、
 * 读用户属性，`bundle.ts`）；`color` 与控制点只取静态值（`color` 绑了属性报不支持；控制点的 `{user}` 报
 * `particle:instance:controlpoint:user`，`checkParticleInstance`）。
 * `rate` 的下限 0.01 只在脏时钳（C5），这里存原值。
 */
export interface ParticleInstance {
  /** 新粒子的 `a0`。 */
  alpha: number;
  /** 乘 `sizerandom`、`sizechange` 的 min / max。 */
  size: number;
  /** 乘各 emitter 的 `rate`、`maxtoemitperperiod`，不改 `maxcount`。 */
  count: number;
  /** 乘发射速度、`velocityrandom`、`movement.gravity`、`angularmovement.force`、`angularvelocityrandom`、`oscillateposition` 频率等。 */
  speed: number;
  /** 乘 `lifetimerandom` 的 min / max。 */
  lifetime: number;
  /** 整个模拟的时间缩放：`dt' = dt·rate`。 */
  rate: number;
  /** 仅 HDR 且系统 `flags` 没有 bit3 时乘实例颜色。 */
  brightness: number;
  /**
   * 未设为 null（WPE 的 −1 −1 −1）；分量 r < 0 也算未设（`colornState` 判断，这里存原值）。`color`（0–255）加载时按
   * `f32(f32(v) / 255)` 再 `%.5f` 往返转成它，两个键都写时取 `color`（rea-p4b-render.md 7.1，`instanceColorn`）。
   */
  colorn: readonly number[] | null;
  /**
   * `controlpoint0..7`；未设为 null（WPE 的 FLT_MAX）。替换控制点 `base` 的平移（`particles/controlpoints.ts`，P4c 步骤 1）。
   * 静态值（`{user}` 只取 JSON 里的 `value`，由能力表报）。
   */
  controlpoints: (number[] | null)[];
  /** `controlpointangle0..7`（弧度，`Rz·Ry·Rx`）；未设为 null。替换控制点 `base` 的 3×3。静态值，同上。 */
  controlpointAngles: (number[] | null)[];
}

/**
 * 控制点数组的一项（rea-p4c-sim.md 1.2，`FUN_1401c5490` 段 `0x1401d04d8`–`0x1401d080e`）。`angles`、`locktopointer`、`id` 不读：
 * `angles` 解析了但运行时没有读者（实测不起作用），`locktopointer` 这个键 WPE 不认（二进制里没有这个字符串，实测不跟随），`id` 是
 * 编辑器键。`parentcontrolpoint` 只对子系统有意义（P4e 步骤 1 起读，`parent`）。
 */
export interface SceneControlPoint {
  /**
   * `flags`：按 jsoncpp 取无符号整数（`FUN_140085f70`，`0x1401d05a2`）：数字取整后取低 32 位（负数当很大的无符号数），布尔为
   * 1 / 0，其余 0（WPE 对字符串、对象会抛异常，语料没有）。bit0 跟随指针（P4c 步骤 2 已实现）、bit1 base 是场景坐标、bit2 父
   * 控制点（子系统读父系统的点，P4e 步骤 1；顶层只让实例覆盖不生效）、bit3 父分支不换算（P4e 步骤 1），其余位没有读者
   * （`particles/controlpoints.ts`）。
   */
  flags: number;
  /**
   * `offset`：只在是字符串时解析（`0x1401d05c5`，其余保持 `0 0 0`），空串保持 `0 0 0`。三个分量各 `atof` 一次：第一个从串首，
   * 之后先跳过非空格字符、再跳过空格（只认 0x20），从那里再 `atof`（`0x1401d061c`–`0x1401d0680`）；`atof` 按 `parseFloat`，
   * 读不出数取 0。
   */
  offset: [number, number, number];
  /**
   * `parentcontrolpoint`（`cp+0xc4`，rea-p4c-sim.md 1.2、1.8）：`asInt`、不钳制，存成 u32（取值同 `flags`），父分支里和父系统的
   * 控制点个数按无符号比较。只在 JSON 写了这个键时有（缺键是 0，读的地方按 `?? 0`）。
   */
  parent?: number;
}

/** 控制点 `flags` 的取值（见 `SceneControlPoint.flags`）。 */
function controlPointFlags(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return asUInt32(Math.trunc(value));
  if (typeof value === "boolean") return value ? 1 : 0;
  return 0;
}

/** 控制点 `offset` 字符串的三个分量（见 `SceneControlPoint.offset`）。 */
export function controlPointOffset(text: string): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  if (!text) return out;
  let at = 0;
  for (let i = 0; i < 3; i++) {
    if (i > 0) {
      while (at < text.length && text[at] !== " ") at++;
      while (at < text.length && text[at] === " ") at++;
    }
    const value = parseFloat(text.slice(at));
    out[i] = Number.isNaN(value) ? 0 : value;
  }
  return out;
}

/**
 * 控制点数组（rea-p4c-sim.md 1.2）：只在 `controlpoint` 是数组时读；按数组下标取前 8 项，不是对象的项（含数组）取缺省。
 * 总是 8 项。控制点有没有用由模块的 `controlpoint` 决定（`particles/controlpoints.ts` 的 `controlPointCount`）。
 */
export function readControlPoints(json: JsonObject): SceneControlPoint[] {
  const raw = json.controlpoint;
  return Array.from({ length: 8 }, (_, i) => {
    const entry: unknown = Array.isArray(raw) ? raw[i] : undefined;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { flags: 0, offset: [0, 0, 0] };
    const { flags, offset, parentcontrolpoint } = entry as Record<string, unknown>;
    const point: SceneControlPoint = {
      flags: controlPointFlags(flags),
      offset: typeof offset === "string" ? controlPointOffset(offset) : [0, 0, 0],
    };
    // 父控制点下标（P4e 步骤 1）：只在写了时带上，没写的点和以前逐字相同
    if (parentcontrolpoint !== undefined && parentcontrolpoint !== null)
      point.parent = controlPointFlags(parentcontrolpoint);
    return point;
  });
}

/**
 * 子系统的嵌套上限（rea-p4e-children 1.6，`FUN_14022ebe0` 的 `sys.depth < 10`，`0x14022ec04`）：深度 < 10 的系统才建自己的子系统，
 * 所以顶层（深度 0）下面最多 10 层，第 10 层的 `children` 不读。自引用的文件因此到第 10 层停（实测 `st-depth` 11 次绘制）。
 */
export const MAX_CHILD_DEPTH = 10;

/** 子系统条目的 `type`（rea-p4e-children 1.2）：`static` 1、`eventfollow` 2、`eventspawn` 3、`eventdeath` 4。 */
export type ParticleChildType = "static" | "eventfollow" | "eventspawn" | "eventdeath";
const CHILD_TYPES: readonly ParticleChildType[] = ["static", "eventfollow", "eventspawn", "eventdeath"];

/**
 * `children` 一项（rea-p4e-children 1.1–1.4，`FUN_1401c1430` 缺省、`0x1401d0880`–`0x1401d1455` 解析）。`type` 不认识（含大小写
 * 不同）的条目解析时丢掉，同 WPE 编号 0 整条既不建也不画（`0x14022ec60`–`0x14022ec7a`，实测 `st-type`）。
 */
export interface SceneParticleChild {
  type: ParticleChildType;
  /**
   * 条目 `flags`（`E+0x64`，`asInt` 原值）：bit0 父的存活粒子写子系统控制点（第 5 节）、bit1 父系统周期发射进入新周期时复位这个
   * static 子系统（3.7）；其余位没有读者（1.3【确，有界】）。
   */
  flags: number;
  /** `controlpointstartindex`（`E+0x68`，`asInt`、有符号、不钳制）：只在 `flags` bit0 时起作用（第 5 节）。 */
  controlPointStartIndex: number;
  /** `probability`（`E+0x6c`，float32，缺省 1）：只有事件类读（4.4，P4e 步骤 2、3）；static 条目不读，保持 1。 */
  probability: number;
  /** `maxcount`（`E+0x70`，u32，缺省 10）：事件类同时活跃的实例上限（4.1）；static 条目不读，保持 10。 */
  maxcount: number;
  /**
   * 局部矩阵 `L = T(origin)·Rz·Ry·Rx·S(scale)`（1.4，列主序 16 个 float32，弧度）。`L` 在解析期算好，运行时不再读这三个键。存数组
   * 不存 `Float32Array`：bundle 要经 Worker 传、也会被工具转成 JSON。
   */
  local: number[];
  /**
   * 条目在 JSON `children` 数组里的下标：`children` 跳过了不认识的类型与读不到的文件，所以它的下标（系统树的路径用这个）不等于 JSON
   * 下标；材质 pass 的稳定键（`…/children/<index>/…`）与对照工具按子系统起名用这个。
   */
  index: number;
  /** 子系统（按 `name` 读的粒子 JSON，结构同顶层系统）。 */
  system: SceneParticle;
}

/** 解析出的条目（还没读子系统 JSON）：`type` 为 null 是不认识的类型（整条忽略）。 */
export type ParticleChildEntry = Omit<SceneParticleChild, "type" | "system" | "index"> & {
  name: string;
  type: ParticleChildType | null;
};

/** jsoncpp `asInt`：数字截断，布尔 1 / 0，其余（WPE 对字符串、对象会抛异常，语料没有）取缺省。 */
function childInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  return fallback;
}

/**
 * 条目的三个向量（1.4）：各自先清零，按控制点 `offset` 同一套 `atof` 读三个分量（`controlPointOffset`），**缺的分量是 0**
 * （`scale "2"` 得 `(2, 0, 0)`，实测 `st-scale1`），舍入成 float。只认字符串：缺键（含 null）取缺省串；写成别的类型 WPE 把数值当
 * 指针读（未定义行为，语料没有），返回 null 由能力表报 `particle:child:<键>`。
 */
function childVector(value: unknown, fallback: string): number[] | null {
  if (value === undefined || value === null) return controlPointOffset(fallback).map(f32);
  return typeof value === "string" ? controlPointOffset(value).map(f32) : null;
}

/**
 * 局部矩阵 `L = T·Rz·Ry·Rx·S`（1.4，`0x1401d09e1`–`0x1401d1211`）：旋转部分和 `controlpointangleN` 是同一套公式（`eulerBasis`，
 * CRT `cosf` / `sinf`，弧度、没有度换算，实测 `s-xf` 的 `angles "0 0 30"` 转 −81.13°），三列逐分量乘缩放（`mulss`），第 4 列是平移。
 */
export function childLocalMatrix(
  origin: readonly number[],
  angles: readonly number[],
  scale: readonly number[],
): number[] {
  const basis = eulerBasis(angles);
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) out[c * 4 + r] = f32(basis[c * 3 + r] * f32(scale[c]));
  out[12] = f32(origin[0]);
  out[13] = f32(origin[1]);
  out[14] = f32(origin[2]);
  out[15] = 1;
  return out;
}

/** 条目里写成绑定或不是字符串的向量键（能力表报 `particle:binding:child:<键>` / `particle:child:<键>`）。 */
export interface ParticleChildIssue {
  field: string;
  kind: "binding" | "value";
}

/**
 * 解析 `children` 的一项（1.1–1.4）：缺省 `type "static"`、`flags 0`、`controlpointstartindex 0`、`probability 1`、`maxcount 10`、
 * `origin "0 0 0"`、`angles "0 0 0"`、`scale "1 1 1"`（`FUN_1401c1430` 写回 JSON 的缺省）。`static` 条目不读 `probability`、`maxcount`
 * （`0x1401d1220` 之后直接跳过，实测 `s-p0`、`s-max`）。`id` 不读。不是对象、或 `name` 不是非空字符串时返回 null（调用方报
 * `particle:child:name`：WPE 读到空文件名，加载失败，整棵子树不画）。值为 null 的键当缺键。`issues` 收集绑定与向量键的形状问题。
 */
export function parseParticleChildEntry(raw: unknown, issues: ParticleChildIssue[] = []): ParticleChildEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  for (const [field, value] of Object.entries(entry))
    if (field !== "id" && (isUserBinding(value) || isScriptValue(value))) issues.push({ field, kind: "binding" });
  if (typeof entry.name !== "string" || !entry.name) return null;
  const rawType = entry.type === undefined || entry.type === null ? "static" : entry.type;
  // 逐字节比较（`strcmp`），大小写不同的写法落到编号 0
  const type = typeof rawType === "string" ? (CHILD_TYPES.find((name) => name === rawType) ?? null) : null;
  const vector = (field: string, fallback: string) => {
    const parsed = childVector(entry[field], fallback);
    if (parsed) return parsed;
    issues.push({ field, kind: "value" });
    return controlPointOffset(fallback);
  };
  const origin = vector("origin", "0 0 0");
  const angles = vector("angles", "0 0 0");
  const scale = vector("scale", "1 1 1");
  const event = type !== null && type !== "static";
  return {
    name: entry.name,
    type,
    flags: childInt(entry.flags, 0),
    controlPointStartIndex: childInt(entry.controlpointstartindex, 0),
    probability: event
      ? typeof entry.probability === "number" && Number.isFinite(entry.probability)
        ? f32(entry.probability)
        : typeof entry.probability === "boolean"
          ? Number(entry.probability)
          : 1
      : 1,
    // `asInt` 后存 u32（`E+0x70`）
    maxcount: event ? asUInt32(childInt(entry.maxcount, 10)) : 10,
    local: childLocalMatrix(origin, angles, scale),
  };
}

export interface SceneParticle {
  /** 粒子 JSON 的路径（对象的 `particle`）。 */
  file: string;
  /** 容量；缺省 0（不分配）。不受 `instanceoverride.count` 影响（C2）。 */
  maxcount: number;
  /** 预热时长（秒）：加载时一次跑完，步长按 `maxcount` 取 0.05 或 0.2（C1，实测核对过）。 */
  starttime: number;
  /**
   * 系统 `flags`（整数）：bit0 世界空间（P4c 步骤 4：粒子存世界坐标，绘制时模型矩阵是单位阵），bit1 关混帧
   * （`SPRITESHEETBLEND = 0`，唯一的读取点，rea-p4b-render.md 2.3），bit2 透视覆盖、bit3–7 禁用对应的 `instanceoverride`（C3）；
   * 更高位由能力表报。
   */
  flags: number;
  /**
   * `animationmode`：只有 `"randomframe"` 是 1，其余（含缺键、null、`"sequence"`）都是 0。`randomframe` 时出生写 `R`、
   * 之后不更新，混帧关（rea-p4b-render.md 2.5）；只在帧表系统（`spriteSheet`）里有作用。
   */
  animationMode: "sequence" | "randomframe";
  /** 缺省 1。帧表系统的 `sequence` 模式下 frame = age / life · 它（可以大于 1，着色器取小数）。 */
  sequenceMultiplier: number;
  /**
   * 粒子材质槽 0 的纹理带帧表（WPE 的系统标志 `0x1000000`，rea-p4b-render.md 2.3）：编完材质后由 `compileScene` 填，
   * `parseParticle` 给 false。模拟器据此每帧算 frame（`ParticleSystem.sequenceFrames`），顶点写 `a_TexCoordVec4C1`。
   */
  spriteSheet: boolean;
  /** JSON 顺序，不排序（O2，实测）。 */
  emitters: ParticleModule[];
  initializers: ParticleModule[];
  operators: ParticleModule[];
  /**
   * JSON 顺序。`renderer` 缺键或不是数组时补一个 `sprite`（`0x1401c58a2` 用 `isArray` 判断，`0x1401c58af` 补）；
   * 写成 `[]` 时 WPE 不补，系统不画（语料里都是只靠子系统出图的发射器）。
   */
  renderers: ParticleModule[];
  /** 绘制用的 renderer（P4c 步骤 5，`particleRenderer`）：种类、拖尾的 `g_RenderVar0`、朝向、rope 的绘制参数（P4d 步骤 1）。 */
  renderer: ParticleRenderer;
  /** 缺省值按正交还是透视那一套选（`isOrthographic`）。 */
  orthographic: boolean;
  /** 控制点数组（总是 8 项，`readControlPoints`）。 */
  controlpoints: SceneControlPoint[];
  instance: ParticleInstance;
  /** 系统色与 `0x200000`（`instanceoverride.colorn` 用，P4b 步骤 6，`particleColorSystem`）。 */
  colorSystem: ParticleColorSystem;
  /**
   * 粒子材质的 pass（稳定键 `objects/<i>/particle/passes/<n>`）。步骤 4 才画：不放进 `layer.passes`，图像层的渲染图、
   * `buildableLayers`、`checkRenderable` 都按 `passes` 判断。
   */
  passes: ScenePass[];
  /**
   * 子系统（P4e 步骤 1，rea-p4e-children 第 1 节）：`children` 里认得的条目，JSON 顺序，不认识的类型已丢掉；`parseParticle` 给
   * 空数组，`compileScene` 读子系统 JSON 后填（深度 < `MAX_CHILD_DEPTH` 的系统才填）。模拟器当场建 `static` 的，事件类建实例池（P4e
   * 步骤 2、3），绘制按先序展开（`render/graph.ts` 的 `planParticleLayer`、`ParticleSystem.forEachDrawn`）。
   */
  children: SceneParticleChild[];
}

/**
 * `rope` 的绘制参数（P4d 步骤 1，rea-p4d-rope.md 1.2、3.1、3.2）：解析期定下，段顶点（`particles/rope.ts` 的 `writeRopeSegments`）
 * 与宏（`compile/bundle.ts`）用。
 */
export interface RopeRenderer {
  /** `subdivision`，已钳到 `[0, 32]`：宏 `TRAILSUBDIVISION`，每段输出 `4 + 2·subdivision` 个顶点。 */
  subdivision: number;
  /** `K = 1/uvscale`（`sys+0x30`，float32）；`uvscale` 为 0 时不改，保持 1（3.1，`0x1401d0026`）。 */
  inverseScale: number;
  /** `uvscrolling`，系统 flags `0x20000`（`0x1401d0060`）：为真时不看 `uvsmoothing`。 */
  scrolling: boolean;
  /** `uvsmoothing` 且没开 `uvscrolling`，系统 flags `0x40000`（`0x1401d00a4`，`else if`）。 */
  smoothing: boolean;
  /**
   * `L`（`def+0x1a4` → `sys+0x1bc`）：按 JSON 顺序第一个中点非零的 `lifetimerandom` 的 `min + (max − min)·0.5`（float32，`exponent`
   * 不参与，3.2 `0x1401c72d0`–`0x1401c72f5`），没有则 0。没乘 `instanceoverride.lifetime`（写段顶点时乘，1.2）。
   */
  lifetime: number;
  /**
   * `R`（`def+0x1a8` → `sys+0x1c0`）：按 JSON 顺序第一个 `rate` 非零的 `sphererandom` / `boxrandom` 的 `rate`（float32，3.2
   * `0x1401c6ab4`），没有则 0。没乘 `instanceoverride.count`（写段顶点时乘，1.2）。
   */
  rate: number;
}

/**
 * `ropetrail` 的绘制参数（P4d 步骤 2，rea-p4d-rope.md 3.1、3.4、第 4、5 节）：解析期定下，历史采样与段顶点（`particles/ropetrail.ts`）、
 * `g_RenderVar0`（`trailRenderVar0`）与宏（`compile/bundle.ts`）用。
 */
export interface RopeTrailRenderer {
  /** `segments`（n，已钳到 `[2, 32]`）：每粒子恒写 n 段、历史 n 个位置（`sys+0x248`，u16）。 */
  segments: number;
  /** 采样间隔 `f32(length / segments)`（`sys+0x250`，`0x1401d29ae`；`length` 已至少 0.001）。 */
  interval: number;
  /** `subdivision`，已钳到 `[0, 32]`：宏 `TRAILSUBDIVISION`，每段输出 `4 + 2·subdivision` 个顶点。 */
  subdivision: number;
  /** `K = 1/uvscale`（和 rope 共用 `sys+0x30`，float32）；`uvscale` 为 0 时不改，保持 1（3.1）。 */
  inverseScale: number;
  /** `uvscrolling`，系统 flags `0x80000`（`0x1401d02d1`）：宏 `TRAILSCROLLALPHA`、`U` 计数、`g_RenderVar0` 的滚动写法。 */
  scrolling: boolean;
  /** `fadealpha`（`rec+0x48` bit0）：宏 `TRAILFADEALPHA`，着色器只在 `TRAILSCROLLALPHA` 分支读（5.4）。 */
  fadeAlpha: boolean;
  /** `fadesize`（`rec+0x48` bit1）：宏 `TRAILFADESIZE`，同上。 */
  fadeSize: boolean;
}

/** 走几何着色器的 renderer（rope 两类，P4d）：着色器换成 `genericropeparticle` 并带 `.geom` 翻译，每段一个实例。 */
export function isRopeRenderer(kind: ParticleRenderer["kind"] | undefined): kind is "rope" | "ropetrail" {
  return kind === "rope" || kind === "ropetrail";
}

/**
 * 绘制用的 renderer（P4c 步骤 5）。一个系统只画一次：多个 renderer 时 WPE 各画一次、共用同一个顶点缓冲（rea-p4c-render.md 6.3），
 * 这里没做，能力表报 `particle:renderers`（`checkParticleFeatures`），强制渲染时取第一个。
 */
export interface ParticleRenderer {
  kind: "sprite" | "spritetrail" | "rope" | "ropetrail";
  /**
   * 拖尾的 `g_RenderVar0.xyz`：`(length, maxlength, minlength)`，float32，原样（不钳制、不排序，6.1）；`w` WPE 不写、
   * `genericparticle` 不读，我们写 0。sprite、rope 为 null（`g_RenderVar0` 全 0：rope 分支不读它，WPE 写的 `z = 0`、
   * `w = 存活数` 不复刻，rea-p4d-rope.md 第 4 节）。ropetrail 也为 null：它的 `g_RenderVar0` 每帧按计时器写
   * （`particles/ropetrail.ts` 的 `trailRenderVar0`）。
   */
  trail: [number, number, number] | null;
  /**
   * 朝向（`readOrientation`）：每次绘制按它和绘制的模型矩阵算 `g_Orientation*`；拖尾的几何不读，值照算（7.7）。rope 的几何
   * 只在 `ORIENTATION ≠ 0` 时读 `g_OrientationForward`（rea-p4d-rope.md 1.5），模式进宏 `ORIENTATION`。
   */
  orientation: ParticleOrientation;
  /** `rope` 的绘制参数；其余 renderer 为 null。 */
  rope: RopeRenderer | null;
  /** `ropetrail` 的绘制参数（P4d 步骤 2）；其余 renderer 为 null。 */
  ropetrail: RopeTrailRenderer | null;
}

/** 表内的 renderer。 */
const DRAWN_RENDERERS: ReadonlySet<string> = new Set(["sprite", "spritetrail", "rope", "ropetrail"]);

/**
 * `rope` 的 `L`、`R`（rea-p4d-rope.md 3.2）：WPE 在解析 emitter / initializer 时顺带记下，`L`、`R` 初值 0、只在当前为 0 时写，
 * 等价于各取第一个非零值。字段是模块表的解析值（double，缺省已补，绑定取静态值），这里舍入成 float32 再算。
 */
function ropeRateAndLifetime(
  emitters: readonly ParticleModule[],
  initializers: readonly ParticleModule[],
): { rate: number; lifetime: number } {
  let lifetime = 0;
  for (const module of initializers) {
    if (module.name !== "lifetimerandom" || lifetime !== 0) continue;
    const min = f32(module.fields.min as number);
    const max = f32(module.fields.max as number);
    lifetime = f32(f32(f32(max - min) * 0.5) + min);
  }
  let rate = 0;
  for (const module of emitters)
    if ((module.name === "sphererandom" || module.name === "boxrandom") && rate === 0)
      rate = f32(module.fields.rate as number);
  return { rate, lifetime };
}

/**
 * 系统的 renderer：第一个表内的 renderer（`sprite` / `spritetrail` / `rope` / `ropetrail`）；一个都没有时按缺省的 `sprite` 画。
 * 表外 renderer 已由能力表报；`renderer: []` 时 WPE 不画这个系统（只靠子系统出图的发射器），这里照样给出缺省的 sprite（材质的宏
 * 按它编），绘制由 `render/graph.ts` 的 `planParticleLayer` 按 `renderers` 为空跳过（P4e 步骤 1）。`emitters`、`initializers` 给 rope 的
 * `R`、`L`（`ropeRateAndLifetime`），缺省为空（`R = L = 0`）。
 */
export function particleRenderer(
  renderers: readonly ParticleModule[],
  emitters: readonly ParticleModule[] = [],
  initializers: readonly ParticleModule[] = [],
): ParticleRenderer {
  const module = renderers.find((item) => DRAWN_RENDERERS.has(item.name));
  const fields = module?.fields ?? readParticleModule("renderer", { name: "sprite" }, true).fields;
  const trail = module?.name === "spritetrail";
  // `divss`：`1.0f / uvscale`，0 时不写（def 构造值 1.0，`0x1401c17c6`）；rope 两类共用 `sys+0x30`
  const inverseScale = () => {
    const scale = f32(fields.uvscale as number);
    return scale !== 0 ? f32(1 / scale) : 1;
  };
  let rope: RopeRenderer | null = null;
  if (module?.name === "rope") {
    const scrolling = fields.uvscrolling === 1;
    rope = {
      subdivision: fields.subdivision as number,
      inverseScale: inverseScale(),
      scrolling,
      smoothing: !scrolling && fields.uvsmoothing === 1,
      ...ropeRateAndLifetime(emitters, initializers),
    };
  }
  let ropetrail: RopeTrailRenderer | null = null;
  if (module?.name === "ropetrail") {
    const segments = fields.segments as number;
    ropetrail = {
      segments,
      // `sys+0x250 = rec+0x3c / (float)rec+0x40`（`0x1401d29ae`）：`length` 已是钳过的 float32（`clampTrailLength`）
      interval: f32(f32(fields.length as number) / segments),
      subdivision: fields.subdivision as number,
      inverseScale: inverseScale(),
      scrolling: fields.uvscrolling === 1,
      fadeAlpha: fields.fadealpha === 1,
      fadeSize: fields.fadesize === 1,
    };
  }
  return {
    kind: trail ? "spritetrail" : rope ? "rope" : ropetrail ? "ropetrail" : "sprite",
    trail: trail
      ? [f32(fields.length as number), f32(fields.maxlength as number), f32(fields.minlength as number)]
      : null,
    orientation: readOrientation(fields),
    rope,
    ropetrail,
  };
}

/** 粒子 JSON 的顶层键（`FUN_1401c5490` 读的全部键）；其余报 `particle:system:<键>`。 */
export const PARTICLE_SYSTEM_KEYS: ReadonlySet<string> = new Set([
  "material",
  "starttime",
  "animationmode",
  "sequencemultiplier",
  "flags",
  "maxcount",
  "emitter",
  "initializer",
  "operator",
  "renderer",
  "controlpoint",
  "children",
]);

/**
 * 场景是否正交（`rea-p4a.md`「基础」【确】）：`general.orthogonalprojection` 是对象，且 `auto: true` 或 `width`、`height`
 * 都非 0。粒子字段的缺省值按它选两套之一。
 */
export function isOrthographic(general: Record<string, unknown> | undefined): boolean {
  const projection = general?.orthogonalprojection;
  if (!projection || typeof projection !== "object" || Array.isArray(projection)) return false;
  const { auto, width, height } = projection as { auto?: unknown; width?: unknown; height?: unknown };
  return auto === true || (!!Number(width) && !!Number(height));
}

/** `perspectiveoverridefov`（度）→ 透视粒子的 fov（弧度）：缺省 95，钳到 [0.1, 179.9] 度（C4【确】，实测核对过 `d`）。 */
export function particleFov(value: SceneScalar | undefined): number {
  const degrees = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
  const clamped = Math.min(179.9, Math.max(0.1, Number.isFinite(degrees) ? degrees : 95));
  return (clamped * Math.PI) / 180;
}

const isNumeric = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export interface ParticleSystemValues {
  maxcount: number;
  starttime: number;
  flags: number;
  animationMode: "sequence" | "randomframe";
  sequenceMultiplier: number;
}

/** 系统级的标量键（解析与能力表共用）。 */
export function readParticleSystem(json: JsonObject): ParticleSystemValues {
  return {
    maxcount: isNumeric(json.maxcount) ? Math.max(0, Math.trunc(json.maxcount)) : 0,
    starttime: isNumeric(json.starttime) ? json.starttime : 0,
    flags: isNumeric(json.flags) ? Math.trunc(json.flags) : 0,
    animationMode: json.animationmode === "randomframe" ? "randomframe" : "sequence",
    sequenceMultiplier: isNumeric(json.sequencemultiplier) ? json.sequencemultiplier : 1,
  };
}

/**
 * 一个类别的模块项。`emitter` / `initializer` / `operator` 缺键或 null 时为空，不是数组时返回 null（能力表报
 * `particle:system:<键>`）。`renderer` 不是数组时补一个 `sprite`，见 `SceneParticle.renderers`。
 */
export function particleModuleEntries(json: JsonObject, category: ParticleCategory): unknown[] | null {
  const raw = json[category];
  if (Array.isArray(raw)) return raw;
  if (category === "renderer") return [{ name: "sprite" }];
  return raw === undefined || raw === null ? [] : null;
}

/** 绑定只取 JSON 里的静态 `value`，不读用户属性。 */
function staticValue(raw: unknown): unknown {
  return raw && typeof raw === "object" && !Array.isArray(raw) && "value" in raw
    ? (raw as { value: unknown }).value
    : raw;
}
/** `"r g b"` 的前三个分量（乘 `scale`）；不是字符串、不足三个或有不是数字的分量时为 null。 */
export function instanceVector(raw: unknown, scale = 1): number[] | null {
  const value = staticValue(raw);
  if (typeof value !== "string") return null;
  const parts = value.trim().split(/\s+/).filter(Boolean).map(Number);
  if (parts.length < 3 || !parts.slice(0, 3).every(Number.isFinite)) return null;
  return parts.slice(0, 3).map((part) => part * scale);
}

/**
 * `colorn` 的取值（编译期与就地写共用，「就地 = 重编译」靠它）：同 `instanceVector`，`"r g b"` 的前三个分量，不是字符串或解析
 * 不出来时为 null（未设）。条件绑定的值是布尔，也是 null（WPE 怎么处理没读到，能力表报 `particle:instance:colorn:condition`）。
 * 存 double 原值，float32 舍入在 `colornState` 里做。
 */
export function instanceColorn(value: unknown): number[] | null {
  return instanceVector(value);
}

/**
 * `color`（0–255）→ `colorn`（rea-p4b-render.md 7.1，`0x14022b581`–`0x14022b592`）：每个分量 `strtod` 后 `divss 255`，
 * 按 `"%.5f"` 格式化写回 `colorn`。只取静态值：绑了用户属性时 WPE 怎么转换没读到，能力表报 `particle:instance:color:user`。
 * 解析不出来时为 null（WPE 的 `strtod` 会得 0，语料没有这种写法，不复刻）。
 */
export function colornFromColor(raw: unknown): number[] | null {
  const color = instanceVector(raw);
  return color && color.map((value) => roundTrip5(f32(f32(value) / 255)));
}

/**
 * 标量键与 `colorn` 的取值方式：参数是键名与 JSON 里的原值（可能是 `{user}` / `{script}`），返回解析后的值。缺省只取静态
 * `value`、不读用户属性；`bundle.ts` 传 `BindingCollector.bind`，同时登记绑定。
 */
export type InstanceResolver = (field: InstanceKey, raw: unknown) => SceneScalar | undefined;
const staticResolver: InstanceResolver = (_, raw) => staticValue(raw) as SceneScalar | undefined;

export function parseParticleInstance(raw: unknown, resolve: InstanceResolver = staticResolver): ParticleInstance {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const scalars = Object.fromEntries(
    INSTANCE_FIELDS.map((field) => [field, instanceScalar(resolve(field, source[field]))]),
  ) as Record<InstanceField, number>;
  // 有 `color` 键就无条件用它（7.1：即使已有 `colorn` 也覆盖，`colorn` 上的绑定随之丢掉，所以不登记）
  const hasColor = source.color !== undefined && source.color !== null;
  return {
    ...scalars,
    colorn: hasColor ? colornFromColor(source.color) : instanceColorn(resolve("colorn", source.colorn)),
    controlpoints: Array.from({ length: 8 }, (_, i) => instanceVector(source[`controlpoint${i}`])),
    controlpointAngles: Array.from({ length: 8 }, (_, i) => instanceVector(source[`controlpointangle${i}`])),
  };
}

/** `ParticleInstance` 就地更新的部分（一份新对象，`colorn` 也拷一份）。 */
export function instanceValues(instance: ParticleInstanceValues): ParticleInstanceValues {
  const scalars = Object.fromEntries(INSTANCE_FIELDS.map((field) => [field, instance[field]])) as Record<
    InstanceField,
    number
  >;
  return { ...scalars, colorn: instance.colorn ? [...instance.colorn] : null };
}

/**
 * 场景 `version`（scene.json 根的 `"version"`，缺键为 0，`0x140187401`）：数字且有限时取它，否则按 0。passthrough 材质
 * （`passthroughMaterial`）与粒子的 `0x200000`（`particleColorSystem`）共用这一个取值函数。
 */
export function sceneVersionOf(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

/** `colorn` 的系统色与 `0x200000`（rea-p4b-render.md 7.1、7.4）。 */
export interface ParticleColorSystem {
  /** 系统色：从颜色模块推出、已 `%.5f` 往返（float32）。`colorn` 与它比较、平移的 HSV 差也以它为原点。 */
  rgb: [number, number, number];
  /**
   * WPE 的系统标志 `0x200000`：场景 `version` < 5（缺键为 0，`0x1401c57b6`），或没有颜色模块（`0x1401c5af9`）。置位且
   * `colorn` 生效时，新粒子的颜色初值是 `colorn`（`colornState` 的 `instanceColor`）。
   */
  instanceColor: boolean;
}

/** 1/255 的乘法常量（`0x140492618`，float32 0.0039215689），系统色用乘法，不是除法。 */
const INV_255 = f32(0.003921569);

/** 颜色模块原文里的一个 vec3：同模块表的 vec3 规则（`"x y z"`，少写的为 0、多写的忽略），绑定取静态 `value`；读不出时取缺省。 */
function rawVec3(raw: unknown, fallback: readonly number[]): number[] {
  const value = staticValue(raw);
  if (typeof value !== "string") return [...fallback];
  const parts = value.trim().split(/\s+/).filter(Boolean).map(Number);
  if (!parts.length || !parts.every(Number.isFinite)) return [...fallback];
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

const moduleName = (entry: unknown): unknown =>
  entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as { name?: unknown }).name : undefined;

/**
 * 系统色（`FUN_1401c45f0`，粒子解析 `FUN_1401c5490` 在 `0x1401c5963` 调用，rea-p4b-render.md 7.1）。从粒子 JSON **原文**算，
 * 不从模块字段反推（`colorrandom` 的字段已经乘过 1/255，乘回去会多一层舍入）：
 * ```
 * color = (1, 1, 1); hascolor = false
 * for init in initializers（按顺序，不提前退出，后者覆盖前者）:
 *     colorrandom: color = ((max − min)·0.5 + min) · 0.003921569   // min / max 是 0–255，缺省 "0 0 0" / "255 255 255"
 *     （命中 hascolor = true）
 * if 一个都没命中: 找第一个 operator colorchange: color = startvalue（缺省 "1 1 1"，不 ÷255），hascolor = true
 * 系统色 = sprintf("%.5f %.5f %.5f", color) 读回
 * ```
 * `hsvcolorrandom`、`colorlist` 也算颜色模块（置 `hascolor`），但这两个模块本身报不支持，系统色不跟着它们算。
 * `0x200000 = sceneVersion < 5 || !hascolor`（7.4）。
 */
export function particleColorSystem(json: JsonObject, sceneVersion: number): ParticleColorSystem {
  let color = [1, 1, 1];
  let hasColor = false;
  for (const entry of particleModuleEntries(json, "initializer") ?? []) {
    const name = moduleName(entry);
    if (name === "colorrandom") {
      const source = entry as Record<string, unknown>;
      const min = rawVec3(source.min, [0, 0, 0]).map(f32);
      const max = rawVec3(source.max, [255, 255, 255]).map(f32);
      color = min.map((low, i) => f32(f32(f32(f32(max[i] - low) * 0.5) + low) * INV_255));
      hasColor = true;
    } else if (name === "hsvcolorrandom" || name === "colorlist") hasColor = true;
  }
  if (!hasColor) {
    const change = (particleModuleEntries(json, "operator") ?? []).find((entry) => moduleName(entry) === "colorchange");
    if (change) {
      color = rawVec3((change as Record<string, unknown>).startvalue, [1, 1, 1]).map(f32);
      hasColor = true;
    }
  }
  return {
    rgb: [roundTrip5(color[0]), roundTrip5(color[1]), roundTrip5(color[2])],
    instanceColor: sceneVersion < 5 || !hasColor,
  };
}

export interface ParseParticleOptions {
  file: string;
  orthographic: boolean;
  /** 对象上的 `instanceoverride`。 */
  instanceoverride?: unknown;
  /** 标量键与 `colorn` 的取值方式；缺省只取静态值（见 `InstanceResolver`）。 */
  resolveInstance?: InstanceResolver;
  /** 场景 `version`（`sceneVersionOf` 取过的值）；缺省 0，同 WPE 缺键。决定 `0x200000`（`particleColorSystem`）。 */
  sceneVersion?: number;
}

/** 解析一个粒子 JSON（能力检查另由 `checkParticleFeatures` 做）。`passes` 由 `compileScene` 编材质后填。 */
export function parseParticle(json: JsonObject, options: ParseParticleOptions): SceneParticle {
  const modules = (category: ParticleCategory): ParticleModule[] =>
    (particleModuleEntries(json, category) ?? []).map((entry) => {
      const { name, id, fields } = readParticleModule(category, entry, options.orthographic);
      return { name, id, fields };
    });
  const renderers = modules("renderer");
  const emitters = modules("emitter");
  const initializers = modules("initializer");
  return {
    file: options.file,
    ...readParticleSystem(json),
    spriteSheet: false,
    emitters,
    initializers,
    operators: modules("operator"),
    renderers,
    renderer: particleRenderer(renderers, emitters, initializers),
    orthographic: options.orthographic,
    controlpoints: readControlPoints(json),
    instance: parseParticleInstance(options.instanceoverride, options.resolveInstance),
    colorSystem: particleColorSystem(json, options.sceneVersion ?? 0),
    passes: [],
    children: [],
  };
}
