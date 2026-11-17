/**
 * P4g 步骤 1：`hsvcolorrandom` / `colorlist` 的系统色（rea-p4g-color.md 3.1）、解析进 `SceneParticle`、能力表不再报这两个键。
 */
import { describe, expect, it } from "vitest";
import { checkParticleFeatures } from "./features";
import type { JsonObject } from "./model";
import { parseParticle, particleColorSystem } from "./particles";

const close = (actual: readonly number[], expected: readonly number[], digits = 5) =>
  expected.forEach((value, i) => expect(actual[i], `分量 ${i}`).toBeCloseTo(value, digits));

const system = (initializer: JsonObject[], sceneVersion = 5) =>
  particleColorSystem({ initializer } as JsonObject, sceneVersion);

describe("系统色：hsvcolorrandom", () => {
  const CORPUS = { name: "hsvcolorrandom", huemin: 0.83660131, huemax: 0.60130719, huesteps: 4 };

  it("取色相 / 饱和度 / 明度区间的中点转 RGB，不看 huesteps（语料：(0.36397, 0.18750, 0.75000)）", () => {
    close(system([CORPUS]).rgb, [0.36397, 0.1875, 0.75]);
    close(system([{ ...CORPUS, huesteps: 0 }]).rgb, [0.36397, 0.1875, 0.75]);
  });

  it("缺键取缺省 0 / 1 / 0.5 / 1 / 0.5 / 1：中点 (0.5, 0.75, 0.75)", () => {
    // h = 0.5（青）、s = v = 0.75：r = v − v·s = 0.1875，g = b = 0.75
    close(system([{ name: "hsvcolorrandom" }]).rgb, [0.1875, 0.75, 0.75]);
  });

  it("三个中点各钳到 [0, 1]（先取下限 0 再取上限 1）", () => {
    // 色相中点 −0.5 → 0（红）；S 中点 2 → 1；V 中点 3 → 1 → (1, 0, 0)
    close(
      system([
        { name: "hsvcolorrandom", huemin: -1, huemax: 0, saturationmin: 2, saturationmax: 2, valuemin: 3, valuemax: 3 },
      ]).rgb,
      [1, 0, 0],
    );
  });

  it("按 initializer 顺序、后者覆盖前者：colorrandom 在前、hsvcolorrandom 在后取后者；反过来取 colorrandom", () => {
    const colorrandom = { name: "colorrandom", min: "255 130 130", max: "134 132 255", exponent: 2 };
    close(system([colorrandom, CORPUS]).rgb, [0.36397, 0.1875, 0.75]);
    close(system([CORPUS, { name: "colorrandom", min: "0 255 0", max: "0 255 0" }]).rgb, [0, 1, 0]);
  });

  it("有颜色模块，version 5 时 0x200000 不置；version 3 置", () => {
    expect(system([CORPUS], 5).instanceColor).toBe(false);
    expect(system([CORPUS], 3).instanceColor).toBe(true);
  });
});

describe("系统色：colorlist", () => {
  it("取第一个有效项的 RGB 原值（不 ÷255、不转 HSV）", () => {
    expect(system([{ name: "colorlist", colors: ["0.2 0.4 0.6", "1 0 0"] }]).rgb).toEqual(
      [0.2, 0.4, 0.6].map(Math.fround),
    );
    expect(system([{ name: "colorlist", colors: ["255 0 0"] }]).rgb).toEqual([255, 0, 0]);
  });

  it("list-bad：切不出三个数的项与非字符串项跳过，取第一个有效的（绿）", () => {
    expect(system([{ name: "colorlist", colors: ["1 0", 5, "0 1 0"] }]).rgb).toEqual([0, 1, 0]);
  });

  it("空串项是 (0, 0, 0)，且它就是第一个有效项", () => {
    const result = system([{ name: "colorlist", colors: ["", "1 1 1"] }]);
    expect(result.rgb).toEqual([0, 0, 0]);
    expect(result.instanceColor).toBe(false);
  });

  it("没有有效项（colors: []）：不改系统色、也不置 hascolor（version 5 时 0x200000 置位）", () => {
    const empty = system([{ name: "colorlist", colors: [] }]);
    expect(empty.rgb).toEqual([1, 1, 1]);
    expect(empty.instanceColor).toBe(true);
    // 前面有别的颜色模块时保持它的值，hascolor 由前者决定
    const after = system([
      { name: "colorrandom", min: "0 255 0", max: "0 255 0" },
      { name: "colorlist", colors: ["1 0"] },
    ]);
    expect(after.rgb).toEqual([0, 1, 0]);
    expect(after.instanceColor).toBe(false);
  });

  it('缺 colors 键按一项白色算（缺省字符串 "1 1 1"，实测 list-empty 粒子是白色）：系统色白、置 hascolor【推】', () => {
    const missing = system([{ name: "colorlist" }]);
    expect(missing.rgb).toEqual([1, 1, 1]);
    expect(missing.instanceColor).toBe(false);
  });

  it("绑定写法取静态 value", () => {
    expect(system([{ name: "colorlist", colors: { user: "c", value: ["0 0 1"] } as never }]).rgb).toEqual([0, 0, 1]);
  });

  it("colorlist 在后覆盖 colorrandom", () => {
    expect(
      system([
        { name: "colorrandom", min: "255 0 0", max: "255 0 0" },
        { name: "colorlist", colors: ["0 0 1"] },
      ]).rgb,
    ).toEqual([0, 0, 1]);
  });
});

describe("解析与能力表", () => {
  const keys = (initializer: JsonObject[]) => {
    const set = new Set<string>();
    checkParticleFeatures({ maxcount: 10, initializer } as JsonObject, true, set);
    return [...set].sort();
  };

  it("hsvcolorrandom、colorlist 不再报 particle:initializer:<名>（缺省与写满字段都不报）", () => {
    expect(keys([{ name: "hsvcolorrandom" }])).toEqual([]);
    expect(
      keys([
        {
          name: "hsvcolorrandom",
          huemin: 0.8,
          huemax: 0.6,
          huesteps: 4,
          saturationmin: 0.1,
          saturationmax: 0.9,
          valuemin: 0.2,
          valuemax: 1,
        },
      ]),
    ).toEqual([]);
    expect(keys([{ name: "colorlist" }])).toEqual([]);
    expect(
      keys([{ name: "colorlist", colors: ["1 0 0", "0 1 0"], huenoise: 0.1, saturationnoise: 0.2, valuenoise: 0.3 }]),
    ).toEqual([]);
    expect(keys([{ name: "colorlist", colors: [] }])).toEqual([]);
  });

  it("表外字段与形状不对按字段报：huesteps 字符串、colors 数字、未知键", () => {
    expect(keys([{ name: "hsvcolorrandom", huesteps: "4" }])).toEqual(["particle:initializer:hsvcolorrandom:huesteps"]);
    expect(keys([{ name: "colorlist", colors: 5 }])).toEqual(["particle:initializer:colorlist:colors"]);
    expect(keys([{ name: "hsvcolorrandom", exponent: 2 }])).toEqual(["particle:initializer:hsvcolorrandom:exponent"]);
  });

  it("用户属性绑定仍报 binding（字段整体不支持动态值）", () => {
    expect(keys([{ name: "hsvcolorrandom", huemin: { user: "h", value: 0.5 } }])).toEqual([
      "particle:binding:initializer:hsvcolorrandom:huemin",
    ]);
  });

  it("parseParticle 把两个模块解析成表内模块（派生字段随 fields）", () => {
    const def = parseParticle(
      {
        maxcount: 4,
        initializer: [
          { name: "hsvcolorrandom", huemin: 0.83660131, huemax: 0.60130719, huesteps: 4 },
          { name: "colorlist", colors: ["0 1 0"] },
        ],
      },
      { file: "p.json", orthographic: true },
    );
    const [hsv, list] = def.initializers;
    expect(hsv.name).toBe("hsvcolorrandom");
    expect(hsv.fields.steps).toBe(4);
    expect(list.fields.colors).toEqual([1 / 3, 1, 1].map(Math.fround));
  });
});
