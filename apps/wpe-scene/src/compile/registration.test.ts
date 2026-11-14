/**
 * P10b 步骤 1：脚本与关键帧动画的登记顺序（`registration.ts`，决定 3）。依据 `p10-REPORT.md`「P10b 补测」的登记顺序一节：
 * `general` 的字段（按键名序）→ 每个对象自己的字段（按键名序）→ 它的 effect（每个 effect 先 `visible`，再各 pass 的常量按键名序）。
 * 场景里的键故意按「书写顺序」的反方向写（effects 在最前、常量 `kfv` 在 `kfa` 前、`clearcolor` 在 `ambientcolor` 前），
 * 照 WPE 的 `p10b-order` 工程：期望 `Gambient, Gclear, Aalpha, Aangles, Acolor, Aorigin, Ascale, Avis, Ae0vis, Ae0kfa, Ae0kfv, Ae1kfa, B`。
 */
import { describe, expect, it, vi } from "vitest";
import { collectAnimations } from "./animations";
import type { JsonObject, SceneJson } from "./model";
import { compareKeys, registrationKeys } from "./registration";
import { collectScripts } from "./scripts";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

const ORTHO = { orthogonalprojection: { width: 1920, height: 1080 } };

/** 两侧切线都关的关键帧。 */
const lin = (frame: number, value: number) => ({
  frame,
  value,
  back: { enabled: false, x: -1, y: 0, magic: false },
  front: { enabled: false, x: -1, y: 0, magic: false },
  lockangle: true,
  locklength: true,
});
const animated = (value: unknown, channels = 1): JsonObject => {
  const animation: JsonObject = { options: { fps: 30, length: 60, mode: "loop" } };
  for (let i = 0; i < channels; i++) animation[`c${i}`] = [lin(0, 0), lin(60, 1)];
  return { animation, value };
};
const scripted = (value: unknown): JsonObject => ({
  script: "'use strict'; export function update(v) { return v; }",
  value,
});

/** 一个场景：叶子由 `leaf` 决定是脚本还是关键帧；键序全部倒着写，effects 与 visible 写在最前。 */
function scene(leaf: (value: unknown, channels?: number) => JsonObject): SceneJson {
  const pass = (constants: JsonObject) => ({ constantshadervalues: constants });
  return {
    // `general` 的键倒序：clearcolor 在 ambientcolor 前
    general: { ...ORTHO, clearcolor: leaf("0 0 0", 3), ambientcolor: leaf("0 0 0", 3) },
    objects: [
      {
        // 对象字段倒序写，effects 写在最前
        effects: [
          // effect 0：passes 在 visible 前、常量 kfv 在 kfa 前
          { passes: [pass({ kfv: leaf(1), kfa: leaf(1) })], visible: leaf(true) },
          { passes: [pass({ kfa: leaf(1) })] },
        ],
        visible: leaf(true),
        scale: leaf("1 1 1", 3),
        origin: leaf("0 0 0", 3),
        color: leaf("1 1 1", 3),
        angles: leaf("0 0 0", 3),
        alpha: leaf(1),
        image: "models/a.json",
        id: 1,
      },
      { image: "models/a.json", id: 2, alpha: leaf(1) },
    ],
  } as unknown as SceneJson;
}

const EXPECTED = [
  "general/ambientcolor",
  "general/clearcolor",
  "objects/0/alpha",
  "objects/0/angles",
  "objects/0/color",
  "objects/0/origin",
  "objects/0/scale",
  "objects/0/visible",
  "objects/0/effects/0/visible",
  "objects/0/effects/0/passes/0/constantshadervalues/kfa",
  "objects/0/effects/0/passes/0/constantshadervalues/kfv",
  "objects/0/effects/1/passes/0/constantshadervalues/kfa",
  "objects/1/alpha",
];

describe("登记顺序（P10b 决定 3）", () => {
  it("collectScripts：general → 对象字段 → effect（visible 在前、常量按键名序），同层按键名序", async () => {
    const { list } = await collectScripts(scene(scripted), {}, []);
    expect(list.map((item) => item.id)).toEqual(EXPECTED);
  });

  it("collectAnimations：同一顺序", () => {
    const { list } = collectAnimations(scene(animated));
    expect(list.map((item) => item.id)).toEqual(EXPECTED);
  });

  it("两处遍历顺序一致，所以 thisScene.getAnimation 的「第一条」与脚本登记同序", async () => {
    const scripts = await collectScripts(scene(scripted), {}, []);
    const animations = collectAnimations(scene(animated));
    expect(animations.list.map((item) => item.id)).toEqual(scripts.list.map((item) => item.id));
  });
});

describe("registrationKeys", () => {
  it("对象：effects 放最后，其余按键名序；没有 effects 就不凭空多出来", () => {
    expect(registrationKeys("objects/3", ["effects", "visible", "alpha", "id"])).toEqual([
      "alpha",
      "id",
      "visible",
      "effects",
    ]);
    expect(registrationKeys("objects/3", ["visible", "alpha"])).toEqual(["alpha", "visible"]);
  });

  it("effect：visible 放最前，其余按键名序", () => {
    expect(registrationKeys("objects/3/effects/1", ["passes", "visible", "file", "id"])).toEqual([
      "visible",
      "file",
      "id",
      "passes",
    ]);
    expect(registrationKeys("objects/3/effects/1", ["passes"])).toEqual(["passes"]);
  });

  it("其它字典（general、pass、常量、instanceoverride 与 effects 本身）全部按键名序，不特殊对待 visible / effects", () => {
    expect(registrationKeys("general", ["clearcolor", "ambientcolor", "visible"])).toEqual([
      "ambientcolor",
      "clearcolor",
      "visible",
    ]);
    expect(registrationKeys("objects/3/effects/1/passes/0", ["visible", "constantshadervalues", "effects"])).toEqual([
      "constantshadervalues",
      "effects",
      "visible",
    ]);
    expect(registrationKeys("objects/3/instanceoverride", ["rate", "alpha"])).toEqual(["alpha", "rate"]);
  });

  it("不改入参", () => {
    const keys = ["b", "a"];
    registrationKeys("general", keys);
    expect(keys).toEqual(["b", "a"]);
  });
});

describe("compareKeys", () => {
  it("按码点序（大写在小写前），前缀较短的在前，补充平面字符按码点而不是 UTF-16 代码单元", () => {
    expect(["b", "B", "a", "ab", "A"].sort(compareKeys)).toEqual(["A", "B", "a", "ab", "b"]);
    // U+FF5E（BMP）比 U+1F600（补充平面）小；按 UTF-16 代码单元比 U+1F600 的高代理项 0xD83D 会排在 U+FF5E 前
    expect(["\u{1F600}", "～"].sort(compareKeys)).toEqual(["～", "\u{1F600}"]);
  });
});
