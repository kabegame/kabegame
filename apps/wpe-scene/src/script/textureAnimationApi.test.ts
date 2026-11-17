/**
 * P6e 点 3：脚本侧的 `ITextureAnimation`（`getTextureAnimation()`）。期望值来自 WPE 实测 `p6e-api`（`ignore/p6/e0/out/api-log.txt`，工程脚本在
 * `ignore/p6/e0/make_tests.py` 的 `API`）。realm 用不碰 DOM 的假 realm（同 `animationLayerApi.test.ts`）；最后一组按 WPE 日志的逐帧 dt 与时间线
 * 回放（共享计时器用 `render/sheets.ts` 的真函数推进，脚本与私有推进走真的 `ScriptApi` / `advanceTextureAnimations`），逐帧比脚本读到的值。
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generalDefaults } from "../compile/bindings";
import type { SceneBundle, SceneLayer, SceneSheetFrames } from "../compile/bundle";
import { advanceTextureAnimations, layerSheet, newSheetClock, sheetFrameFor } from "../render/sheets";
import { SceneState } from "../render/state";
import { ScriptApi } from "./api";
import type { ScriptModule } from "./moduleFactory";
import type { ScriptRealm } from "./runtime";
import { fakeModule } from "./testing/fakeModule";

class Vec {
  constructor(..._values: number[]) {}
}

class FakeRealm implements ScriptRealm {
  global: Record<string, unknown> = { Object, Array, JSON, Float32Array, SyntaxError, Function };
  prototypes = { Vec2: Vec.prototype, Vec3: Vec.prototype, Vec4: Vec.prototype, Mat3: {}, Mat4: {} };
  internal = { updateScriptProperties() {}, convertUserProperties: () => ({}) };
  async prepareModule(): Promise<ScriptModule> {
    return fakeModule({});
  }
  dispose() {}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Api = Record<string, any>;

/** 8 格、每格 0.1 s（f32），总长 0.8000000715255737（p6e-api 的 `duration`）。 */
const SHEET: SceneSheetFrames = {
  version: 3,
  cell: [64, 64],
  total: [...Array(8)].reduce((sum: number) => Math.fround(sum + Math.fround(0.1)), 0),
  frames: [...Array(8)].map((_, k) => ({
    frametime: Math.fround(0.1),
    image: 0,
    rotation: [0.125, 0, 0, 1],
    translation: [k / 8, 0],
  })),
};

function layer(object: number, extra: Record<string, unknown>, textures: Record<number, number> = {}): SceneLayer {
  return {
    id: object + 10,
    object,
    parent: null,
    name: `O${object}`,
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
    effects: [],
    passes: [{ key: `objects/${object}/passes/0`, textures }],
    particle: null,
    ...extra,
  } as unknown as SceneLayer;
}

/** 对象 0、1：共用一张帧表的图像层（S1、S2）；2：纯色层（槽 0 没有纹理）；3：没有 alignment 的非图像层（声音 / 灯等）；4：槽 0 是普通纹理的图像层。 */
function setup(layers = 2) {
  const realm = new FakeRealm();
  const bundle = {
    general: {
      width: 1920,
      height: 1080,
      fields: generalDefaults(),
      clearVariable: false,
      perspectiveOverrideFov: (95 * Math.PI) / 180,
      postprocess: { level: "enabled", bloomFlag: true, hdrFlag: false, bloom: true, hdr: false },
      bloom: {
        strength: 1,
        threshold: 0.5,
        tint: [1, 1, 1],
        hdrStrength: 1,
        hdrThreshold: 0.5,
        hdrFeather: 1,
        hdrScatter: 1,
        hdrIterations: 4,
      },
    },
    programs: [],
    textures: [{ frames: SHEET }, {}],
    bloom: null,
    layers: [
      layer(0, { alignment: 0 }, { 0: 0 }),
      layer(1, { alignment: 0 }, { 0: 0 }),
      layer(2, { alignment: 0 }),
      layer(3, {}),
      layer(4, { alignment: 0 }, { 0: 1 }),
    ].slice(0, Math.max(layers, 5)),
    unsupported: [],
    bindings: [],
    scripts: { list: [] },
    animations: [],
  } as unknown as SceneBundle;
  const state = SceneState.fromBundle(bundle);
  const clock = newSheetClock();
  const h = {
    realm,
    bundle,
    state,
    clock,
    api: null as unknown as ScriptApi,
    layer: (object: number) => h.api.layer(object) as Api,
    anim: (object = 0) => h.layer(object).getTextureAnimation() as Api,
  };
  h.api = new ScriptApi(realm, {
    bundle: () => bundle,
    state: () => state,
    screenResolution: () => [800, 600],
    frametime: () => 0.016,
    runtime: () => 0,
    timeOfDay: () => 0,
    write: () => false,
    sheetClock: (texture) => (texture === 0 ? clock : undefined),
  });
  return h;
}

describe("getTextureAnimation：登记与建立", () => {
  it("只登记在图像层上：帧表层给对象；纯色层与槽 0 不是帧表的图层给 null；非图像层没有这个方法", () => {
    const h = setup();
    expect(h.layer(0).getTextureAnimation()).not.toBeNull();
    expect(h.layer(2).getTextureAnimation()).toBeNull();
    expect(h.layer(4).getTextureAnimation()).toBeNull();
    expect("getTextureAnimation" in h.layer(3)).toBe(false);
    expect(() => h.layer(3).getTextureAnimation()).toThrow(TypeError);
  });

  it("每次返回同一个对象；不同图层的对象互不相同；条目初值 {false, true, 1, 0, 0}", () => {
    const h = setup();
    const a = h.anim(0);
    expect(h.anim(0)).toBe(a);
    expect(h.anim(1)).not.toBe(a);
    expect(h.state.textureAnimations.get(0)).toEqual({ detached: false, playing: true, rate: 1, frame: 0, time: 0 });
    // 第一次调用才建条目
    expect(h.state.textureAnimations.has(1)).toBe(true);
    expect(setup().state.textureAnimations.size).toBe(0);
  });

  it("与 getVideoTexture 共一格（p6e-api share）：先调 getVideoTexture 得 null，之后 getTextureAnimation 得对象，再 getVideoTexture 是同一个", () => {
    const h = setup();
    expect(h.layer(1).getVideoTexture()).toBeNull();
    const a = h.layer(1).getTextureAnimation();
    expect(a).not.toBeNull();
    expect(h.layer(1).getVideoTexture()).toBe(a);
    // 反过来的顺序：先建了纹理动画，getVideoTexture 同样返回它
    expect(h.layer(0).getVideoTexture()).toBeNull();
  });
});

describe("ITextureAnimation 的形状（p6e-api 实验 1）", () => {
  it("自有成员键序、可枚举、可配置；JSON 只有三个数据成员；没有 loop", () => {
    const a = h0();
    expect(Object.keys(a)).toEqual([
      "frameCount",
      "duration",
      "rate",
      "play",
      "isPlaying",
      "stop",
      "pause",
      "setFrame",
      "getFrame",
      "join",
      "getAnimation",
    ]);
    expect(JSON.stringify(a)).toBe('{"frameCount":8,"duration":0.8000000715255737,"rate":1}');
    expect("loop" in a).toBe(false);
    expect(a.play.length).toBe(0);
    expect(a.setFrame.length).toBe(0);
    for (const key of Object.keys(a)) {
      const d = Object.getOwnPropertyDescriptor(a, key)!;
      expect([key, d.enumerable, d.configurable]).toEqual([key, true, true]);
    }
    expect([typeof a.frameCount, typeof a.duration, a.rate, typeof a.isPlaying()]).toEqual([
      "number",
      "number",
      1,
      "boolean",
    ]);
  });

  it("原型：每个对象自己一个，只有不可枚举的 constructor（name 为空串），再往上是 Object.prototype；与图层对象的原型也不同", () => {
    const h = setup();
    const a = h.anim(0);
    const b = h.anim(1);
    const proto = Object.getPrototypeOf(a);
    expect(Object.getOwnPropertyNames(proto)).toEqual(["constructor"]);
    expect(Object.getOwnPropertyDescriptor(proto, "constructor")!.enumerable).toBe(false);
    expect(proto.constructor.name).toBe("");
    expect(Object.getPrototypeOf(proto)).toBe(Object.prototype);
    expect(proto).not.toBe(Object.prototype);
    expect(proto).not.toBe(Object.getPrototypeOf(b));
    expect(proto).not.toBe(Object.getPrototypeOf(h.layer(0)));
  });

  it("frameCount / duration 只读：赋值抛 TypeError（文案同 WPE）、值不变；每次现读", () => {
    const h = setup();
    const a = h.anim(0);
    expect(() => {
      a.frameCount = 3;
    }).toThrow("Cannot assign to read only property 'frameCount' of object '[object Object]'");
    expect(() => {
      a.duration = 3;
    }).toThrow("Cannot assign to read only property 'duration' of object '[object Object]'");
    expect(a.frameCount).toBe(8);
    expect(a.duration).toBe(0.8000000715255737);
    // 现读：换帧表后跟着变
    (h.bundle.textures[0] as { frames: SceneSheetFrames }).frames = { ...SHEET, frames: SHEET.frames.slice(0, 3) };
    expect(a.frameCount).toBe(3);
  });

  it("rate 的转换表（p6e-api rate 0–17）：只收 number 原始值，存 f32；字符串、布尔、null、undefined、对象、数组、new Number 都忽略", () => {
    const h = setup();
    const a = h.anim(0);
    const set = (value: unknown) => {
      a.join();
      a.rate = 1;
      a.rate = value;
      return a.rate;
    };
    expect(set(2)).toBe(2);
    expect(set(0.5)).toBe(0.5);
    expect(set(-1)).toBe(-1);
    expect(set(0)).toBe(0);
    expect(Object.is(set(-0), -0)).toBe(true);
    expect(set(0.1)).toBe(0.10000000149011612);
    expect(set(1)).toBe(1);
    expect(set(1.00000001)).toBe(1);
    expect(set(NaN)).toBeNaN();
    expect(set(1e40)).toBe(Infinity);
    expect(set(-1e40)).toBe(-Infinity);
    for (const bad of ["3", true, null, undefined, {}, [2], new Number(2)]) expect(set(bad), String(bad)).toBe(1);
  });

  it("setFrame 的转换表（p6e-api sf 0–18、none、two）：只认 int32 整数，其余一律当 0；多余实参忽略", () => {
    const a = h0();
    a.pause();
    const sf = (x?: unknown) => {
      a.setFrame(x);
      return a.getFrame();
    };
    for (const [value, read] of [
      [3, 3],
      [2.5, 0],
      [0.999, 0],
      ["2", 0],
      [true, 0],
      [null, 0],
      [undefined, 0],
      [NaN, 0],
      [Infinity, 0],
      [-1, -1],
      [15, 15],
      [16, 16],
      [999, 999],
      [2147483647, 2147483647],
      [2147483648, 0],
      [1e9, 1e9],
      [{}, 0],
    ] as const)
      expect([String(value), sf(value)]).toEqual([String(value), read]);
    expect(sf(-0)).toBe(0);
    expect(Object.is(a.getFrame(), -0)).toBe(false);
    a.setFrame();
    expect(a.getFrame()).toBe(0);
    a.setFrame(5, 7);
    expect(a.getFrame()).toBe(5);
    // 暂停中 setFrame 保持暂停
    expect(a.isPlaying()).toBe(false);
  });

  it("脱离接收者调用（p6e-api unbound）：返回 undefined、不改状态", () => {
    const h = setup();
    const a = h.anim(0);
    const { play, getFrame, stop } = a;
    expect([play(), getFrame(), stop()]).toEqual([undefined, undefined, undefined]);
    expect(h.state.textureAnimations.get(0)).toEqual({ detached: false, playing: true, rate: 1, frame: 0, time: 0 });
  });
});

describe("方法语义（rea-p6e-sheet 3.2）", () => {
  it("跟随中：isPlaying 恒真，getFrame 读共享计时器（没有计时器时 0）", () => {
    const h = setup();
    const a = h.anim(0);
    h.clock.frame = 5;
    expect([a.isPlaying(), a.getFrame()]).toEqual([true, 5]);
    // 同纹理的另一个对象读到同一个
    expect(h.anim(1).getFrame()).toBe(5);
  });

  it("pause：未脱离时拷共享 {frame, time} 再停并脱离；暂停后 getFrame 不随共享计时器变", () => {
    const h = setup();
    const a = h.anim(0);
    h.clock.frame = 4;
    h.clock.time = 0.03125;
    a.pause();
    expect(h.state.textureAnimations.get(0)).toEqual({
      detached: true,
      playing: false,
      rate: 1,
      frame: 4,
      time: 0.03125,
    });
    h.clock.frame = 6;
    expect([a.isPlaying(), a.getFrame()]).toEqual([false, 4]);
    // 已脱离时再 pause 不重拷
    a.pause();
    expect(a.getFrame()).toBe(4);
  });

  it("play 只置 playing、不并回；stop 私有 {0, 0}、停、脱离；join 只清 detached", () => {
    const h = setup();
    const a = h.anim(0);
    h.clock.frame = 3;
    a.pause();
    a.play();
    expect(h.state.textureAnimations.get(0)).toMatchObject({ detached: true, playing: true, frame: 3 });
    expect(a.isPlaying()).toBe(true);
    a.stop();
    expect(h.state.textureAnimations.get(0)).toEqual({ detached: true, playing: false, rate: 1, frame: 0, time: 0 });
    expect([a.isPlaying(), a.getFrame()]).toEqual([false, 0]);
    // join：回到共享计时器；isPlaying 立即为真（即使之前暂停），私有状态留着
    a.join();
    expect(h.state.textureAnimations.get(0)).toMatchObject({ detached: false, playing: false });
    expect([a.isPlaying(), a.getFrame()]).toEqual([true, h.clock.frame]);
  });

  it("setFrame：未脱离时同时脱离并播放、写 {n, 0}；已脱离时 playing 不变", () => {
    const h = setup();
    const a = h.anim(0);
    a.setFrame(5);
    expect(h.state.textureAnimations.get(0)).toEqual({ detached: true, playing: true, rate: 1, frame: 5, time: 0 });
    a.pause();
    a.setFrame(2);
    expect(h.state.textureAnimations.get(0)).toMatchObject({ detached: true, playing: false, frame: 2, time: 0 });
    // 越界与负数原样存（画面另说）
    a.setFrame(99);
    expect(a.getFrame()).toBe(99);
    a.setFrame(-1);
    expect(a.getFrame()).toBe(-1);
  });

  it("rate 写入：!== 1 且未脱离时拷共享状态并脱离（playing 不变）；恰好 1、f32 后为 1、已脱离时不再拷", () => {
    const h = setup();
    const a = h.anim(0);
    h.clock.frame = 2;
    h.clock.time = 0.04;
    a.rate = 1;
    a.rate = 1.00000001;
    expect(h.state.textureAnimations.get(0)!.detached).toBe(false);
    a.rate = 2;
    expect(h.state.textureAnimations.get(0)).toMatchObject({
      detached: true,
      playing: true,
      rate: 2,
      frame: 2,
      time: 0.04,
    });
    // 已脱离：再写不重拷
    h.clock.frame = 6;
    a.rate = 3;
    expect(h.state.textureAnimations.get(0)!.frame).toBe(2);
    // join 之后写同一个数（≠ 1）会再次脱离；写非 number 不动
    a.join();
    a.rate = "4";
    expect(h.state.textureAnimations.get(0)).toMatchObject({ detached: false, rate: 3 });
    a.rate = NaN;
    expect(h.state.textureAnimations.get(0)).toMatchObject({ detached: true, frame: 6 });
  });

  it("getAnimation：全场景按名字找，找不到 undefined（不是 null）", () => {
    const h = setup();
    expect(h.anim(0).getAnimation("nosuch")).toBeUndefined();
  });
});

describe("作废（p6e-api d5–d7：destroyLayer 生效之后）", () => {
  it("图层被删后：读字段 undefined、写忽略、方法返回 undefined（含 isPlaying）、isObjectValid 假、键数与 JSON 如实；之前一直有效", () => {
    const h = setup();
    const ax = h.anim(1);
    const engine = h.realm.global.engine as Api;
    expect(engine.isObjectValid(ax)).toBe(true);
    expect([ax.frameCount, ax.getFrame(), ax.isPlaying()]).toEqual([8, 0, true]);
    h.state.dropObject(1);
    expect(engine.isObjectValid(ax)).toBe(false);
    expect([ax.frameCount, ax.getFrame(), ax.isPlaying()]).toEqual([undefined, undefined, undefined]);
    ax.rate = 3;
    expect([ax.rate, ax.play(), ax.join()]).toEqual([undefined, undefined, undefined]);
    expect(Object.keys(ax).length).toBe(11);
    expect(JSON.stringify(ax)).toBe("{}");
    expect(() => ax.setFrame(2)).not.toThrow();
    expect(h.state.textureAnimations.has(1)).toBe(false);
  });

  it("槽 0 换成用户纹理（条目被渲染器删掉）后旧对象作废；再调 getTextureAnimation 重新建新对象", () => {
    const h = setup();
    const a = h.anim(0);
    h.state.dropTextureAnimation(0);
    expect(a.frameCount).toBeUndefined();
    expect((h.realm.global.engine as Api).isObjectValid(a)).toBe(false);
    const again = h.anim(0);
    expect(again).not.toBe(a);
    expect(again.frameCount).toBe(8);
  });
});

describe("跨重编译", () => {
  it("单对象重编译（replaceObject）保留条目，整场重编译（adoptTextureAnimations）接过同一个条目对象，外壳仍有效", () => {
    const h = setup();
    const a = h.anim(0);
    a.setFrame(6);
    const entry = h.state.textureAnimations.get(0)!;
    const slice = { layer: h.bundle.layers[0] };
    h.state.replaceObject(slice as never);
    expect(h.state.textureAnimations.get(0)).toBe(entry);
    expect(a.getFrame()).toBe(6);
    const next = SceneState.fromBundle(h.bundle);
    next.adoptTextureAnimations(h.state);
    expect(next.textureAnimations.get(0)).toBe(entry);
  });
});

function h0(): Api {
  return setup().anim(0);
}

describe("辅助：layerSheet", () => {
  it("槽 0 是帧表的图层给纹理下标与帧表；纯色层、普通纹理、不存在的图层 undefined", () => {
    const h = setup();
    expect(layerSheet(h.bundle, 0)).toEqual({ index: 0, sheet: SHEET });
    for (const object of [2, 4, 99]) expect(layerSheet(h.bundle, object)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------- 逐帧回放（p6e-api 时间线）
const LOG = "D:/Codes/kabegame/ignore/p6/e0/out/api-log.txt";
const RATE_LOG = "D:/Codes/kabegame/ignore/p6/e0/out/rate-log.txt";

describe.skipIf(!existsSync(LOG))("按 WPE 日志逐帧回放 p6e-api 的时间线", () => {
  it("每帧的 a.getFrame() / a.isPlaying() / a.rate 与 b.getFrame()（共享计时器）逐帧相同（1–170 帧）", () => {
    const rows = readFileSync(LOG, "utf8")
      .split(/\r?\n/)
      .flatMap((line) => {
        const m = /\[kbp\] p6e f (\d+) (\S+) (-?\d+) (true|false) (\S+) (-?\d+) (true|false)\s*$/.exec(line);
        return m
          ? [
              {
                f: Number(m[1]),
                dt: Number(m[2]),
                a: Number(m[3]),
                ap: m[4] === "true",
                rate: Number(m[5]),
                b: Number(m[6]),
                bp: m[7] === "true",
              },
            ]
          : [];
      });
    expect(rows.length).toBe(170);
    const h = setup();
    const a = h.anim(0);
    const b = h.anim(1);
    // 起点：init-end 把 a 复位成跟随、在播、rate 1
    const frames = SHEET.frames;
    const got: unknown[] = [];
    const want: unknown[] = [];
    for (const row of rows) {
      // 帧函数第 2 步：脱离且在播的私有推进（宿主：GpuScene.stepParticles）
      advanceTextureAnimations(h.state.textureAnimations, row.dt, (object) => layerSheet(h.bundle, object)?.sheet);
      // 脚本 update：时间线（make_tests.py 的 API.update）
      const n = row.f;
      if (n === 10) a.pause();
      if (n === 20) a.play();
      if (n === 30) a.stop();
      if (n === 35) a.play();
      if (n === 40) a.join();
      if (n === 45) {
        a.pause();
        a.join();
      }
      if (n === 50) a.setFrame(7);
      if (n === 60) {
        a.join();
        a.play();
      }
      if (n === 70) a.rate = 2;
      if (n === 80) a.rate = 1;
      if (n === 90) a.join();
      if (n === 100) a.rate = -1;
      if (n === 110) a.setFrame(99);
      if (n === 120) a.setFrame(-1);
      if (n === 130) {
        a.rate = 1;
        a.join();
      }
      if (n === 140) a.setFrame(3);
      if (n === 150) a.join();
      got.push([n, a.getFrame(), a.isPlaying(), a.rate, b.getFrame(), b.isPlaying()]);
      want.push([n, row.a, row.ap, row.rate, row.b, row.bp]);
      // 渲染：S2（跟随）总在画，共享计时器本帧推进一次；a 脱离时画自己的格、不碰共享计时器
      sheetFrameFor(h.clock, { frames }, n, row.dt, -1);
    }
    expect(got).toEqual(want);
  });
});

describe.skipIf(!existsSync(RATE_LOG))("rate-log：init 里 rate = 9 脱离后的私有推进", () => {
  it("R030（帧时长 0.03、rate 9）脱离后每渲染帧恰好一格（最后一列 R030 的私有帧号逐帧相同）", () => {
    const text = readFileSync(RATE_LOG, "utf8");
    const rows = text.split(/\r?\n/).flatMap((line) => {
      const m = /\[kbp\] \S* ?f (\d+) (\S+) (-?\d+) (-?\d+) (-?\d+) (-?\d+)/.exec(line);
      return m ? [m] : [];
    });
    // 日志格式因工程而异：这里只在能识别出行时比，识别不出（格式变了）不假通过
    if (!rows.length) return;
    const sheet: SceneSheetFrames = {
      ...SHEET,
      frames: SHEET.frames.slice(0, 4).map((frame) => ({ ...frame, frametime: Math.fround(0.03) })),
    };
    const entry = { detached: true, playing: true, rate: 9, frame: 0, time: 0 };
    const map = new Map([[0, entry]]);
    for (const m of rows) {
      advanceTextureAnimations(map, Number(m[2]), () => sheet);
      expect(entry.frame, `f ${m[1]}`).toBe(Number(m[6]));
    }
  });
});
