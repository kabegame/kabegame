import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { compileScene } from "./bundle";
import { checkScriptFeatures } from "./features";
import { SceneFs, type SceneReader } from "./fs";
import { parseProject, parseScene } from "./model";
import { MISSING_SCRIPT_API, memberAccesses, scanScriptApi, type ScriptApiContext } from "./scriptApi";
import { collectScripts, type SceneScript } from "./scripts";
import { Wpesl2wgsl } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

/** 挂在 objects/0 上的脚本；`owner` 默认是图层本身。 */
function scan(source: string, owner: ScriptApiContext["owner"] = { kind: "layer" }, layer: number | null = 0) {
  return scanScriptApi({ source, owner, layer });
}

describe("未实现脚本 API 的扫描", () => {
  it('根对象成员：thisScene / engine / input，含可选链与 ["成员"]', () => {
    expect(scan("export function init() { let bar = thisScene.createLayer('models/bar.json'); }")).toEqual([
      "thisScene.createLayer",
    ]);
    expect(scan("export function init() { thisScene?.sortLayer(x, 1); thisScene['destroyLayer'](x); }")).toEqual([
      "thisScene.destroyLayer",
      "thisScene.sortLayer",
    ]);
    expect(scan("const asset = engine.registerAsset('materials/x.json', true);")).toEqual(["engine.registerAsset"]);
    expect(scan("export function update() { return input.cursorWorldPosition.x + input?.cursorLeftDown; }")).toEqual([
      "input.cursorLeftDown",
      "input.cursorWorldPosition",
    ]);
    // 场景字段（L1）只认 thisScene
    expect(scan("export function update() { thisScene.zoom = 2; }")).toEqual(["thisScene.zoom"]);
  });

  it("根对象的成员只认裸全局名：属性链上的同名对象不算", () => {
    expect(scan("shared.thisScene.createLayer(); foo.engine.registerAsset('a'); my.input.cursorLeftDown;")).toEqual([]);
  });

  it("图层的独特方法名：任意接收者都算", () => {
    const source = [
      "export function init() {",
      "  let bar = thisScene.getLayer('bar');",
      "  let parent = bar.getParent();",
      "  layers[0].getTextureAnimation().play();",
      "  thisScene.getLayer(1)?.getEffect('tint').visible = false;",
      "  shared.target.getAnimation('a').play();",
      "}",
    ].join("\n");
    expect(scan(source)).toEqual([
      "layer.getEffect",
      "layer.getParent",
      "layer.getTextureAnimation",
      "object.getAnimation",
    ]);
    // thisScene 自己的 getAnimation 另算一个键
    expect(scan("thisScene.getAnimation('x');")).toEqual(["thisScene.getAnimation"]);
  });

  it("通用名不按名字收：play / stop / copy / text / lookAt 只认 thisLayer / thisObject", () => {
    const source = [
      "export function update() {",
      "  sound.play(); anim.stop(); song.isPlaying(); v.copy();",
      "  label.text = 'x'; bar.alignment = 'center';",
      "  let m = Mat4.lookAt(eye, center, up);",
      "  return value;",
      "}",
    ].join("\n");
    expect(scan(source)).toEqual([]);
    expect(scan("export function init() { thisLayer.play(); thisObject.text = 'a'; thisLayer.lookAt(p); }")).toEqual([
      "layer.lookAt",
      "layer.play",
      "layer.text",
    ]);
  });

  it("注释、字符串、模板文字与正则里的不算；模板插值照常扫", () => {
    const source = [
      "// thisScene.createLayer('a');",
      "/* bar.getParent(); engine.registerAsset('x'); */",
      "const a = 'thisScene.createLayer()';",
      'const b = "layer.getTextureAnimation()";',
      "const c = `input.cursorWorldPosition ${'}'} and ${`thisScene.sortLayer`}`;",
      "const d = /x.getParent\\/()/g.test(s) ? 1 : 2;",
      "const e = n / 2 / thisLayer.origin.x;",
      "export function update() { return value; }",
    ].join("\n");
    expect(scan(source)).toEqual([]);
    expect(scan("const s = `${bar.getParent().name} / ${`${thisScene.createLayer('a')}`}`;")).toEqual([
      "layer.getParent",
      "thisScene.createLayer",
    ]);
    // 除号之后不是正则：后面的调用照常扫到
    expect(scan("const k = width / 2; const p = bar.getChildren(); const q = (a) / b.getChildren();")).toEqual([
      "layer.getChildren",
    ]);
  });

  it("已实现的不报", () => {
    const source = [
      "'use strict';",
      "import * as WEMath from 'WEMath';",
      "let audio = engine.registerAudioBuffers(engine.AUDIO_RESOLUTION_64);",
      "export function init() {",
      "  let layer = thisScene.getLayer('a');",
      "  let n = thisScene.getLayerCount() + thisScene.enumerateLayers().length + thisScene.getLayerIndex(layer);",
      "  engine.setTimeout(() => {}, 100); engine.setInterval(() => {}, 100);",
      "  localStorage.set('k', 1); localStorage.get('k'); localStorage.delete('k'); localStorage.clear();",
      "  console.log(engine.frametime, engine.runtime, engine.timeOfDay, engine.canvasSize, engine.screenResolution);",
      "  console.error(engine.userProperties, engine.isPortrait(), engine.isObjectValid(layer));",
      "  thisScene.bloom = true; thisScene.bloomstrength = 2; thisScene.clearcolor = new Vec3(1);",
      "  thisLayer.origin = layer.origin; thisLayer.alpha = thisObject.visible ? 1 : 0;",
      "  return thisLayer.size.x + thisLayer.name.length;",
      "}",
    ].join("\n");
    expect(scan(source)).toEqual([]);
  });

  it("thisObject 按脚本挂在哪里解析", () => {
    // effect：IEffect 的方法
    expect(scan("thisObject.getMaterial(0); thisObject.name;", { kind: "effect" })).toEqual([
      "effect.getMaterial",
      "effect.name",
    ]);
    // 材质常量：成员是 pass 的材质常量，同名的图层字段不报；IObject 的 getAnimation 照报
    expect(scan("thisObject.text = 1; thisObject.speed = 2; thisObject.getAnimation();", { kind: "material" })).toEqual(
      ["object.getAnimation"],
    );
    // general：thisObject / thisLayer 都是场景字段对象，只有字段没有方法（L14）
    expect(
      scan("thisObject.zoom = 1; thisLayer.windstrength; thisObject.createLayer('a');", { kind: "general" }, null),
    ).toEqual(["thisScene.windstrength", "thisScene.zoom"]);
    // 材质 / effect 上的脚本，thisLayer 是所在图层
    expect(scan("thisLayer.text = 'a';", { kind: "material" }, 2)).toEqual(["layer.text"]);
  });

  it('成员访问的词法：可选链、["成员"]、数组字面量与条件运算', () => {
    expect(memberAccesses("a?.b; c['d']; e?.['f']; [\"g\"]; x = ['h']; t ? .5 : 1; return ['i'];")).toEqual([
      { root: "a", name: "b" },
      { root: "c", name: "d" },
      { root: "e", name: "f" },
    ]);
    // 非 ASCII 标识符、不换行空格与 BOM 照常切词
    const nbsp = String.fromCharCode(0xa0);
    const bom = String.fromCharCode(0xfeff);
    expect(memberAccesses(`${bom}let 条 = thisScene.getLayer(1);${nbsp}条.getParent();`)).toEqual([
      { root: "thisScene", name: "getLayer" },
      { root: "条", name: "getParent" },
    ]);
    expect(memberAccesses("a.b.c; f().g; x[0].h")).toEqual([
      { root: "a", name: "b" },
      { root: null, name: "c" },
      { root: null, name: "g" },
      { root: null, name: "h" },
    ]);
  });

  it("每个按名字匹配的表项都写了理由", () => {
    for (const entries of Object.values(MISSING_SCRIPT_API))
      for (const entry of entries) if (entry.match === "any") expect(entry.why, entry.name).toBeTruthy();
  });
});

describe("能力表：script:api:*", () => {
  const script = (source: string, errors: string[] = []): SceneScript => ({
    id: "objects/0/visible",
    source,
    target: { kind: "layer", object: 0, field: "visible" },
    valueType: "bool",
    initial: true,
    owner: { kind: "layer", object: 0 },
    layer: 0,
    scriptProperties: null,
    imports: [],
    errors,
  });

  it("报 script:api:<分组>.<成员>；导入说明符无效、不会执行的脚本不扫", () => {
    const unsupported = new Set<string>();
    checkScriptFeatures(
      [
        script("export function init() { thisScene.createLayer('a'); }"),
        script("export function init() { engine.registerAsset('b'); }", ["不支持的模块说明符：./x.js"]),
      ],
      unsupported,
    );
    expect([...unsupported]).toEqual(["script:api:thisScene.createLayer"]);
  });

  it("编译：用到未实现 API 的场景整张退回，只用已实现 API 的照常", async () => {
    const files = (source: string): Record<string, string> => ({
      "P:/p/project.json": JSON.stringify({ file: "scene.json" }),
      "P:/p/scene.json": JSON.stringify({
        general: { orthogonalprojection: { width: 64, height: 32 } },
        objects: [{ id: 1, name: "group", visible: { script: source, value: true } }],
      }),
    });
    const reader = (map: Record<string, string>): SceneReader => {
      const bytes = (path: string) => {
        const text = map[path.replace(/\\/g, "/")];
        if (text === undefined) throw new TypeError("Failed to fetch");
        return new TextEncoder().encode(text);
      };
      return {
        readWhole: async (path) => bytes(path),
        readRange: async (path, start, end) => bytes(path).slice(start, end),
      };
    };
    const compile = (source: string) =>
      compileScene({
        projectDir: "P:/p",
        sceneAssets: ["A:/assets"],
        reader: reader(files(source)),
        translator: null,
        postprocess: "disabled",
        exhaustive: true,
      });
    const blocked = await compile("export function init() { let bar = thisScene.createLayer('models/bar.json'); }");
    expect(blocked.unsupported).toEqual(["script:api:thisScene.createLayer"]);
    expect(blocked.scripts.list).toHaveLength(1);
    const fine = await compile("export function update() { return thisScene.getLayer(0).visible; }");
    expect(fine.unsupported).toEqual([]);
  });
});

const root = process.env.KABEGAME_WPE_ROOT;
const wasm = join(__dirname, "..", "wpesl2wgsl", "wpesl2wgsl.wasm");
const nodeReader: SceneReader = {
  async readWhole(path) {
    try {
      return new Uint8Array(readFileSync(path));
    } catch {
      throw new TypeError("Failed to fetch");
    }
  },
  async readRange(path, start, end) {
    try {
      return new Uint8Array(readFileSync(path).subarray(start, end));
    } catch {
      throw new TypeError("Failed to fetch");
    }
  },
};

describe.skipIf(!root)("本机：未实现脚本 API", () => {
  const sample = root ? join(root, "..", "..", "workshop", "content", "431960", "3304642534") : "";

  it.skipIf(!root || !existsSync(sample))("3304642534 的音频条脚本报 createLayer / sortLayer", async () => {
    const fs = new SceneFs(sample, [join(root!, "assets")], nodeReader);
    const project = parseProject((await fs.text("project.json"))!);
    const scene = parseScene((await fs.text(project.file))!);
    const { list } = await collectScripts(scene, {}, []);
    expect(list.map((item) => item.id)).toEqual(["objects/1/visible"]);
    const unsupported = new Set<string>();
    checkScriptFeatures(list, unsupported);
    expect([...unsupported].sort()).toEqual(["script:api:thisScene.createLayer", "script:api:thisScene.sortLayer"]);
  });

  it.skipIf(!root || !existsSync(sample) || !existsSync(wasm))(
    "3304642534 整场只剩这两项（加入前能渲染）",
    async () => {
      const bundle = await compileScene({
        projectDir: sample,
        sceneAssets: [join(root!, "assets")],
        reader: nodeReader,
        translator: await Wpesl2wgsl.fromBytes(readFileSync(wasm)),
        postprocess: "ultra",
        exhaustive: true,
      });
      expect(bundle.unsupported).toEqual(["script:api:thisScene.createLayer", "script:api:thisScene.sortLayer"]);
    },
    120000,
  );

  it("表里的名字都出自 WPE 的补全声明，或逆向报告（requestFeatures、L1 的场景字段）", () => {
    const declarations = join(root!, "ui", "dist", "monaco", "autocomplete", "lib.sceneScript.d.ts");
    if (!existsSync(declarations)) return;
    const text = readFileSync(declarations, "utf8");
    const reportOnly = new Set([
      "requestFeatures",
      ...MISSING_SCRIPT_API.thisScene.filter((entry) => entry.kind === "field").map((entry) => entry.name),
    ]);
    for (const entries of Object.values(MISSING_SCRIPT_API))
      for (const { name } of entries)
        if (!reportOnly.has(name)) expect(new RegExp(`^\\s+${name}\\??\\s*[:(]`, "m").test(text), name).toBe(true);
  });
});
