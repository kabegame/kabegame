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
import type { SceneBundle, SceneLayer } from "../compile/bundle";
import type { SceneScript } from "../compile/scripts";
import { SceneState } from "../render/state";
import type { ScriptRealm } from "../script/runtime";
import { replayReadback, type ParticleReplay } from "./particleCorners";
import { createProbeScripts, probeScriptsOptionsOf, type ProbeRealmSetup } from "./probeScripts";
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
        name: "",
        object: 0,
        owner: "objects/0",
        inert: false,
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

describe("跑脚本的回放里的动画控制与事件（P10b 步骤 3）", () => {
  const ID = "objects/0/alpha";
  const EVENT_JSON = JSON.stringify({ name: "hit" });
  const layer = {
    id: 1,
    object: 0,
    parent: null,
    name: "L0",
    origin: [0, 0, 0],
    scale: [1, 1, 1],
    angles: [0, 0, 0],
    size: [100, 100],
    alpha: 1,
    color: [1, 1, 1],
    brightness: 1,
    visible: true,
    visibleBound: false,
    parallaxDepth: [1, 1],
    solidLayer: false,
    instanced: false,
    noPadding: false,
    perspective: false,
    passthroughModel: false,
    group: null,
    subtree: [],
    groupUpload: null,
    copyBackground: true,
    clampUVs: true,
    noInterpolation: false,
    fullscreen: false,
    fullscreenSize: null,
    passes: [],
    colorBlendMode: 0,
    effects: [],
    passthrough: null,
    particle: null,
  } as unknown as SceneLayer;
  const script: SceneScript = {
    id: ID,
    source: "",
    target: { kind: "layer", object: 0, field: "alpha" },
    valueType: "float",
    initial: 1,
    owner: { kind: "layer", object: 0 },
    layer: 0,
    scriptProperties: null,
    imports: [],
    errors: [],
  };
  /** `startpaused` 的动画：不被脚本播放就永远不推进，事件也就永远不触发；事件时间 0.06 s 落在第二帧（[0.05, 0.1125)）。 */
  const animation: SceneAnimation = {
    id: ID,
    target: { kind: "layer", object: 0, field: "alpha" },
    valueType: "float",
    channels: [
      [
        { frame: 0, value: 0, flags: 0, bx: 0, by: 0, fx: 0, fy: 0 },
        { frame: 60, value: 1, flags: 0, bx: 0, by: 0, fx: 0, fy: 0 },
      ],
    ],
    clock: { fps: 30, length: 60, mode: 0, startpaused: true },
    parent: null,
    events: [{ time: 0.06, json: EVENT_JSON }],
    writes: true,
    name: "Fade",
    object: 0,
    owner: "objects",
    inert: false,
  };
  const bundle = {
    general: {
      width: 1920,
      height: 1080,
      fields: generalDefaults(),
      clearVariable: false,
      perspectiveOverrideFov: (95 * Math.PI) / 180,
      postprocess: { level: "disabled", bloomFlag: false, hdrFlag: false, bloom: false, hdr: false },
      bloom: {
        strength: 1,
        threshold: 1,
        tint: [1, 1, 1],
        hdrStrength: 1,
        hdrThreshold: 1,
        hdrFeather: 1,
        hdrScatter: 1,
        hdrIterations: 1,
      },
    },
    layers: [layer],
    programs: [],
    textures: [],
    bloom: null,
    unsupported: [],
    bindings: [],
    scripts: { list: [script] },
    animations: [{ ...animation, owner: "objects/0" }],
  } as unknown as SceneBundle;

  /**
   * 假 realm：模块导出 init（`play` 的开关由 `playInInit` 定）、animationEvent、update，都记进 `log`；animationEvent 与 update 读到的
   * `engine.runtime` 另记进 `times`。
   */
  function fakeRealm(log: string[], playInInit: boolean, times: [string, number][] = []) {
    return async (setup: ProbeRealmSetup): Promise<ScriptRealm> => {
      void setup;
      const global: Record<string, unknown> = {
        Object,
        Array,
        JSON,
        Float32Array,
        Date,
        Math: Object.create(Math),
        SyntaxError,
      };
      return {
        global,
        prototypes: { Vec2: {}, Vec3: {}, Vec4: {}, Mat3: {}, Mat4: {} },
        internal: { updateScriptProperties() {}, convertUserProperties: () => ({}) },
        async importModule() {
          return {
            init() {
              log.push("init");
              if (playInInit) (global.thisObject as { getAnimation(): { play(): void } }).getAnimation().play();
            },
            animationEvent(event: { name: string }, value: number) {
              log.push(`event:${event.name}:${value}`);
              times.push(["event", (global.engine as { runtime: number }).runtime]);
            },
            update() {
              log.push("update");
              times.push(["update", (global.engine as { runtime: number }).runtime]);
            },
          };
        },
        dispose() {},
      };
    };
  }

  async function replay(playInInit: boolean) {
    const log: string[] = [];
    const times: [string, number][] = [];
    const calls: unknown[] = [];
    const state = SceneState.fromBundle(bundle);
    const players = new SceneAnimations(bundle.animations!);
    const probe = createProbeScripts({
      bundle,
      state,
      sceneAssets: [],
      properties: new Map(),
      screen: SCENE,
      options: probeScriptsOptionsOf(true)!,
      animations: players,
      createRealm: fakeRealm(log, playInInit, times),
    });
    await probe.load();
    const scene = {
      stepParticles: () => void calls.push("step"),
      setCamera: () => void calls.push("camera"),
      sync: () => void calls.push("sync"),
      setParallax: () => void calls.push("parallax"),
      update: () => void calls.push("update"),
    };
    replayReadback(scene, state, {
      particles: PARTICLES,
      time: 0,
      pointers: replayPointers({}, SCENE, PARTICLES.dts.length),
      parallax: initialParallaxState(...SCENE),
      size: SCENE,
      animations: players,
      scripts: probe,
    });
    probe.dispose();
    return { log, players, times };
  }

  it("init 里 getAnimation().play() 有落点：回放第一帧起推进；事件在该帧的 update 之前派发给脚本，带上接收者的当前值", async () => {
    const { log, players } = await replay(true);
    expect(players.probe().list[0]).toMatchObject({ playing: true });
    // init → 第 1 帧 update → 第 2 帧（越过 0.06 s）事件在 update 之前 → 第 3、4 帧 update
    expect(log.slice(0, 2)).toEqual(["init", "update"]);
    const events = log.filter((line) => line.startsWith("event:"));
    expect(events).toHaveLength(1);
    // 事件的第二个参数是接收者属性的当前值：动画刚写进的 alpha（不是 1）
    expect(events[0]).toMatch(/^event:hit:0\.\d+/);
    const at = log.indexOf(events[0]);
    expect(log[at + 1]).toBe("update");
    expect(log.slice(at - 1, at)).toEqual(["update"]); // 第一帧的 update 在事件之前
    expect(log.filter((line) => line === "update")).toHaveLength(PARTICLES.dts.length);
  });

  it("事件回调读到的 engine.runtime 是本帧的（同紧接着的 update），不是上一帧的（WPE 先加 g_Time 再跑动画循环）", async () => {
    const { times } = await replay(true);
    const at = times.findIndex(([kind]) => kind === "event");
    expect(at).toBeGreaterThan(0);
    expect(times[at + 1][0]).toBe("update");
    expect(times[at][1]).toBe(times[at + 1][1]);
    // 上一帧的 update 读到的是更早的时间
    expect(times[at - 1][1]).toBeLessThan(times[at][1]);
  });

  it("对照：init 里不播放，startpaused 的动画不动、事件不触发", async () => {
    const { log, players } = await replay(false);
    expect(players.probe().list[0]).toMatchObject({ playing: false, t: 0 });
    expect(log.some((line) => line.startsWith("event:"))).toBe(false);
  });
});
