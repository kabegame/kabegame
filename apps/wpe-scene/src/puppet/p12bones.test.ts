/**
 * P12d-2：`p12-bones`（骨骼脚本 API 的 WPE 实测）的逐帧夹具回放，做法同 `p12script.test.ts`。
 *
 * 夹具 `fixtures/p12-bones.json`（生成脚本 `ignore/p12/d/impl2/mkfix_bones.py`）：工程文本文件与 mdl、从第 1 帧起的 dt 与 `engine.runtime`
 * （WPE 的 `[kbp] @f64` 日志）、WPE 的脚本输出（`[kbp] p12d ` 之后的整行）、抓帧 200–299 里 bones_a / bones_b 的 g_Bones。
 *
 * 脚本用的 `Mat4.translation()` 等要真的 `baseclasses.js`（WPE 自带、有版权，不入库）：从本机 WPE 安装目录读，
 * 环境变量 `KB_WPE_ASSETS` 可覆盖 assets 目录；读不到时整组跳过。
 *
 * 脚本日志行：非数字部分逐字相同，数字按 1e-3 容差比（物理求逆的写法和 WPE 不同，p12-REPORT 第二部分 1.3）；每类行的最大差打印出来。
 */
import { existsSync, readFileSync } from "node:fs";
import vm from "node:vm";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { compileScene, type SceneLayer } from "../compile/bundle";
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
import { fakeModule } from "../script/testing/fakeModule";
import type { TranslateRequest, TranslateResult, Wpesl2wgsl } from "../wpesl2wgsl";
import fixture from "./fixtures/p12-bones.json";
import { puppetEntries, ScenePuppets, stateSink } from "./player";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

const ASSETS = process.env.KB_WPE_ASSETS ?? "D:/Applications/Steam/steamapps/common/wallpaper_engine/assets";
const BASECLASSES = `${ASSETS}/scripts/jsclasses/baseclasses.js`;
const available = existsSync(BASECLASSES);

const STUB_MATERIAL = JSON.stringify({ passes: [{ shader: "s", blending: "translucent" }] });
const stubFiles: Record<string, string | Uint8Array> = {
  "materials/kbpup/white.json": STUB_MATERIAL,
  "materials/particle/white.json": STUB_MATERIAL,
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

/** `node:vm` 的 realm，向量与矩阵用 WPE 自带的 `baseclasses.js`（脚本里的 `Mat4.translation()` 才是真的）。 */
function vmRealm(setup: ProbeRealmSetup): ScriptRealm {
  const context = vm.createContext({});
  const run = (code: string, filename?: string) => vm.runInContext(code, context, { filename }) as never;
  const global = run("globalThis") as Record<string, unknown>;
  global.console = {
    log: (...args: unknown[]) => setup.console.log(args.join(" ")),
    error: (...args: unknown[]) => setup.console.error(args.join(" ")),
  };
  global.localStorage = setup.localStorage(global);
  run(readFileSync(BASECLASSES, "utf8"), "baseclasses.js");
  return {
    global,
    prototypes: {
      Vec2: global._Vec2 as object,
      Vec3: global._Vec3 as object,
      Vec4: global._Vec4 as object,
      Mat3: global._Mat3 as object,
      Mat4: global._Mat4 as object,
    },
    internal: global._Internal as ScriptRealm["internal"],
    async prepareModule(source: string, label: string) {
      const names = [...source.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)].map((match) => match[1]);
      const body = source.replace(/^export\s+/gm, "");
      return fakeModule(
        vm.runInContext(
          `(function () {\n${body}\nreturn { ${names.map((name) => `${name}: ${name}`).join(", ")} };\n})()`,
          context,
          { filename: label },
        ) as Record<string, unknown>,
      );
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

const NUMBER = /-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/g;
/** 一行拆成「非数字部分」与数字序列。 */
function split(line: string): { shape: string; numbers: number[] } {
  return { shape: line.replace(NUMBER, "#"), numbers: (line.match(NUMBER) ?? []).map(Number) };
}
/** 行的类型：第一个逗号之前。 */
const kind = (line: string) => line.split(",", 1)[0];

const TOLERANCE = 1e-3;

describe.skipIf(!available)("p12-bones：骨骼脚本 API 按 WPE 的帧时间回放", () => {
  let scripts: ProbeScripts;
  let layers: SceneLayer[] = [];
  const got: string[] = [];
  const skins: Record<string, Record<number, Float32Array>> = { bones_a: {}, bones_b: {} };
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
    layers = bundle.layers;
    const state = SceneState.fromBundle(bundle);
    const puppets = new ScenePuppets(puppetEntries(bundle.layers));
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
    const object = (name: string) => bundle.layers.find((layer) => layer.name === name)!.object;
    for (let i = 0; i < fixture.dt.length; i++) {
      // 一帧的顺序（同探针回放与宿主）：交时间 → puppet 推进 → 脚本
      stepPuppets({ puppets, scripts }, state, fixture.dt[i], fixture.time[i]);
      scripts.frame(fixture.dt[i], fixture.time[i]);
      if (wanted.has(i + 1))
        for (const name of ["bones_a", "bones_b"]) skins[name][i + 1] = Float32Array.from(puppets.skin(object(name))!);
    }
    got.push(
      ...(scripts.result().console.matched ?? [])
        .filter((line) => line.includes("[kbp] p12d "))
        .map((line) => line.replace(/^.*?\[kbp\] p12d /, "")),
    );
  });
  afterAll(() => scripts?.dispose());

  it("脚本日志行：非数字部分逐字相同，数字在 1e-3 内（打印每类行的最大差）", () => {
    const want = fixture.log;
    expect(got.length).toBe(want.length);
    const worst = new Map<string, { diff: number; line: string }>();
    for (let i = 0; i < want.length; i++) {
      const a = split(got[i]);
      const b = split(want[i]);
      if (a.shape !== b.shape || a.numbers.length !== b.numbers.length)
        expect.fail(`第 ${i} 行形状不同\n  WPE ：${want[i]}\n  我们：${got[i]}`);
      const diff = Math.max(0, ...a.numbers.map((value, k) => Math.abs(value - b.numbers[k])));
      const key = kind(want[i]);
      if (diff > (worst.get(key)?.diff ?? -1)) worst.set(key, { diff, line: `${i}: ${want[i]} | ${got[i]}` });
    }
    for (const [key, { diff, line }] of worst)
      console.log(`[p12-bones] ${key} 行最大差 ${diff.toExponential(3)}  ${line.slice(0, 200)}`);
    for (const [key, { diff, line }] of worst) expect(diff, `${key}：${line}`).toBeLessThanOrEqual(TOLERANCE);
    // 动作都真的发生过
    for (const name of ["a.set1", "a.set2", "a.imp1", "a.imp2", "b.impEmpty", "b.imp1", "b.resetEmpty", "a.setName"])
      expect(
        want.some((line) => line.startsWith(`act,${name}`)),
        name,
      ).toBe(true);
  });

  it("buildPuppet 填的骨骼名与骨骼数（P12d-2）：来自 mdl，静态 puppet 没有骨骼时为 0", () => {
    const puppet = (name: string) => layers.find((layer) => layer.name === name)!.puppet!;
    expect(puppet("bones_a").names).toEqual(["root", "b1", "b2", "b3"]);
    expect(puppet("bones_a").boneCount).toBe(4);
    expect(puppet("bones_b").names).toEqual(["c0", "c1"]);
    expect(puppet("bones_b").boneCount).toBe(2);
    expect(puppet("static").names).toEqual([]);
    expect(puppet("static").boneCount).toBe(0);
  });

  it("g_Bones 与 WPE（抓帧 200–299，bones_a 与 bones_b）：每帧最大差打印，≤ 1e-3 px", () => {
    let max = 0;
    let at = "";
    const perFrame: number[] = [];
    for (const name of ["bones_a", "bones_b"] as const) {
      for (const frame of fixture.frames) {
        const want = (fixture.bones[name] as Record<string, number[]>)[String(frame)];
        const skin = skins[name][frame];
        expect(skin.length).toBe(want.length);
        let frameMax = 0;
        for (let i = 0; i < want.length; i++) frameMax = Math.max(frameMax, Math.abs(skin[i] - Math.fround(want[i])));
        perFrame.push(frameMax);
        if (frameMax > max) [max, at] = [frameMax, `${name} 帧 ${frame}`];
      }
    }
    console.log(
      `[p12-bones] g_Bones 最大差 ${max.toExponential(3)}（${at}），逐位相同的帧 ${perFrame.filter((v) => v === 0).length}/${perFrame.length}`,
    );
    expect(max).toBeLessThanOrEqual(TOLERANCE);
  });
});
