/**
 * `boids`（operator 17，P4h 步骤 1）。依据 `rea-p4h-boids.md` 第 1–3 节（读码【确】）与 `p4-particles-REPORT.md`「P4h 语义的实测核对」
 * （`ignore/p4/h0/model.py` 的参考模型逐粒子对过 WPE 抓帧）。它是第一个粒子之间互相读的 operator：
 *
 * - **遍历（2.3）**：槽按 4 个一组（SIMD 的一个向量），组 `i` 升序，每组对全部组 `j`（含自己）比 16 对：lane `l` 的邻居是
 *   `j + ((l − k4) mod 4)`，`k4` 0..3 依次，求和顺序就是 `j` 升序、组内 `k4` 升序。没有网格、没有邻居数上限。
 * - **存活位缺陷（2.4，照抄）**：邻居「活着」判的是 `life[j + l]`（和被更新粒子同 lane 的那个槽），不随 `k4` 移位，不是邻居自己的
 *   `life`。所以死槽、未出生的槽（位置 0）只要同组同 lane 的槽活着就算邻居；被更新粒子自己是否活着不查（死槽的速度也照改）。
 *   实测：只有两颗粒子的系统就会触发（滴水场景必然受影响）。
 * - **写回（2.6、第 3 节）**：组级边算边写——一组 4 颗全部算完才写速度，后面的组读到前面组已写的速度（只影响对齐项，位置不变）。
 * - **公式（2.4、2.5）**：`d2 = (dy² + dx²) + dz²`；`d2 = 0` 的配对（自己、与自己重合的）两项都不算；邻居 `d < nbT`、分离
 *   `d < sepT`，严格 `<`；分离权重 `w = sepT/d − 1`；`Δv = ((v̄ − v)·A' + (Σw·Δp / nS)·Sep') + (p̄ − p)·C'`，系数 `X' = S·X·k`。
 *   位置不改，不乘 `h`、不乘 `instanceoverride.speed`。
 * - **限速（2.6）**：`flags` bit0（缺省 1）：`new² > max(old², maxS²)` 才乘 `maxS / |new|`。
 * - **槽范围（2.3）**：WPE 的 operator 循环到 `⌈hw/4⌉·4`，boids 读写 `[hw, ⌈hw/4⌉·4)` 里未出生的槽；调用方（`system.ts`）对带 boids 的系统
 *   把 `count` 取到那里。
 * - `rsqrtps`（距离、权重、限速缩放）与 `rcpps`（1/n）不复刻（P4h 决定，同 P4a 起的惯例）：距离用精确 `sqrt`，1/n 用精确倒数。
 */
import { f32, rcp, rsqrt } from "./f32";
import type { ParticleFields, ParticleRunContext } from "./modules";

/**
 * 分帧（2.2、2.7）：`S = floor(hw / 200) + 1`（`hw` = 高水位）。`S > 1` 时一帧只更新 `1/S` 的组、每组只看 `1/S` 的组，系数乘 `S` 补偿，
 * 起点按帧计数器 `ctx+0x144` 轮转。
 */
export function boidsStride(highWater: number): number {
  return Math.floor(highWater / 200) + 1;
}

export function boids(fields: ParticleFields, context: ParticleRunContext): void {
  const { columns, k } = context;
  const hw = context.highWater ?? context.count;
  if (hw <= 0) return;
  const S = boidsStride(hw);
  // TODO:[WPE_SCENE] 帧计数器 `ctx+0x144`（`R+0x154`）的初值未知（rea-p4h-boids.md 2.7、第 7 节），这里从 0 起、每个渲染帧加 1；两遍模式
  // 同一帧用同一个值。只在 `hw ≥ 200` 时影响结果，语料（滴水 `maxcount 16`）用不到
  const frame = context.frame ?? 0;
  const sepT = fields.separationthreshold as number;
  const nbT = fields.neighborthreshold as number;
  const maxS = fields.maxspeed as number;
  const maxS2 = f32(maxS * maxS);
  const limit = ((fields.flags as number) & 1) !== 0;
  // 2.2：`broadcast((float)S·X)·k`，先乘 S 再乘 k
  const sepK = f32(f32(S * (fields.separationfactor as number)) * k);
  const alignK = f32(f32(S * (fields.alignmentfactor as number)) * k);
  const cohK = f32(f32(S * (fields.cohesionfactor as number)) * k);
  const { life } = columns;
  const [px, py, pz] = columns.position;
  const [vx, vy, vz] = columns.velocity;
  const start = 4 * (frame % S);
  // 每个 lane 的累加器（2.4）
  const nS = new Float64Array(4);
  const nN = new Float64Array(4);
  const sep = [new Float32Array(4), new Float32Array(4), new Float32Array(4)];
  const sumV = [new Float32Array(4), new Float32Array(4), new Float32Array(4)];
  const sumP = [new Float32Array(4), new Float32Array(4), new Float32Array(4)];
  const out = [new Float32Array(4), new Float32Array(4), new Float32Array(4)];

  for (let i = start; i < hw; i += 4 * S) {
    nS.fill(0);
    nN.fill(0);
    for (let c = 0; c < 3; c++) {
      sep[c].fill(0);
      sumV[c].fill(0);
      sumP[c].fill(0);
    }
    for (let j = 4 * ((frame + i) % S); j < hw; j += 4 * S) {
      for (let l = 0; l < 4; l++) {
        const me = i + l;
        const alive = life[j + l] !== 0; // 缺陷照抄：不随邻居 lane 移位（2.4）
        for (let k4 = 0; k4 < 4; k4++) {
          const o = j + ((l - k4 + 4) % 4);
          const dx = f32(px[me] - px[o]);
          const dy = f32(py[me] - py[o]);
          const dz = f32(pz[me] - pz[o]);
          const d2 = f32(f32(f32(dy * dy) + f32(dx * dx)) + f32(dz * dz));
          // 自己、与自己重合的：WPE 里 `rsqrtps(0)·0 = NaN`，两项都不算
          if (d2 === 0 || !alive) continue;
          const d = f32(Math.sqrt(d2));
          if (d < sepT) {
            const w = f32(f32(rcp(d) * sepT) - 1);
            nS[l]++;
            sep[0][l] = f32(sep[0][l] + f32(w * dx));
            sep[1][l] = f32(sep[1][l] + f32(w * dy));
            sep[2][l] = f32(sep[2][l] + f32(w * dz));
          }
          if (d < nbT) {
            nN[l]++;
            sumV[0][l] = f32(sumV[0][l] + vx[o]);
            sumV[1][l] = f32(sumV[1][l] + vy[o]);
            sumV[2][l] = f32(sumV[2][l] + vz[o]);
            sumP[0][l] = f32(sumP[0][l] + px[o]);
            sumP[1][l] = f32(sumP[1][l] + py[o]);
            sumP[2][l] = f32(sumP[2][l] + pz[o]);
          }
        }
      }
    }
    // 2.5、2.6：先把 4 个 lane 全算完，再一起写（组内互相读旧值）
    for (let l = 0; l < 4; l++) {
      const me = i + l;
      const invS = nS[l] !== 0 ? f32(rcp(nS[l]) * sepK) : 0;
      const invN = nN[l] !== 0 ? rcp(nN[l]) : 0;
      const a = nN[l] !== 0 ? alignK : 0;
      const co = nN[l] !== 0 ? cohK : 0;
      const v = [vx[me], vy[me], vz[me]];
      const p = [px[me], py[me], pz[me]];
      const nv = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        const align = f32(f32(f32(invN * sumV[c][l]) - v[c]) * a);
        const cohesion = f32(f32(f32(invN * sumP[c][l]) - p[c]) * co);
        const delta = f32(f32(align + f32(invS * sep[c][l])) + cohesion);
        nv[c] = f32(delta + v[c]);
      }
      if (limit) {
        const old2 = f32(f32(f32(v[1] * v[1]) + f32(v[0] * v[0])) + f32(v[2] * v[2]));
        const new2 = f32(f32(f32(nv[1] * nv[1]) + f32(nv[0] * nv[0])) + f32(nv[2] * nv[2]));
        if (new2 > Math.max(old2, maxS2)) {
          const scale = f32(rsqrt(new2) * maxS);
          for (let c = 0; c < 3; c++) nv[c] = f32(nv[c] * scale);
        }
      }
      for (let c = 0; c < 3; c++) out[c][l] = nv[c];
    }
    for (let l = 0; l < 4; l++) {
      vx[i + l] = out[0][l];
      vy[i + l] = out[1][l];
      vz[i + l] = out[2][l];
    }
  }
}
