/**
 * P6d3b 点 9、11、12 的编译期部分：
 * - `collectObjectScripts` 与 `collectScripts` 同一套遍历；
 * - `scriptAssetCandidates` 与 `bundle.assetPaths`（脚本里的资源路径字面量里，在 WPE assets 存在的）；
 * - `structure.created`：新建对象放到 `scene.objects[下标]` 之后和加载时的对象走同一条编译路径，建了又删的不编，数组配置不当图层，
 *   依赖标记只看加载时的对象。
 */
import { describe, expect, it, vi } from "vitest";
import { compileScene, type SceneBundle } from "./bundle";
import { scriptAssetCandidates } from "./assetPaths";
import type { SceneReader } from "./fs";
import { collectObjectScripts, collectScripts } from "./scripts";
import type { SceneJson } from "./model";
import type { SceneStructure } from "./protocol";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

const BACKSLASH = String.fromCharCode(92);

/** `projectFiles`：工程目录；`assetFiles`：WPE assets 根目录（`A:/assets`）。 */
function memory(projectFiles: Record<string, unknown>, assetFiles: Record<string, unknown> = {}): SceneReader {
  const files: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(projectFiles)) files[`P:/p/${path}`] = value;
  for (const [path, value] of Object.entries(assetFiles)) files[`A:/assets/${path}`] = value;
  const reader: SceneReader = {
    async readWhole(path) {
      const value = files[path.split(BACKSLASH).join("/")];
      if (value === undefined) throw new TypeError("Failed to fetch");
      return new TextEncoder().encode(JSON.stringify(value));
    },
    async readRange(path, start, end) {
      return (await reader.readWhole(path)).slice(start, end);
    },
  };
  return reader;
}

const script = (extra = "") => `export function update(value) { return value; }${extra}`;
const image = (extra: Record<string, unknown>) => ({ image: "models/a.json", size: "40 60", ...extra });

function compile(
  objects: unknown[],
  structure?: SceneStructure,
  assetFiles: Record<string, unknown> = {},
): Promise<SceneBundle> {
  return compileScene({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    reader: memory(
      {
        "project.json": { file: "scene.json" },
        "scene.json": { general: { orthogonalprojection: { width: 1920, height: 1080 } }, objects },
        "models/a.json": { material: "materials/a.json", width: 40, height: 60 },
        "materials/a.json": { passes: [{ shader: "simple" }] },
      },
      assetFiles,
    ),
    translator: null,
    postprocess: "disabled",
    exhaustive: true,
    ...(structure ? { structure } : {}),
  });
}

const created = (...items: [number, unknown][]): SceneStructure => ({
  destroyed: [],
  parents: [],
  created: items.map(([object, config]) => ({ object, config: JSON.stringify(config) })),
});

describe("collectObjectScripts（点 11）", () => {
  const rich = () =>
    image({
      id: 5,
      alpha: { script: script(), value: 1 },
      origin: { script: script(" // o"), value: "0 0 0" },
      effects: [{ file: "effects/e.json", visible: { script: script(" // e"), value: true } }],
    });

  it("与 collectScripts 对同一个对象的结果逐项相同（键序、属主、写回目标）", async () => {
    const scene = { general: {}, objects: [image({ id: 1 }), rich(), image({ id: 6 })] } as unknown as SceneJson;
    const all = await collectScripts(scene, {}, []);
    const only = all.list.filter((item) => item.layer === 1);
    expect(only.length).toBe(3);
    expect(await collectObjectScripts(scene.objects[1], 1, {})).toEqual(only);
  });

  it("新下标：路径与属主都是 objects/<新下标>", async () => {
    const list = await collectObjectScripts(rich(), 9, {});
    expect(list.map((item) => item.id)).toEqual(["objects/9/alpha", "objects/9/origin", "objects/9/effects/0/visible"]);
    expect(list.every((item) => item.layer === 9)).toBe(true);
    expect(list[0].owner).toEqual({ kind: "layer", object: 9 });
    expect(list[2].owner).toEqual({ kind: "effect", object: 9, effect: 0 });
    expect(list[0].target).toEqual({ kind: "layer", object: 9, field: "alpha" });
  });

  it("没有脚本、不是对象：空；绑定表按需登记", async () => {
    expect(await collectObjectScripts(image({}), 3, {})).toEqual([]);
    expect(await collectObjectScripts(null, 3, {})).toEqual([]);
    const bindings: never[] = [];
    await collectObjectScripts(
      image({ alpha: { script: script(), value: 1, scriptproperties: { k: { user: "p", value: 1 } } } }),
      4,
      {},
      bindings,
    );
    expect(bindings).toEqual([
      expect.objectContaining({
        property: "p",
        target: { kind: "script-property", script: "objects/4/alpha", key: "k" },
      }),
    ]);
  });
});

describe("scriptAssetCandidates（点 9 的 assets 名单）", () => {
  it("单 / 双引号与不含插值的模板字符串；只留资源目录开头的；去前导斜杠、去重、排序", () => {
    const source = [
      "const a = 'models/b.json'; const b = \"/models/a.json\"; const c = `sounds/x.mp3`;",
      "const d = `models/${name}.json`; const e = 'other/x.json'; const f = 'models/b.json';",
      `const g = 'fonts${BACKSLASH}${BACKSLASH}kb.ttf'; const h = '${BACKSLASH}${BACKSLASH}effects/e.json';`,
    ].join("\n");
    expect(scriptAssetCandidates([source])).toEqual([
      "effects/e.json",
      "fonts/kb.ttf",
      "models/a.json",
      "models/b.json",
      "sounds/x.mp3",
    ]);
  });

  it("八个目录前缀", () => {
    const names = ["models", "particles", "materials", "sounds", "fonts", "effects", "shaders", "textures"];
    expect(scriptAssetCandidates(names.map((name) => `'${name}/x'`))).toEqual(names.map((name) => `${name}/x`).sort());
    expect(scriptAssetCandidates(["'model/x'", "'models'", "'Models/x'"])).toEqual([]);
  });
});

describe("bundle.assetPaths", () => {
  it("只收在 assets 里存在的；项目散文件与不存在的都不收", async () => {
    const source = script(
      " const a = 'models/util/solidlayer.json'; const b = 'models/a.json'; const c = 'models/nothere.json'; const d = `particles/${x}.json`;",
    );
    const bundle = await compile([image({ id: 1, alpha: { script: source, value: 1 } })], undefined, {
      "models/util/solidlayer.json": { material: "materials/util/solid.json" },
      "models/a.json": { material: "x" },
    });
    // `models/a.json` 在项目里也有，但 assets 里也放了一份：只要 assets 里存在就收
    expect(bundle.assetPaths).toEqual(["models/a.json", "models/util/solidlayer.json"]);
    const onlyProject = await compile([image({ id: 1, alpha: { script: source, value: 1 } })], undefined, {
      "models/util/solidlayer.json": {},
    });
    expect(onlyProject.assetPaths).toEqual(["models/util/solidlayer.json"]);
  });

  it("新建对象配置里的脚本源码也扫；没有名单时不带这个键", async () => {
    const source = script(" const a = 'sounds/s.mp3';");
    const bundle = await compile([image({ id: 1 })], created([1, image({ alpha: { script: source, value: 1 } })]), {
      "sounds/s.mp3": {},
    });
    expect(bundle.assetPaths).toEqual(["sounds/s.mp3"]);
    expect(Object.hasOwn(await compile([image({ id: 1 })]), "assetPaths")).toBe(false);
  });
});

describe("compileScene：结构里的新建对象（点 12）", () => {
  const base = () => [image({ id: 1, name: "a" }), image({ id: 2, name: "b" })];

  it("新建对象进 bundle.layers、object 是新下标，configs 有它（键序与规整同加载时的对象）", async () => {
    const bundle = await compile(
      base(),
      created([2, image({ name: "N", origin: "1 2 3", id: 9, size: "10 20", alpha: 0.123456789 })]),
    );
    expect(bundle.layers.map((layer) => [layer.object, layer.name])).toEqual([
      [0, "a"],
      [1, "b"],
      [2, "N"],
    ]);
    expect(bundle.layers[2].origin).toEqual([1, 2, 3]);
    expect(bundle.layers[2].id).toBe(9);
    expect(bundle.configs?.[2]).toBe(
      '{"alpha":0.12345679,"image":"models/a.json","name":"N","origin":"1 2 3","size":"10 20"}',
    );
    expect(bundle.configs?.length).toBe(3);
    // 渲染侧画它：有 pass
    expect(bundle.layers[2].passes.length).toBeGreaterThan(0);
  });

  it("下标之间的空位补 null：不进 layers，configs 是 null", async () => {
    const bundle = await compile(base(), created([4, image({ name: "far" })]));
    expect(bundle.layers.map((layer) => layer.object)).toEqual([0, 1, 4]);
    expect(bundle.configs?.map((config) => config !== null)).toEqual([true, true, false, false, true]);
  });

  it("脚本、关键帧、属性绑定的路径都是新下标", async () => {
    const config = image({
      name: "N",
      alpha: { script: script(), value: 0.5 },
      brightness: { user: "p", value: 2 },
      scale: { animation: { c0: [{ frame: 0, value: 1 }], options: { fps: 30, length: 10 } }, value: "1 1 1" },
    });
    const bundle = await compile(base(), created([2, config]));
    expect(bundle.scripts.list.map((item) => item.id)).toEqual(["objects/2/alpha"]);
    expect(bundle.scripts.list[0].layer).toBe(2);
    expect(bundle.bindings.some((binding) => JSON.stringify(binding.target).includes('"object":2'))).toBe(true);
    expect(bundle.animations?.map((item) => item.owner)).toEqual(["objects/2"]);
  });

  it("建了又删的不编（configs 照留）", async () => {
    const config = image({ name: "N", alpha: { script: script(), value: 1 } });
    const structure = { ...created([2, config]), destroyed: [2] };
    const bundle = await compile(base(), structure);
    expect(bundle.layers.map((layer) => layer.object)).toEqual([0, 1]);
    expect(bundle.scripts.list).toEqual([]);
    expect(bundle.configs?.[2]).not.toBeNull();
  });

  it("配置是数组：编成分组节点（进 layers），configs 是数组原文", async () => {
    const bundle = await compile(base(), created([2, [1]]));
    expect(bundle.layers.map((layer) => layer.object)).toEqual([0, 1, 2]);
    expect(bundle.configs?.[2]).toBe("[1]");
  });

  it("新建对象可以挂到已有对象下（JSON 父是 id）", async () => {
    const bundle = await compile(base(), created([2, image({ name: "kid", parent: 1 })]));
    expect(bundle.layers[2].parent).toBe(0);
    expect(bundle.children).toEqual([[0, [2]]]);
  });

  it("依赖标记只看加载时的对象：新建对象的 dependencies 不给图层置被依赖", async () => {
    const withLoaded = await compile([image({ id: 1 }), image({ id: 2, dependencies: [1] })]);
    expect(withLoaded.layers[0].dependedOn).toBe(true);
    const withCreated = await compile([image({ id: 1 }), image({ id: 2 })], created([2, image({ dependencies: [1] })]));
    expect(withCreated.layers[0].dependedOn).toBeFalsy();
  });

  it("新建对象的 id 不进图层合成名字表（依赖只看加载时）", async () => {
    const bundle = await compile([image({ id: 1 })], created([1, image({ id: 7 })]));
    expect(bundle.layers.map((layer) => layer.object)).toEqual([0, 1]);
  });

  it("下标小于加载个数、配置不是 JSON 的项被忽略；没有新建对象时没有新键", async () => {
    const bundle = await compile(base(), {
      destroyed: [],
      parents: [],
      created: [
        { object: 1, config: JSON.stringify(image({ name: "clobber" })) },
        { object: 2, config: "{oops" },
      ],
    });
    expect(bundle.layers.map((layer) => layer.name)).toEqual(["a", "b"]);
    expect(Object.hasOwn(bundle, "assetPaths")).toBe(false);
  });
});
