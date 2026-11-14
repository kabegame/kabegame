/**
 * P12a 步骤 3 的编译侧单测（`.claude/plans/wpe-import/3-scene/phase12/phase-12a-mesh-animation.md`「步骤 3」）：
 * - 图像层读 `puppet`（`layer.puppet`）：直接上屏的材质变体（基础材质 + `SKINNING` / `BONECOUNT`，稳定键同基础 pass，`layer.passes` 不带组合键）、
 *   合成路径（有 effect / colorBlendMode 混合 / 被依赖，passthrough 材质 + puppet 组合键 + `BLENDMODE`，`layer.passthrough` 不再编）、
 *   写死关闭的 effect 不算 effect；mdl 读不到、fullscreen / 组合层上 WPE 整段跳过，不报；
 * - 能力表：puppet 的 pass 放行 `SKINNING` 与 `g_Bones`，别的 pass 照报 `combo:SKINNING` / `uniform:g_Bones`；图像层的 `animationlayers` 放行，
 *   模型对象上照报 `object:animationlayers`；`model:puppet` 不再报；
 * - 动画层绑定：`rate` / `blend` / `visible` 的 `{user}` 登记成 `animation-layer` 目标，`SceneState` 起始值与就地写（条件、不合法的值）；
 * - `transferableBuffers` 带上网格与动画帧缓冲。
 * 依据 rea-p12-mdl 第 9 节，`p12-REPORT` 用例 4、8。渲染图与 `g_Bones` 的写法见 `render/p12a.test.ts`。
 */
import { gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { compileScene, transferableBuffers, type SceneBundle } from "./bundle";
import { checkObjectFeatures, checkProgramFeatures, PUPPET_COMBOS, PUPPET_UNIFORMS } from "./features";
import type { SceneReader } from "./fs";
import { SceneState } from "../render/state";
import modes from "../puppet/fixtures/p12-modes.json";
import type { TranslateRequest, TranslateResult, Wpesl2wgsl } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

const loop10 = modes.puppets.find((item) => item.name === "loop10")!;
const mdl = new Uint8Array(gunzipSync(Buffer.from(loop10.mdlGzip, "base64")));
const animationId = (loop10.layers[0] as { animation: number }).animation;

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

/** 假翻译器：组合键原样回给 `combos`，带 `SKINNING` 时多一个 `g_Bones`（翻译器的反射形状：`array<mat4x3<f32>, BONECOUNT>`，每项 64 字节）。 */
function fakeTranslator(requests: TranslateRequest[]): Wpesl2wgsl {
  return {
    async translate(request: TranslateRequest): Promise<TranslateResult> {
      requests.push(request);
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

const EFFECT_FILES: Record<string, string> = {
  "P:/p/effects/fx/effect.json": JSON.stringify({ passes: [{ material: "materials/fx.json" }] }),
  "P:/p/materials/fx.json": JSON.stringify({ passes: [{ shader: "fxs", blending: "normal" }] }),
  "P:/p/shaders/fxs.vert": "void main() {}",
  "P:/p/shaders/fxs.frag": "void main() {}",
};

async function compile(
  objects: Record<string, unknown>[],
  options: { model?: Record<string, unknown>; files?: Record<string, Uint8Array | string> } = {},
) {
  const requests: TranslateRequest[] = [];
  const bundle = await compileScene({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    reader: memoryReader({
      "P:/p/project.json": JSON.stringify({ file: "scene.json" }),
      "P:/p/scene.json": JSON.stringify({ general: { orthogonalprojection: { width: 1920, height: 1080 } }, objects }),
      "P:/p/models/pup.json": JSON.stringify({
        material: "materials/a.json",
        puppet: "models/pup.mdl",
        ...options.model,
      }),
      "P:/p/models/plain.json": JSON.stringify({ material: "materials/a.json" }),
      "P:/p/models/pup.mdl": mdl,
      "P:/p/materials/a.json": JSON.stringify({ passes: [{ shader: "s", blending: "translucent" }] }),
      "P:/p/materials/util/effectpassthrough.json": JSON.stringify({
        passes: [
          { shader: "pt", blending: "normal", depthtest: "disabled", depthwrite: "disabled", cullmode: "nocull" },
        ],
      }),
      "P:/p/shaders/s.vert": "void main() {}",
      "P:/p/shaders/s.frag": "void main() {}",
      "P:/p/shaders/pt.vert": "void main() {}",
      "P:/p/shaders/pt.frag": "void main() {}",
      ...EFFECT_FILES,
      ...options.files,
    }),
    translator: fakeTranslator(requests),
    postprocess: "disabled",
    exhaustive: true,
  });
  return { bundle, requests };
}

const layerJson = (extra: Record<string, unknown> = {}) => ({
  animation: animationId,
  name: "walk",
  rate: 1,
  blend: 1,
  visible: true,
  ...extra,
});
const puppetObject = (extra: Record<string, unknown> = {}) => ({
  id: 1,
  name: "P",
  image: "models/pup.json",
  origin: "960 540 0",
  animationlayers: [layerJson()],
  ...extra,
});
describe("compileScene：图像层读 puppet（P12a 步骤 3 点 1）", () => {
  it("直接上屏：puppet 变体 = 基础材质 + SKINNING / BONECOUNT，稳定键同基础 pass，layer.passes 不带组合键；不报任何键", async () => {
    const { bundle, requests } = await compile([puppetObject()]);
    expect(bundle.unsupported).toEqual([]);
    const layer = bundle.layers[0];
    expect(layer.puppet).toMatchObject({
      path: "models/pup.mdl",
      composite: false,
      upload: null,
      combos: { SKINNING: 1, BONECOUNT: 1 },
    });
    expect(layer.puppet!.layers).toHaveLength(1);
    expect(layer.puppet!.passes.map((pass) => pass.key)).toEqual(["objects/0/passes/0"]);
    expect(layer.passes.map((pass) => pass.key)).toEqual(["objects/0/passes/0"]);
    // 基础 pass 不带组合键、puppet 变体带（两次翻译请求，顺序：基础、变体）
    const all = requests.map((request) => request.combos ?? {});
    expect(all.some((combos) => combos.SKINNING === undefined)).toBe(true);
    expect(all.some((combos) => combos.SKINNING === 1 && combos.BONECOUNT === 1)).toBe(true);
    expect(layer.passes[0].program).not.toBe(layer.puppet!.passes[0].program);
    expect(layer.passthrough).toBeNull();
  });

  it("合成路径：colorBlendMode 混合 → passthrough 材质 + puppet 组合键 + BLENDMODE 编成 upload，passes 为空，layer.passthrough 不再编", async () => {
    const { bundle, requests } = await compile([puppetObject({ colorBlendMode: 7 })]);
    expect(bundle.unsupported).toEqual([]);
    const layer = bundle.layers[0];
    expect(layer.puppet).toMatchObject({ composite: true, passes: [] });
    expect(layer.puppet!.upload).toMatchObject({ key: "objects/0/puppetupload", uniforms: { g_Color4: [1, 1, 1, 1] } });
    expect(layer.passthrough).toBeNull();
    expect(requests.map((request) => request.combos ?? {})).toContainEqual({
      BLENDMODE: 7,
      FOG_COMPUTED: 1,
      SKINNING: 1,
      BONECOUNT: 1,
    });
  });

  it("合成路径：有 effect 时 BLENDMODE 0；写死关闭、没有绑定的 effect 不算 effect（直接上屏）", async () => {
    const fx = (visible: unknown) => ({ file: "effects/fx/effect.json", id: 5, name: "fx", visible });
    const withEffect = await compile([puppetObject({ effects: [fx(true)] })]);
    expect(withEffect.bundle.unsupported).toEqual([]);
    expect(withEffect.bundle.layers[0].puppet).toMatchObject({ composite: true, passes: [] });
    expect(withEffect.requests.map((request) => request.combos ?? {})).toContainEqual({
      BLENDMODE: 0,
      FOG_COMPUTED: 1,
      SKINNING: 1,
      BONECOUNT: 1,
    });
    const disabled = await compile([puppetObject({ effects: [fx(false)] })]);
    expect(disabled.bundle.layers[0].puppet).toMatchObject({ composite: false });
    expect(disabled.bundle.layers[0].puppet!.passes).toHaveLength(1);
    // 绑了用户属性的 effect（运行时可能打开）算：WPE 加载时置 0x10
    const bound = await compile([puppetObject({ effects: [fx({ user: "on", value: false })] })]);
    expect(bound.bundle.layers[0].puppet).toMatchObject({ composite: true });
  });

  it("合成路径：被依赖的图层（别的对象的 dependencies 含它的 id）同样走合成", async () => {
    const { bundle } = await compile([
      puppetObject(),
      { id: 2, name: "B", image: "models/plain.json", dependencies: [1] },
    ]);
    expect(bundle.layers[0]).toMatchObject({ dependedOn: true });
    expect(bundle.layers[0].puppet).toMatchObject({ composite: true });
    expect(bundle.layers[0].passthrough).toBeNull();
  });

  it("mdl 读不到、网格为空、fullscreen 与组合层：WPE 不读 puppet，照常画四边形，不报", async () => {
    const missing = await compile([puppetObject()], { model: { puppet: "models/none.mdl" } });
    expect(missing.bundle.layers[0].puppet).toBeNull();
    expect(missing.bundle.unsupported).toEqual([]);
    for (const flag of ["fullscreen", "passthrough"]) {
      const skipped = await compile([puppetObject()], { model: { [flag]: true } });
      expect(skipped.bundle.layers[0].puppet, flag).toBeUndefined();
      expect(skipped.bundle.unsupported, flag).not.toContain("model:puppet");
    }
    const notString = await compile([puppetObject()], { model: { puppet: 5 } });
    expect(notString.bundle.layers[0].puppet).toBeUndefined();
  });

  it("没有 puppet 的图像层：layer.puppet 不填，animationlayers 也放行（WPE 只在读 puppet 时读它）", async () => {
    const { bundle } = await compile([{ id: 1, image: "models/plain.json", animationlayers: [layerJson()] }]);
    expect(bundle.layers[0].puppet).toBeUndefined();
    expect(bundle.unsupported).toEqual([]);
  });
});

describe("能力表：puppet 的 pass（P12a 步骤 3 点 2）", () => {
  const skinned = {
    ok: true,
    uniforms: [{ name: "g_Bones", type: "array<mat4x3<f32>, 2>", offset: 0, size: 128, array: 2, stride: 64 }],
    combos: [{ name: "SKINNING", value: 1, source: "request" }],
  } as unknown as TranslateResult;

  it("checkProgramFeatures：默认报 uniform:g_Bones 与 combo:SKINNING；puppet 放行表里的不报（P12b1 起含 SKINNING_ALPHA、MORPHING 与对应 uniform）", () => {
    const plain = new Set<string>();
    checkProgramFeatures(skinned, plain);
    expect([...plain].sort()).toEqual(["combo:SKINNING", "uniform:g_Bones"]);
    const allowed = new Set<string>();
    checkProgramFeatures(skinned, allowed, PUPPET_UNIFORMS, PUPPET_COMBOS);
    expect([...allowed]).toEqual([]);
    const alpha = new Set<string>();
    checkProgramFeatures(
      {
        ...skinned,
        combos: [
          { name: "SKINNING", value: 1 },
          { name: "SKINNING_ALPHA", value: 1 },
          { name: "MORPHING", value: 1 },
        ],
      } as unknown as TranslateResult,
      alpha,
      PUPPET_UNIFORMS,
      PUPPET_COMBOS,
    );
    expect([...alpha]).toEqual([]);
    // 非 puppet 的 pass 读到照报（P12b1：放行只在 puppet 的 pass 里）
    const plainAlpha = new Set<string>();
    checkProgramFeatures(
      {
        ...skinned,
        uniforms: [
          ...(skinned.uniforms ?? []),
          { name: "g_BonesAlpha", type: "array<f32, 2>", offset: 128, size: 32, array: 2, stride: 16 },
          { name: "g_MorphOffsets", type: "array<u32, 12>", offset: 160, size: 192, array: 12, stride: 16 },
          { name: "g_MorphWeights", type: "array<f32, 12>", offset: 352, size: 192, array: 12, stride: 16 },
        ],
        combos: [
          { name: "SKINNING_ALPHA", value: 1 },
          { name: "MORPHING", value: 1 },
        ],
      } as unknown as TranslateResult,
      plainAlpha,
    );
    expect([...plainAlpha].sort()).toEqual(
      [
        "combo:MORPHING",
        "combo:SKINNING_ALPHA",
        "uniform:g_BonesAlpha",
        "uniform:g_Bones",
        "uniform:g_MorphOffsets",
        "uniform:g_MorphWeights",
      ].sort(),
    );
  });

  it("非 puppet 的图层读 g_Bones / SKINNING 照报", async () => {
    const files = {
      "P:/p/materials/a.json": JSON.stringify({ passes: [{ shader: "s", combos: { SKINNING: 1, BONECOUNT: 2 } }] }),
    };
    const { bundle } = await compile([{ id: 1, image: "models/plain.json" }], { files });
    expect(bundle.unsupported).toEqual(["combo:SKINNING", "uniform:g_Bones"]);
  });

  it("animationlayers：图像层放行，模型对象与别的对象上照报", () => {
    const keys = (object: Record<string, unknown>) => {
      const out = new Set<string>();
      checkObjectFeatures(object as never, out);
      return [...out];
    };
    expect(keys({ id: 1, image: "models/pup.json", animationlayers: [layerJson()] })).toEqual([]);
    expect(keys({ id: 1, model: "models/a.mdl", animationlayers: [layerJson()] })).toEqual(["object:animationlayers"]);
    expect(keys({ id: 1, particle: "particles/a.json", animationlayers: [layerJson()] })).toContain(
      "object:animationlayers",
    );
  });
});

describe("动画层绑定（P12a 步骤 3 点 3，p12-REPORT 用例 4）", () => {
  const bound = () =>
    puppetObject({
      animationlayers: [
        layerJson({
          rate: { user: "speed", value: 2 },
          blend: { user: "mix", value: 0.5 },
          visible: { user: { name: "walking", condition: "1" }, value: true },
        }),
      ],
    });

  it("rate / blend / visible 的 {user} 登记成 animation-layer 目标（对象下标、层下标、字段），起始值按编译期属性值", async () => {
    const { bundle } = await compile([bound()]);
    expect(bundle.unsupported).toEqual([]);
    const targets = bundle.bindings
      .filter((item) => item.target.kind === "animation-layer")
      .map((item) => [item.property, item.condition, item.target]);
    expect(targets).toEqual([
      ["speed", undefined, { kind: "animation-layer", object: 0, layer: 0, field: "rate" }],
      ["mix", undefined, { kind: "animation-layer", object: 0, layer: 0, field: "blend" }],
      ["walking", "1", { kind: "animation-layer", object: 0, layer: 0, field: "visible" }],
    ]);
    expect(bundle.layers[0].puppet!.layers[0]).toMatchObject({ rate: 2, blend: 0.5 });
    const state = SceneState.fromBundle(bundle);
    // `visible` 带 condition、属性 `walking` 工程没声明：保持 `value`、不比条件（P3a 修复，同 WPE 实测）
    expect(state.animationLayers.get("0:0")).toEqual({ rate: 2, blend: 0.5, visible: true });
  });

  it("就地写：数字 / 布尔 / 字符串各按 float 规则，条件先换成布尔；不合法的值不改字段；不标脏、不要重编译", async () => {
    const { bundle } = await compile([bound()]);
    const state = SceneState.fromBundle(bundle);
    const find = (property: string) => bundle.bindings.find((item) => item.property === property)!;
    expect(state.needsRecompile(find("speed"), 3)).toBe(false);
    expect(state.write(find("speed"), 3)).toBe("applied");
    expect(state.animationLayers.get("0:0")!.rate).toBe(3);
    state.write(find("speed"), "0.25");
    expect(state.animationLayers.get("0:0")!.rate).toBe(0.25);
    state.write(find("speed"), true);
    expect(state.animationLayers.get("0:0")!.rate).toBe(1);
    state.write(find("speed"), "abc");
    expect(state.animationLayers.get("0:0")!.rate).toBe(1);
    state.write(find("mix"), 0);
    expect(state.animationLayers.get("0:0")!.blend).toBe(0);
    // visible 带 condition：属性值转字符串后和 condition 比
    state.write(find("walking"), 0);
    expect(state.animationLayers.get("0:0")!.visible).toBe(false);
    state.write(find("walking"), 1);
    expect(state.animationLayers.get("0:0")!.visible).toBe(true);
    // 写进去的值不碰别的状态
    const dirty = state.takeDirty();
    expect([...dirty.layers, ...dirty.passes, ...dirty.structures]).toEqual([]);
  });

  it("目标不在 bundle 里（层下标越界）时写入什么都不做", async () => {
    const { bundle } = await compile([bound()]);
    const state = SceneState.fromBundle(bundle);
    expect(
      state.write({ property: "x", target: { kind: "animation-layer", object: 9, layer: 9, field: "rate" } }, 5),
    ).toBe("applied");
    expect([...state.animationLayers.keys()]).toEqual(["0:0"]);
  });
});

describe("transferableBuffers（P12a 步骤 3 点 1）", () => {
  it("带上 puppet 网格的顶点 / 索引（mdl 文件缓冲）与动画帧数据", async () => {
    const { bundle } = await compile([puppetObject()]);
    const puppet = bundle.layers[0].puppet!;
    const buffers = transferableBuffers(bundle as SceneBundle);
    expect(buffers).toContain(puppet.mesh.vertices.buffer);
    expect(buffers).toContain(puppet.mesh.indices.buffer);
    for (const animation of puppet.animations) expect(buffers).toContain(animation.frames.buffer);
    expect(new Set(buffers).size).toBe(buffers.length);
  });
});
