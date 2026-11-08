/**
 * 两阶段同名 uniform（翻译器 `rewrite::merge_uniforms`，见 `src-tauri/wpesl2wgsl/README.md`「两阶段同名 uniform」）在宿主侧的取值：
 * WPE 每个材质键只有一份存储（vector-constant-REPORT.md 2.1，第 6 节 `stage-def` 实测）。翻译器只在材质键不同时拆开，
 * 同键同类型合成一格、注解取片元的；同键不同类型拆开的两半，宿主让两半共用片元那一半的 setter 类型与缺省值
 * （`materialValues.ts`），能力表不把改名的一格当成未知引擎 uniform。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BindingCollector, type SceneBinding } from "./bindings";
import { compileScene } from "./bundle";
import { checkProgramFeatures } from "./features";
import type { SceneReader } from "./fs";
import { shaderUniforms } from "./shader";
import { SceneState } from "../render/state";
import { UniformBlock } from "../render/uniforms";
import { translateWithIncludes, Wpesl2wgsl, type TranslateRequest, type TranslateResult } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

const wasm = join(__dirname, "..", "wpesl2wgsl", "wpesl2wgsl.wasm");
const root = process.env.KABEGAME_WPE_ROOT;
const assets = root ? join(root, "assets") : "";

const translator = () => Wpesl2wgsl.fromBytes(readFileSync(wasm));

function pick(result: TranslateResult, name: string) {
  const uniform = result.uniforms?.find((u) => u.name === name);
  if (!uniform) throw new Error(`没有 ${name}：${result.uniforms?.map((u) => u.name).join(", ")}`);
  return uniform;
}

/** 只取关心的几个名字，其余材质常量不比。 */
function only(values: Record<string, number[]>, names: string[]): Record<string, number[] | undefined> {
  return Object.fromEntries(names.map((name) => [name, values[name]]));
}

/** uniform 块里某一格的第一个 f32（各格的偏移来自反射）。 */
function readF32(result: TranslateResult, block: UniformBlock, name: string): number {
  return new Float32Array(block.data)[pick(result, name).offset / 4];
}

describe.skipIf(!existsSync(wasm))("两阶段同名 uniform：合成着色器", () => {
  // 工坊 3643916956 自带的 frame_builder 写法：同一个材质键，顶点 vec2、片元 float
  const VERTEX = `uniform mat4 g_ModelViewProjectionMatrix;
uniform vec2 u_refResolution; // {"default":"512 512","material":"Reference resolution"}
attribute vec3 a_Position;
void main() { gl_Position = mul(vec4(a_Position * vec3(u_refResolution, 1.0), 1.0), g_ModelViewProjectionMatrix); }`;
  const FRAGMENT = `uniform float u_refResolution; // {"material":"Reference resolution","int":true,"default":512,"range":[0,2160]}
void main() { gl_FragColor = vec4(u_refResolution / 1024.0); }`;

  it("同键不同类型：两半共用片元那一半的 setter 类型与缺省值，顶点多拷的分量报 constant:mixed-type", async () => {
    const result = await (await translator()).translate({ vertex: VERTEX, fragment: FRAGMENT });
    expect(result.ok, JSON.stringify(result.errors)).toBe(true);
    expect(result.uniforms?.map((u) => [u.name, u.declared, u.stage, u.original])).toEqual([
      ["g_ModelViewProjectionMatrix", "mat4", undefined, undefined],
      ["u_refResolution", "vec2", "vertex", undefined],
      ["kb_fs_u_refResolution", "float", "fragment", "u_refResolution"],
    ]);
    // 存储按片元的 float 写、缺省 512；顶点那一半拷两个分量，第二个是下一个常量的存储（我们给 0），整场报不支持
    const issues = new Set<string>();
    expect(shaderUniforms(result, {}, {}, undefined, undefined, issues)).toEqual({
      u_refResolution: [512, 0],
      kb_fs_u_refResolution: [512],
    });
    expect([...issues]).toEqual(["constant:mixed-type:Reference resolution"]);
    // float setter 不收字符串，键在就不补缺省：两半都是 0；属性值走同一个 float setter
    expect(shaderUniforms(result, { constantshadervalues: { "Reference resolution": "1920 1080" } }, {})).toEqual({
      u_refResolution: [0, 0],
      kb_fs_u_refResolution: [0],
    });
    expect(shaderUniforms(result, { usershadervalues: { res: "Reference resolution" } }, { res: 800 })).toEqual({
      u_refResolution: [800, 0],
      kb_fs_u_refResolution: [800],
    });
    // 改名的一格带 material：能力表不报 uniform:*
    const program = new Set<string>();
    checkProgramFeatures(result, program);
    expect([...program]).toEqual([]);
  });

  it("同键同形、缺省值不同：合成一格，缺省取片元的（第 6 节 stage-def）", async () => {
    const result = await (
      await translator()
    ).translate({
      vertex: `uniform float g_Phase; // {"material":"phase","default":0}\nvoid main() { gl_Position = vec4(g_Phase); }`,
      fragment: `uniform float g_Phase; // {"material":"phase","default":0.5}\nvoid main() { gl_FragColor = vec4(g_Phase); }`,
    });
    expect(result.uniforms?.map((u) => [u.name, u.stage, u.meta?.default])).toEqual([["g_Phase", undefined, 0.5]]);
    const issues = new Set<string>();
    expect(shaderUniforms(result, {}, {}, undefined, undefined, issues)).toEqual({ g_Phase: [0.5] });
    expect(shaderUniforms(result, { constantshadervalues: { phase: 2 } }, {}, undefined, undefined, issues)).toEqual({
      g_Phase: [2],
    });
    expect([...issues]).toEqual([]);
  });

  it("同一阶段两个不同名字共用一个键（clipping_mask 的 1texOffset）：按用户决定两个都照常填，各按自己的类型", async () => {
    const result = await (
      await translator()
    ).translate({
      vertex: `uniform float u_texOffset; // {"default":"0","material":"1texOffset"}
uniform vec2 u_texOffset2; // {"default":"0 0","linked":true,"material":"1texOffset"}
void main() { gl_Position = vec4(u_texOffset2, u_texOffset, 1.0); }`,
      fragment: "void main() { gl_FragColor = vec4(1.0); }",
    });
    expect(result.uniforms?.map((u) => [u.name, u.stage])).toEqual([
      ["u_texOffset", undefined],
      ["u_texOffset2", undefined],
    ]);
    // WPE 只上传后声明的那个（第 6 节 dup-*），不复刻；各按自己的 setter：float 不收字符串、向量铺满数字
    const issues = new Set<string>();
    expect(
      shaderUniforms(result, { constantshadervalues: { "1texOffset": "0.1 0.2" } }, {}, undefined, undefined, issues),
    ).toEqual({ u_texOffset: [0], u_texOffset2: [0.1, 0.2] });
    expect(shaderUniforms(result, { constantshadervalues: { "1texOffset": 0.3 } }, {})).toEqual({
      u_texOffset: [0.3],
      u_texOffset2: [0.3, 0.3],
    });
    expect([...issues]).toEqual([]);
  });
});

/** 按 WPE 的查找顺序读一个着色器对（`dir` 是它所在的 `shaders/` 目录），头文件从 assets/shaders 读。 */
async function translateAsset(
  dir: string,
  shader: string,
  combos: TranslateRequest["combos"] = {},
): Promise<TranslateResult> {
  const read = (path: string) => readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  return translateWithIncludes(
    await translator(),
    {
      vertex: read(join(dir, `${shader}.vert`)),
      fragment: read(join(dir, `${shader}.frag`)),
      combos,
      textures: [{ slot: 0, format: 0 }],
    },
    async (name) => {
      const path = join(assets, "shaders", name);
      return existsSync(path) ? read(path) : null;
    },
  );
}

/** 内存里的项目文件盖在磁盘之上（其余路径照常读 WPE 安装目录）。 */
function overlayReader(files: Record<string, string>): SceneReader {
  const own = (path: string) => {
    const text = files[path.replace(/\\/g, "/")];
    return text === undefined ? null : new TextEncoder().encode(text);
  };
  const disk = (path: string) => {
    try {
      return new Uint8Array(readFileSync(path));
    } catch {
      throw new TypeError("Failed to fetch");
    }
  };
  return {
    async readWhole(path) {
      return own(path) ?? disk(path);
    },
    async readRange(path, start, end) {
      const bytes = own(path) ?? disk(path);
      if (start >= bytes.length) throw new TypeError("Failed to fetch");
      return bytes.slice(start, end);
    },
  };
}

describe.skipIf(!root || !existsSync(wasm))("两阶段同名 uniform：本机 WPE 着色器", () => {
  it("foliagesway：片元的速度取 speeduv（缺省 5），phase 两格各自缺省、给值时写同一个值", async () => {
    const result = await translateAsset(join(assets, "effects", "foliagesway", "shaders"), "effects/foliagesway");
    expect(result.ok, JSON.stringify(result.errors)).toBe(true);
    expect(pick(result, "g_Speed")).toMatchObject({ stage: "vertex", meta: { material: "speed", default: 1 } });
    expect(pick(result, "kb_fs_g_Speed")).toMatchObject({
      stage: "fragment",
      original: "g_Speed",
      meta: { material: "speeduv", default: 5 },
    });
    // phase 同键：合成一格，缺省取片元的 0.5（第 6 节 stage-def）
    expect(pick(result, "g_Phase")).toMatchObject({ meta: { material: "phase", default: 0.5 } });
    expect(pick(result, "g_Phase").stage).toBeUndefined();
    // UV 模式（MODE 0，缺省）片元只读改名的那一格（两处引用都改了，一处没读顶点那一格）；顶点模式（MODE 1）顶点读原名那一格
    expect(result.fragment?.wgsl).toMatch(/\.kb_fs_g_Speed\b/);
    expect(result.fragment?.wgsl).not.toMatch(/\.g_Speed\b/);
    const vertexMode = await translateAsset(join(assets, "effects", "foliagesway", "shaders"), "effects/foliagesway", {
      MODE: 1,
    });
    expect(vertexMode.vertex?.wgsl).toMatch(/\.g_Speed\b/);
    expect(vertexMode.vertex?.wgsl).not.toMatch(/\.kb_fs_g_Speed\b/);
    const names = ["g_Speed", "kb_fs_g_Speed", "g_Phase"];
    expect(only(shaderUniforms(result, {}, {}), names)).toEqual({
      g_Speed: [1],
      kb_fs_g_Speed: [5],
      g_Phase: [0.5],
    });
    // 材质给 speed 只改顶点那一格；给 speeduv 只改片元那一格；给 phase 改合成的那一格
    expect(only(shaderUniforms(result, { constantshadervalues: { speed: 3, phase: 0.25 } }, {}), names)).toEqual({
      g_Speed: [3],
      kb_fs_g_Speed: [5],
      g_Phase: [0.25],
    });
    expect(only(shaderUniforms(result, { constantshadervalues: { speeduv: 7 } }, {}), names)).toMatchObject({
      g_Speed: [1],
      kb_fs_g_Speed: [7],
    });
    // 打包进块后两格在不同偏移、各是各的值
    const values = shaderUniforms(result, {}, {});
    const block = new UniformBlock(result.uniforms ?? [], result.uniformBlockSize ?? 0);
    for (const [name, value] of Object.entries(values)) block.set(name, value);
    expect([readF32(result, block, "g_Speed"), readF32(result, block, "kb_fs_g_Speed")]).toEqual([1, 5]);
    expect(readF32(result, block, "g_Phase")).toBe(0.5);
    const program = new Set<string>();
    checkProgramFeatures(result, program);
    expect([...program]).toEqual([]);
  });

  it("perspective（effect 预览项目自带的旧版）：四个边同键合成一格，缺省取片元的 1", async () => {
    const result = await translateAsset(
      join(assets, "effects", "perspective", "preview", "shaders"),
      "effects/perspective",
    );
    expect(result.ok, JSON.stringify(result.errors)).toBe(true);
    const sides = ["Top", "Bottom", "Left", "Right"];
    const values = shaderUniforms(result, {}, {});
    for (const side of sides) {
      expect(pick(result, `g_${side}`)).toMatchObject({ meta: { material: side, default: 1 } });
      expect(
        result.uniforms?.some((u) => u.name === `kb_fs_g_${side}`),
        side,
      ).toBe(false);
      expect(values[`g_${side}`], side).toEqual([1]);
    }
    // 预览场景给了值：取材质值
    expect(shaderUniforms(result, { constantshadervalues: { Top: 0.29 } }, {}).g_Top).toEqual([0.29]);
  });

  it("clouds：两侧的 g_CloudSpeeds 由 PERSPECTIVE 分开，任一取值下都只有一格、不拆（本机版本没有同时可达的冲突）", async () => {
    const dir = join(assets, "effects", "clouds", "shaders");
    const flat = await translateAsset(dir, "effects/clouds", { PERSPECTIVE: 0 });
    expect(flat.ok, JSON.stringify(flat.errors)).toBe(true);
    expect(
      flat.uniforms?.filter((u) => u.meta?.material === "speed").map((u) => [u.name, u.declared, u.stage]),
    ).toEqual([["g_CloudSpeeds", "vec2", undefined]]);
    expect(only(shaderUniforms(flat, {}, {}), ["g_CloudSpeeds"])).toEqual({ g_CloudSpeeds: [0.01, -0.02] });
    const perspective = await translateAsset(dir, "effects/clouds", { PERSPECTIVE: 1 });
    expect(perspective.ok, JSON.stringify(perspective.errors)).toBe(true);
    expect(
      perspective.uniforms?.filter((u) => u.meta?.material === "speed").map((u) => [u.name, u.declared, u.stage]),
    ).toEqual([["g_CloudSpeeds", "vec4", undefined]]);
  });

  it("整场编译：foliagesway 的 phase 绑用户属性，就地写与整场重编译一致", async () => {
    const projectDir = join(root!, "kb-test-stage-uniforms").replace(/\\/g, "/");
    const scene = (phase: number) =>
      JSON.stringify({
        general: { orthogonalprojection: { width: 64, height: 64 } },
        objects: [
          {
            id: 1,
            name: "sway",
            image: "models/util/solidlayer.json",
            origin: "32 32 0",
            size: "64 64",
            effects: [
              {
                file: "effects/foliagesway/effect.json",
                id: 2,
                passes: [{ id: 3, constantshadervalues: { speed: 2, phase: { user: "ph", value: phase } } }],
              },
            ],
          },
        ],
      });
    const project = JSON.stringify({ file: "scene.json", type: "scene", general: { properties: {} } });
    const compile = (userProperties: Record<string, unknown>) =>
      translator().then((wasmTranslator) =>
        compileScene({
          projectDir,
          sceneAssets: [assets],
          reader: overlayReader({ [`${projectDir}/project.json`]: project, [`${projectDir}/scene.json`]: scene(0.1) }),
          translator: wasmTranslator,
          postprocess: "disabled",
          userProperties,
        }),
      );
    const bundle = await compile({ ph: 0.3 });
    expect(bundle.unsupported.filter((key) => /^(uniform|constant|shader):/.test(key))).toEqual([]);
    const step = bundle.layers[0].effects[0].steps.find((s) => s.kind === "draw");
    if (step?.kind !== "draw") throw new Error("foliagesway 没有绘制步骤");
    expect(only(step.pass.uniforms, ["g_Speed", "kb_fs_g_Speed", "g_Phase"])).toEqual({
      g_Speed: [2],
      kb_fs_g_Speed: [5],
      g_Phase: [0.3],
    });
    const binding = bundle.bindings.find((b: SceneBinding) => b.property === "ph");
    expect(binding?.target).toMatchObject({ kind: "constant", material: "phase", uniforms: ["g_Phase"] });
    const state = SceneState.fromBundle(bundle);
    expect(state.write(binding!, 0.9)).toBe("applied");
    const constants = state.constants.get(step.pass.key)!;
    expect([constants.g_Phase, constants.kb_fs_g_Speed]).toEqual([[0.9], [5]]);
    // 就地写的结果 = 用新值整场重编译的结果
    const fresh = await compile({ ph: 0.9 });
    const freshStep = fresh.layers[0].effects[0].steps.find((s) => s.kind === "draw");
    if (freshStep?.kind !== "draw") throw new Error("foliagesway 没有绘制步骤");
    expect(only(constants, ["g_Phase"])).toEqual(only(freshStep.pass.uniforms, ["g_Phase"]));
  }, 60000);
});
