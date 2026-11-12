/**
 * mdl（静态网格）的解析（P5c 步骤 1）。读码见 rea-p5-mesh 第 1 节，实测见 p5-REPORT「P5c 语义的实测核对」。
 *
 * WPE 所有版本的 mdl 都走同一个加载函数 `FUN_140261880`，各段按版本号门槛读（rea 1.2、1.3、1.7），所以这里也只有一个函数
 * `parseMdl`：读文件头、逐个网格读材质表、标志、包围盒、顶点格式、顶点块与索引块，再按标签跳过尾部段。顶点与索引字节是文件缓冲上
 * 的视图，不拷贝、不在 CPU 上逐顶点重排，GPU 上直接当顶点缓冲、索引缓冲用（步骤 2）。
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
}

/** 并集退化时的包围盒（`0xc8000000` / `0x48000000`，rea 1.6）：等于不剔除。 */
const UNBOUNDED = [-131072, -131072, -131072, 131072, 131072, 131072];

/** 读越界：WPE 的读取原语这时返回 0 / 空串（rea 1.1），语料全部恰好读到末尾、没有截断的样本，所以不猜，整个文件报截断。 */
class Truncated extends Error {}

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
  u32(): number {
    return this.view.getUint32(this.take(4), true);
  }
  f32(): number {
    return this.view.getFloat32(this.take(4), true);
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
 */
export function parseMdl(bytes: Uint8Array): MdlFile {
  const reader = new MdlReader(bytes);
  const file: MdlFile = { version: 0, skins: 0, meshes: [], bounds: UNBOUNDED, sections: [], truncated: false };
  try {
    file.version = atoi(reader.cstr().slice(4));
    const version = file.version;
    const headerFormat = reader.u32();
    file.skins = reader.u32();
    const count = reader.u32();
    for (let m = 0; m < count; m++) {
      const materials = Array.from({ length: file.skins }, () => reader.cstr());
      const flags = version >= 4 ? reader.u32() : 0;
      if (flags & 2) reader.u32();
      const bounds = version >= 17 ? Array.from({ length: 6 }, () => reader.f32()) : null;
      const format = version >= 15 ? reader.u32() : headerFormat;
      const stride = mdlStride(format);
      const vertices = reader.block();
      const indices = reader.block();
      const indexFormat = flags & 1 ? "uint32" : "uint16";
      let puppet = false;
      if (version >= 21) {
        if (reader.u8()) {
          reader.u32();
          reader.block();
          puppet = true;
        }
        if (reader.u8()) {
          reader.block();
          puppet = true;
        }
      }
      if (version >= 23) {
        const records = reader.u32();
        // 每项：u64、名字、u32 标志、两组「u32 个数 + 个数 × u32」（rea 1.3 第 10 行）
        for (let r = 0; r < records; r++) {
          reader.skip(8);
          reader.cstr();
          reader.u32();
          for (let list = 0; list < 2; list++) {
            const length = reader.u32();
            for (let k = 0; k < length; k++) reader.u32();
          }
        }
        if (records > 0) puppet = true;
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
        reader.pos = end;
      }
  } catch (error) {
    if (!(error instanceof Truncated)) throw error;
    file.truncated = true;
  }
  return file;
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
