/**
 * 粒子顶点（P4a 步骤 4）：把模拟器的列写成交错顶点，交给渲染器每帧 `writeBuffer`。
 *
 * WebGPU 没有几何着色器，绘制统一走顶点展开：每粒子 4 个顶点、6 个索引（`0 1 2 0 2 3`），4 个顶点的 UV 依次是
 * `(0,0)`、`(0,1)`、`(1,1)`、`(1,0)`。内置 `genericparticle` 不定义 `GS_ENABLED` 时（我们的做法）走的就是顶点展开分支，
 * 输入照 `genericparticle.vert`：
 *
 * | 输入 | 分量 | 内容 |
 * |---|---|---|
 * | `a_Position` | 3 | 位置 |
 * | `a_TexCoordVec4` | 4 | 角点 u、v，旋转 z，尺寸 |
 * | `a_TexCoordC2` | 2 | 旋转 x、y |
 * | `a_Color` | 4 | 颜色 rgb（当前值）、alpha（当前值） |
 * | `a_TexCoordVec4C1` | 4 | 速度 xyz、frame 原值（只在 `THICKFORMAT`，即帧表系统或拖尾，P4b 步骤 2、P4c 步骤 5） |
 *
 * `a_TexCoordVec4C1` 照 WPE 非 GS 厚格式的写入（`0x140235ea9`，rea-p4b-render.md 2.6）：系统本地空间的列值，4 个角相同，
 * frame 不取小数（着色器在 `ComputeSpriteFrame(frac(...))` 里取）。帧表的网格换算全在翻译后的着色器里，这里不重写。
 *
 * WPE 项目自定义 `particle` 的布局实测是步长 52：`POSITION` 0、`TEXCOORD0` 12、`TEXCOORD2` 28、`COLOR` 36
 * （`p4-particles-REPORT.md`「顶点布局」）。我们的偏移按翻译器反射的 `attributes` 经 `vertexPacking` 排，不写死：
 * 翻译器给出的顺序是位置、`a_TexCoordVec4`、颜色、`a_TexCoordC2`，步长同样 52。
 *
 * 写入按槽序、跳过 `life == 0` 的空槽（报告「对 P4a 底座的要求」：不是年龄序），尺寸、颜色、alpha 取当前值，同 `track.ts`。
 * 拖尾系统另跳过退化的粒子（速度为 0 或平行于视线，`trailDrawable`，P4c 步骤 5）。
 */
import { identity, invert, type Mat4 } from "../render/math";
import type { PackedVertexAttribute } from "../render/programs";
import type { ParticleColumns } from "./columns";
import { f32 } from "./f32";
import type { ParticleSystem } from "./system";

/** 粒子顶点里各输入的 float 偏移；着色器没声明的为 −1（不写）。 */
export interface ParticleVertexLayout {
  /** 每个顶点的 float 数（步长 / 4）。 */
  stride: number;
  /** `a_Position`：xyz。 */
  position: number;
  /** `a_TexCoordVec4`：角点 u、v，旋转 z，尺寸。 */
  texCoord: number;
  /** `a_TexCoordC2`：旋转 x、y。 */
  rotation: number;
  /** `a_Color`：rgba。 */
  color: number;
  /** `a_TexCoordVec4C1`：速度 xyz、frame 原值（厚格式）。 */
  thick: number;
}

type LayoutField = Exclude<keyof ParticleVertexLayout, "stride">;

/** 粒子着色器认得的输入 → 布局字段与分量数（`genericparticle.vert` 的顶点展开分支）。 */
export const PARTICLE_ATTRIBUTES: Readonly<Record<string, readonly [LayoutField, number]>> = {
  a_Position: ["position", 3],
  a_TexCoordVec4: ["texCoord", 4],
  a_TexCoordC2: ["rotation", 2],
  a_Color: ["color", 4],
  a_TexCoordVec4C1: ["thick", 4],
};

/** 每粒子 4 个顶点的角点 UV：`(0,0)`、`(0,1)`、`(1,1)`、`(1,0)`（实测）。 */
export const CORNER_UVS: readonly (readonly [number, number])[] = [
  [0, 0],
  [0, 1],
  [1, 1],
  [1, 0],
];

/** 每粒子 6 个索引（两个三角形，实测）。 */
export const QUAD_INDICES: readonly number[] = [0, 1, 2, 0, 2, 3];

/**
 * 由顶点打包结果（`vertexPacking(result.attributes)`）定布局，偏移按反射排、不写死（WPE 非 GS 厚格式是 68 字节，我们按翻译器的
 * 顺序排，每粒子内容相同）。认不得的输入、分量数或类型不对的报 `render:particle-attribute:<名字>[:<分量数><类型>]`：渲染器写不了，
 * 缺了会读到 0。
 */
export function particleVertexLayout(packing: {
  layout: Pick<GPUVertexBufferLayout, "arrayStride">;
  attributes: readonly PackedVertexAttribute[];
}): { layout: ParticleVertexLayout; problems: string[] } {
  const layout: ParticleVertexLayout = {
    stride: Number(packing.layout.arrayStride) / 4,
    position: -1,
    texCoord: -1,
    rotation: -1,
    color: -1,
    thick: -1,
  };
  const problems: string[] = [];
  for (const attribute of packing.attributes) {
    const known = PARTICLE_ATTRIBUTES[attribute.name];
    if (!known) {
      problems.push(`render:particle-attribute:${attribute.name}`);
      continue;
    }
    const [field, components] = known;
    if (attribute.components !== components || attribute.kind !== "f32" || attribute.column !== 0) {
      problems.push(`render:particle-attribute:${attribute.name}:${attribute.components}${attribute.kind}`);
      continue;
    }
    layout[field] = attribute.offset / 4;
  }
  return { layout, problems };
}

/** 能写进 `into` 的粒子数。 */
export function vertexCapacity(layout: Pick<ParticleVertexLayout, "stride">, into: Float32Array): number {
  return layout.stride > 0 ? Math.floor(into.length / (4 * layout.stride)) : 0;
}

/**
 * 拖尾的眼位 `eyeLocal`（P4c 步骤 5）：着色器 `ComputeParticleTrailTangents` 的 `mul(vec4(g_EyePosition, 1.0), g_ModelMatrixInverse)`，
 * 翻译后是 `g_ModelMatrixInverse * (eye, 1)`。`model` 是这次绘制的模型矩阵（本地系统是对象世界矩阵，世界空间系统是单位阵），
 * 逆矩阵和 uniform 里写的同一个（`invert`，奇异时取单位阵，同 `staticBuiltins`），按列主序 `((m0·x + m4·y) + m8·z) + m12`
 * 逐步 float32。透视粒子（系统 `flags` bit2）的覆盖不改 `g_EyePosition`（rea-p4c-render.md 6.4），用场景的眼位。
 */
export function trailEye(eye: readonly number[], model: Mat4): [number, number, number] {
  const m = invert(model) ?? identity();
  const [x, y, z] = [f32(eye[0] ?? 0), f32(eye[1] ?? 0), f32(eye[2] ?? 0)];
  const row = (r: number) => f32(f32(f32(f32(m[r] * x) + f32(m[4 + r] * y)) + f32(m[8 + r] * z)) + m[12 + r]);
  return [row(0), row(1), row(2)];
}

/**
 * 拖尾的这个粒子画不画（P4c 步骤 5）。着色器（`common_particles.h` 的 `ComputeParticleTrailTangents`）：
 * ```
 * right = normalize(cross(p − eyeLocal, v));  s = length(v);  up = (v / s)·max(minlength, min(s·length, maxlength))
 * ```
 * 速度为 0 时 `v / 0` 与 `normalize(0)` 都是 NaN，速度平行于视线时 `right` 是 NaN，WPE 四角全是 NaN、图元被丢弃（实测 T6 的
 * `gs_out`），`minlength` 也救不回。WGSL 没有可靠的 NaN 判断（`isNan` 已从规范里删掉），`normalize(0)` 各后端结果不同，所以在
 * CPU 上照着色器的式子在 float32 里判，退化的粒子不写顶点：
 * `|v|² == 0`，或 `|cross(p − eyeLocal, v)|² == 0`。平方和的各项都不小于 0，和为 0 当且仅当每项都舍入成 0，所以加法顺序不影响判断；
 * 叉乘每个分量 `f(f(a·b) − f(c·d))`（WGSL `cross` 的定义，GPU 上可能用 FMA，只在恰好退化的边界上可能不同）。
 */
export function trailDrawable(
  columns: Pick<ParticleColumns, "position" | "velocity">,
  slot: number,
  eye: readonly number[],
): boolean {
  const vx = columns.velocity[0][slot],
    vy = columns.velocity[1][slot],
    vz = columns.velocity[2][slot];
  if (f32(f32(f32(vx * vx) + f32(vy * vy)) + f32(vz * vz)) === 0) return false;
  const dx = f32(columns.position[0][slot] - eye[0]),
    dy = f32(columns.position[1][slot] - eye[1]),
    dz = f32(columns.position[2][slot] - eye[2]);
  const cx = f32(f32(dy * vz) - f32(dz * vy)),
    cy = f32(f32(dz * vx) - f32(dx * vz)),
    cz = f32(f32(dx * vy) - f32(dy * vx));
  return f32(f32(f32(cx * cx) + f32(cy * cy)) + f32(cz * cz)) !== 0;
}

/**
 * 把存活粒子按槽序写成交错顶点（每粒子 4 个），返回写了几个粒子。`into` 放不下的粒子不写（容量按 `maxcount` 分配，
 * 存活数不会超过它）。只写布局里有的输入，其余位置保持原值。
 * `trail` 是拖尾系统（renderer 是 `spritetrail`）的眼位（`trailEye`）：给了时跳过退化的粒子（`trailDrawable`），返回实际写的
 * 粒子数；非拖尾系统传 null，速度为 0 的粒子照写。退化粒子在写顶点时跳过、不靠 GPU 丢 NaN 图元：一个系统只有一个 renderer，
 * 顶点只给这一次绘制用（以后支持多 renderer 时，拖尾那次绘制要改用自己的索引）。
 */
export function writeVertices(
  system: Pick<ParticleSystem, "columns" | "highWater">,
  layout: ParticleVertexLayout,
  into: Float32Array,
  trail: readonly number[] | null = null,
): number {
  const c = system.columns;
  const { stride, position: p, texCoord: t, rotation: r, color: k, thick: h } = layout;
  const [px, py, pz] = c.position;
  const [rx, ry, rz] = c.rotation;
  const [cr, cg, cb] = c.color;
  const [vx, vy, vz] = c.velocity;
  const { life, size, alpha, frame } = c;
  const capacity = vertexCapacity(layout, into);
  let count = 0;
  for (let i = 0; i < system.highWater && count < capacity; i++) {
    if (life[i] === 0) continue;
    if (trail && !trailDrawable(c, i, trail)) continue;
    let o = count * 4 * stride;
    for (let corner = 0; corner < 4; corner++, o += stride) {
      if (p >= 0) {
        into[o + p] = px[i];
        into[o + p + 1] = py[i];
        into[o + p + 2] = pz[i];
      }
      if (t >= 0) {
        into[o + t] = CORNER_UVS[corner][0];
        into[o + t + 1] = CORNER_UVS[corner][1];
        into[o + t + 2] = rz[i];
        into[o + t + 3] = size[i];
      }
      if (r >= 0) {
        into[o + r] = rx[i];
        into[o + r + 1] = ry[i];
      }
      if (k >= 0) {
        into[o + k] = cr[i];
        into[o + k + 1] = cg[i];
        into[o + k + 2] = cb[i];
        into[o + k + 3] = alpha[i];
      }
      if (h >= 0) {
        into[o + h] = vx[i];
        into[o + h + 1] = vy[i];
        into[o + h + 2] = vz[i];
        into[o + h + 3] = frame[i];
      }
    }
    count++;
  }
  return count;
}

/** `particles` 个粒子的索引：第 i 个粒子是 `4i + (0 1 2 0 2 3)`。顶点数超过 65536 时用 32 位。 */
export function quadIndices(particles: number): Uint16Array | Uint32Array {
  const out = particles * 4 > 0x10000 ? new Uint32Array(particles * 6) : new Uint16Array(particles * 6);
  for (let i = 0; i < particles; i++) for (let j = 0; j < 6; j++) out[i * 6 + j] = i * 4 + QUAD_INDICES[j];
  return out;
}
