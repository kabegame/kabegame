/**
 * P4e 步骤 1：子系统进 bundle（`compileScene` 的 `compileParticleSystem`，rea-p4e-children 第 1 节）。内存工程 + 假翻译器：
 * 条目递归编进 `SceneParticle.children`、稳定键、深度上限、能力表（事件类报 `particle:children:<type>`、读不到的子系统文件）、
 * 子系统不登记 `instanceoverride` 绑定，以及 mode 0 的音频字段不再挡场景。
 */
import { describe, expect, it, vi } from "vitest";
import { compileScene, type SceneBundle } from "./bundle";
import type { SceneReader } from "./fs";
import type { SceneParticle } from "./particles";
import type { TranslateResult, Wpesl2wgsl } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

function memoryReader(files: Record<string, unknown>): SceneReader {
  const reader: SceneReader = {
    async readWhole(path) {
      const value = files[path.replace(/\\/g, "/")];
      if (value === undefined) throw new TypeError("Failed to fetch");
      if (value instanceof Uint8Array) return value;
      return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
    },
    async readRange(path, start, end) {
      return (await reader.readWhole(path)).slice(start, end);
    },
  };
  return reader;
}

const translator = {
  async translate(): Promise<TranslateResult> {
    return { ok: true, uniforms: [], textures: [], combos: [] } as TranslateResult;
  },
} as unknown as Wpesl2wgsl;

const ORTHO = { orthogonalprojection: { width: 1920, height: 1080 } };
const system = (extra: Record<string, unknown> = {}) => ({
  material: "materials/pm.json",
  maxcount: 4,
  emitter: [{ name: "sphererandom", rate: 1 }],
  ...extra,
});

function files(particles: Record<string, unknown>, object: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    "P:/p/project.json": { file: "scene.json", general: { properties: { c: { type: "slider", value: 2 } } } },
    "P:/p/scene.json": { general: ORTHO, objects: [{ id: 1, particle: "particles/p.json", ...object }] },
    "P:/p/materials/pm.json": { passes: [{ shader: "genericparticle" }] },
    "P:/p/shaders/genericparticle.vert": "void main(){}",
    "P:/p/shaders/genericparticle.frag": "void main(){}",
  };
  for (const [name, json] of Object.entries(particles)) out[`P:/p/${name}`] = json;
  return out;
}

const compile = (reader: SceneReader): Promise<SceneBundle> =>
  compileScene({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    reader,
    translator,
    postprocess: "disabled",
    exhaustive: true,
  });

const keys = (particle: SceneParticle): string[] => [
  ...particle.passes.map((pass) => pass.key),
  ...particle.children.flatMap((child) => keys(child.system)),
];

describe("compileScene：子系统进 bundle（P4e 步骤 1）", () => {
  it("static 条目递归编进 children，稳定键按 JSON 下标（丢掉的条目不移位），事件类也编进来并报 particle:children:<type>", async () => {
    const bundle = await compile(
      memoryReader(
        files({
          "particles/p.json": system({
            children: [
              { name: "particles/c.json", type: "Static" },
              { name: "particles/c.json", origin: "60 0 0", angles: "0 0 -50", scale: "2" },
              { name: "particles/c.json", type: "eventfollow", maxcount: 3, probability: 0.5 },
            ],
          }),
          "particles/c.json": system({ flags: 1, children: [{ name: "particles/g.json" }] }),
          "particles/g.json": system(),
        }),
      ),
    );
    expect(bundle.unsupported).toEqual(["particle:children:eventfollow"]);
    const particle = bundle.layers[0].particle!;
    expect(particle.children.map((child) => [child.type, child.system.file])).toEqual([
      ["static", "particles/c.json"],
      ["eventfollow", "particles/c.json"],
    ]);
    expect(particle.children[0].local.slice(12, 15)).toEqual([60, 0, 0]);
    // `scale "2"`：y、z 列缺分量补 0（`+ 0` 把 −0 换成 +0）
    expect(particle.children[0].local.slice(4, 11).map((value) => value + 0)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(particle.children[1]).toMatchObject({ maxcount: 3, probability: 0.5 });
    expect(keys(particle)).toEqual([
      "objects/0/particle/passes/0",
      "objects/0/particle/children/1/passes/0",
      "objects/0/particle/children/1/children/0/passes/0",
      "objects/0/particle/children/2/passes/0",
      "objects/0/particle/children/2/children/0/passes/0",
    ]);
  });

  it("深度上限：自引用的文件编到第 10 层停（11 个系统），第 10 层的 children 不读", async () => {
    const bundle = await compile(
      memoryReader(
        files({
          "particles/p.json": system({ children: [{ name: "particles/p.json", origin: "10 0 0" }] }),
        }),
      ),
    );
    expect(bundle.unsupported).toEqual([]);
    let depth = 0;
    for (let node = bundle.layers[0].particle!; node.children.length; node = node.children[0].system) depth++;
    expect(depth).toBe(10);
  });

  it("读不到的子系统文件报 particle:missing:<name>，坏 JSON 报 particle:parse:<name>；name 缺失报 particle:child:name", async () => {
    const bundle = await compile(
      memoryReader(
        files({
          "particles/p.json": system({
            children: [{ name: "particles/none.json" }, { name: "particles/bad.json" }, { type: "static" }],
          }),
          "particles/bad.json": "[1, 2]",
        }),
      ),
    );
    expect(bundle.unsupported).toEqual([
      "particle:child:name",
      "particle:missing:particles/none.json",
      "particle:parse:particles/bad.json",
    ]);
    expect(bundle.layers[0].particle!.children).toEqual([]);
  });

  it("子系统 JSON 照顶层同样检查；mode 0 的音频字段不报，非 0 照报", async () => {
    const audio = (mode: number) =>
      compile(
        memoryReader(
          files({
            "particles/p.json": system({ children: [{ name: "particles/c.json" }] }),
            "particles/c.json": system({
              emitter: [{ name: "sphererandom", audioprocessingmode: mode, audioprocessingbounds: "0 1" }],
              operator: [{ name: "turbulence", audioprocessingmode: 0 }],
            }),
          }),
        ),
      );
    expect((await audio(0)).unsupported).toEqual([]);
    expect((await audio(3)).unsupported).toEqual(["particle:emitter:sphererandom:audioprocessingmode"]);
  });

  it("instanceoverride：只有顶层登记绑定，子系统按缺省值解析（实例值由模拟器从对象上传）", async () => {
    const bundle = await compile(
      memoryReader(
        files(
          {
            "particles/p.json": system({ children: [{ name: "particles/c.json" }] }),
            "particles/c.json": system(),
          },
          { instanceoverride: { count: { user: "c", value: 2 } } },
        ),
      ),
    );
    const instanceBindings = bundle.bindings.filter((binding) => binding.target.kind === "particle-instance");
    expect(instanceBindings).toHaveLength(1);
    const particle = bundle.layers[0].particle!;
    expect(particle.instance.count).toBe(2);
    expect(particle.children[0].system.instance.count).toBe(1);
  });
});
