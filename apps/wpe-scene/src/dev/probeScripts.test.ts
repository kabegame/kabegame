/**
 * dev 探针跑场景脚本（kabegame-chromium 第 7 批，`probeScripts.ts`）：选项的形状、`Date` / `Math.random` 的替换、用户属性的全集，以及
 * `createProbeScripts` 在内存里编译的最小场景与真的 `SceneState`、`ScriptApi`、`ScriptRuntime` 上的行为。realm 换成不碰 DOM 的假 realm：
 * 模块按脚本 id 取一个工厂，工厂在「模块求值」时拿到 realm 的全局（脚本读的 `Date`、`Math`、`engine` 都经它），所以能核对替换发生在
 * 模块求值之前。脚本都是有限步的同步函数，不会卡住。
 */
import { describe, expect, it, vi } from "vitest";
import { builtinProperties } from "../compile/builtinProperties";
import { compileScene, type SceneBundle } from "../compile/bundle";
import type { SceneReader } from "../compile/fs";
import type { SceneObject } from "../compile/model";
import { mulberry32 } from "../particles/random";
import { SceneState } from "../render/state";
import { daytimeOf } from "../render/uniforms";
import type { ScriptRealm } from "../script/runtime";
import {
  createProbeScripts,
  DEFAULT_PROBE_CLOCK,
  DEFAULT_PROBE_SEED,
  installProbeClock,
  installProbeRandom,
  probeClockAt,
  probeDaytime,
  probeScriptsOptionsOf,
  probeUserProperties,
  type ProbeRealmSetup,
  type ResolvedProbeScripts,
} from "./probeScripts";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

function memory(files: Record<string, unknown>): SceneReader {
  const reader: SceneReader = {
    async readWhole(path) {
      const value = files[path.replace(/\\/g, "/")];
      if (value === undefined) throw new TypeError("Failed to fetch");
      return new TextEncoder().encode(JSON.stringify(value));
    },
    async readRange(path, start, end) {
      return (await reader.readWhole(path)).slice(start, end);
    },
  };
  return reader;
}

const SCRIPT = "export function update(value) { return value; }";
const image = (extra: Record<string, unknown>): SceneObject =>
  ({ image: "models/a.json", size: "40 60", ...extra }) as SceneObject;

const PROJECT = {
  file: "scene.json",
  general: {
    properties: {
      speed: { type: "slider", value: 2 },
      tint: { type: "color", value: "1 0 0" },
      grp: { type: "group", value: null },
      note: { type: "text", value: "说明" },
    },
  },
};

/**
 * objects：0 FR（颜色挂脚本）、1 T（alpha 挂脚本，用来记环境）、2 music（声音对象，没有脚本）。`scripts: false` 时都不挂脚本。
 * 场景 1920×1080，后处理关（`hdrFlag` 为 false）。
 */
function compile(scripts = true): Promise<SceneBundle> {
  const objects: SceneObject[] = [
    image({ id: 1, name: "FR", origin: "1820 40 0", color: scripts ? { script: SCRIPT, value: "0 0 1" } : "0 0 1" }),
    image({ id: 2, name: "T", origin: "100 100 0", alpha: scripts ? { script: SCRIPT, value: 1 } : 1 }),
    { id: 3, name: "music", sound: "sounds/a.mp3" } as SceneObject,
  ];
  return compileScene({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    reader: memory({
      "P:/p/project.json": PROJECT,
      "P:/p/scene.json": { general: { orthogonalprojection: { width: 1920, height: 1080 } }, objects },
      "P:/p/models/a.json": { material: "materials/a.json", width: 40, height: 60 },
      "P:/p/materials/a.json": { passes: [{ shader: "simple" }] },
      "P:/p/sounds/a.mp3": "a",
    }),
    translator: null,
    postprocess: "disabled",
    exhaustive: true,
  });
}

class Vec2 {
  constructor(
    public x: number,
    public y: number,
  ) {}
}
class Vec3 {
  constructor(
    public x: number,
    public y: number,
    public z: number,
  ) {}
}
class Vec4 {
  constructor(
    public x: number,
    public y: number,
    public z: number,
    public w: number,
  ) {}
}

// 假 realm 里的脚本读写的是宽松的全局，这里不细分类型
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Global = Record<string, any>;
type Factory = (global: Global) => Record<string, unknown>;

/** 假 realm：全局有自己的 `Date` 槽与一份 `Math`（替换不碰测试进程的），模块按脚本 id 取工厂、在求值时调。 */
function fakeRealm(factories: Record<string, Factory>, log: string[] = []) {
  const made = { count: 0, disposed: 0, global: null as Global | null };
  const createRealm = async (setup: ProbeRealmSetup): Promise<ScriptRealm> => {
    made.count++;
    const global: Global = { Object, Array, JSON, Float32Array, Date, Math: Object.create(Math) };
    global.console = setup.console;
    global.localStorage = setup.localStorage(global);
    made.global = global;
    return {
      global,
      prototypes: { Vec2: Vec2.prototype, Vec3: Vec3.prototype, Vec4: Vec4.prototype, Mat3: {}, Mat4: {} },
      internal: {
        updateScriptProperties() {},
        // 同 baseclasses 的形状：键 → 值（颜色不另转换，测试只看键与值）
        convertUserProperties: (json: string) =>
          Object.fromEntries(
            Object.entries(JSON.parse(json) as Record<string, { value: unknown }>).map(([key, item]) => [
              key,
              item.value,
            ]),
          ),
      },
      async importModule(_source: string, label: string) {
        log.push(`evaluate ${label}`);
        return factories[label]?.(global) ?? {};
      },
      dispose() {
        made.disposed++;
      },
    };
  };
  return { createRealm, made };
}

const OPTIONS: ResolvedProbeScripts = { clock: 1_700_000_000_000, clockDefault: false, seed: 42, seedDefault: false };

async function setup(factories: Record<string, Factory>, options = OPTIONS, log: string[] = []) {
  const bundle = await compile();
  const state = SceneState.fromBundle(bundle);
  const realm = fakeRealm(factories, log);
  const scripts = createProbeScripts({
    bundle,
    state,
    sceneAssets: ["A:/assets"],
    properties: probeUserProperties(PROJECT, { speed: 5 }),
    screen: [1280, 720],
    options,
    createRealm: realm.createRealm,
  });
  return { bundle, state, realm, scripts };
}

/** 脚本在某一时刻看到的外部值。 */
function snapshot(g: Global) {
  return {
    runtime: g.engine.runtime,
    frametime: g.engine.frametime,
    now: g.Date.now(),
    newDate: new g.Date().getTime(),
    timeOfDay: g.engine.timeOfDay,
    random: g.Math.random(),
    screen: [g.engine.screenResolution.x, g.engine.screenResolution.y],
    canvas: [g.engine.canvasSize.x, g.engine.canvasSize.y],
  };
}

/** 同 kbp gen 的 FR_COLOR 的颜色部分：第 N 次 update 写 (N % 256 / 255, ⌊N / 256⌋ % 256 / 255, 1)。 */
const frFactory: Factory = () => {
  let frame = 0;
  return {
    update(value: Vec3) {
      frame++;
      value.x = (frame % 256) / 255;
      value.y = (Math.floor(frame / 256) % 256) / 255;
      value.z = 1;
      return value;
    },
  };
};

describe("scripts 选项（probeScriptsOptionsOf）", () => {
  it("不给为 null；true 与 {} 用缺省并写明；给了的原样", () => {
    expect(probeScriptsOptionsOf(undefined)).toBeNull();
    const defaults = { clock: DEFAULT_PROBE_CLOCK, clockDefault: true, seed: DEFAULT_PROBE_SEED, seedDefault: true };
    expect(probeScriptsOptionsOf(true)).toEqual(defaults);
    expect(probeScriptsOptionsOf({})).toEqual(defaults);
    expect(probeScriptsOptionsOf({ clock: 5, seed: 7 })).toEqual({
      clock: 5,
      clockDefault: false,
      seed: 7,
      seedDefault: false,
    });
    expect(probeScriptsOptionsOf({ clock: -8.64e15, seed: 0xffffffff })).toMatchObject({ clock: -8.64e15 });
    // 缺省起点是固定的 2026-01-01T00:00:00Z
    expect(new Date(DEFAULT_PROBE_CLOCK).toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("形状不对抛错：不是 true / 对象、不认识的键、clock 不是有限数或越界、seed 不是 0–2³²−1 的整数", () => {
    for (const bad of [false, null, 1, "x", [1]])
      expect(() => probeScriptsOptionsOf(bad), String(bad)).toThrow("scripts 要是 true，或 { clock?, seed? }");
    expect(() => probeScriptsOptionsOf({ clock: 1, time: 2 })).toThrow("scripts.time 不认识");
    for (const clock of [Number.NaN, Infinity, 8.64e15 + 1, "1"])
      expect(() => probeScriptsOptionsOf({ clock }), String(clock)).toThrow("scripts.clock 要是毫秒时间戳");
    for (const seed of [-1, 1.5, 2 ** 32, "1"])
      expect(() => probeScriptsOptionsOf({ seed }), String(seed)).toThrow("scripts.seed 要是 0–4294967295 的整数");
  });
});

describe("Date 与 Math.random 的替换", () => {
  it("Date：无参构造、当函数调用、Date.now 取 now()；带参数的构造、parse、UTC 同原生；instanceof Date 为真", () => {
    const global: Global = { Date };
    let t = 1000;
    installProbeClock(global, () => t);
    const G = global.Date;
    expect(G).not.toBe(Date);
    expect(new G().getTime()).toBe(1000);
    t = 5000;
    expect(G.now()).toBe(5000);
    expect(G()).toBe(new Date(5000).toString());
    expect(new G(0).getTime()).toBe(0);
    expect(new G(2020, 0, 2, 3, 4, 5).getTime()).toBe(new Date(2020, 0, 2, 3, 4, 5).getTime());
    expect(new G("2020-01-02T00:00:00Z").getTime()).toBe(Date.UTC(2020, 0, 2));
    expect(new G() instanceof Date).toBe(true);
    expect(new G() instanceof G).toBe(true);
    expect(G.UTC).toBe(Date.UTC);
    expect(G.parse).toBe(Date.parse);
    // 测试进程的 Date 不受影响
    expect(Math.abs(Date.now() - new Date().getTime())).toBeLessThan(1000);
    expect(Date.now()).not.toBe(5000);
  });

  it("Math.random：按种子的 mulberry32 序列，同种子相同、不同种子不同，都在 [0, 1)；不碰测试进程的 Math", () => {
    const native = Math.random;
    const take = (seed: number) => {
      const global: Global = { Math: Object.create(Math) };
      installProbeRandom(global, seed);
      return Array.from({ length: 6 }, () => global.Math.random() as number);
    };
    const a = take(42);
    expect(take(42)).toEqual(a);
    expect(take(43)).not.toEqual(a);
    const next = mulberry32(42);
    expect(a).toEqual(Array.from({ length: 6 }, () => next() / 4294967296));
    for (const value of [...a, ...take(0xffffffff)]) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
    expect(Math.random).toBe(native);
  });

  it("时钟：起点加回放时间；g_Daytime 跟着同一个时钟", () => {
    expect(probeClockAt(1000, 2.5)).toBe(3500);
    expect(probeDaytime(OPTIONS.clock, 3)).toBe(daytimeOf(new Date(OPTIONS.clock + 3000)));
  });
});

describe("用户属性全集（probeUserProperties）", () => {
  it("工程声明的属性带类型，值取请求给的（裸值或 { value }）、没给的取缺省；分组、文本、空值与工程没声明的键不收；另带 WPE 的 14 个内置项（P3a 修复）", () => {
    const properties = probeUserProperties(PROJECT, { speed: 5, tint: { value: "0 1 0" }, extra: 1 });
    expect(Object.fromEntries(properties)).toEqual({
      ...builtinProperties(),
      speed: { type: "slider", value: 5 },
      tint: { type: "color", value: "0 1 0" },
    });
    expect(Object.fromEntries(probeUserProperties(PROJECT))).toEqual({
      ...builtinProperties(),
      speed: { type: "slider", value: 2 },
      tint: { type: "color", value: "1 0 0" },
    });
    expect(Object.fromEntries(probeUserProperties(null, { speed: 1 }))).toEqual(builtinProperties());
  });
});

describe("createProbeScripts", () => {
  it("外部值来自请求：Date / Math.random 在模块求值之前换好；init 时 runtime / frametime 为 0；每帧是这一帧的；timeOfDay 同一个时钟；screenResolution 是给的、canvasSize 是场景尺寸", async () => {
    const seen: Record<string, unknown>[] = [];
    const { scripts } = await setup({
      "objects/0/color": frFactory,
      "objects/1/alpha": (g) => {
        // 模块顶层：此时就该是请求给的时钟与种子
        seen.push({ phase: "evaluate", now: g.Date.now(), newDate: new g.Date().getTime(), random: g.Math.random() });
        return {
          init: () => void seen.push({ phase: "init", ...snapshot(g) }),
          update: () => void seen.push({ phase: "update", ...snapshot(g) }),
        };
      },
    });
    await scripts.load();
    scripts.frame(0.25, 0.25);
    scripts.frame(0.5, 0.75);
    const clock = OPTIONS.clock;
    const next = mulberry32(OPTIONS.seed);
    const random = () => next() / 4294967296;
    const at = (time: number) => ({
      now: clock + time * 1000,
      newDate: clock + time * 1000,
      timeOfDay: daytimeOf(new Date(clock + time * 1000)),
      screen: [1280, 720],
      canvas: [1920, 1080],
    });
    expect(seen).toEqual([
      { phase: "evaluate", now: clock, newDate: clock, random: random() },
      { phase: "init", runtime: 0, frametime: 0, ...at(0), random: random() },
      { phase: "update", runtime: 0.25, frametime: 0.25, ...at(0.25), random: random() },
      { phase: "update", runtime: 0.75, frametime: 0.5, ...at(0.75), random: random() },
    ]);
    const result = scripts.result();
    expect(result).toMatchObject({ clock, clockDefault: false, seed: 42, seedDefault: false, frames: 2 });
    expect(result.screenResolution).toEqual([1280, 720]);
    scripts.dispose();
  });

  it("两次同样的请求得到同样的值（时钟、随机数、写回的状态）", async () => {
    const run = async () => {
      const seen: unknown[] = [];
      const { scripts, state } = await setup({
        "objects/0/color": frFactory,
        "objects/1/alpha": (g) => ({
          init: () => void seen.push(snapshot(g)),
          update: () => {
            seen.push(snapshot(g));
            return g.Math.random();
          },
        }),
      });
      await scripts.load();
      for (let i = 1; i <= 5; i++) scripts.frame(1 / 60, i / 60);
      scripts.dispose();
      return { seen, alpha: state.layers.get(1)!.alpha, color: state.layers.get(0)!.color };
    };
    const first = await run();
    expect(await run()).toEqual(first);
    expect(first.color).toEqual([5 / 255, 0, 1]);
  });

  it("缺省时钟与种子：结果写明用的是缺省", async () => {
    let now = 0;
    const { scripts } = await setup(
      { "objects/1/alpha": (g) => ({ init: () => void (now = g.Date.now()) }) },
      probeScriptsOptionsOf(true)!,
    );
    await scripts.load();
    expect(now).toBe(DEFAULT_PROBE_CLOCK);
    expect(scripts.result()).toMatchObject({
      clock: DEFAULT_PROBE_CLOCK,
      clockDefault: true,
      seed: DEFAULT_PROBE_SEED,
      seedDefault: true,
    });
    scripts.dispose();
  });

  it("顺序与次数：全部模块求值 → 各段 init → 整份用户属性 → 每帧一次 update；字段脚本写回经共用的写回进状态", async () => {
    const log: string[] = [];
    const { scripts, state } = await setup(
      {
        "objects/0/color": frFactory,
        "objects/1/alpha": (g) => ({
          init: () => void log.push(`init userProperties=${JSON.stringify(g.engine.userProperties)}`),
          applyUserProperties: (changed: unknown) =>
            void log.push(`apply ${JSON.stringify(changed)} userProperties=${JSON.stringify(g.engine.userProperties)}`),
          update: (value: number) => {
            log.push(`update ${g.engine.runtime}`);
            return value / 2;
          },
        }),
      },
      OPTIONS,
      log,
    );
    expect(log).toEqual([]);
    await scripts.load();
    for (let i = 1; i <= 3; i++) scripts.frame(0.1, i * 0.1);
    // 全集：WPE 的 14 个内置项加工程声明的（P3a 修复）
    const full = JSON.stringify({
      ...Object.fromEntries(Object.entries(builtinProperties()).map(([key, item]) => [key, item.value])),
      speed: 5,
      tint: "1 0 0",
    });
    expect(log).toEqual([
      "evaluate objects/0/color",
      "evaluate objects/1/alpha",
      // init 里 engine.userProperties 已是全集（同 WPE 与宿主）；整份 applyUserProperties 在首帧之前
      `init userProperties=${full}`,
      `apply ${full} userProperties=${full}`,
      "update 0.1",
      "update 0.2",
      "update 0.30000000000000004",
    ]);
    // FR 第 3 帧的颜色；alpha 每帧减半（init 不返回值，不写）
    expect(state.layers.get(0)!.color).toEqual([3 / 255, 0, 1]);
    expect(state.layers.get(1)!.alpha).toBe(1 / 8);
    const diagnostics = scripts.result().diagnostics as {
      id: string;
      state: string;
      calls: Record<string, { count: number }>;
    }[];
    expect(diagnostics.map((d) => [d.id, d.state, d.calls.init?.count, d.calls.update?.count])).toEqual([
      ["objects/0/color", "inited", undefined, 3],
      ["objects/1/alpha", "inited", 1, 3],
    ]);
    expect(scripts.result().frames).toBe(3);
    scripts.dispose();
  });

  it("要整场重编译的写入：值真的变了才记（同宿主），记路径、次数、第一次的帧与最后的值；状态不变", async () => {
    const writes = [false, true, true, false];
    let frame = 0;
    const { scripts, bundle } = await setup({
      "objects/1/alpha": (g) => ({
        // init 写编译期的值（false）：不算变化
        init: () => void (g.thisScene.hdr = false),
        update: () => void (g.thisScene.hdr = writes[frame++]),
      }),
    });
    expect(bundle.general.postprocess.hdrFlag).toBe(false);
    await scripts.load();
    for (let i = 1; i <= writes.length; i++) scripts.frame(0.1, i * 0.1);
    expect(scripts.result().recompile).toEqual([{ path: "general/hdr", count: 2, firstFrame: 2, value: false }]);
    expect(bundle.general.postprocess.hdrFlag).toBe(false);
    scripts.dispose();
  });

  it("没接的 API：声音层的方法空操作（isPlaying 为假）、每次问到都计数；音频缓冲全 0", async () => {
    const seen: unknown[] = [];
    let buffers: Global | null = null;
    const { scripts } = await setup({
      "objects/1/alpha": (g) => {
        buffers = g.engine.registerAudioBuffers(16);
        return {
          update: () => {
            const music = g.thisScene.getLayer("music");
            music.play();
            seen.push(music.isPlaying());
            seen.push(Array.from(buffers!.left as Float32Array).every((v) => v === 0));
          },
        };
      },
    });
    await scripts.load();
    scripts.frame(0.1, 0.1);
    scripts.frame(0.1, 0.2);
    expect(seen).toEqual([false, true, false, true]);
    const result = scripts.result();
    expect(result.unconnected).toEqual({ sound: 4, video: 0, particles: 0 });
    expect(result.audioResolutions).toEqual([16]);
    scripts.dispose();
  });

  it("localStorage 只在内存：写了读得回", async () => {
    const seen: unknown[] = [];
    const { scripts } = await setup({
      "objects/1/alpha": (g) => ({
        init: () => g.localStorage.set("k", { n: 3 }),
        update: () => void seen.push(g.localStorage.get("k")),
      }),
    });
    await scripts.load();
    scripts.frame(0.1, 0.1);
    expect(seen).toEqual([{ n: 3 }]);
    scripts.dispose();
  });

  it("出错与输出：update 抛错只停用它并记进 messages；console 记条数与最后 50 条", async () => {
    let calls = 0;
    const { scripts } = await setup({
      "objects/1/alpha": (g) => {
        for (let i = 0; i < 60; i++) g.console.log(`line ${i}`);
        g.console.error("bad");
        return {
          update: () => {
            calls++;
            throw new Error("boom");
          },
        };
      },
    });
    await scripts.load();
    scripts.frame(0.1, 0.1);
    scripts.frame(0.1, 0.2);
    expect(calls).toBe(1);
    const result = scripts.result();
    const alpha = (result.diagnostics as { id: string; disabled: string[]; errors: string[] }[]).find(
      (d) => d.id === "objects/1/alpha",
    )!;
    expect(alpha.disabled).toEqual(["update"]);
    expect(alpha.errors).toEqual(["update: boom"]);
    expect(result.messages).toEqual(["场景脚本 objects/1/alpha update 出错：boom"]);
    expect(result.console.count).toBe(61);
    expect(result.console.tail).toHaveLength(50);
    expect(result.console.tail.at(0)).toBe("line 11");
    expect(result.console.tail.at(-1)).toBe("error: bad");
    scripts.dispose();
  });

  it("dispose：调各段 destroy、释放 realm，可以重复调；之后 frame 不再跑脚本", async () => {
    const log: string[] = [];
    const { scripts, realm } = await setup({
      "objects/1/alpha": () => ({ update: () => void log.push("update"), destroy: () => void log.push("destroy") }),
    });
    await scripts.load();
    scripts.frame(0.1, 0.1);
    scripts.dispose();
    scripts.dispose();
    scripts.frame(0.1, 0.2);
    expect(log).toEqual(["update", "destroy"]);
    expect(realm.made.disposed).toBe(1);
    expect(scripts.result().frames).toBe(1);
  });

  it("场景没有脚本：不建 realm，结果的诊断为空", async () => {
    const bundle = await compile(false);
    expect(bundle.scripts.list).toEqual([]);
    const realm = fakeRealm({});
    const scripts = createProbeScripts({
      bundle,
      state: SceneState.fromBundle(bundle),
      sceneAssets: [],
      properties: new Map(),
      screen: [1920, 1080],
      options: OPTIONS,
      createRealm: realm.createRealm,
    });
    await scripts.load();
    scripts.frame(0.1, 0.1);
    scripts.dispose();
    expect(realm.made.count).toBe(0);
    expect(scripts.result()).toMatchObject({ diagnostics: [], recompile: [], frames: 1 });
  });
});

describe("scripts.consoleGrep（P6c）", () => {
  it("给了正则源码就编译；不给时结果里没有这个键；非字符串与坏正则抛错", () => {
    expect(probeScriptsOptionsOf(true)).not.toHaveProperty("consoleGrep");
    const resolved = probeScriptsOptionsOf({ consoleGrep: "kbp6c" });
    expect(resolved?.consoleGrep).toBeInstanceOf(RegExp);
    expect(resolved?.consoleGrep?.test("[kbp6c] f=1")).toBe(true);
    expect(() => probeScriptsOptionsOf({ consoleGrep: 5 })).toThrow("consoleGrep 要是正则源码");
    expect(() => probeScriptsOptionsOf({ consoleGrep: "(" })).toThrow("不是合法的正则");
  });
});
