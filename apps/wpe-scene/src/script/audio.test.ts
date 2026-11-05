import { describe, expect, it } from "vitest";
import { fillAudioBuffers, type AudioBuffers } from "./audio";

function buffers(size: number): AudioBuffers {
  return { left: new Float32Array(size), right: new Float32Array(size), average: new Float32Array(size) };
}

/** 左声道 i / 64、右声道 (63 - i) / 64：两边走向相反，串了声道一眼能看出来；值都能被 f32 精确表示。 */
function frame(): number[] {
  return [...Array.from({ length: 64 }, (_, i) => i / 64), ...Array.from({ length: 64 }, (_, i) => (63 - i) / 64)];
}

describe("fillAudioBuffers", () => {
  it("分辨率 64：逐段拷贝，左右声道不串，average 是两声道的均值", () => {
    const target = buffers(64);
    fillAudioBuffers(frame(), target);
    expect([...target.left]).toEqual(frame().slice(0, 64));
    expect([...target.right]).toEqual(frame().slice(64));
    expect([...target.average]).toEqual(Array(64).fill(63 / 128));
  });

  it("分辨率 32 / 16：每段取对应原始段的最大值", () => {
    const half = buffers(32);
    fillAudioBuffers(frame(), half);
    expect([...half.left]).toEqual(Array.from({ length: 32 }, (_, i) => (i * 2 + 1) / 64));
    expect([...half.right]).toEqual(Array.from({ length: 32 }, (_, i) => (63 - i * 2) / 64));

    const quarter = buffers(16);
    fillAudioBuffers(frame(), quarter);
    expect([...quarter.left]).toEqual(Array.from({ length: 16 }, (_, i) => (i * 4 + 3) / 64));
    expect([...quarter.right]).toEqual(Array.from({ length: 16 }, (_, i) => (63 - i * 4) / 64));
    expect(quarter.average[0]).toBe((3 / 64 + 63 / 64) / 2);
    expect(quarter.average[15]).toBe((63 / 64 + 3 / 64) / 2);
  });

  it("峰值不在段首或段尾时也取得到；不同声道的峰值互不影响", () => {
    const values = Array<number>(128).fill(0);
    values[1] = 0.5; // 左声道第 0 段（16 分辨率）的第二个原始段
    values[64 + 6] = 0.25; // 右声道第 1 段的第三个原始段
    const target = buffers(16);
    fillAudioBuffers(values, target);
    expect(target.left[0]).toBe(0.5);
    expect(target.right[0]).toBe(0);
    expect(target.left[1]).toBe(0);
    expect(target.right[1]).toBe(0.25);
    expect(target.average[0]).toBe(0.25);
    expect(target.average[1]).toBe(0.125);
  });

  it("后一帧覆盖前一帧，写的是同一组数组", () => {
    const target = buffers(16);
    const { left } = target;
    fillAudioBuffers(frame(), target);
    fillAudioBuffers(Array<number>(128).fill(0), target);
    expect(target.left).toBe(left);
    expect([...left].every((value) => value === 0)).toBe(true);
  });

  it("长度不是 128 的帧不写入", () => {
    const target = buffers(16);
    target.left.fill(0.5);
    target.right.fill(0.5);
    target.average.fill(0.5);
    for (const length of [0, 64, 127, 129, 256]) fillAudioBuffers(Array<number>(length).fill(1), target);
    for (const array of [target.left, target.right, target.average])
      expect([...array].every((value) => value === 0.5)).toBe(true);
  });
});
