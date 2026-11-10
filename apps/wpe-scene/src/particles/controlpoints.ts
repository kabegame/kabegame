/**
 * 粒子控制点（P4c 步骤 1）。依据 `.claude/plans/wpe-import/3-scene/phase4/rea-p4c-sim.md` 第 1–3 节（读码【确】），实测见
 * `p4-particles-REPORT.md`「P4c 语义的实测核对」。
 *
 * - 一个系统有 `n` 个控制点，`n = max(模块的 controlpoint + 1)`（解析期每个读控制点的模块做一次 `max`，1.1）；没被模块引用的
 *   控制点不存在，JSON 里给它写什么都不起作用。
 * - 每个控制点存 `base`、`current`、`previous` 三份仿射变换（WPE 每份是 4×4，第 4 行恒为 0 0 0 1，这里只存前三行）：
 *   - 建系统时 `base = I + offset`（JSON 控制点的 `angles` 运行时不读，1.2、1.3），再按静态的 `instanceoverride` 覆盖：
 *     `controlpointN` 替换平移（不加到 `offset` 上），`controlpointangleN` 替换 3×3；`flags & 0x10005`（指针、父控制点、
 *     remap 输出）的点上不生效（`FUN_14022bd40`，第 2 节）。`current = previous = base`。
 *   - 每帧 `update`（`FUN_14022e3e0`，1.5）在序列帧之后、发射之前，两遍模式也只一次；全部 operator 之后 `endFrame`
 *     （`previous ← current`，`0x140237798`）。
 * - 读控制点的模块经执行上下文的 `controlPoints` 读 `current`（第 3 节）。
 * - 指针点（`flags` bit0，P4c 步骤 2，1.6）：每帧的平移是「光标下的场景点」`F`（渲染器按壁纸样式把画布指针换成场景纹理坐标，
 *   再由 `pointerScenePoint` 照 WPE 反投影到 z = 0），`offset` 被丢弃、3×3 是单位阵；本地系统再乘 `inverse(W)`，世界系统直接用。
 *
 * - 世界空间系统（系统 `flags` bit0，P4c 步骤 4，rea-p4c-sim.md 5.2）：缺省更新是 `current = W·base`（控制点 0 忽略 bit1），
 *   指针点是 `(X, Y, 0)`、不乘 `W`，和本地分支在同一个函数里（`FUN_14022a070`、1.6）。
 *
 * - remap 写的点（P4d 步骤 4b，rea-p4d-modules.md 2.8）：输出是 `controlpoint` 的 remap 的 `ocp0` 建系统时并进 `0x10000`
 *   （`controlPointModuleFlags`），之后 `update` 整点跳过、不吃实例覆盖，`current` 只被 remap 改写（初值是 `base = I + offset`）。
 *   remap 直接改 `current(i).translation`（`remap.ts`）。
 *
 * 不做：父控制点（bit2、bit3，只对子系统有意义，P4e；顶层系统的 bit2 走缺省更新，只让实例覆盖不生效）；`instanceoverride` 控制点的
 * 运行时改值（语料全是静态值，能力表报 `{user}`）。
 */
import type { ParticleInstance, SceneControlPoint, SceneParticle } from "../compile/particles";
import { invert, multiply, type Mat4 } from "../render/math";
import { f32 } from "./f32";
import { particleModuleDef, type ParticleCategory, type ParticleModule } from "./modules";

/** 一个控制点的仿射变换（WPE 每份存 4×4，第 4 行恒为 0 0 0 1，这里只存前三行）。 */
export interface ControlPoint {
  /** 3×3，列主序：`basis[c * 3 + r]` 是第 c 列第 r 个分量（同 rea-p4b-modules 的 Mij）。 */
  readonly basis: Float32Array;
  readonly translation: Float32Array;
}

export interface ControlPointInputs {
  /** 对象世界矩阵 `W`（`render/layout.ts` 的 `worldMatrixOf`，含父链）。顶层系统模拟时的模型矩阵 `M` 就是它（1.4）。 */
  world: Mat4;
  /**
   * 指针的跟随点 `F`（场景坐标，z = 0，`pointerScenePoint` 算），每帧由渲染器给（P4c 步骤 2）。全场一个值，和对象无关；
   * 只有指针点读它。
   */
  pointer: readonly [number, number];
}

/** 控制点 `flags` 的位（rea-p4c-sim.md 1.9）。bit3（父分支不换算）、bit4（没有读者）这里用不到。 */
export const CONTROL_POINT_FLAGS = {
  /** 跟随指针（1.6，P4c 步骤 2）：平移是光标下的场景点，丢弃 `offset`，不吃实例覆盖。 */
  pointer: 1,
  /** `base` 是场景坐标：本地系统乘 `inverse(W)`；世界系统的控制点 0 忽略它（1.5）。 */
  scene: 2,
  /** 父控制点（1.8）：顶层系统没有父，走缺省更新，只让实例覆盖不生效。 */
  parent: 4,
  /** 内部位：remap 模块写的点（1.2），建系统时由 `controlPointModuleFlags` 并进，`update` 跳过（P4d 步骤 4b）。 */
  remap: 0x10000,
} as const;

/** `FUN_14022bd40` 跳过实例覆盖的位（`test [cp+0xc0], 0x10005`，`0x14022bf26`）：指针、父控制点、remap 输出。 */
const NO_INSTANCE_OVERRIDE = CONTROL_POINT_FLAGS.pointer | CONTROL_POINT_FLAGS.parent | CONTROL_POINT_FLAGS.remap;

/** 单位 3×3（列主序）。只读：执行上下文的缺省 `basis`，不要改写。 */
export const IDENTITY_BASIS: Float32Array = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

/**
 * 光标下的场景纹理坐标（0…1，左上原点、y 向下，`render/layout.ts` 的 `sceneCursor`）→ 跟随点的场景坐标（P4c 步骤 2，
 * rea-p4c-sim.md 1.6，`0x14022e47b`–`0x14022e669`）。`viewProjection` 是场景的正交 `P·V`（`sceneViewProjection`），函数内求逆。
 *
 * WPE 的 `ctx+0x8c/0x90` 是窗口归一化坐标（1.7），`P·V` 里已带着把场景居中盖满到窗口的裁切（报告「步骤 2 补测」）；Kabegame 的
 * 场景渲染在场景分辨率的目标里、`P·V` 不裁，裁切与留白在上屏时按样式做，所以先由 `sceneCursor` 把画布指针换成光标下的场景
 * 纹理坐标，再照 WPE 同一串运算反投影。`fill` 的铺放就是 WPE 的居中盖满，两边结果一致。逐步 float32（照 1.6 的伪代码）：
 * ```
 * x = ((px − 0) + (px − 0)) − 1                          // subss 0、addss 自身、subss 1
 * y = (((1 − py) − 0) + ((1 − py) − 0)) − 1
 * A = inverse(P·V)                                      // FUN_14005ecb0 再 FUN_14005f730
 * w = (A03·x + A13·y) + (A23·0 + A33)
 * X = ((A00·x + A10·y) + (A20·0 + A30)) / w             // divss
 * Y = ((A01·x + A11·y) + (A21·0 + A31)) / w
 * ```
 * `Aij` 是第 i 列第 j 个分量。反投影的 z 丢掉（落在 z = 0 平面）；不钳制，窗口外线性外推。求逆用 `render/math.ts` 的 `invert`
 * （double 余子式、末尾舍入），WPE 是 float32 伴随矩阵乘 `1/det`，正交矩阵的逆可能差 1 ulp。`invert` 失败（正交投影可逆，
 * 不会发生）时返回 NaN。
 */
export function pointerScenePoint(viewProjection: Mat4, cursor: readonly [number, number]): [number, number] {
  const a = invert(viewProjection);
  if (!a) return [Number.NaN, Number.NaN];
  const px = f32(cursor[0]);
  const py = f32(cursor[1]);
  const sx = f32(px - 0);
  const x = f32(f32(sx + sx) - 1);
  const sy = f32(f32(1 - py) - 0);
  const y = f32(f32(sy + sy) - 1);
  const w = f32(f32(f32(a[3] * x) + f32(a[7] * y)) + f32(f32(a[11] * 0) + a[15]));
  const X = f32(f32(f32(f32(a[0] * x) + f32(a[4] * y)) + f32(f32(a[8] * 0) + a[12])) / w);
  const Y = f32(f32(f32(f32(a[1] * x) + f32(a[5] * y)) + f32(f32(a[9] * 0) + a[13])) / w);
  return [X, Y];
}

/**
 * 指针点本地系统的平移：`B·(X, Y, 0, 1)`（`B = inverse(W)`，1.6），逐步 float32、加法顺序照伪代码：
 * `((B0j·X + B1j·Y) + (B2j·0 + B3j))`。`B` 为 null（`W` 奇异）时写 NaN：WPE 的 `FUN_14005f730` 乘 `1/det = inf`，同样画不出来。
 */
function pointerLocal(target: Float32Array, inverse: Mat4 | null, x: number, y: number): void {
  if (!inverse) {
    target.fill(Number.NaN);
    return;
  }
  for (let j = 0; j < 3; j++)
    target[j] = f32(
      f32(f32(inverse[j] * x) + f32(inverse[4 + j] * y)) + f32(f32(inverse[8 + j] * 0) + inverse[12 + j]),
    );
}

/** 模块里引用控制点的字段：`controlpoint`，以及 `mapsequencebetweencontrolpoints` 的两端（P4d 步骤 3）；remap 的走 `controlPointRefs`。 */
const CONTROL_POINT_FIELDS = ["controlpoint", "controlpointstart", "controlpointend"] as const;

/**
 * `n = max(下标 + 1)`：遍历三类模块里模块表有 `CONTROL_POINT_FIELDS` 字段的项，取解析后的值（0–7，`clampControlPoint`）。
 * 没有这样的模块时为 0。WPE 在解析期对每个读控制点的模块做 `max(已有, controlpoint + 1)`（`0x1401c6ab8` 等，无符号比较）；
 * `controlpointattract` 从 P4c 步骤 3 起在表里，计入（`0x1401ccd88`–`0x1401ccd99`），只被它引用的控制点从此存在，指针与实例覆盖
 * 在这些点上生效。`mapsequencebetweencontrolpoints` 两端都计（`def+0x2c = max(·, start + 1, end + 1)`，rea-p4d-modules.md 1.2），
 * 不写字段时 `end` 缺省为 1，所以至少 2 个。字段名不是这三个的引用由模块表的 `controlPointRefs` 给（P4d 步骤 4a 的 remap 两个模块：
 * 输入或输出属于 {7, 8, 16, 17, 18} 时计 `icp0`、`ocp0`，是 8 时再计 `icp1`、`ocp1`，`FUN_1401bc480` / `FUN_1401bc4a0`，rea-p4d-modules.md
 * 2.1）。表外模块（P4d 的 `reducemovementnearcontrolpoint` 等）不计：场景已因 `particle:<类别>:<名字>` 退回，它们也不执行。
 */
export function controlPointCount(def: Pick<SceneParticle, "emitters" | "initializers" | "operators">): number {
  let count = 0;
  const visit = (category: ParticleCategory, modules: readonly ParticleModule[]) => {
    for (const module of modules) {
      const known = particleModuleDef(category, module.name);
      if (!known) continue;
      for (const field of CONTROL_POINT_FIELDS) {
        if (!known.fields[field]) continue;
        const index = module.fields[field];
        if (typeof index === "number") count = Math.max(count, index + 1);
      }
      for (const index of known.controlPointRefs?.(module.fields) ?? []) count = Math.max(count, index + 1);
    }
  };
  visit("emitter", def.emitters);
  visit("initializer", def.initializers);
  visit("operator", def.operators);
  return count;
}

/**
 * 模块要并进控制点 `flags` 的位（P4d 步骤 4b，rea-p4d-modules.md 2.8【确】）：遍历三类模块里模块表有 `controlPointFlags` 的项，返回
 * 8 个控制点各自的附加位。WPE 解析时把「输出是 `controlpoint` 的 remap」的 `ocp0` 插进一个集合（`FUN_1401bc470` →
 * `FUN_140130b20`），解析完控制点数组后对集合里 `< 8` 的下标 `flags |= 0x10000`（`0x1401d0860`–`0x1401d087e`）；输入 16–18、输出
 * 17、18 不插。表外模块不计（场景已退回，同 `controlPointCount`）。
 */
export function controlPointModuleFlags(def: Pick<SceneParticle, "emitters" | "initializers" | "operators">): number[] {
  const flags = new Array<number>(8).fill(0);
  const visit = (category: ParticleCategory, modules: readonly ParticleModule[]) => {
    for (const module of modules) {
      const known = particleModuleDef(category, module.name);
      for (const [index, bits] of known?.controlPointFlags?.(module.fields) ?? [])
        if (index >= 0 && index < 8) flags[index] |= bits;
    }
  };
  visit("emitter", def.emitters);
  visit("initializer", def.initializers);
  visit("operator", def.operators);
  return flags;
}

/**
 * `controlpointangleN` 的 3×3（`FUN_14022bd40`，`0x14022bf53`–`0x14022c069`，rea-p4c-sim.md 第 2 节）：`R = Rz·Ry·Rx`，弧度。
 * 汇编逐条核对过：先 z、再 y、再 x 各算 `cos`、`sin`（CRT `cosf` / `sinf`，这里 `Math.cos` / `Math.sin` 再舍入，可能差 1 ulp），
 * 三列逐项、逐步 float32：
 * ```
 * col0 = (cy·cz, cy·sz, −sy)
 * col1 = ((sy·cz)·sx − cx·sz, (sy·sz)·sx + cx·cz, sx·cy)
 * col2 = ((cx·cz)·sy + sx·sz, (cx·sz)·sy − sx·cz, cx·cy)
 * ```
 * 覆盖值存成 float（`obj+0x8c8 + 12i`），先舍入再求三角函数。
 */
export function eulerBasis(angles: readonly number[]): Float32Array {
  const [ax, ay, az] = angles.map((value) => f32(value));
  const cz = f32(Math.cos(az));
  const sz = f32(Math.sin(az));
  const cy = f32(Math.cos(ay));
  const sy = f32(Math.sin(ay));
  const cx = f32(Math.cos(ax));
  const sx = f32(Math.sin(ax));
  return new Float32Array([
    f32(cy * cz),
    f32(cy * sz),
    -sy,
    f32(f32(f32(sy * cz) * sx) - f32(cx * sz)),
    f32(f32(f32(sy * sz) * sx) + f32(cx * cz)),
    f32(sx * cy),
    f32(f32(f32(cx * cz) * sy) + f32(sx * sz)),
    f32(f32(f32(cx * sz) * sy) - f32(sx * cz)),
    f32(cx * cy),
  ]);
}

/** 建控制点要的那部分粒子定义（`SceneParticle` 满足）。 */
export type ControlPointSource = Pick<SceneParticle, "emitters" | "initializers" | "operators" | "flags"> & {
  controlpoints: readonly SceneControlPoint[];
  instance: Pick<ParticleInstance, "controlpoints" | "controlpointAngles">;
};

interface PointState {
  flags: number;
  base: ControlPoint;
  current: ControlPoint;
  previous: ControlPoint;
}

const newPoint = (): ControlPoint => ({ basis: new Float32Array(IDENTITY_BASIS), translation: new Float32Array(3) });

function copyPoint(target: ControlPoint, source: ControlPoint): void {
  target.basis.set(source.basis);
  target.translation.set(source.translation);
}

/** `B` 的 4×4（列主序，第 4 行 0 0 0 1）。 */
function pointMatrix({ basis, translation }: ControlPoint): Mat4 {
  // prettier-ignore
  return new Float32Array([
    basis[0], basis[1], basis[2], 0,
    basis[3], basis[4], basis[5], 0,
    basis[6], basis[7], basis[8], 0,
    translation[0], translation[1], translation[2], 1,
  ]);
}

/**
 * `target = M·base`（4×4，`FUN_14024f0e0`）。`M` 为 null（`W` 奇异，`invert` 失败）时写 NaN：WPE 的 `FUN_1402290d0` 除以 0 得
 * inf / NaN，粒子同样画不出来。乘法用 `render/math.ts` 的 `multiply`（double 累加、末尾舍入），和 WPE 的 float32 逐步舍入可能差
 * 1–2 ulp。
 */
function applyMatrix(target: ControlPoint, matrix: Mat4 | null, base: ControlPoint): void {
  if (!matrix) {
    target.basis.fill(Number.NaN);
    target.translation.fill(Number.NaN);
    return;
  }
  const m = multiply(matrix, pointMatrix(base));
  target.basis.set([m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]]);
  target.translation.set([m[12], m[13], m[14]]);
}

const DEFAULT_POINT: SceneControlPoint = { flags: 0, offset: [0, 0, 0] };

/** 一个系统的控制点（见文件头）。 */
export class ControlPointSet {
  /** 控制点个数 `n`（`controlPointCount`）。 */
  readonly count: number;
  /** 系统 `flags` bit0（世界空间）。 */
  private readonly world: boolean;
  private readonly points: PointState[];

  /**
   * base = I + offset，再按静态实例覆盖（`flags & 0x10005` 的点跳过）；current = previous = base。`count` 缺省按模块算
   * （`controlPointCount`），只有单测指定。
   *
   * 加载时 WPE 的 `FUN_14022bd40` 还会按当时的 `W`（构造函数写的单位阵）写一次 `current`，紧接着加载时的那次 `update`
   * （`FUN_14022e3e0`，见 `ParticleSystem.prewarm`）按真实 `W` 重算，结果相同，所以这里直接 `current = base`。
   */
  constructor(def: ControlPointSource, count = controlPointCount(def)) {
    this.count = count;
    this.world = (def.flags & 1) !== 0;
    // remap 写的点并进 0x10000（P4d 步骤 4b，`controlPointModuleFlags`），在实例覆盖与 `update` 之前
    const moduleFlags = controlPointModuleFlags(def);
    this.points = Array.from({ length: count }, (_, i) => {
      const source = def.controlpoints[i] ?? DEFAULT_POINT;
      const flags = source.flags | (moduleFlags[i] ?? 0);
      const base = newPoint();
      base.translation.set(source.offset);
      if (!(flags & NO_INSTANCE_OVERRIDE)) {
        // 角度只比较 x 分量是否未设（FLT_MAX），这里未设是 null
        const angle = def.instance.controlpointAngles[i];
        if (angle) base.basis.set(eulerBasis(angle));
        // 替换平移，不加 offset
        const position = def.instance.controlpoints[i];
        if (position) base.translation.set(position.slice(0, 3));
      }
      const current = newPoint();
      const previous = newPoint();
      copyPoint(current, base);
      copyPoint(previous, base);
      return { flags, base, current, previous };
    });
  }

  /**
   * 每帧一次（`FUN_14022e3e0`，1.5），在发射之前。位的优先级 `0x10000` > bit0 > bit2 > 缺省：
   * ```
   * f & 0x10000：跳过（remap 输出的点，current 只被 remap 改写；JSON 写这一位而没有 remap 时 current 一直是 base）
   * f & 1：      指针分支（1.6，0x14022e47b）：current = base（3×3 是单位阵：指针点不吃实例覆盖），平移整体覆盖（丢弃 offset）：
   *   世界：current.t = (X, Y, 0)，不乘 W
   *   本地：current.t = inverse(W)·(X, Y, 0, 1)（和 flags 2 共用一次求逆；W 奇异时平移写 NaN）
   * 其余（含 f & 4：顶层系统没有父，走缺省更新 FUN_14022a070，1.8）：
   *   世界：!(f & 2) 或 i == 0 → current = W·base；否则不动
   *   本地：f & 2 → current = inverse(W)·base；否则不动
   * ```
   * `(X, Y)` 是 `inputs.pointer`（本帧的跟随点）。「不动」的点 `current` 一直是建系统时的 `base`（没有运行时改值）。
   */
  update({ world: matrix, pointer }: ControlPointInputs): void {
    let inverse: Mat4 | null | undefined;
    this.points.forEach((point, i) => {
      const f = point.flags;
      if (f & CONTROL_POINT_FLAGS.remap) return;
      if (f & CONTROL_POINT_FLAGS.pointer) {
        copyPoint(point.current, point.base);
        // 跟随点是 float（`pointerScenePoint` 的结果已舍入；单测直接给的值这里再舍一次）
        const x = f32(pointer[0]);
        const y = f32(pointer[1]);
        if (this.world) point.current.translation.set([x, y, 0]);
        else {
          if (inverse === undefined) inverse = invert(matrix);
          pointerLocal(point.current.translation, inverse, x, y);
        }
        return;
      }
      const scene = (f & CONTROL_POINT_FLAGS.scene) !== 0;
      if (this.world) {
        // 世界系统里控制点 0 忽略 bit1（1.5「怪处」）
        if (!scene || i === 0) applyMatrix(point.current, matrix, point.base);
      } else if (scene) {
        if (inverse === undefined) inverse = invert(matrix);
        applyMatrix(point.current, inverse, point.base);
      }
    });
  }

  /** 帧尾 `previous ← current`（`0x140237798`–`0x1402377dd`，4×4 整体），全部 operator 之后。 */
  endFrame(): void {
    for (const point of this.points) copyPoint(point.previous, point.current);
  }

  current(index: number): ControlPoint {
    return this.points[index].current;
  }

  previous(index: number): ControlPoint {
    return this.points[index].previous;
  }
}

/** 8 个控制点都是单位阵、没有覆盖（模块单测的执行上下文用）。 */
export function identityControlPoints(): ControlPointSet {
  return new ControlPointSet(
    {
      emitters: [],
      initializers: [],
      operators: [],
      flags: 0,
      controlpoints: [],
      instance: { controlpoints: [], controlpointAngles: [] },
    },
    8,
  );
}
