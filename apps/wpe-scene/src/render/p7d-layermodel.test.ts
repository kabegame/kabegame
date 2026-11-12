/**
 * P7d 步骤 2：`g_LayerModelMatrix` 只在 effect pass 里支持。
 * - 程序检查：effect 的 pass（画进 fbo 的中间 pass、上屏的末 pass）读它不报；基础 pass、直接上屏、passthrough 上屏读它照报
 *   （`compile/features.ts` 的 `EFFECT_UNIFORMS`，WPE 在那里不写、读到的是别的图层的残留值）；
 * - 取值：`drawMatrices` 的 `effect`、`final` 角色给图层世界矩阵（含父链、不含 size、不带视差），和 WPE 抓帧
 *   （p7-REPORT「P7d 的实测」，`p7d-uni` 的 `kbfx` 与子图层 `kbchild`）逐值比。WPE 的值是 16 个 float32、列主序、第 12、13 个是平移，
 *   和 `Mat4` 同一约定（同 `p5b-compose.test.ts` 的 `WPE_MVP`）；
 * - 就地刷新：图层或祖先的变换变了，`g_LayerModelMatrix` 跟着重写（`LAYER_UNIFORMS`），字节等于整场重编译。
 */
import { describe, expect, it, vi } from "vitest";
import { compileScene, type SceneBundle } from "../compile/bundle";
import { checkProgramFeatures, EFFECT_UNIFORMS, PARTICLE_UNIFORMS } from "../compile/features";
import type { SceneReader } from "../compile/fs";
import type { TranslateRequest, TranslateResult, UniformLayout, Wpesl2wgsl } from "../wpesl2wgsl";
import { planLayer, type DrawStep } from "./graph";
import { eyePosition, sceneViewProjection, worldMatrixOf } from "./layout";
import { multiply, translation, type Mat4 } from "./math";
import { SceneState } from "./state";
import { drawMatrices, drawUniformValues, LAYER_UNIFORMS, layerRefreshNames, UniformBlock } from "./uniforms";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

/** WPE 抓帧里的 `g_LayerModelMatrix`（`A:\p7d\uni`，p7-REPORT「P7d 的实测」）：effect 的两个 pass 相同。 */
const WPE_LAYER_MODEL = {
  /** origin `960 600 0`、scale `1.5 0.5 1`、angles `0 0 0.4`、size `300 200`：T · R(0.4) · S(1.5, 0.5)，不含 size。 */
  kbfx: [1.3815914, 0.5841275, 0, 0, -0.1947092, 0.4605305, 0, 0, 0, 0, 1, 0, 960, 600, 0, 1],
  /** `kbfx` 的子图层，origin `100 50 0`、scale `0.5 2 1`、size `120 80`：W_父 · T(100, 50) · S(0.5, 2)。 */
  kbchild: [0.6907957, 0.2920637, 0, 0, -0.3894183, 0.921061, 0, 0, 0, 0, 1, 0, 1088.4237, 681.4393, 0, 1],
} as const;

/** 逐元素比：误差 ≤ 1e-5 · max(1, |期望|)（平移在 1000 上下，float32 的间距约 1.2e-4，按相对误差比）。 */
function expectMatrix(actual: ArrayLike<number> | undefined, expected: readonly number[], label: string) {
  expect(actual, label).toBeDefined();
  expect(Array.from(actual!).length, label).toBe(16);
  expected.forEach((value, i) =>
    expect(Math.abs(actual![i] - value), `${label} [${i}]`).toBeLessThanOrEqual(1e-5 * Math.max(1, Math.abs(value))),
  );
}

function memoryReader(files: Record<string, unknown>): SceneReader {
  const bytes = (path: string) => {
    const value = files[path.replace(/\\/g, "/")];
    if (value === undefined) throw new TypeError("Failed to fetch");
    return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
  };
  return {
    async readWhole(path) {
      return bytes(path);
    },
    async readRange(path, start, end) {
      return bytes(path).slice(start, end);
    },
  };
}

const mat4 = (name: string, offset: number): UniformLayout => ({
  name,
  type: "mat4x4<f32>",
  declared: "mat4",
  offset,
  size: 64,
});
/** 读 `g_LayerModelMatrix` 的程序的 uniform 块（同 `p7d-uni` 的 kbfx / kbbase 顶点着色器读的四个矩阵）。 */
const READS: UniformLayout[] = [
  mat4("g_ModelViewProjectionMatrix", 0),
  mat4("g_LayerModelMatrix", 64),
  mat4("g_ModelMatrix", 128),
  mat4("g_EffectModelMatrix", 192),
];
const LAYER_MODEL_OFFSET = 64;

/** 假翻译器：顶点源码写了 `g_LayerModelMatrix` 的程序声明并读它，其余只有 MVP。 */
function translator(): Wpesl2wgsl {
  return {
    async translate(request: TranslateRequest): Promise<TranslateResult> {
      const reads = request.vertex.includes("g_LayerModelMatrix");
      return {
        ok: true,
        uniforms: reads ? READS : [READS[0]],
        uniformBlockSize: reads ? 256 : 64,
        textures: [],
        combos: [],
      };
    },
  } as unknown as Wpesl2wgsl;
}

const FILES = {
  "P:/p/project.json": {
    file: "scene.json",
    general: {
      properties: {
        fxorigin: { type: "text", value: "960 600 0" },
        fxangles: { type: "text", value: "0 0 0.4" },
        fxscale: { type: "text", value: "1.5 0.5 1" },
      },
    },
  },
  // 基础材质：plain 不读，reads 读（`p7d-uni` 的 kbbase）
  "P:/p/models/plain.json": { material: "materials/plain.json" },
  "P:/p/models/reads.json": { material: "materials/reads.json" },
  "P:/p/materials/plain.json": { passes: [{ shader: "plain" }] },
  "P:/p/materials/reads.json": { passes: [{ shader: "reads" }] },
  "P:/p/shaders/plain.vert": "void main() {}",
  "P:/p/shaders/plain.frag": "void main() {}",
  "P:/p/shaders/reads.vert": "uniform mat4 g_LayerModelMatrix;\nvoid main() {}",
  "P:/p/shaders/reads.frag": "void main() {}",
  // `p7d-uni` 的 kbfx effect：第一个 pass 画进 fbo，第二个 pass 绑它上屏，两个 pass 的着色器都读 `g_LayerModelMatrix`
  "P:/p/effects/kbfx/effect.json": {
    passes: [
      { material: "materials/effects/kbfx.json", target: "_rt_KbA" },
      { material: "materials/effects/kbfx.json", bind: [{ name: "_rt_KbA", index: 0 }] },
    ],
    fbos: [{ name: "_rt_KbA", scale: 1, format: "rgba8888" }],
  },
  "P:/p/materials/effects/kbfx.json": { passes: [{ shader: "reads" }] },
  // passthrough 上屏（colorBlendMode 混合）的材质也读它：不是 effect 的 pass，照报
  "P:/p/materials/util/effectpassthrough.json": { passes: [{ shader: "reads" }] },
};

const kbfxEffect = (id: number) => ({
  file: "effects/kbfx/effect.json",
  id,
  passes: [{ id: id * 10 + 1 }, { id: id * 10 + 2 }],
  visible: true,
});

/** `p7d-uni` 的四个图层（objects 下标 0…3）。`fx` 改 kbfx 的变换（绑用户属性的变体用）。 */
function uniObjects(fx: Record<string, unknown> = {}): Record<string, unknown>[] {
  return [
    {
      id: 11,
      name: "kbfx",
      origin: "960 600 0",
      scale: "1.5 0.5 1",
      angles: "0 0 0.4",
      size: "300 200",
      image: "models/plain.json",
      effects: [kbfxEffect(102)],
      ...fx,
    },
    {
      id: 12,
      name: "kbchild",
      origin: "100 50 0",
      scale: "0.5 2 1",
      angles: "0 0 0",
      size: "120 80",
      parent: 11,
      image: "models/plain.json",
      effects: [kbfxEffect(103)],
    },
    {
      id: 13,
      name: "kbbase",
      origin: "1600 300 0",
      scale: "1.25 0.75 1",
      angles: "0 0 -0.3",
      size: "240 160",
      image: "models/reads.json",
    },
    {
      id: 14,
      name: "kbbasefx",
      origin: "400 250 0",
      scale: "0.8 1.2 1",
      angles: "0 0 0.2",
      size: "200 260",
      image: "models/reads.json",
      effects: [kbfxEffect(104)],
    },
  ];
}

async function compile(objects: Record<string, unknown>[], userProperties: Record<string, unknown> = {}) {
  return compileScene({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    reader: memoryReader({
      ...FILES,
      "P:/p/scene.json": { general: { orthogonalprojection: { width: 1920, height: 1200 } }, objects },
    }),
    translator: translator(),
    postprocess: "disabled",
    exhaustive: true,
    userProperties,
  });
}

const drawSteps = (bundle: SceneBundle, object: number): DrawStep[] =>
  planLayer(bundle.layers[object], bundle.textures).steps.filter((step): step is DrawStep => step.kind === "draw");

/** 按渲染器的规则组装一个 draw 的 uniform（同 `GpuScene.uniformValues` 的普通图层分支）。 */
function drawValues(bundle: SceneBundle, state: SceneState, object: number, step: DrawStep, worlds = new Map()) {
  return drawUniformValues({
    step,
    layer: { ...state.layers.get(object)!, size: bundle.layers[object].size },
    world: worldMatrixOf(object, state.layers, worlds),
    constants: state.constants.get(step.pass.key) ?? {},
    viewProjection: sceneViewProjection(bundle.general),
    colorScale: 1,
    screenSize: [1920, 1200],
    textures: [],
    eye: eyePosition(bundle.general),
  });
}

/** 一个 draw 的 uniform 块：程序的布局，按值写满（同 `createDraw`）。 */
function blockOf(bundle: SceneBundle, step: DrawStep, values: Record<string, number[]>): UniformBlock {
  const program = bundle.programs[step.pass.program!];
  const block = new UniformBlock(program.uniforms ?? [], program.uniformBlockSize ?? 0);
  for (const [name, value] of Object.entries(values)) block.set(name, value);
  return block;
}

/** 块里 `g_LayerModelMatrix` 那一格（上传给 GPU 的 float32）。 */
const uploaded = (block: UniformBlock) => new Float32Array(block.data, LAYER_MODEL_OFFSET, 16);

describe("程序检查：g_LayerModelMatrix 只在 effect pass 里当引擎 uniform", () => {
  const program = (extra: Partial<UniformLayout> = {}): TranslateResult => ({
    ok: true,
    uniforms: [{ ...mat4("g_LayerModelMatrix", 0), ...extra }],
  });

  it("checkProgramFeatures：带 EFFECT_UNIFORMS 不报，不带或带粒子的表照报，没被读的不报", () => {
    const effect = new Set<string>();
    checkProgramFeatures(program(), effect, EFFECT_UNIFORMS);
    expect([...effect]).toEqual([]);
    for (const extra of [undefined, PARTICLE_UNIFORMS]) {
      const base = new Set<string>();
      checkProgramFeatures(program(), base, extra);
      expect([...base]).toEqual(["uniform:g_LayerModelMatrix"]);
    }
    // 步骤 1：翻译器标了 unused（WPE 的反射里没有它）的照旧不报
    const unread = new Set<string>();
    checkProgramFeatures(program({ unused: true }), unread);
    expect([...unread]).toEqual([]);
  });

  it("编译：只有 effect 的 pass 读它时不报（kbfx、kbchild），effect 自己的不支持项里也没有", async () => {
    const [kbfx, kbchild] = uniObjects();
    const bundle = await compile([kbfx, kbchild]);
    expect(bundle.unsupported).toEqual([]);
    for (const object of [0, 1]) {
      expect(bundle.layers[object].effects).toHaveLength(1);
      expect(bundle.layers[object].effects[0].unsupported).toEqual([]);
      // 两个 effect pass 的程序确实读它
      for (const step of bundle.layers[object].effects[0].steps)
        if (step.kind === "draw")
          expect(bundle.programs[step.pass.program!].uniforms?.map((u) => u.name)).toContain("g_LayerModelMatrix");
    }
  });

  it("编译：基础 pass 读它照报，带不带 effect 都报（kbbase、kbbasefx）", async () => {
    const [, , kbbase, kbbasefx] = uniObjects();
    expect((await compile([kbbase])).unsupported).toEqual(["uniform:g_LayerModelMatrix"]);
    const withEffect = await compile([kbbasefx]);
    expect(withEffect.unsupported).toEqual(["uniform:g_LayerModelMatrix"]);
    // 报的是基础 pass：effect 自己的不支持项里没有
    expect(withEffect.layers[0].effects[0].unsupported).toEqual([]);
  });

  it("编译：passthrough 上屏（colorBlendMode 混合）读它照报", async () => {
    const [kbfx] = uniObjects();
    const bundle = await compile([{ ...kbfx, effects: [], colorBlendMode: 2 }]);
    expect(bundle.layers[0].passthrough?.program).not.toBeNull();
    expect(bundle.unsupported).toEqual(["uniform:g_LayerModelMatrix"]);
  });
});

describe("取值：effect pass 的图层世界矩阵，与 WPE 抓帧逐值相同（p7d-uni）", () => {
  it("kbfx、kbchild：中间 pass（画进 fbo）与上屏 pass 相同，含父链、不含 size；上传的 float32 与 WPE 一致", async () => {
    const bundle = await compile(uniObjects());
    const state = SceneState.fromBundle(bundle);
    for (const [object, name] of [
      [0, "kbfx"],
      [1, "kbchild"],
    ] as const) {
      const steps = drawSteps(bundle, object);
      expect(
        steps.map((step) => `${step.role}→${step.target.kind}`),
        name,
      ).toEqual(["base→composite", "effect→fbo", "final→scene"]);
      for (const step of steps) {
        const values = drawValues(bundle, state, object, step);
        if (step.role === "base") {
          // 基础 pass 不写（WPE 是残留值）
          expect(values.g_LayerModelMatrix, `${name} base`).toBeUndefined();
          continue;
        }
        expectMatrix(values.g_LayerModelMatrix, WPE_LAYER_MODEL[name], `${name} ${step.role}`);
        expectMatrix(uploaded(blockOf(bundle, step, values)), WPE_LAYER_MODEL[name], `${name} ${step.role} 上传`);
        // 就是这次绘制的 g_ModelMatrix 的来源（世界矩阵）：上屏 pass 两者相同；中间 pass 的 g_ModelMatrix 是单位阵
        if (step.role === "final") expect(values.g_LayerModelMatrix).toEqual(values.g_ModelMatrix);
      }
    }
  });

  it("基础材质直接上屏（kbbase）与带 effect 图层的基础 pass（kbbasefx）不写", async () => {
    const bundle = await compile(uniObjects());
    const state = SceneState.fromBundle(bundle);
    const roles: string[] = [];
    for (const object of [2, 3])
      for (const step of drawSteps(bundle, object)) {
        roles.push(`${bundle.layers[object].name}:${step.role}`);
        const values = drawValues(bundle, state, object, step);
        if (step.role === "direct" || step.role === "base") expect(values.g_LayerModelMatrix).toBeUndefined();
        else
          expectMatrix(
            values.g_LayerModelMatrix,
            Array.from(worldMatrixOf(object, state.layers, new Map())),
            `kbbasefx ${step.role}`,
          );
      }
    expect(roles).toEqual(["kbbase:direct", "kbbasefx:base", "kbbasefx:effect", "kbbasefx:final"]);
  });

  it("视差只在视图投影里：MVP 变了，g_LayerModelMatrix 不变（`A:\\p7d\\unipar` 事件 73）", () => {
    const layers = new Map([[0, { origin: [960, 600, 0], angles: [0, 0, 0.4], scale: [1.5, 0.5, 1], parent: null }]]);
    const world = worldMatrixOf(0, layers, new Map());
    const vp = sceneViewProjection({ width: 1920, height: 1200 });
    const parallax = multiply(vp, translation(37, -21, 0));
    for (const role of ["effect", "final"] as const) {
      const still = drawMatrices({ role }, world, [300, 200], vp);
      const moved = drawMatrices({ role }, world, [300, 200], parallax);
      expect([...moved.effectModelViewProjection!], role).not.toEqual([...still.effectModelViewProjection!]);
      expect([...moved.layerModel!], role).toEqual([...still.layerModel!]);
      expectMatrix(moved.layerModel, WPE_LAYER_MODEL.kbfx, role);
    }
    // passthrough 上屏、基础 pass、直接上屏、组合层的基础 pass 不给
    for (const role of ["passthrough", "base", "direct", "compose"] as const)
      expect(drawMatrices({ role }, world, [300, 200], vp).layerModel, role).toBeUndefined();
  });
});

describe("就地刷新：图层或祖先的变换变了，g_LayerModelMatrix 跟着重写", () => {
  it("在 LAYER_UNIFORMS 里：材质没覆盖时刷新名单里有它", () => {
    expect(LAYER_UNIFORMS.has("g_LayerModelMatrix")).toBe(true);
    expect(layerRefreshNames({})).toContain("g_LayerModelMatrix");
  });

  it("就地改 kbfx 的 origin / angles / scale：kbfx 与子图层 kbchild 的 effect pass 字节等于用新值整场编译", async () => {
    const bound = uniObjects({
      origin: { user: "fxorigin", value: "960 600 0" },
      angles: { user: "fxangles", value: "0 0 0.4" },
      scale: { user: "fxscale", value: "1.5 0.5 1" },
    });
    const updated = { fxorigin: "800 500 0", fxangles: "0 0 -0.7", fxscale: "2 0.75 1" };
    const before = await compile(bound);
    const state = SceneState.fromBundle(before);
    // 建 draw：每个 effect pass 一块，整组写满（同 `createDraw`）
    const draws = [0, 1].flatMap((object) =>
      drawSteps(before, object)
        .filter((step) => step.role !== "base")
        .map((step) => ({ object, step, block: blockOf(before, step, drawValues(before, state, object, step)) })),
    );
    const initial = draws.map(({ block }) => Array.from(uploaded(block)));
    for (const binding of before.bindings) {
      const value = updated[binding.property as keyof typeof updated];
      if (value !== undefined) expect(state.write(binding, value)).toBe("applied");
    }
    // 父写变换，子孙一起标脏；只重写由图层算出的那组（同 `GpuScene.refreshLayer`）
    expect([...state.takeDirty().layers].sort()).toEqual([0, 1]);
    const worlds = new Map<number, Mat4>();
    for (const { object, step, block } of draws) {
      const values = drawValues(before, state, object, step, worlds);
      for (const name of layerRefreshNames(step.pass.uniforms)) if (values[name]) block.set(name, values[name]);
    }
    const after = await compile(bound, updated);
    const fresh = SceneState.fromBundle(after);
    expect(state.layers).toEqual(fresh.layers);
    const freshDraws = [0, 1].flatMap((object) =>
      drawSteps(after, object)
        .filter((step) => step.role !== "base")
        .map((step) => blockOf(after, step, drawValues(after, fresh, object, step))),
    );
    expect(draws.map(({ block }) => Buffer.from(block.data).toString("hex"))).toEqual(
      freshDraws.map((block) => Buffer.from(block.data).toString("hex")),
    );
    // g_LayerModelMatrix 确实变了（父的写入传到了子图层）
    draws.forEach(({ block }, i) => expect(Array.from(uploaded(block)), `draw ${i}`).not.toEqual(initial[i]));
  });
});
