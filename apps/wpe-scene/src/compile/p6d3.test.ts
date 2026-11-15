/**
 * P6d3a 点 2、点 7 的编译期部分（`.claude/plans/wpe-import/3-scene/phase6/phase-6d3-runtime-layers.md`）：
 * - `childLists` / `breakCycles`（`hierarchy.ts`）：子表 = 没换过父的按 `objects` 下标，换过的按最后一次挂上的先后追加在尾；
 * - `compileScene` 的 `structure`：`destroyed` 里的项当作不存在（不进 `bundle.layers`、下标对齐、脚本 / 动画 / 绑定 / 灯 / 依赖都不收），
 *   `parents` 覆盖 `SceneLayer.parent`、`bundle.children`、组的 `subtree` 顺序（`assignGroups` 的 `order`）；没有结构时与改前相同；
 * - `normalizeConfig` 与 `bundle.configs`：jsoncpp writer 的规整（步骤 0 实测的核对用例）。
 */
import { describe, expect, it, vi } from "vitest";
import { assignGroups, compileScene, resolveAttachment, type SceneBundle } from "./bundle";
import { normalizeConfig } from "./config";
import type { SceneReader } from "./fs";
import { breakCycles, childLists, resolveParents } from "./hierarchy";
import type { SceneObject } from "./model";
import type { SceneStructure } from "./protocol";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

const ORTHO = { orthogonalprojection: { width: 1920, height: 1080 } };

function memory(files: Record<string, unknown>): SceneReader {
  const reader: SceneReader = {
    async readWhole(path) {
      const value = files[path.replace(/\\/g, "/")];
      if (value === undefined) throw new TypeError("Failed to fetch");
      return new TextEncoder().encode(JSON.stringify(value));
    },
    async readRange(path, start, end) {
      return (await reader.readWhole(path)).slice(start, end);
    },
  };
  return reader;
}

function compile(
  objects: unknown[],
  structure?: SceneStructure,
  scriptOverrides?: Record<string, number[] | boolean | string>,
): Promise<SceneBundle> {
  return compileScene({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    reader: memory({
      "P:/p/project.json": { file: "scene.json" },
      "P:/p/scene.json": { general: ORTHO, objects },
      "P:/p/models/a.json": { material: "materials/a.json", width: 40, height: 60 },
      "P:/p/materials/a.json": { passes: [{ shader: "simple" }] },
    }),
    translator: null,
    postprocess: "disabled",
    exhaustive: true,
    ...(structure ? { structure } : {}),
    ...(scriptOverrides ? { scriptOverrides } : {}),
  });
}

const image = (extra: Record<string, unknown>) => ({ image: "models/a.json", size: "40 60", ...extra });

describe("childLists（子表）", () => {
  it("没换过父的按 objects 下标，换过的按最后一次挂上的先后追加在尾", () => {
    // 0 是根；1、2、3 的 JSON 父都是 0；4 的父是 2
    const parents = [null, 0, 0, 0, 2];
    expect(childLists(parents, 5, [])).toEqual(
      new Map([
        [0, [1, 2, 3]],
        [2, [4]],
      ]),
    );
    // 4 换到 0 下、1 换到 0 下（本来就在 0 下，但位置挪到尾）：覆盖按发生先后
    const after = [null, 0, 0, 0, 0];
    const lists = childLists(after, 5, [
      [4, 0, null],
      [1, 0, null],
    ]);
    expect(lists.get(0)).toEqual([2, 3, 4, 1]);
    expect(lists.has(2)).toBe(false);
  });

  it("同一个对象多次换父只取最后一次的位置；最终没有父的不进任何子表", () => {
    const parents = [null, 3, null, null];
    const lists = childLists(parents, 4, [
      [1, 2, null],
      [2, 3, null],
      [1, 3, null],
      [2, null, null],
    ]);
    // 1：最后一次挂上在第 3 条（父 3）；2：最后一次是解除父子（最终父 null）
    expect(lists).toEqual(new Map([[3, [1]]]));
  });

  it("breakCycles 断开环并报告", () => {
    const parents: (number | null)[] = [1, 0, null];
    expect(breakCycles(parents)).toBe(true);
    expect(parents).toEqual([1, null, null]);
    expect(breakCycles([null, 0])).toBe(false);
  });

  it("resolveParents 跳过不是对象的项", () => {
    const objects = [{ id: 1 }, null, { id: 3, parent: 1 }, 7, [1]] as unknown as SceneObject[];
    expect(resolveParents(objects)).toEqual({ parents: [null, null, 0, null, null], cycle: false });
  });
});

describe("assignGroups 的组内顺序跟子表走（步骤 0 实测）", () => {
  const layers = () =>
    [
      { object: 0, parent: null, passthroughModel: true },
      { object: 1, parent: 0, passthroughModel: false },
      { object: 2, parent: 0, passthroughModel: false },
      { object: 3, parent: 0, passthroughModel: false },
    ].map((layer) => ({ ...layer, group: null as number | null, subtree: [] as number[] }));

  it("缺省按 objects 下标；给了子表就按子表", () => {
    const plain = layers();
    assignGroups(plain);
    expect(plain[0].subtree).toEqual([1, 2, 3]);
    const ordered = layers();
    assignGroups(ordered, new Map([[0, [3, 1, 2]]]));
    expect(ordered[0].subtree).toEqual([3, 1, 2]);
    expect(ordered.slice(1).map((layer) => layer.group)).toEqual([0, 0, 0]);
  });
});

describe("compileScene：结构（点 2）", () => {
  const base = () => [
    image({ id: 10, name: "a" }),
    image({ id: 11, name: "b", parent: 10 }),
    image({ id: 12, name: "c", parent: 10 }),
    image({ id: 13, name: "d" }),
  ];

  it("没有结构时 bundle 与空结构相同，子表是按 objects 的自然顺序", async () => {
    const without = await compile(base());
    const empty = await compile(base(), { destroyed: [], parents: [], created: [] });
    expect(empty).toEqual(without);
    expect(without.children).toEqual([[0, [1, 2]]]);
    expect(without.layers.map((layer) => [layer.object, layer.parent])).toEqual([
      [0, null],
      [1, 0],
      [2, 0],
      [3, null],
    ]);
  });

  it("destroyed 的项不进 bundle.layers，下标仍对齐；它的子对象变根、不进子表", async () => {
    const bundle = await compile(base(), { destroyed: [0], parents: [], created: [] });
    expect(bundle.layers.map((layer) => [layer.object, layer.parent])).toEqual([
      [1, null],
      [2, null],
      [3, null],
    ]);
    // `layers[i].object === i` 不再成立
    expect(bundle.layers[0].object).toBe(1);
    expect(bundle.children).toEqual([]);
  });

  it("destroyed 的对象不参与脚本、动画、灯与依赖的收集", async () => {
    const script = "export function update(value) { return value; }";
    const objects = [
      image({ id: 1, alpha: { script, value: 1 } }),
      image({
        id: 2,
        alpha: { script, value: 1 },
        brightness: { animation: { c0: [{ frame: 0, value: 1 }], options: { fps: 30, length: 10 } }, value: 1 },
      }),
      { id: 3, light: "lpoint", origin: "0 0 0" },
      image({ id: 4, dependencies: [1] }),
    ];
    const full = await compile(objects);
    expect(full.scripts.list.map((item) => item.layer)).toEqual([0, 1]);
    expect(full.animations?.length).toBe(1);
    const cut = await compile(objects, { destroyed: [1, 3], parents: [], created: [] });
    expect(cut.scripts.list.map((item) => item.layer)).toEqual([0]);
    expect(cut.animations).toEqual([]);
    expect(cut.layers.map((layer) => layer.object)).toEqual([0, 2]);
    // 绑定也不收被删对象
    expect(cut.bindings.every((binding) => !JSON.stringify(binding.target).includes("objects/1/"))).toBe(true);
  });

  it("scene.json 里本来就不是对象的项被跳过，不抛错", async () => {
    const bundle = await compile([image({ id: 1 }), null, 5, [1], image({ id: 2, parent: 1 })]);
    expect(bundle.layers.map((layer) => [layer.object, layer.parent])).toEqual([
      [0, null],
      [4, 0],
    ]);
  });

  it("parents 覆盖 SceneLayer.parent，子表按挂上的先后追加在尾", async () => {
    // d（3）挂到 a（0）下：a 的子表 [b, c, d]；b（1）挂到 d 下：a 的子表 [c, d]，d 的子表 [b]
    const bundle = await compile(base(), {
      destroyed: [],
      created: [],
      parents: [
        [3, 0, null],
        [1, 3, null],
      ],
    });
    expect(bundle.layers.map((layer) => layer.parent)).toEqual([null, 3, 0, 0]);
    expect(bundle.children).toEqual([
      [0, [2, 3]],
      [3, [1]],
    ]);
  });

  it("换父到根（null）与到已删对象都当根；成环的覆盖被断开", async () => {
    const toRoot = await compile(base(), { destroyed: [], parents: [[1, null, null]], created: [] });
    expect(toRoot.layers.map((layer) => layer.parent)).toEqual([null, null, 0, null]);
    expect(toRoot.children).toEqual([[0, [2]]]);
    const toDestroyed = await compile(base(), { destroyed: [3], parents: [[1, 3, null]], created: [] });
    expect(toDestroyed.layers.find((layer) => layer.object === 1)?.parent).toBeNull();
    // a 本来是 b 的父；把 a 挂到 b 下成环，断开 a 的父那条边之外的一条
    const cycle = await compile(base(), { destroyed: [], parents: [[0, 1, null]], created: [] });
    const parents = cycle.layers.map((layer) => layer.parent);
    expect(parents.some((parent, i) => parent === null && i <= 1)).toBe(true);
    expect(new Set(cycle.layers.map((layer) => layer.object)).size).toBe(4);
  });

  it("挂点：改写对象 JSON 的 attachment；null 就删掉", async () => {
    // 没有 puppet 父时 resolveAttachment 找不到，layer.attachment 不写；这里只验证不抛错且父换了
    const bundle = await compile(base(), { destroyed: [], parents: [[3, 0, "tip"]], created: [] });
    expect(bundle.layers[3].parent).toBe(0);
    expect(bundle.layers[3].attachment).toBeUndefined();
  });
});

describe("resolveAttachment：运行中换父带挂点（B4）", () => {
  const puppet = {
    skeleton: { parents: [-1, 0] },
    attachments: [{ name: "tip", bone: 1, matrix: new Float32Array(16) }],
  };
  const puppetOf = (object: number) => (object === 3 ? (puppet as never) : null);

  it("加载时父排在子后面（下标更大）挂点丢失；带挂点覆盖时放行", () => {
    expect(resolveAttachment(1, 3, "tip", puppetOf)).toBeNull();
    const hit = resolveAttachment(1, 3, "tip", puppetOf, true);
    expect(hit).toMatchObject({ parent: 3, bone: 1 });
    // 父在前面的规则不变
    expect(resolveAttachment(5, 3, "tip", puppetOf)).toMatchObject({ parent: 3, bone: 1 });
    // 别的条件不放宽：名字不对、父不是 puppet
    expect(resolveAttachment(1, 3, "nosuch", puppetOf, true)).toBeNull();
    expect(resolveAttachment(1, 2, "tip", puppetOf, true)).toBeNull();
  });
});

describe("normalizeConfig 与 bundle.configs（点 7）", () => {
  it("jsoncpp writer 的规整：去 id、键按字典序、非整数 8 位有效数字、整数与 1e21 原样", () => {
    const text = normalizeConfig({
      origin: "960 540 0",
      id: 12,
      brightness: 0.123456789123,
      kbcustom: [1, 2.5, true, null, "s", 1234.56789123, -0.000012345678912, 123456789012, 1e21, 0.1],
      name: "n",
      alpha: 1,
      angles: "0 0 0",
      color: "1 1 1",
      colorBlendMode: 0,
      copybackground: true,
      image: "models/a.json",
      parallaxDepth: "1 1",
      scale: "1 1 1",
      size: "40 60",
      visible: true,
    });
    expect(text).toContain('"brightness":0.12345679');
    expect(text).toContain('"kbcustom":[1,2.5,true,null,"s",1234.5679,-0.000012345679,123456789012,1e+21,0.1]');
    expect(text).not.toContain('"id"');
    expect(Object.keys(JSON.parse(text))).toEqual([
      "alpha",
      "angles",
      "brightness",
      "color",
      "colorBlendMode",
      "copybackground",
      "image",
      "kbcustom",
      "name",
      "origin",
      "parallaxDepth",
      "scale",
      "size",
      "visible",
    ]);
  });

  it("所有层级的键都排序，嵌套数组里的对象同样", () => {
    const text = normalizeConfig({ b: { z: 1, a: 0.1234567891 }, a: [{ y: 1, x: 2 }] });
    expect(text).toBe('{"a":[{"x":2,"y":1}],"b":{"a":0.12345679,"z":1}}');
  });

  it("bundle.configs：不是对象的项为 null；取套用 scriptOverrides 与结构之前的原文", async () => {
    const objects = [image({ id: 1, alpha: 0.5 }), null, image({ id: 2, alpha: 0.25 })];
    const bundle = await compile(objects, { destroyed: [2], parents: [], created: [] }, { "objects/0/alpha": [0.9] });
    expect(bundle.configs).toHaveLength(3);
    expect(bundle.configs![1]).toBeNull();
    expect(JSON.parse(bundle.configs![0]!).alpha).toBe(0.5);
    // 被删的对象仍有加载原文（getInitialLayerConfig 不看待删 / 已删）
    expect(JSON.parse(bundle.configs![2]!).alpha).toBe(0.25);
    expect(JSON.parse(bundle.configs![0]!)).not.toHaveProperty("id");
  });
});
