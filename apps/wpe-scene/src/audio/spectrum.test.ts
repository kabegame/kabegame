// P4e 步骤 4：场景频谱（rea-p4e-audio.md 3.3 的每帧归一化，`FUN_140111085` `0x140111654`–`0x1401131c1`）。
import { describe, expect, it } from "vitest";
import { SceneSpectrum } from "./spectrum";

const f32 = Math.fround;
const FPS20 = f32(0.05);
const FPS60 = f32(1 / 60);

/** 一帧原始频谱（左 64 + 右 64）：`left` / `right` 是「段号 → 值」，其余为 0。 */
function raw(left: Record<number, number> = {}, right: Record<number, number> = {}): number[] {
  const values = Array<number>(128).fill(0);
  for (const [band, value] of Object.entries(left)) values[Number(band)] = value;
  for (const [band, value] of Object.entries(right)) values[64 + Number(band)] = value;
  return values;
}

/** 同一帧原始频谱推进 n 次，返回频谱。 */
function settle(spectrum: SceneSpectrum, frame: number[] | null, dt: number, n: number): SceneSpectrum {
  for (let i = 0; i < n; i++) spectrum.advance(frame, dt);
  return spectrum;
}

/** 三块输出的拷贝（比较前后是否变了）。 */
const snapshot = (spectrum: SceneSpectrum) => [[...spectrum.spec64], [...spectrum.spec32], [...spectrum.spec16]];
const allZero = (spectrum: SceneSpectrum) => snapshot(spectrum).every((block) => block.every((value) => value === 0));

describe("SceneSpectrum（rea 3.3）", () => {
  it("稳态纯音：音所在组的段收敛到 1；同组其它段是 raw / 组峰值；别的组峰值至少 0.333·M", () => {
    // 1 kHz 在 L64[32]（L16[8]），250 Hz 在 R64[10]（R16[2]），见 rea-p4e-audio.md「a-band」
    const spectrum = settle(new SceneSpectrum(), raw({ 32: 0.6, 33: 0.3, 0: 0.06 }, { 10: 0.3 }), FPS20, 200);
    expect(spectrum.L64[32]).toBeCloseTo(1, 6);
    expect(spectrum.L16[8]).toBeCloseTo(1, 6);
    expect(spectrum.R64[10]).toBeCloseTo(1, 6);
    expect(spectrum.R16[2]).toBeCloseTo(1, 6);
    // 同组（L64[32..39]）：0.3 / 0.6
    expect(spectrum.L64[33]).toBeCloseTo(0.5, 6);
    // 组 0 的组最大 0.06 < 0.333·0.6：峰值停在 0.333·M，读数 0.06 / 0.1998
    expect(spectrum.L64[0]).toBeCloseTo(0.06 / (0.333 * 0.6), 5);
    // 没有声音的段为 0
    expect(spectrum.L64[1]).toBe(0);
    expect(spectrum.R64[0]).toBe(0);
    expect(spectrum.L16[5]).toBe(0);
  });

  it("起音：峰值重置为 1 后同帧降一步（0x140111cd2 写 1.0，0x140111daa 起照常更新），之后 1/读数 每帧减 0.5·dt/raw，直到读数 = 1", () => {
    const spectrum = new SceneSpectrum();
    // 之前静音够久：峰值是 0（建时清零）
    settle(spectrum, null, FPS20, 3);
    const tone = raw({ 32: 0.5 });
    const readings: number[] = [];
    for (let i = 0; i < 30; i++) {
      spectrum.advance(tone, FPS20);
      readings.push(spectrum.L64[32]);
    }
    // 第一帧：峰值 1 − 0.5·dt（音所在组的目标就是 M），读数 = raw / 峰值（20 fps 时 α = 1、限幅 ±1，没有平滑）
    const peak1 = f32(1 - f32(FPS20 * 0.5));
    expect(readings[0]).toBe(f32(f32(0.5) * f32(1 / peak1)));
    expect(readings[0]).toBeGreaterThan(0.5);
    // 之后差 ≥ dt 时峰值每帧降 0.5·dt，1/读数 每帧减 0.5·dt / raw = 0.05（第 19 帧峰值 0.525）
    for (let i = 1; i < 19; i++) expect(1 / readings[i - 1] - 1 / readings[i]).toBeCloseTo(0.05, 4);
    // 差 < dt 时每帧只降差的一半（0.5·min(dt, 差)）：第 20 帧峰值 0.5125；差 ≤ 1e-4 时直接到位，读数 1
    expect(readings[19]).toBeCloseTo(0.5 / 0.5125, 5);
    expect(readings[29]).toBeCloseTo(1, 6);
  });

  it("峰值升 min(dt, 差)、降 0.5·min(dt, 差)：小差额一帧追平；raw 跳得多时读数超过 1", () => {
    const spectrum = settle(new SceneSpectrum(), raw({ 32: 0.5 }), FPS20, 60);
    expect(spectrum.L64[32]).toBeCloseTo(1, 6);
    // 小差额（≤ dt）：峰值一帧追平，读数仍是 1
    spectrum.advance(raw({ 32: 0.52 }), FPS20);
    expect(spectrum.L64[32]).toBeCloseTo(1, 6);
    // 大差额：峰值只升 dt（0.52 → 0.57），读数 1 / 0.57 > 1
    spectrum.advance(raw({ 32: 1 }), FPS20);
    expect(spectrum.L64[32]).toBeCloseTo(1 / 0.57, 5);
    // 下降：峰值每帧降 0.5·dt；raw 回到 0.57 时峰值 0.57 不动，读数 1；再降到 0.3 时峰值 0.57 − 0.025
    settle(spectrum, raw({ 32: 0.57 }), FPS20, 30);
    expect(spectrum.L64[32]).toBeCloseTo(1, 6);
    spectrum.advance(raw({ 32: 0.3 }), FPS20);
    expect(spectrum.L64[32]).toBeCloseTo(0.3 / (0.57 - 0.025), 5);
  });

  it("静音（M < 1e-4）：输出当帧整块清零（含 A、32、16 段），S1、S2 不动，下次有声从旧值接着算", () => {
    // 60 fps：α = 1/3，S1 被清掉的话恢复第一帧只有 1/3
    const tone = raw({ 32: 0.5 }, { 10: 0.25 });
    const spectrum = settle(new SceneSpectrum(), tone, FPS60, 600);
    expect(spectrum.L64[32]).toBeCloseTo(1, 5);
    spectrum.advance(raw({ 32: 5e-5 }), FPS60);
    expect(allZero(spectrum)).toBe(true);
    spectrum.advance(null, FPS60);
    expect(allZero(spectrum)).toBe(true);
    spectrum.advance(tone, FPS60);
    expect(spectrum.L64[32]).toBeCloseTo(1, 4);
    expect(spectrum.R64[10]).toBeCloseTo(1, 4);
  });

  it("dt = 0（暂停、补画）或非正数：什么都不做；长度不是 128 的原值当全 0", () => {
    const spectrum = settle(new SceneSpectrum(), raw({ 32: 0.5 }), FPS20, 10);
    const before = snapshot(spectrum);
    spectrum.advance(raw({ 5: 1 }), 0);
    spectrum.advance(raw({ 5: 1 }), -0.1);
    spectrum.advance(raw({ 5: 1 }), Number.NaN);
    expect(snapshot(spectrum)).toEqual(before);
    spectrum.advance([1, 1, 1], FPS20);
    expect(allZero(spectrum)).toBe(true);
  });

  it("20 fps：α = 1（不平滑）、每帧限幅 ±1；60 fps：α = 1/3、限幅 ±2/3", () => {
    // 原值大于 1（线性幅值可以超过 1）：第一帧读数约 3 / 1.05，被限幅截到 0 + up
    const loud = raw({ 0: 3 });
    const at20 = new SceneSpectrum();
    at20.advance(loud, FPS20);
    expect(at20.L64[0]).toBe(1);
    at20.advance(loud, FPS20);
    expect(at20.L64[0]).toBe(2);
    // 往下同样限幅：原值掉到很小（仍有声，M ≥ 1e-4），读数约 0.001，一帧只降 1
    at20.advance(raw({ 0: 0.001 }), FPS20);
    expect(at20.L64[0]).toBe(1);
    const up60 = f32(40 * FPS60);
    const at60 = new SceneSpectrum();
    at60.advance(loud, FPS60);
    expect(at60.L64[0]).toBe(up60);
    at60.advance(loud, FPS60);
    expect(at60.L64[0]).toBe(f32(up60 + up60));
    // α：组 0 的峰值停在下限 0.333·M（M = 1 来自组 7），组 0 的段从 0.1 跳到 0.2（不触限幅）
    const settled = (dt: number) => settle(new SceneSpectrum(), raw({ 0: 0.1, 60: 1 }), dt, 2000);
    const inv = f32(1 / f32(0.333));
    const before = f32(f32(0.1) * inv);
    const after = f32(f32(0.2) * inv);
    for (const [dt, alpha] of [
      [FPS20, 1],
      [FPS60, f32(20 * FPS60)],
    ] as const) {
      const spectrum = settled(dt);
      expect(spectrum.L64[0]).toBeCloseTo(before, 6);
      spectrum.advance(raw({ 0: 0.2, 60: 1 }), dt);
      expect(spectrum.L64[0], `dt ${dt}`).toBeCloseTo(before + (after - before) * alpha, 6);
    }
  });

  it("A64 = (L + R)/2 先算，32 段、16 段由相邻两段取最大逐级得到（A16 一般不等于 (L16 + R16)/2）", () => {
    // 左声道峰在段 0、右声道峰在段 3：L16[0]、R16[0] 都是 1，A64 每段只有一边有声，A16[0] 约 0.5
    const spectrum = settle(new SceneSpectrum(), raw({ 0: 0.5, 40: 0.4 }, { 3: 0.5, 20: 0.2 }), FPS20, 100);
    for (let i = 0; i < 64; i++) expect(spectrum.A64[i]).toBe(f32(f32(spectrum.R64[i] + spectrum.L64[i]) * 0.5));
    for (let j = 0; j < 96; j++)
      expect(spectrum.spec32[j]).toBe(Math.max(spectrum.spec64[2 * j], spectrum.spec64[2 * j + 1]));
    for (let j = 0; j < 48; j++)
      expect(spectrum.spec16[j]).toBe(Math.max(spectrum.spec32[2 * j], spectrum.spec32[2 * j + 1]));
    expect(spectrum.L16[0]).toBeCloseTo(1, 6);
    expect(spectrum.R16[0]).toBeCloseTo(1, 6);
    expect(spectrum.A16[0]).toBeCloseTo(0.5, 6);
    // 块的布局 [L | R | A]（rea 3.1）
    expect(spectrum.block(16)).toEqual({ left: spectrum.L16, right: spectrum.R16, average: spectrum.A16 });
    expect(spectrum.block(64).average).toBe(spectrum.A64);
  });

  it("输出数组就地更新、引用不变（粒子与脚本持有引用）；disable 清零之后不再改", () => {
    const spectrum = new SceneSpectrum();
    const { L16, R16, A16, L64, spec16 } = spectrum;
    expect(L16.buffer).toBe(spec16.buffer);
    settle(spectrum, raw({ 32: 0.5 }), FPS20, 5);
    expect([spectrum.L16, spectrum.R16, spectrum.A16, spectrum.L64]).toEqual([L16, R16, A16, L64]);
    expect(spectrum.L16).toBe(L16);
    expect(L16[8]).toBeGreaterThan(0);
    spectrum.disable();
    expect(spectrum.isDisabled).toBe(true);
    expect(allZero(spectrum)).toBe(true);
    settle(spectrum, raw({ 32: 0.5 }), FPS20, 5);
    expect(allZero(spectrum)).toBe(true);
    expect(spectrum.L16).toBe(L16);
  });
});
