/**
 * P6c：光标交互的编译期部分——参与命中的对象类别（`cursorPickKind`）、图层的 `solid` / `disablepropagation`、`solid` 的用户属性绑定与字段脚本、
 * 能力表（`cursor:model`、`object:disablepropagation`）。命中与派发本身见 `render/cursor.test.ts`。
 */
import { describe, expect, it, vi } from "vitest";
import { SceneState } from "../render/state";
import { compileScene } from "./bundle";
import { checkObjectFeatures, checkScriptFeatures, cursorPickKind } from "./features";
import type { SceneReader } from "./fs";
import type { SceneJson, SceneObject } from "./model";
import { collectScripts, type SceneScript } from "./scripts";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

const reader = (files: Record<string, string>): SceneReader => {
  const bytes = (path: string) => {
    const text = files[path.replace(/\\/g, "/")];
    if (text === undefined) throw new TypeError("Failed to fetch");
    return new TextEncoder().encode(text);
  };
  return {
    readWhole: async (path) => bytes(path),
    readRange: async (path, start, end) => bytes(path).slice(start, end),
  };
};

/** 只有分组节点的场景（不用着色器与纹理）：编译得到的图层带光标字段。 */
async function compile(objects: object[], userProperties: Record<string, unknown> = {}) {
  return compileScene({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    reader: reader({
      "P:/p/project.json": JSON.stringify({ file: "scene.json" }),
      "P:/p/scene.json": JSON.stringify({ general: { orthogonalprojection: { width: 64, height: 32 } }, objects }),
    }),
    translator: null,
    postprocess: "disabled",
    exhaustive: true,
    userProperties,
  });
}

describe("cursorPickKind：哪些对象参与命中（rea-p6c-dispatch 3.2）", () => {
  it("图像层与文本层参与；模型、粒子、声音、灯、相机、形状与分组节点不参与", () => {
    expect(cursorPickKind({ id: 1, image: "models/a.json" })).toBe("image");
    expect(cursorPickKind({ id: 2, text: { value: "a" } } as SceneObject)).toBe("text");
    // 空文字的文本层也是文本对象（WPE 只看键在不在）
    expect(cursorPickKind({ id: 3, text: "" } as SceneObject)).toBe("text");
    for (const object of [
      { id: 4, model: "models/m.mdl" },
      { id: 5, particle: "particles/p.json" },
      { id: 6, sound: ["a.mp3"] },
      { id: 7, light: "point" },
      { id: 8, camera: "default" },
      { id: 9, shape: "quad" },
      { id: 10, name: "group" },
    ] as SceneObject[])
      expect(cursorPickKind(object), JSON.stringify(object)).toBeUndefined();
  });
});

describe("编译：solid / disablepropagation 进图层，缺省不占字段", () => {
  it("缺省：solid 真、disablepropagation 假，图层上没有这两个字段；写了才有", async () => {
    const bundle = await compile([
      { id: 1, name: "plain" },
      { id: 2, name: "off", solid: false, disablepropagation: true },
      { id: 3, name: "on", solid: true, disablepropagation: false },
    ]);
    expect(bundle.unsupported).toEqual([]);
    const [plain, off, on] = bundle.layers;
    expect("solid" in plain).toBe(false);
    expect("disablePropagation" in plain).toBe(false);
    expect(off.solid).toBe(false);
    expect(off.disablePropagation).toBe(true);
    expect("solid" in on).toBe(false);
    expect("disablePropagation" in on).toBe(false);
  });

  it("SceneState：LayerState.solid 取编译期的值，缺省真", async () => {
    const bundle = await compile([
      { id: 1, name: "plain" },
      { id: 2, name: "off", solid: false },
    ]);
    const state = SceneState.fromBundle(bundle);
    expect(state.layers.get(0)!.solid).toBe(true);
    expect(state.layers.get(1)!.solid).toBe(false);
  });

  it("solid 绑用户属性：编译取当前值并登记就地目标；运行中改属性只改状态、不标脏、不重编译", async () => {
    const objects = [{ id: 1, name: "bound", solid: { user: "clickable", value: true } }];
    const off = await compile(objects, { clickable: false });
    expect(off.layers[0].solid).toBe(false);
    const bundle = await compile(objects, { clickable: true });
    expect(bundle.layers[0].solid).toBeUndefined();
    const binding = bundle.bindings.find((item) => item.property === "clickable");
    expect(binding?.target).toEqual({ kind: "layer", object: 0, field: "solid" });
    const state = SceneState.fromBundle(bundle);
    state.takeDirty();
    expect(state.write(binding!, false)).toBe("applied");
    expect(state.layers.get(0)!.solid).toBe(false);
    expect(state.takeDirty().layers.size).toBe(0);
    state.write(binding!, true);
    expect(state.layers.get(0)!.solid).toBe(true);
    // 带 condition 的绑定：值换成布尔再写
    state.write({ property: "mode", condition: "1", target: binding!.target }, "1");
    expect(state.layers.get(0)!.solid).toBe(true);
    state.write({ property: "mode", condition: "1", target: binding!.target }, "2");
    expect(state.layers.get(0)!.solid).toBe(false);
  });

  it("solid 上的字段脚本写回到图层的 solid（布尔）", async () => {
    const scene = {
      objects: [{ id: 1, name: "s", solid: { script: "export function update(v) { return !v; }", value: true } }],
    } as unknown as SceneJson;
    const { list } = await collectScripts(scene, {}, []);
    expect(list).toHaveLength(1);
    expect(list[0].target).toEqual({ kind: "layer", object: 0, field: "solid" });
    expect(list[0].valueType).toBe("bool");
  });

  it("属性侧写进状态的 solid 照 visible 的规则：只有 false 才关", async () => {
    const bundle = await compile([{ id: 1, name: "bound", solid: { user: "p", value: true } }]);
    const state = SceneState.fromBundle(bundle);
    const target = bundle.bindings.find((item) => item.property === "p")!;
    state.write(target, 0);
    expect(state.layers.get(0)!.solid).toBe(true);
    state.write(target, false);
    expect(state.layers.get(0)!.solid).toBe(false);
  });
});

describe("能力表：cursor:model 与 disablepropagation", () => {
  const keys = (object: SceneObject) => {
    const out = new Set<string>();
    checkObjectFeatures(object, out);
    return [...out].sort();
  };
  const script = (layer: number, source: string): SceneScript => ({
    id: `objects/${layer}/origin`,
    source,
    target: { kind: "layer", object: layer, field: "origin" },
    valueType: "vec3",
    initial: "0 0 0",
    owner: { kind: "layer", object: layer },
    layer,
    scriptProperties: null,
    imports: [],
    errors: [],
  });

  it("disablepropagation 只认 JSON 布尔：布尔中性（图像层、分组节点等任何对象），绑属性、挂脚本照报", () => {
    expect(keys({ id: 1, image: "models/i.json", disablepropagation: true })).toEqual([]);
    expect(keys({ id: 1, name: "group", disablepropagation: true })).toEqual([]);
    expect(keys({ id: 1, image: "models/i.json", disablepropagation: { user: "p", value: true } })).toEqual([
      "object:disablepropagation",
    ]);
    expect(keys({ id: 1, image: "models/i.json", disablepropagation: { script: "export {}", value: true } })).toEqual([
      "object:disablepropagation",
    ]);
  });

  it("模型对象上导出光标回调的脚本报 cursor:model；图像层、只导出 update 的模型脚本不报；cursorHitTest 也算", () => {
    const objects = [
      { id: 1, model: "models/m.mdl" },
      { id: 2, image: "models/i.json" },
    ] as SceneObject[];
    const check = (scripts: SceneScript[]) => {
      const out = new Set<string>();
      checkScriptFeatures(scripts, out, objects);
      return [...out].sort();
    };
    expect(check([script(0, "export function cursorClick(e) {}")])).toEqual(["cursor:model"]);
    expect(check([script(0, "export function cursorHitTest() { return true; }")])).toEqual(["cursor:model"]);
    expect(check([script(0, "export function update(v) { return v; }")])).toEqual([]);
    expect(check([script(1, "export function cursorClick(e) {}")])).toEqual([]);
    // 没给对象表（旧调用）：不判
    const out = new Set<string>();
    checkScriptFeatures([script(0, "export function cursorClick(e) {}")], out);
    expect([...out]).toEqual([]);
  });
});
