/**
 * P5a 收尾（回放逐帧光标）：dev 探针的逐帧指针（`replayPointers.ts`）与回放到读回帧的统一顺序（`particleCorners.ts` 的
 * `replayReadback`）。探针本身要 GPU，跑不了单测；这里用记录调用的假场景核对：
 * - 每帧都是同一个点（不给新字段、或窗口和场景同尺寸）时，调用序列与加逐帧指针之前的写法（下面的 `legacyReadback`，照抄自改动前的
 *   `renderFrame`）逐项相同；
 * - 逐帧指针：第 i 帧步进用第 i 项的 cursor、视差点用第 i 项，读回帧的 `g_PointerPositionLast` 是上一帧的；
 * - 窗口和场景不同尺寸时 cursor 按 `fill` 换算，与 kbp replay（`replayLib.ts` 的 `"track"` 分支）同一个式子。
 */
import { describe, expect, it, vi } from "vitest";
import { generalDefaults, type GeneralValues } from "../compile/bindings";
import { sceneCursor, scenePlacement } from "../render/layout";
import {
  advanceParallax,
  drawParallax,
  initialParallaxState,
  parallaxInput,
  replayParallax,
  type ParallaxState,
} from "../render/parallax";
import type { SceneState } from "../render/state";
import { silentParticleAudio } from "../particles/audio";
import { frameCamera, replayParticles, replayReadback, type ParticleReplay } from "./particleCorners";
import { checkCanvas, pointerWindow, replayPointers, sceneCursors, windowPointer } from "./replayPointers";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

type Point = [number, number];
const SCENE: Point = [1920, 1080];

/** 开着抖动与视差（有延迟、跟随指针）的 general，调用记录里相机与视差点都会变。 */
function state(): SceneState {
  const general: GeneralValues = {
    ...generalDefaults(),
    camerashake: true,
    camerashakespeed: 1,
    camerashakeamplitude: 1,
    camerashakeroughness: 1,
    cameraparallax: true,
    cameraparallaxamount: 0.5,
    cameraparallaxdelay: 2.7,
    cameraparallaxmouseinfluence: 1,
    zoom: 1.25,
  };
  return { general } as unknown as SceneState;
}

/** 记下每次调用（参数拷贝成普通数组 / 对象）的假场景。 */
function recorder() {
  const calls: unknown[] = [];
  const scene = {
    stepParticles: (dt: number, time: number, _state?: SceneState, cursor?: readonly [number, number]) =>
      void calls.push(["step", dt, time, cursor ? [...cursor] : null]),
    setCamera: ({ shake, zoom }: { shake: readonly [number, number]; zoom: number }) =>
      void calls.push(["camera", [...shake], zoom]),
    sync: () => void calls.push(["sync"]),
    setParallax: (next: unknown) => void calls.push(["parallax", structuredClone(next)]),
    update: (frame: unknown) => void calls.push(["update", structuredClone(frame)]),
  };
  return { calls, scene };
}

/** 改动前 `renderFrame` 的读回段（只有一个固定的 `pointer`），逐行照抄，作对照。 */
function legacyReadback(
  scene: ReturnType<typeof recorder>["scene"],
  sceneState: SceneState,
  particles: ParticleReplay | undefined,
  startTime: number,
  pointer: Point,
  start: ParallaxState,
  [sceneWidth, sceneHeight]: Point,
): void {
  const parallaxFrame = { pointer, width: sceneWidth, height: sceneHeight };
  const shake = frameCamera(scene, sceneState, sceneHeight);
  const { time, frametime } = replayParticles(scene, sceneState, particles, startTime, pointer, shake.apply);
  scene.sync();
  scene.stepParticles(frametime, time, sceneState, pointer);
  shake.apply(time);
  const replayed = particles?.dts ?? [];
  const parallax = replayParallax(
    start,
    sceneState.general,
    parallaxFrame,
    [...replayed.slice(0, -1), frametime],
    shake.eyes,
  );
  scene.setParallax(drawParallax(parallax, sceneState.general));
  scene.update({
    time,
    frametime,
    daytime: 0.5,
    pointer,
    pointerLast: pointer,
    cursor: pointer,
    parallax: parallax.position,
  });
}

const PARTICLES: ParticleReplay = { dts: [0.05, 0.0625, 0.04, 0.05], times: [0.05, 0.1125, 0.1525, 0.2025] };

function readback(options: Parameters<typeof replayPointers>[0], particles: ParticleReplay | undefined, time = 0) {
  const { calls, scene } = recorder();
  const s = state();
  const pointers = replayPointers(options, SCENE, particles?.dts.length);
  const result = replayReadback(scene, s, {
    particles,
    time,
    pointers,
    parallax: initialParallaxState(...SCENE),
    size: SCENE,
  });
  return { calls, pointers, result };
}

function legacy(pointer: Point, particles: ParticleReplay | undefined, time = 0) {
  const { calls, scene } = recorder();
  legacyReadback(scene, state(), particles, time, pointer, initialParallaxState(...SCENE), SCENE);
  return calls;
}

describe("逐帧指针（replayPointers）", () => {
  it("只给 pointer 或都不给：每一帧都是它，cursor 与 pointer 相同；没有回放时只有读回那一帧", () => {
    const none = replayPointers({}, SCENE, undefined);
    expect(none).toEqual({ pointers: [[0.5, 0.5]], cursors: [[0.5, 0.5]], warmup: [0.5, 0.5] });
    const fixed = replayPointers({ pointer: [0.3, 0.7] }, SCENE, 3);
    expect(fixed.pointers).toEqual([
      [0.3, 0.7],
      [0.3, 0.7],
      [0.3, 0.7],
    ]);
    expect(fixed.cursors).toEqual(fixed.pointers);
    // 窗口和场景同尺寸：原样
    expect(replayPointers({ pointer: [0.3, 0.7], window: [1920, 1080] }, SCENE, 3)).toEqual(fixed);
  });

  it("窗口和场景不同尺寸：g_PointerPosition 原样，cursor 按 fill 换算（同 kbp replay 的式子）；预热用第 0 项", () => {
    const window: Point = [1920, 800];
    const pointers: Point[] = [
      [0, 0],
      [0.25, 0.75],
      [1.4, -0.2],
    ];
    const got = replayPointers({ pointers, window }, SCENE, 3);
    expect(got.pointers).toEqual(pointers);
    // kbp replay：sceneCursor("fill", scenePlacement("fill", 场景宽, 场景高, 窗口宽, 窗口高), 窗口宽, 窗口高, x, y)
    const placement = scenePlacement("fill", SCENE[0], SCENE[1], window[0], window[1]);
    expect(got.cursors).toEqual(pointers.map(([x, y]) => sceneCursor("fill", placement, window[0], window[1], x, y)));
    // 1920×800 窗口盖满 1920×1080 场景：上下各裁掉 140 行，窗口左上角是场景的 (0, 140/1080)
    expect(got.cursors[0][0]).toBe(0);
    expect(got.cursors[0][1]).toBeCloseTo(140 / 1080, 12);
    expect(got.cursors[1]).not.toEqual(pointers[1]);
    expect(got.warmup).toEqual(got.cursors[0]);
    // 窗口外不钳制
    expect(got.cursors[2][0]).toBeGreaterThan(1);
    expect(got.cursors[2][1]).toBeLessThan(0);
  });

  it("参数不对报错：pointer 与 pointers 同给、没有回放、和 dts 不等长、点或窗口不合法", () => {
    expect(() => replayPointers({ pointer: [0.5, 0.5], pointers: [[0.5, 0.5]] }, SCENE, 1)).toThrow(
      "pointer 与 pointers 不能同时给",
    );
    expect(() => replayPointers({ pointers: [[0.5, 0.5]] }, SCENE, undefined)).toThrow("要和 particles 一起给");
    expect(() => replayPointers({ pointers: [[0.5, 0.5]] }, SCENE, 2)).toThrow("应和 particles.dts 等长");
    expect(() => replayPointers({ pointers: [[0.5, Number.NaN]] }, SCENE, 1)).toThrow("pointers[0]");
    expect(() => replayPointers({ window: [0, 800] }, SCENE, undefined)).toThrow("window 要是");
  });

  it("particleTrack 的 cursors：同尺寸原样返回同一个数组，不同尺寸逐项换算", () => {
    const cursors: Point[] = [
      [0.1, 0.2],
      [0.9, 0.95],
    ];
    expect(sceneCursors(cursors, SCENE)).toBe(cursors);
    expect(sceneCursors(cursors, SCENE, [1920, 1080])).toBe(cursors);
    const convert = windowPointer(SCENE, [1440, 1080]);
    expect(sceneCursors(cursors, SCENE, [1440, 1080])).toEqual(cursors.map((p) => convert(p).cursor));
    expect(sceneCursors(cursors, SCENE, [1440, 1080])[0]).not.toEqual(cursors[0]);
  });
});

describe("读回画布与光标窗口（第 5 批：checkCanvas、pointerWindow）", () => {
  it("checkCanvas：两个正整数，给了上限时各不超过它；合法原样返回", () => {
    expect(checkCanvas([1920, 1080])).toEqual([1920, 1080]);
    expect(checkCanvas([8192, 1], 8192)).toEqual([8192, 1]);
    for (const bad of [
      [1920.5, 1080],
      [0, 1080],
      [1920, -1],
      [1920],
      [1920, 1080, 1],
      "1920x1080",
      [1920, Number.NaN],
    ]) {
      expect(() => checkCanvas(bad)).toThrow("canvas 要是 [宽, 高]（两个正整数");
    }
    expect(() => checkCanvas([8193, 1080], 8192)).toThrow("超过设备的纹理上限 8192");
    expect(() => checkCanvas([1080, 8193], 8192)).toThrow("超过设备的纹理上限 8192");
  });

  it("pointerWindow：window ?? canvas；都没给为 undefined；都给而不同抛错，相同时照用", () => {
    expect(pointerWindow(undefined, undefined)).toBeUndefined();
    expect(pointerWindow([1920, 800], undefined)).toEqual([1920, 800]);
    expect(pointerWindow(undefined, [1280, 720])).toEqual([1280, 720]);
    expect(pointerWindow([1920, 1080], [1920, 1080])).toEqual([1920, 1080]);
    expect(() => pointerWindow([1920, 1080], [1280, 720])).toThrow("window 1920×1080 与 canvas 1280×720 不同");
    expect(() => pointerWindow([1920, 1080], [1920, 1081])).toThrow("不同");
    // 形状不对时报形状，不报「不同」
    expect(() => pointerWindow([0, 1080], [1920, 1080])).toThrow("window 要是");
    expect(() => pointerWindow([1920, 1080], [1920.5, 1080])).toThrow("canvas 要是");
  });

  it("只给 canvas 时光标按画布换算，等于把同一尺寸当 window 给", () => {
    const pointers: Point[] = [
      [0.1, 0.2],
      [0.9, 0.95],
    ];
    const particles = { dts: [0.05, 0.05] };
    const byCanvas = replayPointers({ pointers, window: pointerWindow(undefined, [1080, 1080]) }, SCENE, 2);
    expect(byCanvas).toEqual(replayPointers({ pointers, window: [1080, 1080] }, SCENE, 2));
    expect(byCanvas.cursors).not.toEqual(pointers);
    // 画布和场景同尺寸：原样，同不给
    expect(replayPointers({ pointers, window: pointerWindow(undefined, SCENE) }, SCENE, 2)).toEqual(
      replayPointers({ pointers }, SCENE, particles.dts.length),
    );
  });
});

describe("回放到读回帧（replayReadback）", () => {
  it("每帧同一个点时，调用序列与改动前逐项相同（不给新字段、只给 pointer、逐帧给同一个点且窗口同尺寸、没有回放）", () => {
    expect(readback({}, PARTICLES).calls).toEqual(legacy([0.5, 0.5], PARTICLES));
    expect(readback({ pointer: [0.3, 0.7] }, PARTICLES).calls).toEqual(legacy([0.3, 0.7], PARTICLES));
    const same = Array.from({ length: PARTICLES.dts.length }, () => [0.3, 0.7] as Point);
    expect(readback({ pointers: same, window: [1920, 1080] }, PARTICLES).calls).toEqual(legacy([0.3, 0.7], PARTICLES));
    expect(readback({ pointer: [0.2, 0.4] }, undefined, 2.5).calls).toEqual(legacy([0.2, 0.4], undefined, 2.5));
    // 对照本身是有效的：换个点调用序列就不同
    expect(readback({ pointer: [0.3, 0.71] }, PARTICLES).calls).not.toEqual(legacy([0.3, 0.7], PARTICLES));
  });

  it("逐帧指针：第 i 帧步进用第 i 项、视差点逐帧推进；读回帧的 pointerLast 是上一帧的", () => {
    const pointers: Point[] = [
      [0.1, 0.2],
      [0.3, 0.4],
      [0.5, 0.6],
      [0.7, 0.8],
    ];
    const { calls, result } = readback({ pointers }, PARTICLES);
    const steps = calls.filter((c) => (c as unknown[])[0] === "step") as [string, number, number, Point][];
    expect(steps.map((s) => s[3])).toEqual(pointers);
    expect(steps.map((s) => s[2])).toEqual(PARTICLES.times);
    const update = (calls.at(-1) as [string, Record<string, unknown>])[1];
    expect(update.pointer).toEqual([0.7, 0.8]);
    expect(update.pointerLast).toEqual([0.5, 0.6]);
    expect(update.cursor).toEqual([0.7, 0.8]);
    // 视差点：每帧带这一帧的指针与 s 推进，和手算相同（不是只用一个点）
    const s = state();
    const eyes = (calls.filter((c) => (c as unknown[])[0] === "camera") as [string, Point, number][]).map((c) => c[1]);
    let manual = initialParallaxState(...SCENE);
    [...PARTICLES.dts.slice(0, -1), PARTICLES.dts.at(-1)!].forEach((frametime, i) => {
      manual = advanceParallax(
        manual,
        parallaxInput(s.general, { pointer: pointers[i], frametime, width: SCENE[0], height: SCENE[1], eye: eyes[i] }),
      );
    });
    expect(result.parallax).toEqual(manual);
    expect(update.parallax).toEqual(manual.position);
  });

  it("只有一帧时 pointerLast 取自己；窗口不同尺寸时步进用换算后的 cursor、uniform 用窗口坐标", () => {
    const one = readback({ pointers: [[0.25, 0.75]] }, { dts: [0.05] });
    const update = (one.calls.at(-1) as [string, Record<string, unknown>])[1];
    expect(update.pointer).toEqual([0.25, 0.75]);
    expect(update.pointerLast).toEqual([0.25, 0.75]);

    const window: Point = [1920, 800];
    const pointers: Point[] = [
      [0.1, 0.1],
      [0.2, 0.2],
      [0.3, 0.3],
      [0.4, 0.4],
    ];
    const { calls, pointers: converted } = readback({ pointers, window }, PARTICLES);
    const steps = calls.filter((c) => (c as unknown[])[0] === "step") as [string, number, number, Point][];
    expect(steps.map((s) => s[3])).toEqual(converted.cursors);
    expect(converted.cursors).not.toEqual(pointers);
    const last = (calls.at(-1) as [string, Record<string, unknown>])[1];
    expect(last.pointer).toEqual([0.4, 0.4]);
    expect(last.pointerLast).toEqual([0.3, 0.3]);
    expect(last.cursor).toEqual(converted.cursors[3]);
  });

  it("replayParticles 收逐帧 cursor：第 i 帧用第 i 项；和 dts 不等长报错", () => {
    const cursors: Point[] = [];
    const scene = {
      stepParticles: (_dt: number, _time: number, _state?: SceneState, cursor?: readonly [number, number]) =>
        void cursors.push([...cursor!] as Point),
    };
    const per: Point[] = [
      [1, 2],
      [3, 4],
      [5, 6],
    ];
    replayParticles(scene, {} as never, { dts: [0.1, 0.1, 0.1] }, 0, per);
    expect(cursors).toEqual(per.slice(0, 2));
    expect(() => replayParticles(scene, {} as never, { dts: [0.1, 0.1] }, 0, per)).toThrow("应等长");
  });
});

describe("逐帧频谱（P4e 步骤 4，ParticleReplay.audio）", () => {
  const frame = (v: number) => ({ left: Array<number>(16).fill(v), right: Array<number>(16).fill(v / 2) });

  it("每帧步进之前原样写进场景的粒子频谱（含读回那一帧），null 沿用前一帧；不给时不写", () => {
    const { scene } = recorder();
    const particleAudio = silentParticleAudio();
    const seen: number[][] = [];
    const audioScene = {
      ...scene,
      particleAudio,
      stepParticles: (dt: number, time: number, s?: SceneState, cursor?: readonly [number, number]) => {
        seen.push([particleAudio.left[0], particleAudio.right[15]]);
        scene.stepParticles(dt, time, s, cursor);
      },
    };
    const run = (particles: ParticleReplay) =>
      replayReadback(audioScene, state(), {
        particles,
        time: 0,
        pointers: replayPointers({}, SCENE, particles.dts.length),
        parallax: initialParallaxState(...SCENE),
        size: SCENE,
      });
    run({ dts: [0.1, 0.1, 0.1, 0.1], audio: [frame(0.5), null, frame(0.25), null] });
    expect(seen).toEqual([
      [0.5, 0.25],
      [0.5, 0.25],
      [0.25, 0.125],
      [0.25, 0.125],
    ]);
    seen.length = 0;
    run({ dts: [0.1, 0.1] });
    expect(seen).toEqual([
      [0.25, 0.125],
      [0.25, 0.125],
    ]);
  });

  it("读回帧的音频 uniform（P11a）：取截至读回帧最后一个非 null 项，32 / 64 段取新字段、没给的为 0，舍入成 float32；全是 null 或不给时 update 不带 audio", () => {
    const updates = (particles: ParticleReplay) => {
      const { calls, scene } = recorder();
      replayReadback({ ...scene, particleAudio: silentParticleAudio() }, state(), {
        particles,
        time: 0,
        pointers: replayPointers({}, SCENE, particles.dts.length),
        parallax: initialParallaxState(...SCENE),
        size: SCENE,
      });
      const update = calls.filter((c) => (c as unknown[])[0] === "update");
      expect(update).toHaveLength(1);
      return (update[0] as [string, { audio?: Record<string, ArrayLike<number>> }])[1].audio;
    };
    const ramp = (n: number, scale: number) => Array.from({ length: n }, (_, i) => (i + 0.1) * scale);
    const full = {
      ...frame(0.5),
      left32: ramp(32, 0.01),
      right32: ramp(32, 0.02),
      left64: ramp(64, 0.003),
      right64: ramp(64, 0.004),
    };
    const audio = updates({ dts: [0.1, 0.1, 0.1], audio: [frame(0.9), full, null] })!;
    const f32 = (values: number[]) => [...Float32Array.from(values)];
    expect(Array.from(audio.L16)).toEqual(f32(Array(16).fill(0.5)));
    expect(Array.from(audio.R16)).toEqual(f32(Array(16).fill(0.25)));
    expect(Array.from(audio.L32)).toEqual(f32(full.left32));
    expect(Array.from(audio.R32)).toEqual(f32(full.right32));
    expect(Array.from(audio.L64)).toEqual(f32(full.left64));
    expect(Array.from(audio.R64)).toEqual(f32(full.right64));
    // 只给 16 段：32 / 64 段为 0
    const only16 = updates({ dts: [0.1, 0.1], audio: [full, frame(0.75)] })!;
    expect(Array.from(only16.L16)).toEqual(Array(16).fill(0.75));
    expect(Array.from(only16.L32)).toEqual(Array(32).fill(0));
    expect(Array.from(only16.R64)).toEqual(Array(64).fill(0));
    expect(updates({ dts: [0.1, 0.1], audio: [null, null] })).toBeUndefined();
    expect(updates({ dts: [0.1, 0.1] })).toBeUndefined();
  });

  it("32 / 64 段的个数不对时回放之前就抛错（P11a）", () => {
    const steps: number[] = [];
    const scene = { stepParticles: (dt: number) => void steps.push(dt), particleAudio: silentParticleAudio() };
    const bad = { ...frame(1), left64: Array<number>(32).fill(0) };
    expect(() => replayParticles(scene, {} as never, { dts: [0.1, 0.1, 0.1], audio: [frame(1), null, bad] })).toThrow(
      "audio[2].left64 应 64 个，收到 32 个",
    );
    expect(steps).toEqual([]);
  });

  it("和 dts 不等长、或场景没有粒子频谱（替身）却给了 audio 时抛错", () => {
    const scene = { stepParticles: () => {} };
    expect(() => replayParticles(scene, {} as never, { dts: [0.1, 0.1], audio: [frame(1)] })).toThrow("应等长");
    expect(() => replayParticles(scene, {} as never, { dts: [0.1, 0.1], audio: [frame(1), null] })).toThrow("粒子频谱");
    expect(() => replayParticles(scene, {} as never, { dts: [0.1, 0.1], audio: [null, null] })).not.toThrow();
  });
});
