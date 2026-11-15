// P6d1a 点 2：图层对象的层级与变换 API（getParent / getChildren / getTransformMatrix / rotateObjectSpace / lookAt / lookAtYaw）
// 与 `thisScene.getLayerByID`。真值：`ignore/p6/d0/out/p6d1-round2.log`、`p6d1-xform.log`（WPE 2.8.42 实测）；比较逐位，-0 与 0 视同。
import { describe, expect, it } from "vitest";
import { generalDefaults } from "../compile/bindings";
import type { SceneBundle, SceneLayer } from "../compile/bundle";
import { drawMatrixOf } from "../render/layout";
import { SceneState, scriptWriteValue } from "../render/state";
import { ScriptApi } from "./api";
import type { ScriptRealm } from "./runtime";

class Vec {
  constructor(
    public x = 0,
    public y = 0,
    public z = 0,
    public w = 0,
  ) {}
}
class Mat4Proto {}

class FakeRealm implements ScriptRealm {
  global: Record<string, unknown> = { Object, Array, JSON, Float32Array };
  prototypes = { Vec2: Vec.prototype, Vec3: Vec.prototype, Vec4: Vec.prototype, Mat3: {}, Mat4: Mat4Proto.prototype };
  internal = { updateScriptProperties() {}, convertUserProperties: () => ({}) };
  async importModule(): Promise<Record<string, unknown>> {
    return {};
  }
  dispose() {}
}

interface LayerSpec {
  parent?: number | null;
  origin?: number[];
  angles?: number[];
  alignment?: number;
  camera?: boolean;
  id?: number;
}

function bundleOf(specs: LayerSpec[]): SceneBundle {
  const layers = specs.map(
    (spec, object) =>
      ({
        id: spec.id ?? object + 10,
        object,
        parent: spec.parent ?? null,
        name: `L${object}`,
        origin: spec.origin ?? [0, 0, 0],
        scale: [1, 1, 1],
        angles: spec.angles ?? [0, 0, 0],
        alignment: spec.alignment,
        size: [100, 100],
        alpha: 1,
        color: [1, 1, 1],
        brightness: 1,
        visible: true,
        parallaxDepth: [1, 1],
        effects: [],
        passes: [],
        camera: spec.camera ? { fov: 50, zoom: 1 } : null,
      }) as unknown as SceneLayer,
  );
  return {
    general: {
      width: 1920,
      height: 1080,
      fields: generalDefaults(),
      clearVariable: false,
      perspectiveOverrideFov: (95 * Math.PI) / 180,
      postprocess: { level: "enabled", bloomFlag: true, hdrFlag: false, bloom: true, hdr: false },
      bloom: {
        strength: 1,
        threshold: 0.5,
        tint: [1, 1, 1],
        hdrStrength: 1,
        hdrThreshold: 0.5,
        hdrFeather: 1,
        hdrScatter: 1,
        hdrIterations: 4,
      },
    },
    layers,
    programs: [],
    textures: [],
    bindings: [],
    scripts: { list: [] },
  } as unknown as SceneBundle;
}

function setup(specs: LayerSpec[]) {
  const bundle = bundleOf(specs);
  const state = SceneState.fromBundle(bundle);
  const api = new ScriptApi(new FakeRealm(), {
    bundle: () => bundle,
    state: () => state,
    screenResolution: () => [800, 600],
    frametime: () => 0.016,
    runtime: () => 0,
    timeOfDay: () => 0,
    write(target, value) {
      if (target.kind === "unsupported" || target.kind === "script-property" || target.kind === "recompile")
        return false;
      state.write({ property: "test", target }, scriptWriteValue(value as number[]));
      return true;
    },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layer = (n: number) => api.layer(n) as Record<string, any>;
  return { bundle, state, api, layer };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type L = Record<string, any>;
const nz = (v: number): number => v + 0;
function bits(actual: readonly number[], expected: readonly number[], tag: string): void {
  expect(actual.length, tag).toBe(expected.length);
  actual.forEach((value, i) =>
    expect(Object.is(nz(value), nz(expected[i])), `${tag}[${i}] ${value} vs ${expected[i]}`).toBe(true),
  );
}
const degOf = (layer: L): number[] => [layer.angles.x, layer.angles.y, layer.angles.z];
const mOf = (layer: L): number[] => Array.from(layer.getTransformMatrix().m as number[]);
const P = [960, 540, 0];

describe("层级查询", () => {
  it("图层对象没有 id", () => {
    const h = setup([{}]);
    expect(Object.keys(h.layer(0))).not.toContain("id");
    expect("id" in h.layer(0)).toBe(false);
  });

  it("getParent：根 null、子是父的同一个对象", () => {
    const h = setup([{}, { parent: 0 }, { parent: 1 }]);
    expect(h.layer(0).getParent()).toBeNull();
    expect(h.layer(1).getParent()).toBe(h.layer(0));
    expect(h.layer(2).getParent()).toBe(h.layer(1));
  });

  it("getChildren：objects 顺序、每次新数组、元素是同一个对象", () => {
    const h = setup([{}, { parent: 0 }, {}, { parent: 0 }]);
    const a = h.layer(0).getChildren() as unknown[];
    expect(a.length).toBe(2);
    expect(a[0]).toBe(h.layer(1));
    expect(a[1]).toBe(h.layer(3));
    expect(h.layer(0).getChildren()).not.toBe(a);
    expect(h.layer(1).getChildren()).toEqual([]);
    expect(h.layer(2).getChildren()).toEqual([]);
  });
});

describe("getTransformMatrix", () => {
  it("是 Mat4、m 等于 drawMatrixOf（含图像层对齐偏移与父链）", () => {
    const h = setup([
      { origin: [10, 20, 0], angles: [0, 0, 0.5] },
      { parent: 0, origin: [100, 0, 0], alignment: 3 },
    ]);
    const mat = h.layer(1).getTransformMatrix();
    expect(mat).toBeInstanceOf(Mat4Proto);
    expect(Object.keys(mat)).toEqual(["m"]);
    bits(mat.m, Array.from(drawMatrixOf(1, h.state.layers, new Map())), "m");
    // 偏移确实进了平移列
    expect(h.state.layers.get(1)!.offset).toBeDefined();
    const stripped = new Map([...h.state.layers].map(([k, v]) => [k, { ...v, offset: [0, 0] }]));
    expect(mat.m[12]).not.toBe(drawMatrixOf(1, stripped, new Map())[12]);
    expect(h.layer(1).getTransformMatrix()).not.toBe(mat);
  });

  it("宿主给了 transformMatrix 就用它（挂点钩子）", () => {
    const bundle = bundleOf([{}]);
    const state = SceneState.fromBundle(bundle);
    const api = new ScriptApi(new FakeRealm(), {
      bundle: () => bundle,
      state: () => state,
      screenResolution: () => [1, 1],
      frametime: () => 0,
      runtime: () => 0,
      timeOfDay: () => 0,
      write: () => false,
      transformMatrix: () => new Float32Array(16).fill(7),
    });
    bits((api.layer(0)!.getTransformMatrix as () => { m: number[] })().m, Array(16).fill(7), "hook");
  });

  it("R5：父 rotateObjectSpace 之后立刻读子已经变了（960 640）", () => {
    const h = setup([{ origin: P }, { parent: 0, origin: [100, 0, 0] }]);
    bits(mOf(h.layer(1)).slice(12, 14), [1060, 540], "R5a");
    h.layer(0).rotateObjectSpace(new Vec(0, 0, Math.PI / 2));
    bits(mOf(h.layer(1)).slice(12, 14), [960, 640], "R5b");
  });
});

describe("rotateObjectSpace", () => {
  it("R1：从 0 转 (0.3, 0.2, 0.1)", () => {
    const h = setup([{ origin: P }]);
    expect(h.layer(0).rotateObjectSpace(new Vec(0.3, 0.2, 0.1))).toBeUndefined();
    bits(degOf(h.layer(0)), [17.18873405456543, 11.459155082702637, 5.729578018188477], "angles");
    bits(
      mOf(h.layer(0)).slice(0, 11),
      [
        0.975170373916626, 0.09784340113401413, -0.19866932928562164, 0, -0.036957018077373505, 0.956425130367279,
        0.2896294891834259, 0, 0.21835066378116608, -0.2750958502292633, 0.9362934231758118,
      ],
      "m",
    );
  });

  it("R4：非对象参数只归一化（JSON 弧度 6.981317 → 40.000004）", () => {
    const h = setup([{ angles: [0, 0, Math.fround(6.981317)] }]);
    bits(degOf(h.layer(0)), [0, 0, 400], "R4a");
    h.layer(0).rotateObjectSpace(5);
    bits(degOf(h.layer(0)), [0, 0, 40.000003814697266], "R4b");
    h.layer(0).rotateObjectSpace(undefined);
    bits(degOf(h.layer(0)), [0, 0, 40.000003814697266], "R4c");
  });

  it("R5：转完再把读回的角度写回去，3×3 改按角度重建", () => {
    const h = setup([{ origin: [300, 600, 0] }]);
    h.layer(0).rotateObjectSpace(new Vec(0, 0, 0.5));
    expect(h.state.layers.get(0)!.rotation).not.toBeNull();
    const rotatedM = mOf(h.layer(0));
    const deg = h.layer(0).angles;
    h.layer(0).angles = new Vec(deg.x, deg.y, deg.z);
    expect(h.state.layers.get(0)!.rotation).toBeNull();
    expect(Math.abs(mOf(h.layer(0))[0] - rotatedM[0])).toBeLessThan(1e-6);
  });
});

describe("lookAt / lookAtYaw", () => {
  it("L2：eye (960, 540, 0) 看 (1060, 640, 500)，角度原样写入、清掉 3×3", () => {
    const h = setup([{ origin: P }]);
    h.layer(0).rotateObjectSpace(new Vec(0.1, 0, 0));
    expect(h.layer(0).lookAt(new Vec(1060, 640, 500))).toBeUndefined();
    bits(degOf(h.layer(0)), [-11.095804214477539, 11.309932708740234, 0], "L2");
    expect(h.state.layers.get(0)!.rotation).toBeNull();
  });

  it("L3：看自己什么都不写", () => {
    const h = setup([{ origin: P, angles: [0, 0, 0.5] }]);
    h.layer(0).lookAt(new Vec(960, 540, 0));
    bits(h.state.layers.get(0)!.angles, [0, 0, 0.5], "L3");
  });

  it("L3b：视线与 up 平行时写进 NaN（WPE 读回 NaN NaN NaN、矩阵全 NaN），3×3 仍为 null", () => {
    const h = setup([{ origin: P, angles: [0, 0, 0.5] }]);
    h.layer(0).lookAt(new Vec(960, 640, 0));
    bits(degOf(h.layer(0)), [NaN, NaN, NaN], "L3b");
    expect(h.state.layers.get(0)!.rotation).toBeNull();
    expect(
      mOf(h.layer(0))
        .slice(0, 11)
        .every((v, i) => (i % 4 === 3 ? v === 0 : Number.isNaN(v))),
    ).toBe(true);
  });

  it("L7 / L9：不传目标或非对象目标 = 看原点", () => {
    const h = setup([{ origin: P }]);
    h.layer(0).lookAt();
    bits(degOf(h.layer(0)), [29.357755661010742, -90, 0], "L7");
    const h2 = setup([{ origin: P }]);
    h2.layer(0).lookAt(5);
    bits(degOf(h2.layer(0)), [29.357755661010742, -90, 0], "L9");
  });

  it("Y1 / Y3：lookAtYaw，up 缺省与 (0, 2, 0)", () => {
    const h = setup([{ origin: P }]);
    h.layer(0).lookAtYaw(new Vec(1060, 590, 300), new Vec(0, 2, 0));
    bits(degOf(h.layer(0)), [25.37693214416504, 18.434947967529297, 0], "Y3");
    const h1 = setup([{ origin: P }]);
    h1.layer(0).lookAtYaw(new Vec(1060, 590, 300));
    bits(degOf(h1.layer(0)), [0, 18.434947967529297, 0], "Y1");
  });

  it("L6：相机对象用 −Z 对着目标", () => {
    const h = setup([{ origin: [0, 0, 0], camera: true }]);
    h.layer(0).lookAt(new Vec(100, 100, 500));
    bits(degOf(h.layer(0)), [-168.90420532226562, -11.309932708740234, 180], "L6");
  });
});

describe("thisScene.getLayerByID", () => {
  const find = (h: ReturnType<typeof setup>, ...args: unknown[]) =>
    (h.api.thisScene.getLayerByID as (...a: unknown[]) => unknown)(...args);

  it("只收字符串；无参 undefined；找不到 null", () => {
    const h = setup([{ id: 3 }, { id: 10 }]);
    expect(find(h, "10")).toBe(h.layer(1));
    expect(find(h, 10)).toBeNull();
    expect(find(h)).toBeUndefined();
    expect(find(h, null)).toBeNull();
    expect(find(h, "99")).toBeNull();
  });

  it("照 strtol：前导空白、符号、尾部杂字、无数字得 0", () => {
    const h = setup([{ id: 0 }, { id: 10 }, { id: -4 }]);
    expect(find(h, " 10abc")).toBe(h.layer(1));
    expect(find(h, "+10")).toBe(h.layer(1));
    expect(find(h, "-4")).toBe(h.layer(2));
    expect(find(h, "abc")).toBe(h.layer(0));
    expect(find(h, "")).toBe(h.layer(0));
  });

  it("前导空白只认 C isspace（空格与 \t \n \v \f \r），NBSP 等 Unicode 空格不算：停在第一个非数字得 0", () => {
    const h = setup([{ id: 0 }, { id: 10 }]);
    expect(find(h, "\t\n\v\f\r 10")).toBe(h.layer(1));
    expect(find(h, "\u00a0 10")).toBe(h.layer(0));
    expect(find(h, "\ufeff10")).toBe(h.layer(0));
  });

  it("getLayer 无参 undefined（传了 undefined 仍是按名字找、得 null）", () => {
    const h = setup([{ id: 0 }]);
    const getLayer = h.api.thisScene.getLayer as (...a: unknown[]) => unknown;
    expect(getLayer()).toBeUndefined();
    expect(getLayer(undefined)).toBeNull();
  });
});
