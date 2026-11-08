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
 *
 * 本步不做：指针（`flags` bit0，步骤 2，能力表报 `particle:controlpoint:pointer`，这里先 `current = base`）；父控制点
 * （bit2、bit3，只对子系统有意义，P4e；顶层系统的 bit2 走缺省更新，只让实例覆盖不生效）；remap 写控制点（`0x10000`，P4d）；
 * `instanceoverride` 控制点的运行时改值（语料全是静态值，能力表报 `{user}`）。世界空间分支照 WPE 同一个函数写上，但世界空间
 * 整体在步骤 4，能力表照报 `particle:flags:world`。
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
}

/** 控制点 `flags` 的位（rea-p4c-sim.md 1.9）。bit3（父分支不换算）、bit4（没有读者）这里用不到。 */
export const CONTROL_POINT_FLAGS = {
  /** 跟随指针（1.6，步骤 2）。 */
  pointer: 1,
  /** `base` 是场景坐标：本地系统乘 `inverse(W)`；世界系统的控制点 0 忽略它（1.5）。 */
  scene: 2,
  /** 父控制点（1.8）：顶层系统没有父，走缺省更新，只让实例覆盖不生效。 */
  parent: 4,
  /** 内部位：remap 模块写的点（1.2），`update` 跳过（P4d）。 */
  remap: 0x10000,
} as const;

/** `FUN_14022bd40` 跳过实例覆盖的位（`test [cp+0xc0], 0x10005`，`0x14022bf26`）：指针、父控制点、remap 输出。 */
const NO_INSTANCE_OVERRIDE = CONTROL_POINT_FLAGS.pointer | CONTROL_POINT_FLAGS.parent | CONTROL_POINT_FLAGS.remap;

/** 单位 3×3（列主序）。只读：执行上下文的缺省 `basis`，不要改写。 */
export const IDENTITY_BASIS: Float32Array = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

/**
 * `n = max(controlpoint + 1)`：遍历三类模块里模块表有 `controlpoint` 字段的项，取解析后的值（0–7，`clampControlPoint`）。
 * 没有这样的模块时为 0。WPE 在解析期对每个读控制点的模块做 `max(已有, controlpoint + 1)`（`0x1401c6ab8` 等，无符号比较）；
 * 表外模块（`controlpointattract` 等）不计：场景已因 `particle:<类别>:<名字>` 退回，它们也不执行。
 */
export function controlPointCount(def: Pick<SceneParticle, "emitters" | "initializers" | "operators">): number {
  let count = 0;
  const visit = (category: ParticleCategory, modules: readonly ParticleModule[]) => {
    for (const module of modules) {
      if (!particleModuleDef(category, module.name)?.fields.controlpoint) continue;
      const index = module.fields.controlpoint;
      if (typeof index === "number") count = Math.max(count, index + 1);
    }
  };
  visit("emitter", def.emitters);
  visit("initializer", def.initializers);
  visit("operator", def.operators);
  return count;
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
    this.points = Array.from({ length: count }, (_, i) => {
      const source = def.controlpoints[i] ?? DEFAULT_POINT;
      const base = newPoint();
      base.translation.set(source.offset);
      if (!(source.flags & NO_INSTANCE_OVERRIDE)) {
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
      return { flags: source.flags, base, current, previous };
    });
  }

  /**
   * 每帧一次（`FUN_14022e3e0`，1.5），在发射之前。位的优先级 `0x10000` > bit0 > bit2 > 缺省：
   * ```
   * f & 0x10000：跳过（remap 输出的点，P4d；JSON 写这一位时 current 一直是 base）
   * f & 1：      current = base（指针分支，步骤 2；能力表报 particle:controlpoint:pointer）
   * 其余（含 f & 4：顶层系统没有父，走缺省更新 FUN_14022a070，1.8）：
   *   世界：!(f & 2) 或 i == 0 → current = W·base；否则不动
   *   本地：f & 2 → current = inverse(W)·base；否则不动
   * ```
   * 「不动」的点 `current` 一直是建系统时的 `base`（本步没有运行时改值）。
   */
  update({ world: matrix }: ControlPointInputs): void {
    let inverse: Mat4 | null | undefined;
    this.points.forEach((point, i) => {
      const f = point.flags;
      if (f & CONTROL_POINT_FLAGS.remap) return;
      if (f & CONTROL_POINT_FLAGS.pointer) {
        copyPoint(point.current, point.base);
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
