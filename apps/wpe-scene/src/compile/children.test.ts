/**
 * P4e 步骤 1：子系统进 bundle（`compileScene` 的 `compileParticleSystem`，rea-p4e-children 第 1 节）。内存工程 + 假翻译器：
 * 条目递归编进 `SceneParticle.children`、稳定键、深度上限、能力表（事件类从 P4e 步骤 3 起都不报、读不到的子系统文件）、
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
  it("static 条目递归编进 children，稳定键按 JSON 下标（丢掉的条目不移位），事件类也编进来；三种事件类型都不报（P4e 步骤 2、3）", async () => {
    const bundle = await compile(
      memoryReader(
        files({
          "particles/p.json": system({
            children: [
              { name: "particles/c.json", type: "Static" },
              { name: "particles/c.json", origin: "60 0 0", angles: "0 0 -50", scale: "2" },
              { name: "particles/c.json", type: "eventfollow", maxcount: 3, probability: 0.5 },
              { name: "particles/g.json", type: "eventdeath" },
            ],
          }),
          "particles/c.json": system({ flags: 1, children: [{ name: "particles/g.json" }] }),
          "particles/g.json": system(),
        }),
      ),
    );
    expect(bundle.unsupported).toEqual([]);
    const particle = bundle.layers[0].particle!;
    expect(particle.children.map((child) => [child.type, child.system.file])).toEqual([
      ["static", "particles/c.json"],
      ["eventfollow", "particles/c.json"],
      ["eventdeath", "particles/g.json"],
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
      "objects/0/particle/children/3/passes/0",
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

  it("子系统 JSON 照顶层同样检查；音频字段任意 mode 都不报（P4e 步骤 4），bounds 形状不对照报", async () => {
    const audio = (mode: number, bounds: unknown = "0 1") =>
      compile(
        memoryReader(
          files({
            "particles/p.json": system({ children: [{ name: "particles/c.json" }] }),
            "particles/c.json": system({
              emitter: [{ name: "sphererandom", audioprocessingmode: mode, audioprocessingbounds: bounds }],
              operator: [{ name: "turbulence", audioprocessingmode: 0 }],
            }),
          }),
        ),
      );
    expect((await audio(0)).unsupported).toEqual([]);
    expect((await audio(3)).unsupported).toEqual([]);
    expect((await audio(3, true)).unsupported).toEqual(["particle:emitter:sphererandom:audioprocessingbounds"]);
  });

  it("「场景用音频」位（P4e 步骤 4）：project.json 的 supportsaudioprocessing 是 JSON true 且有 mode ≠ 0 的模块（含子系统）；scene.json 里的同名键中性", async () => {
    const usesAudio = async (flag: unknown, mode: number, sceneFlag = false) => {
      const project = files({
        "particles/p.json": system({ children: [{ name: "particles/c.json" }] }),
        "particles/c.json": system({ operator: [{ name: "vortex", audioprocessingmode: mode }] }),
      });
      const json = project["P:/p/project.json"] as { general: Record<string, unknown> };
      if (flag !== undefined) json.general.supportsaudioprocessing = flag;
      if (sceneFlag)
        (project["P:/p/scene.json"] as { general: Record<string, unknown> }).general.supportsaudioprocessing = true;
      const bundle = await compile(memoryReader(project));
      expect(bundle.unsupported).toEqual([]);
      return bundle.audio;
    };
    expect(await usesAudio(true, 3)).toBe(true);
    expect(await usesAudio(true, 0)).toBe(false);
    expect(await usesAudio(undefined, 3)).toBe(false);
    // 只认 bool 真（rea-p4e-audio.md 4.1）
    expect(await usesAudio("true", 3)).toBe(false);
    expect(await usesAudio(1, 3)).toBe(false);
    // scene.json 的同名键 WPE 不读（第 6 节）：不报、也不打开
    expect(await usesAudio(undefined, 3, true)).toBe(false);
  });

  it("「场景用音频」位（P11a）：程序读音频频谱 uniform 也算，标了 unused 的不算；没声明开关时照旧 false", async () => {
    const usesAudio = async (flag: boolean, unused: boolean) => {
      const project = files({ "particles/p.json": system() });
      if (flag)
        (project["P:/p/project.json"] as { general: Record<string, unknown> }).general.supportsaudioprocessing = true;
      const audioTranslator = {
        async translate(): Promise<TranslateResult> {
          return {
            ok: true,
            uniforms: [
              {
                name: "g_AudioSpectrum64Left",
                type: "array<vec4<f32>, 64>",
                declared: "float",
                offset: 0,
                size: 1024,
                array: 64,
                stride: 16,
                ...(unused ? { unused: true } : {}),
              },
            ],
            textures: [],
            combos: [],
          } as TranslateResult;
        },
      } as unknown as Wpesl2wgsl;
      const bundle = await compileScene({
        projectDir: "P:/p",
        sceneAssets: ["A:/assets"],
        reader: memoryReader(project),
        translator: audioTranslator,
        postprocess: "disabled",
        exhaustive: true,
      });
      // 音频 uniform 是引擎 uniform：不报
      expect(bundle.unsupported).toEqual([]);
      return bundle.audio;
    };
    expect(await usesAudio(true, false)).toBe(true);
    expect(await usesAudio(true, true)).toBe(false);
    expect(await usesAudio(false, false)).toBe(false);
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
