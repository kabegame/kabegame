/**
 * P12c-1 的编译侧单测（`.claude/plans/wpe-import/3-scene/phase12/phase-12c-script.md` 点 1、点 5）：
 * - `PuppetAnimation.events`、`PuppetLayerDef.entry`；
 * - 动画层字段脚本的属主 `animation-layer`：`collectScripts` 认路径、`targetOf` 只给 `rate` / `blend` / `visible` 目标；
 * - bundle 只核对 `entry` 对应的层建出来了没有（层 id = entry，P12e 起不再回填层下标），对象没有运行时或这一项被丢掉时把脚本从列表里删掉；
 * - 键：`rate` / `blend` / `visible` 挂脚本不报，其余五个可写字段照报 `puppet:layer-script`。
 */
import { gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { compileScene } from "./bundle";
import type { SceneReader } from "./fs";
import { parseMdl } from "./mdl";
import { buildPuppet } from "./puppet";
import { collectScripts } from "./scripts";
import modes from "../puppet/fixtures/p12-modes.json";
import type { TranslateRequest, TranslateResult, Wpesl2wgsl } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

const loop10 = modes.puppets.find((item) => item.name === "loop10")!;
const mdl = new Uint8Array(gunzipSync(Buffer.from(loop10.mdlGzip, "base64")));
const animationId = (loop10.layers[0] as { animation: number }).animation;
const SCRIPT = "export function update(value) { return value; }";

describe("buildPuppet：entry 与 events", () => {
  it("entry 是 animationlayers 数组里的下标：丢掉的项（找不到动画、不是对象）让它与层下标错开", () => {
    const file = parseMdl(mdl);
    const { puppet } = buildPuppet(
      file,
      [{ animation: 123456789 }, 5, { animation: animationId, name: "a" }, { animation: animationId, name: "b" }],
      "p.mdl",
    );
    expect(puppet!.layers.map((layer) => [layer.entry, layer.name])).toEqual([
      [2, "a"],
      [3, "b"],
    ]);
  });

  it("动画带上 MDLA 事件（时间与 JSON 原样）", () => {
    const file = parseMdl(mdl);
    const { puppet } = buildPuppet(file, [{ animation: animationId }], "p.mdl");
    expect(puppet!.animations[0].events).toEqual(
      file.animations.find((animation) => animation.id === animationId)!.events,
    );
  });
});

describe("collectScripts：动画层字段脚本的属主与目标", () => {
  const scene = (layers: unknown[]) => ({
    objects: [
      { id: 1, image: "x.json" },
      { id: 2, animationlayers: layers },
    ],
  });

  it("路径 objects/<i>/animationlayers/<k>/<字段>：属主 animation-layer，收集时 layer 就是层 id（= entry，P12e）", async () => {
    const { list } = await collectScripts(
      scene([
        {},
        {
          rate: { script: SCRIPT, value: 1 },
          blend: { script: SCRIPT, value: 1 },
          visible: { script: SCRIPT, value: true },
        },
      ]) as never,
      {},
      [],
    );
    // 脚本按 WPE 的登记顺序排（registration.ts），这里只核内容，按 id 排序
    list.sort((a, b) => a.id.localeCompare(b.id));
    expect(list.map((script) => [script.id, script.owner, script.layer])).toEqual([
      ["objects/1/animationlayers/1/blend", { kind: "animation-layer", object: 1, entry: 1, layer: 1 }, 1],
      ["objects/1/animationlayers/1/rate", { kind: "animation-layer", object: 1, entry: 1, layer: 1 }, 1],
      ["objects/1/animationlayers/1/visible", { kind: "animation-layer", object: 1, entry: 1, layer: 1 }, 1],
    ]);
    expect(list.map((script) => [script.target, script.valueType])).toEqual([
      [{ kind: "animation-layer", object: 1, layer: 1, field: "blend" }, "float"],
      [{ kind: "animation-layer", object: 1, layer: 1, field: "rate" }, "float"],
      [{ kind: "animation-layer", object: 1, layer: 1, field: "visible" }, "bool"],
    ]);
  });

  it("别的字段（name / additive / blendin / blendout / blendtime）是 unsupported，不会落到图层自己的同名字段", async () => {
    const { list } = await collectScripts(
      scene([
        {
          name: { script: SCRIPT, value: "n" },
          additive: { script: SCRIPT, value: false },
          blendin: { script: SCRIPT, value: false },
          blendout: { script: SCRIPT, value: false },
          blendtime: { script: SCRIPT, value: 0.5 },
        },
      ]) as never,
      {},
      [],
    );
    expect(list).toHaveLength(5);
    for (const script of list) expect(script.target.kind).toBe("unsupported");
  });

  it("图层自己的 visible 脚本仍是 layer 属主（不被动画层吞掉）", async () => {
    const { list } = await collectScripts(
      { objects: [{ id: 1, visible: { script: SCRIPT, value: true }, animationlayers: [] }] } as never,
      {},
      [],
    );
    expect(list[0].owner).toEqual({ kind: "layer", object: 0 });
    expect(list[0].target).toMatchObject({ kind: "layer", field: "visible" });
  });
});

function memoryReader(files: Record<string, Uint8Array | string>): SceneReader {
  const bytes = (path: string) => {
    const value = files[path.replace(/\\/g, "/")];
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

async function compile(objects: Record<string, unknown>[]) {
  return compileScene({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    reader: memoryReader({
      "P:/p/project.json": JSON.stringify({ file: "scene.json" }),
      "P:/p/scene.json": JSON.stringify({ general: { orthogonalprojection: { width: 1920, height: 1080 } }, objects }),
      "P:/p/models/pup.json": JSON.stringify({ material: "materials/a.json", puppet: "models/pup.mdl" }),
      "P:/p/models/plain.json": JSON.stringify({ material: "materials/a.json" }),
      "P:/p/models/pup.mdl": mdl,
      "P:/p/materials/a.json": JSON.stringify({ passes: [{ shader: "s", blending: "translucent" }] }),
      "P:/p/shaders/s.vert": "void main() {}",
      "P:/p/shaders/s.frag": "void main() {}",
    }),
    translator: fakeTranslator(),
    postprocess: "disabled",
    exhaustive: true,
  });
}

const script = (value: unknown) => ({ script: SCRIPT, value });
const layerJson = (extra: Record<string, unknown> = {}) => ({ animation: animationId, name: "walk", ...extra });
const puppetObject = (layers: unknown[], extra: Record<string, unknown> = {}) => ({
  id: 1,
  name: "P",
  image: "models/pup.json",
  origin: "960 540 0",
  animationlayers: layers,
  ...extra,
});

describe("compileScene：动画层字段脚本的属主回填", () => {
  it("层 id：属主与目标的 layer 是层 id（= entry，P12e），不是层表里的位置；entry ≠ 位置时（前面的项被丢）也按 entry", async () => {
    const bundle = await compile([
      { id: 9, image: "models/plain.json" },
      puppetObject([
        { animation: 424242, rate: script(1) }, // 动画找不到：整层丢掉，脚本跟着删
        layerJson({ rate: script(1), visible: script(true) }),
      ]),
    ]);
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.layers[1].puppet!.layers.map((layer) => layer.entry)).toEqual([1]);
    expect(bundle.scripts.list.map((item) => [item.id, item.owner, item.target])).toEqual([
      [
        "objects/1/animationlayers/1/rate",
        { kind: "animation-layer", object: 1, entry: 1, layer: 1 },
        { kind: "animation-layer", object: 1, layer: 1, field: "rate" },
      ],
      [
        "objects/1/animationlayers/1/visible",
        { kind: "animation-layer", object: 1, entry: 1, layer: 1 },
        { kind: "animation-layer", object: 1, layer: 1, field: "visible" },
      ],
    ]);
  });

  it("对象不是 skinned puppet 时脚本从列表里删掉：没有 puppet 的图像层", async () => {
    const bundle = await compile([
      { id: 1, image: "models/plain.json", animationlayers: [layerJson({ rate: script(1) })] },
    ]);
    expect(bundle.scripts.list).toEqual([]);
  });

  it("键：rate / blend / visible 挂脚本不报；name / additive / blendin / blendout / blendtime 报 puppet:layer-script", async () => {
    const ok = await compile([puppetObject([layerJson({ rate: script(1), blend: script(1), visible: script(true) })])]);
    expect(ok.unsupported).toEqual([]);
    expect(ok.scripts.list).toHaveLength(3);
    for (const field of ["name", "additive", "blendin", "blendout", "blendtime"]) {
      const bad = await compile([puppetObject([layerJson({ [field]: script(field === "name" ? "n" : 0) })])]);
      expect(bad.unsupported, field).toContain("puppet:layer-script");
    }
  });
});
