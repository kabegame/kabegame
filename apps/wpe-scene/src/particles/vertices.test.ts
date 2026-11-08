import { describe, expect, it } from "vitest";
import { vertexPacking } from "../render/programs";
import { ParticleColumns } from "./columns";
import { COLUMN_FLAGS } from "./modules";
import {
  CORNER_UVS,
  particleVertexLayout,
  QUAD_INDICES,
  quadIndices,
  writeVertices,
  type ParticleVertexLayout,
} from "./vertices";

/** 翻译器给 `genericparticle` 反射出的输入顺序（位置、a_TexCoordVec4、颜色、a_TexCoordC2）。 */
const TRANSLATED = [
  { name: "a_Position", location: 0, type: "vec3" },
  { name: "a_TexCoordVec4", location: 1, type: "vec4" },
  { name: "a_Color", location: 2, type: "vec4" },
  { name: "a_TexCoordC2", location: 3, type: "vec2" },
];
/** WPE 项目自定义 `particle` 的实测布局顺序：POSITION、TEXCOORD0、TEXCOORD2、COLOR。 */
const WPE_ORDER = [
  { name: "a_Position", location: 0, type: "vec3" },
  { name: "a_TexCoordVec4", location: 1, type: "vec4" },
  { name: "a_TexCoordC2", location: 2, type: "vec2" },
  { name: "a_Color", location: 3, type: "vec4" },
];

/** 一个 3 槽的系统：槽 1 是空槽，槽 0、2 存活；旋转三轴分列（bit0）。 */
function threeSlots() {
  const columns = new ParticleColumns(3, COLUMN_FLAGS.rotationYZ | COLUMN_FLAGS.color | COLUMN_FLAGS.alpha);
  const set = (slot: number, base: number) => {
    columns.life[slot] = 1;
    for (let i = 0; i < 3; i++) {
      columns.position[i][slot] = base + i; // x、y、z = base、base+1、base+2
      columns.rotation[i][slot] = base / 10 + i / 100; // x、y、z = base/10 + 0、0.01、0.02
      columns.color[i][slot] = (i + 1) / 10;
    }
    columns.size[slot] = base * 2;
    columns.alpha[slot] = 0.5;
  };
  set(0, 10);
  set(2, 30);
  columns.position[0][1] = 999; // 空槽里的残值不能被写出去
  return { columns, highWater: 3 };
}

describe("粒子顶点布局", () => {
  it("偏移按翻译器反射的 attributes 排：位置 0、a_TexCoordVec4 3、颜色 7、a_TexCoordC2 11，步长 13 个 float（52 字节）", () => {
    const { layout, problems } = particleVertexLayout(vertexPacking(TRANSLATED));
    expect(problems).toEqual([]);
    expect(layout).toEqual({ stride: 13, position: 0, texCoord: 3, color: 7, rotation: 11, thick: -1 });
  });

  it("换成 WPE 的输入顺序，字节偏移就是实测的 0、12、28、36，步长 52", () => {
    const { layout } = particleVertexLayout(vertexPacking(WPE_ORDER));
    expect([layout.position, layout.texCoord, layout.rotation, layout.color].map((o) => o * 4)).toEqual([
      0, 12, 28, 36,
    ]);
    expect(layout.stride * 4).toBe(52);
  });

  it("认不得的输入、分量数不对、整数类型都报 render:particle-attribute", () => {
    // 绳索的第三组属性（P4c）照报；厚格式的 a_TexCoordVec4C1 在 P4b 步骤 2 起认得
    expect(
      particleVertexLayout(vertexPacking([...TRANSLATED, { name: "a_TexCoordVec4C2", location: 4, type: "vec4" }]))
        .problems,
    ).toEqual(["render:particle-attribute:a_TexCoordVec4C2"]);
    expect(
      particleVertexLayout(vertexPacking([...TRANSLATED, { name: "a_TexCoordVec4C1", location: 4, type: "vec3" }]))
        .problems,
    ).toEqual(["render:particle-attribute:a_TexCoordVec4C1:3f32"]);
    expect(
      particleVertexLayout(
        vertexPacking([
          { name: "a_Position", location: 0, type: "vec4" },
          { name: "a_Color", location: 1, type: "ivec4" },
        ]),
      ).problems,
    ).toEqual(["render:particle-attribute:a_Position:4f32", "render:particle-attribute:a_Color:4i32"]);
  });

  it("着色器没声明的输入为 −1，不写", () => {
    const { layout } = particleVertexLayout(vertexPacking([{ name: "a_Position", location: 0, type: "vec3" }]));
    expect(layout).toEqual({ stride: 3, position: 0, texCoord: -1, rotation: -1, color: -1, thick: -1 });
  });
});

describe("writeVertices", () => {
  const read = (data: Float32Array, layout: ParticleVertexLayout, vertex: number) => {
    const o = vertex * layout.stride;
    return {
      position: Array.from(data.subarray(o + layout.position, o + layout.position + 3)),
      texCoord: Array.from(data.subarray(o + layout.texCoord, o + layout.texCoord + 4)),
      rotation: Array.from(data.subarray(o + layout.rotation, o + layout.rotation + 2)),
      color: Array.from(data.subarray(o + layout.color, o + layout.color + 4)),
    };
  };
  const f = Math.fround;

  for (const [label, attributes] of [
    ["翻译器顺序", TRANSLATED],
    ["WPE 顺序", WPE_ORDER],
  ] as const)
    it(`${label}：按槽序、跳过空槽，每粒子 4 个顶点，UV (0,0)(0,1)(1,1)(1,0)，旋转 z 与尺寸在 a_TexCoordVec4.zw`, () => {
      const { layout } = particleVertexLayout(vertexPacking(attributes));
      const system = threeSlots();
      const data = new Float32Array(3 * 4 * layout.stride).fill(-7);
      expect(writeVertices(system, layout, data)).toBe(2);
      // 槽 0 → 粒子 0，槽 2 → 粒子 1；槽 1（空槽）不出现
      for (const [particle, base] of [
        [0, 10],
        [1, 30],
      ])
        for (let corner = 0; corner < 4; corner++) {
          const vertex = read(data, layout, particle * 4 + corner);
          expect(vertex.position).toEqual([base, base + 1, base + 2]);
          expect(vertex.texCoord).toEqual([...CORNER_UVS[corner], f(base / 10 + 0.02), base * 2]);
          expect(vertex.rotation).toEqual([f(base / 10), f(base / 10 + 0.01)]);
          expect(vertex.color).toEqual([f(0.1), f(0.2), f(0.3), 0.5]);
        }
      // 第三个粒子的位置没写（保持原值）
      expect(data[2 * 4 * layout.stride]).toBe(-7);
    });

  it("没有 bit0 时旋转三轴是同一列，x、y、z 写同一个值", () => {
    const columns = new ParticleColumns(1, 0);
    columns.life[0] = 1;
    columns.rotation[2][0] = 0.25;
    const { layout } = particleVertexLayout(vertexPacking(TRANSLATED));
    const data = new Float32Array(4 * layout.stride);
    writeVertices({ columns, highWater: 1 }, layout, data);
    expect(read(data, layout, 0).rotation).toEqual([0.25, 0.25]);
    expect(read(data, layout, 0).texCoord[2]).toBe(0.25);
  });

  it("厚格式（P4b 步骤 2）：a_TexCoordVec4C1 = (速度 xyz, frame 原值)，4 个角相同、frame 不取小数，偏移按反射排", () => {
    // 带 THICKFORMAT 的翻译结果多一组输入；位置放在中间，偏移照样按反射算
    const thick = [
      { name: "a_Position", location: 0, type: "vec3" },
      { name: "a_TexCoordVec4", location: 1, type: "vec4" },
      { name: "a_TexCoordVec4C1", location: 2, type: "vec4" },
      { name: "a_Color", location: 3, type: "vec4" },
      { name: "a_TexCoordC2", location: 4, type: "vec2" },
    ];
    const { layout, problems } = particleVertexLayout(vertexPacking(thick));
    expect(problems).toEqual([]);
    // WPE 非 GS 厚格式是 68 字节（17 个 float），我们同样 17 个
    expect(layout).toEqual({ stride: 17, position: 0, texCoord: 3, thick: 7, color: 11, rotation: 15 });
    const system = threeSlots();
    const c = system.columns;
    for (const [slot, frame] of [
      [0, 1.75],
      [2, 0.25],
    ]) {
      c.velocity[0][slot] = 130 + slot;
      c.velocity[1][slot] = -5;
      c.velocity[2][slot] = 0.5;
      c.frame[slot] = frame;
    }
    const data = new Float32Array(3 * 4 * layout.stride);
    expect(writeVertices(system, layout, data)).toBe(2);
    for (const [particle, slot, frame] of [
      [0, 0, 1.75],
      [1, 2, 0.25],
    ])
      for (let corner = 0; corner < 4; corner++) {
        const o = (particle * 4 + corner) * layout.stride + layout.thick;
        expect(Array.from(data.subarray(o, o + 4))).toEqual([130 + slot, -5, 0.5, frame]);
      }
    // 没有帧表的着色器不声明这组输入：布局里为 −1，不写
    expect(particleVertexLayout(vertexPacking(TRANSLATED)).layout.thick).toBe(-1);
  });

  it("放不下的粒子不写，返回写了的个数；高水位之外的槽不看", () => {
    const { layout } = particleVertexLayout(vertexPacking(TRANSLATED));
    const system = threeSlots();
    expect(writeVertices(system, layout, new Float32Array(4 * layout.stride))).toBe(1);
    expect(writeVertices({ ...system, highWater: 1 }, layout, new Float32Array(12 * layout.stride))).toBe(1);
  });
});

describe("粒子索引", () => {
  it("每粒子 0 1 2 0 2 3，第 i 个加 4i", () => {
    expect(QUAD_INDICES).toEqual([0, 1, 2, 0, 2, 3]);
    expect(Array.from(quadIndices(2))).toEqual([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  });

  it("顶点数不超过 65536 用 16 位，超过用 32 位", () => {
    expect(quadIndices(16384)).toBeInstanceOf(Uint16Array);
    const big = quadIndices(16385);
    expect(big).toBeInstanceOf(Uint32Array);
    expect(Array.from(big.subarray(16384 * 6))).toEqual([65536, 65537, 65538, 65536, 65538, 65539]);
  });
});
