/**
 * mdl（静态网格）的解析（P5c 步骤 1）。读码见 rea-p5-mesh 第 1 节，实测见 p5-REPORT「P5c 语义的实测核对」。
 *
 * WPE 所有版本的 mdl 都走同一个加载函数 `FUN_140261880`，各段按版本号门槛读（rea 1.2、1.3、1.7），所以这里也只有一个函数
 * `parseMdl`：读文件头、逐个网格读材质表、标志、包围盒、顶点格式、顶点块与索引块，再按标签读或跳过尾部段。顶点与索引字节是文件
 * 缓冲上的视图，不拷贝、不在 CPU 上逐顶点重排，GPU 上直接当顶点缓冲、索引缓冲用（步骤 2）。
 *
 * P12a 步骤 1 起，puppet 用到的部分也读出来（`.claude/plans/wpe-import/3-scene/phase12/phase-12a-mesh-animation.md`「步骤 1」点 1，
 * 格式照 rea-p12-mdl 第 1、2、4、7 节，与 `ignore/p12/rea/mdl/mdl12.py` 一一对应）：网格的绘制组（可选块 2）、v23 记录表、标志 bit1
 * 多读的 u32；尾部段里的 `MDLS`（骨骼）与 `MDLA`（动画）。`MDLE`、`MDAT`、`MDMP` 照旧整段跳过（P12a 不用）。
 *
 * 另有两张表的事实来源：顶点格式的属性表 `MDL_ATTRIBUTES`（rea 1.4，`p5c-layout` 实测偏移逐项相同），以及网格的绘制顺序
 * `meshDrawOrder`（MSVC STL `std::sort` 的移植，`p5c-order` 实测逐个复现）。
 */

/** 顶点属性的语义（D3D11 输入元素的 SemanticName）。 */
export type MdlSemantic = "POSITION" | "NORMAL" | "TANGENT" | "BLENDINDICES" | "BLENDWEIGHT" | "TEXCOORD" | "COLOR";

/** 顶点格式的一位：掩码、字节、着色器里的属性名、语义与语义号、分量数、分量类型。 */
export interface MdlAttribute {
  mask: number;
  bytes: number;
  name: string;
  semantic: MdlSemantic;
  semanticIndex: number;
  components: number;
  type: "float" | "uint";
}

const attr = (
  mask: number,
  name: string,
  semantic: MdlSemantic,
  semanticIndex: number,
  components: number,
  type: MdlAttribute["type"] = "float",
): MdlAttribute => ({ mask, bytes: components * 4, name, semantic, semanticIndex, components, type });

/** TEXCOORD n 的三种宽度（rea 1.4 表序 7–24）：`a_TexCoord<后缀>`、`a_TexCoordVec3<后缀>`、`a_TexCoordVec4<后缀>`，后缀 n = 0 时为空。 */
function texcoords(n: number, masks: [number, number, number]): MdlAttribute[] {
  const suffix = n === 0 ? "" : `C${n}`;
  return [
    attr(masks[0], `a_TexCoord${suffix}`, "TEXCOORD", n, 2),
    attr(masks[1], `a_TexCoordVec3${suffix}`, "TEXCOORD", n, 3),
    attr(masks[2], `a_TexCoordVec4${suffix}`, "TEXCOORD", n, 4),
  ];
}

/**
 * 顶点格式的 26 位（rea-p5-mesh 1.4，三张并行表 `0x140484a20` / `0x1404849b0` / `0x140484a90`），按**表序**：顶点内的属性按这个顺序
 * 交错，偏移是前面置位属性大小的累加（`FUN_1400d81b8` 建输入布局时这样算 `AlignedByteOffset`），stride 是置位属性大小之和。除
 * `a_BlendIndices`（u32×4）外都是 float。`p5c-layout` 实测：格式 `0x344988f` stride 156、`0xa34460` stride 104，输入布局每个元素的
 * 语义、格式、偏移和这张表算的逐项相同，`BLENDINDICES` 是 `R32G32B32A32_UINT`。
 * 同一个语义号的几种宽度（TEXCOORD n 的三种，POSITION 0 的两种）共用一个槽：着色器按语义配对，分量少了截断、多了补 (0, 0, 0, 1)
 * （`p5c-attr` 的 M1、M4）。
 */
export const MDL_ATTRIBUTES: readonly MdlAttribute[] = [
  attr(0x1, "a_Position", "POSITION", 0, 3),
  attr(0x10000, "a_PositionVec4", "POSITION", 0, 4),
  attr(0x2000000, "a_PositionC1", "POSITION", 1, 3),
  attr(0x2, "a_Normal", "NORMAL", 0, 3),
  attr(0x4, "a_Tangent4", "TANGENT", 0, 4),
  attr(0x800000, "a_BlendIndices", "BLENDINDICES", 0, 4, "uint"),
  attr(0x1000000, "a_BlendWeights", "BLENDWEIGHT", 0, 4),
  ...texcoords(0, [0x8, 0x10, 0x20]),
  ...texcoords(1, [0x40, 0x80, 0x100]),
  ...texcoords(2, [0x200, 0x400, 0x800]),
  ...texcoords(3, [0x1000, 0x2000, 0x4000]),
  ...texcoords(4, [0x20000, 0x40000, 0x80000]),
  ...texcoords(5, [0x100000, 0x200000, 0x400000]),
  attr(0x8000, "a_Color", "COLOR", 0, 4),
];

/** 表里全部的位；格式里有表外的位时 WPE 怎么处理没读（`checkMdlFeatures` 报 `mdl:format:<十六进制>`）。 */
export const MDL_FORMAT_BITS = MDL_ATTRIBUTES.reduce((bits, item) => bits | item.mask, 0);

/** 网格格式里的一个属性：表项加上在顶点里的字节偏移。 */
export interface MdlVertexAttribute extends MdlAttribute {
  offset: number;
}

/** 格式里置位的属性，按表序，带偏移（rea 1.4）。 */
export function meshAttributes(format: number): MdlVertexAttribute[] {
  let offset = 0;
  const out: MdlVertexAttribute[] = [];
  for (const item of MDL_ATTRIBUTES) {
    if (!(format & item.mask)) continue;
    out.push({ ...item, offset });
    offset += item.bytes;
  }
  return out;
}

/** stride：置位属性的大小之和（加载函数里展开的 24 项加循环补两项，与 `FUN_1400ea5b0` 结果相同，rea 1.4）。 */
export function mdlStride(format: number): number {
  return meshAttributes(format).reduce((sum, item) => sum + item.bytes, 0);
}

/** 语义键：语义名加语义号，如 `TEXCOORD0`。输入布局按它和着色器的属性配对（`FUN_1400f5110` 给属性写的 HLSL 语义，rea 1.4）。 */
export function semanticKey(item: Pick<MdlAttribute, "semantic" | "semanticIndex">): string {
  return `${item.semantic}${item.semanticIndex}`;
}

/** 着色器属性名的语义键；不在表里时为 undefined（`FUN_1400f4460` 只按整词找这 26 个名字）。 */
export function attributeSemantic(name: string): string | undefined {
  const item = MDL_ATTRIBUTES.find((entry) => entry.name === name);
  return item && semanticKey(item);
}

/**
 * 着色器属性（翻译器反射的 GLSL 类型名）能不能读这一项网格数据（P5c 步骤 2）：分量类型要相同（`uint` / `uvec*` 读 `a_BlendIndices` 的
 * u32，`float` / `vec*` 读其余的 float；`int` / `ivec*` 与矩阵哪个都不能读），分量数不管（少了截断、多了补 (0, 0, 0, 1)，`p5c-attr` 的
 * M1、M4）。WebGPU 的顶点格式与着色器类型也是这条规则：基础类型不同是管线校验错误，分量数不同照截断、补齐。编译期的
 * `mdl:attribute-type:<名>`（`features.ts` 的 `checkMeshAttributes`）与渲染器的顶点布局（`render/mesh.ts`）都按它判断。语料 0 个
 * 不相符的。
 */
export function attributeTypeMatches(type: string, item: Pick<MdlAttribute, "type">): boolean {
  if (/^(?:uint|uvec[234])$/.test(type)) return item.type === "uint";
  if (/^(?:float|vec[234])$/.test(type)) return item.type === "float";
  return false;
}

export interface MdlMesh {
  /** 每个皮肤一个材质路径（长度 = 文件头的皮肤数）。 */
  materials: string[];
  flags: number;
  /** 顶点格式（v < 15 取文件头的）。 */
  format: number;
  stride: number;
  /** 原文件缓冲上的视图，不拷贝。 */
  vertices: Uint8Array;
  indices: Uint8Array;
  /** floor(顶点字节 / stride)（`FUN_1401d7760`，rea 1.5）。 */
  vertexCount: number;
  /** 网格标志 bit0（rea 1.5，`p5c-ver` 的 U32 实测索引 stride 4）。 */
  indexFormat: "uint16" | "uint32";
  indexCount: number;
  /** v ≥ 17 的包围盒（min xyz、max xyz），否则 null。 */
  bounds: number[] | null;
  /** v ≥ 21 的两个可选块、v ≥ 23 的记录表非空（木偶数据，rea 1.3：语料只出现在 puppet mdl，模型对象用的都是空的）。 */
  puppet: boolean;
  /**
   * 标志 bit1 时多读的 u32（rea-p12-mdl 8.2：纹理通道网格的 `BLENDROWCOUNT`，`mesh+0x1c`）；没有 bit1 时为 0。语料 1 个网格
   * （`3811424158` 的 `01_z` 网格 1，值 1）。
   */
  blendRowCount: number;
  /**
   * v ≥ 21 的可选块 2：绘制组（rea-p12-mdl 7.2），每项 16 字节 `{u32 骨骼, i32 顺序偏移, u32 索引起点, u32 索引数}`，项数 = 字节数 >> 4。
   * 语料 92 个网格，正好把 u16 索引缓冲切成首尾相接的段。没有绘制顺序轨道时 WPE 不重排（p12-REPORT 用例 7），P12a 只解析。
   * 可选块 1（每顶点的图像空间坐标，图像层运行时没有读者，rea 7.1）照旧读过即丢。
   */
  drawGroups: MdlDrawGroup[];
  /** v ≥ 23 的记录表（rea-p12-mdl 7.3：裁切遮罩，两组下标指向绘制组）。P12b 用；P12a 只看有没有（`puppet:clipping`）。 */
  records: MdlRecord[];
}

/** 一个绘制组（可选块 2 的一项，rea-p12-mdl 7.2）。 */
export interface MdlDrawGroup {
  bone: number;
  /** 同一骨骼下各段的排序细分（i32），排序键 = 骨骼绘制顺序基数 + 它。 */
  order: number;
  start: number;
  count: number;
}

/** v23 记录表的一项（rea-p12-mdl 7.3；`list1` / `list2` 哪组是遮罩见 p12-REPORT「更正读码」，P12b 定）。 */
export interface MdlRecord {
  /** u64，按 number 存（语料都 < 2³²）。 */
  id: number;
  /** 裁切遮罩纹理路径（`masks/clipping_mask_*`，推断）。 */
  name: string;
  flags: number;
  list1: number[];
  list2: number[];
}

/** `MDLS` 的一根骨骼（rea-p12-mdl 1.2）。 */
export interface MdlBone {
  name: string;
  /** 文件里的 u32（`bone+0x64`；只有 bit1 有运行时作用：物理，语料 0 根）。 */
  flags: number;
  /** `0xFFFFFFFF` 为根，读成 −1；其余照文件的 u32。 */
  parent: number;
  /**
   * 局部 4×4 的 16 个 f32，按文件顺序原样：glm 的列主序、列向量约定，平移在 `[12..14]`（按 rea-p12-mdl 的说法就是「行主序、行向量
   * 约定，平移在第 4 行」，同一块内存）。长度前缀 L < 64 时只覆盖前 L 字节，其余保持构造缺省的单位阵（`0x14026b860`，语料全是 64）。
   */
  local: Float32Array;
  /** 骨骼 JSON 原文（`FUN_140265c30` 的输入；P12d 解析物理，P12a 只用它判断 `puppet:physics`）。 */
  json: string;
}

/** `MDLS` 段（rea-p12-mdl 1.1–1.3）。 */
export interface MdlSkeleton {
  /** `atoi(标签 + 4)`。 */
  version: number;
  /** 段里的骨骼数。大于 `MAX_BONES` 时 WPE `int 0x29` 直接终止进程（rea 1.1），这里不读骨骼（`bones` 为空），由 puppet 报键。 */
  count: number;
  bones: MdlBone[];
  /** v ≥ 2 的可选骨骼矩阵（mdl+0x48，静止姿势的来源，rea-p12-runtime 7）；没有为 null（语料 0 个有）。 */
  restMatrices: Float32Array[] | null;
  /** v ≥ 3 每骨骼绘制顺序基数（mdl+0x1e8，按 i32 用；语料 92 个有）。 */
  drawOrder: number[] | null;
  /** v ≥ 2 的记录、约束、键表、链表个数（rea 1.3 第 1、3、4、5 项；语料全 0，非 0 报 `puppet:ik`）。命中盒与命中顺序读过即丢。 */
  extras: { records: number; constraints: number; keyMaps: number; chains: number };
}

/** `MDLA` 段的一条动画（rea-p12-mdl 4.2）。 */
export interface MdlAnimation {
  /** u64（`animationlayers[].animation` 指的就是它），语料高 32 位全是 0：按 number 存，≥ 2³² 时 puppet 报 `mdl:animation-id`。 */
  id: number;
  name: string;
  /** 模式串：`mirror` / `single`，其它都是循环（`FUN_1401a8c10`，rea-p12-runtime 3.1）。 */
  mode: "loop" | "mirror" | "single";
  fps: number;
  /** 文件里的长度；帧数 = length + 1，首尾就是第 0 / 第 length 帧。 */
  length: number;
  /** 动画 flags（bit0：引用别的动画，语料 0 处）。 */
  flags: number;
  /**
   * 每条一个轨道（语料轨道数都 = 骨骼数）：轨道 flags（bit0 = 不参与动画，rea 4.3）与 `9 × (length + 1)` 个 f32，每帧依次平移 xyz、
   * 欧拉角 xyz（弧度）、缩放 xyz，不稀疏（rea 4.4）。字节 4 对齐时是原文件缓冲上的视图，否则拷一份。
   */
  tracks: { flags: number; frames: Float32Array }[];
  /** v ≥ 3 的每骨骼透明度轨道（rea 4.7 第 12 项）：P12a 只记有没有，内容由 P12b 读。 */
  boneAlpha: boolean;
  /** v ≥ 6 的每骨骼绘制顺序轨道（rea 4.7 第 15 项）：同上。 */
  drawOrderTrack: boolean;
  /** 事件：f32 秒 + 事件 JSON（rea 4.7 第 17 项）。P12c 派发。 */
  events: { time: number; json: string }[];
  /** flags bit0 的引用块、v ≥ 2 的记录轨道或约束轨道（语料 0 处，puppet 报 `puppet:animation-ref`）。 */
  unsupported: boolean;
}

export interface MdlFile {
  /** `atoi(魔数 + 4)`：不比较前 4 个字符（rea 1.2）。 */
  version: number;
  skins: number;
  meshes: MdlMesh[];
  /** 全部网格包围盒的并集；并集不满足 max.x > min.x 时（v < 17 没有包围盒）±131072（rea 1.6）。 */
  bounds: number[];
  /** 尾部段的标签（v > 12），按出现顺序。 */
  sections: string[];
  /** 读越界（文件被截断）：已读出的部分照留，能力表整个报 `mdl:truncated`。 */
  truncated: boolean;
  /** 最后一个 `MDLS` 段；没有为 null（静态 puppet、模型对象）。 */
  skeleton: MdlSkeleton | null;
  /** `MDLA` 段的动画（按文件顺序）；没有为空。 */
  animations: MdlAnimation[];
  /**
   * 读了内容却没恰好读到段末的段标签（`MDLS` / `MDLA`：读多、读少、段内读出文件末尾、长度检查不过）。WPE 的读取上限是整个文件，
   * 段内读多了会读进下一段（rea-p12-mdl 1.1），长度检查不过时 `int 0x29` 终止进程（4.2）；语料 137 个文件 0 处，puppet 报
   * `mdl:section:<标签>`。和 `truncated` 无关：段外的结构照旧，模型对象的能力表结果不变。
   */
  sectionIssues: string[];
}

/** 骨骼数上限（rea-p12-mdl 1.1：`> 0x80` 时 `int 0x29`）。 */
export const MAX_BONES = 0x80;

/** 并集退化时的包围盒（`0xc8000000` / `0x48000000`，rea 1.6）：等于不剔除。 */
const UNBOUNDED = [-131072, -131072, -131072, 131072, 131072, 131072];

/** 读越界：WPE 的读取原语这时返回 0 / 空串（rea 1.1），语料全部恰好读到末尾、没有截断的样本，所以不猜，整个文件报截断。 */
class Truncated extends Error {}

/** 段内容不合格式（WPE 在这里 `int 0x29` 终止进程，或行为未定义；语料 0 处）：只记这一段（`sectionIssues`）。 */
class Malformed extends Error {}

/** 单位阵的 16 个 f32（骨骼局部矩阵的构造缺省，`0x14026b860`）。 */
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** 小端、无对齐填充的顺序读取（rea 1.1 的读取原语）。 */
class MdlReader {
  private readonly view: DataView;
  pos = 0;
  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  private take(n: number): number {
    if (this.pos + n > this.bytes.length) throw new Truncated();
    const at = this.pos;
    this.pos += n;
    return at;
  }
  skip(n: number): void {
    this.take(n);
  }
  u8(): number {
    return this.bytes[this.take(1)];
  }
  u16(): number {
    return this.view.getUint16(this.take(2), true);
  }
  u32(): number {
    return this.view.getUint32(this.take(4), true);
  }
  i32(): number {
    return this.view.getInt32(this.take(4), true);
  }
  /** u64（`FUN_1402616b0`）：按 number 返回，超过 2⁵³ 会丢精度（语料都 < 2³²，调用方据此报键）。 */
  u64(): number {
    const at = this.take(8);
    return this.view.getUint32(at + 4, true) * 2 ** 32 + this.view.getUint32(at, true);
  }
  f32(): number {
    return this.view.getFloat32(this.take(4), true);
  }
  /** 裸 64 字节的 4×4（`FUN_140261710` / 内联读）：拷一份，免得对齐问题。 */
  matrix(): Float32Array {
    const at = this.take(64);
    return new Float32Array(this.bytes.slice(at, at + 64).buffer);
  }
  /**
   * `FUN_1400d3ef0(r, dst, 64)`（rea-p12-mdl「方法」）：u32 长度 L + 拷 min(L, 64) 字节，只前进拷贝的字节数；没拷到的部分保持单位阵。
   * 剩余不足 64 + 4 字节时 WPE 不读（语料 0 处，按越界）；L 为负（≥ 2³¹）时也不读（语料 0 处，按格式错误报这一段）。
   */
  lengthMatrix(): Float32Array {
    if (this.pos + 64 + 4 > this.bytes.length) throw new Truncated();
    const length = this.u32();
    if (length >= 2 ** 31) throw new Malformed();
    const n = Math.min(length, 64);
    const at = this.take(n);
    const out = new Float32Array(IDENTITY);
    new Uint8Array(out.buffer).set(this.bytes.subarray(at, at + n));
    return out;
  }
  /** 以 `\0` 结尾的字符串；到文件末尾还没有 `\0` 算越界。 */
  cstr(): string {
    const end = this.bytes.indexOf(0, this.pos);
    if (end < 0) throw new Truncated();
    const text = new TextDecoder().decode(this.bytes.subarray(this.pos, end));
    this.pos = end + 1;
    return text;
  }
  /** u32 字节数 + 字节块（`FUN_14009c5c0`）：返回文件缓冲上的视图。 */
  block(): Uint8Array {
    const length = this.u32();
    const at = this.take(length);
    return this.bytes.subarray(at, at + length);
  }
}

/**
 * 按文件里的个数逐个读：个数是坏的（很大）时读到文件末尾抛 `Truncated`，不会先按个数分配一个巨大的数组（`Array.from({ length })` 会抛
 * `RangeError`）。
 */
function repeat<T>(count: number, read: () => T): T[] {
  const out: T[] = [];
  for (let i = 0; i < count; i++) out.push(read());
  return out;
}

/** C 的 `atoi`：跳过前导空白，可带符号，读到第一个非数字为止；没有数字时为 0。 */
function atoi(text: string): number {
  return Number.parseInt(text, 10) || 0;
}

/**
 * 解析一个 mdl（rea-p5-mesh 1.2–1.7，照 `ignore/p5/rea/mesh/mdl.py`）。不抛错：读越界时 `truncated` 为真，已读出的网格照留。
 * - 文件头：魔数串（版本 = `atoi(魔数 + 4)`）、u32 格式（v < 15 时是所有网格的顶点格式）、u32 皮肤数、u32 网格数；
 * - 每个网格：皮肤数个材质路径；v ≥ 4 时 u32 标志，标志 bit1 时多一个 u32（含义未读，`p5c-ver` 的 B1 照常显示）；v ≥ 17 时 6 个 f32
 *   包围盒；v ≥ 15 时 u32 格式；顶点块、索引块；v ≥ 21 时两个可选块（u8 为真时才有）；v ≥ 23 时记录表；
 * - v > 12 时尾部段：标签串 + u32 段末绝对偏移 + 数据，下一个标签从段末读，所以不认识的段整段跳过（`p5c-ver` 的 S14 / S23），
 *   读到空标签结束。段末不在当前位置与文件末尾之间时算越界（WPE 把读取上限设成 `min(段末, 文件长)`，倒退的段末会重读，不猜）。
 *   `MDLS`、`MDLA`（只比前 4 个字符，版本 = `atoi(标签 + 4)`，rea-p12-mdl 1.1、4.1）读出内容（`readSkeleton` / `readAnimations`），
 *   读完核对恰好到段末，不一致只记进 `sectionIssues`；无论读成怎样，下一个标签都从段头写的段末读（同 WPE）。
 */
export function parseMdl(bytes: Uint8Array): MdlFile {
  const reader = new MdlReader(bytes);
  const file: MdlFile = {
    version: 0,
    skins: 0,
    meshes: [],
    bounds: UNBOUNDED,
    sections: [],
    truncated: false,
    skeleton: null,
    animations: [],
    sectionIssues: [],
  };
  try {
    file.version = atoi(reader.cstr().slice(4));
    const version = file.version;
    const headerFormat = reader.u32();
    file.skins = reader.u32();
    const count = reader.u32();
    for (let m = 0; m < count; m++) {
      const materials = Array.from({ length: file.skins }, () => reader.cstr());
      const flags = version >= 4 ? reader.u32() : 0;
      const blendRowCount = flags & 2 ? reader.u32() : 0;
      const bounds = version >= 17 ? Array.from({ length: 6 }, () => reader.f32()) : null;
      const format = version >= 15 ? reader.u32() : headerFormat;
      const stride = mdlStride(format);
      const vertices = reader.block();
      const indices = reader.block();
      const indexFormat = flags & 1 ? "uint32" : "uint16";
      let puppet = false;
      let drawGroups: MdlDrawGroup[] = [];
      const records: MdlRecord[] = [];
      if (version >= 21) {
        // 可选块 1：u32（`0x140261b79` 的返回值没存，语料恒 1）+ 字节块（rea-p12-mdl 7.1），读过即丢
        if (reader.u8()) {
          reader.u32();
          reader.block();
          puppet = true;
        }
        if (reader.u8()) {
          drawGroups = readDrawGroups(reader.block());
          puppet = true;
        }
      }
      if (version >= 23) {
        const length = reader.u32();
        // 每项：u64 id、名字、u32 标志、两组「u32 个数 + 个数 × u32」（rea-p5-mesh 1.3 第 10 行、rea-p12-mdl 7.3）
        for (let r = 0; r < length; r++) {
          const id = reader.u64();
          const name = reader.cstr();
          const recordFlags = reader.u32();
          const lists = [0, 1].map(() => repeat(reader.u32(), () => reader.u32()));
          records.push({ id, name, flags: recordFlags, list1: lists[0], list2: lists[1] });
        }
        if (length > 0) puppet = true;
      }
      file.meshes.push({
        materials,
        flags,
        format,
        stride,
        vertices,
        indices,
        vertexCount: stride > 0 ? Math.floor(vertices.length / stride) : 0,
        indexFormat,
        indexCount: Math.floor(indices.length / (indexFormat === "uint32" ? 4 : 2)),
        bounds,
        puppet,
        blendRowCount,
        drawGroups,
        records,
      });
    }
    file.bounds = unionBounds(file.meshes);
    if (version > 12)
      for (;;) {
        const tag = reader.cstr();
        if (!tag) break;
        file.sections.push(tag);
        const end = reader.u32();
        if (end < reader.pos || end > bytes.length) throw new Truncated();
        readSection(reader, tag, end, file);
        reader.pos = end;
      }
  } catch (error) {
    if (!(error instanceof Truncated)) throw error;
    file.truncated = true;
  }
  return file;
}

/**
 * 读一个尾部段的内容（只认 `MDLS`、`MDLA`，其余不动）。段内读出文件末尾、格式不合、没恰好读到段末，都只把标签记进 `sectionIssues`，
 * 不影响 `truncated` 与之后的段（读取器的位置由调用方拨回段末）。骨骼数超过 `MAX_BONES` 时 WPE 直接终止进程，这里停在骨骼数之后、
 * 不核对段末（由 puppet 报 `mdl:skeleton:bones`，不重复报 `mdl:section:MDLS`）。
 */
function readSection(reader: MdlReader, tag: string, end: number, file: MdlFile): void {
  const kind = tag.slice(0, 4);
  if (kind !== "MDLS" && kind !== "MDLA") return;
  const version = atoi(tag.slice(4));
  try {
    if (kind === "MDLS") {
      const skeleton = readSkeleton(reader, version);
      file.skeleton = skeleton;
      if (skeleton.count > MAX_BONES) return;
    } else file.animations = readAnimations(reader, version, file.skeleton, file.meshes.length);
    if (reader.pos !== end) file.sectionIssues.push(tag);
  } catch (error) {
    if (!(error instanceof Truncated) && !(error instanceof Malformed)) throw error;
    file.sectionIssues.push(tag);
  }
}

/** 可选块 2 的绘制组（rea-p12-mdl 7.2）：项数 = 字节数 >> 4，零头不读。 */
function readDrawGroups(block: Uint8Array): MdlDrawGroup[] {
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
  return Array.from({ length: block.length >> 4 }, (_, i) => ({
    bone: view.getUint32(i * 16, true),
    order: view.getInt32(i * 16 + 4, true),
    start: view.getUint32(i * 16 + 8, true),
    count: view.getUint32(i * 16 + 12, true),
  }));
}

/**
 * `MDLS` v1–v4（`0x1402624c1`–`0x140263963`，rea-p12-mdl 1.1–1.3，照 `mdl12.py` 的 `parse_mdls`）：
 * - u32 骨骼数（> 128 时停，见 `readSection`）；每骨骼：名字、u32 文件 flags、u32 父、长度前缀的局部矩阵、JSON 串；
 * - v ≥ 2：u16 个记录（名字、u32 id、u32 类型、裸矩阵）；u8 开关的可选矩阵（骨骼数个 → 静止姿势来源，记录数个读过即丢）；u32 个约束
 *   （骨骼、a、b，v ≥ 4 多一个 flags，flags bit1 再多两个 f32）；u16 个键（先 n 个 u32，再每个一张 `u16 个 {u32, 12 字节}`）；u16 个链
 *   （骨骼、u32 个记录下标、u16 个子项，每个子项：骨骼、u16 个孙项，每个孙项：骨骼、flags、两个 f32、u16 个骨骼下标）；u8 开关的命中盒
 *   （每骨骼 vec3 + 矩阵）、u8 开关的命中顺序（每骨骼 u32）——这几样语料全 0 / 只用于光标命中，读过即丢，只记个数；
 * - v ≥ 3：u8 开关的每骨骼绘制顺序（u32，按 i32 用）。
 * WPE 对链表的下标做越界检查（`int 0x29`）；这里不查，链表非空本来就报 `puppet:ik`。
 */
function readSkeleton(reader: MdlReader, version: number): MdlSkeleton {
  const count = reader.u32();
  const skeleton: MdlSkeleton = {
    version,
    count,
    bones: [],
    restMatrices: null,
    drawOrder: null,
    extras: { records: 0, constraints: 0, keyMaps: 0, chains: 0 },
  };
  if (count > MAX_BONES) return skeleton;
  for (let i = 0; i < count; i++) {
    const name = reader.cstr();
    const flags = reader.u32();
    const parent = reader.u32();
    const local = reader.lengthMatrix();
    const json = reader.cstr();
    skeleton.bones.push({ name, flags, parent: parent === 0xffffffff ? -1 : parent, local, json });
  }
  if (version >= 2) {
    const records = reader.u16();
    for (let r = 0; r < records; r++) {
      reader.cstr();
      reader.skip(8 + 64);
    }
    if (reader.u8()) {
      skeleton.restMatrices = skeleton.bones.map(() => reader.matrix());
      reader.skip(records * 64);
    }
    const constraints = reader.u32();
    for (let c = 0; c < constraints; c++) {
      reader.skip(12);
      const flags = version >= 4 ? reader.u32() : 0;
      if (flags & 2) reader.skip(8);
    }
    const keyMaps = reader.u16();
    reader.skip(keyMaps * 4);
    for (let k = 0; k < keyMaps; k++) reader.skip(reader.u16() * 16);
    const chains = reader.u16();
    for (let j = 0; j < chains; j++) {
      reader.u32();
      reader.skip(reader.u32() * 4);
      const items = reader.u16();
      for (let p = 0; p < items; p++) {
        reader.u32();
        const subs = reader.u16();
        for (let q = 0; q < subs; q++) {
          reader.skip(16);
          reader.skip(reader.u16() * 4);
        }
      }
    }
    if (reader.u8()) reader.skip(count * (12 + 64));
    if (reader.u8()) reader.skip(count * 4);
    skeleton.extras = { records, constraints, keyMaps, chains };
  }
  if (version >= 3 && reader.u8()) skeleton.drawOrder = Array.from({ length: count }, () => reader.i32());
  return skeleton;
}

/**
 * 一条 f32 轨道的字节块要恰好是 `size × (length + 1)` 字节（WPE 不满足时 `int 0x29`，rea-p12-mdl 4.2；语料 12187 条骨骼轨道全部满足）。
 */
function checkTrack(block: Uint8Array, size: number, frames: number): Uint8Array {
  if (block.length % size !== 0 || block.length / size !== frames) throw new Malformed();
  return block;
}

/** f32 数组：字节 4 对齐时是原缓冲上的视图（不拷贝），否则拷一份（`Float32Array` 视图要求偏移对齐）。 */
function floatView(block: Uint8Array): Float32Array {
  return block.byteOffset % 4 === 0
    ? new Float32Array(block.buffer, block.byteOffset, block.length >> 2)
    : new Float32Array(block.slice().buffer);
}

/**
 * `MDLA` v1–v6（`0x140263968`–`0x140265577`，rea-p12-mdl 4.2，照 `mdl12.py` 的 `parse_mdla`）。每条动画按顺序：u64 id、名字、模式串、
 * f32 fps、u32 长度、u32 flags、u32 个骨骼轨道（u32 flags + 字节块）；v ≥ 2 每个 MDLS 记录一条同样的轨道、每个约束一条 f32 轨道；
 * v ≥ 3 u32 条「u32 + f32 轨道」（纹理通道权重）、u8 开关的每轨道 f32 轨道（骨骼透明度）；v ≥ 4 u8 开关的每网格变形权重；v ≥ 5 六个
 * f32；v ≥ 6 u8 开关的每轨道 f32 轨道（绘制顺序）；flags bit0 时引用块（u16 + 4 × u32）；最后 u32 个事件（f32 秒 + JSON 串）。
 * 「读了不用」的 u32（rea 4.2 第 11、12、15 项）照读。记录数、约束数取此前读到的 `MDLS`（没有就是 0，同 WPE 用 mdl 的当前状态）。
 */
function readAnimations(
  reader: MdlReader,
  version: number,
  skeleton: MdlSkeleton | null,
  meshes: number,
): MdlAnimation[] {
  const records = skeleton?.extras.records ?? 0;
  const constraints = skeleton?.extras.constraints ?? 0;
  const count = reader.u32();
  const out: MdlAnimation[] = [];
  for (let a = 0; a < count; a++) {
    const id = reader.u64();
    const name = reader.cstr();
    const modeText = reader.cstr();
    const mode = modeText === "mirror" ? "mirror" : modeText === "single" ? "single" : "loop";
    const fps = reader.f32();
    const length = reader.u32();
    const flags = reader.u32();
    const frames = length + 1;
    const trackCount = reader.u32();
    const tracks = repeat(trackCount, () => {
      const trackFlags = reader.u32();
      return { flags: trackFlags, frames: floatView(checkTrack(reader.block(), 36, frames)) };
    });
    let unsupported = (flags & 1) !== 0;
    const scalars = (n: number) => {
      for (let k = 0; k < n; k++) {
        reader.u32();
        checkTrack(reader.block(), 4, frames);
      }
    };
    if (version >= 2) {
      for (let r = 0; r < records; r++) {
        reader.u32();
        checkTrack(reader.block(), 36, frames);
      }
      scalars(constraints);
      if (records > 0 || constraints > 0) unsupported = true;
    }
    let boneAlpha = false;
    if (version >= 3) {
      scalars(reader.u32());
      if (reader.u8()) {
        boneAlpha = true;
        scalars(trackCount);
      }
    }
    if (version >= 4 && reader.u8())
      for (let m = 0; m < meshes; m++) {
        if (!(reader.u32() & 1)) continue;
        reader.u32();
        const targets = reader.u16();
        for (let t = 0; t < targets; t++) {
          reader.u16();
          checkTrack(reader.block(), 4, frames);
        }
      }
    if (version >= 5) reader.skip(24);
    let drawOrderTrack = false;
    if (version >= 6 && reader.u8()) {
      drawOrderTrack = true;
      scalars(trackCount);
    }
    if (flags & 1) reader.skip(2 + 16);
    const events = repeat(reader.u32(), () => ({ time: reader.f32(), json: reader.cstr() }));
    out.push({ id, name, mode, fps, length, flags, tracks, boneAlpha, drawOrderTrack, events, unsupported });
  }
  return out;
}

/**
 * 全部网格包围盒的并集（`FUN_1402617c0`，rea 1.6）：不满足 max.x > min.x 时（v < 17 没有包围盒，或 puppet 写的全 0）改成 ±131072。
 * 只用于视锥剔除（`p5c-frustum` 实测在正交场景里生效、按外接球判，步骤 2）。
 */
function unionBounds(meshes: readonly MdlMesh[]): number[] {
  const out = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const { bounds } of meshes) {
    if (!bounds) continue;
    for (let axis = 0; axis < 3; axis++) {
      out[axis] = Math.min(out[axis], bounds[axis]);
      out[axis + 3] = Math.max(out[axis + 3], bounds[axis + 3]);
    }
  }
  return out[3] > out[0] ? out : UNBOUNDED;
}

/**
 * 对象 `skin` 选第几个材质（`p5c-skin` 实测，推翻了 rea 2.4 的「负数按无符号落到最后一项」）：非负整数（含 `1.0` 这样的整数值）取
 * min(skin, N − 1)，其余（负数、字符串、布尔、缺键、绑属性的对象）一律 0。
 */
export function meshSkin(skin: unknown, count: number): number {
  return typeof skin === "number" && Number.isInteger(skin) && skin >= 0 ? Math.min(skin, count - 1) : 0;
}

/** MSVC STL 的 `_ISORT_MAX`：不超过 32 个元素的区间直接插入排序。 */
const ISORT_MAX = 32;

/**
 * 模型内网格的绘制顺序（rea 2.4 的比较器 `0x14021a620`：a 不透明且 b 半透明时 a 在前；`FUN_140228440` 是 MSVC 的 `std::sort`）。
 * `opaque[i]`：网格 i 的材质 blending 是 normal / alphatocoverage。返回网格下标的顺序。
 *
 * 照 MSVC STL 移植（`ignore/p5/c0/sim_sort.py`，逐个复现了 `p5c-order` 的 40 个网格）：`_Sort_unchecked` 在区间不超过 32 个时插入排序
 * （稳定），否则 `_Partition_by_median_guess_unchecked`（三数取中，超过 40 个用 ninther）划分后对小的一侧递归、大的一侧循环。所以
 * 不超过 32 个网格时就是稳定排序，更多时同类网格的顺序会被打乱（`p5c-order` 的 MANY：`39, 1, 11, 3, 19, …`）。
 * 堆排序那一支（`_Ideal` 耗尽）没有移植：比较器只有两个等价类，一次划分就把和枢轴同类的全部收进中间，两侧各只剩一类，再划分一次
 * 两侧都为空，递归最多两层，`_Ideal`（每层乘 3/4）走不到 0。
 */
export function meshDrawOrder(opaque: readonly boolean[]): number[] {
  const v = opaque.map((_, i) => i);
  const less = (a: number, b: number) => opaque[a] && !opaque[b];
  const swap = (i: number, j: number) => {
    [v[i], v[j]] = [v[j], v[i]];
  };
  const insertionSort = (first: number, last: number) => {
    for (let mid = first + 1; mid < last; mid++) {
      const value = v[mid];
      if (less(value, v[first])) {
        v.copyWithin(first + 1, first, mid);
        v[first] = value;
        continue;
      }
      let hole = mid;
      for (let prev = hole - 1; less(value, v[prev]); prev--) {
        v[hole] = v[prev];
        hole = prev;
      }
      v[hole] = value;
    }
  };
  const med3 = (a: number, b: number, c: number) => {
    if (less(v[b], v[a])) swap(a, b);
    if (less(v[c], v[b])) {
      swap(b, c);
      if (less(v[b], v[a])) swap(a, b);
    }
  };
  const guessMedian = (first: number, mid: number, last: number) => {
    const count = last - first;
    if (count > 40) {
      const step = (count + 1) >> 3;
      const two = step << 1;
      med3(first, first + step, first + two);
      med3(mid - step, mid, mid + step);
      med3(last - two, last - step, last);
      med3(first + step, mid, last - step);
    } else med3(first, mid, last);
  };
  const equal = (a: number, b: number) => !less(a, b) && !less(b, a);
  /** `_Partition_by_median_guess_unchecked`：返回和枢轴等价的区间 [pfirst, plast)。 */
  const partition = (first: number, last: number): [number, number] => {
    const mid = first + ((last - first) >> 1);
    guessMedian(first, mid, last - 1);
    let pfirst = mid;
    let plast = pfirst + 1;
    while (first < pfirst && equal(v[pfirst - 1], v[pfirst])) pfirst--;
    while (plast < last && equal(v[plast], v[pfirst])) plast++;
    let gfirst = plast;
    let glast = pfirst;
    for (;;) {
      for (; gfirst < last; gfirst++) {
        if (less(v[pfirst], v[gfirst])) continue;
        if (less(v[gfirst], v[pfirst])) break;
        if (plast !== gfirst) swap(plast, gfirst);
        plast++;
      }
      for (; first < glast; glast--) {
        if (less(v[glast - 1], v[pfirst])) continue;
        if (less(v[pfirst], v[glast - 1])) break;
        if (--pfirst !== glast - 1) swap(pfirst, glast - 1);
      }
      if (glast === first && gfirst === last) return [pfirst, plast];
      if (glast === first) {
        if (plast !== gfirst) swap(pfirst, plast);
        plast++;
        swap(pfirst, gfirst);
        pfirst++;
        gfirst++;
      } else if (gfirst === last) {
        if (--glast !== --pfirst) swap(glast, pfirst);
        swap(pfirst, --plast);
      } else swap(gfirst++, --glast);
    }
  };
  const sort = (first: number, last: number) => {
    while (last - first > ISORT_MAX) {
      const [mfirst, msecond] = partition(first, last);
      if (mfirst - first < last - msecond) {
        sort(first, mfirst);
        first = msecond;
      } else {
        sort(msecond, last);
        last = mfirst;
      }
    }
    insertionSort(first, last);
  };
  sort(0, v.length);
  return v;
}
