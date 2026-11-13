/**
 * 粒子系统（P4a 步骤 3）：纯 TS、不碰 GPU 的模拟器，照 WPE 的形状写（定长 float32 列、共用 `R`、operator 按 JSON 顺序、
 * 每遍开头重置 size / rgb / a）。依据：
 * - 帧内顺序 O1、积分与两遍 T4、模块顺序 O2：`p4-particles-REPORT.md`「框架结论」，`rea-framework.md` Q1、Q3；
 * - 发射、initializer、operator 的公式：`rea-p4a.md` B（执行函数在模块表上，`modules.ts`）；
 * - 预热 C1（**固定一遍**、步长按 float32 累加）、`instanceoverride` C5（`dt' = dt·rate`）：`rea-p4a.md` 开头的修正。
 *
 * 一帧（`step`）：
 * 1. 全部槽 `age += dt'`；`life ≠ 0 且 life < age`（严格大于）判死：`life = 0`，存活数减一；
 * 2. 序列帧（P4b 步骤 2，`sequenceFrames`）：帧表系统且不是 `randomframe` 时，全部槽 `frame = (1 / life)·age·sequencemultiplier`；
 * 3. 控制点更新一次（P4c 步骤 1，`ControlPointSet.update`，O1 第 5 步 `0x1402376fe`）：两遍模式也只一次；
 * 4. 按 JSON 顺序遍历 emitter：算本帧数量（周期发射的时长在这里从流 A 抽，`rea-p4b-modules.md` A3），逐个新粒子线性扫描
 *    第一个 `life == 0` 的槽 → emitter 写位置速度 → 抽 `R` → 写缺省值 → 按 JSON 顺序跑 initializer；新粒子当帧 `age = 0`；
 * 5. operator 一遍或两遍：每遍开头重置当前值，再按 JSON 顺序执行；
 * 6. 控制点 `previous ← current`（`0x140237798`）。
 * 噪声类模块（P4b 步骤 4）另读场景时间 `T`（`step` 的 `time`，一帧内不变，预热时为 0）。
 *
 * `instanceoverride.colorn`（P4b 步骤 6，`colorn.ts`）：重乘字段之后从基值重算颜色模块的平移与新粒子的颜色初值（`applyColorn`）；
 * HDR 下的 `brightness`（P4f 步骤 2）在同一处乘到颜色初值上（`instanceBrightness`）。
 *
 * 生命周期（步骤 5）：`instanceoverride` 运行时改值走 `setInstance`（从基值重新乘，存活粒子不动；只写了 `rate` 时走 `setRate`，只改
 * 步进率，P4f 步骤 1）；不可见的帧走
 * `suspend`（不发射，有存活粒子就清空并复位 emitter 计时，重新可见时不重新预热；控制点照常更新、拷 `previous`，P4d 步骤 5）；
 * 暂停时渲染器不步进。
 *
 * 控制点（P4c 步骤 1、2）是系统的一份状态（`controlpoints.ts`）：建系统时按 JSON 的 `offset` 与静态 `instanceoverride` 定基准，
 * 每帧按对象世界矩阵 `W` 与指针的跟随点（`step` / `prewarm` 的 `inputs`，渲染器按父链与壁纸样式算）更新，模块经执行上下文读。
 * 同一个 `W` 也是模拟时的模型矩阵 `M`（执行上下文的 `model`，`movement` 的 `flags` bit0 用）。
 * 世界空间（系统 `flags` bit0，P4c 步骤 4，rea-p4c-sim.md 第 5 节）只是坐标系的切换：控制点是 `W·base`，出生点经控制点的 3×3
 * 进世界坐标（`origin` 不经 `W`），之后对象移动、旋转，已发出的粒子留在原地；绘制时模型矩阵是单位阵（渲染器负责）。
 * 表外模块（`skipped`）不执行：场景已因 `particle:<类别>:<名字>` 退回预览图。
 *
 * 子系统（P4e 步骤 1，rea-p4e-children）：一个粒子对象是一棵系统树，子系统的状态归父系统所有。本步只有 `static`（`statics`，条目顺序；
 * 事件类条目由能力表报，不建）：
 * - 建立（3.1）：父系统构造时一起建（深度 < `MAX_CHILD_DEPTH`），和父共用同一个 `ParticleRandom`（WPE 全场一个 MT19937，7.3；我们不复刻
 *   流，共用只让「一个对象一个随机源」的种子规则不变）。实例值是对象的 `instanceoverride`（按子系统自己的 `flags` bit3–7 决定乘哪些，
 *   3.4），控制点覆盖到不了子系统（3.4，实测 `st-iocp`）。
 * - 预热（3.1、3.5）：`prewarm` 先深度优先预热全部 static 子孙（各按**自己的** `starttime`），再做本系统的控制点初始化与预热；父的
 *   预热循环不步进子系统。预热的模型矩阵：本地子系统 `父 M · L`，世界子系统 `L`（实测 `st-wwarm`）。
 * - 每帧（3.2，`FUN_1402308a0`）：父模拟 → 写顶点（采样拖尾）→ 按条目顺序：条目 `flags` bit0 时父粒子写子系统控制点（第 5 节，
 *   `writeParentPoints`），子系统用父的 `dt′`（不再乘自己的 `rate`）与父的 `emit` 递归步进，模型矩阵是 `父 M · L`（本地、世界子系统
 *   都一样，3.3）。父存活数为 0 照样更新子系统。
 * - 周期复位（3.7）：父的周期发射进入新周期时，条目 `flags` bit1（值 2）的 static 子系统复位计时并重开发射器（`restart`），不清粒子。
 * - 不可见（3.6）：顶层有存活粒子时，复位与清空递归到 static 子孙；之后整棵子树照常以 `emit = false` 步进（`suspend`）。
 * 子系统的 remap `layertime`、`layerorigin` 读对象的（和根共用 `obj`，3.1）。
 *
 * 事件子系统（P4e 步骤 2、3，rea-p4e-children 第 4 节，实测见报告「P4e 语义的实测核对」的事件子系统表）：每个事件条目一个实例池
 * （`events`，4.1），实例是一棵完整的系统子树（同 static 子系统的构造），多一个对象矩阵 `X`（`instanceMatrix`，4.5）。三种事件类型共用
 * 池、回收与绘制，只差什么时候取实例、`X` 用哪个位置、之后跟不跟。一帧里（7.3）：
 * - 判死之后（4.2，`0x140237129`–`0x1402376f6`，`handleDeaths`）：逐死粒子（升序），先让跟着它的 eventfollow 实例停跟随（`followSlot = −1`，
 *   `X` 冻结），自己与 static 子孙的发射器全部标结束（`endEmitters`），已有粒子照常活完；再逐 eventdeath 条目抽 `uA`、建实例，`X` 用死粒子
 *   上一帧末的位置（判死只清寿命）。上限是本帧开头各 eventdeath 条目剩余量之和 `cap`，循环里只判 `cap == 0`，多个条目时会失守（照 WPE）；
 * - 发射之后（4.3，`0x14023ae9a`–`0x14023b28c`，`spawnInstances`）：eventfollow 与 eventspawn 逐条目、逐本帧新粒子抽 `uA`（满了整条目
 *   不抽），`uA ≤ probability` 才从池里取实例（`takeInstance`，4.7：空闲表尾部复用或新建），`X` 用新粒子 operator 之前的位置，按实例自己的
 *   `starttime` 预热；
 * - static 子系统之后（4.6）：按条目、按建立先后步进活跃实例（只有 eventfollow 先用父粒子本帧 operator 之后的位置重算 `X`，eventspawn /
 *   eventdeath 的 `X` 只在建立时写一次、父粒子死了也不停），步进后不活跃（`isActive`，`FUN_14022c310`）的移进空闲表。本帧新建的实例当帧
 *   就步进一次完整的 `dt′`。
 * 预热期间（`sys+0x41` 清零，4.8）不记新粒子、不为事件收集死亡，所以不建 eventfollow / eventspawn 实例；但父系统带 rope renderer 时判死
 * 照样收集死亡（rope 表要用），eventdeath 实例照建，预热期间不步进它们。不可见时（`emit = false`）判死与 eventdeath 照常；顶层有存活
 * 粒子时顶层与 static 子孙的活跃实例销毁、空闲表保留（3.6）。
 *
 * `rope`（P4d 步骤 1，rea-p4d-rope.md 第 2 节）：renderer 是 rope 的系统另维护 rope 表（`ropeOrder`，存槽号、表序就是出生序）
 * 和累计死亡数（`deaths`，`sys+0x350`，只给 `uvscrolling` 用）：出生时追加，每帧判死后保序删除当帧的死亡槽、死亡数累加（删除在
 * 发射之前），`clear` 时一起清零。两遍模式只影响 operator，预热照常维护（2.4）。段顶点见 `rope.ts`。
 *
 * `ropetrail`（P4d 步骤 2，rea-p4d-rope.md 第 5 节）：renderer 是 ropetrail 的系统另有历史（`trail`，`ropetrail.ts` 的
 * `TrailHistory`）：出生时在全部 initializer 之后写满出生位置（`born`），预热结束后塌缩到当前位置（`afterPrewarm`，预热不采样），
 * 每帧模拟之后按计时器采样（`sample`，和模拟同一个 `dt'`）。`clear` 不碰计时器，也不清历史（出生时覆盖）。
 *
 * 模块的运行状态（P4d 步骤 3，rea-p4d-modules.md 1.3）：模块表有 `createState` 的 initializer（`mapsequence*` 的序号与步长）每个
 * 系统一份，`run` 时传入；系统复位（`suspend`）时 `resetState`，周期发射进入新周期时 `newPeriod`（早于该 emitter 本帧的新粒子），
 * `setInstance` 重乘字段后 `instanceState`。`clear` 不碰它们（WPE 的清空不动记录）。
 *
 * 系统时间与图层时间（P4d 步骤 4a，rea-p4d-modules.md 2.2、5.3，remap 的输入 `particlesystemtime`（init）与 `layertime` 读）：`step` 在
 * 模拟之前各自 `+= dt′`（float32，乘过 `rate`），`suspend` 在有存活粒子时一起清零；系统时间在不可见的帧上（复位之后）照常累加，预热不
 * 累加（P4d 收尾 A 实测 st-hide、st-pre）。模拟时的
 * 对象原点 `W.t`（remap 的 `layerorigin`）和模型矩阵一起由 `advance` 按 `inputs.world` 写进执行上下文。
 *
 * 冻结（P4f 步骤 1，rea-p4f-script.md 5.4）：`rate` 单写时不钳制（`setRate`），`rate ≤ 0` 时 `dt′ ≤ 0`，整棵树不模拟（不增龄、不判死、
 * 不发射、不移动、控制点不更新），存活粒子照画。两个时间照样 `+= dt′`（0 不变，负数倒退），拖尾采样与子系统的遍历照常（只是子孙同样
 * 冻结），读码见 `step` / `stepNode`。
 *
 * 音频（P4e 步骤 4，rea-p4e-audio.md，`audio.ts`）：执行上下文的 `audio` 是这一帧的 16 段频谱，整棵树共用一个只读引用（`setAudio`，
 * 渲染器在步进之前写好值）；读音频的模块在 `audioprocessingmode ≠ 0` 时取系数。发射器与 initializer 一帧只走一次，operator 两遍模式下
 * 每遍各取一次（值相同）。
 *
 * 脚本接口（P4f 步骤 3，rea-p4f-script.md 第 2–5 节，实测见 p4-particles-REPORT「P4f 语义的实测核对」）：图层代理上的 `IParticleSystem`
 * 落到根系统的 `scriptPause` / `scriptPlay` / `scriptStop` / `scriptIsPlaying` / `emitParticles`（只在根上调）。脚本在本帧粒子步进之后、
 * 写顶点之前跑（P4c 步骤 4 的帧序），这几个方法都当场生效：
 * - 暂停位（`sys+0x3f7` bit0）整棵树共用（子孙与新建、复用的事件实例读根的，`scriptPaused`）：模拟里的发射整段不跑（计时冻结、不建
 *   eventfollow / eventspawn），模拟、判死、eventdeath 照常；
 * - `stop` 另记「被 stop 停下」：之后置脏重算不重开发射器，只有 `play()` 能解（已定 6，不复刻 WPE）；自然结束后 `play()` 复位计时再重开
 *   （已定 5，不复刻 WPE）；
 * - 脚本发出的粒子（`scriptBorn`）与脚本阶段新建的事件实例（`createdByScript`）本帧不画（WPE 在写完顶点之后才跑脚本，4.4）：写顶点、
 *   轨迹快照与绘制先序都跳过，下一次步进开头清掉标记，届时它们先增龄 `dt′` 再画；建实例用对象的 `W`（已定 7，不复刻 WPE 的单位阵）。
 * 实例覆盖的控制点（`controlpointN` / `controlpointangleN`）的运行时写入在 `setInstance` 里（`ControlPointSet.applyOverrides`，5.5）。
 */
import {
  INSTANCE_RATE_MIN,
  instanceOverrideSet,
  instanceValues,
  MAX_CHILD_DEPTH,
  type ParticleInstanceValues,
  type SceneParticle,
  type SceneParticleChild,
} from "../compile/particles";
import { identity, invert, multiply, translation, type Mat4 } from "../render/math";
import { TIME_WRAP_SECONDS } from "../sceneTime";
import { SILENT_PARTICLE_AUDIO, type ParticleAudio } from "./audio";
import { colornState, instanceBrightness, type Rgb } from "./colorn";
import { ParticleColumns } from "./columns";
import {
  controlPointCount,
  ControlPointSet,
  IDENTITY_BASIS,
  NO_INSTANCE_OVERRIDE,
  type ControlPointInputs,
} from "./controlpoints";
import { emissionCount, emitterState, resetEmitterTiming, scriptEmitCount, type EmitterState } from "./emitters";
import { f32 } from "./f32";
import {
  INSTANCE_DISABLE_FLAGS,
  particleModuleDef,
  resolveParticleFields,
  type InstanceMultipliers,
  type InstanceScale,
  type ParticleCategory,
  type ParticleFields,
  type ParticleModule,
  type ParticleModuleDef,
  type ParticleModuleRun,
  type ParticleRunContext,
} from "./modules";
import type { ParticleRandom, ParticleROverride } from "./random";
import { RopeOrder } from "./rope";
import { TrailHistory } from "./ropetrail";

/** 没给控制点输入时用：对象世界矩阵按单位阵、指针的跟随点按 (0, 0)（单测；渲染器与 `particleTrack` 都显式传）。 */
const IDENTITY_INPUTS: ControlPointInputs = { world: identity(), pointer: [0, 0] };

/** 预热步长：`maxcount < 500` 时 0.05，否则 0.2（C1，实测两档都对上）。 */
export function prewarmStep(maxcount: number): number {
  return maxcount < 500 ? f32(0.05) : f32(0.2);
}

/** 预热的步数：`while (t < starttime) t += 步长`，float32 累加（`starttime 2.5`、步长 0.05 是 51 步，不是 `ceil` 的 50）。 */
export function prewarmSteps(starttime: number, maxcount: number): number {
  const step = prewarmStep(maxcount);
  const end = f32(starttime);
  let steps = 0;
  for (let t = 0; t < end; t = f32(t + step)) steps++;
  return steps;
}

const DRAG_REFERENCE = f32(0.025);
const DRAG_EXPONENT = f32(0.7);

/**
 * drag 系数 `k0 = pow(min(1, 0.025 / frameDt), 0.7)·dt'`（`FUN_140236cd0`，实测核对过）。`frameDt` 是当帧未乘 `rate` 的
 * `g_Frametime`；预热时它是 0，`min(1, ∞) = 1`，`k0 = dt'`。
 */
export function dragK0(dt: number, frameDt: number): number {
  const ratio = Math.min(1, f32(DRAG_REFERENCE / frameDt));
  return f32(f32(Math.pow(ratio, DRAG_EXPONENT)) * dt);
}

/**
 * operator 遍数：WPE 设置 `fps` 在 1–20 时两遍，否则一遍（T4，`dec eax; cmp eax, 0x13; ja`，无符号比较，`fps = 0` 是一遍）。
 * Kabegame 对应宿主帧上限 `maxFps`（缺省 60，一遍）。
 */
export function particlePasses(fps: number): 1 | 2 {
  return fps >= 1 && fps <= 20 ? 2 : 1;
}

/** 一遍 operator 的步长与 drag 系数：两遍模式时 `h = dt'/2`、`k = k0/2`，否则 `h = dt'`、`k = k0`（T4）。 */
export function operatorPass(dt: number, frameDt: number, passes: 1 | 2): { h: number; k: number } {
  const k0 = dragK0(dt, frameDt);
  return passes === 2 ? { h: f32(dt * 0.5), k: f32(k0 * 0.5) } : { h: dt, k: k0 };
}

/**
 * 各项 `instanceoverride` 的乘数；系统 `flags` 的对应位禁用时为 1（C3）。`rate` 没有禁用位，取实例值原样（湍流类的 `timescale`
 * 乘它）：钳制不在这里，WPE 在重算之前先把 `io.rate` 钳到 0.01 并写回（`FUN_140230650` `0x1402307c7`–`0x1402307f1`，再调
 * `FUN_14022bd40`，rea-p4f-script.md 5.2），`FUN_1401d15a0` 读的是写回后的值，所以 `setInstance` 与加载（构造）先钳实例值、再算乘数。
 * 新建子系统（事件实例，`FUN_14022f890`）读对象当时的 `io.rate`，可能是 `setRate` 单写的、没钳过的值（5.4），这里同样原样乘。
 */
export function instanceMultipliers(
  instance: Pick<ParticleInstanceValues, InstanceScale>,
  flags: number,
): InstanceMultipliers {
  const pick = (key: InstanceScale) => (flags & INSTANCE_DISABLE_FLAGS[key] ? 1 : instance[key]);
  return {
    size: pick("size"),
    speed: pick("speed"),
    count: pick("count"),
    lifetime: pick("lifetime"),
    rate: instance.rate,
  };
}

interface ResolvedModule {
  name: string;
  def: ParticleModuleDef;
  /** 解析后的基值（没乘 `instanceoverride`）：改值时从这里重新乘。 */
  base: ParticleFields;
  /** 模拟用的字段（已乘、已舍入）。 */
  fields: ParticleFields;
  run: ParticleModuleRun;
  /**
   * 模块的运行状态（P4d 步骤 3）：模块表有 `createState` 的才有（`mapsequence*` 的序号与步长），按建系统时的字段建一份，
   * 传给 `run`；其余为 undefined。
   */
  state: unknown;
}
interface ResolvedEmitter extends ResolvedModule {
  /** emitter 的状态是发射计时（`emitters.ts`），模块表的 emitter 都没有 `createState`。 */
  state: EmitterState;
}

/**
 * 列标志：系统里全部表内模块的 `columnFlags`，加上按字段算的 `columnFlagsOf`（P4c 步骤 3，`controlpointattract` 的 `flags` bit0
 * 开上一步位置列），按位或。`module.fields` 是解析值（没乘 `instanceoverride`）；按字段算的只看 `flags`，不受覆盖影响。
 */
export function particleColumnFlags(def: Pick<SceneParticle, "emitters" | "initializers" | "operators">): number {
  let flags = 0;
  const add = (category: ParticleCategory, modules: readonly ParticleModule[]) => {
    for (const module of modules) {
      const known = particleModuleDef(category, module.name);
      if (known) flags |= known.columnFlags | (known.columnFlagsOf?.(module.fields) ?? 0);
    }
  };
  add("emitter", def.emitters);
  add("initializer", def.initializers);
  add("operator", def.operators);
  return flags;
}

/** 一帧里整棵系统树共用的量（`step` / `suspend` 算好，`stepNode` 逐层往下传，rea-p4e-children 3.2）。 */
interface TreeFrame {
  /** `dt′`：根的帧时间乘根的 `instanceoverride.rate`，子孙共用，不再乘自己的 `rate`（3.2、3.4）。 */
  dt: number;
  /** 当帧未乘 `rate` 的 `g_Frametime`（drag 系数用）。 */
  frameDt: number;
  /** 场景时间 `T`（float32）。 */
  time: number;
  /** 图层时间（`obj+0x770`，对象的，根上那一份）：remap 的 `layertime`。 */
  layerTime: number;
  /** 对象世界矩阵 `W`：remap 的 `layerorigin`（对象的，和系统的模拟矩阵无关）。 */
  object: Mat4;
  /** 对象可见（`FUN_1402308a0` 的 `emit`）：不可见时整棵树不发射（3.2、3.6）。 */
  emit: boolean;
}

/**
 * 这一帧的环境（P4e 步骤 2、3，4.7）：场景时间、图层时间与对象世界矩阵。`advance` 建事件实例时交给实例的预热；父系统自己预热时同样带着
 * 预热用的那一份（预热循环里可能建 eventdeath 实例，4.8）。
 */
interface PrewarmEnv {
  /** 场景时间 `T`：加载时 0（rea-p4b-modules B2 末条）；运行中建实例时是这一帧的（`ctx+0x130` 是全场的场景时间；P4e 收尾 A 实测
   *  p4e-close：取 0 的变体超限 9514 倍，rea-p4e-children.md 4.7）。 */
  time: number;
  /** 图层时间（remap 的 `layertime`，`obj+0x770`）：加载时 0，运行中是这一帧的（【推】，测试工程不读它）。 */
  layerTime: number;
  /** 对象世界矩阵 `W`（remap 的 `layerorigin`）。 */
  object: Mat4;
}

/**
 * 一个事件条目的实例池（rea-p4e-children 4.1，条目表 `sys+0x498` 的一项：`+0x08` 活跃表、`+0x20` 空闲表）。池只增不减；不可见时活跃
 * 实例被销毁、空闲表保留（3.6）。
 */
export interface ParticleEventPool {
  /** 条目在父的 `def.children` 里的下标（模板路径按它走，实例不计序号）。 */
  index: number;
  entry: SceneParticleChild;
  /** 条目的局部矩阵 `L`（`entry.local` 的 float32 形态）。 */
  local: Mat4;
  /** 活跃实例，建立先后（步进与绘制都按它，4.6、第 6 节）；条目 `maxcount` 是它的上限（4.1）。 */
  readonly active: ParticleSystem[];
  /** 空闲实例：回收时追加，取用时从尾部拿（后进先出，4.7）。 */
  readonly free: ParticleSystem[];
}

/** 一个 static 子系统（rea-p4e-children 2 节的 `sys+0x480` 表项）。 */
export interface ParticleChildSystem {
  /** 条目在父的 `def.children` 里的下标（`ParticleSystem.node` 的路径按它走）。 */
  index: number;
  entry: SceneParticleChild;
  /** 条目的局部矩阵 `L`（`entry.local` 的 float32 形态）。 */
  local: Mat4;
  system: ParticleSystem;
}

/**
 * 条目 `flags` bit0：父系统的存活粒子按槽号写进子系统控制点的平移（`FUN_14022a580`，rea-p4e-children 第 5 节【确】，实测 `st-cpw`、
 * `ef-cpw`）。在子系统步进之前调，`top` 是父的模拟矩阵 `M`（栈顶）：
 * ```
 * X = parW ? (childW ? I : inverse(top)) : (childW ? top : I)
 * j = controlpointstartindex
 * for i in 0 .. 父高水位 − 1:
 *     if j ≥ 8: break
 *     if 父 life[i] == 0: continue                    // 空槽不占控制点
 *     if 子 cp[j].flags & 0x10005: continue           // 指针 / 父控制点 / remap 点：这个粒子被跳过，j 不变
 *     子 cp[j].current.t = ((X00·px + X10·py) + (X20·pz + X30), …)   // 只写平移，3×3 与 previous 不动
 *     j += 1
 * ```
 * 写的是**父的全部存活粒子**的前几个，不补偿 `L`（本地子系统里这些点和父粒子的实际位置差一个 `L`）。条目 bit0 时子系统的控制点个数
 * 强制为 8（1.5），所以下标不越界；`controlpointstartindex` 为负时 WPE 从负下标写（越界，【推】），能力表报
 * `particle:child:controlpointstartindex`，这里跳过负下标、照样往后数。
 */
export function writeParentPoints(
  parent: ParticleSystem,
  entry: Pick<SceneParticleChild, "flags" | "controlPointStartIndex">,
  child: ParticleSystem,
  top: Mat4,
): void {
  if (!(entry.flags & 1)) return;
  const childWorld = (child.def.flags & 1) !== 0;
  const parentWorld = (parent.def.flags & 1) !== 0;
  let matrix: Mat4 | null = null;
  if (parentWorld && !childWorld) matrix = invert(top) ?? new Float32Array(16).fill(Number.NaN);
  else if (!parentWorld && childWorld) matrix = top;
  const { life, position } = parent.columns;
  const points = child.controlPoints;
  let j = entry.controlPointStartIndex;
  for (let i = 0; i < parent.highWater; i++) {
    if (j >= 8 || j >= points.count) break;
    if (life[i] === 0) continue;
    if (j < 0) {
      j++;
      continue;
    }
    if (points.pointFlags(j) & NO_INSTANCE_OVERRIDE) continue;
    const px = position[0][i];
    const py = position[1][i];
    const pz = position[2][i];
    const t = points.current(j).translation;
    if (!matrix) t.set([px, py, pz]);
    else
      for (let k = 0; k < 3; k++)
        t[k] = f32(f32(f32(matrix[k] * px) + f32(matrix[4 + k] * py)) + f32(f32(matrix[8 + k] * pz) + matrix[12 + k]));
    j++;
  }
}

/**
 * 系统树里一个模板的定义：`node` 是从根起每层的 `children` 下标（顶层 `[]`）。事件条目下的路径同样适用（实例不计序号，P4e 步骤 2 的
 * 模板路径）。
 */
export function particleNode(root: SceneParticle, node: readonly number[]): SceneParticle {
  let current = root;
  for (const index of node) current = current.children[index].system;
  return current;
}

/** NaN 的 4×4：`invert` 失败（`W` 奇异）时用，同 WPE 乘 `1/det = inf`，画不出来。 */
function nanMatrix(): Mat4 {
  return new Float32Array(16).fill(Number.NaN);
}

/**
 * `forEachDrawn` 的回调：系统、模板路径（每层 `def.children` 下标，事件实例不计序号）、这次绘制的模型矩阵。返回 `false` 时不再递归
 * 这个系统的子孙（渲染器用它跳过基础材质为空的子树，第 6 节）。
 */
export type ParticleDrawnCallback = (
  system: ParticleSystem,
  template: readonly number[],
  model: Mat4,
) => boolean | void;

export class ParticleSystem {
  readonly def: SceneParticle;
  readonly columns: ParticleColumns;
  readonly passes: 1 | 2;
  /** 槽号上界（只增不减，循环上界）。 */
  highWater = 0;
  /** 存活数。 */
  alive = 0;
  /** 没有执行函数、模拟器跳过的模块（`<类别>:<名字>`）。 */
  readonly skipped: string[] = [];
  /** 控制点（P4c 步骤 1）。 */
  readonly controlPoints: ControlPointSet;
  /** rope 表（P4d 步骤 1，`sys+0x218`）：renderer 是 rope 的系统才有，其余为 null。 */
  readonly ropeOrder: RopeOrder | null;
  /** 累计死亡数（`sys+0x350`，rope `uvscrolling` 的 `TP0`）：rope 系统才累加，`clear` 时清零。 */
  deaths = 0;
  /**
   * 当帧判死的槽号（升序，`ageAndKill` 收集，`sys+0x420`），复用同一个数组。rope 系统（删 rope 表，预热期间也收集）与有 eventfollow /
   * eventdeath 条目的系统（停跟随、建 eventdeath 实例，P4e 步骤 2、3；`sys+0x41 & 0x14`，预热期间不收集）才收集（rea-p4e-children 4.2、4.8）。
   */
  private readonly dead: number[] = [];
  /**
   * 本帧新粒子的槽号（`sys+0x408`，出生先后，P4e 步骤 2）：有 eventfollow / eventspawn 条目、不在预热时（`sys+0x41 & 0xc`）才记，建完实例
   * 清空（4.3）。
   */
  private readonly born: number[] = [];
  /** 有 eventfollow 或 eventdeath 条目（`sys+0x41 & 0x14`）：判死时收集死亡槽号（4.2）。 */
  private readonly watchesDeaths: boolean;
  /** 有 eventfollow 或 eventspawn 条目（`sys+0x41 & 0xc`）：发射时记新粒子（4.3）。 */
  private readonly watchesBirths: boolean;
  /** 这一次发射要不要记新粒子（`emit` 开头按「不在预热且 `watchesBirths`」定）。 */
  private recordBirths = false;
  /**
   * ropetrail 的历史与计时器（P4d 步骤 2，`sys+0x230`…`0x24c`）：renderer 是 ropetrail 的系统才有，其余为 null。间隔取
   * `def.renderer.ropetrail.interval`。
   */
  readonly trail: TrailHistory | null;
  /**
   * 系统时间 `St`（`sys+0x3f0`，P4d 步骤 4a）：每帧模拟之前 `+= dt′`（`FUN_1402308a0` 开头 `0x1402308c2`，float32），系统复位
   * （`FUN_14022f6c0`，`suspend`）清零；不可见的帧上 `suspend` 照样累加，预热不累加（P4d 收尾 A 实测）。`remapinitialvalue` 的
   * `particlesystemtime` 读它（经执行上下文）。
   */
  systemTime = 0;
  /**
   * 图层时间（`obj+0x770`，P4d 步骤 4a）：可见时每帧 `+= dt′`（`FUN_140230650` 的 `0x140230810`，早于系统的模拟），不可见且有存活粒子
   * 时清零。WPE 存在对象上，Kabegame 一个粒子对象一个系统，所以放在这里。remap 的 `layertime` 读它。
   */
  layerTime = 0;
  /** 父系统（rea-p4e-children 2 节的 `sys+0x10`）；顶层为 null。控制点父分支、父粒子写控制点读它。 */
  readonly parent: ParticleSystem | null;
  /** 本系统在父系统里的条目（子系统才有）。 */
  readonly entry: SceneParticleChild | null;
  /** 嵌套深度（`sys+0x3f8`，顶层 0，1.6）：< `MAX_CHILD_DEPTH` 才建子系统。 */
  readonly depth: number;
  /** static 子系统（3.1，`sys+0x480`），条目顺序。 */
  readonly statics: ParticleChildSystem[] = [];
  /**
   * 事件条目的实例池（P4e 步骤 2、3，4.1，`sys+0x498`），条目顺序；`eventfollow` / `eventspawn` / `eventdeath` 各建一个池。深度到
   * `MAX_CHILD_DEPTH` 的系统和 static 子系统一样不建（1.6）。
   */
  readonly events: ParticleEventPool[] = [];
  /** 本系统作为子系统时条目的局部矩阵 `L`（`sys+0x360`，`entry.local` 的 float32 形态）；顶层为 null。 */
  readonly localMatrix: Mat4 | null;
  /**
   * 事件实例的对象矩阵 `X`（`sys+0x3a0`，4.5，`FUN_14022a360` 写）：建立与复用时写一次，eventfollow 跟随期间每帧重算（eventspawn /
   * eventdeath 不重算）。static 子系统与顶层为 null（它们的 `X` 是 `L` / `W`）。
   */
  instanceMatrix: Mat4 | null = null;
  /**
   * 事件实例对应的父粒子槽号（`sys+0x478`，构造为 −1，`0x1402296f6`）：建实例时写，三种类型都写（4.2、4.3：eventspawn 是新粒子、eventdeath
   * 是死粒子；目前没有读者，留给 `inheritinitialvaluefromevent`，7.2）；只有 eventfollow 的父粒子死亡时改回 −1（停跟随，4.6 末段）。
   * static 子系统与顶层恒为 −1。
   */
  followSlot = -1;
  /**
   * 本帧脚本阶段出生的粒子（P4f 步骤 3，`emitParticles`，rea-p4f-script.md 4.4）：按槽号置 1，没有过时为 null。WPE 在写完顶点之后才跑
   * 脚本，这些粒子下一帧才画，所以写顶点（`writeVertices`、rope / ropetrail 的段）与轨迹快照（`particleSnapshot`）跳过它们；下一次
   * `step` / `suspend` 开头清掉，届时它们先增龄 `dt′` 再画。只有根会有（脚本只发顶层）。
   */
  scriptBorn: Uint8Array | null = null;
  /** `scriptBorn` 里置位的个数（rope 表尾部就是这么多个，`writeRopeSegments` 按它截掉）。 */
  scriptBornCount = 0;
  /**
   * 脚本阶段新建（或从池里复用）的事件实例（P4f 步骤 3，4.4、4.5）：本帧不画（`forEachDrawn` 连同子孙跳过），下一帧它第一次步进时
   * （`stepNode` 开头）清掉。WPE 的实例要到下一帧子系统更新才第一次步进，我们同样（实例建在步进之后）。
   */
  createdByScript = false;

  private readonly random: ParticleRandom;
  private readonly emitters: ResolvedEmitter[];
  private readonly initializers: ResolvedModule[];
  private readonly operators: ResolvedModule[];
  /** 当前的 `instanceoverride` 标量与 `colorn`（起始值 = `def.instance`，`setInstance` 改）。 */
  private instance: ParticleInstanceValues;
  /** 新粒子的 `a0`（`instanceoverride.alpha`，WPE 的 `sys+0x3ec`，不乘 HDR 下的 `brightness`）。 */
  private alpha0 = 1;
  /**
   * 新粒子的 rgb 初值（WPE 的 `sys+0x3e0..0x3e8`）：`colornState` 的 `instanceColor` 逐通道乘 HDR 下的 `brightness`
   * （`instanceBrightness`，P4f 步骤 2），颜色 initializer 乘在它上面。
   */
  private instanceColor: Rgb = [1, 1, 1];
  /**
   * `colorn` 生效位（`sys+0x3f7` bit1，rea-p4e-children 2 节、3.4）：顶层是自己的生效判断；子系统建立时从父拷、每帧被父的覆盖，所以
   * 整棵树都是顶层的值。子系统的 `colorn` 生效另要父的这一位（`applyColorn`）。
   */
  private colornGate = false;
  /**
   * 步进率（`dt′ = frameDt·rate`，float32，只有顶层的起作用：子孙共享根的 `dt′`）。重算（`setInstance`）与加载时是钳过的
   * `instanceoverride.rate`（≥ 0.01）；`setRate` 单写时不钳制，可以是 0 或负数（整棵树冻结，rea-p4f-script.md 5.4）。
   */
  private rate = 1;
  /** 下一次找空槽的起点：它之前没有空槽。 */
  private searchFrom = 0;
  /** `step` 没给场景时间时用的时钟：收到的帧时间之和（秒，double，按 432000 回绕）。 */
  private elapsed = 0;
  private readonly context: ParticleRunContext;
  /** 出生时 `R` 的替换（dev 探针按出生顺序注入 WPE 的值，`random.ts` 的 `injectedR`）；缺省照常用抽到的值。 */
  private readonly rOverride: ParticleROverride | undefined;
  /**
   * 脚本暂停位（P4f 步骤 3，`sys+0x3f7` bit0，rea-p4f-script.md 2.1）：只有根上的起作用，整棵树读根的（`scriptPaused`；WPE 的子孙每帧
   * 从父拷、新建与复用的实例建立时拷，结果相同）。
   */
  private pausedByScript = false;
  /**
   * 被脚本 `stop()` 停下（P4f 步骤 3，已定 6）：这之后置脏重算（`setInstance`）不重开已结束的发射器，只有 `play()` 真正重开时才清掉。
   * 只有根上的起作用。WPE 的重算会重开 `stop` 过的发射器（2.5、5.3，实测 `b-stop-write`），是 bug，不复刻。
   */
  private stoppedByScript = false;
  /** 正在为脚本发射（`emitParticles`）：`spawn` 据此记 `scriptBorn`。 */
  private spawningByScript = false;
  /**
   * 根上次步进（`step` / `suspend` / `prewarm`）用的对象世界矩阵（WPE 的 `sys+0x3a0`，每帧对象更新时写）：置脏重算写控制点覆盖时压栈的
   * `M` 由它推出（`overrideMatrix`）。
   */
  private lastWorld: Mat4 = identity();

  /**
   * `link` 只给子系统（父系统构造时自己建，P4e 步骤 1）：父与条目。子系统的 `instanceoverride` 取对象的当前值（3.4：`FUN_14022f890`
   * 用同一个对象的 `obj+0x778`），即根系统上的那一份（`setRate` 只改根的，P4f 步骤 1），不看子系统定义里的 `instance`（编译期给的是
   * 缺省值）；`rOverride` 只给顶层。
   * 顶层（加载）先把 `rate` 钳到 0.01（`FUN_14022af30` `0x14022b840`–`0x14022b86f`，rea-p4f-script.md 6.1）；子系统照搬对象的值、
   * 不再钳（`FUN_14022f890` 直接读 `io`）。
   */
  constructor(
    def: SceneParticle,
    random: ParticleRandom,
    passes: 1 | 2,
    rOverride?: ParticleROverride,
    link?: { parent: ParticleSystem; entry: SceneParticleChild },
  ) {
    this.def = def;
    this.random = random;
    this.passes = passes;
    this.rOverride = rOverride;
    this.parent = link?.parent ?? null;
    this.entry = link?.entry ?? null;
    this.depth = link ? link.parent.depth + 1 : 0;
    this.localMatrix = link ? new Float32Array(link.entry.local) : null;
    // 事件类型位集（`def+0x29` → `sys+0x41`，1.1）：深度到上限的系统不读 `children`，也就没有事件条目
    const kinds = new Set(this.depth < MAX_CHILD_DEPTH ? (def.children ?? []).map((child) => child.type) : []);
    this.watchesDeaths = kinds.has("eventfollow") || kinds.has("eventdeath");
    this.watchesBirths = kinds.has("eventfollow") || kinds.has("eventspawn");
    this.columns = new ParticleColumns(def.maxcount, particleColumnFlags(def));
    // WPE 在 rope 的段缓冲（`sys+0x208`）存在时才维护表（2.2、2.3），即 renderer 是 rope
    this.ropeOrder = def.renderer?.kind === "rope" ? new RopeOrder(this.columns.capacity) : null;
    // WPE 在 ropetrail 的 `sys+0x248`（segments）非零时分配历史（rea-p4d-rope.md 3.5），即 renderer 是 ropetrail
    const ropetrail = def.renderer?.ropetrail;
    this.trail = ropetrail ? new TrailHistory(this.columns.capacity, ropetrail.segments, ropetrail.scrolling) : null;
    let root = link?.parent ?? null;
    while (root?.parent) root = root.parent;
    this.instance = instanceValues(root ? root.instance : def.instance);
    if (!root) this.instance.rate = Math.max(INSTANCE_RATE_MIN, this.instance.rate);
    // 从基值乘，不累乘（C5）；颜色模块的字段乘完再按 `colorn` 平移（`applyColorn`）。`brightness` 不乘模块字段，只在 HDR 下乘新粒子
    // 的颜色初值（`applyColorn`，P4f 步骤 2）
    const multipliers = instanceMultipliers(this.instance, def.flags);
    const resolve = (category: ParticleCategory, modules: readonly ParticleModule[]): ResolvedModule[] =>
      modules.flatMap((module) => {
        const known = particleModuleDef(category, module.name);
        if (!known?.run) {
          this.skipped.push(`${category}:${module.name}`);
          return [];
        }
        const fields = resolveParticleFields(known, module.fields, multipliers);
        const state = known.createState?.(fields);
        return [{ name: module.name, def: known, base: module.fields, fields, run: known.run, state }];
      });
    this.emitters = resolve("emitter", def.emitters).map((emitter) => ({
      ...emitter,
      state: emitterState(emitter.fields),
    }));
    this.initializers = resolve("initializer", def.initializers);
    this.operators = resolve("operator", def.operators);
    this.applyScalars();
    this.applyColorn();
    // 子系统（P4e 步骤 1）：控制点接上父系统；条目 `flags` bit0 时个数强制 8、`i ≥ (u8)startindex` 的点由父粒子写（1.5）
    const writes = link && link.entry.flags & 1 ? link.entry.controlPointStartIndex & 0xff : undefined;
    this.controlPoints = link
      ? new ControlPointSet(def, writes !== undefined ? 8 : controlPointCount(def), {
          parent: { points: link.parent.controlPoints, world: (link.parent.def.flags & 1) !== 0 },
          parentWrites: writes,
        })
      : new ControlPointSet(def);
    this.context = {
      columns: this.columns,
      random,
      slot: 0,
      count: 0,
      h: 0,
      k: 0,
      time: 0,
      controlPoints: this.controlPoints,
      world: (def.flags & 1) !== 0,
      basis: IDENTITY_BASIS,
      // 每帧由 `advance` 按 `inputs.world` 写（本系统独占一份，不和别的系统共用）
      model: new Float32Array(IDENTITY_BASIS),
      // P4d 步骤 4a：`step` 写两个时间，`advance` 写原点
      systemTime: 0,
      layerTime: 0,
      origin: new Float32Array(3),
      // P4e 步骤 4：子系统与事件实例沿用父的频谱（整棵树一份），顶层缺省全 0，渲染器建树时换成场景的那份（`setAudio`）
      audio: link ? link.parent.audio : SILENT_PARTICLE_AUDIO,
    };
    // 子系统（3.1，`FUN_14022ebe0`）：深度 < 10 才建，条目顺序；类型 0（不认识的）编译期已丢掉。static 当场建；事件类建空的实例池
    // （P4e 步骤 2，`0x14022ef43` 起的 `E.type in (2, 3, 4)` 分支），实例在父粒子出生 / 死亡时才建
    if (this.depth < MAX_CHILD_DEPTH)
      (def.children ?? []).forEach((entry, index) => {
        const local = new Float32Array(entry.local);
        if (entry.type !== "static") {
          this.events.push({ index, entry, local, active: [], free: [] });
          return;
        }
        this.statics.push({
          index,
          entry,
          local,
          system: new ParticleSystem(entry.system, random, passes, undefined, { parent: this, entry }),
        });
      });
  }

  /** 这棵树读的 16 段频谱（P4e 步骤 4，`audio.ts`）。 */
  get audio(): ParticleAudio {
    return this.context.audio!;
  }

  /**
   * 换上这棵树读的频谱（P4e 步骤 4，rea-p4e-audio.md 3.5、第 5 节）：频谱是场景的一份状态，一帧里各系统、各遍读到的值相同，所以整棵树
   * （static 子孙、各池的活跃与空闲实例）共用同一个只读引用，之后新建的实例从父上取（构造时）。渲染器建树时、预热之前调，回放与 dev
   * 探针给自己的数组。只换引用，不拷值。
   */
  setAudio(audio: ParticleAudio): void {
    this.context.audio = audio;
    for (const child of this.statics) child.system.setAudio(audio);
    for (const pool of this.events) for (const instance of [...pool.active, ...pool.free]) instance.setAudio(audio);
  }

  /** 有子系统（static 或事件条目）：不可见时也要每帧步进子孙（3.6），渲染器据此每帧重写顶点。 */
  get hasChildren(): boolean {
    return this.statics.length > 0 || this.events.length > 0;
  }

  /** 系统树里的一个节点（`node` 是每层 `def.children` 的下标，顶层 `[]`）；路径不是 static 子系统时为 null。 */
  node(path: readonly number[]): ParticleSystem | null {
    let current: ParticleSystem = this;
    for (const index of path) {
      const child = current.statics.find((item) => item.index === index);
      if (!child) return null;
      current = child.system;
    }
    return current;
  }

  /**
   * 按绘制先序（`FUN_1402366f0`，rea-p4e-children 第 6 节【确】，实测 `f-*`、`st-order`）列出本系统与全部子孙，同时给出每个系统的模板
   * 路径与绘制模型矩阵。渲染器、轨迹与回放共用。本系统当顶层看（`object` 是对象世界矩阵 `W`，缺省单位阵，只要路径的调用方不必给）：
   * ```
   * 顺序：自己 → static 子系统（条目顺序，各自递归）→ 事件条目（条目顺序）的活跃实例（建立先后，各自递归）
   * 顶层：    model = 世界 ? I : W；画完栈顶是 W（世界系统画完恢复成 X = W，0x140236ae9）
   * static：  model = 世界 ? I : top · L；栈顶 = 世界 ? L : model      // 世界子系统画完把栈顶恢复成 X = L
   * 实例：    model = 世界 ? I : top · X；栈顶 = 世界 ? X : model      // X 见 4.5
   * ```
   * 所以世界 static 子系统的本地孙辈绘制时是 `L·L₂`，模拟时却是 `W·L·L₂`（3.3「两处不一致」，照复刻）。只有 static 时和 P4e 步骤 1 的
   * `particleDrawModel` 逐字节相同（同一串 `multiply`）。模板路径是每层 `def.children` 下标（实例不计序号），同一模板可能出现多次。
   * 回调返回 `false` 时不递归这个系统的子孙。脚本阶段新建的事件实例（`createdByScript`，P4f 步骤 3）本帧不画，连同子孙跳过。
   */
  forEachDrawn(callback: ParticleDrawnCallback, object: Mat4 = identity()): void {
    this.visitDrawn(callback, this.def.flags & 1 ? identity() : object, object, []);
  }

  private visitDrawn(callback: ParticleDrawnCallback, model: Mat4, top: Mat4, template: readonly number[]): void {
    if (callback(this, template, model) === false) return;
    for (const child of this.statics) {
      const world = (child.system.def.flags & 1) !== 0;
      const childModel = world ? identity() : multiply(top, child.local);
      child.system.visitDrawn(callback, childModel, world ? child.local : childModel, [...template, child.index]);
    }
    for (const pool of this.events)
      for (const instance of pool.active) {
        if (instance.createdByScript) continue;
        const x = instance.instanceMatrix!;
        const world = (instance.def.flags & 1) !== 0;
        const childModel = world ? identity() : multiply(top, x);
        instance.visitDrawn(callback, childModel, world ? x : childModel, [...template, pool.index]);
      }
  }

  /**
   * 本系统这次绘制的模型矩阵与画完后的栈顶（第 6 节）：沿父链自底向上，和 `forEachDrawn` 自顶向下是同一串运算，结果逐字节相同。`object`
   * 是对象世界矩阵 `W`。渲染器在就地刷新 uniform（对象变换、相机、视差变了）时用它，不必遍历整棵树。
   */
  drawTransform(object: Mat4): { model: Mat4; top: Mat4 } {
    const world = (this.def.flags & 1) !== 0;
    const parent = this.parent;
    if (!parent) return { model: world ? identity() : object, top: object };
    const x = this.instanceMatrix ?? this.localMatrix!;
    const model = world ? identity() : multiply(parent.drawTransform(object).top, x);
    return { model, top: world ? x : model };
  }

  /**
   * 活跃判定（`FUN_14022c310`，rea-p4e-children 4.6【确】）：任一 static 子系统活跃、任一事件实例活跃、还有没结束的发射器（`sys+0x3f4 > 0`）、
   * 存活数 > 0，有一条就活跃。只有连续 `rate`、没有 `duration` 的发射器永远不结束（周期发射器同样），这样的实例永不回收。
   */
  isActive(): boolean {
    if (this.alive > 0) return true;
    if (this.emitters.some((emitter) => !emitter.state.ended)) return true;
    if (this.statics.some((child) => child.system.isActive())) return true;
    return this.events.some((pool) => pool.active.some((instance) => instance.isActive()));
  }

  /** 当前的 `instanceoverride` 标量与 `colorn`（一份拷贝）。 */
  get instanceValues(): ParticleInstanceValues {
    return instanceValues(this.instance);
  }

  /**
   * 当前的一项 `instanceoverride` 标量原值（不看系统 flags 的禁用位）：rope 的 `R`、`L` 乘 `count`、`lifetime`
   * （rea-p4d-rope.md 1.2，`io+0xd0`、`io+0xd8`），每帧写段顶点时读，不拷贝。`rate` 是重算与加载时钳过的值（`setRate` 单写之后是
   * 原值），`GpuScene.sync` 读它写回状态（P4f 步骤 1，rea-p4f-script.md 5.2）。
   */
  instanceScalar(field: "count" | "lifetime" | "rate"): number {
    return this.instance[field];
  }

  /**
   * `instanceoverride` 运行时改值（C5「运行时改值」，`FUN_140230650` 脏时调 `FUN_14022bd40(sys, 1)`）：从基值重新乘、不累乘，
   * 不清粒子、不改容量（`count` 只乘 emitter 的 `rate` 与 `maxtoemitperperiod`）。
   * - 存活粒子保留出生时写进列的 life、颜色、尺寸、`a0`；`size`、`lifetime`、`alpha`、发射速度与 `velocityrandom` 等只影响之后出生的。
   * - 每帧现算的参数下一帧就用新值：`rate`（dt' = dt·rate，下限 0.01）、`count`（发射数量）、`speed` 乘的 operator 字段
   *   （重力、角力、振荡频率，存活粒子也用）。
   * - `rate` 先钳到 0.01 并写回实例值（P4f 步骤 1，rea-p4f-script.md 5.2：WPE 置脏后 `0x1402307c7`–`0x1402307f1` 先
   *   `io.rate = max(0.01, io.rate)`，再调 `FUN_14022bd40`），之后的乘数（湍流类 `timescale`）与步进率都用钳过的值；调用方读
   *   `instanceScalar("rate")` 写回状态。子孙收到的已是钳过的值，再钳一次不变（WPE 只钳一次，`io` 是共用的）。
   * - 系统 `flags` bit4–7 禁用的项照旧不乘（C3）。`brightness` 不影响模拟。
   * - `colorn`（P4b 步骤 6）：颜色模块的平移与新粒子的颜色初值从基值重算（`applyColorn`）。`colorrandom` 是出生时的
   *   initializer，只影响之后出生的粒子；`colorchange` 每帧读字段，存活粒子下一帧就跟着变（rea-p4b-render.md 7.3【推】）。
   * - `brightness`（P4f 步骤 2，rea-p4f-script.md 第 7 节）：HDR 且本系统没有 bit3 时，颜色初值从基值重算后再乘它，只影响之后出生的
   *   粒子（初值只在出生时写进颜色列），已有粒子的颜色不动。子孙在下面的递归里各按自己的 `flags & 8` 重算。
   * - 已结束、新 `rate > 0` 的 emitter 重新打开（`param_2 = 1` 的尾段，`0x14022c1f0` 起）；累积余数等计时保留。被脚本 `stop()` 停下的
   *   树（`stoppedByScript`，P4f 步骤 3，已定 6）不重开：`stop` 的结束只由 `play()` 解除，WPE 这里会重开（rea-p4f-script.md 2.5），不复刻。
   * - 有运行状态的模块（P4d 步骤 3）按登记的覆盖条目改状态（`instanceState`）：`mapsequencebetweencontrolpoints` 在 `flags & 0x10`
   *   时 `step` 重写成正的新值（条目 4），序号不动；`mapsequencearoundcontrolpoint` 不登记，不动。
   * - 控制点覆盖（P4f 步骤 3，rea-p4f-script.md 5.5）：对象当前的 `controlpointN` / `controlpointangleN` 每次重算都重写进本系统控制点的
   *   `base`（`ControlPointSet.applyOverrides`，跳过 `0x10005` 的点），递归里同样写进 static 子孙与池里的事件实例（子系统加载时不带，
   *   第一次重算才到，rea-p4e-children 3.4）。一项都没设时不碰控制点。
   * `reopen` 是 `FUN_14022bd40` 的 `p2`：顶层与 static 子系统为真；事件实例（活跃与空闲的都递归，P4e 步骤 2，3.4 `0x14022c1d0`–
   * `0x14022c26d`）传 `p2 = 0`，已结束的发射器不重开，它的 static 子孙同样。
   */
  setInstance(values: Partial<ParticleInstanceValues>, reopen = true): void {
    this.instance = { ...this.instance, ...values };
    this.instance.rate = Math.max(INSTANCE_RATE_MIN, this.instance.rate);
    const multipliers = instanceMultipliers(this.instance, this.def.flags);
    for (const module of [...this.emitters, ...this.initializers, ...this.operators])
      module.fields = resolveParticleFields(module.def, module.base, multipliers);
    for (const module of this.initializers)
      if (module.state !== undefined) module.def.instanceState?.(module.state, module.fields, this.def.flags);
    this.applyScalars();
    this.applyColorn();
    const { controlpoints, controlpointAngles } = this.instance;
    if (controlpoints.some(instanceOverrideSet) || controlpointAngles.some(instanceOverrideSet))
      this.controlPoints.applyOverrides(this.instance, this.overrideMatrix());
    if (reopen && !this.root.stoppedByScript)
      for (const emitter of this.emitters)
        if (emitter.state.ended && (emitter.fields.rate as number) > 0) emitter.state.ended = false;
    // 递归到 static 子系统（P4e 步骤 1，3.4：`FUN_14022bd40` 传原 `p2`，所以已结束的发射器同样重开）：子系统按自己的 `flags` 重乘；
    // `rate` 照样记下，但子系统步进用父的 `dt′`、不乘它（3.2）
    for (const child of this.statics) child.system.setInstance(this.instance, reopen);
    // 事件实例（P4e 步骤 2）：活跃与空闲的都递归，`p2 = 0`
    for (const pool of this.events)
      for (const instance of [...pool.active, ...pool.free]) instance.setInstance(this.instance, false);
  }

  /**
   * 只改步进率（P4f 步骤 1，rea-p4f-script.md 5.4【确】：`rate` 没有改值回调，写了不置脏，不触发 `FUN_14022bd40`）：下一次 `step` 的
   * `dt′ = frameDt·rate`（`0x1402307ff` 每帧读 `io.rate`，不看脏位）。
   * - 不钳制：钳到 0.01 只发生在重算里（`setInstance`）。`rate ≤ 0` 时整棵树冻结，见 `step`（实测 `b-rate0`）。
   * - 不重乘模块字段：湍流类（`turbulence`、`turbulentvelocityrandom`）的 `timescale` 仍是上一次重算时的值，要等别的系数被写、
   *   `setInstance` 重算时才跟上【确：路径】【推：画面】。
   * - 不递归：子系统与事件实例共享根的 `dt′`（rea-p4e-children 3.2）。实例值只改根上这一份（WPE 的 `io`），之后新建的子系统从根上取
   *   （构造，`FUN_14022f890` 读 `io`）；static 子孙与已有实例的实例值等下一次 `setInstance` 递归时才跟上，它们的 `rate` 只在重算乘数时用。
   * - 不重开已结束的发射器（重开在 `FUN_14022bd40` 尾部，单写 `rate` 不调它，5.3）。
   * 只对顶层有意义（`GpuScene.sync` 只交给根）。
   */
  setRate(rate: number): void {
    this.instance.rate = rate;
    this.rate = f32(rate);
  }

  /** 树根（顶层系统）：暂停位、「被 stop 停下」与上次的对象世界矩阵都存在它上面。 */
  private get root(): ParticleSystem {
    let node: ParticleSystem = this;
    while (node.parent) node = node.parent;
    return node;
  }

  /** 这棵树的脚本暂停位（读根的，P4f 步骤 3）。 */
  get scriptPaused(): boolean {
    return this.root.pausedByScript;
  }

  /** 这棵树被脚本 `stop()` 停下、还没被 `play()` 重开（读根的，P4f 步骤 3）。 */
  get scriptStopped(): boolean {
    return this.root.stoppedByScript;
  }

  /**
   * 置脏重算写控制点覆盖时压栈的 `M`（`FUN_14022bd40` 开头的 `FUN_140229760(sys)`，rea-p4c-sim.md 第 2 节）：根是上一次步进的对象世界
   * 矩阵（`sys+0x3a0`，`lastWorld`）；static 子系统 `世界 ? L : 父 M · L`，事件实例 `世界 ? X : 父 M · X`（同 `simulationMatrix`）。
   * 世界 static 子系统在这里是 `L`，模拟时却是 `W·L`（`FUN_140229810` 不看世界位，3.3），照 WPE 的两个函数各用各的；只有冻结的帧看得出。
   */
  private overrideMatrix(): Mat4 {
    const parent = this.parent;
    if (!parent) return this.lastWorld;
    const x = this.instanceMatrix ?? this.localMatrix!;
    return this.def.flags & 1 ? x : multiply(parent.overrideMatrix(), x);
  }

  /**
   * 脚本 `pause()`（`0x14024c670`，rea-p4f-script.md 2.1【确】，实测 `a-pause`、`b-pause-dur`）：只置暂停位，整棵树的模拟里发射整段不跑
   * （`emit`）：不发射，`delay` / `duration` / 周期计时 / 余数冻结，eventspawn / eventfollow 不建；模拟、判死、eventdeath 照常，已有粒子
   * 继续运动、死亡。暂停期间建出的事件实例同样带着暂停位（预热也发不出粒子）。只在根上调。
   */
  scriptPause(): void {
    this.pausedByScript = true;
  }

  /**
   * 脚本 `play()`（`0x14024c5b0`，2.2【确】，已定 5）：清暂停位；整棵树还活跃（`isActive`）时只做这一件（同 WPE、同 `d.ts`「If the
   * particle has stopped」）。整棵树都不活跃时复位发射计时（同 `stop` 用的 `FUN_14022f6c0`：`delay` / `duration` / `instantaneous` / 周期
   * 计时与余数回初值、系统时间清零、mapsequence 序号归零，递归 static）、清全部结束位并重开（递归 static，`FUN_14022f5b0`），不预热，
   * 并解除「被 stop 停下」。
   * 和 WPE 不同（已定 5，读码 2.5、实测 `b-end-play`）：WPE 只清结束位、不复位计时，`duration` 型发射器停在 −1 不再发，`isPlaying()`
   * 却恒真；我们复位后重新发射（`instantaneous` 再爆发一次）。`stop` → `play` 时两边都从头来，只是 WPE 的 `delay` / `duration` 在停止期间
   * 照样倒数（发射器已结束，帧尾照走），系统时间也照样累加，我们在这里又复位了一次【推：停止期间不为 0 的 `delay` / `duration` 与
   * `particlesystemtime` 和 WPE 不同，实测的工程都是 0】。只在根上调。
   */
  scriptPlay(): void {
    this.pausedByScript = false;
    if (this.isActive()) return;
    this.restart();
    this.stoppedByScript = false;
  }

  /**
   * 脚本 `stop()`（`0x14024c680`，2.3【确】，实测 `a-stop`、`a-tree`）：全部发射器标结束（递归 static，`FUN_14022f640`）、图层时间清零、
   * 系统复位（`FUN_14022f6c0`：计时回初值、系统时间清零、mapsequence 序号归零，递归 static）、清全部粒子（含 static 子孙，`FUN_14022fd90`
   * 同时销毁子孙的活跃事件实例）、销毁本系统的活跃事件实例（空闲池保留）。不清暂停位。另记「被 stop 停下」（已定 6：之后的置脏重算不
   * 重开发射器，只有 `play()` 能解）。只在根上调；存活数变成 0，本帧就不画了（同 WPE）。
   */
  scriptStop(): void {
    this.stoppedByScript = true;
    this.endEmitters();
    this.layerTime = 0;
    this.context.layerTime = 0;
    this.resetTiming();
    this.clear();
    for (const child of this.statics) child.system.clearTree();
    this.destroyInstances();
  }

  /**
   * 脚本 `isPlaying()`（`0x14024ca10`，第 3 节【确】，实测 `a-pause`、`a-done`）：没暂停 且 整棵树活跃（`isActive`：有存活粒子、有没结束
   * 的发射器、任一 static 子孙或活跃事件实例活跃）。所以暂停时即使还有粒子也是 false。
   */
  scriptIsPlaying(): boolean {
    return !this.pausedByScript && this.isActive();
  }

  /**
   * 脚本 `emitParticles(count)`（`0x14024cac0`，第 4 节【确】，实测见报告的 `a-emit*`、`b-args`、`b-debt`、`b-emit-alpha`）。只在根上调，
   * 在脚本阶段当场发：
   * - 数量：`scriptEmitCount`（int32 整数原样、0 当 1、负数不发；缺参数与非整数实测都是 1）；
   * - 每条发射器（JSON 顺序）各发 n 个（不乘 `instanceoverride.count`、和 `rate` 无关），每条现算 `容量 − 存活`，满了丢弃；越过暂停位、
   *   结束位（含 `stop` 之后）、`delay > 0` 与对象不可见；门内的发射器连同待发的 `instantaneous` 记欠账（`acc −= pending + n`），门外的
   *   不动计时（`emissionCount` 的 `script`，4.3）。周期发射器在门内照常走（`P` 恰为 0 时开新周期，`newPeriod` 与 static 子系统复位同常规）；
   * - 新粒子照常跑 initializer（出生 `age = 0`），控制点读本帧模拟算好的 `current`；同一段脚本里先写的 `instance` 系数对这批不生效
   *   （脏位下一帧才消费，实测 `b-emit-alpha`）；
   * - 照常触发 eventspawn / eventfollow（4.5），建实例的 `top` 用 `inputs.world`（对象的 `W`，已定 7：WPE 这里是单位阵，父或子是世界空间时
   *   偏一个 `W`，不复刻）。实例在下一帧子系统更新时第一次步进；
   * - 新粒子记进 `scriptBorn`、新实例置 `createdByScript`：本帧不画，下一帧先增龄 `dt′` 再画（4.4）。
   * `inputs` 是这一帧给根系统的控制点输入（渲染器缓存 `stepParticles` 用的那份）：只取 `world` 作执行上下文的模型矩阵与原点、建实例的
   * `top`，以及实例预热的指针，不重新更新控制点。场景时间、图层时间取本系统最近一次步进的。
   */
  emitParticles(count: unknown, inputs: ControlPointInputs = IDENTITY_INPUTS): void {
    const n = scriptEmitCount(count);
    if (n <= 0) return;
    const context = this.context;
    const w = inputs.world;
    context.model.set([w[0], w[1], w[2], w[4], w[5], w[6], w[8], w[9], w[10]]);
    context.origin!.set([w[12], w[13], w[14]]);
    const before = this.events.map((pool) => pool.active.length);
    this.spawningByScript = true;
    try {
      this.emit(0, this.watchesBirths, n);
    } finally {
      this.spawningByScript = false;
    }
    if (this.born.length) this.spawnInstances(inputs, { time: context.time, layerTime: this.layerTime, object: w });
    // 这次新建（或复用）的实例追加在各池的活跃表尾部
    this.events.forEach((pool, i) => {
      for (let k = before[i]; k < pool.active.length; k++) pool.active[k].createdByScript = true;
    });
  }

  /**
   * 重编译、单图层重建换上新系统树时沿用旧树的脚本控制状态（P4f 步骤 3【推】：WPE 没有重建，状态一直在）：旧树被 `stop()` 停下的，新树
   * 照样 `scriptStop()`（清掉预热出来的粒子、全部发射器标结束）；暂停位照抄。新树的粒子与计时本来就从头来（重建的既有语义）。只在根上调。
   */
  adoptScriptControl(previous: ParticleSystem): void {
    if (previous.stoppedByScript) this.scriptStop();
    this.pausedByScript = previous.pausedByScript;
  }

  /** 清掉 `scriptBorn`（下一次步进开头、清空粒子时）。 */
  private clearScriptBorn(): void {
    if (!this.scriptBornCount) return;
    this.scriptBorn!.fill(0);
    this.scriptBornCount = 0;
  }

  /**
   * 从基值重算颜色模块的字段和新粒子颜色（rea-p4b-render.md 7.3、7.4）。重乘字段之后调，平移的输入是 `module.base`，
   * 所以不会在上一次的结果上累加；不生效时写回基值（float32）。
   * - 新粒子颜色初值（`FUN_1401d15a0` 开头，rea-p4f-script.md 第 7 节）：`colornState` 的 `instanceColor`（`colorn` 或 1）逐通道乘
   *   `k = instanceBrightness(def, brightness)`（HDR 且本系统没有 bit3 时是 `brightness`，否则 1），float32、不钳制；alpha 初值不乘
   *   （`applyScalars`）。子系统、事件实例的 `def.hdr` 由编译期写、`brightness` 是对象上的值，`flags & 8` 各看自己的。
   * - 0xb `colorrandom`：`min' = shift(min)`、`max' = shift(max)`，两端各自平移后再插值（`colorRandom` 每次按 `max − min` 算区间）。
   * - 0xc `colorchange`：写回 start = `A'`、Δ = `B' − A'`；`colorChange` 每帧按 `f32(end − start)` 算 Δ，和 WPE 的 `subss`
   *   相同，所以换两端即可（7.4）。
   */
  private applyColorn(): void {
    // 子系统另要父的生效位（3.4），生效位本身整棵树都是顶层的值（`colornGate`）
    const parent = this.parent;
    const state = colornState(this.def, this.instance.colorn, parent ? parent.colornGate : true);
    this.colornGate = parent ? parent.colornGate : state.active;
    // k 乘在 colorn 之后（`mulss`，colorn 在前），逐通道 float32；k = 1 时与不乘逐位相同
    const k = instanceBrightness(this.def, this.instance.brightness);
    const [r, g, b] = state.instanceColor;
    this.instanceColor = [f32(r * k), f32(g * k), f32(b * k)];
    for (const module of this.initializers)
      if (module.name === "colorrandom")
        module.fields = {
          ...module.fields,
          min: state.shift(module.base.min as number[]),
          max: state.shift(module.base.max as number[]),
        };
    for (const module of this.operators)
      if (module.name === "colorchange")
        module.fields = {
          ...module.fields,
          startvalue: state.shift(module.base.startvalue as number[]),
          endvalue: state.shift(module.base.endvalue as number[]),
        };
  }

  /**
   * 不乘字段、由模拟器自己用的两项：新粒子的 `a0` 与步进率 `rate`。`rate` 不在这里钳：调用方（构造的顶层、`setInstance`）已经钳过
   * 实例值（rea-p4f-script.md 5.2、6.1），子系统照搬对象的值（它的步进率不用）。
   */
  private applyScalars(): void {
    this.alpha0 = f32(this.instance.alpha);
    this.rate = f32(this.instance.rate);
  }

  /**
   * 不可见的一帧（C8，`FUN_140230650` 的不可见分支）：不发射、不步进；还有存活粒子就清空全部粒子，并复位每个 emitter 的计时
   * （`resetEmitterTiming`，`FUN_14022f6c0`）。返回这次有没有清空。重新可见后照常 `step`，**不重新预热**。
   * 控制点照常更新（rea-p4c-sim.md 5.6、rea-p4d-modules.md 5.3，P4d 步骤 5）：每个不可见的帧按当帧的 `inputs`（`W` 与跟随点，渲染器照
   * 可见时的算法算）`update`，再 `previous ← current`，没有粒子时也做。这样重新可见的第一帧，读 `previous` 的 maintaindistance* 看到的
   * `current − previous` 只是一帧的位移，不会把粒子一次拽过整段隐藏期间的位移（实测 p4d-dist2 的 hide-r）。
   * 同一处（`FUN_14022f6c0`）还复位有运行状态的模块（P4d 步骤 3，`resetState`）：`mapsequence*` 无条件 `seq = 0`、`step` 的符号不
   * 复位（rea-p4d-modules.md 1.3、5.3），并清零系统时间 `sys+0x3f0`；`FUN_140230650` 同时清零图层时间 `obj+0x770`（P4d 步骤 4a）。
   * 系统时间不看可见性（P4d 收尾 A 实测 p4d-close 的 st-hide，两种 fps 都对上；rea-p4d-modules.md 5.3 原是【推】）：不可见的每一帧在
   * 复位（有存活粒子时）之后照常 `+= dt′`（`frameDt` 乘 `instanceoverride.rate`，同 `step`），所以重新可见后新粒子读到的 St 从隐藏的第一
   * 帧算起、含那一帧的 dt′；「不累加」与「先累加再复位」都超限。图层时间只在可见时累加，这里不动。其余照旧：不发射、不模拟（步骤 5
   * 实测不可见期间不发射）。`inputs` 缺省（单位阵、(0, 0)）、`frameDt` 缺省 0 只给单测用。
   *
   * 子系统（P4e 步骤 1，rea-p4e-children 3.6，`FUN_140230650` `0x14023068e`–`0x1402307b8`）：只在顶层有存活粒子时，复位（`resetTiming`，
   * `FUN_14022f6c0` 递归 static 子孙）与清粒子（`clearTree`，`FUN_14022fd90`）都递归到 static 子孙；不清发射器结束位。之后整棵子树照常
   * 以 `emit = false` 步进（`stepStatics`，WPE 的 `FUN_1402308a0(sys, dt′, 0)`），顶层存活数为 0 时不复位，子系统里还活着的粒子照常
   * 模拟到死。顶层自己保持上面的现状（它这时没有存活粒子，模拟与否结果相同）。`time` 是这一帧的场景时间（子系统的噪声类模块用），
   * 不给时用本系统收到的帧时间之和（同 `step`）。返回值仍只表示顶层清没清空；有子系统时子系统每帧都可能变，渲染器另看 `hasChildren`。
   *
   * 事件实例（P4e 步骤 2，3.6 第 3、4 步）：顶层有存活粒子时，顶层与 static 子孙各池的活跃实例**销毁**（丢掉，不进空闲表），空闲表不动；
   * 之后照常以 `emit = false` 步进剩下的子孙（`stepChildren`）。顶层存活数为 0 时不销毁，停了跟随的实例照常模拟到回收。子孙以
   * `emit = false` 步进时判死与 eventdeath 照常（P4e 步骤 3，`advance`），新建的实例同样不发射。
   *
   * 冻结（P4f 步骤 1，`rate ≤ 0`，`setRate`）：复位照做（`0x14023068e` 只看可见与存活数，不看 `dt′`）；`dt′ ≤ 0` 时顶层的控制点不更新
   * （WPE 的控制点更新在被跳过的模拟里），系统时间照样 `+= dt′`，子孙同样冻结（`stepNode`）。
   */
  suspend(inputs: ControlPointInputs = IDENTITY_INPUTS, frameDt = 0, time?: number): boolean {
    // 上一帧脚本发出的粒子从这一帧起照常（P4f 步骤 3）；对象矩阵不看可见性每帧写（`sys+0x3a0`）
    this.clearScriptBorn();
    this.lastWorld = inputs.world;
    // 本帧的 `dt′`（`0x1402307ff`，不可见时同样乘 `rate`，不钳制，rea-p4f-script.md 5.4）
    const dt = f32(f32(frameDt) * this.rate);
    // 控制点在模拟函数里更新（`FUN_140236cd0`），`FUN_1402308a0` 在 `dt′ ≤ 0` 时整段跳过它（`0x1402308dc`–`0x1402308eb`，P4f 步骤 1）：
    // 冻结的帧不更新、不拷 `previous`。`frameDt` 缺省 0 是单测的写法（不关心帧时间），这时只看 `rate`
    if (frameDt > 0 ? dt > 0 : this.rate > 0) {
      this.controlPoints.update(inputs);
      this.controlPoints.endFrame();
    }
    const cleared = this.alive !== 0;
    if (cleared) {
      // 计时复位递归到 static 子孙（3.6 第 1 步），系统时间一起清零
      this.resetTiming();
      this.layerTime = 0;
      this.context.layerTime = 0;
      this.clear();
      // 3.6 第 3 步：static 子孙清粒子、销毁它们的活跃实例（`FUN_14022fd90`）
      for (const child of this.statics) child.system.clearTree();
      // 3.6 第 4 步：销毁顶层自己的活跃实例
      this.destroyInstances();
    }
    // 系统时间（`FUN_1402308a0` 开头 `sys+0x3f0 += dt′`，不可见时照样调，冻结时同样加）：复位之后累加本帧
    this.systemTime = f32(this.systemTime + dt);
    this.context.systemTime = this.systemTime;
    if (this.hasChildren)
      this.stepChildren(
        { dt, frameDt, time: f32(time ?? this.elapsed), layerTime: this.layerTime, object: inputs.world, emit: false },
        inputs,
      );
    return cleared;
  }

  /**
   * 系统复位（`FUN_14022f6c0`，rea-p4e-children 3.6、3.7、4.7）：发射器计时从初值重抄（`resetEmitterTiming`，不清结束位）、有状态模块复位
   * （`resetState`，mapsequence 序号归零）、系统时间清零，递归 static 子孙（不碰事件实例）。不清粒子。
   */
  private resetTiming(): void {
    for (const emitter of this.emitters) resetEmitterTiming(emitter.state, emitter.fields);
    for (const module of this.initializers) if (module.state !== undefined) module.def.resetState?.(module.state);
    this.systemTime = 0;
    this.context.systemTime = 0;
    for (const child of this.statics) child.system.resetTiming();
  }

  /** 清全部粒子，递归 static 子孙，销毁各池的活跃实例（`FUN_14022fd90`，3.6 第 3 步）。 */
  private clearTree(): void {
    this.clear();
    for (const child of this.statics) child.system.clearTree();
    this.destroyInstances();
  }

  /** 销毁本系统各事件池的活跃实例（3.6：析构 + 释放，不进空闲表）；空闲表不动。 */
  private destroyInstances(): void {
    for (const pool of this.events) pool.active.length = 0;
  }

  /**
   * eventfollow 的父粒子死亡时停掉实例的发射（4.6 末段 `0x140237320`–`0x1402373bb`，`FUN_14022f640`）：`sys+0x3f4 = 0`、每个发射器标结束，
   * 递归 static 子孙；实例自己的事件实例不停。
   */
  private endEmitters(): void {
    for (const emitter of this.emitters) emitter.state.ended = true;
    for (const child of this.statics) child.system.endEmitters();
  }

  /**
   * 父的周期发射进入新周期时复位这个 static 子系统（条目 `flags` bit1，`FUN_14022f790`，3.7【确】，实测 `st-per2`）：系统复位
   * （`resetTiming`，递归 static 子孙），再清全部发射器的结束位、重新打开（递归 static 子孙，`FUN_14022f5b0`）。不清粒子。
   */
  private restart(): void {
    this.resetTiming();
    this.reopen();
  }

  private reopen(): void {
    for (const emitter of this.emitters) emitter.state.ended = false;
    for (const child of this.statics) child.system.reopen();
  }

  /**
   * 一帧。`frameDt` 是当帧的 `g_Frametime`（渲染器已钳到 `[0.0001, 0.25]`），这里乘 `instanceoverride.rate` 得 `dt'`。
   * `time` 是本帧的 `g_Time`（已加上本帧钳过的帧时间、已按 432000 回绕，P4b 步骤 4 的场景时间 `T`），舍入成 float32 给噪声类
   * 模块（WPE 的 `ctx+0x130` 是场景时间的 float 副本）；`T` **不乘** `rate`（`rate` 只缩放 `dt'` 与 `timescale`）。
   * 不给时用本系统收到的帧时间之和（double 累加、同样回绕），即从 0 起步的 `FrameClock`：渲染器、`particleTrack` 都显式传，
   * 缺省只给单测用。`inputs` 是本帧控制点更新的输入：对象世界矩阵 `W`（P4c 步骤 1，渲染器每帧按 `SceneState` 沿父链算，
   * 取的是本帧脚本运行之前的状态，P4c 步骤 4；同时是模拟用的模型矩阵，`movement` 的 `flags` bit0 用）和指针的跟随点
   * （P4c 步骤 2，场景坐标，渲染器每帧按本帧的光标反投影，用的是本帧的指针）；缺省（单位阵、(0, 0)）只给单测用。
   */
  step(frameDt: number, time?: number, inputs: ControlPointInputs = IDENTITY_INPUTS): void {
    // 上一帧脚本发出的粒子（`scriptBorn`，P4f 步骤 3）从这一帧起照常增龄、照常画
    this.clearScriptBorn();
    this.lastWorld = inputs.world;
    this.elapsed = (this.elapsed + frameDt) % TIME_WRAP_SECONDS;
    // `dt′ = dt·io.rate`（`FUN_140230650` `0x1402307ff` 的 `mulss`）：每帧都读实例覆盖里的 `rate`，不看脏位、不钳制（P4f 步骤 1，
    // rea-p4f-script.md 5.4），`setRate` 单写 0 或负数时 `dt′ ≤ 0`
    const dt = f32(f32(frameDt) * this.rate);
    // P4d 步骤 4a：图层时间（`obj+0x770`，`0x140230810`）与系统时间（`sys+0x3f0`，`0x1402308c2`，`stepNode` 里）都在模拟之前 `+= dt′`，
    // float32。图层时间是对象的，整棵树共用这一份（P4e 步骤 1）。
    // 冻结时（`dt′ ≤ 0`，P4f 步骤 1）照样加【确：读码】：`0x140230808` 只判可见（`r12b`），`0x140230810` 的 `addss` 不看 `dt′` 的正负，
    // 所以 `rate = 0` 时不变、负数时倒退（负数没有实测）
    this.layerTime = f32(this.layerTime + dt);
    this.stepNode(
      { dt, frameDt, time: f32(time ?? this.elapsed), layerTime: this.layerTime, object: inputs.world, emit: true },
      inputs,
    );
  }

  /**
   * 树里一个系统的一帧（`FUN_1402308a0`，rea-p4e-children 3.2）：系统时间 `+= dt′` → 模拟（`emit` 为假时不发射；判死后停跟随、建
   * eventdeath 实例，发射后建 eventfollow / eventspawn 实例，P4e 步骤 2、3）→ 拖尾采样（写顶点的位置）→ 子系统（`stepChildren`：static，
   * 再事件实例）。`inputs.world` 是本系统的模拟矩阵 `M`（顶层是 `W`）。
   *
   * 冻结（P4f 步骤 1，rea-p4f-script.md 5.4，`dt′ ≤ 0`）【确：读码】：
   * ```
   * 0x1402308bf  xmm0 = dt′;  0x1402308c2  xmm0 += St          // 系统时间先加，不看 dt′ 的正负
   * 0x1402308dc  comiss dt′, 0;  0x1402308e3  St = xmm0        // 存回（在判断之前）
   * 0x1402308eb  jbe 0x1402308f2                                 // dt′ ≤ 0（含 NaN）：跳过 FUN_140236cd0
   * 0x1402308ed  call FUN_140236cd0                              // 模拟：增龄判死、控制点、发射、operator（`advance`）
   * 0x1402308f2  …                                               // 写顶点、拖尾采样、子系统：不看 dt′
   * ```
   * 所以冻结时系统时间照样 `+= dt′`（0 不变、负数倒退），模拟整段跳过（`advance` 开头的 `!(dt > 0)`），拖尾照常按 `dt′` 走计时器
   * （`0x140232cb6` 的 `subss`，0 时不动、不采样），子系统与事件实例拿到同一个 `dt′`、同样冻结；父粒子写子系统控制点、eventfollow 重算 `X`、不活跃的实例回收照常做
   * （都在 `0x1402308f2` 之后）。实测 `b-rate0`（周期内没有出生）；冻结期间不移动由回放核对，负数没有实测。
   */
  private stepNode(frame: TreeFrame, inputs: ControlPointInputs): void {
    // 脚本阶段建的实例（P4f 步骤 3）第一次步进：从这一帧起照常画
    this.createdByScript = false;
    const context = this.context;
    context.time = frame.time;
    this.systemTime = f32(this.systemTime + frame.dt);
    context.layerTime = frame.layerTime;
    context.systemTime = this.systemTime;
    this.advance(frame.dt, frame.frameDt, this.passes, inputs, frame.emit, frame.object, {
      time: frame.time,
      layerTime: frame.layerTime,
      object: frame.object,
    });
    // ropetrail 的历史采样（P4d 步骤 2）：WPE 的顶点函数先模拟、再在存活数非零时采样（`FUN_1402308a0`，rea-p4d-rope.md 1.1、5.2），
    // 用同一个 `dt'`；位置是本帧模拟后的
    const trail = this.trail;
    if (trail) trail.sample(frame.dt, this.def.renderer.ropetrail!.interval, this.columns, this.highWater, this.alive);
    this.stepChildren(frame, inputs);
  }

  /** 子系统的一帧（3.2 `0x140236380` 起）：先全部 static 子系统（条目顺序），再各事件条目的活跃实例（4.6）。 */
  private stepChildren(frame: TreeFrame, inputs: ControlPointInputs): void {
    this.stepStatics(frame, inputs);
    this.stepEvents(frame, inputs);
  }

  /**
   * static 子系统的一帧（3.2，`0x140236380`–`0x140236445`），条目顺序：条目 `flags` bit0 时父的存活粒子写子系统控制点
   * （`writeParentPoints`，压子系统矩阵之前，栈顶是本系统的 `M`），再以 `M · L` 递归步进（`FUN_140229810` 不看子系统的世界位，本地、
   * 世界子系统都一样，3.3）。`Mprev`（控制点父分支）是本系统的 `M`。父存活数为 0 照样更新子系统。
   */
  private stepStatics(frame: TreeFrame, inputs: ControlPointInputs): void {
    for (const child of this.statics) {
      writeParentPoints(this, child.entry, child.system, inputs.world);
      child.system.stepNode(frame, {
        world: multiply(inputs.world, child.local),
        pointer: inputs.pointer,
        parent: inputs.world,
      });
    }
  }

  /**
   * 事件实例的一帧（4.6，`0x140236447`–`0x1402365c0`【确】），条目顺序、每条按建立先后（含本帧刚建的，它当帧就走一次完整的 `dt′`）：
   * ```
   * FUN_14022a580(sys, E, inst)                       // 条目 flags bit0：父的存活粒子写实例控制点（第 5 节，不补偿 T(p)·L）
   * if E.type == eventfollow 且 inst.followSlot ≠ −1：X = FUN_14022a360(sys, followSlot)   // 父粒子本帧 operator 之后的位置
   * push(inst)（本地 top·X、世界 X）；FUN_1402308a0(inst, dt′, emit)；pop
   * if !FUN_14022c310(inst)：移进空闲表、从活跃表删除（其余保序）
   * ```
   * 本地 eventfollow 实例的已有粒子因此跟着父粒子一起平移（粒子存实例坐标，实测 `f-base`），世界实例的留在原地（`f-cw`、`ef-world`）。
   * eventspawn / eventdeath 实例的 `followSlot` 也是父粒子槽号（4.2、4.3），但不按类型 2 的分支重算，`X` 停在建立时的值（P4e 步骤 3）。
   * `Mprev`（实例控制点的父分支）是本系统的 `M`（7.1）。
   */
  private stepEvents(frame: TreeFrame, inputs: ControlPointInputs): void {
    const top = inputs.world;
    for (const pool of this.events) {
      const { active } = pool;
      if (!active.length) continue;
      let kept = 0;
      for (const instance of active) {
        writeParentPoints(this, pool.entry, instance, top);
        if (pool.entry.type === "eventfollow" && instance.followSlot >= 0)
          instance.instanceMatrix = this.instanceMatrixFor(pool, instance.followSlot, top);
        instance.stepNode(frame, { world: instance.simulationMatrix(top), pointer: inputs.pointer, parent: top });
        if (instance.isActive()) active[kept++] = instance;
        else pool.free.push(instance);
      }
      active.length = kept;
    }
  }

  /**
   * 实例的对象矩阵 `X`（`FUN_14022a360(parent, b, inst)`，rea-p4e-children 4.5【确】，实测 `f-base`、`f-xf`、`ef-rotl`、`ef-rotw`）。
   * `p` 是本系统（父）槽 `slot` 的当前位置，`top` 是本系统的模拟矩阵（栈顶，顶层即 `W`）：
   * ```
   * 子本地 / 父本地：X = T(p)·L           模拟 M = top·X
   * 子本地 / 父世界：X = top⁻¹·T(p)·L     模拟 M = top·X（= T(p)·L，p 是世界坐标）
   * 子世界 / 父本地：X = top·T(p)·L       模拟 M = X
   * 子世界 / 父世界：X = T(p)·L           模拟 M = X
   * ```
   * 结果是实例原点落在父粒子的世界位置；父本地时还带对象 `W` 的旋转缩放（`L` 被 `W` 转），父世界时不带。乘法与求逆用 `render/math.ts`
   * （double 累加、末尾舍入），和 WPE 的 float32 逐步舍入可能差 1–2 ulp；`top` 奇异时写 NaN。
   */
  private instanceMatrixFor(pool: ParticleEventPool, slot: number, top: Mat4): Mat4 {
    const [px, py, pz] = this.columns.position;
    const placed = multiply(translation(px[slot], py[slot], pz[slot]), pool.local);
    const parentWorld = (this.def.flags & 1) !== 0;
    if (pool.entry.system.flags & 1) return parentWorld ? placed : multiply(top, placed);
    if (!parentWorld) return placed;
    const inverse = invert(top);
    return inverse ? multiply(inverse, placed) : nanMatrix();
  }

  /**
   * 事件实例的模拟矩阵 `M`（`FUN_140229760(inst)`，4.5「实例模拟时压栈」）：本地 `top·X`，世界 `X`。模拟与绘制两边一致（第 6 节）。
   * `top` 是父的模拟矩阵。
   */
  private simulationMatrix(top: Mat4): Mat4 {
    const x = this.instanceMatrix!;
    return this.def.flags & 1 ? x : multiply(top, x);
  }

  /**
   * 从池里取一个实例（4.7【确】）：空闲表非空时从尾部取（后进先出），否则新建。`slot` 是触发它的父粒子（新粒子或死粒子，`X` 读它当前
   * 位置列里的值），`top` 是本系统的模拟矩阵，`pointer` 是这一帧的跟随点，`env` 是这一帧的场景时间、图层时间与对象矩阵（实例预热用）。
   * - 新建（`0x14023744f` / `0x14023af69`）：同 static 子系统的构造（父、条目、实例覆盖按子系统自己的 flags），写 `X`，再
   *   `FUN_14022ebe0(inst)`：建孙辈并各自预热、控制点初始化、按**自己的** `starttime` 预热（`prewarmNode`，实测 `ef-start`）；
   * - 复用（`0x140237524` / `0x14023b04b`）：系统复位（`resetTiming`：系统时间 0、发射器计时、mapsequence 序号，递归 static 子孙）、重开
   *   全部发射器（递归 static 子孙），写 `X`；不重新初始化控制点（`previous` 是上次用完时的值）、不重新应用实例覆盖（池里的实例在
   *   `setInstance` 递归里照样被更新）、不清高水位与死亡数；`starttime > 0` 时只跑预热循环（`FUN_14022f430`）。复用时 static 孙辈是否
   *   再预热没读到，按「只跑实例自己的预热循环」做【推】。
   * 预热发生在父系统的模拟里（判死之后或发射之后），从同一个随机源抽。父系统自己在预热时建的（带 rope 时的 eventdeath，4.8）照样当场
   * 初始化、按自己的 `starttime` 预热，之后要到父预热结束后的第一个正常帧才步进。
   */
  private takeInstance(
    pool: ParticleEventPool,
    slot: number,
    top: Mat4,
    pointer: ControlPointInputs["pointer"],
    env: PrewarmEnv,
  ): ParticleSystem {
    const reused = pool.free.pop();
    if (reused) {
      reused.resetTiming();
      reused.reopen();
      reused.instanceMatrix = this.instanceMatrixFor(pool, slot, top);
      if (reused.def.starttime > 0)
        reused.prewarmLoop({ world: reused.simulationMatrix(top), pointer, parent: top }, env);
      return reused;
    }
    const created = new ParticleSystem(pool.entry.system, this.random, this.passes, undefined, {
      parent: this,
      entry: pool.entry,
    });
    created.instanceMatrix = this.instanceMatrixFor(pool, slot, top);
    created.prewarmNode({ world: created.simulationMatrix(top), pointer, parent: top }, env);
    return created;
  }

  /**
   * 预热（C1）：加载时一次跑完 `while (t < starttime)`，步长按 `maxcount` 取 0.05 或 0.2，float32 累加，**固定一遍**
   * （加载时 `fps` 还是 0，实测推翻了读码的「受 fps 分支影响」），发射开启，`k0 = 步长`。步长不乘 `rate`（按读码直接传步长，
   * `rate ≠ 1` 的预热没有实测）。预热不走帧函数，场景时间 `T` 保持加载期的初值 0（`rea-p4b-modules.md` B2 末条；实测
   * `ignore/p4/tracks/rd-p4b-pre-fps60.json`：预热里出生的 `turbulentvelocityrandom` 粒子方向全是 90°，`positionoffsetrandom`
   * 粒子偏移完全相同）。
   *
   * 控制点（P4c 步骤 1，rea-p4c-sim.md 1.3）：加载时 `FUN_14022feb0` 先写好 `W`，压模型矩阵，`FUN_14022e3e0` 更新一次、全部
   * 控制点 `previous ← current`，再预热，预热的每一步照常更新、照常拷 `previous`。`starttime` 为 0 时也做前两步。
   * `inputs` 是加载时的 `W` 与加载时刻光标的跟随点（P4c 步骤 2；预热不走帧函数，指针不变）。
   *
   * 子系统（P4e 步骤 1，rea-p4e-children 3.1、3.5【确】，实测 `st-warmp` / `st-warmc` / `st-wwarm`）：本系统的控制点初始化与预热**之前**，
   * 先深度优先把全部 static 子孙建好并预热完，各按**自己的** `starttime` 与步长；父的预热循环只模拟自己、不步进子系统。子系统预热的模型
   * 矩阵（`FUN_140229760(child)`）：本地 `本系统 M · L`，**世界 `L`**（不含父 `W`，3.3「两处不一致」照复刻）；控制点父分支读到的是父的
   * 初值（父还没更新，`current = base`），`Mprev` 是本系统预热的 `M`。
   */
  prewarm(inputs: ControlPointInputs = IDENTITY_INPUTS): void {
    this.lastWorld = inputs.world;
    this.prewarmNode(inputs, { time: 0, layerTime: 0, object: inputs.world });
  }

  /**
   * `prewarm` 的一层（`FUN_14022ebe0`）：先建好的 static 子孙各自预热，再做本系统的控制点初始化与预热循环。`env.object` 是对象世界矩阵
   * （remap 的 `layerorigin`，整棵树共用）；加载时 `env` 的两个时间是 0，运行中新建的事件实例（P4e 步骤 2）用这一帧的。
   */
  private prewarmNode(inputs: ControlPointInputs, env: PrewarmEnv): void {
    for (const child of this.statics)
      child.system.prewarmNode(
        {
          world: child.system.def.flags & 1 ? child.local : multiply(inputs.world, child.local),
          pointer: inputs.pointer,
          parent: inputs.world,
        },
        env,
      );
    this.controlPoints.update(inputs);
    this.controlPoints.endFrame();
    this.prewarmLoop(inputs, env);
  }

  /**
   * 预热循环（C1，`FUN_14022ebe0` 尾部；复用事件实例时单独跑，`FUN_14022f430`）：`while (t < starttime)` 按步长模拟，事件位清零
   * （`sys+0x41 = 0`，4.8：不记新粒子，所以不建 eventfollow / eventspawn 实例；不为事件收集死亡），不步进子系统（3.5）。结束后 ropetrail
   * 的历史塌缩。
   * 例外（4.8【确】，实测 `ed-rope` 比 `ed-sprite` 多 1 个实例）：rope 系统的判死照样收集死亡槽号（rope 表要用），建 eventdeath 实例的循环
   * 只看死亡表与 `cap`、不看 `sys+0x41`，所以带 rope 的系统在预热里照样建 eventdeath 实例（`advance` 的 `prewarming`）；这些实例预热期间
   * 不步进，到预热之后的第一个正常帧才步进。
   */
  private prewarmLoop(inputs: ControlPointInputs, env: PrewarmEnv): void {
    const step = prewarmStep(this.def.maxcount);
    const end = f32(this.def.starttime);
    this.context.time = env.time;
    this.context.layerTime = env.layerTime;
    for (let t = 0; t < end; t = f32(t + step)) this.advance(step, 0, 1, inputs, true, env.object, env, true);
    // ropetrail（P4d 步骤 2）：预热的步进不调顶点函数、不采样，结束后历史塌缩到当前位置（rea-p4d-rope.md 5.1，`0x14022f2fc`）
    this.trail?.afterPrewarm(this.columns, this.highWater);
  }

  /**
   * 清空全部粒子（不重置发射状态）。rope 表与累计死亡数一起清零（`FUN_14022fd90` / `FUN_14022f990` 在高水位 > 0 时同时清零
   * 高水位、存活数、`sys+0x350` 并清空表，rea-p4d-rope.md 2.4；累计死亡数非零时高水位一定非零，所以无条件清零结果相同）。
   * ropetrail 的计时器不重置、历史不清（5.1：计时器只有采样写；历史出生时覆盖）。
   */
  clear(): void {
    this.columns.clear();
    this.highWater = 0;
    this.alive = 0;
    this.searchFrom = 0;
    this.ropeOrder?.clear();
    this.deaths = 0;
    this.clearScriptBorn();
  }

  /**
   * 模拟一步（`FUN_140236cd0`）。`emit` 为假（对象不可见，子系统在 `suspend` 里步进，P4e 步骤 1）时不调发射，发射计时也不走；判死与
   * 死亡事件不看它（`emit` 只挡发射器的调用，【推】自代码结构，同停跟随）。`object` 是对象世界矩阵（`layerorigin`），顶层就是
   * `inputs.world`。
   * 事件（P4e 步骤 2、3）用两个参数：`env` 是这一帧的环境（建实例与实例预热用，预热时也有；为 null 时不处理事件，现在只剩没传的单测）；
   * `prewarming` 是预热（`sys+0x41 = 0`，4.8）：不记新粒子、不为事件收集死亡（rope 系统照旧收集，所以预热里照样可能建 eventdeath 实例）。
   * 帧内顺序（7.3）：判死 → 序列帧 → 逐死粒子停跟随、建 eventdeath 实例（4.2）→ 控制点 → 发射（记新粒子）→ 逐条目、逐新粒子建
   * eventfollow / eventspawn 实例（4.3）→ operator → `previous ← current`。
   */
  private advance(
    dt: number,
    frameDt: number,
    passes: 1 | 2,
    inputs: ControlPointInputs,
    emit = true,
    object: Mat4 = inputs.world,
    env: PrewarmEnv | null = null,
    prewarming = false,
  ): void {
    // `FUN_1402308a0` 的 `comiss dt′, 0` + `jbe`（`0x1402308dc`–`0x1402308eb`）：`dt′ ≤ 0`（含 NaN）时不调模拟，整段冻结（P4f 步骤 1）
    if (!(dt > 0)) return;
    // rope 系统总收集（`ageAndKill` 自己判断）；事件只在不预热时收集（`sys+0x41 & 0x14`）
    this.ageAndKill(dt, !prewarming && this.watchesDeaths);
    this.sequenceFrames();
    // 判死之后、控制点之前（4.2，`0x140237129`–`0x1402376f6`）：停跟随 + eventdeath（P4e 步骤 2、3）。预热里也走：死亡表这时只有 rope
    // 系统非空（4.8）
    if (env) this.handleDeaths(inputs, env);
    // O1 第 5 步（`0x1402376fe`）：序列帧（`0x140237022`）之后、发射之前，两遍模式也只一次
    this.controlPoints.update(inputs);
    const context = this.context;
    // 模拟时的模型矩阵 `M`（rea-p4c-sim.md 1.4，顶层系统就是 `W`，子系统是 `父 M · L`）：取前三列的 xyz，同 `FUN_1400dd7d0`（P4c 步骤 4）
    const w = inputs.world;
    context.model.set([w[0], w[1], w[2], w[4], w[5], w[6], w[8], w[9], w[10]]);
    // 对象原点 `W.t`（P4d 步骤 4a，remap 的 `layerorigin`：对象虚函数 +0x80 的第 3 列，子系统读的也是对象的）
    context.origin!.set([object[12], object[13], object[14]]);
    if (emit) {
      this.emit(dt, env !== null && !prewarming && this.watchesBirths);
      // 全部发射器发完之后（4.3，`0x14023ae9a` 起）：逐条目、逐新粒子建 eventfollow / eventspawn 实例（P4e 步骤 2、3）；预热时 `born` 本来
      // 就是空的，这里再挡一次
      if (env && !prewarming && this.born.length) this.spawnInstances(inputs, env);
    }
    const { h, k } = operatorPass(dt, frameDt, passes);
    context.count = this.highWater;
    context.h = h;
    context.k = k;
    for (let pass = 0; pass < passes; pass++) {
      this.columns.resetCurrent(this.highWater);
      for (const operator of this.operators) operator.run(operator.fields, context);
    }
    // 帧尾，全部 operator 之后（`0x140237798`）
    this.controlPoints.endFrame();
  }

  /**
   * 判死（O1 第 1 步）。rope 系统另收集当帧的死亡槽号（槽号升序，`FUN_140236cd0` 的死亡列表 `sys+0x420`），循环后从 rope 表里
   * 保序删除（`0x140237082`），死亡数累加进 `deaths`（`0x140237146`，rea-p4d-rope.md 2.3）。都在发射之前：同一帧先删死的、再追加新的。
   * `events`：有 eventfollow / eventdeath 条目且不在预热（`sys+0x41 & 0x14`，P4e 步骤 2、3）时同样收集，供停跟随与建 eventdeath 实例
   * （4.2）。rope 系统不看它，预热里也收集（4.8）。
   */
  private ageAndKill(dt: number, events = false): void {
    const { age, life } = this.columns;
    const order = this.ropeOrder;
    const collect = order !== null || events;
    const dead = this.dead;
    dead.length = 0;
    for (let i = 0; i < this.highWater; i++) {
      age[i] = f32(age[i] + dt);
      if (life[i] !== 0 && life[i] < age[i]) {
        life[i] = 0;
        this.alive--;
        if (i < this.searchFrom) this.searchFrom = i;
        if (collect) dead.push(i);
      }
    }
    if (order && dead.length) {
      order.removeDead(dead);
      this.deaths += dead.length;
    }
  }

  /**
   * 判死之后处理死亡表（4.2【确】，`0x140237129`–`0x1402376f6`）：逐死粒子（升序）先停跟随，再建 eventdeath 实例。`inputs.world` 是本系统的
   * 模拟矩阵（`X` 的 `top`），`env` 是这一帧的环境（实例预热用）。
   * ```
   * cap = Σ_{eventdeath 条目} (E.maxcount − 活跃数)           // 本帧开头算一次，可以是负数
   * for d in 死亡表（升序）:
   *     for eventfollow 条目, for 活跃实例 inst（表序）:
   *         if inst.followSlot == d: 停跟随                   // 0x140237320–0x1402373bb
   *     if cap == 0: continue                                 // 只判恰好为 0
   *     for E in 事件条目（条目顺序）, E.type == eventdeath:
   *         if uA > E.probability: continue                   // 0x14023740d：每个（死粒子，条目）抽一次，probability ≥ 1 也抽
   *         inst = 取空闲或新建（4.7），followSlot = d，X 用死粒子的位置
   *         活跃表追加 inst;  cap −= 1
   *         if 活跃数 == E.maxcount: break                    // 跳到下一个死粒子
   * ```
   * - 停跟随（4.6 末段，实测 `f-death`、`ef-death`）：`followSlot = −1`（`X` 冻结在最后一次的值）、自己与 static 子孙的发射器全部标结束
   *   （`endEmitters`），已有粒子照常活到寿命，之后在子系统更新里回收。死亡发生在父模拟开头，所以父粒子死亡那一帧实例就不再发射。只看
   *   eventfollow 条目的活跃实例（停过跟随的是 −1，不会再匹配；eventspawn / eventdeath 实例的 `followSlot` 不受影响）。
   * - eventdeath 的 `X`：判死只把寿命清零，位置列还是死粒子**上一帧末**的值（判死在 operator 之前，实测 `ed-pos`），`takeInstance` 读的就是它。
   * - 嵌套是「死粒子在外、条目在内」，和 4.3 相反（`ed-order` 的抽取顺序只在单测里核对）。
   * - 上限（「决定」4，照 WPE 复刻）：`cap` 是各 eventdeath 条目剩余量之和，循环里不再逐条目查「已满」。单条目时上限严格成立；多个条目时某
   *   条目满了而别的没满，满的条目照样建（之后 `活跃数 == maxcount` 的相等判断不再成立），`cap` 减到负数后一直非零，于是每个死粒子在每个
   *   条目各建一个（实测 `ed-max2` 两个条目各 `maxcount 1`，12 s 后 60、59 个实例）。
   * - 不可见（`emit = false`）时照常（判死不看 `emit`）；预热时死亡表只有 rope 系统非空，这时同样建（4.8）。
   * - `uA` 抽本对象的随机源，不复刻 WPE 的 MT19937（7.3）；`cap == 0` 时整个死粒子不抽。
   */
  private handleDeaths(inputs: ControlPointInputs, env: PrewarmEnv): void {
    const dead = this.dead;
    if (!dead.length) return;
    let cap = 0;
    for (const pool of this.events)
      if (pool.entry.type === "eventdeath") cap += pool.entry.maxcount - pool.active.length;
    for (const slot of dead) {
      for (const pool of this.events) {
        if (pool.entry.type !== "eventfollow") continue;
        for (const instance of pool.active)
          if (instance.followSlot === slot) {
            instance.followSlot = -1;
            instance.endEmitters();
          }
      }
      if (cap === 0) continue;
      for (const pool of this.events) {
        if (pool.entry.type !== "eventdeath") continue;
        if (this.random.a() > pool.entry.probability) continue;
        const instance = this.takeInstance(pool, slot, inputs.world, inputs.pointer, env);
        instance.followSlot = slot;
        pool.active.push(instance);
        cap--;
        if (pool.active.length === pool.entry.maxcount) break;
      }
    }
  }

  /**
   * 本帧新粒子建事件实例（4.3【确】，`0x14023ae9a`–`0x14023b28c`），嵌套是「条目在外、新粒子在内」：
   * ```
   * for E in 事件条目（条目顺序）, E.type in (eventfollow, eventspawn):
   *   if 活跃数 == E.maxcount: continue                           // 满了：本帧不抽、不建（实测 f-max、ef-max、es-max）
   *   for b in 新粒子（出生先后）:
   *     if uA > E.probability: continue                           // 流 A，probability 1 也抽一次（4.4）
   *     inst = 取空闲或新建（4.7），X 用新粒子当前位置（initializer 之后、operator 之前），followSlot = b
   *     活跃表追加 inst
   *     if 活跃数 == E.maxcount: break
   * 清空新粒子表
   * ```
   * 两种类型在这里完全相同，区别只在之后：eventfollow 每帧按父粒子重算 `X`、父粒子死时停跟随（`stepEvents`、`handleDeaths`）；eventspawn 的
   * `X` 只在这里写一次（实测 `es-pos`：子粒子从父粒子的出生点出发，不随父粒子移动），父粒子死了也不停。只有连续发射、没有 `duration` 的
   * eventspawn 实例永不回收，池满后这个条目不再有事件（`es-max`）。
   * 上限照 WPE 用相等判断（单条目时活跃数不会超过 `maxcount`）。我们不复刻 WPE 的 MT19937，`uA` 取本对象的随机源（同其它模块，7.3）。
   */
  private spawnInstances(inputs: ControlPointInputs, env: PrewarmEnv): void {
    const born = this.born;
    for (const pool of this.events) {
      const { type } = pool.entry;
      if (type !== "eventfollow" && type !== "eventspawn") continue;
      const { maxcount, probability } = pool.entry;
      if (pool.active.length === maxcount) continue;
      for (const slot of born) {
        if (this.random.a() > probability) continue;
        const instance = this.takeInstance(pool, slot, inputs.world, inputs.pointer, env);
        instance.followSlot = slot;
        pool.active.push(instance);
        if (pool.active.length === maxcount) break;
      }
    }
    born.length = 0;
  }

  /**
   * 序列帧（模拟第 3 步，`0x140237022`，rea-p4b-render.md 2.5）：系统有 `0x1000000`（`def.spriteSheet`）且不是 `randomframe`
   * 时，对 `[0, highWater)` 全部槽 `frame = (1 / life)·age·sequencemultiplier`，先乘 age 再乘倍数，float32。引擎不取小数，
   * frame 可以大于 1（倍数 2 时一生循环两遍），小数由着色器取。
   * - 在判死之后、发射之前：出生当帧 `frame = 0`（序列）或 `R`（`randomframe`，之后不更新），下一帧才按年龄更新。
   * - WPE 用 `rcpps(life)`（相对误差约 3.7e-4），不复刻（总体设计「近似倒数不复刻」）：混帧开着时只让混帧系数差约 1%，
   *   关着时帧号正好落在帧边界附近的粒子可能差一帧。
   * - 死槽（`life = 0`）得 inf / NaN：写顶点时跳过、出生时覆盖，和 WPE 一样不影响结果。
   */
  private sequenceFrames(): void {
    if (!this.def.spriteSheet || this.def.animationMode !== "sequence") return;
    const { frame, age, life } = this.columns;
    const multiplier = f32(this.def.sequenceMultiplier);
    for (let i = 0; i < this.highWater; i++) frame[i] = f32(f32(f32(1 / life[i]) * age[i]) * multiplier);
  }

  /**
   * 按 JSON 顺序逐个 emitter：先算数量（周期发射在这里抽时长，早于本 emitter 的新粒子，A3），再逐个出生。
   * 周期发射进入新周期时（`emissionCount` 置 `periodStarted`），先对全部有状态的 initializer 调 `newPeriod`（P4d 步骤 3，
   * `FUN_14022f790`，在 `FUN_1402378a0` 的新周期分支里 `0x140237ac1`，早于本 emitter 本帧的新粒子），再出生。
   * 暂停位（P4f 步骤 3，rea-p4f-script.md 2.1，`0x1402378c8`–`0x1402378e4`：`(sys+0x3f7 & 1) && n ≤ 0` 时返回）：模拟里的发射整段不跑——
   * 不发射、不走帧尾（`delay` / `duration` 不递减）、周期计时与余数不动，`born` 是空的所以之后也不建 eventfollow / eventspawn 实例。
   * `scripted > 0` 是脚本 `emitParticles(n)`（`dt = 0`，`emitParticles` 调）：每条发射器交给 `emissionCount` 的 `script`。
   */
  private emit(dt: number, record = false, scripted = 0): void {
    const capacity = this.columns.capacity;
    // 发射开头（4.3，`dil = sys+0x41 & 0xc`）：有 eventfollow / eventspawn 条目且不在预热时，新粒子的槽号按出生先后记进 `born`（P4e 步骤 2）
    this.born.length = 0;
    const paused = this.scriptPaused;
    if (paused && scripted <= 0) return;
    this.recordBirths = record;
    const script = scripted > 0 ? { count: scripted, paused } : undefined;
    for (const emitter of this.emitters) {
      // 音频系数（P4e 步骤 4）在 `emissionCount` 里按这一帧的频谱取，每帧每条 emitter 一次
      const count = emissionCount(
        emitter.state,
        emitter.fields,
        dt,
        this.alive,
        capacity,
        this.random,
        this.context.audio,
        script,
      );
      if (emitter.state.periodStarted) {
        emitter.state.periodStarted = false;
        for (const module of this.initializers)
          if (module.state !== undefined) module.def.newPeriod?.(module.state, module.fields);
        // 同一处（`FUN_14022f790`，rea-p4e-children 3.7）：条目 `flags` bit1 的 static 子系统复位并重开，每个周期发射器的新周期各一次
        for (const child of this.statics) if (child.entry.flags & 2) child.system.restart();
      }
      for (let n = 0; n < count; n++) this.spawn(emitter);
    }
  }

  /** 一个新粒子：第一个空槽 → emitter 写位置速度 → 抽 `R` → 缺省值 → initializer（JSON 顺序）。 */
  private spawn(emitter: ResolvedEmitter): void {
    const c = this.columns;
    let slot = this.searchFrom;
    while (slot < c.capacity && c.life[slot] !== 0) slot++;
    if (slot >= c.capacity) return;
    this.searchFrom = slot + 1;
    const context = this.context;
    context.slot = slot;
    emitter.run(emitter.fields, context);
    // 照常抽一次再替换：注入只改 `R` 本身，后面各模块抽到的随机数和不注入时相同
    const drawn = this.random.a();
    const r = this.rOverride ? this.rOverride(drawn) : drawn;
    c.random[slot] = r;
    c.age[slot] = 0;
    c.life[slot] = 1;
    // 出生时 frame（`0x14023b4e9`）：`randomframe` 写 `R`，否则 0（rea-p4b-render.md 2.5）
    c.frame[slot] = this.def.animationMode === "randomframe" ? r : 0;
    c.size0[slot] = 0.5;
    for (let i = 0; i < 3; i++) {
      c.rotation[i][slot] = 0;
      if (c.angularVelocity) c.angularVelocity[i][slot] = 0;
      // 实例颜色（`FUN_14023b340` 在 initializer 之前拷 `sys+0x3e0..0x3e8`，rea-p4b-render.md 7.4 第 4 小节）：`0x200000`
      // 且 `colorn` 生效时是 `colorn`，否则 1；颜色 initializer 乘在它上面，`colorchange` 每遍从这里复制后再乘
      c.color0[i][slot] = this.instanceColor[i];
    }
    c.alpha0[slot] = this.alpha0;
    for (const initializer of this.initializers) initializer.run(initializer.fields, context, initializer.state);
    // ropetrail（P4d 步骤 2）：全部 initializer 之后历史写满出生位置、`C = 1`、`U = 0`（rea-p4d-rope.md 5.1，`0x14023f953`）
    this.trail?.born(slot, c);
    // 当前值与上一步位置（拖尾初值）
    c.size[slot] = c.size0[slot];
    for (let i = 0; i < 3; i++) {
      c.color[i][slot] = c.color0[i][slot];
      if (c.previousPosition) c.previousPosition[i][slot] = c.position[i][slot];
    }
    c.alpha[slot] = c.alpha0[slot];
    this.alive++;
    if (slot >= this.highWater) this.highWater = slot + 1;
    // 「存活数 + 1、高水位更新」之后追加到 rope 表尾（rea-p4d-rope.md 2.2）：同一帧按 emitter 顺序、逐个出生的顺序
    this.ropeOrder?.push(slot);
    // 事件用的新粒子表（P4e 步骤 2，`0x140238bf8`：initializer、拖尾初值、存活数加一之后）
    if (this.recordBirths) this.born.push(slot);
    // 脚本发出的（P4f 步骤 3）：本帧不画
    if (this.spawningByScript) {
      (this.scriptBorn ??= new Uint8Array(c.capacity))[slot] = 1;
      this.scriptBornCount++;
    }
  }
}
