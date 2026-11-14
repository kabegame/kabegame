/**
 * puppet 数据（P12a 步骤 1 点 2）：把解析好的 mdl（`mdl.ts` 的 `parseMdl`）与图层的 `animationlayers` 整理成 `ScenePuppet`，并报
 * P12a 还不支持的用法。纯 TS，编译期（Worker）调用，产物结构化克隆安全（只有数、字符串、布尔、类型化数组与普通对象）。
 *
 * 依据：`.claude/plans/wpe-import/3-scene/phase12/phase-12a-mesh-animation.md`「总体设计思路」与「步骤 1」点 2；格式与加载见
 * `rea-p12-mdl.md` 第 1、2、4、7–9 节，运行时的约定见 `rea-p12-runtime.md` 第 1、6、7 节，实测见 `p12-REPORT.md`。
 * - 只用网格 0（rea-mdl 9.2）；索引一律按 u16（9.2、8：puppet 路径不看标志 bit0）；
 * - skinned = 网格 0 的格式含 `a_BlendIndices` 且骨骼表非空（`L` 虚函数 `+0xd0`，rea-mdl 9.3）：`SKINNING = 1`、`BONECOUNT` = 真实骨骼数
 *   （不取 2 的幂，`p12-REPORT`「复核」的 48 字节 `g_bufAnimation`）；否则是静态 puppet，没有组合键、不进运行时；
 * - 逆绑定：`MDLS` 局部矩阵沿父链完整 4×4 相乘再 glm 求逆（rea-RT 1.1，不用 `MDLE`）；静止姿势：来源矩阵（可选骨骼矩阵，没有就是局部
 *   矩阵）按快速倒数平方根分解（rea-RT 7）；
 * - 轨道每帧 9 个 f32 转成 T(3) q(4) S(3)（rea-mdl 4.5），只转动画层用到的动画。
 */
import type { AnimationMode } from "../animation/types";
import { decomposeRest, eulerToQuat, inverse4, mulFull } from "../puppet/math";
import { POSE_STRIDE } from "../puppet/pose";
import { isScriptValue, userBindingOf } from "./bindings";
import { MAX_BONES, type MdlAnimation, type MdlFile } from "./mdl";
import { resolveValue, type SceneScalar, type SceneValue } from "./model";

const f = Math.fround;

/** 顶点格式的 `a_BlendIndices` 位（`mdl.ts` 的 `MDL_ATTRIBUTES`）：skinned 的条件之一。 */
const BLEND_INDICES = 0x800000;
/** 顶点格式的 `a_PositionVec4` 位：`MORPHING` 的条件（rea-mdl 9.3）。 */
const POSITION_VEC4 = 0x10000;

/** 动画层字段里能挂用户属性的三个（步骤 3 的 `animation-layer` 目标）。 */
export type PuppetLayerField = "rate" | "blend" | "visible";

/** 一个动画层（`animationlayers` 的一项，rea-RT 1.4、1.5）。 */
export interface PuppetLayerDef {
  /** `ScenePuppet.animations` 的下标。 */
  animation: number;
  name: string;
  rate: number;
  blend: number;
  visible: boolean;
  additive: boolean;
  blendin: boolean;
  /** JSON 原值；非 single 的动画在运行时建层时清掉（rea-RT 1.4）。 */
  blendout: boolean;
  blendtime: number;
  /**
   * `{user}` 绑定（步骤 3 登记成 `animation-layer` 目标）：`rate` / `blend` / `visible` 三个字段。上面三个值已按编译期的属性值解析
   * （WPE 加载时套用一次，rea-RT 1.5）；之后的改动由运行时从状态读（`puppet/player.ts` 的 `PuppetSink`）。
   */
  bindings: { field: PuppetLayerField; property: string; condition?: string }[];
}

/** 一条动画层用到的动画（编译期转好的帧数据，`puppet/pose.ts` 的排法）。 */
export interface PuppetAnimation {
  /** `MDLA` 里的 id。 */
  id: number;
  name: string;
  /** 0 loop、1 mirror、2 single（`animation/clock.ts` 的常量）。 */
  mode: AnimationMode;
  fps: number;
  /** 文件里的长度；帧数 = length + 1。 */
  length: number;
  /** 每骨骼 1 = 有轨道（轨道 flags bit0 为 0）、0 = 保持来源（rea-mdl 4.3、rea-RT 4）。静态 puppet 为空。 */
  mask: Uint8Array;
  /** 第 f 帧第 b 根骨骼在 `(f × 骨骼数 + b) × 10`：T(3) q(4，w x y z) S(3)。静态 puppet 不转换，为空。 */
  frames: Float32Array;
}

export interface ScenePuppet {
  /** 模型 JSON 里写的 mdl 路径。 */
  path: string;
  /** 网格 0：顶点格式、stride、顶点 / 索引视图（原文件缓冲上的，索引一律按 u16 读）。 */
  mesh: {
    format: number;
    stride: number;
    vertices: Uint8Array;
    indices: Uint8Array;
    vertexCount: number;
    indexCount: number;
  };
  /** skinned 时的组合键（`SKINNING` / `BONECOUNT`）；静态 puppet 为空对象。 */
  combos: Record<string, number>;
  /** 静态 puppet 为 null。 */
  skeleton: {
    /** 父骨骼下标，根为 −1。 */
    parents: Int32Array;
    /** 每骨骼 16 个 f32，绑定姿势的逆。 */
    inverseBind: Float32Array;
    /** 静止姿势：每骨骼 T(3) q(4) S(3)（`decomposeRest`，单位旋转是 `(0.99936533, 0, 0, 0)`）。 */
    rest: Float32Array;
    /** 静止姿势的来源矩阵，每骨骼 16 个 f32（没有可见层时局部矩阵直接用它，rea-RT 6.1）。 */
    restMatrices: Float32Array;
  } | null;
  animations: PuppetAnimation[];
  /** 按 JSON 顺序（语料没有 `autosort` / `index`，rea-RT 1.4）。找不到动画的项整层丢掉，不报。 */
  layers: PuppetLayerDef[];
}

/** 动画层的描述符字段（rea-RT 1.5 的属性表 `0x1404e8a60`，只读的 `fps` / `frameCount` / `duration` 不在 JSON 里写）。 */
const LAYER_KEYS = ["visible", "additive", "blendin", "blendout", "name", "rate", "blend", "blendtime"] as const;

/** float 描述符的 JSON 取值（同图层字段的 `asNumber`：数字原样、布尔 1 / 0、能解析的字符串；其余取缺省），存 float32。 */
function floatField(value: SceneScalar | undefined, fallback: number): number {
  if (value === null || value === undefined) return fallback;
  const parsed = Number(value);
  return f(Number.isFinite(parsed) ? parsed : fallback);
}

/** 位描述符的 JSON 取值（jsoncpp `asBool`：布尔原样、数字非 0 为真；缺键或别的类型取缺省）。语料全是布尔。 */
function boolField(value: SceneScalar | undefined, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return fallback;
}

/**
 * 骨骼 JSON 的标志位（`FUN_140265c30` 的门，rea-mdl 2.1、2.2）：布尔键要求值确是布尔，`se` 0x1、`re` 0x2、`r` 0x1000、`t` 0x2000、
 * `ik` 0x4000、`ikce` 0x8000；物理开（`(r ‖ t) && (se ‖ re)`）、`ik` 或 `ikce` 时原样保留，三样都没有时整个清 0（`0x140266559`）。解析
 * 失败为 0。只算门用到的位（`ge`、`la` 等物理参数的位归 P12d）。
 */
export function boneJsonFlags(json: string): number {
  let parsed: unknown;
  try {
    parsed = json ? JSON.parse(json) : null;
  } catch {
    return 0;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return 0;
  const object = parsed as Record<string, unknown>;
  const bits: [string, number][] = [
    ["se", 0x1],
    ["re", 0x2],
    ["r", 0x1000],
    ["t", 0x2000],
    ["ik", 0x4000],
    ["ikce", 0x8000],
  ];
  let flags = 0;
  for (const [key, bit] of bits) if (object[key] === true) flags |= bit;
  const physics = (flags & 0x3000) !== 0 && (flags & 0x3) !== 0;
  return physics || flags & 0xc000 ? flags : 0;
}

/** 骨骼 JSON 是否开了物理（rea-mdl 2.1 的门；p12-REPORT 用例 10）。 */
export function bonePhysics(json: string): boolean {
  const flags = boneJsonFlags(json);
  return (flags & 0x3000) !== 0 && (flags & 0x3) !== 0;
}

const MODES: Record<MdlAnimation["mode"], AnimationMode> = { loop: 0, mirror: 1, single: 2 };

/**
 * 把一条动画的轨道转成帧数据（加载时的 `0x140263fa0`–`0x140264340`，rea-mdl 4.5）：每帧每骨骼 9 个 f32 → T 原样、`eulerToQuat`、S 原样。
 * 轨道 flags bit0 的骨骼 mask 为 0（rea-mdl 4.3），帧数据不转（采样不读）；文件 flags bit1 的骨骼同样标成不动画（4.3，物理接管，语料 0 根，
 * 由调用方报 `puppet:physics`）。轨道比骨骼少时多出来的骨骼 mask 为 0、比骨骼多时多的不读（语料轨道数都等于骨骼数，不等时报键）。
 */
function convertAnimation(animation: MdlAnimation, file: MdlFile, bones: number, skinned: boolean): PuppetAnimation {
  const frameCount = animation.length + 1;
  const mask = new Uint8Array(skinned ? bones : 0);
  const frames = new Float32Array(skinned ? frameCount * bones * POSE_STRIDE : 0);
  if (skinned) {
    const boneList = file.skeleton!.bones;
    for (let b = 0; b < Math.min(bones, animation.tracks.length); b++) {
      const track = animation.tracks[b];
      if (track.flags & 1 || boneList[b].flags & 2) continue;
      mask[b] = 1;
      for (let k = 0; k < frameCount; k++) {
        const s = k * 9;
        const o = (k * bones + b) * POSE_STRIDE;
        const data = track.frames;
        frames[o] = data[s];
        frames[o + 1] = data[s + 1];
        frames[o + 2] = data[s + 2];
        eulerToQuat(data[s + 3], data[s + 4], data[s + 5], frames, o + 3);
        frames[o + 7] = data[s + 6];
        frames[o + 8] = data[s + 7];
        frames[o + 9] = data[s + 8];
      }
    }
  }
  return {
    id: animation.id,
    name: animation.name,
    mode: MODES[animation.mode],
    fps: animation.fps,
    length: animation.length,
    mask,
    frames,
  };
}

/**
 * 整理一个 puppet 图层（步骤 1 点 2）。`layers` 是图层对象的 `animationlayers` 原值；`properties` 是编译期的用户属性（`{user}` 绑定的
 * 初值，同图层字段的 `resolveValue`）。返回 `puppet` 为 null 时 WPE 销毁 P、照常画四边形（mdl 没有网格，rea-mdl 9.1 第 5 条）。
 *
 * `issues`（P12a 不做、照报的细分键，子计划「总体设计思路」）：
 * - 文件：`mdl:truncated`（同模型对象）、`mdl:section:<标签>`（`MDLS` / `MDLA` 没恰好读到段末）、`mdl:skeleton:bones`（骨骼数 > 128，WPE
 *   直接终止进程）、`mdl:animation-id`（动画 id ≥ 2³²）；
 * - 网格（只看网格 0，纹理通道看全部网格）：`puppet:index32`（标志 bit0）、`puppet:alpha`（bit2 → `SKINNING_ALPHA`）、`puppet:morph`
 *   （格式含 `a_PositionVec4` → `MORPHING`）、`puppet:clipping`（v23 记录）、`puppet:texture-channels`（任一网格 bit1）。这几样不论 skinned
 *   都报（静态 puppet 上 WPE 怎么画没查清，语料的静态 puppet 都没有它们）；
 * - 动画层：`puppet:layer-script`（字段挂脚本，P12c）；
 * - 只在 skinned 时报（静态 puppet 每帧不做事，rea-RT 2）：`puppet:physics`（骨骼 JSON 的物理门，或文件 flags bit1）、`puppet:ik`
 *   （`MDLS` v ≥ 2 的记录、约束、键表、链表，或骨骼 JSON 的 `ik` / `ikce`）、动画层用到的动画里 `puppet:draw-order`（绘制顺序轨道且网格 0
 *   有 bit3）、`puppet:order-track`（有绘制顺序轨道却没有 bit3：WPE 写空指针，读码推断崩溃）、`puppet:alpha-track`（有骨骼透明度轨道
 *   却没有 bit2：WPE 崩溃，p12-REPORT 用例 5）、`puppet:animation-ref`（引用块、记录轨道、约束轨道）、`mdl:animation:tracks`（轨道数
 *   不等于骨骼数：WPE 越界，语料 0 处）。
 */
export function buildPuppet(
  file: MdlFile,
  layers: unknown,
  path: string,
  properties: Record<string, SceneScalar> = {},
): { puppet: ScenePuppet | null; issues: Set<string> } {
  const issues = new Set<string>();
  if (file.truncated) issues.add("mdl:truncated");
  for (const tag of file.sectionIssues) issues.add(`mdl:section:${tag}`);
  if (file.animations.some((animation) => animation.id >= 2 ** 32)) issues.add("mdl:animation-id");
  const mesh = file.meshes[0];
  if (!mesh) return { puppet: null, issues };

  if (mesh.flags & 1) issues.add("puppet:index32");
  if (mesh.flags & 4) issues.add("puppet:alpha");
  if (mesh.format & POSITION_VEC4) issues.add("puppet:morph");
  if (mesh.records.length) issues.add("puppet:clipping");
  if (file.meshes.some((item) => item.flags & 2)) issues.add("puppet:texture-channels");

  const skeleton = file.skeleton;
  if (skeleton && skeleton.count > MAX_BONES) issues.add("mdl:skeleton:bones");
  const bones = skeleton && skeleton.count <= MAX_BONES ? skeleton.bones : [];
  const skinned = (mesh.format & BLEND_INDICES) !== 0 && bones.length > 0;

  // 动画层（`FUN_1401fcc20`，rea-RT 1.4）：只认数组里的对象；`animation` 不是数或在 MDLA 里找不到就整层丢掉、不报
  const used: number[] = [];
  const defs: PuppetLayerDef[] = [];
  for (const entry of Array.isArray(layers) ? layers : []) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const json = entry as Record<string, unknown>;
    if (typeof json.animation !== "number" || !Number.isFinite(json.animation)) continue;
    const id = Math.trunc(json.animation);
    const index = file.animations.findIndex((animation) => animation.id === id);
    if (index < 0) continue;
    let slot = used.indexOf(index);
    if (slot < 0) slot = used.push(index) - 1;
    if (LAYER_KEYS.some((key) => isScriptValue(json[key]))) issues.add("puppet:layer-script");
    const value = (key: (typeof LAYER_KEYS)[number]) => resolveValue(json[key] as SceneValue | undefined, properties);
    const bindings: PuppetLayerDef["bindings"] = [];
    for (const field of ["rate", "blend", "visible"] as const) {
      const binding = userBindingOf(json[field] as SceneValue | undefined);
      if (binding) bindings.push({ field, ...binding });
    }
    const name = value("name");
    defs.push({
      animation: slot,
      name: typeof name === "string" ? name : "",
      rate: floatField(value("rate"), 1),
      blend: floatField(value("blend"), 1),
      visible: boolField(value("visible"), true),
      additive: boolField(value("additive"), false),
      blendin: boolField(value("blendin"), false),
      blendout: boolField(value("blendout"), false),
      blendtime: floatField(value("blendtime"), 0.5),
      bindings,
    });
  }

  if (skinned) {
    for (const bone of bones) {
      const flags = boneJsonFlags(bone.json);
      if ((flags & 0x3000 && flags & 0x3) || bone.flags & 2) issues.add("puppet:physics");
      if (flags & 0xc000) issues.add("puppet:ik");
    }
    const { records, constraints, keyMaps, chains } = skeleton!.extras;
    if (records || constraints || keyMaps || chains) issues.add("puppet:ik");
    for (const index of used) {
      const animation = file.animations[index];
      if (animation.unsupported) issues.add("puppet:animation-ref");
      if (animation.tracks.length !== bones.length) issues.add("mdl:animation:tracks");
      if (animation.boneAlpha && !(mesh.flags & 4)) issues.add("puppet:alpha-track");
      if (animation.drawOrderTrack) issues.add(mesh.flags & 8 ? "puppet:draw-order" : "puppet:order-track");
    }
  }

  const puppet: ScenePuppet = {
    path,
    mesh: {
      format: mesh.format,
      stride: mesh.stride,
      vertices: mesh.vertices,
      indices: mesh.indices,
      vertexCount: mesh.vertexCount,
      indexCount: mesh.indices.length >> 1,
    },
    combos: skinned ? { SKINNING: 1, BONECOUNT: bones.length } : {},
    skeleton: skinned ? buildSkeleton(file) : null,
    animations: used.map((index) => convertAnimation(file.animations[index], file, bones.length, skinned)),
    layers: defs,
  };
  return { puppet, issues };
}

/**
 * 骨骼的父链、逆绑定、静止姿势（rea-RT 1.1、7）。父下标越界（不是 −1 又 ≥ 骨骼数）时当根（WPE 越界读，语料 0 处）。父在后面时读到的是
 * 还没算的矩阵，WPE 新分配的是零（rea-RT 1.1），这里同样从零开始。
 */
function buildSkeleton(file: MdlFile): NonNullable<ScenePuppet["skeleton"]> {
  const source = file.skeleton!;
  const bones = source.bones;
  const n = bones.length;
  const parents = Int32Array.from(bones, (bone) => (bone.parent >= 0 && bone.parent < n ? bone.parent : -1));
  const world = new Float32Array(n * 16);
  const temp = new Float32Array(16);
  for (let i = 0; i < n; i++) {
    const parent = parents[i];
    if (parent < 0) world.set(bones[i].local, i * 16);
    else {
      mulFull(world, parent * 16, bones[i].local, 0, temp, 0);
      world.set(temp, i * 16);
    }
  }
  const inverseBind = new Float32Array(n * 16);
  for (let i = 0; i < n; i++) inverse4(world, i * 16, inverseBind, i * 16);
  const restMatrices = new Float32Array(n * 16);
  for (let i = 0; i < n; i++) restMatrices.set(source.restMatrices?.[i] ?? bones[i].local, i * 16);
  const rest = new Float32Array(n * POSE_STRIDE);
  for (let i = 0; i < n; i++) decomposeRest(restMatrices, i * 16, rest, i * POSE_STRIDE);
  return { parents, inverseBind, rest, restMatrices };
}
