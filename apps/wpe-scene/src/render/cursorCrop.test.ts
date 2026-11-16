/**
 * P6c 修复 2：`fill` 且窗口与场景比例不同时，光标按「裁过的 `P·V`」与窗口归一化指针反投影（`layout.ts` 的 `fillCropEdges` /
 * `croppedCursorViewProjection`）。数据来自走查 `3637191856-iso-clockv`（场景 3936×2208、窗口 1920×1080）：WPE 拖动时钟的逐帧日志
 * （`cursorCrop.fixture.json` 每项 `[光标 x, 光标 y（窗口像素）, origin.x, origin.y]`），`origin` 由脚本 `cursorDown` 记的偏移加世界坐标算出。
 */
import { describe, expect, it } from "vitest";
import { pointerScenePoint } from "../particles/controlpoints";
import { CursorSession, unprojectCursor } from "./cursor";
import { replayPointers } from "../dev/replayPointers";
import {
  alignEdges,
  croppedCursorViewProjection,
  fillCropEdges,
  layerLocalMatrix,
  scenePlacement,
  sceneCursor,
  sceneViewProjection,
} from "./layout";
import { identity, mulAffine } from "./math";
import fixture from "./cursorCrop.fixture.json";

const f = Math.fround;
const W = 1920,
  H = 1080,
  SW = 3936,
  SH = 2208;
const general = { width: SW, height: SH };

/** 照脚本的写法预测 `origin`：按下处（960, 38）的世界坐标与初值 (1968, 2138.76562) 的差（JS double），之后每帧世界坐标加它再舍入。 */
function predictor(world: (cx: number, cy: number) => number[]) {
  const o0 = [f(1968), f(2138.76562)];
  const down = world(960, 38);
  const offset = [o0[0] - down[0], o0[1] - down[1]];
  return (cx: number, cy: number) => {
    const w = world(cx, cy);
    return [f(w[0] + offset[0]), f(w[1] + offset[1])];
  };
}

describe("fillCropEdges", () => {
  it("别的样式、同比例（整数交叉相乘）都是 null", () => {
    expect(fillCropEdges("fit", SW, SH, W, H)).toBeNull();
    expect(fillCropEdges("stretch", SW, SH, W, H)).toBeNull();
    expect(fillCropEdges("center", SW, SH, W, H)).toBeNull();
    expect(fillCropEdges("tile", SW, SH, W, H)).toBeNull();
    expect(fillCropEdges("fill", 1920, 1080, 1280, 720)).toBeNull();
    expect(fillCropEdges("fill", 3936, 2208, 3936, 2208)).toBeNull();
    expect(fillCropEdges("fill", 0, 1080, 1280, 720)).toBeNull();
  });
  it("fill 比例不同：就是 alignEdges(0, …)", () => {
    expect(fillCropEdges("fill", SW, SH, W, H)).toEqual(alignEdges(0, SW, SH, W, H));
    expect(fillCropEdges("fill", SW, SH, W, H)).toEqual([5.333251953125, 0, 5.333251953125, 0]);
    // 窗口更宽：裁上下
    const wide = fillCropEdges("fill", 1920, 1080, 1920, 800)!;
    expect(wide[0]).toBe(0);
    expect(wide[1]).toBeGreaterThan(0);
  });
});

describe("裁过的 P·V（WPE 抓帧 clockv-drag-frame759）", () => {
  it("FR 的 MVP（T(−100000, −100000)）m0 / m5 / m12 / m13 与 WPE 逐位相同", () => {
    const edges = fillCropEdges("fill", SW, SH, W, H)!;
    const model = layerLocalMatrix({ origin: [-100000, -100000, 0], angles: [0, 0, 0], scale: [1, 1, 1] });
    const mvp = mulAffine(croppedCursorViewProjection(general, 1, edges, identity()), model);
    expect(mvp[0]).toBe(f(0.0005095108645036817));
    expect(mvp[5]).toBe(f(0.0009057971183210611));
    expect(mvp[12]).toBe(f(-51.95380401611328));
    expect(mvp[13]).toBe(f(-91.5797119140625));
  });
});

describe("时钟拖动的 origin（WPE 日志 969 帧，P6c 走查）", () => {
  const edges = fillCropEdges("fill", SW, SH, W, H)!;
  const projection = croppedCursorViewProjection(general, 1, edges, identity());
  const cropped = predictor((cx, cy) => unprojectCursor(projection, [cx / W, cy / H]));
  // 以前的写法：不裁的 P·V，窗口指针先过 sceneCursor（double）
  const placement = scenePlacement("fill", SW, SH, W, H);
  const plain = sceneViewProjection(general, 1);
  const before = predictor((cx, cy) => unprojectCursor(plain, sceneCursor("fill", placement, W, H, cx / W, cy / H)));

  it("裁过的 P·V 逐位复现 968 帧（另 1 帧光标已移出窗口，origin 不再变）", () => {
    let same = 0;
    for (const [cx, cy, ox, oy] of fixture as number[][]) {
      const [x, y] = cropped(cx, cy);
      if (x === ox && y === oy) same++;
    }
    expect(same).toBe(968);
  });
  it("以前的写法在这份数据上有差（1 ulp），所以要改", () => {
    let same = 0;
    for (const [cx, cy, ox, oy] of fixture as number[][]) {
      const [x, y] = before(cx, cy);
      if (x === ox && y === oy) same++;
    }
    expect(same).toBeLessThan(968);
  });
});

describe("粒子跟随指针点（pointerScenePoint）", () => {
  const edges = fillCropEdges("fill", SW, SH, W, H)!;
  const projection = croppedCursorViewProjection(general, 1, edges, identity());
  it("窗口角与中心落在被盖满裁切后的场景位置上", () => {
    const center = pointerScenePoint(projection, [0.5, 0.5]);
    expect(center[0]).toBeCloseTo(SW / 2, 3);
    expect(center[1]).toBeCloseTo(SH / 2, 3);
    const corner = pointerScenePoint(projection, [0, 0]);
    expect(corner[0]).toBeCloseTo(edges[0], 3);
    expect(corner[1]).toBeCloseTo(SH, 3);
  });
  it("和以前（sceneCursor + 不裁的 P·V）只差 float32 舍入", () => {
    const placement = scenePlacement("fill", SW, SH, W, H);
    const plain = sceneViewProjection(general, 1);
    for (const [x, y] of [
      [0.1, 0.9],
      [0.5, 0.5],
      [0.73, 0.21],
    ] as const) {
      const a = pointerScenePoint(projection, [x, y]);
      const b = pointerScenePoint(plain, sceneCursor("fill", placement, W, H, x, y));
      expect(Math.abs(a[0] - b[0])).toBeLessThan(2e-3);
      expect(Math.abs(a[1] - b[1])).toBeLessThan(2e-3);
    }
  });
  it("缩放与抖动：zoom 的三步、V 的平移都进裁过的 P·V", () => {
    const view = Float32Array.from(identity());
    view[12] = -3;
    view[13] = 2;
    const zoomed = croppedCursorViewProjection(general, 1.5, edges, view);
    const p = pointerScenePoint(zoomed, [0.5, 0.5]);
    // 可见区中心 (SW/2, SH/2) 经缩放不动，V 平移 (−3, 2) 把世界点移到 (+3, −2) 的位置：指针中心落在中心 + (3, −2)
    expect(p[0]).toBeCloseTo(SW / 2 + 3, 2);
    expect(p[1]).toBeCloseTo(SH / 2 - 2, 2);
  });
});

describe("探针与会话的接线", () => {
  const scene: [number, number] = [SW, SH];
  const window: [number, number] = [W, H];
  it("replayPointers：cropped 时光标保持窗口指针并给出裁切边距；不给 cropped 同以前", () => {
    const options = { pointers: [[0.25, 0.75]] as [number, number][], window };
    const old = replayPointers(options, scene, 1);
    expect(old.cursorCrop).toBeNull();
    expect(old.cursors[0]).not.toEqual([0.25, 0.75]);
    const now = replayPointers({ ...options, cropped: true }, scene, 1);
    expect(now.cursors[0]).toEqual([0.25, 0.75]);
    expect(now.pointers[0]).toEqual([0.25, 0.75]);
    expect(now.cursorCrop).toEqual(fillCropEdges("fill", SW, SH, W, H));
    // 同比例：cropped 也原样、没有裁切
    const same = replayPointers({ ...options, window: [1968, 1104], cropped: true }, scene, 1);
    expect(same.cursorCrop).toBeNull();
  });
  it("CursorSession：windowCursor 为真时世界坐标按窗口指针反投影，否则按 cursor", () => {
    const edges = fillCropEdges("fill", SW, SH, W, H)!;
    const projection = croppedCursorViewProjection(general, 1, edges, identity());
    const camera = (windowCursor: boolean) => ({
      viewProjection: projection,
      windowCursor,
      eye: [SW / 2, SH / 2, 2000],
      perspective: false,
      forward: [0, 0, -1],
      override: null,
    });
    const input = (windowCursor: boolean) => ({
      camera: camera(windowCursor),
      cursor: [0.9, 0.9] as [number, number],
      pointer: [0.5, 0.5] as [number, number],
      window,
      down: false,
      parallax: null,
    });
    const scenePart = { layers: [], state: {} as never };
    const a = new CursorSession().frame(input(true), scenePart, false).snapshot.world;
    expect(a[0]).toBeCloseTo(SW / 2, 3);
    const b = new CursorSession().frame(input(false), scenePart, false).snapshot.world;
    expect(b).toEqual([...unprojectCursor(projection, [0.9, 0.9]).slice(0, 2), 0]);
  });
});
