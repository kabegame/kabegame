/**
 * P6e 点 5：文本 `anchor`（`render/layout.ts` 的 `anchorOffset` / `withAnchor` / `anchorEdgesFor` / `resolveAnchorEdges`，`render/cursor.ts` 的命中）。
 * 平移表照 rea-p6b-layout 3.4；`E0..E3` 的例子取 rea-p6e-sheet 8.2（`edges.py`，场景 1920×1080）；世界空间照 `p6e-anchor2` 的实测。
 */
import { describe, expect, it } from "vitest";
import {
  ALIGNMENT_OF_STYLE,
  alignEdges,
  anchorEdgesFor,
  anchorOffset,
  resolveAnchorEdges,
  sceneViewProjection,
  withAnchor,
  worldMatrixOf,
  type Edges,
} from "./layout";
import { hitQuad, pickablesOf, sceneRay, type PickLayer, type PickState } from "./cursor";
import { mulAffine, translateGlm } from "./math";
import { textMatrices } from "./uniforms";
import type { LayerState } from "./state";

const f = Math.fround;
const close = (a: readonly number[], b: readonly number[], eps = 0.01) =>
  a.forEach((v, i) => expect(Math.abs(v - b[i]), `${i}: ${v} vs ${b[i]}`).toBeLessThan(eps));

describe("anchorOffset：平移表（f32）", () => {
  const E: Edges = [f(10.5), f(3.25), f(7.125), f(20.75)];
  const [E0, E1, E2, E3] = E;
  const midX = f(f(E0 - E2) * 0.5);
  const midY = f(f(E3 - E1) * 0.5);
  const table: [string, [number, number]][] = [
    ["none", [0, 0]],
    ["center", [midX, midY]],
    ["top", [midX, -E1]],
    ["topright", [-E2, -E1]],
    ["right", [-E2, midY]],
    ["bottomright", [-E2, E3]],
    ["bottom", [midX, E3]],
    ["bottomleft", [E0, E3]],
    ["left", [E0, midY]],
    ["topleft", [E0, -E1]],
  ];
  for (const [name, expected] of table) it(name, () => expect(anchorOffset(name, E)).toEqual(expected));
  it("不认识的名字与缺省当 none；全 0 的 E 不产生 −0", () => {
    expect(anchorOffset("nowhere", E)).toEqual([0, 0]);
    expect(anchorOffset(undefined, E)).toEqual([0, 0]);
    for (const [name] of table) expect(anchorOffset(name, [0, 0, 0, 0]), name).toEqual([0, 0]);
  });
  it("f32：非 f32 精确的 E 经 f32 取半", () => {
    const e: Edges = [f(0.1), 0, f(0.3), 0];
    expect(anchorOffset("center", e)[0]).toBe(f(f(f(0.1) - f(0.3)) * 0.5));
  });
});

type Spec = { origin: number[]; angles?: number[]; scale?: number[]; parent: number | null };
const layersOf = (specs: Record<number, Spec>) =>
  new Map(
    Object.entries(specs).map(([k, v]) => [
      Number(k),
      { origin: v.origin, angles: v.angles ?? [0, 0, 0], scale: v.scale ?? [1, 1, 1], parent: v.parent },
    ]),
  );

describe("withAnchor：世界空间的平移 T(ax, ay) · W", () => {
  const E: Edges = [100, 40, 60, 20];
  const base = worldMatrixOf(0, layersOf({ 0: { origin: [300, 200, 0], parent: null } }), new Map());

  it("none 原样返回同一个矩阵", () => expect(withAnchor(base, "none", E)).toBe(base));

  it("只改平移列的 x、y：线性部分与 z、w 不动", () => {
    const out = withAnchor(base, "topleft", E); // (E0, −E1) = (100, −40)
    expect([out[12], out[13], out[14], out[15]]).toEqual([400, 160, 0, 1]);
    expect([...out.slice(0, 12)]).toEqual([...base.slice(0, 12)]);
  });

  const cases: [string, ReturnType<typeof layersOf>][] = [
    ["自身放大 2 倍", layersOf({ 0: { origin: [300, 200, 0], scale: [2, 2, 1], parent: null } })],
    ["自身转 90°", layersOf({ 0: { origin: [300, 200, 0], angles: [0, 0, Math.PI / 2], parent: null } })],
    [
      "父对象缩放 0.5",
      layersOf({
        0: { origin: [100, 100, 0], parent: 1 },
        1: { origin: [50, 60, 0], scale: [0.5, 0.5, 1], parent: null },
      }),
    ],
  ];
  for (const [name, set] of cases)
    it(`${name}：平移量仍是 (ax, ay)（不是 2E、不沿自身轴、不是 E/2）`, () => {
      const world = worldMatrixOf(0, set, new Map());
      const [ax, ay] = anchorOffset("bottomright", E); // (−E2, E3) = (−60, 20)
      const out = withAnchor(world, "bottomright", E);
      expect(out[12] - world[12]).toBeCloseTo(ax, 4);
      expect(out[13] - world[13]).toBeCloseTo(ay, 4);
      expect([...out.slice(0, 12)]).toEqual([...world.slice(0, 12)]);
      expect(out[14]).toBe(world[14]);
    });
});

describe("E 的来源", () => {
  it("rea-p6e-sheet 8.2 的例子（场景 1920×1080）：alignEdges 与表一致", () => {
    close(alignEdges(0, 1920, 1080, 900, 1600), [656.25, 0, 656.25, 0]);
    close(alignEdges(1, 1920, 1080, 900, 1600), [0, -1166.667, 0, -1166.667]);
    close(alignEdges(3, 1920, 1080, 900, 1600), [510, -260, 510, -260]);
    close(alignEdges(0, 1920, 1080, 2560, 1080), [0, 135, 0, 135]);
    close(alignEdges(1, 1920, 1080, 2560, 1080), [-320, 0, -320, 0]);
    close(alignEdges(3, 1920, 1080, 960, 540), [480, 270, 480, 270]);
    close(alignEdges(3, 1920, 1080, 1280, 1024), [320, 28, 320, 28]);
  });

  it("表里的 topleft / bottomright 平移", () => {
    const e = alignEdges(0, 1920, 1080, 900, 1600);
    expect(anchorOffset("topleft", e)).toEqual([656.25, 0]);
    expect(anchorOffset("bottomright", e)).toEqual([-656.25, 0]);
    const g = alignEdges(1, 1920, 1080, 900, 1600);
    close(anchorOffset("topleft", g), [0, 1166.667]);
    close(anchorOffset("bottomright", g), [0, -1166.667]);
  });

  it("产品：fill / fit / center 按显示的铺放算，stretch 与 tile 全 0", () => {
    expect(anchorEdgesFor("fill", 1920, 1080, 900, 1600)).toEqual(alignEdges(0, 1920, 1080, 900, 1600));
    expect(anchorEdgesFor("fit", 1920, 1080, 900, 1600)).toEqual(alignEdges(1, 1920, 1080, 900, 1600));
    expect(anchorEdgesFor("center", 1920, 1080, 960, 540)).toEqual([480, 270, 480, 270]);
    expect(anchorEdgesFor("stretch", 1920, 1080, 900, 1600)).toEqual([0, 0, 0, 0]);
    expect(anchorEdgesFor("tile", 1920, 1080, 900, 1600)).toEqual([0, 0, 0, 0]);
    expect(anchorEdgesFor("fill", 1920, 1080, 1920, 1080)).toEqual([0, 0, 0, 0]);
    expect(anchorEdgesFor("fill", 0, 1080, 900, 1600)).toEqual([0, 0, 0, 0]);
  });

  it("产品：画布像素按 pixelRatio 换成 CSS 尺寸（center 一个场景单位对一个 CSS 像素；fill / fit 只看比例）", () => {
    expect(anchorEdgesFor("center", 1920, 1080, 1920, 1080, 2)).toEqual([480, 270, 480, 270]);
    expect(anchorEdgesFor("center", 1920, 1080, 1920, 1080, 1)).toEqual([0, 0, 0, 0]);
    expect(anchorEdgesFor("fill", 1920, 1080, 1800, 3200, 2)).toEqual(anchorEdgesFor("fill", 1920, 1080, 900, 1600, 1));
    expect(anchorEdgesFor("fit", 1920, 1080, 1800, 3200, 2)).toEqual(anchorEdgesFor("fit", 1920, 1080, 900, 1600, 1));
    expect(ALIGNMENT_OF_STYLE.center).toBe(3);
  });

  it("resolveAnchorEdges：透视恒 0；探针的投影边距优先；否则产品值", () => {
    const product: Edges = [1, 2, 3, 4];
    const crop: Edges = [5, 6, 7, 8];
    expect(resolveAnchorEdges(true, crop, product)).toEqual([0, 0, 0, 0]);
    expect(resolveAnchorEdges(false, crop, product)).toBe(crop);
    expect(resolveAnchorEdges(false, null, product)).toBe(product);
    expect(resolveAnchorEdges(false, undefined, product)).toBe(product);
  });
});

describe("文本矩阵：探针的 edges 交到上屏的 MVP", () => {
  const edges = alignEdges(0, 1920, 1080, 900, 1600);
  const vp = sceneViewProjection({ width: 1920, height: 1080 }, 1, edges);
  const world = worldMatrixOf(0, layersOf({ 0: { origin: [960, 540, 0], parent: null } }), new Map());
  const layout = { mesh: null, padding: [0, 0] as [number, number], compositeSize: [64, 32] as [number, number] };

  it("直接上屏：MVP = VP ⊗ (anchor 后的世界矩阵)；合成 RT 内部的矩阵不读 world", () => {
    const resolved = resolveAnchorEdges(false, edges, [0, 0, 0, 0]);
    const anchored = withAnchor(world, "topleft", resolved);
    const direct = textMatrices({ part: "glyphs", space: "direct" } as never, anchored, vp, layout as never);
    expect([...direct.modelViewProjection]).toEqual([...mulAffine(vp, anchored)]);
    expect([...direct.modelViewProjection]).not.toEqual([...mulAffine(vp, world)]);
    const a = textMatrices({ part: "glyphs", space: "composite" } as never, anchored, vp, layout as never);
    const b = textMatrices({ part: "glyphs", space: "composite" } as never, world, vp, layout as never);
    expect([...a.modelViewProjection]).toEqual([...b.modelViewProjection]);
  });

  it("字形平移在 anchor 之后叠加（glm 内联求和）", () => {
    const anchored = withAnchor(world, "left", edges);
    const m = translateGlm(anchored, [3, 4, 0]);
    expect(m[12]).toBe(f(f(f(anchored[0] * 3) + f(anchored[4] * 4)) + anchored[12]));
  });
});

describe("光标命中：文本矩阵带 anchor 平移", () => {
  const E: Edges = [100, 0, 100, 0];
  const layerState = (origin: number[]): LayerState =>
    ({
      origin,
      scale: [1, 1, 1],
      angles: [0, 0, 0],
      alpha: 1,
      color: [1, 1, 1],
      brightness: 1,
      visible: true,
      parallaxDepth: [0, 0],
      parent: null,
    }) as unknown as LayerState;
  const layers: PickLayer[] = [
    {
      object: 0,
      pick: "text",
      perspective: false,
      fullscreen: false,
      size: [50, 50],
      text: { script: { anchor: "topleft" } },
    },
    { object: 1, pick: "image", perspective: false, fullscreen: false, size: [50, 50] },
  ];
  const state: PickState = {
    layers: new Map([
      [0, layerState([400, 400, 0])],
      [1, layerState([800, 400, 0])],
    ]),
    texts: new Map([[0, { size: [50, 50] }]]),
  };

  it("pickablesOf：文本的矩阵平移列加 (E0, −E1)，图像层不带", () => {
    const all = pickablesOf(layers, state, false, [0, 0, -1], undefined, E);
    const text = all.find((p) => p.object === 0)!;
    const image = all.find((p) => p.object === 1)!;
    expect(text.matrix[12]).toBe(500);
    expect(text.matrix[13]).toBe(400);
    expect(image.matrix[12]).toBe(800);
  });

  it("不给 E（缺省）时与以前相同", () => {
    const text = pickablesOf(layers, state, false).find((p) => p.object === 0)!;
    expect(text.matrix[12]).toBe(400);
  });

  it("命中区跟着平移：原位置不再命中，平移后的位置命中", () => {
    const hit = (x: number, y: number, edges?: Edges) => {
      const text = pickablesOf(layers, state, false, [0, 0, -1], undefined, edges).find((p) => p.object === 0)!;
      const ray = sceneRay([x, y, 0], [960, 540, 2000], false);
      return hitQuad(ray, text, [0, 0, 0], [0, 0]).hit;
    };
    expect(hit(400, 400)).toBe(true);
    expect(hit(400, 400, E)).toBe(false);
    expect(hit(500, 400, E)).toBe(true);
  });
});
