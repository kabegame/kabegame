/**
 * P12g：图像层上的 `getBoneIndex` / `getBoneParentIndex` / `getLocalBone*` / `setLocalBone*`（rea-p12g-localbones 第 1、3–6 节）。
 * 落点用真的 `ScenePuppets`，realm 用不碰 DOM 的假 realm（同 `p12dBonesApi.test.ts`，但 `Vec3` 构造器要真的记下 x y z）。
 * 骨架同 WPE 实测的 S4（`ignore/p12/g/defs/p12g.py`）：b0 根 → b1（T(100,0)·Rz 30°·S(2,1,1)）→ b2（T(60,0)），c0 独立根 T(0,150)，
 * 所以 la / la2 的日志行（夹具 `puppet/fixtures/p12g-local.json`）可以直接当期望。
 */
import { describe, expect, it } from "vitest";
import { generalDefaults } from "../compile/bindings";
import type { SceneBundle, SceneLayer } from "../compile/bundle";
import { MISSING_SCRIPT_API } from "../compile/scriptApi";
import fixture from "../puppet/fixtures/p12g-local.json";
import { inverse4, mulFull } from "../puppet/math";
import { ScenePuppets, type PuppetRig, type PuppetSink } from "../puppet/player";
import { SceneState } from "../render/state";
import { ScriptApi } from "./api";
import { writeScriptState } from "./stateWrite";
import type { ScriptRealm, ScriptTarget, ScriptValue } from "./runtime";
import { fakeModule } from "./testing/fakeModule";

class Vec3 {
  x: number;
  y: number;
  z: number;
  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }
}
class Vec {
  constructor(..._values: number[]) {}
}

class FakeRealm implements ScriptRealm {
  global: Record<string, unknown> = { Object, Array, JSON, Float32Array, SyntaxError, Function };
  prototypes = { Vec2: Vec.prototype, Vec3: Vec3.prototype, Vec4: Vec.prototype, Mat3: {}, Mat4: {} };
  modules = new Map<string, Record<string, unknown>>();
  internal = { updateScriptProperties() {}, convertUserProperties: () => ({}) };
  async prepareModule(_source: string, label: string) {
    return fakeModule(this.modules.get(label) ?? {});
  }
  dispose() {}
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const T = (x: number, y = 0, z = 0) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const B1 = [1.7320507764816284, 1, 0, 0, -0.5, 0.8660253882408142, 0, 0, 0, 0, 1, 0, 100, 0, 0, 1];
const NAMES = ["b0", "b1", "b2", "c0"];
const PARENTS = [-1, 0, 1, -1];

/** S4 骨架（没有物理）。 */
function rig(names = NAMES, parents = PARENTS): PuppetRig & { names: string[]; parents: number[]; boneCount: number } {
  const local = [T(0), B1, T(60), T(0, 150)].map((m) => Float32Array.from(m));
  const n = names.length;
  const restMatrices = new Float32Array(n * 16);
  const world = new Float32Array(n * 16);
  const inverseBind = new Float32Array(n * 16);
  const temp = new Float32Array(16);
  for (let i = 0; i < n; i++) {
    restMatrices.set(local[i], i * 16);
    if (parents[i] < 0) world.set(local[i], i * 16);
    else {
      mulFull(world, parents[i] * 16, local[i], 0, temp, 0);
      world.set(temp, i * 16);
    }
    inverse4(world, i * 16, inverseBind, i * 16);
  }
  return {
    skeleton: { parents: Int32Array.from(parents), inverseBind, rest: new Float32Array(n * 10), restMatrices },
    names,
    parents,
    boneCount: n,
    animations: [],
    layers: [],
    boneAlpha: false,
  } as unknown as PuppetRig & { names: string[]; parents: number[]; boneCount: number };
}

function layer(object: number, extra: Record<string, unknown> = {}): SceneLayer {
  return {
    id: object + 10,
    object,
    parent: null,
    name: `O${object}`,
    origin: [0, 0, 0],
    scale: [1, 1, 1],
    angles: [0, 0, 0],
    size: [100, 100],
    alpha: 1,
    color: [1, 1, 1],
    brightness: 1,
    visible: true,
    visibleBound: false,
    parallaxDepth: [1, 1],
    effects: [],
    passes: [],
    particle: null,
    puppet: null,
    alignment: 0,
    ...extra,
  } as unknown as SceneLayer;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Api = Record<string, any>;

/**
 * 对象 0 是 puppet（S4）、对象 1 是普通图像层、对象 2 是静态 puppet（`skeleton: null`，mdl 有 3 根骨骼 s0 → s1 → s2）、对象 3 没有 `alignment`（不是图像层）、
 * 对象 4 是名字重复的 puppet（x 根、x 非根、y）。`hosted: false` 时不给宿主视图。
 */
function setup(options: { hosted?: boolean } = {}) {
  const realm = new FakeRealm();
  const puppetRig = rig();
  const dupRig = rig(["x", "x", "y", "x"], [-1, 0, 1, -1]);
  const staticRig = { ...rig(["s0", "s1", "s2"], [-1, 0, 1]), skeleton: null };
  const bundle = {
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
    programs: [],
    textures: [],
    bloom: null,
    layers: [
      layer(0, { puppet: puppetRig }),
      layer(1),
      layer(2, { puppet: staticRig }),
      layer(3, { alignment: undefined }),
      layer(4, { puppet: dupRig }),
    ],
    unsupported: [],
    bindings: [],
    scripts: { list: [] },
    animations: [],
  } as unknown as SceneBundle;
  const state = SceneState.fromBundle(bundle);
  const puppets = new ScenePuppets([
    { object: 0, puppet: puppetRig },
    { object: 4, puppet: dupRig },
  ]);
  const world = Float32Array.from(T(200, 900));
  const sink: PuppetSink = { animationLayer: () => undefined, world: () => world };
  const h = {
    puppets,
    frame: () => puppets.frame(0.016, sink),
    api: null as unknown as ScriptApi,
    layer: (object: number) => h.api.layer(object) as Api,
  };
  h.api = new ScriptApi(realm, {
    bundle: () => bundle,
    state: () => state,
    screenResolution: () => [800, 600],
    frametime: () => 0.016,
    runtime: () => 0,
    timeOfDay: () => 0,
    write: (target, value) => writeScriptState(state, target as ScriptTarget, value as ScriptValue) === "applied",
    ...(options.hosted === false
      ? {}
      : {
          puppetLayers: (object: number) => ({
            ids: () => puppets.ids(object),
            find: (name: string) => puppets.findLayer(object, name),
            control: (id: number) => puppets.control(object, id),
            alive: (id: number) => puppets.alive(object, id),
            boneTransform: (bone: number | string) => puppets.boneTransform(object, bone),
            setBoneTransform: (bone: number | string, matrix: ArrayLike<number>) =>
              puppets.setBoneTransform(object, bone, matrix),
            localBoneTransform: (bone: number | string) => puppets.localBoneTransform(object, bone),
            localBoneAngles: (bone: number | string) => puppets.localBoneAngles(object, bone),
            localBoneOrigin: (bone: number | string) => puppets.localBoneOrigin(object, bone),
            setLocalBoneTransform: (bone: number | string, matrix: ArrayLike<number>) =>
              puppets.setLocalBoneTransform(object, bone, matrix),
            setLocalBoneAngles: (bone: number | string, v: readonly [number, number, number]) =>
              puppets.setLocalBoneAngles(object, bone, v),
            setLocalBoneOrigin: (bone: number | string, v: readonly [number, number, number]) =>
              puppets.setLocalBoneOrigin(object, bone, v),
          }),
        }),
  });
  return h;
}

const METHODS = [
  "getBoneIndex",
  "getBoneParentIndex",
  "getLocalBoneTransform",
  "setLocalBoneTransform",
  "getLocalBoneAngles",
  "setLocalBoneAngles",
  "getLocalBoneOrigin",
  "setLocalBoneOrigin",
];
const logs = fixture as unknown as {
  local: { logs: Record<string, string[]> };
  args: { logs: Record<string, string[]> };
};
const text = (m: ArrayLike<number>) => Array.from(m, String).join(" ");
const vec = (v: Api) => `${v.x} ${v.y} ${v.z}`;

describe("装载与缺失表", () => {
  it("8 个方法装在图像层上（含静态 puppet、普通图像层），没有 alignment 的对象没有", () => {
    const h = setup();
    for (const object of [0, 1, 2, 4])
      for (const name of METHODS) expect(typeof h.layer(object)[name], name).toBe("function");
    for (const name of METHODS) expect(name in h.layer(3), name).toBe(false);
  });

  it("缺失表只剩混合形状三个", () => {
    expect(MISSING_SCRIPT_API.layer.map((entry) => entry.name).filter((name) => METHODS.includes(name))).toEqual([]);
    for (const name of ["getBlendShapeIndex", "getBlendShapeWeight", "setBlendShapeWeight"])
      expect(
        MISSING_SCRIPT_API.layer.some((entry) => entry.name === name),
        name,
      ).toBe(true);
  });
});

describe("getBoneIndex / getBoneParentIndex（按骨骼表回答，不看运行时）", () => {
  it("la 的 init 行：5 类实参逐行与 WPE 相同（init 里、第一次推进之前）", () => {
    const h = setup();
    const a = h.layer(0);
    let checked = 0;
    for (const line of logs.local.logs.la) {
      const parts = line.split(",");
      if (parts[0] !== "init") continue;
      if (parts[1] === "idx" && parts[2] !== "num1") {
        expect(String(a.getBoneIndex(JSON.parse(parts[2]))), line).toBe(parts[3]);
        checked++;
      } else if (parts[1] === "idx") {
        // init,idx,num1,<getBoneIndex(1)>,none,<getBoneIndex()>
        expect([String(a.getBoneIndex(1)), String(a.getBoneIndex())], line).toEqual([parts[3], parts[5]]);
        checked++;
      } else if (parts[1] === "par") {
        expect(String(a.getBoneParentIndex(JSON.parse(parts[2]))), line).toBe(parts[3]);
        checked++;
      }
    }
    expect(checked).toBe(7 + 1 + 13);
  });

  it("getBoneIndex 只收字符串：数字（哪怕是合法下标）、对象、布尔、空串、大小写不对都是 −1；取第一个同名的", () => {
    const h = setup();
    const a = h.layer(0);
    expect(a.getBoneIndex("b1")).toBe(1);
    for (const bad of [1, 0, 1.5, "", "B1", "nosuch", {}, null, undefined, true])
      expect(a.getBoneIndex(bad), String(bad)).toBe(-1);
    expect(h.layer(4).getBoneIndex("x")).toBe(0);
  });

  it("getBoneParentIndex：整数按骨骼数判界（根 −1）；名字取第一个同名且有父的骨骼的父（跳过同名的根）", () => {
    const h = setup();
    expect([0, 1, 2, 3].map((i) => h.layer(0).getBoneParentIndex(i))).toEqual([-1, 0, 1, -1]);
    for (const bad of [4, 99, -1, 1.5, NaN, "", "B2", "2", {}, null, undefined, true])
      expect(h.layer(0).getBoneParentIndex(bad), String(bad)).toBe(-1);
    // x 根（0）被跳过，下一个同名的 x（1）有父 0
    expect(h.layer(4).getBoneParentIndex("x")).toBe(0);
    expect(h.layer(4).getBoneParentIndex("y")).toBe(1);
  });

  it("静态 puppet（没有骨骼运行时）、第一次推进之前都能用；非 puppet 为 −1", () => {
    const h = setup();
    expect(h.layer(2).getBoneIndex("s2")).toBe(2);
    expect(h.layer(2).getBoneParentIndex(2)).toBe(1);
    expect(h.layer(2).getBoneParentIndex("s1")).toBe(0);
    expect(h.layer(1).getBoneIndex("b0")).toBe(-1);
    expect(h.layer(1).getBoneParentIndex(0)).toBe(-1);
  });

  it("没有宿主视图时也能用（不经视图）", () => {
    const h = setup({ hosted: false });
    expect(h.layer(0).getBoneIndex("c0")).toBe(3);
    expect(h.layer(0).getBoneParentIndex("b2")).toBe(1);
  });
});

describe("读：getLocalBoneTransform / Angles / Origin", () => {
  it("推进之前（init）一律失败：单位阵与 (0,0,0)；推进后第 1 帧读到 MDLS 局部矩阵", () => {
    const h = setup();
    expect(h.layer(0).getLocalBoneTransform(0).m).toEqual(IDENTITY);
    expect(vec(h.layer(0).getLocalBoneOrigin(1))).toBe("0 0 0");
    h.frame();
    expect(text(h.layer(0).getLocalBoneTransform(1).m)).toBe(text(B1));
    expect(text(h.layer(0).getLocalBoneTransform("b1").m)).toBe(text(B1));
    expect(vec(h.layer(0).getLocalBoneOrigin(1))).toBe("100 0 0");
    expect(vec(h.layer(0).getLocalBoneAngles(1))).toBe("0 0 0.5235987901687622");
    expect(vec(h.layer(0).getLocalBoneAngles("b1"))).toBe("0 0 0.5235987901687622");
  });

  it("选骨失败：单位阵 / (0,0,0)，不是 null、不抛错（越界、非整数、空串、−1、大小写、数字字符串）", () => {
    const h = setup();
    h.frame();
    for (const bad of [99, -1, 1.5, NaN, "", "B1", "1", 4, {}, null, undefined, true]) {
      expect(h.layer(0).getLocalBoneTransform(bad).m, String(bad)).toEqual(IDENTITY);
      expect(vec(h.layer(0).getLocalBoneAngles(bad)), String(bad)).toBe("0 0 0");
      expect(vec(h.layer(0).getLocalBoneOrigin(bad)), String(bad)).toBe("0 0 0");
    }
  });

  it("每次返回新对象：Mat4 原型、自有键 m；Vec3 原型、自有键 x y z；改返回值不影响内部", () => {
    const h = setup();
    h.frame();
    const a = h.layer(0).getLocalBoneTransform(0);
    const b = h.layer(0).getLocalBoneTransform(0);
    expect(a).not.toBe(b);
    expect(Object.getPrototypeOf(a)).toBe(h.layer(0).getLocalBoneTransform(0).__proto__);
    expect(Object.keys(a)).toEqual(["m"]);
    a.m[12] = 999;
    expect(h.layer(0).getLocalBoneTransform(0).m[12]).toBe(0);
    for (const getter of ["getLocalBoneAngles", "getLocalBoneOrigin"]) {
      const v = h.layer(0)[getter](0);
      expect(Object.getPrototypeOf(v)).toBe(Vec3.prototype);
      expect(Object.keys(v)).toEqual(["x", "y", "z"]);
      expect(h.layer(0)[getter](0)).not.toBe(v);
    }
  });

  it("非 puppet、静态 puppet 与（没有 alignment 以外的）失败：单位阵 / 零向量，set 返回 undefined", () => {
    const h = setup();
    h.frame();
    for (const object of [1, 2]) {
      const l = h.layer(object);
      expect(l.getLocalBoneTransform(0).m).toEqual(IDENTITY);
      expect(vec(l.getLocalBoneAngles(0))).toBe("0 0 0");
      expect(vec(l.getLocalBoneOrigin(0))).toBe("0 0 0");
      expect(l.setLocalBoneOrigin(0, new Vec3(1, 2, 3))).toBeUndefined();
    }
  });

  it("没有宿主视图：读回失败值，写空操作不抛错", () => {
    const h = setup({ hosted: false });
    h.frame();
    expect(h.layer(0).getLocalBoneTransform(0).m).toEqual(IDENTITY);
    expect(() => {
      h.layer(0).setLocalBoneTransform(0, { m: T(5) });
      h.layer(0).setLocalBoneAngles(0, new Vec3(1, 2, 3));
      h.layer(0).setLocalBoneOrigin(0, new Vec3(1, 2, 3));
    }).not.toThrow();
  });
});

describe("写：当帧生效、只管一帧、选骨失败不做事", () => {
  it("setLocalBoneOrigin 当帧读回新值、子树的世界矩阵当场重算（W = 图层矩阵），兄弟不动；下一帧复位", () => {
    const h = setup();
    h.frame();
    expect(h.layer(0).setLocalBoneOrigin(0, new Vec3(10, 20, 30))).toBeUndefined();
    expect(vec(h.layer(0).getLocalBoneOrigin(0))).toBe("10 20 30");
    // 同 WPE la 的 t2（W = T(200, 900)）：b2 的世界平移 (413.92…, 980, 30)
    expect(h.layer(0).getBoneTransform(2).m.slice(12, 15)).toEqual([413.92303466796875, 980, 30]);
    expect(h.layer(0).getBoneTransform("c0").m.slice(12, 15)).toEqual([200, 1050, 0]);
    h.frame();
    expect(vec(h.layer(0).getLocalBoneOrigin(0))).toBe("0 0 0");
  });

  it("la / la2 的写入：缺参与非法实参换成单位阵 / (0,0,0)，读回逐行与 WPE 相同（t2–t13、t22、t23）", () => {
    const m = (...values: unknown[]) => ({ m: values });
    const cases: [string, (a: Api) => void][] = [
      ["t2", (a) => a.setLocalBoneTransform(1)],
      ["t3", (a) => a.setLocalBoneTransform(1, 5)],
      ["t4", (a) => a.setLocalBoneAngles(1)],
      ["t5", (a) => a.setLocalBoneOrigin(1)],
      ["t6", (a) => a.setLocalBoneAngles(1, 7)],
      ["t7", (a) => a.setLocalBoneOrigin(1, "x")],
      ["t8", (a) => a.setLocalBoneTransform(1, m(2, "x"))],
      ["t9", (a) => a.setLocalBoneTransform(1, m("q", 0, 0, 0, 0, 3, 0, 0, 0, 0, 1, 0, 4, 5, 6, 1))],
      ["t10", (a) => a.setLocalBoneAngles(1, { x: 1 })],
      ["t11", (a) => a.setLocalBoneOrigin(1, { x: 3, y: 4 })],
      ["t12", (a) => a.setLocalBoneTransform(1, null)],
    ];
    for (const [tag, call] of cases) {
      const h = setup();
      h.frame();
      expect(call(h.layer(0)), tag).toBeUndefined();
      const want = logs.args.logs.la2.find((line) => line.startsWith(`${tag},1`) || line.startsWith(`${tag},2`))!;
      expect(`${tag},${text(h.layer(0).getLocalBoneTransform(1).m)}`, tag).toBe(want);
    }
    // la 的 t22 / t23：{x:5, y:'a', z:7} → (5, 0, 7)；m 里的 'q' 保留单位阵对应位
    const h = setup();
    h.frame();
    h.layer(0).setLocalBoneOrigin(0, { x: 5, y: "a", z: 7 });
    expect(`t22,${text(h.layer(0).getLocalBoneTransform(0).m)}`).toBe(
      logs.local.logs.la.find((line) => line.startsWith("t22,1"))!,
    );
    h.layer(0).setLocalBoneTransform(0, m(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, "q", 5, 1));
    expect(`t23,${text(h.layer(0).getLocalBoneTransform(0).m)}`).toBe(
      logs.local.logs.la.find((line) => line.startsWith("t23,1"))!,
    );
  });

  it("setLocalBoneAngles 丢缩放、保留平移；setLocalBoneOrigin 只改平移（t8、t9）", () => {
    const h = setup();
    h.frame();
    h.layer(0).setLocalBoneAngles(1, new Vec3(0.5, 0, 0));
    expect(`t8,${text(h.layer(0).getLocalBoneTransform(1).m)}`).toBe(
      logs.local.logs.la.find((line) => line.startsWith("t8,1"))!,
    );
    h.frame();
    h.layer(0).setLocalBoneOrigin(1, new Vec3(11, 22, 33));
    expect(`t9,${text(h.layer(0).getLocalBoneTransform(1).m)}`).toBe(
      logs.local.logs.la.find((line) => line.startsWith("t9,1"))!,
    );
  });

  it("选骨失败什么都不做（空串、1.5、越界、−1、大小写不对、数字字符串、true、null、推进之前）", () => {
    const h = setup();
    const a = h.layer(0);
    a.setLocalBoneTransform(0, { m: T(500, 500) });
    h.frame();
    const before = text(a.getBoneTransform(2).m);
    for (const bad of ["", 1.5, 99, -1, "B0", "0", true, null, undefined]) {
      a.setLocalBoneTransform(bad, { m: T(500, 500) });
      a.setLocalBoneAngles(bad, new Vec3(1, 1, 1));
      a.setLocalBoneOrigin(bad, new Vec3(1, 1, 1));
    }
    expect(text(a.getBoneTransform(2).m)).toBe(before);
    expect(text(a.getLocalBoneTransform(0).m)).toBe(text(IDENTITY));
    // 按名字能写
    a.setLocalBoneTransform("b0", { m: T(7, 8, 9) });
    expect(vec(a.getLocalBoneOrigin(0))).toBe("7 8 9");
  });

  it("先后：setBoneTransform(1) 之后 setLocal(2) 跟着走，反过来不跟（t16 / t17）", () => {
    const moved = (a: Api, dx: number) => {
      const m = Array.from(a.getBoneTransform(1).m as number[]);
      m[12] += dx;
      return { m };
    };
    const h = setup();
    h.frame();
    const a = h.layer(0);
    a.setBoneTransform(1, moved(a, 50));
    a.setLocalBoneTransform(2, a.getLocalBoneTransform(2));
    const follow = a.getBoneTransform(2).m[12];
    const h2 = setup();
    h2.frame();
    const b = h2.layer(0);
    b.setLocalBoneTransform(2, b.getLocalBoneTransform(2));
    b.setBoneTransform(1, moved(b, 50));
    expect(follow - b.getBoneTransform(2).m[12]).toBe(50);
  });
});
