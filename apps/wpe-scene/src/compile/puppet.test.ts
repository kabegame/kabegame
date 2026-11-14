/**
 * P12a 步骤 1 点 3 的 puppet 数据单测（`.claude/plans/wpe-import/3-scene/phase12/phase-12a-mesh-animation.md`「步骤 1」）：
 * - float32 数学（`puppet/math.ts`）：欧拉转四元数、静止姿势分解（含 `0.99936533`）、绑定姿势的逆，和 `ignore/p12/rea/runtime/posemodel.py`
 *   的输出逐位比（常量由 `ignore/p12/a/fix/consts.py` 打印后抄来，`-0` 也要相同）；
 * - `buildPuppet`：组合键、逆绑定与静止姿势的接线、轨道转换与 mask、动画层的解析（缺省值、找不到的动画、绑定、脚本），以及子计划
 *   「P12a 不做、照报的细分键」逐个一例。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decomposeRest, eulerToQuat, fastInvSqrt, inverse4, mulFull } from "../puppet/math";
import { parseMdl, type MdlAnimation, type MdlBone, type MdlFile, type MdlMesh, type MdlSkeleton } from "./mdl";
import { boneJsonFlags, bonePhysics, buildPuppet } from "./puppet";

const f32 = (values: readonly number[]) => Array.from(Float32Array.from(values));

// ———— float32 数学（python 模型的逐位真值） ————

describe("欧拉转四元数（rea-p12-mdl 4.5，posemodel.quat_from_euler）", () => {
  it.each<[[number, number, number], number[]]>([
    [
      [0, 0, 0],
      [1, 0, 0, 0],
    ],
    [
      [0, 0, 0.7],
      [0.939372718, 0, 0, 0.342897803],
    ],
    [
      [0.3, -1.2, 2.5],
      [0.177249998, 0.568710923, -0.0590006113, 0.801042616],
    ],
    [
      [1e-5, 3.14159, -6.5],
      [-7.19174068e-7, -0.108195134, -0.994129658, 5.10779546e-6],
    ],
    [
      [0.74, 0, 0],
      [0.93232733, 0.361615449, 0, 0],
    ],
  ])("%j → w x y z", (euler, expected) => {
    const out = new Float32Array(4);
    const [x, y, z] = f32(euler);
    eulerToQuat(x, y, z, out, 0);
    expect(Array.from(out)).toEqual(f32(expected));
  });
});

describe("静止姿势的分解（rea-p12-runtime 7，posemodel.Puppet.decompose）", () => {
  it.each<[string, number[], number[]]>([
    [
      "单位阵：四元数是 (0.99936533, 0, 0, 0)，不是单位长度",
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      [0, 0, 0, 0.99936533, 0, 0, 0, 1, 1, 1],
    ],
    [
      "绕 z 转 0.7、平移 (80, 0)",
      [0.764842212, 0.64421767, 0, 0, -0.64421767, 0.764842212, 0, 0, 0, 0, 1, 0, 80, 0, 0, 1],
      [80, 0, 0, 0.938803017, 0, 0, 0.342525393, 1, 1, 1],
    ],
    [
      "带缩放 (1.5, 0.75)、转 −2.2",
      [-0.882751703, -1.21274459, 0, 0, 0.606372297, -0.441375852, 0, 0, 0, 0, 1, 0, -12.5, 40.25, 0, 1],
      [-12.5, 40.25, 0, -0.453294873, 0, 0, 0.890781462, 1.5, 0.75, 1],
    ],
  ])("%s", (_name, matrix, expected) => {
    const out = new Float32Array(10);
    decomposeRest(Float32Array.from(matrix), 0, out, 0);
    expect(Array.from(out)).toEqual(f32(expected));
  });

  it("快速倒数平方根：1 → 0.998308122（posemodel.fast_inv_sqrt；rea-RT 7 正文写的 0.99830717 是抄错的近似值）", () => {
    expect(fastInvSqrt(1)).toBe(Math.fround(0.998308122));
  });
});

describe("绑定姿势的逆（rea-p12-runtime 1.1，posemodel.mul_full + inverse）", () => {
  // 输入是 consts.py 的 trs(100, 50, 0.3, 1.2, 0.9) 与 trs(30, −10, −0.8)（下面的 `trs` 同一个式子）
  it("单根骨骼：逆", () => {
    const out = new Float32Array(16);
    const m = Float32Array.from(trs(100, 50, 0.3, 1.2, 0.9));
    inverse4(m, 0, out, 0);
    expect(Array.from(out)).toEqual(
      f32([
        0.796113729, -0.328355759, 0, -0, 0.246266827, 1.06148493, -0, 0, 0, -0, 1, -0, -91.9247131, -20.2386703, -0, 1,
      ]),
    );
  });

  it("两根骨骼：父链完整 4×4 相乘再求逆", () => {
    const world = new Float32Array(16);
    mulFull(Float32Array.from(trs(100, 50, 0.3, 1.2, 0.9)), 0, Float32Array.from(trs(30, -10, -0.8)), 0, world, 0);
    const out = new Float32Array(16);
    inverse4(world, 0, out, 0);
    expect(Array.from(out)).toEqual(
      f32([
        0.790205777, 0.342329353, 0, -0, -0.589886963, 0.916204691, -0, 0, 0, -0, 1, -0, -77.6009827, -94.5967865, -0,
        1,
      ]),
    );
  });
});

/** 列主序 `T·Rz·S`，同 `ignore/p12/defs/puppet.py` 的 `trs`（double 里算，存成 float32）。 */
function trs(tx: number, ty: number, rz: number, sx = 1, sy = 1): number[] {
  const c = Math.cos(rz);
  const s = Math.sin(rz);
  return f32([c * sx, s * sx, 0, 0, -s * sy, c * sy, 0, 0, 0, 0, 1, 0, tx, ty, 0, 1]);
}

// ———— buildPuppet ————

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/** 语料最常见的 puppet 格式：位置、法线、切线、骨骼下标与权重、uv（`ignore/p12/defs/puppet.py` 的 `FMT_SKIN`）。 */
const FMT_SKIN = 0x180000f;

function mesh(extra: Partial<MdlMesh> = {}): MdlMesh {
  return {
    materials: ["materials/a.json"],
    flags: 0,
    format: FMT_SKIN,
    stride: 80,
    vertices: new Uint8Array(320),
    indices: new Uint8Array(new Uint16Array([0, 1, 2, 0, 2, 3]).buffer),
    vertexCount: 4,
    indexFormat: "uint16",
    indexCount: 6,
    bounds: null,
    puppet: false,
    blendRowCount: 0,
    drawGroups: [],
    records: [],
    morph: null,
    ...extra,
  };
}

function bone(parent: number, local: number[] = IDENTITY, extra: Partial<MdlBone> = {}): MdlBone {
  return { name: "b", flags: 1, parent, local: Float32Array.from(local), json: "", ...extra };
}

function skeleton(bones: MdlBone[], extra: Partial<MdlSkeleton> = {}): MdlSkeleton {
  return {
    version: 4,
    count: bones.length,
    bones,
    restMatrices: null,
    drawOrder: null,
    extras: { records: 0, constraints: 0, keyMaps: 0, chains: 0 },
    ...extra,
  };
}

/** 每帧 9 个数：`frame(k)` 给第 k 帧的 [tx, ty, tz, rx, ry, rz, sx, sy, sz]。 */
function animation(
  id: number,
  bones: number,
  length: number,
  frame: (k: number, bone: number) => number[],
  extra: Partial<MdlAnimation> = {},
): MdlAnimation {
  return {
    id,
    name: `a${id}`,
    mode: "loop",
    fps: 10,
    length,
    flags: 0,
    tracks: Array.from({ length: bones }, (_, b) => ({
      flags: 0,
      frames: Float32Array.from({ length: (length + 1) * 9 }, (_, i) => frame(Math.floor(i / 9), b)[i % 9]),
    })),
    boneAlpha: null,
    morphWeights: null,
    drawOrderTrack: false,
    events: [],
    unsupported: false,
    ...extra,
  };
}

function file(extra: Partial<MdlFile> = {}): MdlFile {
  return {
    version: 23,
    skins: 1,
    meshes: [mesh()],
    bounds: [],
    sections: [],
    truncated: false,
    skeleton: skeleton([bone(-1)]),
    animations: [],
    attachments: [],
    sectionIssues: [],
    ...extra,
  };
}

/** 带 `drawGroups` 的网格：4 个组各 3 个索引（索引缓冲 12 个 u16，值 = 位置），`records` 照给。 */
function clipMesh(records: MdlMesh["records"]): MdlMesh {
  return mesh({
    indices: new Uint8Array(Uint16Array.from({ length: 12 }, (_, i) => i).buffer),
    drawGroups: [0, 1, 2, 3].map((g) => ({ bone: 0, order: 0, start: g * 3, count: 3 })),
    records,
  });
}

const walk = (k: number) => [k, 2 * k, 0, 0, 0, 0.1 * k, 1, 1, 1];

describe("buildPuppet：网格、组合键、骨骼", () => {
  it("skinned：SKINNING = 1、BONECOUNT = 真实骨骼数（不取 2 的幂）；网格 0 的视图、索引按 u16", () => {
    const source = file({ skeleton: skeleton([bone(-1), bone(0), bone(1)]) });
    const { puppet, issues } = buildPuppet(source, [], "models/p.mdl");
    expect([...issues]).toEqual([]);
    expect(puppet!.combos).toEqual({ SKINNING: 1, BONECOUNT: 3 });
    expect(puppet!.path).toBe("models/p.mdl");
    expect(puppet!.mesh).toMatchObject({ format: FMT_SKIN, stride: 80, vertexCount: 4, indexCount: 6 });
    expect(puppet!.mesh.vertices).toBe(source.meshes[0].vertices);
    expect(Array.from(puppet!.skeleton!.parents)).toEqual([-1, 0, 1]);
  });

  it("静态 puppet：没有 MDLS，或格式没有 a_BlendIndices → 没有组合键、skeleton 为 null", () => {
    expect(buildPuppet(file({ skeleton: null }), [], "p").puppet).toMatchObject({ combos: {}, skeleton: null });
    expect(buildPuppet(file({ meshes: [mesh({ format: 0xf })] }), [], "p").puppet).toMatchObject({
      combos: {},
      skeleton: null,
    });
    expect(buildPuppet(file({ skeleton: skeleton([]) }), [], "p").puppet!.skeleton).toBeNull();
  });

  it("没有网格：puppet 为 null（WPE 销毁 P、照常画四边形）", () => {
    expect(buildPuppet(file({ meshes: [] }), [], "p").puppet).toBeNull();
  });

  it("逆绑定沿父链完整 4×4 相乘再求逆；静止姿势取可选骨骼矩阵（有时）并按快速倒数平方根分解", () => {
    const a = trs(100, 50, 0.3, 1.2, 0.9);
    const b = trs(30, -10, -0.8);
    const { puppet } = buildPuppet(file({ skeleton: skeleton([bone(-1, a), bone(0, b)]) }), [], "p");
    const expected = new Float32Array(32);
    inverse4(Float32Array.from(a), 0, expected, 0);
    const world = new Float32Array(16);
    mulFull(Float32Array.from(a), 0, Float32Array.from(b), 0, world, 0);
    inverse4(world, 0, expected, 16);
    expect(Array.from(puppet!.skeleton!.inverseBind)).toEqual(Array.from(expected));
    expect(Array.from(puppet!.skeleton!.restMatrices)).toEqual([...a, ...b]);
    const rest = new Float32Array(10);
    decomposeRest(Float32Array.from(b), 0, rest, 0);
    expect(Array.from(puppet!.skeleton!.rest.subarray(10, 20))).toEqual(Array.from(rest));

    const optional = trs(5, 6, 0.2);
    const withOptional = buildPuppet(
      file({ skeleton: skeleton([bone(-1, a)], { restMatrices: [Float32Array.from(optional)] }) }),
      [],
      "p",
    ).puppet!;
    expect(Array.from(withOptional.skeleton!.restMatrices)).toEqual(optional);
    // 逆绑定照旧来自 MDLS 局部矩阵
    expect(Array.from(withOptional.skeleton!.inverseBind)).toEqual(Array.from(expected.subarray(0, 16)));
  });
});

describe("buildPuppet：动画与动画层（rea-p12-runtime 1.4、1.5）", () => {
  const anims = [animation(7, 2, 4, walk, { mode: "mirror" }), animation(9, 2, 2, walk, { mode: "single", fps: 30 })];
  // 骨骼 1 的轨道 flags bit0：不参与动画
  anims[0].tracks[1].flags = 1;
  const source = file({ skeleton: skeleton([bone(-1), bone(0)]), animations: anims });

  it("缺省值：rate 1、blend 1、visible 真、其余假、blendtime 0.5、name 空；层顺序照 JSON；同一动画只转一次", () => {
    const { puppet, issues } = buildPuppet(
      source,
      [{ animation: 9 }, { animation: 7, name: "w" }, { animation: 9 }],
      "p",
    );
    expect([...issues]).toEqual([]);
    expect(puppet!.animations.map((item) => [item.id, item.mode, item.fps, item.length])).toEqual([
      [9, 2, 30, 2],
      [7, 1, 10, 4],
    ]);
    expect(puppet!.layers.map((layer) => layer.animation)).toEqual([0, 1, 0]);
    expect(puppet!.layers[1]).toEqual({
      animation: 1,
      name: "w",
      rate: 1,
      blend: 1,
      visible: true,
      additive: false,
      blendin: false,
      blendout: false,
      blendtime: 0.5,
      bindings: [],
    });
  });

  it("轨道转成 T q S（q 是欧拉角的半角四元数）；flags bit0 的骨骼 mask 0、帧数据不转", () => {
    const { puppet } = buildPuppet(source, [{ animation: 7 }], "p");
    const [anim] = puppet!.animations;
    expect(Array.from(anim.mask)).toEqual([1, 0]);
    expect(anim.frames.length).toBe(5 * 2 * 10);
    const q = new Float32Array(4);
    eulerToQuat(0, 0, Math.fround(0.3), q, 0);
    // 第 3 帧骨骼 0：T = (3, 6, 0)、rz = 0.3、S = 1
    expect(Array.from(anim.frames.subarray(60, 70))).toEqual([3, 6, 0, ...q, 1, 1, 1]);
    expect(Array.from(anim.frames.subarray(70, 80))).toEqual(new Array(10).fill(0));
  });

  it("animation 不是数或找不到 → 整层丢掉、不报；非整数按截断找；不是对象的项跳过", () => {
    const { puppet, issues } = buildPuppet(
      source,
      [{ animation: 999 }, { animation: "7" }, { animation: 9.8 }, 3, null, [], { animation: { user: "a", value: 7 } }],
      "p",
    );
    expect([...issues]).toEqual([]);
    expect(puppet!.layers.map((layer) => puppet!.animations[layer.animation].id)).toEqual([9]);
    expect(buildPuppet(source, { animation: 7 }, "p").puppet!.layers).toEqual([]);
  });

  it("{user} 绑定：初值按编译期属性解析，rate / blend / visible 记下绑定；条件绑定按字符串比", () => {
    const { puppet } = buildPuppet(
      source,
      [
        {
          animation: 7,
          rate: { user: "speed", value: 1 },
          blend: { user: "mix", value: 0.25 },
          visible: { user: { name: "mode", condition: "2" }, value: true },
          blendtime: { user: "bt", value: 0.5 },
        },
      ],
      "p",
      { speed: 0.5, mode: 2, bt: 3 },
    );
    expect(puppet!.layers[0]).toMatchObject({ rate: 0.5, blend: 0.25, visible: true, blendtime: 3 });
    expect(puppet!.layers[0].bindings).toEqual([
      { field: "rate", property: "speed" },
      { field: "blend", property: "mix" },
      { field: "visible", property: "mode", condition: "2" },
    ]);
    const hidden = buildPuppet(source, [{ animation: 7, visible: { user: { name: "m", condition: "1" } } }], "p", {
      m: 0,
    });
    expect(hidden.puppet!.layers[0].visible).toBe(false);
  });

  it("值的类型：float 收数字 / 布尔 / 数字串（存 float32），位收布尔与数字", () => {
    const { puppet } = buildPuppet(
      source,
      [{ animation: 7, rate: "0.3", blend: 0.58, visible: 0, additive: 1, blendin: "x", blendtime: true }],
      "p",
    );
    expect(puppet!.layers[0]).toMatchObject({
      rate: Math.fround(0.3),
      blend: Math.fround(0.58),
      visible: false,
      additive: true,
      blendin: false,
      blendtime: 1,
    });
  });

  it("静态 puppet 也解析动画层（P12c 的脚本要用），但帧数据不转", () => {
    const { puppet } = buildPuppet({ ...source, meshes: [mesh({ format: 0xf })] }, [{ animation: 7 }], "p");
    expect(puppet!.skeleton).toBeNull();
    expect(puppet!.layers).toHaveLength(1);
    expect(puppet!.animations[0].frames.length).toBe(0);
  });
});

describe("buildPuppet：P12a 不做、照报的细分键", () => {
  const anim = (extra: Partial<MdlAnimation>) => animation(1, 1, 2, walk, extra);
  const keys = (source: MdlFile, layers: unknown = [{ animation: 1 }]) =>
    [...buildPuppet(source, layers, "p").issues].sort();

  it.each<[string, Partial<MdlFile>, string[]]>([
    ["截断", { truncated: true }, ["mdl:truncated"]],
    ["段没读到段末", { sectionIssues: ["MDLS0004", "MDLA0006"] }, ["mdl:section:MDLA0006", "mdl:section:MDLS0004"]],
    ["骨骼数 > 128（WPE 直接终止进程）", { skeleton: skeleton([], { count: 129 }) }, ["mdl:skeleton:bones"]],
    ["动画 id ≥ 2³²", { animations: [animation(2 ** 32 + 1, 1, 2, walk)] }, ["mdl:animation-id"]],
    ["网格 0 标志 bit0：u32 索引", { meshes: [mesh({ flags: 1 })] }, ["puppet:index32"]],
    ["网格 0 标志 bit2：SKINNING_ALPHA 不再报（P12b1）", { meshes: [mesh({ flags: 4 })] }, []],
    ["网格 0 格式含 a_PositionVec4：MORPHING 不再报（P12b1）", { meshes: [mesh({ format: FMT_SKIN | 0x10000 })] }, []],
    ["网格 0 标志 bit13：MORPHING_MODIFIERS", { meshes: [mesh({ flags: 0x2000 })] }, ["puppet:morph:modifiers"]],
    [
      "网格 0 有 v23 记录：裁切遮罩不再报（P12b1）",
      { meshes: [clipMesh([{ id: 1, name: "m", flags: 0, list1: [0], list2: [1] }])] },
      [],
    ],
    [
      "记录 flags 非 0",
      { meshes: [clipMesh([{ id: 1, name: "m", flags: 2, list1: [0], list2: [1] }])] },
      ["puppet:clipping:flags"],
    ],
    [
      "遮罩被别的记录裁切（嵌套）",
      {
        meshes: [
          clipMesh([
            { id: 1, name: "a", flags: 0, list1: [2], list2: [0] },
            { id: 2, name: "b", flags: 0, list1: [0, 3], list2: [1] },
          ]),
        ],
      },
      ["puppet:clipping:nested"],
    ],
    [
      "记录下标超出绘制组数",
      { meshes: [clipMesh([{ id: 1, name: "m", flags: 0, list1: [0], list2: [9] }])] },
      ["puppet:clipping:groups"],
    ],
    [
      "任一网格标志 bit1：纹理通道",
      { meshes: [mesh(), mesh({ flags: 2, blendRowCount: 1 })] },
      ["puppet:texture-channels"],
    ],
    [
      "骨骼 JSON 的物理门 (r ‖ t) && (se ‖ re)",
      { skeleton: skeleton([bone(-1, IDENTITY, { json: '{"r":true,"se":true}' })]) },
      ["puppet:physics"],
    ],
    ["骨骼文件 flags bit1（物理接管）", { skeleton: skeleton([bone(-1, IDENTITY, { flags: 3 })]) }, ["puppet:physics"]],
    ["骨骼 JSON 的 ik", { skeleton: skeleton([bone(-1, IDENTITY, { json: '{"ik":true}' })]) }, ["puppet:ik"]],
    [
      "MDLS v ≥ 2 的约束",
      { skeleton: skeleton([bone(-1)], { extras: { records: 0, constraints: 1, keyMaps: 0, chains: 0 } }) },
      ["puppet:ik"],
    ],
    [
      "绘制顺序轨道 + bit3",
      { meshes: [mesh({ flags: 8 })], animations: [anim({ drawOrderTrack: true })] },
      ["puppet:draw-order"],
    ],
    [
      "绘制顺序轨道、没有 bit3（WPE 写空指针）",
      { animations: [anim({ drawOrderTrack: true })] },
      ["puppet:order-track"],
    ],
    [
      "骨骼透明度轨道、没有 bit2（WPE 崩溃）",
      { animations: [anim({ boneAlpha: new Float32Array(3) })] },
      ["puppet:alpha-track"],
    ],
    [
      "骨骼透明度轨道 + bit2：不报（P12b1）",
      { meshes: [mesh({ flags: 4 })], animations: [anim({ boneAlpha: new Float32Array(3) })] },
      [],
    ],
    ["引用块 / 记录轨道 / 约束轨道", { animations: [anim({ unsupported: true })] }, ["puppet:animation-ref"]],
    ["轨道数不等于骨骼数", { animations: [animation(1, 2, 2, walk)] }, ["mdl:animation:tracks"]],
  ])("%s", (_name, extra, expected) => {
    expect(keys(file({ animations: [anim({})], ...extra }))).toEqual(expected);
  });

  it("动画层字段挂脚本：puppet:layer-script（任一描述符字段；丢掉的层不算）", () => {
    const source = file({ animations: [anim({})] });
    expect(
      keys(source, [{ animation: 1, blend: { script: "export function update(v) { return v; }", value: 1 } }]),
    ).toEqual(["puppet:layer-script"]);
    expect(keys(source, [{ animation: 1, name: { script: "x", value: "n" } }])).toEqual(["puppet:layer-script"]);
    expect(keys(source, [{ animation: 5, blend: { script: "x", value: 1 } }])).toEqual([]);
  });

  it("运行时的键只在 skinned 时报；没被动画层用到的动画不看", () => {
    const animations = [anim({ drawOrderTrack: true, boneAlpha: new Float32Array(3), unsupported: true })];
    const physics = skeleton([bone(-1, IDENTITY, { json: '{"t":true,"re":true}' })]);
    expect(keys(file({ meshes: [mesh({ format: 0xf })], animations, skeleton: physics }))).toEqual([]);
    expect(keys(file({ animations }), [])).toEqual([]);
  });
});

describe("骨骼 JSON 的门（rea-p12-mdl 2.1）", () => {
  it.each<[string, number, boolean]>([
    ['{"r":true,"se":true}', 0x1001, true],
    ['{"t":true,"re":true,"ik":false}', 0x2002, true],
    ['{"r":true}', 0, false],
    ['{"se":true,"re":true}', 0, false],
    ['{"r":1,"se":true}', 0, false],
    ['{"ik":true}', 0x4000, false],
    ['{"ikce":true,"r":true}', 0x9000, false],
    ["", 0, false],
    ["{bad", 0, false],
    ['{"a":"","s":"","tp":"-nan(ind) 0 0"}', 0, false],
  ])("%s → 标志 %i、物理 %s", (json, flags, physics) => {
    expect(boneJsonFlags(json)).toBe(flags);
    expect(bonePhysics(json)).toBe(physics);
  });
});

// ———— P12b1 步骤 1：挂点、骨骼透明度、变形纹理、裁切命令表 ————

describe("buildPuppet：挂点（MDAT）、骨骼透明度、变形（P12b1）", () => {
  const attached = (flags: number, format: number) =>
    file({
      meshes: [mesh({ flags, format })],
      attachments: [{ name: "tip", bone: 0, matrix: Float32Array.from(IDENTITY) }],
    });

  it("挂点：名字、骨骼、矩阵拷一份（不共享 mdl 的缓冲）", () => {
    const source = attached(0, FMT_SKIN);
    const { puppet } = buildPuppet(source, [], "p");
    expect(puppet!.attachments).toEqual([{ name: "tip", bone: 0, matrix: Float32Array.from(IDENTITY) }]);
    expect(puppet!.attachments[0].matrix).not.toBe(source.attachments[0].matrix);
  });

  it("组合键：bit2 → SKINNING_ALPHA；格式含 a_PositionVec4 → MORPHING（不看有没有目标，也没有 MORPHING_NORMALS）；两个都要 skinned", () => {
    expect(buildPuppet(attached(4, FMT_SKIN), [], "p").puppet!.combos).toEqual({
      SKINNING: 1,
      BONECOUNT: 1,
      SKINNING_ALPHA: 1,
    });
    const both = buildPuppet(attached(4 | 0x400, FMT_SKIN | 0x10000), [], "p").puppet!;
    expect(both.combos).toEqual({ SKINNING: 1, BONECOUNT: 1, SKINNING_ALPHA: 1, MORPHING: 1 });
    expect(both.boneAlpha).toBe(true);
    expect(both.morph).toEqual({
      scale: 0,
      vertices: 0,
      targets: 0,
      side: 1,
      texels: Int16Array.from([0, 0, 0, 32767]),
    });
    // 静态 puppet（格式没有骨骼下标）：不加，也不填
    const stat = buildPuppet(attached(4, 0xf | 0x10000), [], "p").puppet!;
    expect(stat.combos).toEqual({});
    expect([stat.boneAlpha, stat.morph]).toEqual([false, null]);
  });

  it("变形纹理：count = 目标数 × nv + 1，side = ⌊√count⌋（不够加 1）；纹素 0 = (0, 0, 0, 32767)；只有 bit12 时写目标数据", () => {
    const morph = (nv: number, targets: number) => ({
      scale: 2.5,
      count: nv,
      targets: Array.from({ length: targets }, (_, t) => ({
        id: t,
        name: `Shape ${t}`,
        position: Int16Array.from({ length: 3 * nv }, (_, i) => 100 * (t + 1) + i),
        alpha: Int16Array.from({ length: nv }, (_, v) => 1000 * (t + 1) + v),
      })),
    });
    const build = (flags: number, nv: number, targets: number) =>
      buildPuppet(file({ meshes: [mesh({ flags, format: FMT_SKIN | 0x10000, morph: morph(nv, targets) })] }), [], "p")
        .puppet!.morph!;
    // 2 个目标 × nv 3 + 1 = 7 → side 2（4 < 7）→ 3
    const full = build(0x1000, 3, 2);
    expect([full.side, full.vertices, full.targets, full.scale, full.texels.length]).toEqual([3, 3, 2, 2.5, 36]);
    expect(Array.from(full.texels.subarray(0, 4))).toEqual([0, 0, 0, 32767]);
    // 目标 0 顶点 1：纹素 1 + 0·3 + 1；目标 1 顶点 2：纹素 1 + 1·3 + 2
    expect(Array.from(full.texels.subarray(8, 12))).toEqual([103, 104, 105, 1001]);
    expect(Array.from(full.texels.subarray(24, 28))).toEqual([206, 207, 208, 2002]);
    expect(Array.from(full.texels.subarray(28))).toEqual(new Array(8).fill(0)); // 多出来的纹素 7、8
    // 没有 bit12：只有纹素 0
    const plain = build(0, 3, 2);
    expect(Array.from(plain.texels)).toEqual([0, 0, 0, 32767, ...new Array(32).fill(0)]);
    // 恰好是平方数：8 × 1 + 1 = 9 → side 3，不加 1
    expect(build(0x1000, 8, 1).side).toBe(3);
  });

  it("动画的转换：骨骼透明度（帧 × 骨骼、flags & 3 == 1 的骨骼不参与）、变形权重（按目标号，缺的为 null）；没有 bit2 / 没有 MORPHING 时不转", () => {
    const alpha = Float32Array.from([0.1, 0.9, 0.2, 0.8, 0.3, 0.7]); // 3 帧 × 2 轨道
    const wide = skeleton([bone(-1), bone(0)]);
    const source = (flags: number, format: number) => {
      const base = animation(1, 2, 2, walk, { boneAlpha: alpha });
      base.tracks[1].flags = 1; // 轨道 1 不参与动画，透明度也不参与（flags & 3 == 1）
      return file({
        skeleton: wide,
        meshes: [
          mesh({
            flags,
            format,
            morph: {
              scale: 1,
              count: 1,
              targets: [0, 1, 2].map((t) => ({ id: t, name: "t", position: new Int16Array(3), alpha: null })),
            },
          }),
        ],
        animations: [
          {
            ...base,
            morphWeights: [
              { target: 2, values: Float32Array.from([1, 2, 3]) },
              { target: 0, values: Float32Array.from([4, 5, 6]) },
              { target: 9, values: Float32Array.from([7, 8, 9]) },
            ],
          },
        ],
      });
    };
    const [animationOut] = buildPuppet(source(4, FMT_SKIN | 0x10000), [{ animation: 1 }], "p").puppet!.animations;
    expect(Array.from(animationOut.alpha!)).toEqual(f32([0.1, 0, 0.2, 0, 0.3, 0]));
    expect(Array.from(animationOut.alphaMask)).toEqual([1, 0]);
    expect(animationOut.morph).toEqual([Float32Array.from([4, 5, 6]), null, Float32Array.from([1, 2, 3])]);
    const [bare] = buildPuppet(source(0, FMT_SKIN), [{ animation: 1 }], "p").puppet!.animations;
    expect([bare.alpha, bare.morph]).toEqual([null, null]);
    expect(Array.from(bare.alphaMask)).toEqual([]);
  });
});

describe("buildPuppet：裁切命令表（P12b1，照 cm_cmdlist.py）", () => {
  // clipMesh：4 个组各 3 个索引（索引缓冲 12 个 u16，值 = 位置）
  const build = (records: MdlMesh["records"]) => buildPuppet(file({ meshes: [clipMesh(records)] }), [], "p");
  const idx = (...groups: number[]) => Uint16Array.from(groups.flatMap((g) => [3 * g, 3 * g + 1, 3 * g + 2]));

  it("没有记录：clipping 为 null", () => {
    expect(build([]).puppet!.clipping).toBeNull();
  });

  it("一条记录：遮罩组先作为普通段画一次、再进遮罩；目标在遮罩组之后画；后面的普通组合成末段", () => {
    const { puppet, issues } = build([{ id: 1, name: "masks/clipping_mask_x", flags: 0, list1: [1], list2: [0] }]);
    expect([...issues]).toEqual([]);
    expect(puppet!.clipping).toEqual({
      commands: [
        { kind: "normal", segment: 0 },
        { kind: "clip", record: 0, mask: 1, target: 2 },
        { kind: "normal", segment: 3 },
      ],
      segments: [idx(0), idx(0), idx(1), idx(2, 3)],
      records: [{ mask: "materials/masks/clipping_mask_x.tex" }],
    });
  });

  it("遮罩段 = 首末遮罩位置之间的全部位置减去本记录的目标（夹在中间的普通组也画进遮罩）；一条记录的多个 list1 合成一个目标段", () => {
    const { puppet } = build([{ id: 1, name: "m", flags: 0, list1: [1, 3], list2: [0, 2] }]);
    // 位置 0、2 是遮罩，目标 1、3 不打断普通段的累积：发射在末遮罩位置 2，此前累积 [0, 2]
    expect(puppet!.clipping!.segments).toEqual([idx(0, 2), idx(0, 2), idx(1, 3)]);
    expect(puppet!.clipping!.commands).toEqual([
      { kind: "normal", segment: 0 },
      { kind: "clip", record: 0, mask: 1, target: 2 },
    ]);
  });

  it("两条同遮罩的记录：同一位置发射时按最小目标位置排序（并列按记录下标），各自一份遮罩段与目标段", () => {
    const { puppet } = build([
      { id: 1, name: "m", flags: 0, list1: [3], list2: [0] },
      { id: 2, name: "m", flags: 0, list1: [1], list2: [0] },
    ]);
    expect(puppet!.clipping!.commands).toEqual([
      { kind: "normal", segment: 0 },
      { kind: "clip", record: 1, mask: 1, target: 2 },
      { kind: "clip", record: 0, mask: 3, target: 4 },
      { kind: "normal", segment: 5 },
    ]);
    expect(puppet!.clipping!.segments).toEqual([idx(0), idx(0), idx(1), idx(0), idx(3), idx(2)]);
  });
});

// ———— 本机语料 ————

const corpusRoot = process.env.KABEGAME_WPE_ROOT;
const mdlDir = join(__dirname, "..", "..", "..", "..", "ignore", "p12", "rea", "mdl");
const mdlIndex = join(mdlDir, "corpus_index.json");
const cmOut = join(__dirname, "..", "..", "..", "..", "ignore", "p12", "b", "rea", "cm_cmdlist_out.txt");

describe.skipIf(!corpusRoot || !existsSync(mdlIndex) || !existsSync(cmOut))(
  "本机语料：裁切命令表与 cm_cmdlist_out.txt（P12b1）",
  () => {
    interface Expected {
      scene: string;
      path: string;
      obj: number;
      names: string[];
      cmds: number[];
      segments: { kind: string; groups: number[]; indices: number }[];
    }

    /** 解析 `cm_cmdlist.py` 的输出：每个网格一块。 */
    function parseOut(text: string): Expected[] {
      const out: Expected[] = [];
      for (const line of text.split(/\r?\n/)) {
        const head = /^(\d+) (.+) obj (\d+) mesh0 flags/.exec(line);
        if (head) {
          out.push({ scene: head[1], path: head[2], obj: Number(head[3]), names: [], cmds: [], segments: [] });
          continue;
        }
        const current = out[out.length - 1];
        if (!current) continue;
        const rec = /^\s+rec\d+ (\S+) flags=/.exec(line);
        if (rec) current.names.push(rec[1]);
        const cmds = /cmds P\+0x430 = \[([^\]]*)\]/.exec(line);
        if (cmds) current.cmds = cmds[1].split(",").map(Number);
        const seg = /^\s+seg\d+ (normal|mask r\d+|target r\d+)\s+groups=\[([^\]]*)\] indices=(\d+)/.exec(line);
        if (seg)
          current.segments.push({ kind: seg[1], groups: seg[2].split(",").map(Number), indices: Number(seg[3]) });
      }
      return out;
    }

    it("5 个带记录的语料网格：命令、每段索引（按段里的组拼接）、遮罩纹理路径逐个等于 python 模拟器；不报裁切的键", () => {
      const expected = parseOut(readFileSync(cmOut, "utf8"));
      expect(expected).toHaveLength(5);
      const index = JSON.parse(readFileSync(mdlIndex, "utf8")) as {
        scene: string;
        path: string;
        obj: number;
        file: string;
      }[];
      for (const want of expected) {
        const entry = index.find(
          (item) => item.scene === want.scene && item.path === want.path && item.obj === want.obj,
        );
        expect(entry, `${want.scene} ${want.path}`).toBeDefined();
        const parsed = parseMdl(new Uint8Array(readFileSync(join(mdlDir, "corpus", entry!.file))));
        const { puppet, issues } = buildPuppet(parsed, [], want.path);
        expect(
          [...issues].filter((key) => key.startsWith("puppet:clipping")),
          want.path,
        ).toEqual([]);
        const clipping = puppet!.clipping!;
        // python 的命令表是平铺的 u32：0 = 普通段，1 + 记录下标 = 裁切
        expect(
          clipping.commands.flatMap((command) => (command.kind === "normal" ? [0] : [1, command.record])),
          `${want.path} 命令`,
        ).toEqual(want.cmds);
        expect(clipping.segments, `${want.path} 段数`).toHaveLength(want.segments.length);
        const mesh = parsed.meshes[0];
        const view = new DataView(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength);
        want.segments.forEach((segment, s) => {
          const expectedIndices: number[] = [];
          for (const group of segment.groups) {
            const { start, count } = mesh.drawGroups[group];
            for (let i = 0; i < count; i++) expectedIndices.push(view.getUint16((start + i) * 2, true));
          }
          expect(expectedIndices.length, `${want.path} 段 ${s} 索引数`).toBe(segment.indices);
          expect(Array.from(clipping.segments[s]), `${want.path} 段 ${s}（${segment.kind}）`).toEqual(expectedIndices);
        });
        expect(clipping.records.map((record) => record.mask)).toEqual(
          want.names.map((name) => `materials/${name}.tex`),
        );
      }
    });

    it("语料全部 puppet mdl（动画层取全部动画）：不再有 puppet:alpha / puppet:morph / puppet:clipping 键", () => {
      const index = JSON.parse(readFileSync(mdlIndex, "utf8")) as { file: string; kind: string; path: string }[];
      const keys = new Set<string>();
      let attachments = 0;
      let withAlpha = 0;
      let withMorph = 0;
      let withClipping = 0;
      let alphaAnimations = 0;
      for (const entry of index) {
        if (entry.kind !== "puppets") continue;
        const parsed = parseMdl(new Uint8Array(readFileSync(join(mdlDir, "corpus", entry.file))));
        const layers = parsed.animations.map((animation) => ({ animation: animation.id }));
        const { puppet, issues } = buildPuppet(parsed, layers, entry.path);
        for (const key of issues) keys.add(key);
        if (!puppet) continue;
        attachments += puppet.attachments.length;
        if (puppet.boneAlpha) withAlpha++;
        if (puppet.morph) withMorph++;
        if (puppet.clipping) withClipping++;
        alphaAnimations += puppet.animations.filter((item) => item.alpha).length;
      }
      // 语料里剩下的键：绘制顺序轨道（3577990983）、物理、纹理通道（3811424158）；P12b1 的四样没有新增键
      expect([...keys].sort()).toEqual(["puppet:draw-order", "puppet:physics", "puppet:texture-channels"]);
      // 挂点 38 项（MDAT：1 个文件 14、2 个 5、3 个 2、8 个 1）；bit2 的 puppet 8 个、带透明度轨道的动画 15 条；MORPHING 6 个；裁切 5 个
      expect([attachments, withAlpha, alphaAnimations, withMorph, withClipping]).toEqual([38, 8, 15, 6, 5]);
    });
  },
);
