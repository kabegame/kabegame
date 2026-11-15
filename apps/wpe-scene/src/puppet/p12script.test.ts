/**
 * P12c-2：`p12-script`（p12-REPORT 用例 9）的逐帧夹具回放。
 *
 * 夹具 `fixtures/p12-script.json`（生成脚本 `ignore/p12/c/impl2/mkfix_script.py`）：工程的文本文件与 mdl、从第 1 帧起的 dt 与 `engine.runtime`
 * （WPE 的 `[kbp] @f64` 日志）、WPE 的脚本输出（`[kbp] ` 之后的整行，含 `@f64` 行）、抓帧 152–251 里 main 的 g_Bones。
 *
 * 做法：用产品源码编译这个工程（材质与着色器换成桩，脚本与它们无关），真的 `SceneState` / `ScenePuppets` / `ScriptApi` / `ScriptRuntime`
 * （经 dev 探针的 `createProbeScripts` 搭，同 `renderFrame` 跑脚本时的接线），每帧按 `stepPuppets`（探针回放用的同一个函数：先交时间、
 * puppet 推进并派发事件与播完回调）→ 脚本 `frame` 的顺序推进；realm 用 `node:vm` 的上下文（脚本是严格模式的 ES 模块，导出函数）。
 * 比：每帧脚本日志行与 WPE 逐行相同；g_Bones 与 WPE 在 P12a 的 `rsqrtps` 容差内（≤ 5 ulp 或 ≤ 2e-6，逐位相同的帧数与最大差打印出来）。
 */
import { fakeModule } from "../script/testing/fakeModule";
import vm from "node:vm";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { compileScene } from "../compile/bundle";
import type { SceneReader } from "../compile/fs";
import { stepPuppets } from "../dev/particleCorners";
import {
  createProbeScripts,
  type ProbeRealmSetup,
  type ProbeScripts,
  type ResolvedProbeScripts,
} from "../dev/probeScripts";
import { SceneState } from "../render/state";
import type { ScriptRealm } from "../script/runtime";
import type { TranslateRequest, TranslateResult, Wpesl2wgsl } from "../wpesl2wgsl";
import fixture from "./fixtures/p12-script.json";
import { puppetEntries, ScenePuppets, stateSink } from "./player";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

/** 材质与着色器的桩：脚本与它们无关，编译只要不因缺文件失败。 */
const STUB_MATERIAL = JSON.stringify({ passes: [{ shader: "s", blending: "translucent" }] });
const stubFiles: Record<string, string | Uint8Array> = {
  "materials/kbpup/white.json": STUB_MATERIAL,
  "materials/kbp_clk.json": STUB_MATERIAL,
  "models/kbp_clk.json": JSON.stringify({ material: "materials/kbp_clk.json" }),
  "models/util/solidlayer.json": JSON.stringify({ material: "materials/kbp_clk.json" }),
  "shaders/s.vert": "void main() {}",
  "shaders/s.frag": "void main() {}",
};

function files(): Record<string, string | Uint8Array> {
  const out: Record<string, string | Uint8Array> = { ...fixture.files, ...stubFiles };
  for (const [path, text] of Object.entries(fixture.mdl))
    out[path] = new Uint8Array(gunzipSync(Buffer.from(text, "base64")));
  return Object.fromEntries(Object.entries(out).map(([path, value]) => [`P:/p/${path}`, value]));
}

function memoryReader(all: Record<string, string | Uint8Array>): SceneReader {
  const bytes = (path: string) => {
    const value = all[path.replace(/\\/g, "/")];
    if (value === undefined) throw new TypeError("Failed to fetch");
    return typeof value === "string" ? new TextEncoder().encode(value) : value.slice();
  };
  return {
    async readWhole(path) {
      return bytes(path);
    },
    async readRange(path, start, end) {
      return bytes(path).slice(start, end);
    },
  };
}

function fakeTranslator(): Wpesl2wgsl {
  return {
    async translate(request: TranslateRequest): Promise<TranslateResult> {
      const combos = Object.entries(request.combos ?? {}).map(([name, value]) => ({
        name,
        value: Number(value),
        source: "request" as const,
      }));
      const bones = Number(request.combos?.BONECOUNT ?? 0);
      return {
        ok: true,
        uniforms: request.combos?.SKINNING
          ? [
              {
                name: "g_Bones",
                type: `array<mat4x3<f32>, ${bones}>`,
                declared: "mat4x3",
                offset: 0,
                size: 64 * bones,
                array: bones,
                stride: 64,
              },
            ]
          : [],
        uniformBlockSize: request.combos?.SKINNING ? 64 * bones : 0,
        textures: [],
        combos,
      } as unknown as TranslateResult;
    },
  } as unknown as Wpesl2wgsl;
}

/**
 * `node:vm` 的 realm：脚本在独立的全局里求值（`engine` / `thisLayer` 等由 `ScriptApi` 挂在它上面），模块源码去掉 `export` 后包进函数、
 * 导出对象是普通对象（没有 `name`，所以回调里 `this` 的 `String(this.name)` 是 `undefined`，同 WPE 的模块命名空间）。
 */
function vmRealm(setup: ProbeRealmSetup): ScriptRealm {
  const context = vm.createContext({});
  const run = (code: string) => vm.runInContext(code, context) as never;
  // 向量的 `toString` 是空格分隔的分量（WPE 的 `String(vec3)`，日志里 `value=1 1 1`）
  run(`
    const vec = (n) => class { constructor(...v) { ['x', 'y', 'z', 'w'].slice(0, n).forEach((k, i) => { this[k] = v[i]; }); }
      toString() { return ['x', 'y', 'z', 'w'].slice(0, n).map((k) => this[k]).join(' '); } };
    globalThis.Vec2 = vec(2); globalThis.Vec3 = vec(3); globalThis.Vec4 = vec(4);
  `);
  const global = run("globalThis") as Record<string, unknown>;
  global.console = {
    log: (...args: unknown[]) => setup.console.log(args.join(" ")),
    error: (...args: unknown[]) => setup.console.error(args.join(" ")),
  };
  global.localStorage = setup.localStorage(global);
  return {
    global,
    prototypes: {
      Vec2: run("Vec2.prototype"),
      Vec3: run("Vec3.prototype"),
      Vec4: run("Vec4.prototype"),
      Mat3: {},
      Mat4: {},
    },
    internal: {
      updateScriptProperties() {},
      convertUserProperties: (json: string) =>
        Object.fromEntries(
          Object.entries(JSON.parse(json) as Record<string, { value: unknown }>).map(([key, item]) => [
            key,
            item.value,
          ]),
        ),
    },
    async prepareModule(source: string, label: string) {
      const names = [...source.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)].map((match) => match[1]);
      const body = source.replace(/^export\s+/gm, "");
      const exports = vm.runInContext(
        `(function () {\n${body}\nreturn { ${names.map((name) => `${name}: ${name}`).join(", ")} };\n})()`,
        context,
        {
          filename: label,
        },
      ) as Record<string, unknown>;
      return fakeModule(exports);
    },
    dispose() {},
  };
}

const OPTIONS: ResolvedProbeScripts = {
  clock: 1_700_000_000_000,
  clockDefault: false,
  seed: 1,
  seedDefault: false,
  consoleGrep: /\[kbp\]/,
};

const bitsF = new Float32Array(1);
const bitsI = new Int32Array(bitsF.buffer);
/** float32 的有序整数（+0 与 −0 都是 0），相减就是相差几个 ulp。 */
function ordered(value: number): number {
  bitsF[0] = value;
  const i = bitsI[0];
  return i < 0 ? -(i & 0x7fffffff) : i;
}

/** V8 版本差：WPE 的 V8 在「给只读属性赋值」的报错里把对象写成 `[object Object]`，Node 的写成 `#<构造函数名>`（只这一处不同，其余原样比）。 */
const normalize = (line: string) => line.replace(/of object '#<\w+>'/, "of object '[object Object]'");

describe("p12-script：按 WPE 的帧时间回放", () => {
  let scripts: ProbeScripts;
  let puppets: ScenePuppets;
  const got: string[] = [];
  const skins: Record<number, Float32Array> = {};
  const wanted = new Set(fixture.frames);

  beforeAll(async () => {
    const bundle = await compileScene({
      projectDir: "P:/p",
      sceneAssets: ["A:/assets"],
      reader: memoryReader(files()),
      translator: fakeTranslator(),
      postprocess: "disabled",
      exhaustive: true,
    });
    const state = SceneState.fromBundle(bundle);
    puppets = new ScenePuppets(puppetEntries(bundle.layers));
    puppets.refresh(stateSink(state));
    scripts = createProbeScripts({
      bundle,
      state,
      sceneAssets: ["A:/assets"],
      properties: new Map(),
      screen: [1856, 1044],
      options: OPTIONS,
      puppets,
      createRealm: async (setup) => vmRealm(setup),
    });
    await scripts.load();
    const main = bundle.layers.find((layer) => layer.name === "main")!;
    for (let i = 0; i < fixture.dt.length; i++) {
      const dt = fixture.dt[i];
      const time = fixture.time[i];
      // 一帧的顺序（同探针回放与宿主）：交时间 → puppet 推进（事件与播完回调）→ 脚本
      stepPuppets({ puppets, scripts }, state, dt, time);
      scripts.frame(dt, time);
      if (wanted.has(i + 1)) skins[i + 1] = Float32Array.from(puppets.skin(main.object)!);
    }
    got.push(...(scripts.result().console.matched ?? []).map((line) => line.replace(/^.*?\[kbp\] /, "")));
  });
  afterAll(() => scripts?.dispose());

  it("每帧的脚本日志行与 WPE 逐行相同（含 init、查找、成员、事件、播完回调、各动作的生效帧）", () => {
    const want = fixture.log.map(normalize);
    expect(got.map(normalize).length).toBe(want.length);
    for (let i = 0; i < want.length; i++) {
      if (normalize(got[i]) !== want[i])
        expect.fail(`第 ${i} 行不同\n  WPE ：${want[i]}\n  我们：${normalize(got[i])}`);
    }
    // 回调与事件都真的发生过（不是两边都没有）
    expect(want.filter((line) => line.startsWith("p12 main,ended,")).length).toBeGreaterThan(15);
    expect(want.filter((line) => line.startsWith("p12 main,event,")).length).toBeGreaterThan(15);
    console.log(`[p12-script] ${fixture.dt.length} 帧，${want.length} 行逐行相同`);
  });

  // 容差同 `player.test.ts`（P12a）：单个数 ≤ 5 ulp 或绝对差 ≤ 2e-6。差来自 WPE `rsqrtps` 的硬件近似（不复刻，P12a 决定），和脚本无关：
  // 脚本只改时钟，时钟的任何偏差都会先在上一条的 `getFrame` 日志行（逐行相同）里出现。实测 100 帧最大 4 ulp（5.96e-8）
  it("g_Bones 与 WPE 在 rsqrtps 的容差内（≤ 5 ulp 或 ≤ 2e-6）", () => {
    let same = 0;
    let count = 0;
    let maxUlp = 0;
    let maxAbs = 0;
    let exactFrames = 0;
    let outside = 0;
    const worst: string[] = [];
    for (const frame of fixture.frames) {
      const want = fixture.bones[String(frame) as keyof typeof fixture.bones] as number[];
      const skin = skins[frame];
      expect(skin.length).toBe(want.length);
      let frameSame = true;
      for (let i = 0; i < want.length; i++) {
        const ref = Math.fround(want[i]);
        const ulp = Math.abs(ordered(skin[i]) - ordered(ref));
        const abs = Math.abs(skin[i] - ref);
        count++;
        if (skin[i] === ref) same++;
        else {
          frameSame = false;
          if (ulp > maxUlp) worst.push(`帧 ${frame}[${i}] ${skin[i]} vs ${ref}（${ulp} ulp）`);
        }
        if (ulp > 5 && abs > 2e-6) outside++;
        maxUlp = Math.max(maxUlp, ulp);
        maxAbs = Math.max(maxAbs, abs);
      }
      if (frameSame) exactFrames++;
    }
    console.log(
      `[p12-script] g_Bones：${fixture.frames.length} 帧中 ${exactFrames} 帧逐位相同，${same}/${count} 个数相同，最大差 ${maxAbs.toExponential(3)}（${maxUlp} ulp）${worst.slice(-3).join("；")}`,
    );
    expect(outside).toBe(0);
  });
});
