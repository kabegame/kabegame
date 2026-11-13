/**
 * P5d 步骤 2 的相机数学（`render/camera.ts`、`render/shake.ts` 的 `shakeOffset3`），数值来自 p5-REPORT「P5d 语义的实测核对」：
 * - `perspectiveRH`：`p5d-persp`（1920×1080，缺省 fov 50 / nearz 0.1 / farz 10000）、`p5d-persp-1280x1024`、`p5d-persp-b`
 *   （fov 30、nearz 1、farz 100）；
 * - `lookAtRH` 与视图向量：`p5d-tilt`（eye (6, 4, 10) 看原点）；
 * - 路径状态机：`ignore/p5/d0/gen_d.py` 的 `KBCAM` 与 `sim_path.py` 的逐帧推法（dt 取 0.25，二进制精确，免得 float 累加左右切换时刻），
 *   硬切、循环、单关键帧保持、rea-p5-camera 3.3 的两个怪癖；
 * - 三维抖动：`p5d-shakep`（roughness 1）与 `p5d-shakep-r`（roughness 0.1，临界不改长度）抓帧里的 `g_EyePosition`。
 */
import { describe, expect, it } from "vitest";
import type { CameraPath } from "../compile/camera";
import {
  initialCameraPathState,
  lookAtRH,
  lookAtVectors,
  pathEase,
  perspectiveCamera,
  perspectiveFov,
  perspectiveRH,
  replayCameraPath,
  stepCameraPath,
  stepCameraSource,
  usesCameraPaths,
  type CameraPathState,
} from "./camera";
import { multiply, transformPoint } from "./math";
import { shakeOffset3 } from "./shake";

const f = Math.fround;
const NO_SHAKE = { camerashake: false, camerashakespeed: 3, camerashakeamplitude: 0.5, camerashakeroughness: 1 };
const DEFAULT_FIELDS = { fov: 50, nearz: 0.1, farz: 10000, ...NO_SHAKE };

describe("perspectiveRH：反向深度的 PerspectiveFovRH（rea-p5-camera 1.1，p5d-persp 实测）", () => {
  it("p5d-persp（1920×1080，fov 50、nearz 0.1、farz 10000）：m00 1.206285、m11 2.144507、m22 1.00001e-5、m23 −1", () => {
    const m = perspectiveRH(perspectiveFov(50), f(1920 / 1080), f(0.1), f(10000));
    expect(m[0]).toBeCloseTo(1.206285, 5);
    expect(m[5]).toBeCloseTo(2.144507, 5);
    expect(m[10]).toBeCloseTo(1.00001e-5, 10);
    expect(m[11]).toBe(-1);
    expect(m[14]).toBeCloseTo(0.1000010000100001, 6);
    // 其余为 0
    for (const i of [1, 2, 3, 4, 6, 7, 8, 9, 12, 13, 15]) expect(m[i], String(i)).toBe(0);
  });

  it("p5d-persp-1280x1024：宽高比取窗口，m00 = 2.144507 / 1.25 = 1.715605，m11 不变", () => {
    const m = perspectiveRH(perspectiveFov(50), f(1280 / 1024), f(0.1), f(10000));
    expect(m[0]).toBeCloseTo(1.715605, 5);
    expect(m[5]).toBeCloseTo(2.144507, 5);
  });

  it("p5d-persp-b（fov 30、nearz 1、farz 100）：m11 = cot 15° = 3.732051、m22 = 1/99、m32 = 100/99", () => {
    const m = perspectiveRH(perspectiveFov(30), f(16 / 9), 1, 100);
    expect(m[5]).toBeCloseTo(3.732051, 5);
    expect(m[10]).toBeCloseTo(1 / 99, 7);
    expect(m[14]).toBeCloseTo(100 / 99, 6);
  });

  it("深度：z_view = −near 时 1、−far 时 0（反向深度，近处大）", () => {
    const m = perspectiveRH(perspectiveFov(30), 1, 1, 100);
    const ndc = (z: number) => {
      const [, , cz, w] = transformPoint(m, 0, 0, z);
      return cz / w;
    };
    expect(ndc(-1)).toBeCloseTo(1, 6);
    expect(ndc(-100)).toBeCloseTo(0, 6);
    expect(ndc(-10)).toBeGreaterThan(ndc(-50));
  });

  it("fov 钳到 [0.1, 179.9] 度（0x140189b12），非数取缺省 50", () => {
    expect(perspectiveFov(0)).toBe(perspectiveFov(0.1));
    expect(perspectiveFov(-30)).toBe(perspectiveFov(0.1));
    expect(perspectiveFov(200)).toBe(perspectiveFov(179.9));
    expect(perspectiveFov(Number.NaN)).toBe(perspectiveFov(50));
    expect(perspectiveFov(50)).toBeCloseTo((50 * Math.PI) / 180, 6);
    // 179.9 度时 m11 很小但有限
    expect(perspectiveRH(perspectiveFov(1000), 1, 0.1, 10)[5]).toBeCloseTo(1 / Math.tan((179.9 * Math.PI) / 360), 4);
  });
});

describe("lookAtRH 与视图向量（rea-p5-camera 1.2、8，p5d-tilt 实测）", () => {
  const eye: [number, number, number] = [6, 4, 10];
  const origin: [number, number, number] = [0, 0, 0];
  const up: [number, number, number] = [0, 1, 0];

  it("p5d-tilt：forward / right / up 是 f、normalize(f × up)、s × f", () => {
    const v = lookAtVectors(eye, origin, up);
    const close = (a: readonly number[], b: readonly number[]) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i], 5));
    close(v.forward, [-0.48666, -0.32444, -0.81111]);
    close(v.right, [0.85749, 0, -0.5145]);
    close(v.up, [-0.16692, 0.94591, -0.27821]);
  });

  it("V 的行是 (s, u, −f)、平移 (−s·eye, −u·eye, f·eye)：eye 落到原点，center 落在 −Z 上", () => {
    const v = lookAtRH(eye, origin, up);
    const { forward, right, up: u } = lookAtVectors(eye, origin, up);
    // 列主序：m[c * 4 + r]
    expect([v[0], v[4], v[8]].map((x) => +x.toFixed(5))).toEqual(right.map((x) => +f(x).toFixed(5)));
    expect([v[1], v[5], v[9]].map((x) => +x.toFixed(5))).toEqual(u.map((x) => +f(x).toFixed(5)));
    expect([v[2], v[6], v[10]].map((x) => +x.toFixed(5))).toEqual(forward.map((x) => +f(-x).toFixed(5)));
    expect([v[3], v[7], v[11], v[15]]).toEqual([0, 0, 0, 1]);
    const [ex, ey, ez] = transformPoint(v, ...eye);
    expect(Math.hypot(ex, ey, ez)).toBeLessThan(1e-5);
    const [cx, cy, cz] = transformPoint(v, 0, 0, 0);
    expect(Math.abs(cx) + Math.abs(cy)).toBeLessThan(1e-5);
    expect(cz).toBeCloseTo(-Math.hypot(6, 4, 10), 4);
  });

  it("p5d-tilt 的 VP m00 = s.x · cot 25°/(16/9) = 1.03438（行向量 V·P 的 m00 = 这里 P·V 的下标 0）", () => {
    const frame = perspectiveCamera({
      pose: { eye, center: origin, up, zoom: 1 },
      fields: DEFAULT_FIELDS,
      time: 0,
      width: 1920,
      height: 1080,
    });
    expect(frame.viewProjection[0]).toBeCloseTo(1.03438, 4);
    expect(frame.eye).toEqual([6, 4, 10]);
    expect(Array.from(frame.viewProjection)).toEqual(Array.from(multiply(frame.projection, frame.view)));
  });

  it("p5d-persp 的正对相机：视图向量是 (0, 0, −1)、(1, 0, 0)、(0, 1, 0)，g_EyePosition = eye", () => {
    const frame = perspectiveCamera({
      pose: { eye: [0, 0, 10], center: [0, 0, 0], up: [0, 1, 0], zoom: 1 },
      fields: DEFAULT_FIELDS,
      time: 9.1,
      width: 1920,
      height: 1080,
    });
    expect(frame.vectors).toEqual({ forward: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0] });
    expect(frame.eye).toEqual([0, 0, 10]);
    expect(frame.viewProjection[0]).toBeCloseTo(1.206285, 5);
    expect(frame.viewProjection[5]).toBeCloseTo(2.144507, 5);
  });

  it("up 与视线平行：右向量是 0（XMVector3Normalize 的零长度），不出 NaN", () => {
    const v = lookAtVectors([0, 5, 0], [0, 0, 0], [0, 1, 0]);
    expect(v.right).toEqual([0, 0, 0]);
    expect(v.forward).toEqual([0, -1, 0]);
  });
});

/** `gen_d.py` 的 KBCAM（`p5d-path`）：第一条 3 个关键帧（eye.x 0 → 2 → 6，duration 4），第二条 1 个关键帧（eye (0, 3, 10)，duration 2）。 */
const KBCAM: CameraPath[] = [
  {
    duration: 4,
    keys: [0, 2, 4].map((t, i) => ({
      t,
      eye: [[0, 2, 6][i], 0, 10],
      center: [[0, 2, 6][i], 0, 0],
      up: [0, 1, 0],
      zoom: 1,
    })),
  },
  { duration: 2, keys: [{ t: 0, eye: [0, 3, 10], center: [0, 3, 0], up: [0, 1, 0], zoom: 1 }] },
];

/** 逐帧推进，返回每帧求值的 eye 与求值时的状态。 */
function run(paths: CameraPath[], dts: number[], state: CameraPathState = initialCameraPathState()) {
  const out: { eye: number[]; state: CameraPathState }[] = [];
  for (const dt of dts) {
    const { pose, next } = stepCameraPath(paths, state, dt);
    out.push({ eye: pose.eye, state });
    state = next;
  }
  return { frames: out, state };
}

describe("路径状态机（rea-p5-camera 3.2【确】，p5d-path 实测）", () => {
  it("段内插值系数 −s³ + 1.5s² + 0.5s：两端 0 / 1，中点 0.5，两端速度是中间的 0.4 倍", () => {
    expect(pathEase(0)).toBe(0);
    expect(pathEase(1)).toBe(1);
    expect(pathEase(0.5)).toBe(0.5);
    const slope = (s: number) => (pathEase(s + 1e-6) - pathEase(s - 1e-6)) / 2e-6;
    expect(slope(1e-6) / slope(0.5)).toBeCloseTo(0.4, 4);
  });

  it("KBCAM、dt 0.25：第一条 17 帧（t 0…4），切到第二条保持 9 帧（t 0…2），再回到第一条", () => {
    const { frames } = run(KBCAM, new Array(30).fill(0.25));
    const xs = frames.map((frame) => frame.eye[0]);
    // 第一条：t = 0、0.25、1、2（段末取 k1）、2.25（第二段 s = 0.125）、3、4（s = 1）
    expect(xs[0]).toBe(0);
    expect(xs[1]).toBe(f(2 * pathEase(0.125)));
    expect(xs[4]).toBe(1);
    expect(xs[8]).toBe(2);
    expect(xs[9]).toBe(f(2 + 4 * pathEase(0.125)));
    expect(xs[12]).toBe(4);
    expect(xs[16]).toBe(6);
    // 第二条：硬切，eye (0, 3, 10)，保持到 t = 2（含）
    for (let i = 17; i <= 25; i++) expect(frames[i].eye, String(i)).toEqual([0, 3, 10]);
    expect(frames[17].state).toEqual({ path: 1, key: 0, t: 0 });
    // 循环回第一条，t 归零
    expect(frames[26].state).toEqual({ path: 0, key: 0, t: 0 });
    expect(frames[26].eye).toEqual([0, 0, 10]);
  });

  it("先求值、后推进：第一帧取 t = 0 的值，与 dt 大小无关", () => {
    expect(stepCameraPath(KBCAM, initialCameraPathState(), 3).pose.eye).toEqual([0, 0, 10]);
    expect(stepCameraPath(KBCAM, initialCameraPathState(), 3).next).toEqual({ path: 0, key: 1, t: 3 });
  });

  it("切换路径时 t = 0、余量丢掉；关键帧之间不清 t（本路径内的绝对时间）", () => {
    // t = 3.9 再推 0.5 → 4.4 > 4：切到第二条，t = 0 而不是 0.4
    expect(stepCameraPath(KBCAM, { path: 0, key: 1, t: f(3.9) }, 0.5).next).toEqual({ path: 1, key: 0, t: 0 });
    // t = 1.9 再推 0.5 → 2.4 > 2：换关键帧，t 接着累加
    expect(stepCameraPath(KBCAM, { path: 0, key: 0, t: f(1.9) }, 0.5).next).toEqual({ path: 0, key: 1, t: f(2.4) });
  });

  it("补画帧 dt 0：状态不变", () => {
    const state = { path: 0, key: 1, t: 2.5 };
    expect(stepCameraPath(KBCAM, state, 0).next).toEqual(state);
  });

  it("单关键帧保持（neon_sunset：t = 0、duration 5）：一直取这一帧，过了 duration 回到自己、t 归零", () => {
    const single: CameraPath[] = [
      { duration: 5, keys: [{ t: 0, eye: [1, 2, 3], center: [0, 0, 0], up: [0, 1, 0], zoom: 2 }] },
    ];
    const { frames, state } = run(single, new Array(22).fill(0.25));
    for (const frame of frames) expect(frame.eye).toEqual([1, 2, 3]);
    // t = 5 时还在（不大于段末），5.25 时回到 0
    expect(frames[20].state.t).toBe(5);
    expect(frames[21].state.t).toBe(0);
    expect(state.path).toBe(0);
  });

  it("怪癖 1（3.3）：最后一帧的段末是 duration − k[last].t（t 是绝对时间），k[last].t > duration/2 时下一帧就切走", () => {
    const paths: CameraPath[] = [
      {
        duration: 4,
        keys: [
          { t: 0, eye: [0, 0, 0], center: [0, 0, -1], up: [0, 1, 0], zoom: 1 },
          { t: 3, eye: [3, 0, 0], center: [3, 0, -1], up: [0, 1, 0], zoom: 1 },
        ],
      },
    ];
    const { frames } = run(paths, new Array(16).fill(0.25));
    expect(frames[12].eye[0]).toBe(3); // t = 3：插值到段末
    expect(frames[13].state).toEqual({ path: 0, key: 1, t: 3.25 });
    expect(frames[13].eye[0]).toBe(3); // 最后一帧只保持这一帧
    expect(frames[14].state).toEqual({ path: 0, key: 0, t: 0 }); // 3.5 > 4 − 3：切走
  });

  it("怪癖 2（3.3）：t < k[0].t 时段末是 k[0].t + k[1].t，一大步跨过 k[0] 也不换关键帧，下一帧外插", () => {
    const paths: CameraPath[] = [
      {
        duration: 3,
        keys: [
          { t: 1, eye: [0, 0, 0], center: [0, 0, -1], up: [0, 1, 0], zoom: 1 },
          { t: 2, eye: [2, 0, 0], center: [2, 0, -1], up: [0, 1, 0], zoom: 1 },
        ],
      },
    ];
    const first = stepCameraPath(paths, initialCameraPathState(), 2.5);
    expect(first.pose.eye).toEqual([0, 0, 0]);
    expect(first.next).toEqual({ path: 0, key: 0, t: 2.5 }); // 2.5 ≤ 1 + 2
    // s = 1.5：pathEase(1.5) = 0.75
    expect(stepCameraPath(paths, first.next, 0).pose.eye[0]).toBe(1.5);
  });

  it("up 照线性插值、不归一化；zoom 同样插值（透视下不起作用）", () => {
    const paths: CameraPath[] = [
      {
        duration: 2,
        keys: [
          { t: 0, eye: [0, 0, 1], center: [0, 0, 0], up: [0, 1, 0], zoom: 1 },
          { t: 2, eye: [0, 0, 1], center: [0, 0, 0], up: [1, 0, 0], zoom: 3 },
        ],
      },
    ];
    const pose = stepCameraPath(paths, { path: 0, key: 0, t: 1 }, 0).pose;
    expect(pose.up).toEqual([0.5, 0.5, 0]);
    expect(pose.zoom).toBe(2);
  });

  it("t 按 float32 累加（WPE 的 G+0xec 是 float）", () => {
    const { state } = run(KBCAM, new Array(10).fill(0.1));
    let t = 0;
    for (let i = 0; i < 10; i++) t = f(t + f(0.1));
    expect(state.t).toBe(t);
  });

  it("状态越界（路径表变了）从头开始", () => {
    expect(stepCameraPath(KBCAM, { path: 5, key: 0, t: 1 }, 0).pose.eye).toEqual([0, 0, 10]);
    expect(stepCameraPath(KBCAM, { path: 1, key: 3, t: 1 }, 0).pose.eye).toEqual([0, 0, 10]);
  });

  it("replayCameraPath：从加载时的状态按逐帧 dt 推；没有路径时恒为初始状态", () => {
    expect(replayCameraPath(KBCAM, new Array(17).fill(0.25))).toEqual({ path: 1, key: 0, t: 0 });
    expect(replayCameraPath(KBCAM, [])).toEqual(initialCameraPathState());
    expect(replayCameraPath([], [1, 2, 3])).toEqual(initialCameraPathState());
    expect(usesCameraPaths([])).toBe(false);
    expect(usesCameraPaths([{ duration: 1, keys: [] }])).toBe(false);
  });

  it("stepCameraSource：没有路径用基准（状态不动），有路径走路径", () => {
    const base = { eye: [6, 4, 10] as [number, number, number], center: [0, 0, 0] as [number, number, number] };
    const camera = { ...base, up: [0, 1, 0] as [number, number, number], paths: [] };
    const state = { path: 0, key: 0, t: 0.5 };
    expect(stepCameraSource(camera, state, 0.25)).toEqual({
      pose: { eye: [6, 4, 10], center: [0, 0, 0], up: [0, 1, 0], zoom: 1 },
      next: state,
    });
    expect(stepCameraSource({ ...camera, paths: KBCAM }, initialCameraPathState(), 0.25).pose.eye).toEqual([0, 0, 10]);
  });
});

describe("三维抖动 shakeOffset3（rea-p5-camera 第 5 节）", () => {
  const fields = (roughness: number) => ({
    camerashake: true,
    camerashakespeed: 1,
    camerashakeamplitude: 1,
    camerashakeroughness: roughness,
  });

  it("p5d-shakep（speed 1、amplitude 1、roughness 1）：g_EyePosition − (0, 0, 10) 与公式相同", () => {
    const time = 8.999231338500977;
    const offset = shakeOffset3(fields(1), time);
    expect(offset[0]).toBeCloseTo(-0.09108132123947144, 6);
    expect(offset[1]).toBeCloseTo(-0.05399654433131218, 6);
    expect(offset[2]).toBeCloseTo(10.041281700134277 - 10, 5);
  });

  it("p5d-shakep-r（roughness 0.1）：e = 0.001f 正好在临界上，不改长度", () => {
    const time = 9.103206634521484;
    const offset = shakeOffset3(fields(0.1), time);
    expect(offset[0]).toBeCloseTo(-0.09487399458885193, 6);
    expect(offset[1]).toBeCloseTo(-0.04185032472014427, 6);
    expect(offset[2]).toBeCloseTo(10.03160572052002 - 10, 5);
  });

  it("幅度是 0.1·amplitude 个世界单位（不乘场景高）；roughness 2 时长度指数作用在三维长度上", () => {
    const t = 1.3;
    const base = shakeOffset3(fields(1), t);
    const v = [Math.cos(t), Math.sin(1.333 * t), Math.sin(t)];
    base.forEach((x, i) => expect(x).toBeCloseTo(0.1 * v[i], 6));
    const rough = shakeOffset3(fields(2), t);
    const length = Math.hypot(...v);
    rough.forEach((x, i) => expect(x).toBeCloseTo(0.1 * (v[i] / length) * Math.pow(length, 8), 5));
    expect(shakeOffset3({ ...fields(1), camerashake: false }, t)).toEqual([0, 0, 0]);
  });

  it("perspectiveCamera：eye 与 center 加同一个偏移（纯平移），视图向量不变", () => {
    const pose = { eye: [0, 0, 10] as [number, number, number], center: [0, 0, 0] as [number, number, number] };
    const input = { pose: { ...pose, up: [0, 1, 0] as [number, number, number], zoom: 1 }, width: 1920, height: 1080 };
    const time = 8.999231338500977;
    const shaken = perspectiveCamera({ ...input, fields: { ...DEFAULT_FIELDS, ...fields(1) }, time });
    const offset = shakeOffset3(fields(1), time);
    expect(shaken.eye).toEqual([f(offset[0]), f(offset[1]), f(10 + offset[2])]);
    expect(shaken.center).toEqual(offset.map((x) => f(x)));
    expect(shaken.vectors).toEqual({ forward: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0] });
  });
});
