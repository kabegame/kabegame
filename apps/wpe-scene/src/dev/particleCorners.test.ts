import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { compileScene } from "../compile/bundle";
import type { SceneReader } from "../compile/fs";
import { ropeVertexLayout } from "../particles/rope";
import { trailVertexLayout } from "../particles/ropetrail";
import { programVertexPacking, vertexPacking } from "../render/programs";
import { shakeOffset } from "../render/shake";
import { translateWithIncludes, Wpesl2wgsl } from "../wpesl2wgsl";
import { cornerInputs, frameCamera, replayParticles, rewriteVertexAsCompute } from "./particleCorners";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

/** naga GLSL 前端输出的形状（摘自翻译后的 `genericparticle` 顶点 WGSL，主体只留一行）。 */
const NAGA_VERTEX = `struct KbUniforms {
    g_ModelViewProjectionMatrix: mat4x4<f32>,
    g_Texture0Resolution: vec4<f32>,
}

struct VertexOutput {
    @location(0) v_Color: vec4<f32>,
    @location(1) v_TexCoord: vec2<f32>,
    @builtin(position) gl_Position: vec4<f32>,
}

@group(0) @binding(0)
var<uniform> global: KbUniforms;
var<private> a_Position_1: vec3<f32>;
var<private> a_TexCoordVec4_1: vec4<f32>;
var<private> a_Color_1: vec4<f32>;
var<private> a_TexCoordC2_1: vec2<f32>;
var<private> v_Color: vec4<f32>;
var<private> v_TexCoord: vec2<f32>;
var<private> gl_Position: vec4<f32>;

fn main_1() {
    gl_Position = (global.g_ModelViewProjectionMatrix * vec4<f32>(a_Position_1, 1f));
    return;
}

@vertex
fn main(@location(0) a_Position: vec3<f32>, @location(1) a_TexCoordVec4_: vec4<f32>, @location(2) a_Color: vec4<f32>, @location(3) a_TexCoordC2_: vec2<f32>) -> VertexOutput {
    a_Position_1 = a_Position;
    a_TexCoordVec4_1 = a_TexCoordVec4_;
    a_Color_1 = a_Color;
    a_TexCoordC2_1 = a_TexCoordC2_;
    main_1();
    let _e55 = v_Color;
    let _e57 = v_TexCoord;
    let _e59 = gl_Position;
    return VertexOutput(_e55, _e57, _e59);
}
`;

const TRANSLATED = [
  { name: "a_Position", location: 0, type: "vec3" },
  { name: "a_TexCoordVec4", location: 1, type: "vec4" },
  { name: "a_Color", location: 2, type: "vec4" },
  { name: "a_TexCoordC2", location: 3, type: "vec2" },
];

describe("顶点着色器改写成计算着色器（风险 7 的验收工具）", () => {
  const inputs = cornerInputs(vertexPacking(TRANSLATED).attributes);

  it("输入表：float 偏移按顶点打包", () => {
    expect(inputs).toEqual([
      { location: 0, offset: 0, components: 3, kind: "f32" },
      { location: 1, offset: 3, components: 4, kind: "f32" },
      { location: 2, offset: 7, components: 4, kind: "f32" },
      { location: 3, offset: 11, components: 2, kind: "f32" },
    ]);
  });

  it("入口变成普通函数：去掉 @vertex 与参数的 IO 属性、改名；主体与入口之前的代码逐字不变", () => {
    const out = rewriteVertexAsCompute(NAGA_VERTEX, "main", inputs, 13);
    expect(out).not.toContain("@vertex");
    expect(out).toContain(
      "fn kb_corner_vertex(a_Position: vec3<f32>, a_TexCoordVec4_: vec4<f32>, a_Color: vec4<f32>, a_TexCoordC2_: vec2<f32>) -> VertexOutput {",
    );
    const entry = NAGA_VERTEX.indexOf("@vertex");
    expect(out.startsWith(NAGA_VERTEX.slice(0, entry))).toBe(true);
    const body = NAGA_VERTEX.slice(NAGA_VERTEX.indexOf("{", NAGA_VERTEX.indexOf("-> VertexOutput")));
    expect(out).toContain(body);
    // 只有一个入口，是计算入口
    expect(out.match(/@compute/g)).toHaveLength(1);
    expect(out).not.toMatch(/\bfn main\(/);
  });

  it("计算入口：按布局从存储缓冲读各输入，写回 @builtin(position) 那个成员", () => {
    const out = rewriteVertexAsCompute(NAGA_VERTEX, "main", inputs, 13);
    expect(out).toContain("@group(1) @binding(0) var<storage, read> kb_corner_in: array<f32>;");
    expect(out).toContain("@group(1) @binding(1) var<storage, read_write> kb_corner_out: array<vec4<f32>>;");
    expect(out).toContain(
      "@compute @workgroup_size(64)\nfn kb_corner_main(@builtin(global_invocation_id) kb_corner_id: vec3<u32>) {",
    );
    expect(out).toContain("let kb_corner_base = kb_corner_index * 13u;");
    const r = (k: number) => `kb_corner_in[kb_corner_base + ${k}u]`;
    expect(out).toContain(
      `let kb_corner_result = kb_corner_vertex(vec3<f32>(${r(0)}, ${r(1)}, ${r(2)}), vec4<f32>(${r(3)}, ${r(4)}, ${r(5)}, ${r(6)}), vec4<f32>(${r(7)}, ${r(8)}, ${r(9)}, ${r(10)}), vec2<f32>(${r(11)}, ${r(12)}));`,
    );
    expect(out).toContain("kb_corner_out[kb_corner_index] = kb_corner_result.gl_Position;");
    expect(out).toContain("if (kb_corner_index >= arrayLength(&kb_corner_out)) {");
  });

  it("返回值本身是 @builtin(position)、标量与整数输入、vertex_index 参数", () => {
    const source = `fn helper() {}
@vertex
fn vs(@builtin(vertex_index) index: u32, @location(1) size: f32, @location(0) id: vec2<i32>) -> @invariant @builtin(position) vec4<f32> {
    return vec4<f32>(size);
}
`;
    const out = rewriteVertexAsCompute(
      source,
      "vs",
      [
        { location: 0, offset: 0, components: 2, kind: "i32" },
        { location: 1, offset: 2, components: 1, kind: "f32" },
      ],
      3,
    );
    expect(out).toContain("fn kb_corner_vertex(index: u32, size: f32, id: vec2<i32>) -> vec4<f32> {");
    expect(out).toContain(
      "kb_corner_vertex(kb_corner_index, kb_corner_in[kb_corner_base + 2u], vec2<i32>(bitcast<i32>(kb_corner_in[kb_corner_base + 0u]), bitcast<i32>(kb_corner_in[kb_corner_base + 1u])));",
    );
    expect(out).toContain("kb_corner_out[kb_corner_index] = kb_corner_result;");
  });

  it("结构不认识时抛错，不生成半截着色器", () => {
    expect(() => rewriteVertexAsCompute(NAGA_VERTEX, "vs", inputs, 13)).toThrow("找不到顶点入口 vs");
    expect(() => rewriteVertexAsCompute(NAGA_VERTEX, "main", inputs.slice(0, 2), 13)).toThrow("location 2");
    expect(() =>
      rewriteVertexAsCompute(
        NAGA_VERTEX.replace("@builtin(position) gl_Position", "@location(9) gl_Position"),
        "main",
        inputs,
        13,
      ),
    ).toThrow("@builtin(position)");
    expect(() => rewriteVertexAsCompute(NAGA_VERTEX + "\nfn kb_corner_x() {}", "main", inputs, 13)).toThrow(
      "kb_corner_",
    );
  });

  describe("几何着色器展开（rope，P4d 步骤 1）", () => {
    /** 翻译器展开 `.geom` 后的形状（摘自 `genericropeparticle` 的顶点 WGSL，主体只留一行）。 */
    const ROPE_VERTEX = `struct VertexOutput {
    @location(0) v_TexCoord: vec2<f32>,
    @location(1) v_Color: vec4<f32>,
    @builtin(position) gl_Position: vec4<f32>,
}

var<private> a_PositionVec4_1: vec4<f32>;
var<private> v_TexCoord: vec2<f32>;
var<private> v_Color: vec4<f32>;
var<private> gl_Position: vec4<f32>;
var<private> gl_VertexIndex_1: u32;

fn main_1() {
    gl_Position = a_PositionVec4_1;
    return;
}

@vertex
fn main(@location(0) a_PositionVec4_: vec4<f32>, @location(1) a_TexCoordVec4_: vec4<f32>, @builtin(vertex_index) gl_VertexIndex: u32, @builtin(instance_index) gl_InstanceIndex: u32) -> VertexOutput {
    a_PositionVec4_1 = a_PositionVec4_;
    gl_VertexIndex_1 = gl_VertexIndex;
    main_1();
    let _e1 = v_TexCoord;
    let _e2 = v_Color;
    let _e3 = gl_Position;
    return VertexOutput(_e1, _e2, _e3);
}
`;
    const ropeInputs = cornerInputs(
      vertexPacking(
        [
          { name: "a_PositionVec4", location: 0, type: "vec4" },
          { name: "a_TexCoordVec4", location: 1, type: "vec4" },
        ],
        "instance",
      ).attributes,
    );
    const rewrite = () =>
      rewriteVertexAsCompute(ROPE_VERTEX, "main", ropeInputs, 8, {
        maxVertices: 10,
        outputs: ["v_TexCoord", "v_Color"],
      });

    it("第 id 个调用是第 id / maxVertices 段的第 id % maxVertices 个顶点；按段读输入", () => {
      const out = rewrite();
      expect(out).toContain("let kb_corner_base = (kb_corner_index / 10u) * 8u;");
      const r = (k: number) => `kb_corner_in[kb_corner_base + ${k}u]`;
      expect(out).toContain(
        `let kb_corner_result = kb_corner_vertex(vec4<f32>(${r(0)}, ${r(1)}, ${r(2)}, ${r(3)}), vec4<f32>(${r(4)}, ${r(5)}, ${r(6)}, ${r(7)}), (kb_corner_index % 10u), (kb_corner_index / 10u));`,
      );
    });

    it("每个顶点写 3 项：位置、uv（补成 vec4）、颜色；上界按项数除", () => {
      const out = rewrite();
      expect(out).toContain("if (kb_corner_index >= arrayLength(&kb_corner_out) / 3u) {");
      expect(out).toContain("kb_corner_out[kb_corner_index * 3u + 0u] = kb_corner_result.gl_Position;");
      expect(out).toContain(
        "kb_corner_out[kb_corner_index * 3u + 1u] = vec4<f32>(kb_corner_result.v_TexCoord, 0f, 0f);",
      );
      expect(out).toContain("kb_corner_out[kb_corner_index * 3u + 2u] = kb_corner_result.v_Color;");
      expect(out).not.toContain("kb_corner_out[kb_corner_index] =");
    });

    it("要的成员不存在、入口只返回位置时抛错", () => {
      expect(() =>
        rewriteVertexAsCompute(ROPE_VERTEX, "main", ropeInputs, 8, { maxVertices: 10, outputs: ["v_Missing"] }),
      ).toThrow("v_Missing");
      expect(() =>
        rewriteVertexAsCompute(
          "@vertex\nfn vs(@location(0) p: vec4<f32>) -> @builtin(position) vec4<f32> {\n    return p;\n}\n",
          "vs",
          [{ location: 0, offset: 0, components: 4, kind: "f32" }],
          4,
          { outputs: ["v_Color"] },
        ),
      ).toThrow("v_Color");
    });
  });

  it("回放：前 n−1 帧只步进，最后一帧的时间是累计值、帧时间是最后一个 dt", () => {
    const steps: number[] = [];
    const scene = { stepParticles: (dt: number) => void steps.push(dt) };
    expect(replayParticles(scene, {} as never, { dts: [0.1, 0.2, 0.05] })).toEqual({
      time: 0.1 + 0.2 + 0.05,
      frametime: 0.05,
    });
    expect(steps).toEqual([0.1, 0.2]);
    expect(replayParticles(scene, {} as never, undefined, 3)).toEqual({ time: 3, frametime: 0 });
    expect(replayParticles(scene, {} as never, { dts: [] }, 3)).toEqual({ time: 3, frametime: 0 });
  });

  it("回放的相机（P5a 步骤 3、4）：afterStep 在每帧步进之后收到这一帧的 g_Time；frameCamera 按它设 s、带上状态里的 zoom，并记下每帧的 eye", () => {
    const calls: string[] = [];
    const scene = {
      stepParticles: (dt: number, time: number) => void calls.push(`step ${dt} ${time}`),
      setCamera: ({ shake, zoom }: { shake: readonly [number, number]; zoom: number }) =>
        void calls.push(`shake ${shake.join(" ")} zoom ${zoom}`),
    };
    const general = {
      camerashake: true,
      camerashakespeed: 1,
      camerashakeamplitude: 1,
      camerashakeroughness: 1,
      zoom: 1.5,
    };
    const shake = frameCamera(scene, { general } as never, 1080);
    const { time } = replayParticles(
      scene,
      {} as never,
      { dts: [0.1, 0.2, 0.05], times: [5, 5.2, 5.25] },
      0,
      [0.5, 0.5],
      (t) => {
        calls.push(`after ${t}`);
        shake.apply(t);
      },
    );
    // 读回帧：调用方先步进，再设这一帧的 s
    scene.stepParticles(0.05, time);
    shake.apply(time);
    const s = (t: number) => shakeOffset(general, t, 1080);
    // 每一帧的粒子先用上一帧的 s 步进（第一帧是加载时的 0），再换上这一帧的
    expect(calls).toEqual([
      "step 0.1 5",
      "after 5",
      `shake ${s(5).join(" ")} zoom 1.5`,
      "step 0.2 5.2",
      "after 5.2",
      `shake ${s(5.2).join(" ")} zoom 1.5`,
      "step 0.05 5.25",
      `shake ${s(5.25).join(" ")} zoom 1.5`,
    ]);
    expect(shake.eyes).toEqual([s(5), s(5.2), s(5.25)]);
  });
});

const root = process.env.KABEGAME_WPE_ROOT;
const wasm = join(__dirname, "..", "wpesl2wgsl", "wpesl2wgsl.wasm");
const diskReader: SceneReader = {
  async readWhole(path) {
    try {
      return new Uint8Array(readFileSync(path));
    } catch {
      throw new TypeError("Failed to fetch");
    }
  },
  async readRange(path, start, end) {
    return (await diskReader.readWhole(path)).slice(start, end);
  },
};

describe.skipIf(!root || !existsSync(wasm))("本机样本：翻译出的粒子顶点着色器都能改写", () => {
  it("shimmering_particles 的两个粒子程序（项目 particle，含 WORLDBLUR 变体）", async () => {
    const bundle = await compileScene({
      projectDir: join(root!, "projects", "defaultprojects", "shimmering_particles"),
      sceneAssets: [join(root!, "assets")],
      reader: diskReader,
      translator: await Wpesl2wgsl.fromBytes(readFileSync(wasm)),
      postprocess: "disabled",
      exhaustive: true,
    });
    const programs = new Set(
      bundle.layers.flatMap((layer) => layer.particle?.passes.map((pass) => pass.program) ?? []),
    );
    expect(programs.size).toBe(2);
    for (const index of programs) {
      const result = bundle.programs[index!];
      const packing = vertexPacking(result.attributes ?? []);
      const out = rewriteVertexAsCompute(
        result.vertex!.wgsl!,
        result.vertex!.entryPoint!,
        cornerInputs(packing.attributes),
        Number(packing.layout.arrayStride) / 4,
      );
      expect(out).toContain("fn kb_corner_main(");
      expect(out).toContain("kb_corner_out[kb_corner_index] = kb_corner_result.gl_Position;");
      expect(out).not.toContain("@vertex");
    }
  }, 60000);

  it("WPE 的 genericropeparticle 带 .geom 翻译（P4d 步骤 1）：6 个 vec4 输入、maxVertices = 4 + 2·3，按段改写并写出 uv、颜色", async () => {
    const shaders = join(root!, "assets", "shaders");
    const read = (name: string) => readFileSync(join(shaders, name), "utf8");
    const result = await translateWithIncludes(
      await Wpesl2wgsl.fromBytes(readFileSync(wasm)),
      {
        vertex: read("genericropeparticle.vert"),
        fragment: read("genericropeparticle.frag"),
        geometry: read("genericropeparticle.geom"),
        defines: { THICKFORMAT: "1", TRAILSUBDIVISION: "3", ORIENTATION: "0", SCENE_ORTHO: "1" },
      },
      async (name) => (existsSync(join(shaders, name)) ? read(name) : null),
    );
    expect(result.ok, JSON.stringify(result.errors)).toBe(true);
    expect(result.geometry).toEqual({ maxVertices: 10 });
    const packing = programVertexPacking(result);
    expect(packing.layout.stepMode).toBe("instance");
    const { layout, problems } = ropeVertexLayout(packing);
    expect(problems).toEqual([]);
    expect(layout.stride).toBe(24);
    const out = rewriteVertexAsCompute(
      result.vertex!.wgsl!,
      result.vertex!.entryPoint!,
      cornerInputs(packing.attributes),
      layout.stride,
      { maxVertices: 10, outputs: ["v_TexCoord", "v_Color"] },
    );
    expect(out).toContain("kb_corner_out[kb_corner_index * 3u + 2u] = kb_corner_result.v_Color;");
    expect(out).toContain("(kb_corner_index % 10u)");
    expect(out).not.toContain("@vertex");
  }, 60000);

  it("WPE 的 genericropeparticle 按 ropetrail 的宏翻译（P4d 步骤 2）：5 个输入（含 vec3 的 a_TexCoordVec3C2）、步长 19、maxVertices = 4 + 2·1；按段改写、vec3 读 3 个分量", async () => {
    const shaders = join(root!, "assets", "shaders");
    const read = (name: string) => readFileSync(join(shaders, name), "utf8");
    for (const scroll of [false, true]) {
      const result = await translateWithIncludes(
        await Wpesl2wgsl.fromBytes(readFileSync(wasm)),
        {
          vertex: read("genericropeparticle.vert"),
          fragment: read("genericropeparticle.frag"),
          geometry: read("genericropeparticle.geom"),
          defines: {
            TRAILSUBDIVISION: "1",
            ORIENTATION: "0",
            TRAILRENDERER: "1",
            SCENE_ORTHO: "1",
            ...(scroll ? { TRAILSCROLLALPHA: "1", TRAILFADEALPHA: "1", TRAILFADESIZE: "1" } : {}),
          },
        },
        async (name) => (existsSync(join(shaders, name)) ? read(name) : null),
      );
      expect(result.ok, JSON.stringify(result.errors)).toBe(true);
      expect(result.geometry).toEqual({ maxVertices: 6 });
      const packing = programVertexPacking(result);
      expect(packing.layout.stepMode).toBe("instance");
      const { layout, problems } = trailVertexLayout(packing);
      expect(problems).toEqual([]);
      // WPE 76 字节一段（rea-p4d-rope.md 1.3）
      expect(layout.stride).toBe(19);
      const inputs = cornerInputs(packing.attributes);
      const out = rewriteVertexAsCompute(result.vertex!.wgsl!, result.vertex!.entryPoint!, inputs, layout.stride, {
        maxVertices: 6,
        outputs: ["v_TexCoord", "v_Color"],
      });
      const cp1 = inputs.find((input) => input.offset === layout.cp1)!;
      expect(cp1.components).toBe(3);
      expect(out).toContain(
        `vec3<f32>(kb_corner_in[kb_corner_base + ${layout.cp1}u], kb_corner_in[kb_corner_base + ${layout.cp1 + 1}u], ` +
          `kb_corner_in[kb_corner_base + ${layout.cp1 + 2}u])`,
      );
      expect(out).toContain("(kb_corner_index % 6u)");
      expect(out).not.toContain("@vertex");
    }
  }, 60000);
});
