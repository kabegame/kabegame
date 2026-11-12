import { describe, expect, it } from "vitest";
import { SceneSpectrum } from "../audio/spectrum";
import { copySpectrumToBuffers, type AudioBuffers } from "./audio";

function buffers(size: number): AudioBuffers {
  return { left: new Float32Array(size), right: new Float32Array(size), average: new Float32Array(size) };
}

/** 左声道 (i + 1) / 64、右声道 (64 − i) / 64：两边走向相反，串了声道一眼能看出来；值都能被 f32 精确表示。 */
function raw(): number[] {
  return [
    ...Array.from({ length: 64 }, (_, i) => (i + 1) / 64),
    ...Array.from({ length: 64 }, (_, i) => (64 - i) / 64),
  ];
}

describe("copySpectrumToBuffers（P4e 步骤 4：脚本缓冲改读归一化频谱）", () => {
  it("三个分辨率各拷同分辨率的块：left / right / average 分别是 L / R / A 段，值是归一化之后的", () => {
    const spectrum = new SceneSpectrum();
    spectrum.advance(raw(), 0.05);
    for (const size of [16, 32, 64] as const) {
      const target = buffers(size);
      copySpectrumToBuffers(spectrum.block(size), target);
      const block = spectrum.block(size);
      expect([...target.left]).toEqual([...block.left]);
      expect([...target.right]).toEqual([...block.right]);
      expect([...target.average]).toEqual([...block.average]);
    }
    // 归一化过：第一个有声帧峰值重置为 1、同帧再向目标靠（最响的组目标就是 1，读数 = 原值；其余组峰值降了 0.5·dt，读数比原值大），
    // 不是 Hub 原值段内取最大的那种
    const target = buffers(64);
    copySpectrumToBuffers(spectrum.block(64), target);
    expect(target.left[63]).toBe(1);
    expect(target.right[0]).toBe(1);
    const f32 = Math.fround;
    const peak0 = f32(1 - f32(f32(0.05) * 0.5));
    expect(target.left[0]).toBe(f32(f32(1 / 64) * f32(1 / peak0)));
    // average 是 A 段：16 段的 average 先平均再逐级取最大，一般不等于 (left + right) / 2
    const quarter = buffers(16);
    copySpectrumToBuffers(spectrum.block(16), quarter);
    expect(quarter.average[0]).toBe(Math.max(...spectrum.A64.subarray(0, 4)));
    expect(Math.fround((quarter.left[0] + quarter.right[0]) / 2)).not.toBe(quarter.average[0]);
  });

  it("后一帧覆盖前一帧，写的是同一组数组（脚本持有的引用不变）", () => {
    const spectrum = new SceneSpectrum();
    const target = buffers(16);
    const { left, right, average } = target;
    spectrum.advance(raw(), 0.05);
    copySpectrumToBuffers(spectrum.block(16), target);
    expect(left.some((value) => value !== 0)).toBe(true);
    // 静音：输出当帧清零
    spectrum.advance(null, 0.05);
    copySpectrumToBuffers(spectrum.block(16), target);
    expect([target.left, target.right, target.average]).toEqual([left, right, average]);
    expect(target.left).toBe(left);
    for (const array of [left, right, average]) expect(array.every((value) => value === 0)).toBe(true);
  });
});
