import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Wpesl2wgsl, translateWithIncludes } from "./index";

// wasm 由 `deno task build:wpesl2wgsl` 产出、kabegame 命令拷进本目录；没有就跳过
const WASM = fileURLToPath(new URL("./wpesl2wgsl.wasm", import.meta.url));

const VERTEX = `
#include "common_vertex.h"
uniform mat4 g_ModelViewProjectionMatrix;
attribute vec3 a_Position;
attribute vec2 a_TexCoord;
varying vec2 v_TexCoord;
void main() {
  gl_Position = mul(vec4(a_Position, 1.0), g_ModelViewProjectionMatrix);
  v_TexCoord = a_TexCoord;
}
`;

const FRAGMENT = `
// [COMBO] {"combo":"TINT","default":0}
uniform sampler2D g_Texture0;
#if TINT
uniform vec3 g_Color1; // {"material":"color1","default":"0 0 0"}
#endif
varying vec2 v_TexCoord;
void main() {
  gl_FragColor = texSample2D(g_Texture0, v_TexCoord);
#if TINT
  gl_FragColor.rgb *= g_Color1;
#endif
}
`;

describe.skipIf(!existsSync(WASM))("wpesl2wgsl wasm", () => {
  const load = () => Wpesl2wgsl.fromBytes(readFileSync(WASM));

  it("按需补头文件后翻译成 WGSL", async () => {
    const translator = await load();
    const requested: string[] = [];
    const result = await translateWithIncludes(
      translator,
      { vertex: VERTEX, fragment: FRAGMENT, combos: { tint: true }, textures: [{ slot: 0, format: 0 }] },
      async (name) => {
        requested.push(name);
        return name === "common_vertex.h" ? "vec2 helper(vec2 v) { return frac(v); }\n" : null;
      },
    );
    expect(requested).toEqual(["common_vertex.h"]);
    expect(result.ok).toBe(true);
    expect(result.vertex?.wgsl).toContain("@vertex");
    expect(result.fragment?.wgsl).toContain("@fragment");
    expect(result.uniforms?.map((u) => u.name)).toEqual(["g_ModelViewProjectionMatrix", "g_Color1"]);
    expect(result.uniforms?.[1].meta?.material).toBe("color1");
    expect(result.textures?.[0]).toMatchObject({ slot: 0, binding: 1, samplerBinding: 2 });
    expect(result.attributes?.map((a) => [a.name, a.location])).toEqual([
      ["a_Position", 0],
      ["a_TexCoord", 1],
    ]);
  });

  it("读不到头文件时返回缺失清单", async () => {
    const result = await translateWithIncludes(await load(), { vertex: VERTEX, fragment: FRAGMENT }, async () => null);
    expect(result.ok).toBe(false);
    expect(result.phase).toBe("include");
    expect(result.missing).toEqual(["common_vertex.h"]);
  });

  it("诊断里带出错阶段与生成的 GLSL", async () => {
    const result = await (
      await load()
    ).translate({
      vertex: "void main() { gl_Position = vec4(0); }",
      fragment: "void main() { gl_FragColor = undefined_call(); }",
    });
    expect(result.ok).toBe(false);
    expect(result.phase).toBe("parse");
    expect(result.stage).toBe("fragment");
    expect(result.fragment?.glsl).toContain("#version 450");
  });
});
