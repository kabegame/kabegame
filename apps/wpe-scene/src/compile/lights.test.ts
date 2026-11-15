import { describe, expect, it } from "vitest";
import type { TranslateRequest, TranslateResult, Wpesl2wgsl } from "../wpesl2wgsl";
import { compileScene } from "./bundle";
import { checkObjectFeatures, isEngineUniform } from "./features";
import type { SceneReader } from "./fs";
import {
  engineDefines,
  legacyLightUniforms,
  lightAxes,
  lightConfigIssues,
  lightCounts,
  lightFrame,
  lightFrameUniforms,
  lightUniforms,
  litDefines,
  readsLegacyLights,
} from "./lights";
import type { SceneObject, SceneScalar, SceneValue } from "./model";

/** 不带阴影的计数（P13d 起 `LightCounts` 带阴影与聚光 cookie 的计数）。 */
const NONE = { pointShadow: 0, directionalShadow: 0, spotShadow: 0, spotCookie: 0, spotShadowCookie: 0 };
const plain = (value: SceneValue | undefined) => value as string | number | boolean | null | undefined;
const close = (actual: number[], expected: number[]) => {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index], 5));
};

describe("general.lightconfig", () => {
  it("灯数只取低 4 位，缺键与非数字按 0", () => {
    expect(lightCounts({})).toEqual({ ...NONE, point: 0, spot: 0, tube: 0, directional: 0 });
    expect(lightCounts({ lightconfig: { point: 2, spot: 17, tube: "3", directional: 15 } })).toEqual({
      ...NONE,
      point: 2,
      spot: 1,
      tube: 0,
      directional: 15,
    });
  });

  it("阴影计数按档位（P13d）：档位 0 时阴影计数不读，spotshadowcookie 并进 spotcookie；各 2 位", () => {
    const config = {
      lightconfig: { point: 2, pointshadow: 1, directional: 1, directionalshadow: 5, spotshadowcookie: 1 },
    };
    expect(lightCounts(config, 0)).toEqual({
      ...NONE,
      point: 2,
      spot: 0,
      tube: 0,
      directional: 1,
      spotCookie: 1,
    });
    expect(lightCounts(config, 1)).toEqual({
      ...NONE,
      point: 2,
      spot: 0,
      tube: 0,
      directional: 1,
      pointShadow: 1,
      directionalShadow: 1,
      spotShadowCookie: 1,
    });
  });

  it("只有聚光的阴影与 cookie 照报（P13d 起点光、平行光的阴影支持）", () => {
    expect(lightConfigIssues({})).toEqual([]);
    const config = { lightconfig: { point: 1, spotcookie: 1, pointshadow: 2, spotshadow: 1 } };
    expect(lightConfigIssues(config, 2)).toEqual(["lightconfig:spotshadow", "lightconfig:spotcookie"]);
    expect(lightConfigIssues(config, 0)).toEqual(["lightconfig:spotcookie"]);
  });

  it("宏：litDefines 只有 LIGHTS_*，HDR / SCENE_ORTHO 全局给，关闭时不写键；REVERSEDEPTH 恒为 1（P13c）", () => {
    const shadowless = {
      LIGHTS_SPOT_SHADOW: "0",
      LIGHTS_SPOT_COOKIE: "0",
      LIGHTS_SPOT_SHADOW_COOKIE: "0",
      LIGHTS_DIRECTIONAL_SHADOW: "0",
      LIGHTS_POINT_SHADOW: "0",
    };
    expect(litDefines({ ...NONE, point: 2, spot: 0, tube: 1, directional: 0 })).toEqual({
      LIGHTS_POINT: "2",
      LIGHTS_SPOT: "0",
      LIGHTS_TUBE: "1",
      LIGHTS_DIRECTIONAL: "0",
      ...shadowless,
    });
    // 有阴影计数时另写 LIGHTS_SHADOW_MAPPING 与档位（P13d）
    expect(litDefines({ ...NONE, point: 1, spot: 0, tube: 0, directional: 0, pointShadow: 1 }, 3)).toMatchObject({
      LIGHTS_POINT_SHADOW: "1",
      LIGHTS_SHADOW_MAPPING: "1",
      LIGHTS_SHADOW_MAPPING_QUALITY: "3",
    });
    expect(engineDefines(false, false)).toEqual({ REVERSEDEPTH: "1" });
    expect(engineDefines(true, true)).toEqual({ REVERSEDEPTH: "1", HDR: "1", SCENE_ORTHO: "1" });
  });
});

describe("灯对象 → uniform", () => {
  const counts = { ...NONE, point: 1, spot: 1, tube: 1, directional: 1 };

  it("旋转是 Rz · Ry · Rx，弧度", () => {
    // 绕 y 转 90°：局部 +X 指向世界 -Z，这正是灯从 +Z 照向图层的写法
    close(lightAxes([0, Math.PI / 2, 0], [1, 1, 1])[0], [0, 0, -1]);
    close(lightAxes([0, 0, Math.PI / 2], [2, 1, 1])[0], [0, 2, 0]);
    const [x, y, z] = [0.4, 1.2, 0.3];
    close(lightAxes([x, y, z], [1, 1, 1])[0], [Math.cos(y) * Math.cos(z), Math.cos(y) * Math.sin(z), -Math.sin(y)]);
  });

  it("点光：颜色乘强度，w 是半径；位置的 w 是指数", () => {
    const objects: SceneObject[] = [
      { light: "lpoint", origin: "1 2 3", color: "1 0.5 0.25", intensity: 2, radius: 90, exponent: 1.5 },
    ];
    const values = lightUniforms(objects, { ...counts, spot: 0, tube: 0, directional: 0 }, plain);
    expect(values.g_LPoint_Color).toEqual([2, 1, 0.5, 90]);
    expect(values.g_LPoint_Origin).toEqual([1, 2, 3, 1.5]);
    expect(values.g_LSpot_Color).toBeUndefined();
  });

  it("聚光：内外锥角存余弦，方向是局部 +X，指数在 Exponent.x", () => {
    const objects: SceneObject[] = [
      {
        light: "lspot",
        origin: "0 0 5",
        angles: `0 ${Math.PI / 2} 0`,
        color: "1 1 1",
        intensity: 1,
        radius: 10,
        exponent: 3,
        innercone: 60,
        outercone: 90,
      },
    ];
    const values = lightUniforms(objects, { ...counts, point: 0 }, plain);
    close(values.g_LSpot_Origin, [0, 0, 5, 0.5]);
    close(values.g_LSpot_Direction, [0, 0, -1, 0]);
    expect(values.g_LSpot_Exponent).toEqual([3, 0, 0, 0]);
  });

  it("管光：控制点走世界矩阵", () => {
    const objects: SceneObject[] = [
      {
        light: "ltube",
        origin: "10 0 0",
        angles: `0 0 ${Math.PI / 2}`,
        controlpoint: "5 0 0",
        color: "1 1 1",
        intensity: 1,
      },
    ];
    const values = lightUniforms(objects, counts, plain);
    expect(values.g_LTube_OriginA.slice(0, 3)).toEqual([10, 0, 0]);
    close(values.g_LTube_OriginB, [10, 5, 0, 0]);
  });

  it("平行光：方向是局部 -X，颜色 w 恒为 1", () => {
    const objects: SceneObject[] = [
      { light: "ldirectional", angles: `0 ${Math.PI / 2} 0`, color: "1 1 1", intensity: 2 },
    ];
    const values = lightUniforms(objects, counts, plain);
    expect(values.g_LDirectional_Color).toEqual([2, 2, 2, 1]);
    close(values.g_LDirectional_Direction, [0, 0, 1, 0]);
  });

  it("缺键取构造函数默认值：颜色 0、强度 0、半径 1、指数 2、控制点 (2, 0, 0)", () => {
    const values = lightUniforms([{ light: "lpoint" }, { light: "ltube" }], counts, plain);
    expect(values.g_LPoint_Color).toEqual([0, 0, 0, 1]);
    expect(values.g_LPoint_Origin).toEqual([0, 0, 0, 2]);
    expect(values.g_LTube_OriginB).toEqual([2, 0, 0, 0]);
  });

  it("隐藏的灯、遗留 point、超配的灯都不进数组，空槽保持 0", () => {
    const objects: SceneObject[] = [
      { light: "lpoint", visible: false, intensity: 9, color: "1 1 1" },
      { light: "point", intensity: 9, color: "1 1 1" },
      { light: "lpoint", intensity: 1, color: "1 0 0", radius: 5 },
      { light: "lpoint", intensity: 1, color: "0 1 0", radius: 5 },
    ];
    const values = lightUniforms(objects, { ...NONE, point: 2, spot: 0, tube: 0, directional: 0 }, plain);
    expect(values.g_LPoint_Color).toEqual([1, 0, 0, 5, 0, 1, 0, 5]);
    const one = lightUniforms(objects, { ...NONE, point: 1, spot: 0, tube: 0, directional: 0 }, plain);
    expect(one.g_LPoint_Color).toEqual([1, 0, 0, 5]);
    const empty = lightUniforms([], { ...NONE, point: 2, spot: 0, tube: 0, directional: 0 }, plain);
    expect(empty.g_LPoint_Color).toEqual(new Array(8).fill(0));
  });
});

describe("能力表", () => {
  it("灯对象自己的键不算不支持，castvolumetrics 也是（P13e：不支持的组合由 `compile/volumetrics.ts` 照报）", () => {
    const issues = new Set<string>();
    checkObjectFeatures(
      { light: "lpoint", color: "1 1 1", intensity: 1, radius: 2, exponent: 2, castshadow: true, usecookie: true },
      issues,
    );
    expect([...issues]).toEqual([]);
    checkObjectFeatures({ light: "lspot", castvolumetrics: true, density: 0.8, volumetricsexponent: 1.5 }, issues);
    expect([...issues]).toEqual([]);
  });

  it("castshadow 在任何对象上都中性（P13d D4：只有不透明模型进阴影 pass，图像层写了也不画）", () => {
    const issues = new Set<string>();
    checkObjectFeatures({ image: "models/a.json", castshadow: true }, issues);
    checkObjectFeatures({ model: "models/m.json", castshadow: false }, issues);
    expect([...issues]).toEqual([]);
  });

  it("灯光数组与阴影数组（g_LFeature_*，P13d）算引擎 uniform，别的 g_L* 不算", () => {
    expect(isEngineUniform("g_LPoint_Color")).toBe(true);
    expect(isEngineUniform("g_LDirectional_Direction")).toBe(true);
    // 遗留灯的三个数组（P13a）随材质常量写入
    expect(isEngineUniform("g_LightsPosition")).toBe(true);
    expect(isEngineUniform("g_LightsColorRadius")).toBe(true);
    expect(isEngineUniform("g_LightsColorPremultiplied")).toBe(true);
    expect(isEngineUniform("g_LFeature_ShadowProjection")).toBe(true);
    expect(isEngineUniform("g_LFeature_ShadowPointTransform")).toBe(true);
    expect(isEngineUniform("g_LCustom_Value")).toBe(false);
  });
});

describe("遗留灯（P13a）", () => {
  // p13-REPORT「P13a 的实测」p13a-slots：objects 顺序
  const slots = (flag: SceneValue): SceneObject[] => [
    { light: "lpoint", origin: "100 100 100" },
    { light: "point", origin: "300 540 200", color: "1 0.2 0.1", intensity: 1.5, radius: 600, visible: true },
    { light: "point", origin: "700 300 200", color: "0.1 1 0.2", intensity: 2.0, radius: 500, visible: false },
    { light: "point", origin: "1300 540 200", color: "0.2 0.3 1", intensity: 1.25, radius: 700 },
    { light: "point", origin: "960 820 200", color: "1 1 0.1", intensity: 3.0, radius: 400 },
    { light: "point", origin: "1600 300 150", color: "1 0.1 1", intensity: 0.75, radius: 650, visible: flag },
  ];
  // 属性 p_f 的解析：`{user, value}` 取 properties 里的值，缺省取 value
  const reader = (properties: Record<string, SceneScalar>) => (value: SceneValue | undefined) => {
    if (value && typeof value === "object" && "user" in value) {
      const user = value as { user: string; value?: SceneScalar };
      return user.user in properties ? properties[user.user] : user.value;
    }
    return value as SceneScalar | undefined;
  };
  const flag = { user: "p_f", value: false } as unknown as SceneValue;

  it("WPE 读到的值（p_f = false）：逐值相同", () => {
    const values = legacyLightUniforms(slots(flag), reader({ p_f: false }));
    expect(values.g_LightsPosition).toEqual([1600, 300, 150, 300, 540, 200, 700, 300, 200, 1300, 540, 200]);
    expect(values.g_LightsColorRadius).toEqual([
      0, 0, 0, 1, 1.5, 0.30000001192092896, 0.15000000596046448, 600, 0, 0, 0, 1, 0.25, 0.375, 1.25, 700,
    ]);
    expect(values.g_LightsColorPremultiplied).toEqual([
      0, 0, 0, 122500, 540000, 108000.0078125, 54000.00390625, 183750, 0, 0, 0, 612500,
    ]);
  });

  it("p_f = true：槽 0 是 E 的颜色与半径", () => {
    const values = legacyLightUniforms(slots(flag), reader({ p_f: true }));
    expect(values.g_LightsColorRadius.slice(0, 4)).toEqual([0.75, 0.07500000298023224, 0.75, 650]);
    expect(values.g_LightsColorPremultiplied.slice(0, 3)).toEqual([316875, 31687.501953125, 316875]);
  });

  it("空场景：位置 (0, 100, 0)，颜色半径 (0, 0, 0, 1)", () => {
    const values = legacyLightUniforms([], plain);
    expect(values.g_LightsPosition).toEqual([0, 100, 0, 0, 100, 0, 0, 100, 0, 0, 100, 0]);
    expect(values.g_LightsColorRadius).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(values.g_LightsColorPremultiplied).toEqual(new Array(12).fill(0));
  });

  it("lpoint 占槽 0 但不写；非灯对象不占槽；缺键取 color 0、intensity 0、radius 1", () => {
    const values = legacyLightUniforms(
      [{ image: "a.json" }, { light: "lpoint", origin: "1 2 3" }, { light: "point", origin: "4 5 6" }],
      plain,
    );
    expect(values.g_LightsPosition.slice(0, 6)).toEqual([0, 100, 0, 4, 5, 6]);
    expect(values.g_LightsColorRadius.slice(0, 8)).toEqual([0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it("隐藏：颜色半径 (0, 0, 0, 1)，位置照写", () => {
    const values = legacyLightUniforms(
      [{ light: "point", origin: "7 8 9", color: "1 1 1", intensity: 1, radius: 5, visible: false }],
      plain,
    );
    expect(values.g_LightsPosition.slice(0, 3)).toEqual([7, 8, 9]);
    expect(values.g_LightsColorRadius.slice(0, 4)).toEqual([0, 0, 0, 1]);
  });

  it("满槽后取槽 0，后写的覆盖先写的", () => {
    const lamp = (n: number): SceneObject => ({
      light: "point",
      origin: `${n} 0 0`,
      color: "1 1 1",
      intensity: 1,
      radius: n,
    });
    const values = legacyLightUniforms([1, 2, 3, 4, 5, 6].map(lamp), plain);
    expect(values.g_LightsPosition).toEqual([6, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0, 0]);
    expect(values.g_LightsColorRadius.filter((_, i) => i % 4 === 3)).toEqual([6, 2, 3, 4]);
  });

  it("readsLegacyLights：被读、不是材质常量才算", () => {
    const uniform = { name: "g_LightsPosition", type: "array<vec3<f32>, 4>", offset: 0, size: 64 };
    expect(readsLegacyLights({ uniforms: [uniform] })).toBe(true);
    expect(readsLegacyLights({ uniforms: [{ ...uniform, unused: true }] })).toBe(false);
    expect(readsLegacyLights({ uniforms: [{ ...uniform, meta: { material: "x" } }] })).toBe(false);
    expect(readsLegacyLights({ uniforms: [{ name: "g_Time", type: "f32", offset: 0, size: 4 }] })).toBe(false);
    expect(readsLegacyLights({})).toBe(false);
  });
});

describe("编译", () => {
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
  /** 按 COMBO 给结果：`litDefines` 记下来，`g_LPoint_Color` 只有开了光照的程序才声明。 */
  function translator(extra: object[] = []): Wpesl2wgsl & { calls: TranslateRequest[] } {
    const calls: TranslateRequest[] = [];
    return {
      calls,
      async translate(request: TranslateRequest): Promise<TranslateResult> {
        calls.push(request);
        const lit = request.combos?.LIGHTING ? 1 : 0;
        return {
          ok: true,
          uniforms: extra,
          textures: [],
          combos: [{ name: "LIGHTING", value: lit, source: "request" }],
        } as unknown as TranslateResult;
      },
    } as unknown as Wpesl2wgsl & { calls: TranslateRequest[] };
  }
  const FILES = {
    "P:/p/project.json": JSON.stringify({
      file: "scene.json",
      general: { properties: { p: { type: "slider", value: 2 } } },
    }),
    "P:/p/models/lit.json": JSON.stringify({ material: "materials/lit.json", width: 4, height: 4 }),
    "P:/p/materials/lit.json": JSON.stringify({ passes: [{ shader: "s", combos: { LIGHTING: 1 } }] }),
    "P:/p/models/off.json": JSON.stringify({ material: "materials/off.json", width: 4, height: 4 }),
    "P:/p/materials/off.json": JSON.stringify({ passes: [{ shader: "s" }] }),
    "P:/p/effects/e/effect.json": JSON.stringify({ passes: [{ material: "materials/fx.json" }] }),
    "P:/p/materials/fx.json": JSON.stringify({ passes: [{ shader: "s", combos: { LIGHTING: 1 } }] }),
    "P:/p/shaders/s.vert": "void main() {}",
    "P:/p/shaders/s.frag": "void main() {}",
  };
  async function compile(
    object: Record<string, unknown>,
    general: Record<string, unknown> = {},
    extra: object[] = [],
    uniforms: object[] = [],
  ) {
    const t = translator(uniforms);
    const bundle = await compileScene({
      projectDir: "P:/p",
      sceneAssets: ["A:/assets"],
      reader: memoryReader({
        ...FILES,
        "P:/p/scene.json": JSON.stringify({
          general: { orthogonalprojection: { width: 64, height: 32 }, ...general },
          objects: [{ id: 1, name: "a", ...object }, ...extra],
        }),
      }),
      translator: t,
      postprocess: "disabled",
      exhaustive: true,
    });
    return { bundle, calls: t.calls };
  }
  const lamp = { id: 2, name: "l", light: "lpoint", color: "1 1 1", intensity: { user: "p", value: 1 }, radius: 3 };

  it("无 effect 的图层：灯数宏随请求给翻译器，灯光数组不进 pass、由 bundle.lights 每帧算（P13d）", async () => {
    const { bundle, calls } = await compile({ image: "models/lit.json" }, { lightconfig: { point: 1 } }, [lamp]);
    expect(bundle.unsupported).toEqual([]);
    expect(calls[0].litDefines).toMatchObject({ LIGHTS_POINT: "1" });
    expect(calls[0].defines).toMatchObject({ SCENE_ORTHO: "1" });
    expect(bundle.layers[0].passes[0].uniforms.g_LPoint_Color).toBeUndefined();
    const lights = bundle.lights!;
    expect(lights.records).toHaveLength(1);
    const frame = lightFrame(lights.records, lights.counts, lights.quality, [0, 0, -1]);
    expect(lightFrameUniforms(frame).g_LPoint_Color).toEqual([2, 2, 2, 3]);
  });

  it("灯字段绑了属性：登记重编译", async () => {
    const { bundle } = await compile({ image: "models/lit.json" }, { lightconfig: { point: 1 } }, [lamp]);
    expect(bundle.bindings.find((binding) => binding.property === "p")?.target).toEqual({
      kind: "recompile",
      reason: "layer-structure",
      path: "objects/1/intensity",
    });
  });

  it("没有开光照的材质不写灯光 uniform，也不解析灯对象", async () => {
    const { bundle } = await compile({ image: "models/off.json" }, { lightconfig: { point: 1 } }, [lamp]);
    expect(bundle.layers[0].passes[0].uniforms).toEqual({});
    expect(bundle.bindings).toEqual([]);
    expect(bundle.lights).toBeUndefined();
  });

  const legacyLamp = { id: 3, name: "g", light: "point", origin: "1 2 3", color: "1 1 1", intensity: 1, radius: 4 };
  const legacyUniforms = [{ name: "g_LightsPosition", type: "array<vec3<f32>, 4>", offset: 0, size: 64 }];

  it("遗留灯：声明 g_LightsPosition 的程序（不开 LIGHTING）拿到值、不报 uniform:*", async () => {
    const { bundle } = await compile({ image: "models/off.json" }, {}, [legacyLamp], legacyUniforms);
    expect(bundle.unsupported).toEqual([]);
    const uniforms = bundle.layers[0].passes[0].uniforms;
    expect(uniforms.g_LightsPosition).toEqual([1, 2, 3, 0, 100, 0, 0, 100, 0, 0, 100, 0]);
    expect(uniforms.g_LightsColorRadius).toHaveLength(16);
    expect(uniforms.g_LightsColorPremultiplied).toHaveLength(12);
  });

  it("遗留灯：不声明三个数组的程序 uniforms 里没有这三个键", async () => {
    const { bundle } = await compile({ image: "models/off.json" }, {}, [legacyLamp]);
    expect(Object.keys(bundle.layers[0].passes[0].uniforms)).toEqual([]);
  });

  it("遗留灯：visible 绑属性登记重编译", async () => {
    const lamp = { ...legacyLamp, visible: { user: "p", value: true } };
    const { bundle } = await compile({ image: "models/off.json" }, {}, [lamp], legacyUniforms);
    expect(bundle.bindings.find((binding) => binding.property === "p")?.target).toEqual({
      kind: "recompile",
      reason: "layer-structure",
      path: "objects/1/visible",
    });
  });

  it("带 effect 的图层走 PRELIGHTING，没实现，照报", async () => {
    const { bundle } = await compile({ image: "models/lit.json", effects: [{ file: "effects/e/effect.json" }] });
    expect(bundle.unsupported).toContain("lighting:prelighting");
  });

  it("passthrough 的图层同样走 PRELIGHTING", async () => {
    const { bundle } = await compile({ image: "models/lit.json", colorBlendMode: 9 });
    expect(bundle.unsupported).toContain("lighting:prelighting");
  });

  it("effect 自己开光照：照报", async () => {
    const { bundle } = await compile({ image: "models/off.json", effects: [{ file: "effects/e/effect.json" }] });
    expect(bundle.unsupported).toContain("lighting:effect");
  });

  it("lightconfig 的点光、平行光阴影不报（P13d 支持），聚光的阴影照报", async () => {
    // 内存读取器里没有 WPE 的 config.json：阴影档位按缺键的 medium（2）
    const point = await compile(
      { image: "models/lit.json" },
      { lightconfig: { pointshadow: 1, directionalshadow: 1 } },
    );
    expect(point.bundle.unsupported).toEqual([]);
    expect(point.bundle.lights?.counts).toMatchObject({ pointShadow: 1, directionalShadow: 1 });
    expect(point.bundle.lights?.quality).toBe(2);
    const spot = await compile({ image: "models/lit.json" }, { lightconfig: { spotshadow: 1 } });
    expect(spot.bundle.unsupported).toContain("lightconfig:spotshadow");
  });
});
