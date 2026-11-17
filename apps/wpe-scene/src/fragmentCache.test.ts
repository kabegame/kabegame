/**
 * 活的场景图 L5 点 2：片段缓存（`fragmentCache.ts`）。键去 `id`、规整；`seed` 只收无损（`exactConfigs`）且没有 blocker 的对象，同键先到先得；
 * 带「按属性整场重编译」绑定的片段在属性变了时作废。换场景时清空由宿主换掉整个实例（`LiveObjects.dispose`，`script/createLayerChange.test.ts`）。
 */
import { describe, expect, it, vi } from "vitest";
import { compileScene, type SceneBundle } from "./compile/bundle";
import { normalizeConfig } from "./compile/config";
import type { ObjectFragment } from "./compile/fragment";
import { FragmentCache, fragmentKey } from "./fragmentCache";
import type { Wpesl2wgsl } from "./wpesl2wgsl";

vi.mock("./fileUrl", () => ({ fileToUrl: (path: string) => path }));

const OBJECTS: Record<string, unknown>[] = [
  { id: 10, name: "a", image: "models/a.json", origin: "1 2 0" },
  { id: 11, name: "b", image: "models/a.json", origin: "3 4 0" },
  { id: 12, name: "c", image: "models/a.json", origin: "5 6 0" },
  // 3：和 0 规整后相同（只有 id 不同）
  { id: 13, name: "a", image: "models/a.json", origin: "1 2 0" },
];
const files: Record<string, unknown> = {
  "P:/p/project.json": { file: "scene.json", general: { properties: {} } },
  "P:/p/scene.json": { general: { orthogonalprojection: { width: 1920, height: 1080 } }, objects: OBJECTS },
  "P:/p/models/a.json": { material: "materials/a.json", width: 4, height: 4 },
  "P:/p/materials/a.json": { passes: [{ shader: "base" }] },
  "P:/p/shaders/base.vert": "// base",
  "P:/p/shaders/base.frag": "// base",
};
function bytesOf(path: string): Uint8Array {
  const value = files[path.replace(/\\/g, "/")];
  if (value === undefined) throw new TypeError("Failed to fetch");
  return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
}
const translator = {
  memoryBytes: 1,
  async translate() {
    return { ok: true, uniforms: [], textures: [], combos: [], attributes: [] };
  },
} as unknown as Wpesl2wgsl;

function compile(): Promise<SceneBundle> {
  return compileScene({
    projectDir: "P:/p",
    sceneAssets: [],
    reader: {
      readWhole: async (path) => bytesOf(path),
      readRange: async (path, start, end) => bytesOf(path).slice(start, end),
    },
    translator,
    postprocess: "disabled",
    reflection: "disabled",
    force: true,
    exhaustive: true,
  });
}

describe("fragmentKey", () => {
  it("去顶层 id、键排序、非整数 8 位有效数字：和 normalizeConfig 一致；id 不同、键序不同的配置同键", () => {
    const a = fragmentKey(JSON.stringify({ id: 4, name: "x", alpha: 0.123456789123, origin: "1 2 0" }));
    const b = fragmentKey(JSON.stringify({ origin: "1 2 0", alpha: 0.123456789, name: "x", id: 99 }));
    expect(a).toBe(normalizeConfig({ name: "x", alpha: 0.123456789123, origin: "1 2 0" }));
    expect(a).toBe(b);
    expect(a).not.toContain('"id"');
  });

  it("数组配置（分组节点）、不是 JSON、不是对象：null", () => {
    expect(fragmentKey("[]")).toBeNull();
    expect(fragmentKey("{")).toBeNull();
    expect(fragmentKey("3")).toBeNull();
    expect(fragmentKey("null")).toBeNull();
  });
});

describe("FragmentCache", () => {
  it("seed：只收 exact 里的、没有 blocker 的；键是 bundle 的规整配置；同键先到先得", async () => {
    const bundle = await compile();
    // 对象 2 被依赖（blocker：depended），不收
    bundle.layers.find((layer) => layer.object === 2)!.dependedOn = true;
    const cache = new FragmentCache();
    // 1 不在 exact 里（有损）；0 与 3 同键，先到的 0 留下
    expect(cache.seed(bundle, [3, 0, 2])).toBe(1);
    expect(cache.size).toBe(1);
    const hit = cache.get(bundle.configs![0]!)!;
    expect(hit.object).toBe(0);
    expect(hit.config).toBe(bundle.configs![0]);
    expect(cache.get(bundle.configs![1]!)).toBeUndefined();
    expect(cache.get(bundle.configs![2]!)).toBeUndefined();
    // 配置原文（带新 id）算出的键命中同一份
    expect(cache.get(fragmentKey(JSON.stringify({ ...OBJECTS[0], id: 77 }))!)).toBe(hit);
    // 不预置不改 bundle
    expect(bundle.layers).toHaveLength(4);
  });

  it("put：同键已有时保留旧的；has / get / clear", () => {
    const cache = new FragmentCache();
    const first = { object: 1, bindings: [] } as unknown as ObjectFragment;
    const second = { object: 2, bindings: [] } as unknown as ObjectFragment;
    cache.put("k", first);
    cache.put("k", second);
    expect(cache.get("k")).toBe(first);
    expect(cache.has("k")).toBe(true);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("dropBoundTo：只摘带这些属性的 recompile 绑定的片段", () => {
    const cache = new FragmentCache();
    const bound = (property: string, kind: "recompile" | "layer") =>
      ({
        object: 1,
        bindings: [
          {
            property,
            target:
              kind === "recompile"
                ? { kind, reason: "layer-structure", path: "objects/1/size" }
                : { kind, object: 1, field: "alpha" },
          },
        ],
      }) as unknown as ObjectFragment;
    cache.put("size-p", bound("p", "recompile"));
    cache.put("alpha-p", bound("p", "layer"));
    cache.put("size-q", bound("q", "recompile"));
    expect(cache.dropBoundTo(["p"])).toBe(1);
    expect([cache.has("size-p"), cache.has("alpha-p"), cache.has("size-q")]).toEqual([false, true, true]);
    expect(cache.dropBoundTo([])).toBe(0);
  });
});
