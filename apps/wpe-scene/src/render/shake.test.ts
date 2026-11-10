/**
 * P5a 步骤 3（抖动）的公式：`shake.ts` 的 `shakeOffset`。GpuScene 的矩阵、眼位、指针反投影与渲染器的帧顺序在 `parallax.test.ts`
 * 「抖动」两节（共用那里的假设备）。
 * 期望值取 WPE 实测（步骤 0，`ignore/p5/a0/shake_table.py` 导出）：s = `g_EyePosition` − (W/2, H/2)，`g_EyePosition` 是 float32，
 * 960 附近的 ulp 是 6.1e-5，容差取 2e-3。
 */
import { describe, expect, it } from "vitest";
import { shakeOffset, type ShakeFields } from "./shake";

const H = 1080;

function fields(speed: number, amplitude: number, roughness: number, camerashake = true): ShakeFields {
  return {
    camerashake,
    camerashakespeed: speed,
    camerashakeamplitude: amplitude,
    camerashakeroughness: roughness,
  };
}

/** 按 double 算的同一个公式（不取整）：只在 `roughness 0.1` 的临界值上和 float 版分叉。 */
function doubleShake(speed: number, amplitude: number, roughness: number, time: number): [number, number] {
  const e = roughness ** 3;
  const amp = 0.01 * amplitude * H;
  const t = speed * speed * time;
  let x = Math.cos(t);
  let y = Math.sin(1.333 * t);
  if (e > 0.001 && e !== 1) {
    const length = Math.hypot(x, y);
    const scale = length ** e;
    x = (x / length) * scale;
    y = (y / length) * scale;
  }
  return [x * amp, y * amp];
}

/** 步骤 0 的实测（计划「步骤 3 — 抖动」点 6 的表）。 */
const MEASURED: {
  project: string;
  speed: number;
  amplitude: number;
  roughness: number;
  time: number;
  s: [number, number];
}[] = [
  {
    project: "shake1",
    speed: 1,
    amplitude: 1,
    roughness: 1,
    time: 5.152159690856934,
    s: [4.597900390625, 5.96051025390625],
  },
  {
    project: "shake1",
    speed: 1,
    amplitude: 1,
    roughness: 1,
    time: 5.315052509307861,
    s: [6.12188720703125, 7.76080322265625],
  },
  {
    project: "shaker2",
    speed: 1,
    amplitude: 1,
    roughness: 2,
    time: 5.149637699127197,
    s: [0.35247802734375, 0.45709228515625],
  },
  {
    project: "shaker2",
    speed: 1,
    amplitude: 1,
    roughness: 2,
    time: 5.340617656707764,
    s: [4.318115234375, 5.45074462890625],
  },
  {
    project: "shaker01",
    speed: 1,
    amplitude: 1,
    roughness: 0.1,
    time: 5.100968837738037,
    s: [4.09185791015625, 5.33258056640625],
  },
  {
    project: "shaker005",
    speed: 1,
    amplitude: 1,
    roughness: 0.05,
    time: 5.100132942199707,
    s: [4.08349609375, 5.3221435546875],
  },
  {
    project: "shakes3",
    speed: 3,
    amplitude: 0.5,
    roughness: 1,
    time: 5.165701389312744,
    s: [-4.35516357421875, -4.08856201171875],
  },
  {
    project: "shakes3",
    speed: 3,
    amplitude: 0.5,
    roughness: 1,
    time: 5.336287498474121,
    s: [-3.34527587890625, 5.00836181640625],
  },
];

describe("shakeOffset（p5-REPORT 实测）", () => {
  it.each(MEASURED)("$project（$speed / $amplitude / $roughness）g_Time $time", (item) => {
    const [x, y] = shakeOffset(fields(item.speed, item.amplitude, item.roughness), item.time, H);
    expect(Math.abs(x - item.s[0])).toBeLessThan(2e-3);
    expect(Math.abs(y - item.s[1])).toBeLessThan(2e-3);
  });

  it("关着时 (0, 0)，不看别的字段与时间", () => {
    expect(shakeOffset(fields(3, 0.5, 1, false), 5.1, H)).toEqual([0, 0]);
    expect(shakeOffset(fields(1, 1, 2, false), 1234.5, 4320)).toEqual([0, 0]);
  });

  it("roughness 0.1：powf(0.1f, 3) 等于 0.001f，「e > 0.001」为假、不改长度；按 double 算会改，差约 2.5 像素", () => {
    expect(Math.fround(Math.pow(Math.fround(0.1), 3))).toBe(Math.fround(0.001));
    const item = MEASURED.find((entry) => entry.project === "shaker01")!;
    const float = shakeOffset(fields(1, 1, 0.1), item.time, H);
    // 不改长度：和 roughness 1（e = 1，同样跳过）逐位相同
    expect(float).toEqual(shakeOffset(fields(1, 1, 1), item.time, H));
    const double = doubleShake(1, 1, 0.1, item.time);
    expect(Math.abs(double[0] - item.s[0])).toBeGreaterThan(2);
    expect(Math.abs(double[0] - float[0])).toBeGreaterThan(2);
    // 其余几组 double 版也在容差里：分叉只在临界值上
    for (const entry of MEASURED.filter((row) => row.roughness !== 0.1)) {
      const [x, y] = doubleShake(entry.speed, entry.amplitude, entry.roughness, entry.time);
      expect(Math.abs(x - entry.s[0])).toBeLessThan(2e-3);
      expect(Math.abs(y - entry.s[1])).toBeLessThan(2e-3);
    }
  });

  it("roughness 2 改长度、方向不变；幅度按场景的正交高 H 线性缩放", () => {
    const time = 5.149637699127197;
    const plain = shakeOffset(fields(1, 1, 1), time, H);
    const rough = shakeOffset(fields(1, 1, 2), time, H);
    expect(Math.atan2(rough[1], rough[0])).toBeCloseTo(Math.atan2(plain[1], plain[0]), 5);
    // |v| = L 时改成 L^8
    const length = Math.hypot(plain[0], plain[1]) / 10.8;
    expect(Math.hypot(rough[0], rough[1]) / 10.8).toBeCloseTo(length ** 8, 5);
    const [x, y] = shakeOffset(fields(1, 1, 1), time, 2160);
    expect(x).toBeCloseTo(plain[0] * 2, 4);
    expect(y).toBeCloseTo(plain[1] * 2, 4);
  });
});
