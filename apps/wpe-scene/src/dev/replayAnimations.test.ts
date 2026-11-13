/**
 * P10a 步骤 3：dev 探针回放到读回帧（`particleCorners.ts` 的 `replayReadback`）里关键帧动画的位置。探针本身要 GPU，这里用记录调用的
 * 假场景核对：
 * - 每一帧（前 n − 1 帧与读回帧）在步进粒子、设相机之后按这一帧的 dt 推进动画、写进状态，接着 `sync`；
 * - 不给 `animations` 时调用序列与给了之后去掉这两项逐项相同（`replayPointers.test.ts` 另核对与改动前的写法相同）；
 * - 没有回放（没有 `dts`）时不推进（调用方自己 `seek` + `write`）；
 * - 用真的 `SceneAnimations`：写在 `sync` 之前，最后的值和同一串 dt 逐帧推进的结果相同。
 */
import { describe, expect, it, vi } from "vitest";
import { SceneAnimations } from "../animation/player";
import type { SceneAnimation } from "../animation/types";
import { generalDefaults } from "../compile/bindings";
import { initialParallaxState } from "../render/parallax";
import type { SceneState } from "../render/state";
import { replayReadback, type ParticleReplay } from "./particleCorners";
import { replayPointers } from "./replayPointers";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

type Point = [number, number];
const SCENE: Point = [1920, 1080];
const PARTICLES: ParticleReplay = { dts: [0.05, 0.0625, 0.04, 0.05], times: [0.05, 0.1125, 0.1525, 0.2025] };

/** 开着抖动与视差，相机与视差点每帧都变；`write` 记进同一份调用记录（真的 `SceneAnimations` 写状态时）。 */
function fakeState(calls: unknown[]): SceneState {
  const general = {
    ...generalDefaults(),
    camerashake: true,
    camerashakespeed: 1,
    camerashakeamplitude: 1,
    camerashakeroughness: 1,
    cameraparallax: true,
    cameraparallaxamount: 0.5,
    cameraparallaxdelay: 2.7,
    cameraparallaxmouseinfluence: 1,
  };
  return {
    general,
    write: (_binding: unknown, raw: unknown) => {
      calls.push(["write", raw]);
      return "applied";
    },
  } as unknown as SceneState;
}

function run(particles: ParticleReplay | undefined, animations: "none" | "fake" | SceneAnimations, time = 0) {
  const calls: unknown[] = [];
  const scene = {
    stepParticles: (dt: number, at: number) => void calls.push(["step", dt, at]),
    setCamera: ({ shake, zoom }: { shake: readonly [number, number]; zoom: number }) =>
      void calls.push(["camera", [...shake], zoom]),
    sync: () => void calls.push(["sync"]),
    setParallax: (next: unknown) => void calls.push(["parallax", structuredClone(next)]),
    update: (frame: unknown) => void calls.push(["update", structuredClone(frame)]),
  };
  const state = fakeState(calls);
  const pointers = replayPointers({}, SCENE, particles?.dts.length);
  const result = replayReadback(scene, state, {
    particles,
    time,
    pointers,
    parallax: initialParallaxState(...SCENE),
    size: SCENE,
    animations:
      animations === "none"
        ? undefined
        : animations === "fake"
          ? { frame: (dt: number) => void calls.push(["animate", dt]) }
          : animations,
  });
  return { calls, result };
}

const kind = (call: unknown) => (call as unknown[])[0];

/** 去掉动画带来的两项（`animate` 或真的写入，以及紧跟着的 `sync`）。 */
function withoutAnimation(calls: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < calls.length; i++) {
    if (kind(calls[i]) === "animate" || kind(calls[i]) === "write") {
      while (kind(calls[i + 1]) === "write") i++;
      if (kind(calls[i + 1]) === "sync") i++;
      continue;
    }
    out.push(calls[i]);
  }
  return out;
}

describe("回放到读回帧里的关键帧动画（P10a 步骤 3）", () => {
  it("每一帧在步进粒子、设相机之后按这一帧的 dt 推进，接着 sync；读回帧之后才设视差、写 update", () => {
    const { calls } = run(PARTICLES, "fake");
    expect(calls.map(kind)).toEqual([
      ...["step", "camera", "animate", "sync"],
      ...["step", "camera", "animate", "sync"],
      ...["step", "camera", "animate", "sync"],
      // 读回帧：开头的 sync → 步进 → 相机 → 动画 → sync → 视差 → update
      ...["sync", "step", "camera", "animate", "sync", "parallax", "update"],
    ]);
    expect(calls.filter((call) => kind(call) === "animate").map((call) => (call as unknown[])[1])).toEqual(
      PARTICLES.dts,
    );
  });

  it("不给 animations：调用序列同给了之后去掉动画的两项；没有回放时不推进", () => {
    const fake = run(PARTICLES, "fake");
    const none = run(PARTICLES, "none");
    expect(none.calls).toEqual(withoutAnimation(fake.calls));
    expect(none.result).toEqual(fake.result);
    // 对照有效：给了动画时确实多出调用
    expect(fake.calls.length).toBeGreaterThan(none.calls.length);
    for (const particles of [undefined, { dts: [] }]) {
      const still = run(particles, "fake", 2.5);
      expect(still.calls.map(kind)).not.toContain("animate");
      expect(still.calls).toEqual(run(particles, "none", 2.5).calls);
    }
  });

  it("真的 SceneAnimations：写在 sync 之前，最后的值同一串 dt 逐帧推进", () => {
    const list: SceneAnimation[] = [
      {
        id: "objects/0/alpha",
        target: { kind: "layer", object: 0, field: "alpha" },
        valueType: "float",
        channels: [
          [
            { frame: 0, value: 0, flags: 0, bx: 0, by: 0, fx: 0, fy: 0 },
            { frame: 60, value: 1, flags: 0, bx: 0, by: 0, fx: 0, fy: 0 },
          ],
        ],
        clock: { fps: 30, length: 60, mode: 0, startpaused: false },
        parent: null,
        events: [],
        writes: true,
      },
    ];
    const players = new SceneAnimations(list);
    const { calls } = run(PARTICLES, players);
    const kinds = calls.map(kind);
    expect(kinds.filter((item) => item === "write")).toHaveLength(PARTICLES.dts.length);
    kinds.forEach((item, i) => {
      if (item === "write") expect(kinds[i + 1]).toBe("sync");
    });
    const manual = new SceneAnimations(list);
    const recorded: unknown[] = [];
    for (const dt of PARTICLES.dts) manual.frame(dt, fakeState(recorded));
    expect(players.probe().list.map(({ t, value }) => [t, value])).toEqual(
      manual.probe().list.map(({ t, value }) => [t, value]),
    );
    expect(calls.filter((call) => kind(call) === "write")).toEqual(recorded);
    // 去掉动画之后同不给动画
    expect(withoutAnimation(calls)).toEqual(run(PARTICLES, "none").calls);
  });
});
