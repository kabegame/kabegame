/**
 * P4f 步骤 4（一个系统多个 renderer，rea-p4f-script.md 8.1–8.4）：编译侧。解析出的 `draws` 与模拟用的 renderer、能力表的
 * `particle:renderers`（只有 rope 类混挂照报）、每条 renderer 一个变体材质（宏、稳定键、属性绑定、子系统），以及单 renderer 系统的 pass
 * 和以前相同（bundle 只多出 `draws`）。
 */
import { describe, expect, it, vi } from "vitest";
import { compileScene, type SceneBundle, type ScenePass } from "./bundle";
import { checkParticleFeatures } from "./features";
import type { SceneReader } from "./fs";
import type { JsonObject } from "./model";
import {
  hasSpriteTrail,
  parseParticle,
  particleDraws,
  particleRenderer,
  particleThick,
  type SceneParticle,
} from "./particles";
import { readParticleModule } from "../particles/modules";
import { SceneState } from "../render/state";
import type { TranslateRequest, TranslateResult, Wpesl2wgsl } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

const ORTHO = { orthogonalprojection: { width: 1920, height: 1080 } };

/** 内存文件：字符串原样，其它按 JSON（同 `compile/particles.test.ts`）。 */
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

/** 一级 mip、4×4 的原始 `.tex`（同 `compile/particles.test.ts`）：只关心格式号。 */
function rawTex(format: number): Uint8Array {
  const magic = (text: string) => [...new TextEncoder().encode(text), 0];
  const word = (value: number) => [value & 255, (value >> 8) & 255, (value >> 16) & 255, (value >>> 24) & 255];
  return new Uint8Array([
    ...magic("TEXV0005"),
    ...magic("TEXI0001"),
    ...[format, 2, 4, 4, 4, 4, 0].flatMap(word),
    ...magic("TEXB0002"),
    ...[1, 1, 4, 4, 0, 64, 64].flatMap(word),
    ...new Array(64).fill(7),
  ]);
}

interface Fixture {
  /** 顶层粒子 JSON 的 `renderer`。 */
  renderer?: JsonObject[];
  /** 槽 0 纹理的格式。 */
  format?: number;
  /** 覆盖顶层粒子 JSON 的其余键。 */
  system?: JsonObject;
  /** 材质 pass 的额外键（`constantshadervalues` 等）。 */
  pass?: JsonObject;
  /** 翻译结果的 uniform（材质常量要带 `meta.material`）。 */
  uniforms?: TranslateResult["uniforms"];
  /** 另加的文件（子系统 JSON 等）。 */
  files?: Record<string, unknown>;
}

/**
 * 编一个只有一个粒子对象的场景。假翻译器把这次请求的宏写进顶点 WGSL：`definesOf(pass)` 从程序里读回，按 pass 认出是哪一份变体
 * （同一组宏命中翻译缓存时是同一个程序，读回的也一样）。
 */
async function compile(fixture: Fixture = {}) {
  const requests: TranslateRequest[] = [];
  const translator = {
    async translate(request: TranslateRequest): Promise<TranslateResult> {
      requests.push(request);
      return {
        ok: true,
        vertex: { wgsl: JSON.stringify(request.defines ?? {}), entryPoint: "main" },
        ...(fixture.uniforms ? { uniforms: fixture.uniforms } : {}),
      } as TranslateResult;
    },
  } as unknown as Wpesl2wgsl;
  const bundle = await compileScene({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    reader: memoryReader({
      "P:/p/project.json": { file: "scene.json" },
      "P:/p/scene.json": { general: ORTHO, objects: [{ id: 1, particle: "particles/p.json" }] },
      "P:/p/particles/p.json": {
        material: "materials/pm.json",
        maxcount: 4,
        renderer: fixture.renderer ?? [{ name: "sprite" }],
        ...fixture.system,
      },
      "P:/p/materials/pm.json": {
        passes: [{ shader: "genericparticle", blending: "additive", textures: ["kbt/t"], ...fixture.pass }],
      },
      "P:/p/materials/kbt/t.tex": rawTex(fixture.format ?? 0),
      "P:/p/shaders/genericparticle.vert": "void main(){}",
      "P:/p/shaders/genericparticle.frag": "void main(){}",
      ...fixture.files,
    }),
    translator,
    postprocess: "disabled",
    exhaustive: true,
  });
  const definesOf = (pass: ScenePass): Record<string, string> =>
    JSON.parse(bundle.programs[pass.program!].vertex!.wgsl ?? "{}") as Record<string, string>;
  return { bundle, requests, definesOf };
}

const particleOf = (bundle: SceneBundle): SceneParticle => bundle.layers[0].particle!;

describe("解析：draws 与模拟用的 renderer（P4f 步骤 4）", () => {
  const parse = (renderer: unknown) => parseParticle({ renderer }, { file: "p.json", orthographic: true });

  it("表内每条 renderer 一项，JSON 顺序；表外的不算；只有表外类型时按缺省 sprite 一项；renderer: [] 为空；缺键补的 sprite 一项", () => {
    const kinds = (renderer: unknown) => parse(renderer).draws.map((draw) => draw.renderer.kind);
    expect(kinds([{ name: "sprite" }, { name: "spritetrail" }])).toEqual(["sprite", "spritetrail"]);
    expect(kinds([{ name: "spritetrail" }, { name: "sprite" }])).toEqual(["spritetrail", "sprite"]);
    expect(kinds([{ name: "foo" }, { name: "spritetrail" }, { name: "bar" }, { name: "sprite" }])).toEqual([
      "spritetrail",
      "sprite",
    ]);
    expect(kinds([{ name: "foo" }])).toEqual(["sprite"]);
    expect(kinds([])).toEqual([]);
    expect(kinds(undefined)).toEqual(["sprite"]);
    // 每条各自的参数：拖尾的 g_RenderVar0、朝向
    const both = parse([
      { name: "sprite", orientation: "upright", axis: "1 0 0" },
      { name: "spritetrail", length: 0.08, maxlength: 7, minlength: 12, orientation: "fixed" },
    ]);
    expect(both.draws[0].renderer).toMatchObject({ kind: "sprite", trail: null, orientation: { mode: 1 } });
    expect(both.draws[1].renderer).toMatchObject({
      kind: "spritetrail",
      trail: [Math.fround(0.08), 7, 12],
      orientation: { mode: 2 },
    });
  });

  it("第 0 项的 passes 就是 SceneParticle.passes（同一个数组），其余各自一个空数组；模拟用的 renderer 是同一份对象", () => {
    const particle = parse([{ name: "sprite" }, { name: "spritetrail" }, { name: "sprite" }]);
    expect(particle.draws[0].passes).toBe(particle.passes);
    expect(particle.draws[1].passes).not.toBe(particle.passes);
    expect(particle.draws[2].passes).not.toBe(particle.draws[1].passes);
    expect(particle.draws.map((draw) => draw.passes)).toEqual([[], [], []]);
    expect(particle.renderer).toBe(particle.draws[0].renderer);
  });

  it("模拟用的 renderer：有 rope 类时取第一个 rope 类，否则取第一个，都没有时缺省 sprite；单 renderer 与以前相同", () => {
    expect(parse([{ name: "sprite" }, { name: "spritetrail" }]).renderer.kind).toBe("sprite");
    expect(parse([{ name: "spritetrail" }, { name: "sprite" }]).renderer.kind).toBe("spritetrail");
    // rope 表与拖尾历史跟第一个 rope 类建（强制渲染混挂）
    const mixed = parse([{ name: "sprite" }, { name: "ropetrail" }, { name: "rope" }]);
    expect(mixed.renderer.kind).toBe("ropetrail");
    expect(mixed.renderer).toBe(mixed.draws[1].renderer);
    expect(parse([{ name: "sprite" }, { name: "rope" }]).renderer.kind).toBe("rope");
    expect(parse([]).renderer).toEqual(parse(undefined).renderer);
    // `particleRenderer` 按同一规则
    const modules = (names: string[]) => names.map((name) => readParticleModule("renderer", { name }, true));
    expect(particleRenderer(modules(["sprite", "rope"])).kind).toBe("rope");
    expect(particleRenderer(modules(["spritetrail", "sprite"])).kind).toBe("spritetrail");
    expect(particleRenderer([]).kind).toBe("sprite");
  });

  it("particleDraws：第 0 项总读 passes（单测会整个换掉它）；没有 draws 的手写定义按 renderers 画一次", () => {
    const particle = parse([{ name: "sprite" }, { name: "spritetrail" }]);
    const replaced: ScenePass[] = [];
    particle.passes = replaced;
    const draws = particleDraws(particle);
    expect(draws[0].passes).toBe(replaced);
    expect(draws[0].renderer).toBe(particle.draws[0].renderer);
    expect(draws[1]).toBe(particle.draws[1]);
    // 没换过时返回的就是 `draws` 本身
    const plain = parse([{ name: "sprite" }]);
    expect(particleDraws(plain)).toBe(plain.draws);
    const passes: ScenePass[] = [];
    expect(particleDraws({ passes, renderers: [plain.renderers[0]] })).toEqual([{ renderer: undefined, passes }]);
    expect(particleDraws({ passes, renderers: [] })).toEqual([]);
  });

  it("厚格式看整个系统：有 spritetrail 或帧表时为真（particleThick / hasSpriteTrail）", () => {
    expect(hasSpriteTrail(parse([{ name: "sprite" }, { name: "spritetrail" }]))).toBe(true);
    expect(hasSpriteTrail(parse([{ name: "sprite" }, { name: "sprite" }]))).toBe(false);
    expect(particleThick(parse([{ name: "sprite" }, { name: "spritetrail" }]))).toBe(true);
    expect(particleThick(parse([{ name: "spritetrail" }]))).toBe(true);
    expect(particleThick(parse([{ name: "sprite" }]))).toBe(false);
    expect(particleThick({ ...parse([{ name: "sprite" }]), spriteSheet: true })).toBe(true);
  });
});

describe("能力表：particle:renderers 只报 rope 类混挂（P4f 步骤 4）", () => {
  const keys = (renderer: JsonObject[]) => {
    const out = new Set<string>();
    checkParticleFeatures({ maxcount: 4, renderer }, true, out);
    return [...out].sort();
  };
  it("sprite / spritetrail 任意条数不报；表内多于一个且有 rope 类照报；表外的不算条数", () => {
    expect(keys([{ name: "sprite" }, { name: "spritetrail" }])).toEqual([]);
    expect(keys([{ name: "spritetrail" }, { name: "sprite" }])).toEqual([]);
    expect(keys([{ name: "sprite" }, { name: "sprite" }, { name: "spritetrail" }, { name: "spritetrail" }])).toEqual(
      [],
    );
    expect(keys([{ name: "sprite" }, { name: "rope" }])).toEqual(["particle:renderers"]);
    expect(keys([{ name: "ropetrail" }, { name: "spritetrail" }])).toEqual(["particle:renderers"]);
    expect(keys([{ name: "rope" }, { name: "ropetrail" }])).toEqual(["particle:renderers"]);
    expect(keys([{ name: "rope" }])).toEqual([]);
    // 表外的照报自己的键，不让单条 rope 变成「混挂」
    expect(keys([{ name: "foo" }, { name: "rope" }])).toEqual(["particle:renderer:foo"]);
  });
});

describe("compileScene：每条 renderer 一个变体材质（rea-p4f-script.md 8.1）", () => {
  it.each([
    ["sprite 在前", [0, 1]],
    ["spritetrail 在前", [1, 0]],
  ] as const)(
    "sprite + spritetrail（%s）：各编一份；sprite 那份有 THICKFORMAT、没有 TRAILRENDERER；TEX0FORMAT 按厚格式（只看 8–11、不看朝向）",
    async (_, [spriteAt, trailAt]) => {
      for (const format of [0, 4, 9]) {
        const renderer: JsonObject[] = [];
        renderer[spriteAt] = { name: "sprite", orientation: "upright", axis: "1 0 0" };
        renderer[trailAt] = { name: "spritetrail" };
        const { bundle, requests, definesOf } = await compile({ renderer, format });
        expect(bundle.unsupported, `${format}`).toEqual([]);
        const particle = particleOf(bundle);
        expect(particle.draws.map((draw) => draw.renderer.kind)).toEqual(
          spriteAt === 0 ? ["sprite", "spritetrail"] : ["spritetrail", "sprite"],
        );
        const tex0 = format === 9 ? { TEX0FORMAT: "9" } : {};
        // 非厚格式的 upright sprite 会对任何格式写 TEX0FORMAT；同系统有拖尾时厚格式，只看 8–11
        expect(definesOf(particle.draws[spriteAt].passes[0]), `${format}`).toEqual({
          REVERSEDEPTH: "1",
          SCENE_ORTHO: "1",
          THICKFORMAT: "1",
          ...tex0,
        });
        expect(definesOf(particle.draws[trailAt].passes[0]), `${format}`).toEqual({
          REVERSEDEPTH: "1",
          SCENE_ORTHO: "1",
          THICKFORMAT: "1",
          TRAILRENDERER: "1",
          ...tex0,
        });
        // 两份各翻译一次，按数组顺序
        expect(requests.map((request) => request.defines?.TRAILRENDERER)).toEqual(
          spriteAt === 0 ? [undefined, "1"] : ["1", undefined],
        );
        // blending 等来自同一个基础材质
        expect(particle.draws.map((draw) => draw.passes[0].blending)).toEqual(["additive", "additive"]);
      }
    },
  );

  it("两个 sprite 朝向不同、没有拖尾：非厚格式，TEX0FORMAT 各按各的朝向（7.8）", async () => {
    const { bundle, definesOf } = await compile({
      renderer: [
        { name: "sprite", orientation: "screen" },
        { name: "sprite", orientation: "fixed" },
      ],
      format: 4,
    });
    expect(bundle.unsupported).toEqual([]);
    const [screen, fixed] = particleOf(bundle).draws;
    expect(definesOf(screen.passes[0])).toEqual({ REVERSEDEPTH: "1", SCENE_ORTHO: "1" });
    expect(definesOf(fixed.passes[0])).toEqual({ REVERSEDEPTH: "1", SCENE_ORTHO: "1", TEX0FORMAT: "4" });
  });

  it("稳定键：第 0 个沿用 <系统键>/passes/<k>，第 r 个是 <系统键>/renderers/<r>/passes/<k>；SceneState 各留一份常量", async () => {
    const { bundle } = await compile({
      renderer: [{ name: "sprite" }, { name: "spritetrail" }, { name: "sprite", orientation: "upright" }],
    });
    const particle = particleOf(bundle);
    expect(particle.draws.map((draw) => draw.passes.map((pass) => pass.key))).toEqual([
      ["objects/0/particle/passes/0"],
      ["objects/0/particle/renderers/1/passes/0"],
      ["objects/0/particle/renderers/2/passes/0"],
    ]);
    expect(particle.draws[0].passes).toBe(particle.passes);
    const state = SceneState.fromBundle(bundle);
    for (const key of [
      "objects/0/particle/passes/0",
      "objects/0/particle/renderers/1/passes/0",
      "objects/0/particle/renderers/2/passes/0",
    ])
      expect(state.constants.has(key), key).toBe(true);
  });

  it("材质常量绑用户属性：两个变体各登记一份，改值时两份都写到", async () => {
    const { bundle } = await compile({
      renderer: [{ name: "sprite" }, { name: "spritetrail" }],
      pass: { constantshadervalues: { overbright: { user: "ob", value: 2 } } },
      uniforms: [
        { name: "g_Overbright", type: "f32", offset: 0, size: 4, meta: { material: "overbright" } },
      ] as unknown as TranslateResult["uniforms"],
    });
    const constants = bundle.bindings.filter((binding) => binding.target.kind === "constant");
    expect(constants.map((binding) => [binding.property, (binding.target as { pass: string }).pass])).toEqual([
      ["ob", "objects/0/particle/passes/0"],
      ["ob", "objects/0/particle/renderers/1/passes/0"],
    ]);
    expect(particleOf(bundle).draws.map((draw) => draw.passes[0].uniforms)).toEqual([
      { g_Overbright: [2] },
      { g_Overbright: [2] },
    ]);
    const state = SceneState.fromBundle(bundle);
    for (const binding of constants) expect(state.write(binding, 5)).toBe("applied");
    expect(state.constants.get("objects/0/particle/passes/0")).toEqual({ g_Overbright: [5] });
    expect(state.constants.get("objects/0/particle/renderers/1/passes/0")).toEqual({ g_Overbright: [5] });
  });

  it("子系统同样：变体的键接在自己的 children/<n> 后面，厚格式按子系统自己的 renderer 判断", async () => {
    const { bundle, definesOf } = await compile({
      renderer: [{ name: "sprite" }],
      system: { children: [{ name: "particles/c.json" }] },
      files: {
        "P:/p/particles/c.json": {
          material: "materials/pm.json",
          maxcount: 4,
          renderer: [{ name: "spritetrail" }, { name: "sprite" }],
        },
      },
    });
    expect(bundle.unsupported).toEqual([]);
    const root = particleOf(bundle);
    const child = root.children[0].system;
    expect(root.draws.map((draw) => draw.passes.map((pass) => pass.key))).toEqual([["objects/0/particle/passes/0"]]);
    expect(child.draws.map((draw) => draw.passes.map((pass) => pass.key))).toEqual([
      ["objects/0/particle/children/0/passes/0"],
      ["objects/0/particle/children/0/renderers/1/passes/0"],
    ]);
    // 父只有 sprite：非厚格式；子系统的 sprite 跟着子系统的拖尾变厚
    expect(definesOf(root.passes[0])).toEqual({ REVERSEDEPTH: "1", SCENE_ORTHO: "1" });
    expect(definesOf(child.draws[1].passes[0])).toEqual({ REVERSEDEPTH: "1", SCENE_ORTHO: "1", THICKFORMAT: "1" });
    expect(definesOf(child.draws[0].passes[0])).toEqual({
      REVERSEDEPTH: "1",
      SCENE_ORTHO: "1",
      THICKFORMAT: "1",
      TRAILRENDERER: "1",
    });
  });

  it("只有 rope 类混挂报 particle:renderers；sprite + spritetrail 不报", async () => {
    expect((await compile({ renderer: [{ name: "sprite" }, { name: "spritetrail" }] })).bundle.unsupported).toEqual([]);
    const rope = await compile({
      renderer: [{ name: "sprite" }, { name: "rope" }],
      files: {
        "P:/p/shaders/genericropeparticle.vert": "v",
        "P:/p/shaders/genericropeparticle.frag": "f",
        "P:/p/shaders/genericropeparticle.geom": "g",
      },
    });
    expect(rope.bundle.unsupported).toContain("particle:renderers");
    // 强制渲染照样编两份：rope 那份换 genericropeparticle
    expect(rope.requests.map((request) => request.geometry)).toEqual([undefined, "g"]);
  });

  it("单 renderer 系统的 pass 和以前相同：键、宏、程序、常量；bundle 里粒子只多出 draws", async () => {
    for (const [renderer, defines] of [
      [{ name: "sprite" }, { REVERSEDEPTH: "1", SCENE_ORTHO: "1" }],
      [
        { name: "sprite", orientation: "upright" },
        { REVERSEDEPTH: "1", SCENE_ORTHO: "1", TEX0FORMAT: "0" },
      ],
      [{ name: "spritetrail" }, { REVERSEDEPTH: "1", SCENE_ORTHO: "1", THICKFORMAT: "1", TRAILRENDERER: "1" }],
    ] as const) {
      const { bundle, requests, definesOf } = await compile({ renderer: [renderer] });
      const particle = particleOf(bundle);
      expect(requests).toHaveLength(1);
      expect(particle.passes.map((pass) => [pass.key, pass.program, pass.blending, pass.uniforms])).toEqual([
        ["objects/0/particle/passes/0", 0, "additive", {}],
      ]);
      expect(definesOf(particle.passes[0])).toEqual(defines);
      expect(particle.draws).toHaveLength(1);
      expect(particle.draws[0].passes).toBe(particle.passes);
      expect(particle.draws[0].renderer).toBe(particle.renderer);
      expect(Object.keys(particle).sort()).toEqual(
        [
          "file",
          "maxcount",
          "starttime",
          "flags",
          "animationMode",
          "sequenceMultiplier",
          "spriteSheet",
          "emitters",
          "initializers",
          "operators",
          "renderers",
          "renderer",
          "draws",
          "orthographic",
          "controlpoints",
          "instance",
          "colorSystem",
          "hdr",
          "passes",
          "children",
        ].sort(),
      );
    }
  });

  it("renderer: [] 照旧按缺省 sprite 编一份放进 passes，draws 为空", async () => {
    const { bundle, definesOf } = await compile({ renderer: [] });
    const particle = particleOf(bundle);
    expect(particle.draws).toEqual([]);
    expect(particle.passes.map((pass) => pass.key)).toEqual(["objects/0/particle/passes/0"]);
    expect(definesOf(particle.passes[0])).toEqual({ REVERSEDEPTH: "1", SCENE_ORTHO: "1" });
  });
});
