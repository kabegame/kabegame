/**
 * puppet 骨骼局部矩阵的纯函数（P12g，rea-p12g-localbones 第 2、4 节）：`getLocalBoneAngles` 的分解、`setLocalBoneAngles` 的重建、
 * 写入之后的子树重算。全部 float32（`Math.fround`），结合顺序照 WPE 汇编；矩阵列主序，第 c 个 4 数是第 c 列，平移在 12..14。
 */
import { mulFull } from "./math";
import { SKIN_STRIDE } from "./pose";

const f = Math.fround;

/**
 * `getLocalBoneAngles`（`0x14020fa10`）：对 `R = Rz·Ry·Rx` 求逆，弧度，不先去缩放（均匀缩放无影响，非均匀缩放让 x / y 失真）。
 * 三角函数用 `Math` 再 `fround`，与 CRT 的 `atan2f` / `sinf` / `cosf` 偶有 1 ulp 之差（按近似不复刻处理）。返回 `[x, y, z]`。
 */
export function localAngles(m: ArrayLike<number>, o: number): [number, number, number] {
  const z = f(Math.atan2(m[o + 1], m[o]));
  const n = f(f(m[o + 6] * m[o + 6]) + f(m[o + 10] * m[o + 10]));
  const y = f(Math.atan2(-m[o + 2], f(Math.sqrt(n))));
  const sz = f(Math.sin(z));
  const cz = f(Math.cos(z));
  const x = f(Math.atan2(f(f(sz * m[o + 8]) - f(cz * m[o + 9])), f(f(cz * m[o + 5]) - f(sz * m[o + 4]))));
  return [x, y, z];
}

/**
 * `setLocalBoneAngles`（`0x14020fce0`）：前三列重写成 `Rz(v.z)·Ry(v.y)·Rx(v.x)`（各列 w 写 0，原有缩放与剪切丢掉），第 4 列（平移与 w）不动。
 * `v` 是 `[x, y, z]` 弧度。
 */
export function writeLocalAngles(local: Float32Array, o: number, v: readonly [number, number, number]): void {
  const x = f(v[0]);
  const y = f(v[1]);
  const z = f(v[2]);
  const cz = f(Math.cos(z));
  const sz = f(Math.sin(z));
  const cy = f(Math.cos(y));
  const sy = f(Math.sin(y));
  const cx = f(Math.cos(x));
  const sx = f(Math.sin(x));
  local[o] = f(cy * cz);
  local[o + 1] = f(cy * sz);
  local[o + 2] = -sy;
  local[o + 3] = 0;
  local[o + 4] = f(f(f(sy * cz) * sx) - f(cx * sz));
  local[o + 5] = f(f(f(sy * sz) * sx) + f(cx * cz));
  local[o + 6] = f(sx * cy);
  local[o + 7] = 0;
  local[o + 8] = f(f(f(cx * cz) * sy) + f(sx * sz));
  local[o + 9] = f(f(f(cx * sz) * sy) - f(sx * cz));
  local[o + 10] = f(cx * cy);
  local[o + 11] = 0;
}

const temp = new Float32Array(16);

/**
 * 子树重算（`FUN_14020db40`）：从 `i` 起按下标往后扫，父在脏集合里的才算（父下标比子大的骨骼不会被算，同 WPE）。每根：
 * - `Pose[j] = 父 < 0 ? Local[j] : Pose[父]·Local[j]`（写 `world`）；
 * - `K[j] = Pose[j]·绑定逆[j]`（取 12 个数写 `skin`，布局同 `skinMatrices`）；
 * - `World[j] = W·Pose[j]`（写 `cur`）。
 * 三处都是完整 4×4 乘法（`mulFull`），不是推进用的仿射乘法，所以原样写回也会改变低位。`W` 是调用那一刻的图层矩阵，整个函数共用。
 */
export function recomputeSubtree(
  i: number,
  parents: Int32Array,
  local: Float32Array,
  inverseBind: Float32Array,
  W: Float32Array,
  world: Float32Array,
  skin: Float32Array,
  cur: Float32Array,
): void {
  const bones = parents.length;
  const dirty = new Uint8Array(bones);
  for (let j = i; j < bones; j++) {
    const parent = parents[j];
    if (j !== i && !(parent >= 0 && dirty[parent])) continue;
    dirty[j] = 1;
    if (parent < 0) world.set(local.subarray(j * 16, j * 16 + 16), j * 16);
    else {
      mulFull(world, parent * 16, local, j * 16, temp, 0);
      world.set(temp, j * 16);
    }
    mulFull(world, j * 16, inverseBind, j * 16, temp, 0);
    const o = j * SKIN_STRIDE;
    skin[o] = temp[0];
    skin[o + 1] = temp[1];
    skin[o + 2] = temp[2];
    skin[o + 3] = temp[4];
    skin[o + 4] = temp[5];
    skin[o + 5] = temp[6];
    skin[o + 6] = temp[8];
    skin[o + 7] = temp[9];
    skin[o + 8] = temp[10];
    skin[o + 9] = temp[12];
    skin[o + 10] = temp[13];
    skin[o + 11] = temp[14];
    mulFull(W, 0, world, j * 16, cur, j * 16);
  }
}
