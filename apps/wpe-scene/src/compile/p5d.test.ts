/**
 * P5d 步骤 1 的编译侧单测（`.claude/plans/wpe-import/3-scene/phase5/phase-5d-camera-depth.md`「步骤 1」点 1、点 5），依据是
 * p5-REPORT「P5d 语义的实测核对」的深度、非法值、缺键三行：
 * - `normalizeDepthKeys`：缺键为开（`cullmode` normal、`depthtest` / `depthwrite` enabled），合法值原样，写了但不是表里的串（含非字符串、
 *   `null`）取表的第一项（`depthtest` / `depthwrite` 落到 disabled、`cullmode` 落到 normal）；
 * - 能力表不再报 `cull:*`、`depthtest:*`、`depthwrite:*`（模型的也去掉）；拼错的键（ricepod 的 `depthtesting`）照报 `material:<键>`；
 * - `compileScene`：图像层、模型的 `ScenePass` 一套规则，非法值不报、规整后写进 pass。
 */
import { describe, expect, it, vi } from "vitest";
import { compileScene, type SceneBundle } from "./bundle";
import { checkPassFeatures, normalizeDepthKeys } from "./features";
import type { SceneReader } from "./fs";
import type { MaterialPass } from "./model";
import type { Wpesl2wgsl } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

describe("normalizeDepthKeys：照 WPE 的表规整（rea-p5-mesh 3.3）", () => {
  it("缺键为开：normal / enabled / enabled（p5d-depth 缺全部深度键的图像层测、写、剔背面）", () => {
    expect(normalizeDepthKeys({})).toEqual({ cullmode: "normal", depthtest: "enabled", depthwrite: "enabled" });
  });

  it("合法值原样", () => {
    expect(normalizeDepthKeys({ cullmode: "nocull", depthtest: "disabled", depthwrite: "disabled" })).toEqual({
      cullmode: "nocull",
      depthtest: "disabled",
      depthwrite: "disabled",
    });
    expect(normalizeDepthKeys({ cullmode: "normal", depthtest: "enabled", depthwrite: "enabled" })).toEqual({
      cullmode: "normal",
      depthtest: "enabled",
      depthwrite: "enabled",
    });
    // 三个键各自规整，互不影响
    expect(normalizeDepthKeys({ depthwrite: "disabled" })).toEqual({
      cullmode: "normal",
      depthtest: "enabled",
      depthwrite: "disabled",
    });
  });

  it.each([["yes"], ["back"], ["Disabled"], ["NOCULL"], [""], [1], [0], [true], [null], [{}], [["enabled"]]])(
    '非法值 %j：depthtest / depthwrite 落到 disabled，cullmode 落到 normal（p5d-depth 的 `"yes"` 不测、`"back"` 剔背面）',
    (value) => {
      const pass = { cullmode: value, depthtest: value, depthwrite: value } as unknown as MaterialPass;
      expect(normalizeDepthKeys(pass)).toEqual({ cullmode: "normal", depthtest: "disabled", depthwrite: "disabled" });
    },
  );
});

describe("checkPassFeatures：深度与剔除三个键都不报（P5d 步骤 1）", () => {
  const keys = (pass: MaterialPass) => {
    const out = new Set<string>();
    checkPassFeatures(pass, out);
    return [...out].sort();
  };

  it("缺键、合法值、非法值、会写深度的组合都不报 cull:* / depthtest:* / depthwrite:*", () => {
    const values: unknown[] = [undefined, "enabled", "disabled", "normal", "nocull", "yes", "back", "front", 1, null];
    for (const blending of ["normal", "translucent", "additive"])
      for (const cullmode of values)
        for (const depthtest of values)
          for (const depthwrite of values) {
            const pass = { shader: "s", blending, cullmode, depthtest, depthwrite } as unknown as MaterialPass;
            for (const key of Object.keys(pass)) if (pass[key] === undefined) delete pass[key];
            expect(keys(pass), JSON.stringify(pass)).toEqual([]);
          }
  });

  it("拼错的键（ricepod 的 depthtesting / depthwriting，WPE 不认、等于缺键）照报 material:<键>", () => {
    expect(keys({ shader: "s", depthtesting: "enabled", depthwriting: "enabled" } as MaterialPass)).toEqual([
      "material:depthtesting",
      "material:depthwriting",
    ]);
  });
});

// ———— compileScene ————

function memoryReader(files: Record<string, string>): SceneReader {
  const bytes = (path: string) => {
    const value = files[path.replace(/\\/g, "/")];
    if (value === undefined) throw new TypeError("Failed to fetch");
    return new TextEncoder().encode(value);
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

/** 假翻译器：一律成功、没有接口，不依赖 wasm。 */
const fakeTranslator = {
  async translate() {
    return { ok: true, uniforms: [], textures: [], combos: [] };
  },
} as unknown as Wpesl2wgsl;

/** 每个材质一个图像层（`models/<i>.json` → `materials/<i>.json`），着色器 `s`。 */
async function compileImages(passes: Record<string, unknown>[]): Promise<SceneBundle> {
  const files: Record<string, string> = {
    "P:/p/project.json": JSON.stringify({ file: "scene.json" }),
    "P:/p/scene.json": JSON.stringify({
      general: { orthogonalprojection: { width: 1920, height: 1080 } },
      objects: passes.map((_, i) => ({ id: i + 1, name: `L${i}`, image: `models/${i}.json`, origin: "960 540 0" })),
    }),
    "P:/p/shaders/s.vert": "void main() {}",
    "P:/p/shaders/s.frag": "void main() {}",
  };
  passes.forEach((pass, i) => {
    files[`P:/p/models/${i}.json`] = JSON.stringify({ material: `materials/${i}.json` });
    files[`P:/p/materials/${i}.json`] = JSON.stringify({ passes: [{ shader: "s", ...pass }] });
  });
  return compileScene({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    reader: memoryReader(files),
    translator: fakeTranslator,
    postprocess: "disabled",
    exhaustive: true,
  });
}

describe("compileScene：图像层的 ScenePass 按 WPE 规整（P5d 步骤 1 点 1）", () => {
  it("缺键、合法值、非法值：写进 ScenePass 的是规整后的值，能力表一项不报", async () => {
    const bundle = await compileImages([
      { blending: "translucent" },
      { blending: "translucent", cullmode: "nocull", depthtest: "disabled", depthwrite: "disabled" },
      { blending: "normal", cullmode: "back", depthtest: "yes", depthwrite: "enabled" },
      { blending: "normal", cullmode: 1, depthtest: null, depthwrite: "no" },
    ]);
    expect(bundle.unsupported).toEqual([]);
    expect(
      bundle.layers.map(({ passes: [pass] }) => [pass.cullmode, pass.depthtest, pass.depthwrite].join(" ")),
    ).toEqual([
      "normal enabled enabled",
      "nocull disabled disabled",
      "normal disabled enabled",
      "normal disabled disabled",
    ]);
  });
});
