/**
 * P10a 走查：dev 探针回放时每一帧都在 GPU 上画（`replayReadback` 的 `encodeFrame`）。探针本身要 GPU，这里用记录调用的假场景核对：
 * - 前 n − 1 帧每帧照读回帧的顺序走完（`sync` → 步进 → 相机 → 动画 → `sync` → 视差 → `update`），再编码；读回帧不编码；
 * - 读回帧的 `update`、视差与返回值和只画读回帧时逐项相同（general 不变时两种视差推进等价）；
 * - 前置帧的 `update` 用这一帧的时间、帧时间、光标、上一帧的光标与截至这一帧的频谱（`spectrumAt`，null 沿用前一帧）；
 * - 没有回放（没有 `dts`）时给了 `encodeFrame` 也不调，调用序列同不给。
 */
import { describe, expect, it, vi } from "vitest";
import { generalDefaults } from "../compile/bindings";
import { initialParallaxState } from "../render/parallax";
import type { SceneState } from "../render/state";
import { replayReadback, spectrumAt, type ParticleReplay } from "./particleCorners";
import { replayPointers } from "./replayPointers";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

type Point = [number, number];
const SCENE: Point = [1920, 1080];
const POINTERS: Point[] = [
  [0.5, 0.5],
  [0.25, 0.75],
  [0.6, 0.4],
  [0.9, 0.1],
];
const left = (v: number) => Array.from({ length: 16 }, () => v);
const PARTICLES: ParticleReplay = {
  dts: [0.05, 0.0625, 0.04, 0.05],
  times: [0.05, 0.1125, 0.1525, 0.2025],
  audio: [{ left: left(0.1), right: left(0.2) }, null, { left: left(0.3), right: left(0.4) }, null],
};

/** 开着抖动与视差，相机与视差点每帧都变。 */
function fakeState(): SceneState {
  return {
    general: {
      ...generalDefaults(),
      camerashake: true,
      camerashakespeed: 1,
      camerashakeamplitude: 1,
      camerashakeroughness: 1,
      cameraparallax: true,
      cameraparallaxamount: 0.5,
      cameraparallaxdelay: 2.7,
      cameraparallaxmouseinfluence: 1,
    },
  } as unknown as SceneState;
}

function run(particles: ParticleReplay | undefined, encode: boolean, animate = true) {
  const calls: unknown[][] = [];
  const scene = {
    stepParticles: (dt: number, at: number, _state: unknown, cursor: readonly number[]) =>
      void calls.push(["step", dt, at, [...cursor]]),
    setCamera: ({ shake, zoom }: { shake: readonly [number, number]; zoom: number }) =>
      void calls.push(["camera", [...shake], zoom]),
    sync: () => void calls.push(["sync"]),
    setParallax: (next: unknown) => void calls.push(["parallax", structuredClone(next)]),
    update: (frame: unknown) => void calls.push(["update", structuredClone(frame)]),
    particleAudio: { left: new Float32Array(16), right: new Float32Array(16) },
  };
  // 逐帧指针只能和回放一起给（`replayPointers`）；没有回放时用固定的一个点
  const pointers = replayPointers(particles ? { pointers: POINTERS } : {}, SCENE, particles?.dts.length);
  const result = replayReadback(scene as never, fakeState(), {
    particles,
    time: 0,
    pointers,
    parallax: initialParallaxState(...SCENE),
    size: SCENE,
    animations: animate ? { frame: (dt: number) => void calls.push(["animate", dt]) } : undefined,
    encodeFrame: encode ? (index) => void calls.push(["encode", index]) : undefined,
  });
  return { calls, result };
}

const kinds = (calls: unknown[][]) => calls.map((call) => call[0]);
const lastOf = (calls: unknown[][], kind: string) => calls.filter((call) => call[0] === kind).at(-1);

describe("回放的每一帧都画（encodeFrame）", () => {
  it("前 n − 1 帧照读回帧的顺序走完再编码，读回帧不编码", () => {
    const { calls } = run(PARTICLES, true);
    const frame = ["sync", "step", "camera", "animate", "sync", "parallax", "update"];
    expect(kinds(calls)).toEqual([...frame, "encode", ...frame, "encode", ...frame, "encode", ...frame]);
    expect(calls.filter((call) => call[0] === "encode").map((call) => call[1])).toEqual([0, 1, 2]);
  });

  it("读回帧的 update、视差与返回值和只画读回帧时逐项相同", () => {
    for (const animate of [true, false]) {
      const encoded = run(PARTICLES, true, animate);
      const plain = run(PARTICLES, false, animate);
      expect(lastOf(encoded.calls, "update")).toEqual(lastOf(plain.calls, "update"));
      expect(lastOf(encoded.calls, "parallax")).toEqual(lastOf(plain.calls, "parallax"));
      expect(encoded.result).toEqual(plain.result);
      // 步进、相机、动画的逐帧参数也相同（只多了每帧开头的 sync、前置帧的视差与 update、编码）
      const core = (calls: unknown[][]) =>
        calls.filter((call) => ["step", "camera", "animate"].includes(call[0] as string));
      expect(core(encoded.calls)).toEqual(core(plain.calls));
    }
  });

  it("前置帧的 update 用这一帧的时间、光标、上一帧的光标与截至这一帧的频谱", () => {
    const { calls } = run(PARTICLES, true);
    const updates = calls.filter((call) => call[0] === "update").map((call) => call[1]) as Record<string, unknown>[];
    expect(updates.map((frame) => frame.time)).toEqual(PARTICLES.times);
    expect(updates.map((frame) => frame.frametime)).toEqual(PARTICLES.dts);
    const pointer = (frame: Record<string, unknown>) => [...(frame.pointer as number[])];
    const pointerLast = (frame: Record<string, unknown>) => [...(frame.pointerLast as number[])];
    expect(updates.map(pointer)).toEqual(POINTERS);
    expect(updates.map(pointerLast)).toEqual([POINTERS[0], POINTERS[0], POINTERS[1], POINTERS[2]]);
    const audioLeft = (frame: Record<string, unknown>) =>
      Math.fround((frame.audio as { L16: Float32Array }).L16[0] as number);
    expect(updates.map(audioLeft)).toEqual([0.1, 0.1, 0.3, 0.3].map(Math.fround));
  });

  it("没有回放时给了 encodeFrame 也不调，调用序列同不给", () => {
    expect(run(undefined, true).calls).toEqual(run(undefined, false).calls);
    expect(kinds(run(undefined, true).calls)).not.toContain("encode");
  });

  it("spectrumAt：截至这一帧最后一个非 null 项，开头是 null 时没有", () => {
    const replay: ParticleReplay = { dts: [1, 1, 1], audio: [null, { left: left(0.5), right: left(0) }, null] };
    expect(spectrumAt(replay, 0)).toBeUndefined();
    expect(spectrumAt(replay, 1)?.L16[0]).toBe(0.5);
    expect(spectrumAt(replay, 2)?.L16[0]).toBe(0.5);
    expect(spectrumAt({ dts: [1] }, 0)).toBeUndefined();
  });
});
