/**
 * 材质常量的取值，照 WPE 2.8.42 读码（`.claude/plans/wpe-import/3-scene/vector-constant-REPORT.md`，下称「报告」），
 * 第 6 节 `p4b-vec` 实测与读码 36 格全部吻合。
 *
 * 一个材质键在 WPE 里只有一份存储，按 setter 的类型（1–4 个 float）存：
 * - 加载：`constantshadervalues` 没有这个键时插入注解缺省值（float 存 `atof` 的数、向量存字符串，报告 2.3 第 2 步）；
 *   `usershadervalues` 把它改写成 `{value, user}`（第 3 步）；再用 setter 写一次（第 5 步，对象取 `value`）。
 * - 场景构造完，以属性全集走一次运行时路径：每条用户绑定把属性值交给同一个 setter，带 condition 的换成布尔（报告 2.5）。
 * - setter（报告 2.4）要么整体写满 N 个分量，要么一个都不写；所以就地写只要新值，不需要旧存储。
 *
 * 按用户决定（2026-11-08）不复刻两条冷门行为（报告第 5 / 6 节）：同一阶段两个 uniform 同键时 WPE 只上传后声明的，
 * 我们两个都照常填；WPE 按声明行（含注释）的子串定类型，我们按真实的声明类型。
 */
import type { UniformLayout } from "../wpesl2wgsl";

/** WPE 每个材质 pass 的常量存储只有 48 个 float（`FUN_1401515b0` 清零 `+0x120` 起 0xc0 字节，槽位累加到 0x30 为止）。 */
export const MATERIAL_SLOT_FLOATS = 48;

/** 一个 uniform 怎么从材质常量取值。 */
export interface MaterialMember {
  name: string;
  /** 块里这一格的分量数（声明类型；数组为元素分量 × 长度）：写回时补满，没写到的为 0。 */
  size: number;
  /**
   * setter 的分量数：自己的声明类型；拆开的两半都取「主格」那一半的（报告 2.1 合并表里片元覆盖顶点，没读到这个键的阶段
   * 不进合并表，所以是读到它的片元一半，没有再取读到的顶点一半，见 `materialSlots`）。
   */
  components: number;
  /** 从存储拷几个分量：自己的声明分量数；数组为 0（见 `materialSlots`）。 */
  count: number;
  /** 注解 `default`：拆开的两半都取主格那一半的。 */
  default: unknown;
}

/** 一个材质键：读它的各个 uniform（主格排第一：拆开时是定合并类型的那一半，否则是第一个）与复刻不了的情况。 */
export interface MaterialSlot {
  material: string;
  members: MaterialMember[];
  /**
   * 有没有阶段读到这个键（任一格不带翻译器的 `unused`）：WPE 只给被使用的键分配槽位（p7-REPORT「P7d 的实测」`kbslot`），
   * 没被读的键不占 48 个 float 的预算。取值照常填（这一格没人读，填什么都一样）。
   */
  used: boolean;
  issues: string[];
}

/**
 * C 的 `atof`（WPE 用 `common_atof_l`，`FUN_1402d06ac`）：跳过前导空白，读最长的十进制浮点前缀，读不出为 0。
 * `inf` / `nan` / 十六进制浮点没有复刻（语料里没有）。
 */
export function atof(text: string): number {
  const match = /^[ \t\n\v\f\r]*([+-]?(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?))/.exec(text);
  return match ? Number(match[1]) : 0;
}

/**
 * 向量 setter 的字符串分支（`FUN_1401a3fc0` / `FUN_1401a4230` / `FUN_1401a4580`，报告 2.4）：先把 N 个分量清零；
 * `atof` 读第一段；从当前位置往后找第一个空格（只认 0x20），跳过连续空格再 `atof`；最多 N 段。
 * 所以 `"a, b"` 得 (a, b)、`"a,b"` 得 (a, 0)、前导空格让第一段读两次、tab 不算分隔（第 6 节 `comma*` / `lead-sp` / `tab`）。
 */
function vectorFromString(text: string, n: number): number[] {
  const out = new Array<number>(n).fill(0);
  if (!text) return out;
  out[0] = atof(text);
  let at = 0;
  for (let k = 1; k < n; k++) {
    const space = text.indexOf(" ", at);
    if (space < 0) break;
    at = space;
    while (text[at] === " ") at++;
    out[k] = atof(text.slice(at));
  }
  return out;
}

function writeValue(n: number, value: unknown): number[] | null {
  // jsoncpp 的 int / uint / real：float 写一个分量，向量铺满（第 6 节 `num-*`）
  if (typeof value === "number") return new Array<number>(n).fill(value);
  // 字符串只有向量收（float 的 `FUN_1401a4b00` 只认数字，第 6 节 `s1-f` / `s2-f`）
  if (typeof value === "string" && n > 1) return vectorFromString(value, n);
  // 布尔、null、数组：不写（第 6 节 `bool-*` / `array-v3`）
  return null;
}

/**
 * WPE 的材质常量 setter（报告 2.4）：返回写入的 n 个分量，不写返回 null（存储保持原值，初值 0）。
 * 对象（`{user, value}`、`{script, value}`、`{animation, value}`）开着解析绑定时取 `value`，按同一规则写，不再往下取。
 */
export function materialSetter(n: number, value: unknown): number[] | null {
  if (value && typeof value === "object" && !Array.isArray(value))
    return "value" in value ? writeValue(n, (value as { value: unknown }).value) : null;
  return writeValue(n, value);
}

/**
 * 注解 `default` 插进 `constantshadervalues` 的样子（`FUN_1401636a0` 存成字符串，`FUN_140154480` 插入，报告 2.1 / 2.3）：
 * 字符串原样，数字转十进制（WPE 取 float 的最短表示，经 `atof` 回读后写进 f32 存储，与直接用这个数相同），其余为空串；
 * float 插 `atof(串)` 的数，向量插串本身。所以数字缺省进向量**不铺满**（第 6 节 `defn-*`）。
 */
export function materialDefault(n: number, value: unknown): number | string {
  const text = typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
  return n === 1 ? atof(text) : text;
}

/** `{value: …}` 取里面那一层（`usershadervalues` 改写时的「原值」，报告 2.3 第 3 步）。 */
export function unwrapValue(value: unknown): unknown {
  return value && typeof value === "object" && !Array.isArray(value) && "value" in value
    ? (value as { value: unknown }).value
    : value;
}

/**
 * 一格每个数组元素的分量数：按 WPESL 声明类型（`float` / `int` / `bool` 1，`vecN` N，`matN` N×N）；手写的测试数据没有
 * `declared` 时按 WGSL 类型（`vec3<f32>`、`mat4x4<f32>`，数组取元素）。认不出按 1。
 */
function elementComponents(uniform: Pick<UniformLayout, "declared" | "type">): number {
  if (uniform.declared) {
    const m = /^(?:[biud]?vec(\d)|mat(\d)(?:x(\d))?)$/.exec(uniform.declared.trim());
    if (!m) return 1;
    return m[1] ? Number(m[1]) : Number(m[2]) * Number(m[3] ?? m[2]);
  }
  const element = /^array<\s*(.+?)\s*,\s*\d+\s*>$/.exec(uniform.type.trim())?.[1] ?? uniform.type.trim();
  const m = /^(?:vec(\d)|mat(\d)x(\d))/.exec(element);
  if (!m) return 1;
  return m[1] ? Number(m[1]) : Number(m[2]) * Number(m[3]);
}

/** 分量数 → 绑定目标与脚本取值的形状（WPE 的描述符按 setter 类型建 float / vec2 / vec3 / vec4，报告 2.3 第 4 步）。 */
export function componentsType(components: number): "float" | "vec2" | "vec3" | "vec4" {
  return components === 2 ? "vec2" : components === 3 ? "vec3" : components === 4 ? "vec4" : "float";
}

/**
 * 按 `meta.material` 把 uniform 分组成材质键。
 * - 翻译器拆开的两半（带 `stage`，同一个键而类型不同）：WPE 只有一份存储（报告 2.1），按合并表里的类型写。合并表只收本阶段反射里
 *   被使用的键、片元覆盖顶点（p7-REPORT「P7d 的实测」），所以两半的 setter 类型与缺省值取「主格」：读到它的片元一半，没有再取读到的
 *   顶点一半（`frame_builder_by_gariam` 的 `u_refResolution` 只有顶点读，按顶点的 `vec2` 写），两半都没读时照旧取片元一半。
 *   被读的一半拷的分量比主格多时会读到排序后下一个被使用的键的存储（报告 2.2、`kbslot`），复刻不了，报 `constant:mixed-type:<键>`；
 *   没被读的那一半 WPE 不上传，不比宽度。
 * - 其余同键的 uniform（同一阶段两个名字共用一个键）：按用户决定各按自己的声明类型与缺省值照常填。
 * - 数组不收材质值：WPE 取名字时连 `[n]` 一起取，反射里查不到（报告 2.1，`FUN_1401636a0`，推断；语料里没有）。
 * - `used`：有一格被读（翻译器反射里不带 `unused`）。没带 `unused` 的手写测试数据都当被读。
 */
export function materialSlots(uniforms: readonly UniformLayout[]): MaterialSlot[] {
  const groups = new Map<string, UniformLayout[]>();
  for (const uniform of uniforms) {
    const material = uniform.meta?.material;
    if (typeof material !== "string") continue;
    const list = groups.get(material) ?? [];
    list.push(uniform);
    groups.set(material, list);
  }
  const slots: MaterialSlot[] = [];
  for (const [material, list] of groups) {
    const read = list.filter((u) => !u.unused);
    // 主格：合并表里片元覆盖顶点，但没读到的阶段没有这个键，所以取读到它的片元一半，没有再取读到的顶点一半
    const primary =
      read.find((u) => u.stage === "fragment") ??
      read.find((u) => u.stage === "vertex") ??
      list.find((u) => u.stage === "fragment");
    const issues = new Set<string>();
    const members = list.map((u): MaterialMember => {
      const own = elementComponents(u);
      const record = u.stage && primary ? primary : u;
      const components = elementComponents(record);
      const count = u.array ? 0 : own;
      // 没被读的那一格不比宽度（WPE 不上传它）
      if (!u.unused && count > components) issues.add(`constant:mixed-type:${material}`);
      return { name: u.name, size: own * (u.array ?? 1), components, count, default: record.meta?.default };
    });
    if (primary) members.sort((a, b) => Number(b.name === primary.name) - Number(a.name === primary.name));
    slots.push({ material, members, used: read.length > 0, issues: [...issues] });
  }
  return slots;
}

/**
 * `constant` 绑定目标里与材质键相关的字段：整组名字（主格第一，脚本读回取它）、主格 setter 类型对应的形状
 * （脚本写回按它铺满，报告 2.6），以及各格的取值方式（就地写用）。
 */
export function constantTargetFields(slot: MaterialSlot): {
  uniforms: string[];
  type: "float" | "vec2" | "vec3" | "vec4";
  members: MaterialMember[];
} {
  return {
    uniforms: slot.members.map((member) => member.name),
    type: componentsType(slot.members[0]?.components ?? 1),
    members: slot.members,
  };
}

/**
 * 一份存储（这一格 setter 写出的 `components` 个分量）→ 这一格的值：拷 `count` 个分量，补满到 `size`，没拷到的为 0
 * （报告 2.2：WPE 只拷这么多）。就地写也用它：每次整体重写，不留旧分量。
 */
export function memberValue(member: MaterialMember, storage: readonly number[]): number[] {
  return Array.from({ length: member.size }, (_, i) => (i < member.count ? (storage[i] ?? 0) : 0));
}
