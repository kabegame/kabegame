/**
 * 纹理变体（P11e，`TEXB0004` 的条件，rea-p11e）：资源编译器把一张底图和若干张按用户属性条件生效的补丁编进同一个 `.tex`。
 * 这里是解析出的形状与三个纯函数，编译期（`compile/tex.ts`、`bundle.ts`）与宿主（`render/`）共用：
 * - `parseVariantCondition`：条件 JSON → 判定式；
 * - `selectVariants`：照 WPE 判定器 `FUN_140174a60` 与 `FUN_14015c8d0` 的命中表，按属性全集选出 `变体号 → 标志`；
 * - `variantPlan`：一级 mip 上要贴的变体与顺序（最后一条整张替换之前的丢掉、出界的跳过）。
 *
 * 实测（P11e 点 0，`ignore/p11/e/ref_variants.py`）：加载时与运行中的选择、各级 mip 的矩形、数字值判假、bool 形式、标志位 1 的混合公式
 * 都和 WPE 逐像素相同。
 */

/** 一条条件的判定式：对象形式比字符串值，字符串形式要布尔 true。 */
export type VariantTest = { name: string; equals: string } | { name: string; bool: true };

/** 头里的一条条件（`[组号, 变体号, 标志, JSON]`）。JSON 不合规的条件 WPE 什么都不做，不进表。 */
export interface TexVariantCondition {
  group: number;
  id: number;
  /** 位 1：按 alpha 混合（只对 RGBA8888，资源编译器的 `blend: "alphablend"`）；位 2：整张替换。 */
  flags: number;
  test: VariantTest;
}

/** 一级 mip 上的一条变体（`[组号, 变体号, x, y, w, h, FreeImage 格式, 长度, 数据]`）；`start` / `end` 是数据在磁盘上的绝对区间。 */
export interface TexVariantPatch {
  group: number;
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  freeImageFormat: number;
  start: number;
  end: number;
}

/** 标志位（`FUN_14015c480`、`FUN_14015c8d0`）。 */
export const VARIANT_FLAGS = { alphaBlend: 1, replace: 2 } as const;

/**
 * 条件 JSON（`{"condition": variantcondition}`）→ 判定式（rea-p11e 1.3）：`condition` 是对象且 `name`、`condition` 都是字符串时比字符串值，
 * 是字符串时它就是属性名、要布尔 true；别的写法（缺键、类型不对、JSON 解析失败）返回 null，同 WPE 什么都不做。
 */
export function parseVariantCondition(text: string): VariantTest | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const condition = (json as { condition?: unknown }).condition;
  if (typeof condition === "string") return { name: condition, bool: true };
  if (!condition || typeof condition !== "object" || Array.isArray(condition)) return null;
  const { name, condition: equals } = condition as { name?: unknown; condition?: unknown };
  return typeof name === "string" && typeof equals === "string" ? { name, equals } : null;
}

/**
 * 判一条条件（`FUN_140174a60`，P11e 点 0 实测）：属性不存在为假；对象形式要属性值是字符串且逐字节相等（数字、布尔都为假，不转字符串——
 * 和场景对象 `{user:{…}}` 绑定的判定不同）；字符串形式要属性值是布尔 true。
 * @param values 属性名 → 当前值（类型照原样）；没有这个键即属性不存在
 */
export function variantHolds(test: VariantTest, values: ReadonlyMap<string, unknown>): boolean {
  if (!values.has(test.name)) return false;
  const value = values.get(test.name);
  return "bool" in test ? value === true : typeof value === "string" && value === test.equals;
}

/** 命中表（`FUN_14015c8d0`）：按头里的顺序判，同一组只认第一条命中的。返回 变体号 → 标志。 */
export function selectVariants(
  conditions: readonly TexVariantCondition[],
  values: ReadonlyMap<string, unknown>,
): Map<number, number> {
  const groups = new Set<number>();
  const chosen = new Map<number, number>();
  for (const condition of conditions) {
    if (groups.has(condition.group) || !variantHolds(condition.test, values)) continue;
    groups.add(condition.group);
    chosen.set(condition.id, condition.flags);
  }
  return chosen;
}

/** 两张命中表是否相同（换选择时才重写纹理）。 */
export function sameSelection(a: ReadonlyMap<number, number>, b: ReadonlyMap<number, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, flags] of a) if (b.get(id) !== flags) return false;
  return true;
}

/**
 * 一级 mip 上要贴的变体，按文件顺序（`FUN_14015c8d0` 的 mip 循环）：只收命中的，最后一条整张替换（位 2）之前的丢掉；整张替换的那条
 * 之后的不再贴（WPE 在它那里 `break`）。出界检查照 WPE 覆盖 / 混合条目的那一段（宽高非 0、矩形在这一级 mip 里），不合格的跳过；
 * 整张替换的条目 WPE 不查（它把数据当整级像素用，PNG 时是编码后的字节，P11e 点 0 实测的缺陷），我们解码后贴在它的矩形上，同样要查。
 */
export function variantPlan<P extends TexVariantPatch>(
  patches: readonly P[],
  selected: ReadonlyMap<number, number>,
  mipWidth: number,
  mipHeight: number,
): { patch: P; flags: number }[] {
  let entries = patches.flatMap((patch) => (selected.has(patch.id) ? [{ patch, flags: selected.get(patch.id)! }] : []));
  let last = -1;
  entries.forEach((entry, i) => {
    if (entry.flags & VARIANT_FLAGS.replace) last = i;
  });
  if (last >= 0) entries = entries.slice(last, last + 1);
  return entries.filter(({ patch }) => {
    const { x, y, width, height } = patch;
    return (
      width !== 0 &&
      height !== 0 &&
      patch.end > patch.start &&
      x <= mipWidth &&
      width <= mipWidth - x &&
      y <= mipHeight &&
      height <= mipHeight - y
    );
  });
}

/** 条件里出现过的属性名（按首次出现的顺序），绑定表给每个登记一条。 */
export function variantPropertyNames(conditions: readonly TexVariantCondition[]): string[] {
  return [...new Set(conditions.map((condition) => condition.test.name))];
}
