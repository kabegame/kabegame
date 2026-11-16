/**
 * P12e-2：`p12-create`（运行时建删动画层）的逐帧夹具回放。
 *
 * 夹具 `fixtures/p12-create.json`（生成脚本 `ignore/p12/e/impl/mkfix_create.py`）：工程的文本文件与五个 mdl、从第 1 帧起的 dt 与 `engine.runtime`
 * （WPE 的 `[kbp] @f64` 日志）、WPE 的脚本输出（`[kbp] ` 之后的整行，含 `@f64` 行）、抓帧脚本帧 241、242 里五个 puppet 的 g_Bones。
 *
 * 做法同 `p12script.test.ts`：用产品源码编译这个工程（材质与着色器换成桩），真的 `SceneState` / `ScenePuppets` / `ScriptApi` / `ScriptRuntime`
 * （经 dev 探针的 `createProbeScripts` 搭，同 `renderFrame` 跑脚本时的接线），每帧按 `stepPuppets`（先交时间、puppet 推进并派发事件、播完回调与单次层的删除）
 * → 脚本 `frame`（update、`settleDestroyed`、`settle`）的顺序推进；realm 用 `node:vm` 的上下文。
 * 比：全部 `[kbp]` 行（268 帧）与 WPE 逐行相同（含脚本里建 / 删层的返回值、包装作废、回调与计数）；两帧五个 puppet 的 g_Bones 在 `rsqrtps` 容差内。
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
import fixture from "./fixtures/p12-create.json";
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
  // 向量的 `toString` 是空格分隔的分量（WPE 的 `String(vec3)`）
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

const NAMES = ["main", "single", "destroy", "cb1", "cb2"] as const;

describe("p12-create：按 WPE 的帧时间回放", () => {
  let scripts: ProbeScripts;
  let puppets: ScenePuppets;
  const got: string[] = [];
  const skins: Record<number, Record<string, Float32Array>> = {};
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
    const objects = Object.fromEntries(
      NAMES.map((name) => [name, bundle.layers.find((layer) => layer.name === name)!]),
    );
    for (let i = 0; i < fixture.dt.length; i++) {
      const dt = fixture.dt[i];
      const time = fixture.time[i];
      // 一帧的顺序（同探针回放与宿主）：交时间 → puppet 推进（事件、播完回调、单次层的删除）→ 脚本（update、settleDestroyed、settle）
      stepPuppets({ puppets, scripts }, state, dt, time);
      scripts.frame(dt, time);
      if (wanted.has(i + 1))
        skins[i + 1] = Object.fromEntries(
          NAMES.map((name) => [name, Float32Array.from(puppets.skin(objects[name].object)!)]),
        );
    }
    got.push(...(scripts.result().console.matched ?? []).map((line) => line.replace(/^.*?\[kbp\] /, "")));
  });
  afterAll(() => scripts?.dispose());

  it("每帧的脚本日志行与 WPE 逐行相同（含建层的初值、查找、config、插入、单次层、删层、回调循环）", () => {
    const want = fixture.log;
    expect(got.length).toBe(want.length);
    for (let i = 0; i < want.length; i++) {
      if (got[i] !== want[i]) expect.fail(`第 ${i} 行不同\n  WPE ：${want[i]}\n  我们：${got[i]}`);
    }
    // 建、删、回调都真的发生过（不是两边都没有）
    expect(want.filter((line) => line.startsWith("p12e main,create,")).length).toBeGreaterThanOrEqual(40);
    expect(want.filter((line) => line.startsWith("p12e single,ended,")).length).toBeGreaterThan(3);
    expect(want.filter((line) => line.startsWith("p12e destroy,destroy,")).length).toBeGreaterThan(10);
    expect(want.filter((line) => line.startsWith("p12e cb1,cb,")).length).toBeGreaterThan(3);
    console.log(`[p12-create] ${fixture.dt.length} 帧，${want.length} 行逐行相同`);
  });

  // 容差同 `p12script.test.ts`（P12a）：单个数 ≤ 5 ulp 或绝对差 ≤ 2e-6。此时建删都已结束，验稳态姿势（新层有贡献、删掉的层没了、删光回到静止）
  it("两帧五个 puppet 的 g_Bones 与 WPE 在 rsqrtps 的容差内（≤ 5 ulp 或 ≤ 2e-6）", () => {
    let same = 0;
    let count = 0;
    let maxUlp = 0;
    let maxAbs = 0;
    let outside = 0;
    for (const frame of fixture.frames) {
      const table = (fixture.bones as unknown as Record<string, Record<string, number[]>>)[String(frame)];
      for (const name of NAMES) {
        const want = table[name];
        const skin = skins[frame][name];
        expect(skin.length, `${name} 帧 ${frame}`).toBe(want.length);
        for (let i = 0; i < want.length; i++) {
          const ref = Math.fround(want[i]);
          const ulp = Math.abs(ordered(skin[i]) - ordered(ref));
          const abs = Math.abs(skin[i] - ref);
          count++;
          if (skin[i] === ref) same++;
          if (ulp > 5 && abs > 2e-6) {
            outside++;
            console.log(`[p12-create] ${name} 帧 ${frame}[${i}] ${skin[i]} vs ${ref}（${ulp} ulp）`);
          }
          maxUlp = Math.max(maxUlp, ulp);
          maxAbs = Math.max(maxAbs, abs);
        }
      }
    }
    console.log(`[p12-create] g_Bones：${same}/${count} 个数相同，最大差 ${maxAbs.toExponential(3)}（${maxUlp} ulp）`);
    expect(outside).toBe(0);
  });
});
